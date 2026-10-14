import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { agents, aiConnectionDefaults, aiProviderDefaults, companies, companyMemberships, createDb, toolConnections } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { aiConnectionService, subscriptionAccountLabel } from "../services/ai-connections.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
const companyId = randomUUID(), agentId = randomUUID();
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
  await db.insert(agents).values({ id: agentId, companyId, name: "Grok agent", adapterType: "grok_local" });
  await db.insert(companyMemberships).values(["kimi", "other"].map(principalId => ({ companyId, principalId, principalType: "user", status: "active", membershipRole: "member" })));
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
  // Signing in to the first account again restores it and moves the default back.
  const back = await service.save(companyId, "kimi", intent("xai"), grokAuth("kimi@example.com", "third"));
  expect(back.connectionId).toBe(old.id);
  expect(await defaults("kimi", "xai")).toEqual({ method: old.grantId, provider: old.grantId });
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
  // The most recent sign-in is the default.
  expect(await defaults("kimi", "openai")).toEqual({ method: d.grantId, provider: d.grantId });
});
