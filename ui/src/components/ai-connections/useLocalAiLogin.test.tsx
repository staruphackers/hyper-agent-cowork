// @vitest-environment jsdom
import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEVICE_LOGIN_POLL_MS, useLocalAiLogin } from "./useLocalAiLogin";
import { LocalProviderLoginInstructions } from "../AdapterLoginChrome";

const api = vi.hoisted(() => ({ startLocalLogin: vi.fn(), checkLocalLogin: vi.fn(), cancelLocalLogin: vi.fn(), connectLocal: vi.fn() }));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: api }));
const clipboard = vi.hoisted(() => ({ copyTextToClipboard: vi.fn() }));
vi.mock("../../lib/clipboard", () => clipboard);
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  clipboard.copyTextToClipboard.mockResolvedValue(undefined);
  api.startLocalLogin.mockImplementation(async () => ({ sessionId: "attempt-1", command: "isolated codex login", expiresAt: "2099-01-01T00:00:00Z" }));
  api.checkLocalLogin.mockResolvedValue({ status: "sign_in_required" });
  api.cancelLocalLogin.mockResolvedValue({});
  api.connectLocal.mockResolvedValue({ connectionId: "connection", grantId: "grant" });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });
function Harness({ name = "Account", provider = "openai", enabled = true }: { name?: string; provider?: "anthropic" | "openai" | "xai"; enabled?: boolean }) {
  const login = useLocalAiLogin("company", { provider, method: "subscription", name, ownership: "personal", agentIds: [], allAgents: true }, enabled, { allowHostClaude: true });
  return <><LocalProviderLoginInstructions adapterType={provider === "anthropic" ? "claude_local" : provider === "xai" ? "grok_local" : "codex_local"} login={login} /><button onClick={() => void login.connect()}>Connect</button></>;
}
it("checks once under StrictMode, preserves renaming and navigation, and cancels only on explicit retry", async () => {
  flushSync(() => root.render(<StrictMode><Harness name="First name" /></StrictMode>));
  await vi.waitFor(() => expect(host.textContent).toContain("isolated codex login"));
  expect(api.startLocalLogin).toHaveBeenCalledTimes(1);
  expect(api.checkLocalLogin).toHaveBeenCalledTimes(1);
  expect(api.cancelLocalLogin).not.toHaveBeenCalled();
  flushSync(() => root.render(<StrictMode><Harness name="Renamed" /></StrictMode>));
  expect(api.startLocalLogin).toHaveBeenCalledTimes(1);
  flushSync(() => root.render(<StrictMode><Harness name="Renamed" enabled={false} /></StrictMode>));
  flushSync(() => root.render(<StrictMode><Harness name="Renamed" /></StrictMode>));
  await vi.waitFor(() => expect(host.textContent).toContain("isolated codex login"));
  expect(api.cancelLocalLogin).not.toHaveBeenCalled();
  flushSync(() => Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Connect')!.click());
  await vi.waitFor(() => expect(api.connectLocal).toHaveBeenCalledWith("company", expect.objectContaining({ name: "Renamed", localSessionId: "attempt-1" })));
  flushSync(() => Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Start sign-in again')!.click());
  await vi.waitFor(() => expect(api.startLocalLogin).toHaveBeenCalledTimes(2));
  expect(api.cancelLocalLogin).toHaveBeenCalledTimes(1);
  expect(api.cancelLocalLogin.mock.invocationCallOrder[0]).toBeLessThan(api.startLocalLogin.mock.invocationCallOrder[1]);
});
it.each(["anthropic", "openai"] as const)("detects an already-signed-in %s account before showing instructions, and does not save it until Connect", async provider => {
  api.checkLocalLogin.mockResolvedValue({ status: "ready" });
  flushSync(() => root.render(<Harness provider={provider} />));
  expect(host.textContent).toContain("Checking local");
  await vi.waitFor(() => expect(host.textContent).toContain("is signed in"));
  expect(host.textContent).not.toContain("Run this in a terminal");
  expect(api.connectLocal).not.toHaveBeenCalled();
  if (provider === "anthropic") expect(api.startLocalLogin).not.toHaveBeenCalled();
});
it("detects terminal completion on focus without needing a Connect attempt", async () => {
  flushSync(() => root.render(<Harness />));
  await vi.waitFor(() => expect(host.textContent).toContain("isolated codex login"));
  api.checkLocalLogin.mockResolvedValue({ status: "ready" });
  window.dispatchEvent(new Event('focus'));
  await vi.waitFor(() => expect(host.textContent).toContain("is signed in"));
  expect(host.textContent).not.toContain("isolated codex login");
  expect(api.connectLocal).not.toHaveBeenCalled();
});
it("keeps a copied command's attempt alive after leaving the page", async () => {
  flushSync(() => root.render(<Harness />));
  await vi.waitFor(() => expect(host.textContent).toContain("isolated codex login"));
  flushSync(() => root.render(<div>Another page</div>));
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(api.cancelLocalLogin).not.toHaveBeenCalled();
  const checks = api.checkLocalLogin.mock.calls.length;
  window.dispatchEvent(new Event('focus'));
  expect(api.checkLocalLogin).toHaveBeenCalledTimes(checks);
});

it("explicit retry can replace an attempt opened in another authentication host", async () => {
  api.startLocalLogin.mockRejectedValueOnce(new Error("Another sign-in is still open."));
  flushSync(() => root.render(<Harness />));
  await vi.waitFor(() => expect(host.textContent).toContain("Another sign-in"));
  flushSync(() => Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Start sign-in again')!.click());
  await vi.waitFor(() => expect(host.textContent).toContain("isolated codex login"));
  expect(api.startLocalLogin).toHaveBeenLastCalledWith("company", expect.objectContaining({ restart: true }));
});

const DEVICE = { url: "https://accounts.x.ai/oauth2/device?user_code=AB12-CD34", code: "AB12-CD34" };
it("shows the server-run sign-in code and approval link, with the terminal command tucked away", async () => {
  const timeouts = vi.spyOn(window, "setTimeout");
  api.startLocalLogin.mockResolvedValue({ sessionId: "attempt-1", command: "isolated grok login", expiresAt: "2099-01-01T00:00:00Z", deviceLogin: DEVICE });
  api.checkLocalLogin.mockResolvedValue({ status: "sign_in_required", deviceLogin: DEVICE });
  flushSync(() => root.render(<Harness provider="xai" />));
  await vi.waitFor(() => expect(host.querySelector('[data-testid="device-login-code"]')?.textContent).toBe("AB12-CD34"));
  const link = Array.from(host.querySelectorAll("a")).find(a => a.textContent === "Go to x.ai to approve")!;
  expect(link.getAttribute("href")).toBe(DEVICE.url);
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toContain("noopener");
  expect(host.textContent).toContain("Waiting for you to choose Allow");
  const details = host.querySelector("details")!;
  expect(details.open).toBe(false);
  expect(details.textContent).toContain("isolated grok login");
  expect(details.querySelector("summary")?.textContent).toBe("Advanced: sign in from a terminal instead");
  // While the user approves in another tab, polling is faster.
  await vi.waitFor(() => expect(timeouts.mock.calls.some(([, delay]) => delay === DEVICE_LOGIN_POLL_MS)).toBe(true));
  expect(timeouts.mock.calls.some(([, delay]) => delay === 5000)).toBe(false);
  // Approval is detected automatically.
  api.checkLocalLogin.mockResolvedValue({ status: "ready" });
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() => expect(host.textContent).toContain("is signed in"));
  expect(host.querySelector('[data-testid="device-login-code"]')).toBeNull();
  timeouts.mockRestore();
});
it("offers a fresh sign-in when the server-run sign-in failed, and stops polling", async () => {
  api.startLocalLogin.mockResolvedValue({ sessionId: "attempt-1", command: "isolated grok login", expiresAt: "2099-01-01T00:00:00Z", deviceLogin: DEVICE });
  api.checkLocalLogin.mockResolvedValue({ status: "sign_in_required", loginFailed: true });
  const timeouts = vi.spyOn(window, "setTimeout");
  flushSync(() => root.render(<Harness provider="xai" />));
  await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("The sign-in did not finish"));
  expect(host.querySelector('[data-testid="device-login-code"]')).toBeNull();
  expect(host.textContent).not.toContain("isolated grok login");
  expect(timeouts.mock.calls.some(([, delay]) => delay === DEVICE_LOGIN_POLL_MS || delay === 5000)).toBe(false);
  timeouts.mockRestore();
  api.checkLocalLogin.mockResolvedValue({ status: "sign_in_required", deviceLogin: DEVICE });
  flushSync(() => Array.from(host.querySelectorAll("button")).find(b => b.textContent === "Start sign-in again")!.click());
  await vi.waitFor(() => expect(api.startLocalLogin).toHaveBeenLastCalledWith("company", expect.objectContaining({ restart: true })));
  await vi.waitFor(() => expect(host.querySelector('[data-testid="device-login-code"]')).not.toBeNull());
});

const CODEX_DEVICE = { url: "https://auth.openai.com/codex/device", code: "WXYZ-98765" };
function stepTexts() {
  return Array.from(host.querySelectorAll("ol > li")).map(li => li.textContent ?? "");
}
it("U5: shows two numbered steps with the approval button above the code, worded per provider", async () => {
  api.startLocalLogin.mockResolvedValue({ sessionId: "attempt-1", command: "isolated grok login", expiresAt: "2099-01-01T00:00:00Z", deviceLogin: DEVICE });
  api.checkLocalLogin.mockResolvedValue({ status: "sign_in_required", deviceLogin: DEVICE });
  flushSync(() => root.render(<Harness provider="xai" />));
  await vi.waitFor(() => expect(stepTexts()).toHaveLength(2));
  const [first, second] = stepTexts();
  expect(first).toContain("Open the authorization page");
  expect(first).toContain("Go to x.ai to approve");
  expect(first).not.toContain(DEVICE.code);
  expect(second).toContain("Check that the authorization page shows the same code as below, then choose Allow");
  expect(second).toContain(DEVICE.code);
  // The approval button comes before the code in the document.
  const link = Array.from(host.querySelectorAll("a")).find(a => a.textContent === "Go to x.ai to approve")!;
  const code = host.querySelector('[data-testid="device-login-code"]')!;
  expect(link.compareDocumentPosition(code) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(host.querySelector("details")?.open).toBe(false);
  expect(host.textContent).toContain("Waiting for you to choose Allow");
});
it("U5: OpenAI asks the user to enter the code", async () => {
  api.startLocalLogin.mockResolvedValue({ sessionId: "attempt-1", command: "isolated codex login", expiresAt: "2099-01-01T00:00:00Z", deviceLogin: CODEX_DEVICE });
  api.checkLocalLogin.mockResolvedValue({ status: "sign_in_required", deviceLogin: CODEX_DEVICE });
  flushSync(() => root.render(<Harness provider="openai" />));
  await vi.waitFor(() => expect(stepTexts()).toHaveLength(2));
  expect(stepTexts()[0]).toContain("Go to OpenAI to approve");
  expect(stepTexts()[1]).toContain("Enter this code on the authorization page");
  expect(stepTexts()[1]).not.toContain("choose Allow");
});
it("U5: opening the authorization page also copies the code", async () => {
  api.startLocalLogin.mockResolvedValue({ sessionId: "attempt-1", command: "isolated codex login", expiresAt: "2099-01-01T00:00:00Z", deviceLogin: CODEX_DEVICE });
  api.checkLocalLogin.mockResolvedValue({ status: "sign_in_required", deviceLogin: CODEX_DEVICE });
  flushSync(() => root.render(<Harness provider="openai" />));
  await vi.waitFor(() => expect(stepTexts()).toHaveLength(2));
  const link = Array.from(host.querySelectorAll("a")).find(a => a.textContent === "Go to OpenAI to approve")!;
  link.addEventListener("click", event => event.preventDefault()); // keep jsdom from navigating
  flushSync(() => link.click());
  expect(clipboard.copyTextToClipboard).toHaveBeenCalledWith(CODEX_DEVICE.code);
  await vi.waitFor(() => expect(host.textContent).toContain("Code copied"));
});
it("U5: a refused clipboard write never blocks the approval link", async () => {
  clipboard.copyTextToClipboard.mockRejectedValue(new Error("denied"));
  api.startLocalLogin.mockResolvedValue({ sessionId: "attempt-1", command: "isolated codex login", expiresAt: "2099-01-01T00:00:00Z", deviceLogin: CODEX_DEVICE });
  api.checkLocalLogin.mockResolvedValue({ status: "sign_in_required", deviceLogin: CODEX_DEVICE });
  flushSync(() => root.render(<Harness provider="openai" />));
  await vi.waitFor(() => expect(stepTexts()).toHaveLength(2));
  const link = Array.from(host.querySelectorAll("a")).find(a => a.textContent === "Go to OpenAI to approve")!;
  let defaultPrevented: boolean | undefined;
  link.addEventListener("click", event => { defaultPrevented = event.defaultPrevented; event.preventDefault(); });
  flushSync(() => link.click());
  expect(defaultPrevented).toBe(false);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(host.textContent).not.toContain("Code copied");
});
it("B1: once the server answers, a code from the original attempt is not shown again", async () => {
  api.startLocalLogin.mockResolvedValue({ sessionId: "attempt-1", command: "isolated grok login", expiresAt: "2099-01-01T00:00:00Z", deviceLogin: DEVICE });
  api.checkLocalLogin.mockResolvedValue({ status: "sign_in_required" });
  flushSync(() => root.render(<Harness provider="xai" />));
  await vi.waitFor(() => expect(api.checkLocalLogin).toHaveBeenCalled());
  await vi.waitFor(() => expect(host.textContent).toContain("isolated grok login"));
  expect(host.querySelector('[data-testid="device-login-code"]')).toBeNull();
});
