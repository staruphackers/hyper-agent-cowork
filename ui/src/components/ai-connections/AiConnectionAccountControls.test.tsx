// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConnectionGrant } from "@paperclipai/shared";
import { AiConnectionAccountControls } from "./AiConnectionAccountControls";
import type { AiConnectionSummary } from "./model";

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });

const account = (overrides: Partial<AiConnectionSummary> = {}): AiConnectionSummary => ({
  id: "c1", grantId: "g1", companyId: "co", provider: "xai", method: "subscription", name: "My Grok subscription",
  accountLabel: "kimi@example.com", ownership: "personal", ownerUserId: "me", isDefault: true, status: "connected", ...overrides,
});
const grant = { id: "g1", capabilities: { canRevoke: true } } as unknown as ConnectionGrant;
function render(summary: AiConnectionSummary, readOnly = false) {
  const onReconnect = vi.fn();
  flushSync(() => root.render(<AiConnectionAccountControls account={summary} grant={grant} currentUserId="me" readOnly={readOnly}
    onMakeDefault={vi.fn()} onReconnect={onReconnect} onRevoke={vi.fn()} />));
  return onReconnect;
}

it("tells the owner an expired sign-in needs a new sign-in, with a prominent button", () => {
  const onReconnect = render(account({ status: "needs_attention" }));
  const alert = host.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain("Sign-in expired");
  const button = Array.from(alert.querySelectorAll("button")).find(b => b.textContent === "Sign in again")!;
  flushSync(() => button.click());
  expect(onReconnect).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain("kimi@example.com");
});

it("uses reconnect wording for API keys and hides the button for read-only viewers", () => {
  render(account({ status: "needs_attention", method: "api_key" }), true);
  const alert = host.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain("This account needs attention");
  expect(alert.querySelector("button")).toBeNull();
});

it("shows no warning for a connected account", () => {
  render(account());
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).toContain("Personal default");
});
