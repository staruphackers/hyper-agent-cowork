import { useEffect, useRef, useState } from "react";
import type { AiConnectionLoginIntent, LocalAiDeviceLogin, LocalAiLoginAttempt, LocalAiLoginStatus } from "@paperclipai/shared";

/** Poll faster while the user is approving a server-run device sign-in in another tab. */
export const DEVICE_LOGIN_POLL_MS = 3000;
const TERMINAL_LOGIN_POLL_MS = 5000;
import { aiConnectionsApi } from "@/api/ai-connections";

/** Every authentication host uses the same local credential check and login lifecycle. */
export function useLocalAiLogin(companyId: string | null, intent: AiConnectionLoginIntent, enabled: boolean, options: { allowHostClaude?: boolean } = {}) {
  const isolated = intent.provider !== "anthropic" || !options.allowHostClaude;
  const active = Boolean(companyId && enabled);
  const [attempt, setAttempt] = useState<LocalAiLoginAttempt | null>(null);
  const [status, setStatus] = useState<LocalAiLoginStatus["status"] | null>(null);
  const [checked, setChecked] = useState<LocalAiLoginStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const latestIntent = useRef(intent);
  const restartRequested = useRef(false);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const current = useRef<{ key: string; companyId: string; request: Promise<LocalAiLoginAttempt> } | null>(null);
  function cancelCurrent() {
    const previous = current.current;
    current.current = null;
    if (previous) pending.current = previous.request
      .then((result) => aiConnectionsApi.cancelLocalLogin(previous.companyId, result.sessionId)).catch(() => {});
  }
  latestIntent.current = intent;
  // Renaming the account does not restart sign-in; access/target changes do.
  const target = JSON.stringify({ ...intent, name: undefined });
  useEffect(() => {
    setAttempt(null);
    setError(null);
    setStatus(null);
    setChecked(null);
    if (!active || !companyId) return;
    let cancelled = false;
    let checking = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const key = JSON.stringify([companyId, target, generation]);
    if (isolated && current.current?.key !== key) {
      cancelCurrent();
      const input = { ...latestIntent.current, ...(restartRequested.current ? { restart: true } : {}) };
      restartRequested.current = false;
      const request = pending.current.then(() => aiConnectionsApi.startLocalLogin(companyId, input));
      current.current = { key, companyId, request };
      pending.current = request.catch(() => {});
    }
    const request = isolated ? current.current!.request : Promise.resolve(null);
    async function check() {
      if (checking || cancelled) return;
      checking = true;
      clearTimeout(timer);
      try {
        const result = await request;
        if (cancelled) return;
        setAttempt(result);
        const next = await aiConnectionsApi.checkLocalLogin(companyId!, {
          ...latestIntent.current, ...(result ? { localSessionId: result.sessionId } : {}),
        });
        if (cancelled) return;
        setStatus(next.status);
        setChecked(next);
        setError(next.status === "expired" ? "This sign-in attempt expired. Start sign-in again." : null);
        // Stop polling a verified account or a failed server-run sign-in. Focus
        // still rechecks after a terminal visit; awaiting login never requires
        // repeated Connect clicks.
        const awaitingDevice = Boolean(next.deviceLogin ?? result?.deviceLogin);
        if (next.status === "sign_in_required" && !next.loginFailed)
          timer = setTimeout(() => void check(), awaitingDevice ? DEVICE_LOGIN_POLL_MS : TERMINAL_LOGIN_POLL_MS);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not check local sign-in.");
      } finally { checking = false; }
    }
    const onFocus = () => { if (!document.hidden) void check(); };
    void check();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      // Navigation is not cancellation. The server resumes this bounded attempt
      // when the user returns and reaps abandoned attempts after expiry. Deleting
      // here made copied CODEX_HOME commands point at nonexistent directories.
    };
  }, [companyId, active, isolated, target, generation]);
  const loginFailed = checked?.loginFailed === true;
  const deviceLogin: LocalAiDeviceLogin | null =
    status === "ready" || loginFailed ? null : checked?.deviceLogin ?? attempt?.deviceLogin ?? null;
  return {
    isolated,
    command: attempt?.command,
    deviceLogin,
    loginFailed,
    status,
    preparing: active && !status && !error,
    error,
    retry: () => { restartRequested.current = true; cancelCurrent(); setGeneration((value) => value + 1); },
    connect: (input = intent) => {
      if (!companyId) throw new Error("Choose a company before connecting.");
      if (isolated && !attempt) throw new Error("Prepare local sign-in before connecting.");
      return aiConnectionsApi.connectLocal(companyId, { ...input, ...(attempt ? { localSessionId: attempt.sessionId } : {}) });
    },
  };
}
