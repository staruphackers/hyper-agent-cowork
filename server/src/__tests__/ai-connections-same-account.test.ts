import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { agents, aiConnectionDefaults, aiProviderDefaults, companies, toolConnectionInstalls, companyMemberships, createDb, toolConnections } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { aiConnectionService, subscriptionAccountLabel } from "../services/ai-connections.js";
import { AI_SIGN_IN_EXPIRED_MESSAGE, prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
const companyId = randomUUID(), agentId = randomUUID(), agentB = randomUUID();
const grokAuth = (email: string, marker: string) => JSON.stringify({
  [`https://auth.x.ai::${randomUUID()}`]: { key: `key-${marker}`, refresh_token: `refresh-${marker}`, email },
});
const jwt = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const codexAuth = (email: string, marker: string) => JSON.stringify({
  tokens: { access_token: `access-${marker}`, refresh_token: `refresh-${marker}`, id_token: jwt({ email }), account_id: "acct" },
});
const intent = (provider: "xai" | "openai", name = "My subscription") => ({
  provider, method: "subscription" as const, ownership: "personal" as const, name, loginSessionId: "fixture", agentIds: [], allAgents: true,
});

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "ai-same-account-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  database = await startEmbeddedPostgresTestDatabase("ai-same-account-db-");
  db = createDb(database.connectionString);
  await db.insert(companies).values({ id: companyId, name: "Same account", issuePrefix: "SAM" });
  await db.insert(agents).values([
    { id: agentId, companyId, name: "Grok agent", adapterType: "grok_local" },
    { id: agentB, companyId, name: "Grok agent B", adapterType: "grok_local" },
  ]);
  await db.insert(companyMemberships).values(["kimi", "other", "expired-user", "m1a", "m1b", "m1c", "m1d", "m2"].map(principalId => ({ companyId, principalId, principalType: "user", status: "active", membershipRole: "member" })));
}, 90000);
afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });

async function defaults(userId: string, provider: string) {
  const [method] = await db.select().from(aiConnectionDefaults).where(and(
    eq(aiConnectionDefaults.companyId, companyId), eq(aiConnectionDefaults.userId, userId), eq(aiConnectionDefaults.provider, provider)));
  const [providerDefault] = await db.select().from(aiProviderDefaults).where(and(
    eq(aiProviderDefaults.companyId, companyId), eq(aiProviderDefaults.userId, userId), eq(aiProviderDefaults.provider, provider)));
  return { method: method?.grantId, provider: providerDefault?.grantId };
}

it("reads the Grok account email from under its identity scope", () => {
  expect(subscriptionAccountLabel("xai", grokAuth("kimi@example.com", "x"))).toBe("kimi@example.com");
  expect(subscriptionAccountLabel("openai", codexAuth("kimi@example.com", "x"))).toBe("kimi@example.com");
  expect(subscriptionAccountLabel("xai", JSON.stringify({ email: "top-level@example.com" }))).toBeUndefined();
  expect(subscriptionAccountLabel("xai", "not json")).toBeUndefined();
  expect(subscriptionAccountLabel("anthropic", grokAuth("kimi@example.com", "x"))).toBeUndefined();
});

it("updates the same Grok account in place, labels it, and makes it the default", async () => {
  const service = aiConnectionService(db);
  const first = await service.save(companyId, "kimi", intent("xai"), grokAuth("kimi@example.com", "first"));
  let accounts = (await service.list(companyId, "kimi")).filter(a => a.provider === "xai");
  expect(accounts).toEqual([expect.objectContaining({ id: first.connectionId, accountLabel: "kimi@example.com", isDefault: true, status: "connected" })]);
  // The login later expires: the connection needs attention.
  await db.update(toolConnections).set({ healthStatus: "error", healthMessage: "Sign-in expired" }).where(eq(toolConnections.id, first.connectionId));
  expect((await service.list(companyId, "kimi")).find(a => a.id === first.connectionId)?.status).toBe("needs_attention");
  // Signing in again to the same account refreshes it instead of adding another.
  const again = await service.save(companyId, "kimi", intent("xai"), grokAuth("kimi@example.com", "second"));
  expect(again).toEqual(first);
  accounts = (await service.list(companyId, "kimi")).filter(a => a.provider === "xai");
  expect(accounts).toHaveLength(1);
  expect(accounts[0]).toMatchObject({ status: "connected", isDefault: true });
  const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, first.connectionId));
  expect(row).toMatchObject({ healthStatus: "ok", healthMessage: null });
  const selected = await service.select({ companyId, agentId, userId: "kimi", adapterType: "grok_local", binding: { provider: "xai", method: "subscription", mode: "responsible_user" } });
  expect(await service.credential(selected)).toContain("refresh-second");
});

it("a new account becomes the default, replacing an older expired default", async () => {
  const service = aiConnectionService(db);
  const old = (await service.list(companyId, "kimi")).find(a => a.provider === "xai")!;
  await db.update(toolConnections).set({ healthStatus: "error" }).where(eq(toolConnections.id, old.id));
  const fresh = await service.save(companyId, "kimi", intent("xai", "Second Grok"), grokAuth("second@example.com", "fresh"));
  expect(fresh.connectionId).not.toBe(old.id);
  expect(await defaults("kimi", "xai")).toEqual({ method: fresh.grantId, provider: fresh.grantId });
  const accounts = (await service.list(companyId, "kimi")).filter(a => a.provider === "xai");
  expect(accounts.filter(a => a.isDefault).map(a => a.id)).toEqual([fresh.connectionId]);
  // Signing in to the first account again restores it, but the working
  // default chosen in the meantime stays (M1).
  const back = await service.save(companyId, "kimi", intent("xai"), grokAuth("kimi@example.com", "third"));
  expect(back.connectionId).toBe(old.id);
  expect(await defaults("kimi", "xai")).toEqual({ method: fresh.grantId, provider: fresh.grantId });
});

it("matches Codex accounts by email and never merges other users or labelless logins", async () => {
  const service = aiConnectionService(db);
  const a = await service.save(companyId, "kimi", intent("openai"), codexAuth("kimi@example.com", "1"));
  const b = await service.save(companyId, "kimi", intent("openai"), codexAuth("kimi@example.com", "2"));
  expect(b).toEqual(a);
  const other = await service.save(companyId, "other", intent("openai"), codexAuth("kimi@example.com", "3"));
  expect(other.connectionId).not.toBe(a.connectionId);
  const noEmail = JSON.stringify({ tokens: { access_token: "x", refresh_token: "y", id_token: "not-a-jwt", account_id: "z" } });
  const c = await service.save(companyId, "kimi", intent("openai"), noEmail);
  const d = await service.save(companyId, "kimi", intent("openai"), noEmail);
  expect(c.connectionId).not.toBe(d.connectionId);
  expect((await service.list(companyId, "kimi")).filter(x => x.provider === "openai")).toHaveLength(3);
  // A working default is never taken over by a later sign-in to another account.
  expect(await defaults("kimi", "openai")).toEqual({ method: a.grantId, provider: a.grantId });
});

it("flags an account whose CLI discarded its login instead of failing run cleanup", async () => {
  const service = aiConnectionService(db);
  const saved = await service.save(companyId, "expired-user", intent("xai"), grokAuth("expired@example.com", "old"));
  const runInput = {
    companyId, agentId, adapterType: "grok_local", responsibleUserId: "expired-user",
    binding: { provider: "xai", method: "subscription", mode: "responsible_user" } as const, config: { model: "m" },
  };
  const run = await prepareManagedAiRuntime(db, runInput);
  const before = await service.credential(await service.select({ ...runInput, userId: "expired-user" }));
  // grok: "auth: cleared credentials after permanent refresh failure" removes auth.json.
  await rm(path.join(String(run.config.env.GROK_HOME), "auth.json"));
  await expect(run.cleanup()).resolves.toBeUndefined();
  const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, saved.connectionId));
  expect(row).toMatchObject({ healthStatus: "error", healthMessage: AI_SIGN_IN_EXPIRED_MESSAGE });
  expect((await service.list(companyId, "expired-user")).find(a => a.id === saved.connectionId)?.status).toBe("needs_attention");
  // Nothing was written back, and the run home is gone.
  await db.update(toolConnections).set({ healthStatus: "ok" }).where(eq(toolConnections.id, saved.connectionId));
  expect(await service.credential(await service.select({ ...runInput, userId: "expired-user" }))).toBe(before);
  // Signing in again to the same account clears the warning.
  await db.update(toolConnections).set({ healthStatus: "error", healthMessage: AI_SIGN_IN_EXPIRED_MESSAGE }).where(eq(toolConnections.id, saved.connectionId));
  await service.save(companyId, "expired-user", intent("xai"), grokAuth("expired@example.com", "new"));
  const [healed] = await db.select().from(toolConnections).where(eq(toolConnections.id, saved.connectionId));
  expect(healed).toMatchObject({ healthStatus: "ok", healthMessage: null });
  // Other read failures keep their original behavior.
  const other = await prepareManagedAiRuntime(db, runInput);
  const authFile = path.join(String(other.config.env.GROK_HOME), "auth.json");
  await rm(authFile);
  await mkdir(authFile);
  await expect(other.cleanup()).rejects.toHaveProperty("code", "EISDIR");
});

const grokIntent = (agentIds: string[] = [], allAgents = agentIds.length === 0, connectionId?: string) => ({
  ...intent("xai"), agentIds, allAgents, ...(connectionId ? { connectionId } : {}),
});
const selectFor = (userId: string, forAgent: string) => aiConnectionService(db).select({
  companyId, agentId: forAgent, userId, adapterType: "grok_local", binding: { provider: "xai", method: "subscription", mode: "responsible_user" },
});
async function installsOf(connectionId: string) {
  return (await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connectionId)))
    .map(i => `${i.targetType}:${i.targetId}`).sort();
}

it("M1a: a new account installed only on agent A does not take over a working default", async () => {
  const service = aiConnectionService(db);
  const original = await service.save(companyId, "m1a", grokIntent(), grokAuth("m1a-old@example.com", "o"));
  const narrow = await service.save(companyId, "m1a", grokIntent([agentId]), grokAuth("m1a-new@example.com", "n"));
  expect(narrow.connectionId).not.toBe(original.connectionId);
  expect(await defaults("m1a", "xai")).toEqual({ method: original.grantId, provider: original.grantId });
  expect((await selectFor("m1a", agentB)).grant.id).toBe(original.grantId);
});

it("M1b: a new sign-in replaces a broken default and is installed where the old default was", async () => {
  const service = aiConnectionService(db);
  const old = await service.save(companyId, "m1b", grokIntent([agentB]), grokAuth("m1b-old@example.com", "o"));
  await db.update(toolConnections).set({ healthStatus: "error" }).where(eq(toolConnections.id, old.connectionId));
  await expect(selectFor("m1b", agentB)).rejects.toThrow();
  const fresh = await service.save(companyId, "m1b", grokIntent([agentId]), grokAuth("m1b-new@example.com", "n"));
  expect(await defaults("m1b", "xai")).toEqual({ method: fresh.grantId, provider: fresh.grantId });
  expect(await installsOf(fresh.connectionId)).toEqual([`agent:${agentId}`, `agent:${agentB}`].sort());
  expect((await selectFor("m1b", agentB)).grant.id).toBe(fresh.grantId);
  // The old connection keeps its own installs.
  expect(await installsOf(old.connectionId)).toEqual([`agent:${agentB}`]);
});

it("M1c: reconnecting a secondary account leaves the default alone", async () => {
  const service = aiConnectionService(db);
  const main = await service.save(companyId, "m1c", grokIntent(), grokAuth("m1c-main@example.com", "m"));
  const second = await service.save(companyId, "m1c", grokIntent(), grokAuth("m1c-second@example.com", "s"));
  expect(await defaults("m1c", "xai")).toEqual({ method: main.grantId, provider: main.grantId });
  await db.update(toolConnections).set({ healthStatus: "error" }).where(eq(toolConnections.id, second.connectionId));
  // Explicit reconnect and same-account sign-in both refresh the secondary only.
  await service.save(companyId, "m1c", grokIntent([], true, second.connectionId), grokAuth("m1c-second@example.com", "s2"));
  await service.save(companyId, "m1c", grokIntent(), grokAuth("m1c-second@example.com", "s3"));
  expect(await defaults("m1c", "xai")).toEqual({ method: main.grantId, provider: main.grantId });
  // Reconnecting the default itself keeps it the default.
  await service.save(companyId, "m1c", grokIntent([], true, main.connectionId), grokAuth("m1c-main@example.com", "m2"));
  expect(await defaults("m1c", "xai")).toEqual({ method: main.grantId, provider: main.grantId });
});

it("M1d: a working API-key default is not taken over by a subscription sign-in", async () => {
  const service = aiConnectionService(db);
  const api = await service.save(companyId, "m1d", { provider: "xai", method: "api_key", ownership: "personal", name: "Grok API", apiKey: "xai-key", agentIds: [], allAgents: true }, "xai-key");
  const sub = await service.save(companyId, "m1d", grokIntent(), grokAuth("m1d@example.com", "s"));
  expect((await defaults("m1d", "xai")).provider).toBe(api.grantId);
  expect((await service.list(companyId, "m1d")).filter(a => a.isDefault).map(a => a.grantId)).toEqual([api.grantId]);
  // Signing in to the same subscription again (in-place update) still leaves the API key as default.
  await service.save(companyId, "m1d", grokIntent(), grokAuth("m1d@example.com", "s1"));
  expect((await defaults("m1d", "xai")).provider).toBe(api.grantId);
  // Only when the API key stops working does the subscription take over.
  await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, api.connectionId));
  expect((await defaults("m1d", "xai")).provider).toBe(api.grantId);
  await service.save(companyId, "m1d", grokIntent(), grokAuth("m1d@example.com", "s2"));
  expect((await defaults("m1d", "xai")).provider).toBe(sub.grantId);
});

