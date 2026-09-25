import { describe, expect, it } from "vitest";
import { adapterSupportsAiConnections, isAiConnectionCompatible } from "./ai-connections.js";

describe("adapterSupportsAiConnections", () => {
  it("is true for harnesses that some provider integration lists", () => {
    expect(adapterSupportsAiConnections("claude_local")).toBe(true);
    expect(adapterSupportsAiConnections("codex_local")).toBe(true);
    expect(adapterSupportsAiConnections("opencode_local")).toBe(true);
    expect(adapterSupportsAiConnections("grok_local")).toBe(true);
    expect(adapterSupportsAiConnections("paperclip_runner", "codex")).toBe(true);
    expect(adapterSupportsAiConnections("paperclip_runner", "acpx", "claude")).toBe(true);
  });

  it("is false for harnesses that authenticate outside managed connections", () => {
    for (const type of ["pi_local", "gemini_local", "kimi_local", "hermes_local", "hermes_gateway", "cursor_local", "process", "http"]) {
      expect(adapterSupportsAiConnections(type)).toBe(false);
    }
    expect(adapterSupportsAiConnections("paperclip_runner", "aws_agentcore")).toBe(false);
  });

  it("agrees with isAiConnectionCompatible: a binding never fits an unsupported harness", () => {
    const binding = { provider: "xai" as const, method: "subscription" as const, mode: "responsible_user" as const };
    expect(isAiConnectionCompatible(binding, "grok_local")).toBe(true);
    expect(isAiConnectionCompatible(binding, "pi_local")).toBe(false);
  });
});
