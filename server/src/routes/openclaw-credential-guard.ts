import { REDACTED_EVENT_VALUE } from "../redaction.js";

/**
 * zhtw.10 (T3). An OpenClaw agent's gateway credentials (authToken, password,
 * every header) are sent to the gateway URL. When a save or test points the
 * agent at a different gateway, each stored credential must be typed in again
 * in that same request, so a hidden value is never carried to a new host.
 *
 * Deliberately not covered: devicePrivateKeyPem. It only signs the connect
 * challenge on this server and is never transmitted, and the settings page has
 * no field for it (requiring it would make the URL impossible to change).
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function gatewayDestination(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  try {
    const parsed = new URL(raw);
    // ws and wss to the same host and path are the same gateway (a downgrade
    // is checked separately); the query string is not part of the destination.
    return `${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return raw.toLowerCase().replace(/\/+$/, "");
  }
}

/** wss:// to ws:// would send the same credentials without encryption. */
function downgradesTransport(beforeUrl: unknown, afterUrl: unknown): boolean {
  const scheme = (value: unknown) =>
    typeof value === "string" ? value.trim().toLowerCase().split(":", 1)[0] : "";
  return scheme(beforeUrl) === "wss" && scheme(afterUrl) === "ws";
}

function storedCredentials(config: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const key of ["authToken", "password"]) {
    const value = config[key];
    if (typeof value === "string" && value.trim()) out.push([key, value]);
  }
  const headers = asRecord(config.headers);
  if (headers) {
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === "string" && value.trim()) out.push([`headers.${name}`, value]);
    }
  }
  return out;
}

function valueAt(config: Record<string, unknown> | null, path: string): unknown {
  if (!config) return undefined;
  if (!path.startsWith("headers.")) return config[path];
  return asRecord(config.headers)?.[path.slice("headers.".length)];
}

function freshlyProvided(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0 && !value.includes(REDACTED_EVENT_VALUE);
}

/**
 * Returns the credential paths that would be sent to a new gateway without the
 * caller having typed them in this request. Empty when the destination did not
 * change or every stored credential was re-entered (or removed).
 */
export function findOpenClawCredentialsCarriedToNewGateway(input: {
  requestedConfig: Record<string, unknown> | null;
  existingConfig: Record<string, unknown>;
  effectiveConfig: Record<string, unknown>;
}): string[] {
  const before = gatewayDestination(input.existingConfig.url);
  const after = gatewayDestination(input.effectiveConfig.url);
  if (before === null || after === null) return [];
  if (before === after && !downgradesTransport(input.existingConfig.url, input.effectiveConfig.url)) return [];
  return storedCredentials(input.existingConfig)
    .filter(([path, stored]) =>
      valueAt(input.effectiveConfig, path) === stored
      && !freshlyProvided(valueAt(input.requestedConfig, path)))
    .map(([path]) => path);
}

export function openClawCredentialReentryMessage(paths: string[]): string {
  return `The gateway URL changed. Type these values in again so they are not sent to the new gateway: ${paths.join(", ")}`;
}

/**
 * zhtw.10 (D1-A). Replaying an OpenClaw invite on an already-approved join
 * request updates the live agent without a new approval, and anyone holding the
 * invite link can send one. Upstream uses it to refresh the gateway token and
 * the Paperclip URL, so only those fields may change this way; every other
 * setting must be changed from the agent's settings page.
 *
 * Only fields the replay request actually sends are considered. The stored join
 * payload is stale once the owner edits the agent, so it must neither trigger a
 * refusal nor be written back over the live config.
 */
// Only the gateway token (headers) may be refreshed. paperclipApiUrl is locked too
// (Kimi D2-A, 2026-10-03): the agent sends its Paperclip API key to that address,
// so changing it is an owner action on the settings page, not an invite-holder one.
export const OPENCLAW_REPLAY_REFRESHABLE_FIELDS: ReadonlySet<string> = new Set(["headers"]);

export function openClawReplayRequestedFields(body: unknown): string[] {
  const record = asRecord(body);
  if (!record) return [];
  const fields = new Set(Object.keys(asRecord(record.agentDefaultsPayload) ?? {}));
  if (typeof record.paperclipApiUrl === "string" && record.paperclipApiUrl.trim()) fields.add("paperclipApiUrl");
  return [...fields];
}

function sameSetting(field: string, live: unknown, next: unknown): boolean {
  if (field === "url") {
    return gatewayDestination(live) === gatewayDestination(next) && !downgradesTransport(live, next);
  }
  if (field === "paperclipApiUrl") {
    const canonical = (value: unknown) => {
      if (typeof value !== "string" || !value.trim()) return null;
      try { return new URL(value.trim()).toString(); } catch { return value.trim(); }
    };
    return canonical(live) === canonical(next);
  }
  if (field === "disableDeviceAuth") {
    const off = (value: unknown) => value === true || value === "true";
    return off(live) === off(next);
  }
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : value);
  return JSON.stringify(text(live) ?? null) === JSON.stringify(text(next) ?? null);
}

export function findOpenClawReplayLockedChanges(
  liveConfig: Record<string, unknown>,
  normalizedReplay: Record<string, unknown>,
  requestedFields: string[],
): string[] {
  return requestedFields.filter((field) =>
    !OPENCLAW_REPLAY_REFRESHABLE_FIELDS.has(field)
    && Object.prototype.hasOwnProperty.call(normalizedReplay, field)
    && !sameSetting(field, liveConfig[field], normalizedReplay[field]));
}

/**
 * The adapterConfig an allowed replay writes: the live config plus the
 * refreshable fields this request sent. Header values come from the request
 * (by name, case-insensitively) on top of the live headers.
 */
export function buildOpenClawReplayAdapterConfig(
  liveConfig: Record<string, unknown>,
  normalizedReplay: Record<string, unknown>,
  requestedFields: string[],
  requestedHeaders: unknown,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...liveConfig };
  const sentHeaders = asRecord(requestedHeaders);
  const replayHeaders = asRecord(normalizedReplay.headers) ?? {};
  if (requestedFields.includes("headers") && sentHeaders) {
    const headers: Record<string, unknown> = { ...(asRecord(liveConfig.headers) ?? {}) };
    for (const sentName of Object.keys(sentHeaders)) {
      const match = Object.keys(replayHeaders).find((name) => name.toLowerCase() === sentName.toLowerCase());
      if (!match) continue;
      for (const existing of Object.keys(headers)) {
        if (existing.toLowerCase() === sentName.toLowerCase()) delete headers[existing];
      }
      headers[match] = replayHeaders[match];
    }
    next.headers = headers;
  }
  return next;
}

export function openClawReplayLockedMessage(fields: string[]): string {
  return `This agent is already approved. Change these settings from the agent's settings page, not by reusing the invite: ${fields.join(", ")}`;
}
