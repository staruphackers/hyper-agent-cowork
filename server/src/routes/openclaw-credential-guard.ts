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
 * request updates the live agent without a new approval. Upstream uses this to
 * refresh the gateway token and the Paperclip URL; anyone holding the invite
 * link could also redirect the agent. These settings may only be changed from
 * the agent's settings page, so a replay that changes them is refused.
 */
export function findOpenClawReplayLockedChanges(
  existingConfig: Record<string, unknown>,
  nextConfig: Record<string, unknown>,
): string[] {
  const locked: string[] = [];
  const before = gatewayDestination(existingConfig.url);
  const after = gatewayDestination(nextConfig.url);
  if (before !== after || downgradesTransport(existingConfig.url, nextConfig.url)) locked.push("url");
  const keyPath = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  if (keyPath(existingConfig.claimedApiKeyPath) !== keyPath(nextConfig.claimedApiKeyPath)) {
    locked.push("claimedApiKeyPath");
  }
  const deviceAuthOff = (value: unknown) => value === true || value === "true";
  if (deviceAuthOff(existingConfig.disableDeviceAuth) !== deviceAuthOff(nextConfig.disableDeviceAuth)) {
    locked.push("disableDeviceAuth");
  }
  return locked;
}

export function openClawReplayLockedMessage(fields: string[]): string {
  return `This agent is already approved. Change these settings from the agent's settings page, not by reusing the invite: ${fields.join(", ")}`;
}
