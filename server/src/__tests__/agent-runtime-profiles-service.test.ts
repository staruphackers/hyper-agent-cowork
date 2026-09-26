import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  agentRuntimeProfiles,
  agentRuntimeState,
  agentTaskSessions,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { agentRuntimeProfileService } from "../services/agent-runtime-profiles.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { HttpError } from "../errors.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres runtime profile tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent runtime profiles", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-runtime-profiles-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(agentTaskSessions);
    await db.delete(agentRuntimeState);
    await db.delete(heartbeatRuns);
    await db.delete(agentRuntimeProfiles);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const claudeConfig = {
    model: "claude-sonnet-4-5",
    effort: "high",
    cwd: "/tmp/profiles",
    instructionsFilePath: "/tmp/profiles/AGENTS.md",
    env: { ANTHROPIC_API_KEY: { type: "plain", value: "anthropic-key" } },
  };

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Profiles",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Switcher",
      role: "engineer",
      adapterType: "claude_local",
      adapterConfig: claudeConfig,
      runtimeConfig: { heartbeat: { enabled: false } },
    });
    await db.insert(agentRuntimeState).values({
      companyId,
      agentId,
      adapterType: "claude_local",
      sessionId: "legacy-session",
      stateJson: {},
    });
    return { companyId, agentId };
  }

  async function insertSession(input: { companyId: string; agentId: string; taskKey: string; runtimeProfileKey: string; adapterType?: string }) {
    await db.insert(agentTaskSessions).values({
      companyId: input.companyId,
      agentId: input.agentId,
      adapterType: input.adapterType ?? "claude_local",
      runtimeProfileKey: input.runtimeProfileKey,
      taskKey: input.taskKey,
      sessionDisplayId: `session-${input.taskKey}-${input.runtimeProfileKey || "none"}`,
    });
  }

  async function sessionKeys(agentId: string) {
    const rows = await db
      .select({ key: agentTaskSessions.runtimeProfileKey, taskKey: agentTaskSessions.taskKey })
      .from(agentTaskSessions)
      .where(eq(agentTaskSessions.agentId, agentId));
    return rows.map((row) => `${row.key || "none"}:${row.taskKey}`).sort();
  }

  async function loadAgent(agentId: string) {
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    return row;
  }

  it("saves the current runtime as the first profile, activates it and re-keys existing sessions", async () => {
    const { companyId, agentId } = await seedAgent();
    await insertSession({ companyId, agentId, taskKey: "issue-1", runtimeProfileKey: "" });
    const svc = agentRuntimeProfileService(db);

    const { profile, activated } = await svc.createFromCurrent(await loadAgent(agentId), { name: "primary" });

    expect(activated).toBe(true);
    expect(profile).toMatchObject({
      name: "primary",
      tier: "primary",
      adapterType: "claude_local",
      adapterConfig: claudeConfig,
      runtimeConfig: {},
    });
    expect(profile.lastActivatedAt).not.toBeNull();
    expect((await loadAgent(agentId)).activeRuntimeProfileId).toBe(profile.id);
    expect(await sessionKeys(agentId)).toEqual([`${profile.id}:issue-1`]);
  });

  it("keeps later profiles inactive and enforces unique names per agent", async () => {
    const { agentId } = await seedAgent();
    const svc = agentRuntimeProfileService(db);
    const first = await svc.createFromCurrent(await loadAgent(agentId), { name: "primary" });
    const second = await svc.createFromCurrent(await loadAgent(agentId), { name: "economy", tier: "economy" });

    expect(second.activated).toBe(false);
    expect(second.profile.lastActivatedAt).toBeNull();
    expect((await loadAgent(agentId)).activeRuntimeProfileId).toBe(first.profile.id);

    await expect(
      svc.createFromCurrent(await loadAgent(agentId), { name: "Economy" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(svc.update(agentId, second.profile.id, { name: "PRIMARY" })).rejects.toMatchObject({ status: 409 });
  });

  it("mirrors in-place runtime edits into the active profile and clears only that namespace's sessions", async () => {
    const { companyId, agentId } = await seedAgent();
    const svc = agentRuntimeProfileService(db);
    const { profile: active } = await svc.createFromCurrent(await loadAgent(agentId), { name: "primary" });
    const { profile: parked } = await svc.createFromCurrent(await loadAgent(agentId), { name: "economy", tier: "economy" });
    await insertSession({ companyId, agentId, taskKey: "issue-1", runtimeProfileKey: active.id });
    await insertSession({ companyId, agentId, taskKey: "issue-2", runtimeProfileKey: active.id });
    await insertSession({ companyId, agentId, taskKey: "issue-1", runtimeProfileKey: parked.id });

    await agentService(db).update(agentId, {
      adapterType: "codex_local",
      adapterConfig: { ...claudeConfig, model: "gpt-6-sol", modelReasoningEffort: "high" },
    });

    expect(await sessionKeys(agentId)).toEqual([`${parked.id}:issue-1`]);
    const [mirrored] = await db.select().from(agentRuntimeProfiles).where(eq(agentRuntimeProfiles.id, active.id));
    expect(mirrored).toMatchObject({ adapterType: "codex_local", adapterConfig: expect.objectContaining({ model: "gpt-6-sol" }) });
    const [untouched] = await db.select().from(agentRuntimeProfiles).where(eq(agentRuntimeProfiles.id, parked.id));
    expect(untouched.adapterType).toBe("claude_local");
    const [runtime] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, agentId));
    expect(runtime).toMatchObject({ adapterType: "codex_local", sessionId: null });
  });

  it("activation keeps every namespace's sessions, applies the profile and records lastActivatedAt", async () => {
    const { companyId, agentId } = await seedAgent();
    const svc = agentRuntimeProfileService(db);
    const { profile: primary } = await svc.createFromCurrent(await loadAgent(agentId), { name: "primary" });
    const { profile: economyDraft } = await svc.createFromCurrent(await loadAgent(agentId), { name: "economy", tier: "economy" });
    await db
      .update(agentRuntimeProfiles)
      .set({
        adapterType: "codex_local",
        adapterConfig: {
          model: "gpt-5.6-terra",
          modelReasoningEffort: "low",
          cwd: "/tmp/stale-profile-cwd",
          env: { OPENAI_API_KEY: { type: "plain", value: "openai-key" } },
        },
      })
      .where(eq(agentRuntimeProfiles.id, economyDraft.id));
    await insertSession({ companyId, agentId, taskKey: "issue-1", runtimeProfileKey: primary.id });
    await insertSession({ companyId, agentId, taskKey: "issue-1", runtimeProfileKey: economyDraft.id, adapterType: "codex_local" });

    const agentBefore = await loadAgent(agentId);
    const economy = (await svc.getById(agentId, economyDraft.id))!;
    const preflight = await svc.preflight(agentBefore, economy.id);
    expect(preflight).toMatchObject({
      isActive: false,
      activeRunCount: 0,
      targetSessionCount: 1,
      currentSessionCount: 1,
      harnessChanges: true,
      modelChanges: true,
    });

    const { replaceAdapterConfig: _replace, ...patch } = svc.buildActivationPatch(agentBefore, economy);
    const runtimeConfig = patch.runtimeConfig as Record<string, unknown>;
    if (runtimeConfig.aiConnection === null) delete runtimeConfig.aiConnection;
    const updated = await agentService(db).update(agentId, patch as never);

    expect(updated).toMatchObject({
      adapterType: "codex_local",
      activeRuntimeProfileId: economy.id,
      adapterConfig: expect.objectContaining({
        model: "gpt-5.6-terra",
        modelReasoningEffort: "low",
        // Agent-owned keys come from the agent, not the stale profile snapshot.
        cwd: "/tmp/profiles",
        instructionsFilePath: "/tmp/profiles/AGENTS.md",
      }),
    });
    const env = (updated!.adapterConfig as { env: Record<string, unknown> }).env;
    expect(Object.keys(env).sort()).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
    expect((updated!.adapterConfig as Record<string, unknown>).effort).toBeUndefined();
    expect(await sessionKeys(agentId)).toEqual([`${economy.id}:issue-1`, `${primary.id}:issue-1`].sort());
    const [activatedRow] = await db.select().from(agentRuntimeProfiles).where(eq(agentRuntimeProfiles.id, economy.id));
    expect(activatedRow.lastActivatedAt).not.toBeNull();
    const [runtime] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, agentId));
    expect(runtime).toMatchObject({ adapterType: "codex_local", sessionId: null });
  });

  it("refuses to delete or disable the active profile and drops an inactive profile's sessions with it", async () => {
    const { companyId, agentId } = await seedAgent();
    const svc = agentRuntimeProfileService(db);
    const { profile: active } = await svc.createFromCurrent(await loadAgent(agentId), { name: "primary" });
    const { profile: parked } = await svc.createFromCurrent(await loadAgent(agentId), { name: "economy" });
    await insertSession({ companyId, agentId, taskKey: "issue-1", runtimeProfileKey: parked.id });

    await expect(svc.remove(agentId, active.id)).rejects.toBeInstanceOf(HttpError);
    await expect(svc.update(agentId, active.id, { enabled: false })).rejects.toMatchObject({ status: 409 });

    await svc.remove(agentId, parked.id);
    expect(await svc.list(agentId)).toHaveLength(1);
    expect(await sessionKeys(agentId)).toEqual([]);
    expect(
      await db.select().from(agentRuntimeProfiles).where(and(eq(agentRuntimeProfiles.agentId, agentId), eq(agentRuntimeProfiles.id, parked.id))),
    ).toEqual([]);
  });

  it("scopes an operator task-session reset to the active profile's namespace", async () => {
    const { companyId, agentId } = await seedAgent();
    const svc = agentRuntimeProfileService(db);
    const { profile: active } = await svc.createFromCurrent(await loadAgent(agentId), { name: "primary" });
    const { profile: parked } = await svc.createFromCurrent(await loadAgent(agentId), { name: "economy" });
    await insertSession({ companyId, agentId, taskKey: "issue-1", runtimeProfileKey: active.id });
    await insertSession({ companyId, agentId, taskKey: "issue-1", runtimeProfileKey: parked.id });
    await insertSession({ companyId, agentId, taskKey: "issue-2", runtimeProfileKey: active.id });

    const heartbeat = heartbeatService(db, { runtimeEnv: { PAPERCLIP_INSTANCE_ID: "runtime-profiles-test" } });
    const listed = await heartbeat.listTaskSessions(agentId);
    expect(listed.map((row) => row.runtimeProfileKey).sort()).toEqual([active.id, active.id, parked.id].sort());

    const reset = await heartbeat.resetRuntimeSession(agentId, { taskKey: "issue-1" });
    expect(reset?.clearedTaskSessions).toBe(1);
    expect(await sessionKeys(agentId)).toEqual([`${active.id}:issue-2`, `${parked.id}:issue-1`].sort());

    // A full reset without a task still clears every namespace, as before.
    const full = await heartbeat.resetRuntimeSession(agentId);
    expect(full?.clearedTaskSessions).toBe(2);
    expect(await sessionKeys(agentId)).toEqual([]);
  });

  it("rejects an activation patch that names a profile of another agent", async () => {
    const { agentId } = await seedAgent();
    const other = await seedAgent();
    const svc = agentRuntimeProfileService(db);
    const { profile: foreign } = await svc.createFromCurrent(await loadAgent(other.agentId), { name: "primary" });

    await expect(
      agentService(db).update(agentId, { activeRuntimeProfileId: foreign.id }),
    ).rejects.toMatchObject({ status: 422 });
    expect((await loadAgent(agentId)).activeRuntimeProfileId).toBeNull();
  });
});
