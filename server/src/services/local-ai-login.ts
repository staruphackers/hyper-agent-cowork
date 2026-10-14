import { randomUUID } from "node:crypto";
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
  deviceLoginStatus, ensureDeviceLogin, stopDeviceLogin, type LocalAiDeviceLoginOptions,
} from "./local-ai-device-login.js";

const LOCAL_LOGIN_METHOD = "local_subscription";
const ATTEMPT_DURATION_MS = 30 * 60 * 1000;
function loginHome(id: string) {
  return path.join(resolvePaperclipInstanceRoot(), "ai-local-logins", id);
}
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function presentAttempt(id: string, expiresAt: Date, provider: string): LocalAiLoginAttempt {
  const directory = loginHome(id);
  return {
    sessionId: id, expiresAt: expiresAt.toISOString(),
    command: provider === "openai"
      ? `(export CODEX_HOME=${shellQuote(directory)} && mkdir -p "$CODEX_HOME" && codex -c 'cli_auth_credentials_store="file"' login --device-auth)`
      : provider === "anthropic"
        ? `(export CLAUDE_CONFIG_DIR=${shellQuote(directory)} && mkdir -p "$CLAUDE_CONFIG_DIR" && claude auth login)`
        : `(export GROK_HOME=${shellQuote(directory)} && mkdir -p "$GROK_HOME" && grok login --device-auth)`,
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

/** Local terminal sign-ins share the durable attempt/credential lifecycle, but
 * never seed their home from the operator's rotating CLI credential. */
export function localAiLoginService(db: Db, options: LocalAiDeviceLoginOptions = {}) {
  /** Server-side device-code sign-in (openai/xai only). Runs after the attempt row commits. */
  async function withDeviceLogin(attempt: LocalAiLoginAttempt, provider: string, expiresAt: Date): Promise<LocalAiLoginAttempt> {
    if (provider !== "openai" && provider !== "xai") return attempt;
    // Already signed in and waiting for Connect: never start another sign-in.
    if (await access(path.join(loginHome(attempt.sessionId), "auth.json")).then(() => true, () => false))
      return { ...attempt, deviceLogin: null };
    const deviceLogin = await ensureDeviceLogin(attempt.sessionId, provider, loginHome(attempt.sessionId), expiresAt, options);
    return { ...attempt, deviceLogin };
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
        stopDeviceLogin(row.id);
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
        stopDeviceLogin(existing.id);
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
    return withDeviceLogin(attempt.attempt, intent.provider, attempt.expiresAt);
  }

  // Read-only credential detection: never saves a connection or refreshes another
  // login. Scope and intent are checked before touching an attempt's directory.
  async function check(companyId: string, userId: string, intent: AiConnectionLoginIntent, id?: string): Promise<LocalAiLoginStatus> {
    let directory: string | undefined;
    let attemptExpiresAt: Date | undefined;
    if (id || intent.provider !== "anthropic") {
      if (!id) throw unprocessable("Start local sign-in before checking this account.");
      const [session] = await db.select().from(adapterAuthSessions).where(and(
        eq(adapterAuthSessions.id, id), eq(adapterAuthSessions.companyId, companyId),
        eq(adapterAuthSessions.startedByUserId, userId),
        eq(adapterAuthSessions.connectionMethod, LOCAL_LOGIN_METHOD),
      ));
      if (!session?.aiConnection || !sameTarget(session.aiConnection, intent))
        throw notFound("Local sign-in attempt not found for this connection.");
      if (session.status !== "waiting_for_user" || !session.expiresAt || session.expiresAt.getTime() <= Date.now()) {
        stopDeviceLogin(id);
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
        return { status: "sign_in_required", ...(deviceLogin ? { deviceLogin } : {}), ...(loginFailed ? { loginFailed: true } : {}) };
      }
      return { status: "sign_in_required" };
    }
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
        .save(companyId, userId, intent, credential, id, session.createdAt);
      await tx.update(adapterAuthSessions).set({
        status: "authenticated", connectionMethod: LOCAL_LOGIN_METHOD,
        finishedAt: new Date(), updatedAt: new Date(),
      }).where(eq(adapterAuthSessions.id, id));
      return saved;
    });
    // Failed cleanup can be retried by the same completed attempt or reaper.
    stopDeviceLogin(id);
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
      stopDeviceLogin(id);
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
  return { start, check, complete, cancel, reapExpired };
}
