import { spawn, type ChildProcess } from "node:child_process";
import { parseDeviceLoginPrompt } from "@paperclipai/adapter-codex-local/server";
import { parseGrokDeviceLoginPrompt } from "@paperclipai/adapter-grok-local/server";
import { unprocessable } from "../errors.js";

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
  /** Server-wide cap on simultaneously running sign-in processes. */
  maxConcurrent?: number;
}

const MAX_OUTPUT_BYTES = 16 * 1024;
const DEFAULT_PROMPT_TIMEOUT_MS = 10_000;
const KILL_GRACE_MS = 2_000;
const DEFAULT_MAX_CONCURRENT = 20;
/** A dead sign-in process is relaunched automatically once per attempt. */
const MAX_AUTOMATIC_RESTARTS = 1;

interface Runner {
  provider: DeviceLoginProvider;
  child: ChildProcess;
  output: string;
  prompt: DeviceLoginPromptValue | null;
  exited: boolean;
  failed: boolean;
  /** Exit code 0: the CLI finished signing in. */
  succeeded: boolean;
  stopped: boolean;
  restarts: number;
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

// The CLI runs as the leader of its own process group (`detached`), so a
// wrapper such as the npm `codex` launcher and the native binary it starts are
// signalled together. Signalling only the wrapper orphaned the native CLI.
function signalGroup(runner: Runner, signal: NodeJS.Signals) {
  const pid = runner.child.pid;
  if (!pid) return;
  try { process.kill(-pid, signal); } catch { /* group already gone */ }
}

function stopRunner(runner: Runner) {
  const wasStopped = runner.stopped;
  runner.stopped = true;
  if (runner.expiryTimer) clearTimeout(runner.expiryTimer);
  notify(runner);
  if (wasStopped) return;
  // Even after the leader exits, helpers it started may still hold the group.
  signalGroup(runner, "SIGTERM");
  const force = setTimeout(() => signalGroup(runner, "SIGKILL"), KILL_GRACE_MS);
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

function runningCount() {
  let count = 0;
  for (const runner of runners.values()) if (!runner.exited && !runner.stopped) count++;
  return count;
}

function launch(id: string, provider: DeviceLoginProvider, home: string, expiresAt: Date, options: LocalAiDeviceLoginOptions, restarts = 0): Runner {
  if (runningCount() >= (options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT))
    throw unprocessable("Too many sign-ins are in progress on this server. Wait a few minutes, then start sign-in again.", {
      code: "ai_local_login_busy",
    });
  installExitHook();
  const { command, args } = (options.resolveCommand ?? defaultDeviceLoginCommand)(provider);
  const child = spawn(command, args, {
    cwd: home,
    env: deviceLoginEnvironment(provider, home),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: true,
  });
  const runner: Runner = {
    provider, child, output: "", prompt: null, exited: false, failed: false, succeeded: false, stopped: false, restarts, waiters: new Set(),
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
    runner.succeeded = code === 0;
    // Output is no longer needed once the CLI is gone.
    runner.output = "";
    notify(runner);
  });
  const remaining = expiresAt.getTime() - Date.now();
  runner.expiryTimer = setTimeout(() => stopDeviceLogin(id), Math.max(0, remaining));
  runner.expiryTimer.unref();
  return runner;
}

// A prompt is only useful while its process is still waiting for approval.
const livePrompt = (runner: Runner) => (runner.exited || runner.stopped ? null : runner.prompt);

function waitForPrompt(runner: Runner, timeoutMs: number): Promise<DeviceLoginPromptValue | null> {
  if (runner.prompt || runner.exited || runner.stopped) return Promise.resolve(livePrompt(runner));
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); runner.waiters.delete(done); resolve(livePrompt(runner)); };
    const timer = setTimeout(done, timeoutMs);
    timer.unref();
    runner.waiters.add(done);
  });
}

/**
 * Make sure the attempt has a running sign-in process and wait briefly for its
 * prompt. A server restart leaves no process: one is launched. A process that
 * died without signing in is relaunched once; after that the attempt reports a
 * failure and the user starts sign-in again. A process that finished signing in
 * is never relaunched.
 */
export async function ensureDeviceLogin(
  id: string, provider: DeviceLoginProvider, home: string, expiresAt: Date, options: LocalAiDeviceLoginOptions = {},
): Promise<DeviceLoginPromptValue | null> {
  let runner = runners.get(id);
  if (runner?.exited && !runner.succeeded && runner.restarts < MAX_AUTOMATIC_RESTARTS) {
    const restarts = runner.restarts + 1;
    stopRunner(runner);
    runners.delete(id);
    runner = launch(id, provider, home, expiresAt, options, restarts);
    runners.set(id, runner);
  } else if (!runner) {
    runner = launch(id, provider, home, expiresAt, options);
    runners.set(id, runner);
  }
  return waitForPrompt(runner, options.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS);
}

/** Current prompt and failure state (only meaningful while no usable login exists). */
export function deviceLoginStatus(id: string): { deviceLogin: DeviceLoginPromptValue | null; loginFailed: boolean } {
  const runner = runners.get(id);
  return {
    deviceLogin: runner ? livePrompt(runner) : null,
    loginFailed: Boolean(runner && runner.exited && !runner.stopped),
  };
}
