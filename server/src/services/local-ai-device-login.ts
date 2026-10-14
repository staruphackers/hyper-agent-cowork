import { spawn, type ChildProcess } from "node:child_process";
import { parseDeviceLoginPrompt } from "@paperclipai/adapter-codex-local/server";
import { parseGrokDeviceLoginPrompt } from "@paperclipai/adapter-grok-local/server";

/**
 * Server-side device-code sign-in for local subscription attempts.
 *
 * The web UI used to show a terminal command that the operator had to run on
 * the host. On container hosts that command ran as a different OS user than the
 * server, so the server could not read the resulting login. Here the server
 * itself runs `codex … login --device-auth` / `grok login --device-auth` inside
 * the attempt's private login home and reads the authorization URL and one-time
 * code from the CLI output. The CLI needs no TTY and no stdin for this flow.
 *
 * The URL and code are returned only to the attempt owner (callers enforce
 * ownership) and are never logged. Captured output is capped and kept only in
 * memory. Every child is killed on cancel, completion, restart, reap, attempt
 * expiry and process exit.
 */
export type DeviceLoginProvider = "openai" | "xai";
export interface DeviceLoginPromptValue { url: string; code: string }
export interface DeviceLoginCommand { command: string; args: string[] }
export interface LocalAiDeviceLoginOptions {
  /** Resolve the CLI to run. Defaults to `codex`/`grok` on PATH, overridable by env. */
  resolveCommand?: (provider: DeviceLoginProvider) => DeviceLoginCommand;
  /** How long start() waits for the CLI to print the prompt. */
  promptTimeoutMs?: number;
}

const MAX_OUTPUT_BYTES = 16 * 1024;
const DEFAULT_PROMPT_TIMEOUT_MS = 10_000;
const KILL_GRACE_MS = 2_000;

interface Runner {
  provider: DeviceLoginProvider;
  child: ChildProcess;
  output: string;
  prompt: DeviceLoginPromptValue | null;
  exited: boolean;
  failed: boolean;
  stopped: boolean;
  expiryTimer?: ReturnType<typeof setTimeout>;
  waiters: Set<() => void>;
}

// One registry per server process: attempts are owned by this process's HTTP
// handlers, and service instances are cheap per-request wrappers.
const runners = new Map<string, Runner>();
let exitHookInstalled = false;

export function defaultDeviceLoginCommand(provider: DeviceLoginProvider): DeviceLoginCommand {
  if (provider === "openai")
    return {
      command: process.env.PAPERCLIP_LOCAL_LOGIN_CODEX_COMMAND?.trim() || "codex",
      args: ["-c", 'cli_auth_credentials_store="file"', "login", "--device-auth"],
    };
  return {
    command: process.env.PAPERCLIP_LOCAL_LOGIN_GROK_COMMAND?.trim() || "grok",
    args: ["login", "--device-auth"],
  };
}

function parsePrompt(provider: DeviceLoginProvider, output: string): DeviceLoginPromptValue | null {
  const parsed = provider === "openai" ? parseDeviceLoginPrompt(output) : parseGrokDeviceLoginPrompt(output);
  return parsed ? { url: parsed.url, code: parsed.code } : null;
}

// Only what a CLI needs to find itself, reach the network and print text. Every
// other server variable (database URL, auth secrets, PAPERCLIP_*, operator API
// keys) stays out of a user's sign-in process.
const PASSTHROUGH_ENV = new Set([
  "PATH", "LANG", "TZ", "TMPDIR", "TMP", "TEMP",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
]);
const isPassthrough = (key: string) => PASSTHROUGH_ENV.has(key) || key.startsWith("LC_");

export function deviceLoginEnvironment(provider: DeviceLoginProvider, home: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source))
    if (value !== undefined && isPassthrough(key)) env[key] = value;
  env.HOME = home;
  env.NO_COLOR = "1";
  if (provider === "openai") env.CODEX_HOME = home;
  else env.GROK_HOME = home;
  return env;
}

function notify(runner: Runner) {
  for (const waiter of runner.waiters) waiter();
  runner.waiters.clear();
}

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // `exit` handlers must be synchronous; signalling a child is.
  process.once("exit", () => stopAllDeviceLogins());
}

function stopRunner(runner: Runner) {
  runner.stopped = true;
  if (runner.expiryTimer) clearTimeout(runner.expiryTimer);
  notify(runner);
  if (runner.exited) return;
  try { runner.child.kill("SIGTERM"); } catch { /* already gone */ }
  const force = setTimeout(() => {
    if (!runner.exited) try { runner.child.kill("SIGKILL"); } catch { /* already gone */ }
  }, KILL_GRACE_MS);
  force.unref();
}

/** Stop and forget the sign-in process for an attempt. Safe to call repeatedly. */
export function stopDeviceLogin(id: string) {
  const runner = runners.get(id);
  if (!runner) return;
  runners.delete(id);
  stopRunner(runner);
}

export function stopAllDeviceLogins() {
  for (const id of [...runners.keys()]) stopDeviceLogin(id);
}

/** Test/diagnostic view; never exposes captured output. */
export function deviceLoginState(id: string): { running: boolean; failed: boolean; prompt: DeviceLoginPromptValue | null; pid?: number } | null {
  const runner = runners.get(id);
  if (!runner) return null;
  return { running: !runner.exited, failed: runner.failed, prompt: runner.prompt, pid: runner.child.pid };
}

function launch(id: string, provider: DeviceLoginProvider, home: string, expiresAt: Date, options: LocalAiDeviceLoginOptions): Runner {
  installExitHook();
  const { command, args } = (options.resolveCommand ?? defaultDeviceLoginCommand)(provider);
  const child = spawn(command, args, {
    cwd: home,
    env: deviceLoginEnvironment(provider, home),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const runner: Runner = {
    provider, child, output: "", prompt: null, exited: false, failed: false, stopped: false, waiters: new Set(),
  };
  const onData = (chunk: Buffer) => {
    if (runner.output.length < MAX_OUTPUT_BYTES)
      runner.output = (runner.output + chunk.toString("utf8")).slice(0, MAX_OUTPUT_BYTES);
    if (!runner.prompt) {
      runner.prompt = parsePrompt(provider, runner.output);
      if (runner.prompt) notify(runner);
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("error", () => {
    // Missing binary or spawn failure. Never surface the raw error text.
    runner.exited = true;
    runner.failed = !runner.stopped;
    notify(runner);
  });
  // `close` fires after stdout/stderr are drained, so a fast-exiting CLI's
  // last output is parsed before the run is marked finished.
  child.on("close", (code) => {
    runner.exited = true;
    runner.failed = !runner.stopped && code !== 0;
    // Output is no longer needed once the CLI is gone.
    runner.output = "";
    notify(runner);
  });
  const remaining = expiresAt.getTime() - Date.now();
  runner.expiryTimer = setTimeout(() => stopDeviceLogin(id), Math.max(0, remaining));
  runner.expiryTimer.unref();
  return runner;
}

function waitForPrompt(runner: Runner, timeoutMs: number): Promise<DeviceLoginPromptValue | null> {
  if (runner.prompt || runner.exited || runner.stopped) return Promise.resolve(runner.prompt);
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); runner.waiters.delete(done); resolve(runner.prompt); };
    const timer = setTimeout(done, timeoutMs);
    timer.unref();
    runner.waiters.add(done);
  });
}

/**
 * Make sure the attempt has a running sign-in process (spawning one when the
 * server has none for it, e.g. after a restart) and wait briefly for its
 * prompt. An exited process is reported as-is; restarting is an explicit user
 * action that creates a new attempt.
 */
export async function ensureDeviceLogin(
  id: string, provider: DeviceLoginProvider, home: string, expiresAt: Date, options: LocalAiDeviceLoginOptions = {},
): Promise<DeviceLoginPromptValue | null> {
  let runner = runners.get(id);
  if (!runner) {
    runner = launch(id, provider, home, expiresAt, options);
    runners.set(id, runner);
  }
  return waitForPrompt(runner, options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS);
}

/** Current prompt and failure state for check(). */
export function deviceLoginStatus(id: string): { deviceLogin: DeviceLoginPromptValue | null; loginFailed: boolean } {
  const runner = runners.get(id);
  return { deviceLogin: runner && !runner.exited ? runner.prompt : null, loginFailed: runner?.failed === true };
}
