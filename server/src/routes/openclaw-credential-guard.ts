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

// Header names that carry the gateway token. A replay may refresh this token and
// nothing else; every other header would be sent to the owner's gateway on each
// wake-up (fourth review F1), so changing one is an owner action.
export const OPENCLAW_REPLAY_TOKEN_HEADERS: readonly string[] = ["x-openclaw-token", "x-openclaw-auth"];
const GATEWAY_TOKEN_PATTERN = /^[\x21-\x7E]{1,4096}$/;

function headerValueIgnoreCase(headers: Record<string, unknown>, name: string): unknown {
  const match = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  return match === undefined ? undefined : headers[match];
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export type OpenClawReplayHeaderReview = {
  /** The gateway token to write, taken from the request itself (never the merged stored payload). */
  token: string | null;
  /** Header changes an invite holder may not make (reported like locked fields). */
  lockedFields: string[];
  /** The request sent a token that is not a plain printable value. */
  invalidToken: boolean;
};

export function reviewOpenClawReplayHeaders(
  liveConfig: Record<string, unknown>,
  requestedHeaders: unknown,
  inbound: { token?: string | null; auth?: string | null } = {},
): OpenClawReplayHeaderReview {
  const liveHeaders = asRecord(liveConfig.headers) ?? {};
  const lockedFields: string[] = [];
  const sent = asRecord(requestedHeaders);
  if (requestedHeaders !== undefined && requestedHeaders !== null && !sent) lockedFields.push("headers");

  // Any non-token header is refused outright. Comparing it with the live value
  // would let the invite holder test guesses against stored headers (fifth review).
  const sentTokens: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(sent ?? {})) {
    const lower = name.toLowerCase();
    if (OPENCLAW_REPLAY_TOKEN_HEADERS.includes(lower)) {
      if (!(lower in sentTokens)) sentTokens[lower] = value;
      continue;
    }
    lockedFields.push(`headers.${name}`);
  }

  const raw =
    sentTokens["x-openclaw-token"] ?? sentTokens["x-openclaw-auth"] ?? inbound.token ?? inbound.auth ?? undefined;
  if (raw === undefined || raw === null) return { token: null, lockedFields, invalidToken: false };

  const trimmed = typeof raw === "string" ? raw.trim() : "";
  // A bare "Bearer" (or "Bearer   ") is not a token (sixth review N3).
  const token = /^bearer$/i.test(trimmed) ? "" : trimmed.replace(/^bearer\s+/i, "");
  if (!GATEWAY_TOKEN_PATTERN.test(token)) return { token: null, lockedFields, invalidToken: true };

  // A replay may only replace an existing gateway token header. If the agent has
  // none (it authenticates another way), or the owner keeps a token in authToken /
  // token / Authorization (which the adapter prefers or sends as-is), the token
  // must be changed on the settings page. No equality exception: answering
  // differently for the current value would let the caller confirm a guess.
  const ownerToken =
    nonEmptyText(liveConfig.authToken) ?? nonEmptyText(liveConfig.token) ?? nonEmptyText(headerValueIgnoreCase(liveHeaders, "authorization"));
  const currentHeaderToken =
    nonEmptyText(headerValueIgnoreCase(liveHeaders, "x-openclaw-token")) ??
    nonEmptyText(headerValueIgnoreCase(liveHeaders, "x-openclaw-auth"));
  if (ownerToken || !currentHeaderToken) {
    lockedFields.push("headers.x-openclaw-token");
    return { token: null, lockedFields, invalidToken: false };
  }
  return { token, lockedFields, invalidToken: false };
}

/**
 * The adapterConfig an allowed replay writes: the live config, with the gateway
 * token (if the request sent one) stored under x-openclaw-token.
 */
export function buildOpenClawReplayAdapterConfig(
  liveConfig: Record<string, unknown>,
  token: string | null,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...liveConfig };
  if (!token) return next;
  const headers: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(asRecord(liveConfig.headers) ?? {})) {
    if (!OPENCLAW_REPLAY_TOKEN_HEADERS.includes(name.toLowerCase())) headers[name] = value;
  }
  headers["x-openclaw-token"] = token;
  next.headers = headers;
  return next;
}

const URL_SCHEME_CHAR = /[a-z0-9+.-]/i;
// Only whitespace ends a URL: quotes and brackets can appear inside a stored
// URL's userinfo or query (sixth review N1); over-masking trailing punctuation is fine.
const URL_STOP_CHAR = /\s/;
const REDACT_MAX_DEPTH = 64;

function redactOneUrl(url: string): string {
  const separator = url.indexOf("://");
  const head = url.slice(0, separator + 3);
  const rest = url.slice(separator + 3);
  let authorityEnd = rest.search(/[/?#]/);
  if (authorityEnd === -1) authorityEnd = rest.length;
  let authority = rest.slice(0, authorityEnd);
  let tail = rest.slice(authorityEnd);
  const at = authority.lastIndexOf("@");
  if (at !== -1) authority = `***${authority.slice(at)}`;
  let fragment = "";
  const hash = tail.indexOf("#");
  if (hash !== -1) {
    fragment = "#***";
    tail = tail.slice(0, hash);
  }
  const query = tail.indexOf("?");
  if (query !== -1) tail = `${tail.slice(0, query)}?***`;
  return head + authority + tail + fragment;
}

// Linear-time scan (fifth review: the earlier regexes were quadratic on long
// input, so one long URL from an invite holder could stall the event loop).
function redactUrlSecretsInText(text: string): string {
  let out = "";
  let cursor = 0;
  let separator = text.indexOf("://", cursor);
  while (separator !== -1) {
    let start = separator;
    while (start > cursor && URL_SCHEME_CHAR.test(text[start - 1] ?? "")) start -= 1;
    // A scheme starts with a letter; skip leading digits/+/./- (sixth review N2).
    while (start < separator && !/[a-z]/i.test(text[start] ?? "")) start += 1;
    if (start === separator) {
      separator = text.indexOf("://", separator + 3);
      continue;
    }
    let end = separator + 3;
    while (end < text.length && !URL_STOP_CHAR.test(text[end] ?? "")) end += 1;
    out += text.slice(cursor, start) + redactOneUrl(text.slice(start, end));
    cursor = end;
    separator = text.indexOf("://", cursor);
  }
  return out + text.slice(cursor);
}

/** Masks userinfo, query and fragment of any URL found in strings (deep). */
export function redactUrlSecrets<T>(value: T, depth = 0): T {
  if (typeof value === "string") return redactUrlSecretsInText(value) as T;
  if (depth >= REDACT_MAX_DEPTH && typeof value === "object" && value !== null) return "***" as T;
  if (Array.isArray(value)) return value.map((item) => redactUrlSecrets(item, depth + 1)) as T;
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, redactUrlSecrets(item, depth + 1)]),
  ) as T;
}

export function openClawReplayLockedMessage(fields: string[]): string {
  return `This agent is already approved. Change these settings from the agent's settings page, not by reusing the invite: ${fields.join(", ")}`;
}
