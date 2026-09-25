import type { AdapterExecutionErrorFamily } from "./types.js";

/**
 * Provider-neutral classification of a failed CLI run's output.
 *
 * Claude and Codex ship their own detectors with provider-specific wording.
 * Harnesses that only surface a generic non-zero exit (Pi, OpenCode, Gemini)
 * use this shared detector so a rate limit or an exhausted quota reaches the
 * server as `transient_upstream` / `provider_quota` instead of an anonymous
 * adapter failure that flips the agent into `error` and never schedules the
 * quota monitor.
 */
export interface ProviderFailureClassification {
  errorFamily: Extract<AdapterExecutionErrorFamily, "transient_upstream" | "provider_quota"> | null;
  /** ISO timestamp the provider asked us to wait for, when it said so. */
  retryNotBefore: string | null;
}

const PROVIDER_QUOTA_RE =
  /(?:insufficient[\s_-]*(?:quota|credits?|balance|funds)|(?:quota|credits?|balance)\s+(?:exhausted|depleted|exceeded)|exceeded\s+(?:your\s+)?(?:current\s+)?quota|out\s+of\s+credits?|no\s+credits?\s+remaining|usage\s+limit\s+(?:reached|exceeded)|(?:daily|weekly|monthly|plan)\s+(?:usage\s+)?limit\s+(?:reached|exceeded)|billing\s+(?:hard\s+)?limit|payment\s+required|\b402\b|resource[\s_]*exhausted|quota[\s_]*exceeded|you(?:'|’)ve\s+hit\s+your\s+(?:\w+\s+)?limit)/i;

const TRANSIENT_UPSTREAM_RE =
  /(?:rate[\s_-]?limit(?:ed|s)?|rate_limit_error|too\s+many\s+requests|\b429\b|overloaded(?:_error)?|server\s+(?:is\s+)?(?:busy|overloaded)|service\s+(?:temporarily\s+)?unavailable|temporarily\s+unavailable|\b502\b|\b503\b|\b504\b|\b529\b|gateway\s+time(?:d\s+)?out|upstream\s+(?:error|timeout|connect)|at\s+capacity|capacity\s+(?:limit|exceeded)|try\s+again\s+(?:later|in)|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket\s+hang\s+up)/i;

// "context length exceeded" style messages are model input errors, not
// provider pressure. They must never schedule a quota wait.
const CONTEXT_LIMIT_RE =
  /(?:context\s+(?:length|window)|maximum\s+context|prompt\s+is\s+too\s+long|too\s+many\s+tokens|input\s+(?:is\s+)?too\s+long|max(?:imum)?\s+tokens?\s+(?:limit\s+)?exceeded)/i;

const RETRY_AFTER_DURATION_RE =
  /(?:retry[\s_-]?after|retry\s+in|try\s+again\s+in|wait(?:\s+for)?|resets?\s+in)[:\s]+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)?\b/i;

const RETRY_AFTER_TIMESTAMP_RE =
  /(?:resets?\s+at|retry\s+at|available\s+(?:again\s+)?at|until)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/i;

function durationToMs(value: number, unit: string | undefined): number {
  const normalized = (unit ?? "s").toLowerCase();
  if (normalized.startsWith("ms") || normalized.startsWith("milli")) return value;
  if (normalized.startsWith("h")) return value * 3_600_000;
  if (normalized.startsWith("m")) return value * 60_000;
  return value * 1_000;
}

export function parseProviderRetryNotBefore(
  text: string,
  now: Date = new Date(),
): string | null {
  const timestamp = RETRY_AFTER_TIMESTAMP_RE.exec(text);
  if (timestamp) {
    const parsed = new Date(timestamp[1]);
    if (!Number.isNaN(parsed.getTime()) && parsed.getTime() > now.getTime()) {
      return parsed.toISOString();
    }
  }
  const duration = RETRY_AFTER_DURATION_RE.exec(text);
  if (duration) {
    const amount = Number(duration[1]);
    if (Number.isFinite(amount) && amount > 0) {
      const delayMs = durationToMs(amount, duration[2]);
      // Ignore absurd waits (over a day); they are almost always parsing noise.
      if (delayMs <= 24 * 3_600_000) {
        return new Date(now.getTime() + delayMs).toISOString();
      }
    }
  }
  return null;
}

/**
 * Classify the failure text of a run that already ended with an error.
 * Callers must only pass text from failed runs: ordinary assistant prose can
 * mention "rate limit" without the run being rate limited.
 */
export function classifyProviderFailureText(
  input: string | Array<string | null | undefined>,
  now: Date = new Date(),
): ProviderFailureClassification {
  const text = (Array.isArray(input) ? input : [input])
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n")
    // Bound the scan so a huge transcript cannot stall the event loop.
    .slice(-20_000);
  if (text.trim().length === 0) return { errorFamily: null, retryNotBefore: null };
  if (CONTEXT_LIMIT_RE.test(text) && !TRANSIENT_UPSTREAM_RE.test(text) && !PROVIDER_QUOTA_RE.test(text)) {
    return { errorFamily: null, retryNotBefore: null };
  }
  const retryNotBefore = parseProviderRetryNotBefore(text, now);
  if (PROVIDER_QUOTA_RE.test(text)) {
    return { errorFamily: "provider_quota", retryNotBefore };
  }
  if (TRANSIENT_UPSTREAM_RE.test(text)) {
    return { errorFamily: "transient_upstream", retryNotBefore };
  }
  return { errorFamily: null, retryNotBefore: null };
}
