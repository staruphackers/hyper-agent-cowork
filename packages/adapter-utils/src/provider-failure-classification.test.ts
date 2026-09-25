import { describe, expect, it } from "vitest";
import {
  classifyProviderFailureText,
  parseProviderRetryNotBefore,
} from "./provider-failure-classification.js";

const now = new Date("2026-09-26T10:00:00.000Z");

describe("classifyProviderFailureText", () => {
  it("classifies rate limits and upstream pressure as transient", () => {
    for (const text of [
      "Error: 429 Too Many Requests",
      "rate_limit_error: Rate limit exceeded for gpt-6-luna",
      "The upstream provider is overloaded, try again later",
      "503 Service Unavailable",
      "request failed: ECONNRESET",
    ]) {
      expect(classifyProviderFailureText(text, now).errorFamily, text).toBe("transient_upstream");
    }
  });

  it("classifies exhausted quota and billing failures as provider quota", () => {
    for (const text of [
      "insufficient_quota: You exceeded your current quota, please check your plan and billing details.",
      "Payment Required (402): insufficient credits",
      "You've hit your weekly limit for this plan",
      "RESOURCE_EXHAUSTED: Quota exceeded for quota metric",
      "Usage limit reached. Resets in 2h",
    ]) {
      expect(classifyProviderFailureText(text, now).errorFamily, text).toBe("provider_quota");
    }
  });

  it("does not treat context-window or ordinary errors as provider pressure", () => {
    for (const text of [
      "Error: context length exceeded (maximum context is 200000 tokens)",
      "prompt is too long: 250000 tokens > 200000 maximum",
      "TypeError: Cannot read properties of undefined",
      "",
    ]) {
      expect(classifyProviderFailureText(text, now)).toEqual({ errorFamily: null, retryNotBefore: null });
    }
  });

  it("accepts an array of output fragments and ignores empty ones", () => {
    expect(
      classifyProviderFailureText([null, undefined, "", "stderr: 429 too many requests"], now).errorFamily,
    ).toBe("transient_upstream");
  });

  it("parses retry hints into an ISO timestamp", () => {
    expect(parseProviderRetryNotBefore("Retry after 30 seconds", now)).toBe("2026-09-26T10:00:30.000Z");
    expect(parseProviderRetryNotBefore("retry-after: 90", now)).toBe("2026-09-26T10:01:30.000Z");
    expect(parseProviderRetryNotBefore("try again in 5 minutes", now)).toBe("2026-09-26T10:05:00.000Z");
    expect(parseProviderRetryNotBefore("Usage resets in 2h", now)).toBe("2026-09-26T12:00:00.000Z");
    expect(parseProviderRetryNotBefore("Quota resets at 2026-09-26T18:30:00Z", now)).toBe("2026-09-26T18:30:00.000Z");
    // Past timestamps and absurd waits are ignored.
    expect(parseProviderRetryNotBefore("resets at 2026-09-25T18:30:00Z", now)).toBeNull();
    expect(parseProviderRetryNotBefore("retry after 999 hours", now)).toBeNull();
    expect(parseProviderRetryNotBefore("no hint here", now)).toBeNull();
  });

  it("carries the retry hint with the classification", () => {
    expect(classifyProviderFailureText("429 rate limited. Retry after 45 seconds.", now)).toEqual({
      errorFamily: "transient_upstream",
      retryNotBefore: "2026-09-26T10:00:45.000Z",
    });
  });
});
