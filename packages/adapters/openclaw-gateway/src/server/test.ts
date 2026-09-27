import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_CLIENT_MODE,
  buildDeviceAuthPayloadV3,
  resolveClaimedApiKeyPath,
  resolveDeviceIdentity,
  signDevicePayload,
  type GatewayDeviceIdentity,
} from "./execute.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isLoopbackHost(hostname: string): boolean {
  const value = hostname.trim().toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

function toStringRecord(value: unknown): Record<string, string> {
  const parsed = parseObject(value);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function headerMapGetIgnoreCase(headers: Record<string, string>, key: string): string | null {
  const match = Object.entries(headers).find(([entryKey]) => entryKey.toLowerCase() === key.toLowerCase());
  return match ? match[1] : null;
}

function tokenFromAuthHeader(rawHeader: string | null): string | null {
  if (!rawHeader) return null;
  const trimmed = rawHeader.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^bearer\s+(.+)$/i);
  return match ? nonEmpty(match[1]) : trimmed;
}

function resolveAuthToken(config: Record<string, unknown>, headers: Record<string, string>): string | null {
  const explicit = nonEmpty(config.authToken) ?? nonEmpty(config.token);
  if (explicit) return explicit;

  const tokenHeader = headerMapGetIgnoreCase(headers, "x-openclaw-token");
  if (nonEmpty(tokenHeader)) return nonEmpty(tokenHeader);

  const authHeader =
    headerMapGetIgnoreCase(headers, "x-openclaw-auth") ??
    headerMapGetIgnoreCase(headers, "authorization");
  return tokenFromAuthHeader(authHeader);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function rawDataToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) {
    return Buffer.concat(
      data.map((entry) => (Buffer.isBuffer(entry) ? entry : Buffer.from(String(entry), "utf8"))),
    ).toString("utf8");
  }
  return String(data ?? "");
}

type ProbeResult = {
  status: "ok" | "challenge_only" | "failed";
  /** Rejection text from the gateway, when it sent one. */
  errorMessage?: string | null;
  pairingRequestId?: string | null;
  grantedScopes?: string[] | null;
};

function extractGrantedScopes(hello: Record<string, unknown> | null): string[] | null {
  if (!hello) return null;
  for (const candidate of [asRecord(hello.auth), asRecord(hello.session), hello]) {
    const scopes = candidate?.scopes;
    if (Array.isArray(scopes)) {
      return scopes.filter((entry): entry is string => typeof entry === "string");
    }
  }
  return null;
}

async function probeGateway(input: {
  url: string;
  headers: Record<string, string>;
  authToken: string | null;
  password?: string | null;
  role: string;
  scopes: string[];
  clientId: string;
  clientMode: string;
  deviceIdentity: GatewayDeviceIdentity | null;
  timeoutMs: number;
}): Promise<ProbeResult> {
  return await new Promise((resolve) => {
    const ws = new WebSocket(input.url, { headers: input.headers, maxPayload: 2 * 1024 * 1024 });
    const timeout = setTimeout(() => {
      finish({ status: "failed", errorMessage: "gateway did not answer in time" });
    }, input.timeoutMs);

    let completed = false;

    const finish = (result: ProbeResult) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(result);
    };

    ws.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawDataToString(raw));
      } catch {
        return;
      }
      const event = asRecord(parsed);
      if (event?.type === "event" && event.event === "connect.challenge") {
        const nonce = nonEmpty(asRecord(event.payload)?.nonce);
        if (!nonce) {
          finish({ status: "failed", errorMessage: "gateway challenge had no nonce" });
          return;
        }

        const connectId = randomUUID();
        const signedAtMs = Date.now();
        const params: Record<string, unknown> = {
          minProtocol: 4,
          maxProtocol: 4,
          client: {
            id: input.clientId,
            version: "paperclip-probe",
            platform: process.platform,
            mode: input.clientMode,
          },
          role: input.role,
          scopes: input.scopes,
          ...(input.authToken || input.password
            ? {
                auth: {
                  ...(input.authToken ? { token: input.authToken } : {}),
                  ...(input.password ? { password: input.password } : {}),
                },
              }
            : {}),
        };
        // Sign exactly like a real run so the probe sees the same pairing and scope answer.
        if (input.deviceIdentity) {
          const payload = buildDeviceAuthPayloadV3({
            deviceId: input.deviceIdentity.deviceId,
            clientId: input.clientId,
            clientMode: input.clientMode,
            role: input.role,
            scopes: input.scopes,
            signedAtMs,
            token: input.authToken,
            nonce,
            platform: process.platform,
          });
          params.device = {
            id: input.deviceIdentity.deviceId,
            publicKey: input.deviceIdentity.publicKeyRawBase64Url,
            signature: signDevicePayload(input.deviceIdentity.privateKeyPem, payload),
            signedAt: signedAtMs,
            nonce,
          };
        }
        ws.send(JSON.stringify({ type: "req", id: connectId, method: "connect", params }));
        return;
      }

      if (event?.type === "res") {
        if (event.ok === true) {
          finish({ status: "ok", grantedScopes: extractGrantedScopes(asRecord(event.payload)) });
        } else {
          const error = asRecord(event.error);
          const details = asRecord(error?.details);
          finish({
            status: "challenge_only",
            errorMessage: nonEmpty(error?.message) ?? nonEmpty(error?.code),
            pairingRequestId: nonEmpty(details?.requestId),
          });
        }
      }
    });

    ws.on("error", (err) => {
      finish({ status: "failed", errorMessage: err instanceof Error ? err.message : String(err) });
    });

    ws.on("close", () => {
      if (!completed) finish({ status: "failed", errorMessage: "gateway closed the connection" });
    });
  });
}

function containsRedactedPlaceholder(value: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (typeof value === "string") return value.includes("***REDACTED***");
  if (Array.isArray(value)) return value.some((entry) => containsRedactedPlaceholder(entry, depth + 1));
  const record = asRecord(value);
  return record ? Object.values(record).some((entry) => containsRedactedPlaceholder(entry, depth + 1)) : false;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const urlValue = asString(config.url, "").trim();

  if (!urlValue) {
    checks.push({
      code: "openclaw_gateway_url_missing",
      level: "error",
      message: "OpenClaw gateway adapter requires a WebSocket URL.",
      hint: "Set adapterConfig.url to ws://host:port (or wss://).",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  let url: URL | null = null;
  try {
    url = new URL(urlValue);
  } catch {
    checks.push({
      code: "openclaw_gateway_url_invalid",
      level: "error",
      message: `Invalid URL: ${urlValue}`,
    });
  }

  if (url && url.protocol !== "ws:" && url.protocol !== "wss:") {
    checks.push({
      code: "openclaw_gateway_url_protocol_invalid",
      level: "error",
      message: `Unsupported URL protocol: ${url.protocol}`,
      hint: "Use ws:// or wss://.",
    });
  }

  if (url) {
    checks.push({
      code: "openclaw_gateway_url_valid",
      level: "info",
      message: `Configured gateway URL: ${url.toString()}`,
    });

    if (url.protocol === "ws:" && !isLoopbackHost(url.hostname)) {
      checks.push({
        code: "openclaw_gateway_plaintext_remote_ws",
        level: "warn",
        message: "Gateway URL uses plaintext ws:// on a non-loopback host.",
        hint: "Prefer wss:// for remote gateways.",
      });
    }
  }

  const headers = toStringRecord(config.headers);
  const authToken = resolveAuthToken(config, headers);
  const password = nonEmpty(config.password);
  const role = nonEmpty(config.role) ?? "operator";
  const scopes = toStringArray(config.scopes);

  if (authToken || password) {
    checks.push({
      code: "openclaw_gateway_auth_present",
      level: "info",
      message: "Gateway credentials are configured.",
    });
  } else {
    checks.push({
      code: "openclaw_gateway_auth_missing",
      level: "warn",
      message: "No gateway credentials detected in adapter config.",
      hint: "Set authToken/password or headers.x-openclaw-token for authenticated gateways.",
    });
  }

  if (containsRedactedPlaceholder(config)) {
    checks.push({
      code: "openclaw_gateway_config_redacted_placeholder",
      level: "error",
      message: "Some settings contain the masked placeholder ***REDACTED*** instead of a real value.",
      hint: "Re-enter the gateway token and generate a new device key; the placeholder was saved by mistake.",
    });
  }

  const disableDeviceAuth = config.disableDeviceAuth === true || config.disableDeviceAuth === "true";
  let deviceIdentity: GatewayDeviceIdentity | null = null;
  if (disableDeviceAuth) {
    checks.push({
      code: "openclaw_gateway_device_auth_disabled",
      level: "warn",
      message: "Device auth is disabled. Current OpenClaw gateways grant no operator scopes without a device identity.",
      hint: "Turn device auth back on; Paperclip signs with this agent's device key and OpenClaw needs one approval.",
    });
  } else if (nonEmpty(config.devicePrivateKeyPem)) {
    try {
      deviceIdentity = resolveDeviceIdentity({ devicePrivateKeyPem: config.devicePrivateKeyPem });
      checks.push({
        code: "openclaw_gateway_device_key_valid",
        level: "info",
        message: `Device key is valid (deviceId ${deviceIdentity.deviceId.slice(0, 12)}…).`,
      });
    } catch {
      checks.push({
        code: "openclaw_gateway_device_key_invalid",
        level: "error",
        message: "The stored device private key is not a valid PEM key.",
        hint: "Generate a new Ed25519 device key for this agent, then approve the new device once in OpenClaw.",
      });
    }
  } else {
    checks.push({
      code: "openclaw_gateway_device_key_missing",
      level: "warn",
      message: "No device private key is stored, so every run uses a new temporary device that OpenClaw has not approved.",
      hint: "Store an Ed25519 devicePrivateKeyPem for this agent (agents that join through an invite get one automatically).",
    });
  }

  checks.push({
    code: "openclaw_gateway_claimed_api_key_path",
    level: "info",
    message: `The agent must keep its Paperclip API key at ${resolveClaimedApiKeyPath(config.claimedApiKeyPath)} on the OpenClaw host.`,
  });

  if (url && (url.protocol === "ws:" || url.protocol === "wss:")) {
    try {
      const effectiveScopes = scopes.length > 0 ? scopes : ["operator.admin"];
      const probeResult = await probeGateway({
        url: url.toString(),
        headers,
        authToken,
        password,
        role,
        scopes: effectiveScopes,
        clientId: nonEmpty(config.clientId) ?? DEFAULT_CLIENT_ID,
        clientMode: nonEmpty(config.clientMode) ?? DEFAULT_CLIENT_MODE,
        deviceIdentity,
        timeoutMs: 3_000,
      });
      const signedWith = deviceIdentity ? "this agent's device key" : "the gateway token only";

      if (probeResult.status === "ok") {
        checks.push({
          code: "openclaw_gateway_probe_ok",
          level: "info",
          message: `Gateway connect probe succeeded (signed with ${signedWith}).`,
        });
        const granted = probeResult.grantedScopes;
        if (granted && !granted.some((scope) => scope === "operator.admin" || scope === "operator.write")) {
          checks.push({
            code: "openclaw_gateway_probe_missing_write_scope",
            level: "warn",
            message: `The gateway granted scopes [${granted.join(", ") || "none"}], so runs will fail with "missing scope: operator.write".`,
            hint: "Keep device auth enabled and approve this agent's device in OpenClaw with operator scopes.",
          });
        } else if (granted) {
          checks.push({
            code: "openclaw_gateway_probe_scopes",
            level: "info",
            message: `Granted scopes: ${granted.join(", ")}.`,
          });
        }
      } else if (probeResult.status === "challenge_only") {
        const reason = probeResult.errorMessage ?? "no reason given";
        const pairing = /pairing required|not[_ -]?paired/i.test(reason) || Boolean(probeResult.pairingRequestId);
        checks.push({
          code: pairing ? "openclaw_gateway_probe_pairing_required" : "openclaw_gateway_probe_challenge_only",
          level: "warn",
          message: pairing
            ? `OpenClaw is waiting for you to approve this agent's device (${reason}).`
            : `Gateway rejected the connect probe: ${reason}.`,
          hint: pairing
            ? `In OpenClaw run: openclaw devices approve ${probeResult.pairingRequestId ?? "<requestId>"} — then test again.`
            : "Check gateway credentials, scopes, role, and device-auth requirements.",
        });
      } else {
        checks.push({
          code: "openclaw_gateway_probe_failed",
          level: "warn",
          message: `Gateway probe failed${probeResult.errorMessage ? `: ${probeResult.errorMessage}` : "."}`,
          hint: "Verify network reachability and gateway URL from the Paperclip server host.",
        });
      }
    } catch (err) {
      checks.push({
        code: "openclaw_gateway_probe_error",
        level: "warn",
        message: err instanceof Error ? err.message : "Gateway probe failed",
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
