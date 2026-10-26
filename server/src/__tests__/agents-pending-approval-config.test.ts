import { createAgentLifecycle } from "../services/agent-lifecycle.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  approvals,
  activityLog,
  budgetPolicies,
  companies,
  createDb,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { approvalService } from "../services/approvals.ts";
import { redactEventPayload } from "../redaction.ts";
import { paperclipRunnerSupportsPlatform } from "@paperclipai/shared";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pending approval agent tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("pending approval agent config integrity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pending-agent-config-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(budgetPolicies);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: true,
    });
    return companyId;
  }

  it("resolves internal Codex creation once and preserves legacy agents through ordinary edits", async () => {
    const companyId = await seedCompany();
    const service = agentService(db);
    const lifecycle = createAgentLifecycle(db);
    const native = await lifecycle.requestHire(companyId, { name: "New Codex", adapterType: "codex_local", adapterConfig: { modelReasoningEffort: "high" }, status: "pending_approval" });
    const legacy = await lifecycle.requestHire(companyId, { name: "Legacy Codex", adapterType: "codex_local", runner: "legacy", adapterConfig: { extraArgs: ["--search"] }, status: "pending_approval" });
    const reviewedLegacy = await lifecycle.requestHire(companyId, { name: "Historical approved hire", adapterType: "codex_local", adapterConfig: {}, status: "pending_approval" }, { runnerResolved: true });
    if (paperclipRunnerSupportsPlatform("codex_local", process.platform, process.arch)) {
      expect(native).toMatchObject({ adapterType: "paperclip_runner", adapterConfig: { provider: "codex", modelReasoningEffort: "high" } });
    } else {
      expect(native).toMatchObject({ adapterType: "codex_local", adapterConfig: { modelReasoningEffort: "high" } });
    }
    expect(legacy.adapterType).toBe("codex_local");
    expect(reviewedLegacy.adapterType).toBe("codex_local");
    for (const agent of [native, legacy, reviewedLegacy]) {
      expect(agent).not.toHaveProperty("runner");
      await lifecycle.approveHire(agent.id);
      await service.update(agent.id, { title: "Updated title" });
      const saved = await service.getById(agent.id);
      expect(saved?.adapterType).toBe(agent.adapterType);
      expect(saved?.adapterConfig).toEqual(agent.adapterConfig);
    }
  });

  it("freezes generic pending hire config and reapplies the approval snapshot on activation", async () => {
    const companyId = await seedCompany();
    const agentSvc = agentService(db);
    const agentSvcLifecycle = createAgentLifecycle(db);
    const approvalSvc = approvalService(db);
    const pending = await agentSvcLifecycle.requestHire(companyId, {
      name: "Pending Coder",
      role: "engineer",
      title: "Software Engineer",
      icon: "code",
      capabilities: "Writes code",
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      runtimeConfig: { maxConcurrentRuns: 1 },
      budgetMonthlyCents: 1234,
      metadata: { source: "hire-form" },
      status: "pending_approval",
      spentMonthlyCents: 0,
      permissions: {},
      lastHeartbeatAt: null,
    });
    const approval = await approvalSvc.create(companyId, {
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "pending",
      payload: {
        name: "Pending Coder",
        role: "engineer",
        title: "Software Engineer",
        icon: "code",
        reportsTo: null,
        capabilities: "Writes code",
        adapterType: "process",
        adapterConfig: { command: "echo safe" },
        runtimeConfig: { maxConcurrentRuns: 1 },
        budgetMonthlyCents: 1234,
        metadata: { source: "hire-form" },
        agentId: pending.id,
        appearance: pending.appearance,
      },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    await expect(agentSvc.update(pending.id, {
      name: "Tampered Coder",
      adapterConfig: { command: "echo malicious" },
      runtimeConfig: { maxConcurrentRuns: 99 },
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "pending_approval_agent_config_frozen",
        agentId: pending.id,
        fields: ["name", "adapterConfig", "runtimeConfig"],
      },
    });
    await expect(agentSvc.updatePermissions(pending.id, {
      canCreateAgents: true,
    })).rejects.toMatchObject({
      status: 409,
      details: {
        code: "pending_approval_agent_config_frozen",
        agentId: pending.id,
        fields: ["permissions"],
      },
    });

    await db
      .update(agents)
      .set({
        name: "Tampered Coder",
        adapterConfig: { command: "echo malicious" },
        runtimeConfig: { maxConcurrentRuns: 99 },
        metadata: { source: "tampered" },
      })
      .where(eq(agents.id, pending.id));

    await approvalSvc.approve(approval.id, "board-user", "Approved generic hire");

    await expect(agentSvc.getById(pending.id)).resolves.toMatchObject({
      status: "paused",
      lifecycleState: "preparing",
      appearance: pending.appearance,
      name: "Pending Coder",
      role: "engineer",
      title: "Software Engineer",
      icon: "code",
      capabilities: "Writes code",
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      runtimeConfig: { maxConcurrentRuns: 1 },
      budgetMonthlyCents: 1234,
      metadata: { source: "hire-form" },
    });
  });

  // The hire route stores a redacted copy of the pending agent's config as the
  // approval snapshot (routes/agents.ts). Activation must put the frozen real
  // values back instead of writing "***REDACTED***" into the agent.
  async function seedPendingHire(companyId: string, realConfig: Record<string, unknown>, snapshotConfig: Record<string, unknown>) {
    const pending = await createAgentLifecycle(db).requestHire(companyId, {
      name: "Gateway Hire",
      role: "general",
      title: null,
      icon: null,
      capabilities: null,
      adapterType: "openclaw_gateway",
      adapterConfig: realConfig,
      runtimeConfig: { maxConcurrentRuns: 1 },
      budgetMonthlyCents: 0,
      metadata: { apiToken: "meta-secret", source: "hire-form" },
      status: "pending_approval",
      spentMonthlyCents: 0,
      permissions: {},
      lastHeartbeatAt: null,
    });
    const approval = await approvalService(db).create(companyId, {
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "pending",
      payload: {
        name: "Gateway Hire",
        role: "general",
        adapterType: "openclaw_gateway",
        adapterConfig: snapshotConfig,
        runtimeConfig: redactEventPayload({ maxConcurrentRuns: 1 }),
        metadata: redactEventPayload({ apiToken: "meta-secret", source: "hire-form" }),
        agentId: pending.id,
        appearance: pending.appearance,
      },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });
    return { pending, approval };
  }

  const realGatewayConfig = {
    url: "wss://gateway.example/",
    authToken: "gateway-token-value",
    password: "gateway-password",
    headers: { "x-openclaw-token": "header-token-value" },
    devicePrivateKeyPem: "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA==\n-----END PRIVATE KEY-----\n",
    disableDeviceAuth: false,
    maxRawInputTokens: 4000,
    timeoutSec: 120,
  };

  it("restores the frozen secret values when a redacted hire snapshot is approved", async () => {
    const companyId = await seedCompany();
    const snapshot = redactEventPayload(realGatewayConfig)!;
    expect(JSON.stringify(snapshot)).toContain("***REDACTED***");
    const { pending, approval } = await seedPendingHire(companyId, realGatewayConfig, snapshot);

    await approvalService(db).approve(approval.id, "board-user", "Approved gateway hire");

    const activated = await agentService(db).getById(pending.id);
    expect(activated?.lifecycleState).toBe("preparing");
    expect(activated?.adapterConfig).toEqual(realGatewayConfig);
    expect(activated?.metadata).toEqual({ apiToken: "meta-secret", source: "hire-form" });
    expect(JSON.stringify(activated)).not.toContain("***REDACTED***");
  });

  it("keeps non-secret edits from the snapshot while restoring its masked fields", async () => {
    const companyId = await seedCompany();
    const snapshot = { ...redactEventPayload(realGatewayConfig)!, timeoutSec: 600 };
    const { pending, approval } = await seedPendingHire(companyId, realGatewayConfig, snapshot);

    await approvalService(db).approve(approval.id, "board-user", "Approved gateway hire");

    const activated = await agentService(db).getById(pending.id);
    expect(activated?.adapterConfig).toEqual({ ...realGatewayConfig, timeoutSec: 600 });
  });

  it("refuses a payload-only hire whose config still holds masked values and leaves it pending", async () => {
    const companyId = await seedCompany();
    const approval = await approvalService(db).create(companyId, {
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "pending",
      payload: {
        name: "Payload Gateway",
        adapterType: "openclaw_gateway",
        adapterConfig: { url: "wss://gateway.example/", authToken: "***REDACTED***" },
      },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    await expect(
      approvalService(db).approve(approval.id, "board-user", "Approved gateway hire"),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "hire_approval_redacted_values", fields: ["adapterConfig.authToken"] },
    });

    const [stillApproval] = await db.select().from(approvals).where(eq(approvals.id, approval.id));
    expect(stillApproval?.status).toBe("pending");
    const created = await db.select().from(agents).where(eq(agents.companyId, companyId));
    expect(created.filter((agent) => agent.name === "Payload Gateway")).toHaveLength(0);
  });

  it("refuses to activate when a masked snapshot value has no frozen value to restore", async () => {
    const companyId = await seedCompany();
    const { authToken: _dropped, ...withoutToken } = realGatewayConfig;
    const snapshot = { ...redactEventPayload(withoutToken)!, authToken: "***REDACTED***" };
    const { pending, approval } = await seedPendingHire(companyId, withoutToken, snapshot);

    await expect(
      approvalService(db).approve(approval.id, "board-user", "Approved gateway hire"),
    ).rejects.toMatchObject({ status: 422 });

    const still = await agentService(db).getById(pending.id);
    expect(still?.status).toBe("pending_approval");
    expect(JSON.stringify(still?.adapterConfig)).not.toContain("***REDACTED***");
    const [stillApproval] = await db.select().from(approvals).where(eq(approvals.id, approval.id));
    expect(stillApproval?.status).toBe("pending");
  });
});
