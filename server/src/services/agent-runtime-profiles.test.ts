import { describe, expect, it } from "vitest";
import {
  composeActivationAdapterConfig,
  profileRuntimeConfigFrom,
  runtimeProfileKeyFor,
} from "./agent-runtime-profiles.js";

describe("composeActivationAdapterConfig", () => {
  it("takes harness keys from the profile and agent-owned keys from the current config", () => {
    const composed = composeActivationAdapterConfig(
      {
        model: "claude-sonnet-4-5",
        effort: "high",
        cwd: "/agent/cwd",
        instructionsFilePath: "/agent/AGENTS.md",
        paperclipSkillSync: { desiredSkills: ["a"] },
        timeoutSec: 900,
      },
      {
        model: "gpt-6-sol",
        modelReasoningEffort: "medium",
        cwd: "/stale/profile/cwd",
        timeoutSec: 5,
      },
    );
    expect(composed).toEqual({
      model: "gpt-6-sol",
      modelReasoningEffort: "medium",
      cwd: "/agent/cwd",
      instructionsFilePath: "/agent/AGENTS.md",
      paperclipSkillSync: { desiredSkills: ["a"] },
      timeoutSec: 900,
    });
    expect(composed.effort).toBeUndefined();
  });

  it("merges env so the profile's provider keys win but other keys survive", () => {
    const composed = composeActivationAdapterConfig(
      { env: { A: { type: "plain", value: "agent-a" }, SHARED: { type: "plain", value: "agent" } } },
      { env: { B: { type: "plain", value: "profile-b" }, SHARED: { type: "plain", value: "profile" } } },
    );
    expect(composed.env).toEqual({
      A: { type: "plain", value: "agent-a" },
      B: { type: "plain", value: "profile-b" },
      SHARED: { type: "plain", value: "profile" },
    });
  });

  it("omits env entirely when neither side has one", () => {
    expect(composeActivationAdapterConfig({ model: "x" }, { model: "y" })).toEqual({ model: "y" });
  });
});

describe("profileRuntimeConfigFrom", () => {
  it("keeps only a valid AI connection binding", () => {
    const binding = {
      mode: "shared",
      provider: "openai",
      method: "subscription",
      connectionId: "55555555-5555-4555-8555-555555555555",
      grantId: "66666666-6666-4666-8666-666666666666",
    };
    expect(profileRuntimeConfigFrom({ aiConnection: binding, heartbeat: { enabled: true } })).toEqual({ aiConnection: binding });
    expect(profileRuntimeConfigFrom({ heartbeat: { enabled: true } })).toEqual({});
    expect(profileRuntimeConfigFrom({ aiConnection: { mode: "nope" } })).toEqual({});
    expect(profileRuntimeConfigFrom(null)).toEqual({});
  });
});

describe("runtimeProfileKeyFor", () => {
  it("uses the active profile id or the empty legacy key", () => {
    expect(runtimeProfileKeyFor({ activeRuntimeProfileId: "abc" })).toBe("abc");
    expect(runtimeProfileKeyFor({ activeRuntimeProfileId: null })).toBe("");
    expect(runtimeProfileKeyFor({})).toBe("");
  });
});
