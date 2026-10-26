import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { adapterAuthSessions, ADAPTER_AUTH_SESSION_ACTIVE_STATES, environments, type Db } from "@paperclipai/db";
import type { AiConnectionLoginIntent, LocalAiLoginAttempt, LocalAiLoginStatus } from "@paperclipai/shared";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { notFound, unprocessable } from "../errors.js";
import { aiConnectionService } from "./ai-connections.js";
import { readVerifiedLocalAiCredential } from "./local-ai-credentials.js";
import { logActivity } from "./activity-log.js";
import {
  deviceLoginState, deviceLoginStatus, ensureDeviceLogin, stopDeviceLogin, type LocalAiDeviceLoginOptions,
} from "./local-ai-device-login.js";
import { startLocalBrowserLogin, type LocalBrowserLoginState } from "./local-ai-browser-login.js";

const LOCAL_LOGIN_METHOD = "local_subscription";
const ATTEMPT_DURATION_MS = 30 * 60 * 1000;
function loginHome(id: string) {
  const root = resolvePaperclipInstanceRoot();
  // macOS exposes /var through a system symlink to /private/var. Credential
  // reads use O_NOFOLLOW_ANY, so generate login homes from the canonical root.
  // A fresh instance root may not exist yet; prepareHome creates it first.
  let canonicalRoot = root;
  try { canonicalRoot = realpathSync(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return path.join(canonicalRoot, "ai-local-logins", id);
}
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function presentAttempt(id: string, expiresAt: Date, provider: string): LocalAiLoginAttempt {
  const directory = loginHome(id);
  return {
    sessionId: id, expiresAt: expiresAt.toISOString(),
    ...(provider === "xai" ? { command: `(export GROK_HOME=${shellQuote(directory)} && mkdir -p "$GROK_HOME" && grok login --device-auth)` } : {}),
  };
}
async function prepareHome(id: string, provider: string) {
  const directory = loginHome(id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (provider === "openai") {
    // Idempotent: preserve credentials when a user returns to an active attempt.
    await writeFile(path.join(directory, "config.toml"), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
  }
}
function sameTarget(a: AiConnectionLoginIntent, b: AiConnectionLoginIntent) {
  return a.provider === b.provider && a.method === b.method && a.ownership === b.ownership &&
    a.connectionId === b.connectionId && a.allAgents === b.allAgents &&
    JSON.stringify([...a.agentIds].sort()) === JSON.stringify([...b.agentIds].sort());
}

// Route handlers construct this service per request. Keep live browser processes
// shared so status polling and code submission can reach the original process.
const browserLogins = new Map<string, LocalBrowserLoginState>();

const DEVICE_LOGIN_FAILED_MESSAGE =
  "The sign-in did not finish. The code may have expired or the request was declined. Start sign-in again to get a new code.";

/** Local sign-ins share the durable attempt/credential lifecycle, but never seed
 * their home from the operator's rotating CLI credential. OpenAI and xAI use the
 * server-run device-code sign-in (restricted environment, process-group stop,
 * instance-wide limit); Anthropic uses the browser setup-token sign-in. */
export function localAiLoginService(db: Db, options: LocalAiDeviceLoginOptions = {}) {
  function stopBrowserLogin(id: string) {
    browserLogins.get(id)?.abort();
    browserLogins.delete(id);
  }
  function stopLogin(id: string) {
    stopDeviceLogin(id);
    stopBrowserLogin(id);
  }
  function ensureBrowserLogin(id: string, provider: string) {
    if (provider !== "anthropic" || browserLogins.has(id)) return;
    browserLogins.set(id, startLocalBrowserLogin("anthropic", loginHome(id)));
  }
  /** Server-side device-code sign-in (openai/xai only). Runs after the attempt row commits. */
  async function startDeviceLogin(sessionId: string, provider: string, expiresAt: Date): Promise<void> {
    if (provider !== "openai" && provider !== "xai") return;
    // Already signed in and waiting for Connect: never start another sign-in.
    if (await access(path.join(loginHome(sessionId), "auth.json")).then(() => true, () => false)) return;
    await ensureDeviceLogin(sessionId, provider, loginHome(sessionId), expiresAt, options);
  }
  async function reapExpired() {
    // Bounded batches use the existing expires-at index. Replaying is safe.
    const rows = await db.select({ id: adapterAuthSessions.id }).from(adapterAuthSessions)
      .where(and(eq(adapterAuthSessions.connectionMethod, LOCAL_LOGIN_METHOD),
        lte(adapterAuthSessions.expiresAt, new Date())))
      .orderBy(adapterAuthSessions.expiresAt).limit(100);
    for (const row of rows) {
      await db.transaction(async (tx) => {
        const [session] = await tx.select().from(adapterAuthSessions)
          .where(eq(adapterAuthSessions.id, row.id)).for("update");
        if (!session || !session.expiresAt || session.expiresAt.getTime() > Date.now()) return;
        stopLogin(row.id);
        await rm(loginHome(row.id), { recursive: true, force: true });
        await tx.update(adapterAuthSessions).set({
          status: session.connectionId ? "authenticated" : "timed_out",
          expiresAt: null, finishedAt: session.finishedAt ?? new Date(), updatedAt: new Date(),
        }).where(eq(adapterAuthSessions.id, row.id));
      });
    }
  }

  async function start(companyId: string, userId: string, intent: AiConnectionLoginIntent, restart = false): Promise<LocalAiLoginAttempt> {
    if (intent.provider !== "openai" && intent.provider !== "xai" && intent.provider !== "anthropic")
      throw unprocessable("This provider does not use a separate local login home.");
    await reapExpired();
    const attempt = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ai-local-login:${companyId}:${userId}:${intent.provider}`}, 0))`);
      const adapterType = intent.provider === "openai" ? "codex_local" : intent.provider === "anthropic" ? "claude_local" : "grok_local";
      const [existing] = await tx.select().from(adapterAuthSessions).where(and(
        eq(adapterAuthSessions.companyId, companyId), eq(adapterAuthSessions.startedByUserId, userId),
        eq(adapterAuthSessions.adapterType, adapterType),
        inArray(adapterAuthSessions.status, [...ADAPTER_AUTH_SESSION_ACTIVE_STATES]),
      )).for("update");
      if (existing) {
        if (!restart && existing.connectionMethod === LOCAL_LOGIN_METHOD && existing.status === "waiting_for_user" &&
            existing.aiConnection && sameTarget(existing.aiConnection, intent) &&
            existing.expiresAt && existing.expiresAt.getTime() > Date.now()) {
          await prepareHome(existing.id, intent.provider);
          return { attempt: presentAttempt(existing.id, existing.expiresAt, intent.provider), expiresAt: existing.expiresAt };
        }
        if (!restart || existing.connectionMethod !== LOCAL_LOGIN_METHOD)
          throw unprocessable("Another sign-in is still open. Finish it, or choose Start sign-in again to replace a local attempt.");
        stopLogin(existing.id);
        await rm(loginHome(existing.id), { recursive: true, force: true });
        await tx.update(adapterAuthSessions).set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date() })
          .where(eq(adapterAuthSessions.id, existing.id));
        await logActivity(tx as unknown as Db, {
          companyId, actorType: "user", actorId: userId, action: "ai_connection.local_login_cancelled",
          entityType: "adapter_auth_session", entityId: existing.id, details: { provider: intent.provider },
        });
      }
      const [environment] = await tx.select().from(environments)
        .where(and(eq(environments.driver, "local"), eq(environments.status, "active"))).limit(1);
      if (!environment) throw unprocessable("No active local environment is available.");
      const id = randomUUID();
      const directory = loginHome(id);
      const expiresAt = new Date(Date.now() + ATTEMPT_DURATION_MS);
      await prepareHome(id, intent.provider);
      try {
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.localLoginCleanup);
        await tx.insert(adapterAuthSessions).values({
          id, publicSessionId: id, companyId, environmentId: environment.id,
          adapterType,
          startedByUserId: userId, aiConnection: intent,
          connectionMethod: LOCAL_LOGIN_METHOD, status: "waiting_for_user", expiresAt,
        });
        await logActivity(tx as unknown as Db, {
          companyId, actorType: "user", actorId: userId, action: "ai_connection.local_login_started",
          entityType: "adapter_auth_session", entityId: id, details: { provider: intent.provider },
        });
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        if ((error as { cause?: { code?: string }; code?: string }).cause?.code === "23505" ||
            (error as { code?: string }).code === "23505")
          throw unprocessable("Another sign-in is still open. Finish or cancel it before starting again.");
        throw error;
      }
      return { attempt: presentAttempt(id, expiresAt, intent.provider), expiresAt };
    });
    ensureBrowserLogin(attempt.attempt.sessionId, intent.provider);
    await startDeviceLogin(attempt.attempt.sessionId, intent.provider, attempt.expiresAt);
    return attempt.attempt;
  }

  // Read-only credential detection: never saves a connection or refreshes another
  // login. Scope and intent are checked before touching an attempt's directory.
  async function check(companyId: string, userId: string, intent: AiConnectionLoginIntent, id?: string): Promise<LocalAiLoginStatus> {
    let directory: string | undefined;
    let attemptExpiresAt: Date | undefined;
    {
      if (!id) throw unprocessable(intent.provider === "anthropic"
        ? "Start browser sign-in before checking this account."
        : "Start local sign-in before checking this account.");
      const [session] = await db.select().from(adapterAuthSessions).where(and(
        eq(adapterAuthSessions.id, id), eq(adapterAuthSessions.companyId, companyId),
        eq(adapterAuthSessions.startedByUserId, userId),
        eq(adapterAuthSessions.connectionMethod, LOCAL_LOGIN_METHOD),
      ));
      if (!session?.aiConnection || !sameTarget(session.aiConnection, intent))
        throw notFound("Local sign-in attempt not found for this connection.");
      if (session.status !== "waiting_for_user" || !session.expiresAt || session.expiresAt.getTime() <= Date.now()) {
        stopLogin(id);
        return { status: "expired" };
      }
      directory = loginHome(id);
      attemptExpiresAt = session.expiresAt;
    }
    try {
      await readVerifiedLocalAiCredential(intent.provider, directory);
      return { status: "ready" };
    } catch {
      if (id && directory && attemptExpiresAt && (intent.provider === "openai" || intent.provider === "xai")) {
        // No live sign-in process (server restarted, or the CLI died): relaunch
        // it once so the user gets a fresh code instead of a stale one.
        await ensureDeviceLogin(id, intent.provider, directory, attemptExpiresAt, {
          ...options, promptTimeoutMs: Math.min(options.promptTimeoutMs ?? 3000, 3000),
        }).catch(() => null);
        const { deviceLogin, loginFailed } = deviceLoginStatus(id);
        const error = loginFailed
          ? DEVICE_LOGIN_FAILED_MESSAGE
          : deviceLoginState(id)
            ? undefined
            : "Sign-in could not start on the server. Check that the provider CLI is installed, then start sign-in again.";
        return {
          status: "sign_in_required",
          ...(deviceLogin ? { authorizationUrl: deviceLogin.url, code: deviceLogin.code } : {}),
          ...(error ? { error } : {}),
        };
      }
      const login = id ? browserLogins.get(id) : undefined;
      return { status: "sign_in_required", authorizationUrl: login?.authorizationUrl, code: login?.code,
        ...(!login && intent.provider === "anthropic"
          ? { error: "The server restarted during sign-in. Start sign-in again." }
          : login?.outcome === "failure"
            ? { error: login.error ?? "Sign-in ended before the account was connected. Start sign-in again." }
            : {}) };
    }
  }

  async function submitCode(companyId: string, userId: string, id: string, code: string) {
    await db.transaction(async (tx) => {
      const [session] = await tx.select().from(adapterAuthSessions).where(and(
        eq(adapterAuthSessions.id, id), eq(adapterAuthSessions.companyId, companyId),
        eq(adapterAuthSessions.startedByUserId, userId), eq(adapterAuthSessions.connectionMethod, LOCAL_LOGIN_METHOD),
        eq(adapterAuthSessions.adapterType, "claude_local"),
      )).for("update");
      if (!session) throw notFound("Local sign-in attempt not found.");
      if (session.status !== "waiting_for_user" || !session.expiresAt || session.expiresAt.getTime() <= Date.now())
        throw unprocessable("This sign-in attempt has expired or was cancelled. Start sign-in again.");
      const login = browserLogins.get(id);
      if (!login?.authorizationUrl || !login.submitCode || login.outcome)
        throw unprocessable("This sign-in attempt cannot accept a code. Start sign-in again.");
      const submit = login.submitCode;
      login.submitCode = undefined;
      submit(code);
      await logActivity(tx as unknown as Db, {
        companyId, actorType: "user", actorId: userId, action: "ai_connection.local_login_code_submitted",
        entityType: "adapter_auth_session", entityId: id, details: { provider: "anthropic" },
      });
    });
  }

  async function complete(companyId: string, userId: string, id: string, intent: AiConnectionLoginIntent) {
    const result = await db.transaction(async (tx) => {
      const [session] = await tx.select().from(adapterAuthSessions).where(and(
        eq(adapterAuthSessions.id, id), eq(adapterAuthSessions.companyId, companyId),
        eq(adapterAuthSessions.startedByUserId, userId),
        // Successful completion replaces connectionMethod with subscription.
        sql`${adapterAuthSessions.providerLeaseId} is null`,
      )).for("update");
      if (!session || !session.aiConnection || !sameTarget(session.aiConnection, intent))
        throw notFound("Local sign-in attempt not found for this connection.");
      if (session.connectionId && session.connectionGrantId)
        return { connectionId: session.connectionId, grantId: session.connectionGrantId };
      if (session.connectionMethod !== LOCAL_LOGIN_METHOD || session.status !== "waiting_for_user" ||
          !session.expiresAt || session.expiresAt.getTime() <= Date.now())
        throw unprocessable("This sign-in attempt has expired or was cancelled. Start sign-in again.");
      const credential = await readVerifiedLocalAiCredential(intent.provider, loginHome(id));
      await tx.update(adapterAuthSessions).set({ status: "promoting", updatedAt: new Date() })
        .where(eq(adapterAuthSessions.id, id));
      // Nested transaction is a savepoint on this same connection. Holding the
      // attempt lock makes completion/cancellation/restart retries idempotent.
      const saved = await aiConnectionService(tx as unknown as Db)
        .save(companyId, userId, intent, credential, { id }, session.createdAt);
      await tx.update(adapterAuthSessions).set({
        status: "authenticated", connectionMethod: LOCAL_LOGIN_METHOD,
        finishedAt: new Date(), updatedAt: new Date(),
      }).where(eq(adapterAuthSessions.id, id));
      return saved;
    });
    // Failed cleanup can be retried by the same completed attempt or reaper.
    stopLogin(id);
    await rm(loginHome(id), { recursive: true, force: true });
    return result;
  }

  async function cancel(companyId: string, userId: string, id: string) {
    await db.transaction(async (tx) => {
      const [session] = await tx.select().from(adapterAuthSessions).where(and(
        eq(adapterAuthSessions.id, id), eq(adapterAuthSessions.companyId, companyId),
        eq(adapterAuthSessions.startedByUserId, userId),
        eq(adapterAuthSessions.connectionMethod, LOCAL_LOGIN_METHOD),
      )).for("update");
      if (!session) throw notFound("Local sign-in attempt not found.");
      stopLogin(id);
      await rm(loginHome(id), { recursive: true, force: true });
      if (!session.connectionId && session.status !== "cancelled") {
        await tx.update(adapterAuthSessions).set({
          status: "cancelled", finishedAt: new Date(), updatedAt: new Date(),
        }).where(eq(adapterAuthSessions.id, id));
        await logActivity(tx as unknown as Db, {
          companyId, actorType: "user", actorId: userId, action: "ai_connection.local_login_cancelled",
          entityType: "adapter_auth_session", entityId: id,
          details: { provider: session.aiConnection?.provider },
        });
      }
    });
  }
  return { start, check, submitCode, complete, cancel, reapExpired };
}
