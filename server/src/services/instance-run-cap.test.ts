import { describe, expect, it } from "vitest";
import {
  availableRunSlots,
  INSTANCE_MAX_CONCURRENT_RUNS_ENV_KEY,
  readInstanceMaxConcurrentRuns,
} from "./instance-run-cap.js";

describe("readInstanceMaxConcurrentRuns", () => {
  it("returns null when the variable is unset or invalid", () => {
    expect(readInstanceMaxConcurrentRuns({})).toBeNull();
    for (const value of ["", "  ", "abc", "0", "-3", "1.5"]) {
      expect(readInstanceMaxConcurrentRuns({ [INSTANCE_MAX_CONCURRENT_RUNS_ENV_KEY]: value }), value).toBeNull();
    }
  });

  it("parses a positive integer", () => {
    expect(readInstanceMaxConcurrentRuns({ [INSTANCE_MAX_CONCURRENT_RUNS_ENV_KEY]: "2" })).toBe(2);
    expect(readInstanceMaxConcurrentRuns({ [INSTANCE_MAX_CONCURRENT_RUNS_ENV_KEY]: " 10 " })).toBe(10);
  });
});

describe("availableRunSlots", () => {
  it("keeps the per-agent policy when no instance cap is set", () => {
    expect(availableRunSlots({ agentCap: 20, agentRunning: 3, instanceCap: null, instanceRunning: 99 })).toBe(17);
  });

  it("never exceeds the remaining instance capacity", () => {
    expect(availableRunSlots({ agentCap: 20, agentRunning: 0, instanceCap: 2, instanceRunning: 1 })).toBe(1);
    expect(availableRunSlots({ agentCap: 20, agentRunning: 0, instanceCap: 2, instanceRunning: 2 })).toBe(0);
    expect(availableRunSlots({ agentCap: 20, agentRunning: 0, instanceCap: 2, instanceRunning: 5 })).toBe(0);
  });

  it("still honors the tighter per-agent limit", () => {
    expect(availableRunSlots({ agentCap: 1, agentRunning: 1, instanceCap: 8, instanceRunning: 0 })).toBe(0);
    expect(availableRunSlots({ agentCap: 1, agentRunning: 0, instanceCap: 8, instanceRunning: 0 })).toBe(1);
  });
});
