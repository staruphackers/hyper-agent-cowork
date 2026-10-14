import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { activityLog, adapterAuthSessions, companies, companyMemberships, createDb, environments } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { localAiLoginService } from "../services/local-ai-login.js";
import { deviceLoginState, stopAllDeviceLogins, type DeviceLoginProvider } from "../services/local-ai-device-login.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

// Fake CLIs: never contact x.ai or OpenAI from tests.
const ESC = "\u001b";
const GROK_CODE = "AB12-CD34";
const CODEX_CODE = "WXYZ-98765";
const GROK_OUTPUT = `Open this URL to sign in:\n${ESC}[1mhttps://accounts.x.ai/oauth2/device?user_code=${GROK_CODE}${ESC}[0m\n\nConfirm this code in your browser:\n  ${ESC}[36m${GROK_CODE}${ESC}[0m\n`;
const CODEX_OUTPUT = `Follow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   ${ESC}[94mhttps://auth.openai.com/codex/device${ESC}[0m\n\n2. Enter this one-time code (expires in 15 minutes)\n   ${ESC}[94m${CODEX_CODE}${ESC}[0m\n`;

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
let script: string;
const companyId = randomUUID(), owner = "device-owner";
const intent = (provider: DeviceLoginProvider) => ({
  provider, method: "subscription" as const, name: `Device ${provider}`, ownership: "personal" as const, agentIds: [], allAgents: true,
});

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "ai-device-login-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  script = path.join(home, "fake-cli.mjs");
  await writeFile(script, `
const mode = process.argv[2];
const fs0 = await import("node:fs");
fs0.appendFileSync(process.cwd() + "/fake-runs.log", "run\\n");
if (mode === "tree") {
  const { spawn } = await import("node:child_process");
  const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs0.writeFileSync(process.cwd() + "/helper.pid", String(helper.pid));
}
const env = { home: process.env.HOME, codex: process.env.CODEX_HOME, grok: process.env.GROK_HOME, key: process.env.OPENAI_API_KEY ?? null, all: process.env };
await import("node:fs").then((fs) => fs.writeFileSync(process.cwd() + "/fake-env.json", JSON.stringify(env)));
if (mode === "fail") { process.stderr.write("Error: device authorization failed\\n"); process.exit(1); }
if (mode === "silent") { setInterval(() => {}, 1000); }
else {
  process.stdout.write(mode === "codex" ? ${JSON.stringify(CODEX_OUTPUT)} : ${JSON.stringify(GROK_OUTPUT)});
  setInterval(() => {}, 1000);
}
`);
  database = await startEmbeddedPostgresTestDatabase("ai-device-login-db-");
  db = createDb(database.connectionString);
  await db.insert(companies).values({ id: companyId, name: "Device", issuePrefix: "DEV" });
  await db.insert(companyMemberships).values(["device-owner", "device-owner-2"].map(principalId => ({ companyId, principalId, principalType: "user", status: "active", membershipRole: "owner" })));
  await db.insert(environments).values({ name: "Local device", driver: "local" }).onConflictDoNothing();
}, 90000);
afterEach(() => { stopAllDeviceLogins(); vi.unstubAllGlobals(); });
afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });

function service(mode: string, promptTimeoutMs = 5000, maxConcurrent?: number) {
  return localAiLoginService(db, {
    promptTimeoutMs, maxConcurrent,
    resolveCommand: (provider) => ({ command: process.execPath, args: [script, mode === "auto" ? (provider === "openai" ? "codex" : "grok") : mode === "tree" ? "tree" : mode] }),
  });
}
const alive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
async function expectExited(pid?: number) { await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000 }); }

it("runs grok sign-in on the server and returns the authorization link and code", async () => {
  vi.stubEnv("OPENAI_API_KEY", "operator-key-must-not-leak");
  const login = service("auto");
  const attempt = await login.start(companyId, owner, intent("xai"));
  expect(attempt.deviceLogin).toEqual({ url: `https://accounts.x.ai/oauth2/device?user_code=${GROK_CODE}`, code: GROK_CODE });
  expect(attempt.command).toContain("grok login --device-auth");
  const state = deviceLoginState(attempt.sessionId)!;
  expect(state.running).toBe(true);
  // Resuming the same attempt reuses the running process instead of spawning another.
  expect(await service("auto").start(companyId, owner, intent("xai"))).toEqual(attempt);
  expect(deviceLoginState(attempt.sessionId)!.pid).toBe(state.pid);
  expect(await login.check(companyId, owner, intent("xai"), attempt.sessionId)).toEqual({
    status: "sign_in_required", deviceLogin: attempt.deviceLogin,
  });
  const directory = path.join(resolvePaperclipInstanceRoot(), "ai-local-logins", attempt.sessionId);
  const { readFile } = await import("node:fs/promises");
  const env = JSON.parse(await readFile(path.join(directory, "fake-env.json"), "utf8"));
  expect(env).toMatchObject({ home: directory, grok: directory, key: null });
  // Never written to the activity log.
  const events = await db.select().from(activityLog).where(eq(activityLog.entityId, attempt.sessionId));
  expect(JSON.stringify(events)).not.toContain(GROK_CODE);
  await login.cancel(companyId, owner, attempt.sessionId);
  await expectExited(state.pid);
  expect(deviceLoginState(attempt.sessionId)).toBeNull();
  vi.unstubAllEnvs();
  vi.stubEnv("PAPERCLIP_HOME", home);
});

it("runs codex sign-in with file credential storage and parses its colored prompt", async () => {
  const attempt = await service("auto").start(companyId, owner, intent("openai"));
  expect(attempt.deviceLogin).toEqual({ url: "https://auth.openai.com/codex/device", code: CODEX_CODE });
  const pid = deviceLoginState(attempt.sessionId)!.pid;
  await service("auto").cancel(companyId, owner, attempt.sessionId);
  await expectExited(pid);
});

const homeOf = (id: string) => path.join(resolvePaperclipInstanceRoot(), "ai-local-logins", id);
const runsOf = async (id: string) => (await readFileText(path.join(homeOf(id), "fake-runs.log"))).trim().split("\n").length;
async function readFileText(file: string) { const { readFile } = await import("node:fs/promises"); return readFile(file, "utf8"); }

it("reports a failed CLI run so the UI can offer a fresh sign-in", async () => {
  const login = service("fail");
  const attempt = await login.start(companyId, owner, intent("xai"));
  expect(attempt.deviceLogin).toBeNull();
  expect(await login.check(companyId, owner, intent("xai"), attempt.sessionId)).toEqual({ status: "sign_in_required", loginFailed: true });
  await login.cancel(companyId, owner, attempt.sessionId);
});

it("B2: stops helper processes the CLI started, not just the CLI itself", async () => {
  const login = service("tree");
  const attempt = await login.start(companyId, owner, intent("xai"));
  const helperPid = Number(await readFileText(path.join(homeOf(attempt.sessionId), "helper.pid")));
  expect(alive(helperPid)).toBe(true);
  await login.cancel(companyId, owner, attempt.sessionId);
  await expectExited(deviceLoginState(attempt.sessionId)?.pid);
  await expectExited(helperPid);
});

it("B2: caps simultaneous sign-in processes across the server", async () => {
  const login = service("auto", 5000, 1);
  const first = await login.start(companyId, owner, intent("xai"));
  await expect(login.start(companyId, "device-owner-2", intent("xai"))).rejects.toThrow("Too many sign-ins");
  await login.cancel(companyId, owner, first.sessionId);
  const second = await login.start(companyId, "device-owner-2", intent("xai"));
  expect(second.deviceLogin?.code).toBe(GROK_CODE);
  await login.cancel(companyId, "device-owner-2", second.sessionId);
});

it("falls back to the terminal command when no prompt appears in time", async () => {
  const login = service("silent", 200);
  const attempt = await login.start(companyId, owner, intent("xai"));
  expect(attempt.deviceLogin).toBeNull();
  expect(attempt.command).toContain("grok login --device-auth");
  const pid = deviceLoginState(attempt.sessionId)!.pid;
  await login.cancel(companyId, owner, attempt.sessionId);
  await expectExited(pid);
});

it("kills the sign-in process on restart, expiry reaping, and completion", async () => {
  const login = service("auto");
  const first = await login.start(companyId, owner, intent("xai"));
  const firstPid = deviceLoginState(first.sessionId)!.pid;
  const second = await login.start(companyId, owner, { ...intent("xai"), allAgents: false }, true);
  expect(second.sessionId).not.toBe(first.sessionId);
  await expectExited(firstPid);
  // Expiry: the reaper stops the process together with the attempt.
  const secondPid = deviceLoginState(second.sessionId)!.pid;
  await db.update(adapterAuthSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(adapterAuthSessions.id, second.sessionId));
  await login.reapExpired();
  await expectExited(secondPid);
  expect(deviceLoginState(second.sessionId)).toBeNull();
  // Completion: a finished login stops the waiting CLI.
  const third = await login.start(companyId, owner, intent("xai"));
  const thirdPid = deviceLoginState(third.sessionId)!.pid;
  const directory = path.join(resolvePaperclipInstanceRoot(), "ai-local-logins", third.sessionId);
  await writeFile(path.join(directory, "auth.json"), JSON.stringify({
    [`https://auth.x.ai::${randomUUID()}`]: { key: "xai-key", refresh_token: "xai-refresh", email: "device@example.com" },
  }));
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
  expect(await login.check(companyId, owner, intent("xai"), third.sessionId)).toEqual({ status: "ready" });
  await login.complete(companyId, owner, third.sessionId, intent("xai"));
  await expectExited(thirdPid);
  expect(deviceLoginState(third.sessionId)).toBeNull();
});

it("stops the process when the attempt deadline passes even without the reaper", async () => {
  const login = service("auto");
  const attempt = await login.start(companyId, owner, intent("xai"));
  const pid = deviceLoginState(attempt.sessionId)!.pid;
  await db.update(adapterAuthSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(adapterAuthSessions.id, attempt.sessionId));
  expect(await login.check(companyId, owner, intent("xai"), attempt.sessionId)).toEqual({ status: "expired" });
  await expectExited(pid);
});

it("kills a waiting sign-in at the attempt deadline on its own", async () => {
  const dir = await mkdtemp(path.join(home, "deadline-"));
  const { ensureDeviceLogin } = await import("../services/local-ai-device-login.js");
  const id = randomUUID();
  const prompt = await ensureDeviceLogin(id, "xai", dir, new Date(Date.now() + 800), {
    resolveCommand: () => ({ command: process.execPath, args: [script, "grok"] }),
  });
  expect(prompt?.code).toBe(GROK_CODE);
  const pid = deviceLoginState(id)!.pid;
  await expectExited(pid);
  expect(deviceLoginState(id)).toBeNull();
});

it("passes only an allow-listed environment to the sign-in CLI", async () => {
  const leaked = {
    DATABASE_URL: "postgres://user:secret@db/paperclip", BETTER_AUTH_SECRET: "auth-secret",
    PAPERCLIP_AGENT_JWT_SECRET: "jwt-secret", PAPERCLIP_HOME_EXTRA: "x", MY_CUSTOM_TOKEN: "custom",
    OPENAI_API_KEY: "operator-key", XAI_API_KEY: "operator-xai", CODEX_HOME: "/operator/codex", GROK_HOME: "/operator/grok",
  };
  const kept = {
    LANG: "zh_TW.UTF-8", LC_ALL: "zh_TW.UTF-8", TZ: "Asia/Taipei", TMPDIR: "/tmp/x",
    HTTPS_PROXY: "http://proxy:1", https_proxy: "http://proxy:2", NO_PROXY: "localhost", NODE_EXTRA_CA_CERTS: "/ca.pem", SSL_CERT_FILE: "/cert.pem",
  };
  for (const [key, value] of Object.entries({ ...leaked, ...kept })) vi.stubEnv(key, value);
  try {
    const login = service("auto");
    const attempt = await login.start(companyId, owner, intent("openai"));
    const directory = path.join(resolvePaperclipInstanceRoot(), "ai-local-logins", attempt.sessionId);
    const { readFile } = await import("node:fs/promises");
    const all: Record<string, string> = JSON.parse(await readFile(path.join(directory, "fake-env.json"), "utf8")).all;
    for (const key of Object.keys(leaked)) expect(Object.hasOwn(all, key) && all[key] === leaked[key as keyof typeof leaked]).toBe(false);
    expect(Object.keys(all).filter(key => key.startsWith("PAPERCLIP_"))).toEqual([]);
    expect(all).toMatchObject({ ...kept, HOME: directory, CODEX_HOME: directory, NO_COLOR: "1" });
    expect(all.PATH).toBe(process.env.PATH);
    const allowed = new Set([...Object.keys(kept), "PATH", "HOME", "CODEX_HOME", "NO_COLOR"]);
    // Node may add a few variables of its own on some platforms; nothing from the server's env may appear.
    // macOS adds __CF_USER_TEXT_ENCODING to every child process.
    const unexpected = Object.keys(all).filter(key => !allowed.has(key) && !key.startsWith("__CF_") && process.env[key] !== undefined);
    expect(unexpected).toEqual([]);
    await login.cancel(companyId, owner, attempt.sessionId);
  } finally {
    vi.unstubAllEnvs();
    vi.stubEnv("PAPERCLIP_HOME", home);
  }
});
