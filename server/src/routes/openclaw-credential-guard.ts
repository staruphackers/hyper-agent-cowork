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
    // ws and wss to the same host and path are the same gateway; the query
    // string is not part of the destination.
    return `${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return raw.toLowerCase().replace(/\/+$/, "");
  }
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
  if (before === null || after === null || before === after) return [];
  return storedCredentials(input.existingConfig)
    .filter(([path, stored]) =>
      valueAt(input.effectiveConfig, path) === stored
      && !freshlyProvided(valueAt(input.requestedConfig, path)))
    .map(([path]) => path);
}

export function openClawCredentialReentryMessage(paths: string[]): string {
  return `The gateway URL changed. Type these values in again so they are not sent to the new gateway: ${paths.join(", ")}`;
}
