import type { OpenCodePlanProbe, OpenCodePlansResult } from "@paperclipai/shared";

// OpenCode sells two plans behind one API key: Zen (pay-as-you-go credits,
// provider id `opencode`) and Go (a monthly subscription over curated open
// models, provider id `opencode-go`). The OpenCode CLI never checks which plan
// a key is entitled to — with any key present it lists both catalogs — so the
// setup UI asks the gateway directly. Each plan has its own models endpoint;
// a key that is not entitled to a plan gets an auth-class rejection there.
export const OPENCODE_ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
export const OPENCODE_GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";
const PROBE_TIMEOUT_MS = 8_000;
const MODEL_ID_PREFIXES = ["opencode-go/", "opencode/"];

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Accepts the OpenAI-style `{ data: [{ id }] }` list, a `{ models: [...] }`
 * list, or a bare array of ids/objects, and returns sorted bare model ids. */
export function extractOpenCodeModelIds(payload: unknown): string[] {
  const record = asRecord(payload);
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(record?.data)
      ? (record!.data as unknown[])
      : Array.isArray(record?.models)
        ? (record!.models as unknown[])
        : null;
  if (!list) return [];
  const ids = new Set<string>();
  for (const item of list) {
    const entry = asRecord(item);
    const raw = typeof item === "string" ? item : entry ? (entry.id ?? entry.name) : null;
    if (typeof raw !== "string") continue;
    let id = raw.trim();
    if (!id) continue;
    for (const prefix of MODEL_ID_PREFIXES) {
      if (id.startsWith(prefix)) {
        id = id.slice(prefix.length);
        break;
      }
    }
    if (id) ids.add(id);
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

async function probeEndpoint(
  url: string,
  apiKey: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<OpenCodePlanProbe> {
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const httpStatus = response.status;
    // 401/403: key rejected for this plan. 402: plan not paid for / no credits.
    if (httpStatus === 401 || httpStatus === 402 || httpStatus === 403) {
      return { status: "inactive", models: [], httpStatus };
    }
    if (!response.ok) {
      return { status: "unknown", models: [], httpStatus, message: `HTTP ${httpStatus}` };
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { status: "unknown", models: [], httpStatus, message: "Unparseable response" };
    }
    const models = extractOpenCodeModelIds(payload);
    if (models.length === 0) {
      return { status: "unknown", models: [], httpStatus, message: "No models in response" };
    }
    return { status: "active", models, httpStatus };
  } catch (error) {
    // Network errors and timeouts never carry the key; surface the message as-is.
    return {
      status: "unknown",
      models: [],
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function probeOpenCodePlans(
  apiKey: string,
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<OpenCodePlansResult> {
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const [zen, go] = await Promise.all([
    probeEndpoint(OPENCODE_ZEN_MODELS_URL, apiKey, fetchImpl, timeoutMs),
    probeEndpoint(OPENCODE_GO_MODELS_URL, apiKey, fetchImpl, timeoutMs),
  ]);
  return { zen, go, checkedAt: new Date().toISOString() };
}
