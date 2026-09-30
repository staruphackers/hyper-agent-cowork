#!/usr/bin/env node
// Read-only health check for OpenClaw gateway agents.
//
// Run it inside the Paperclip container:
//   docker exec -i <container> node /app/scripts/openclaw-doctor.mjs
//
// It never prints setting values: only setting names, agent names, short ids,
// the gateway scheme and host, and PASS / WARN / FAIL. It never writes to the
// database.
// Exit code: 0 when nothing failed, 1 when at least one FAIL, 2 when it could
// not read the database.

import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const REDACTED_MARKER = "***REDACTED***";
export const DEFAULT_CLAIMED_API_KEY_PATH = "~/.openclaw/workspace/paperclip-claimed-api-key.json";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Same rule as isSafeClaimedApiKeyPath in the openclaw-gateway adapter
// (packages/adapters/openclaw-gateway/src/index.ts); the adapter ignores any
// other value and falls back to the default path.
export function isSafeClaimedApiKeyPath(value) {
  if (typeof value !== "string" || value.length > 512) return false;
  if (!/^(?:~\/|\/)[A-Za-z0-9._\-/]+\.json$/.test(value)) return false;
  return !value.split("/").includes("..");
}

/** Scheme and host only: no userinfo, path or query, which can carry secrets. */
export function displayGateway(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "(unreadable URL)";
  }
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Setting paths (not values) that still hold the masked placeholder. */
export function findRedactedPaths(value, prefix = "", depth = 0) {
  if (depth > 8) return [];
  if (typeof value === "string") return value.includes(REDACTED_MARKER) ? [prefix || "(root)"] : [];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findRedactedPaths(entry, `${prefix}[${index}]`, depth + 1));
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, entry]) =>
      findRedactedPaths(entry, prefix ? `${prefix}.${key}` : key, depth + 1),
    );
  }
  return [];
}

function headerValue(headers, name) {
  if (!isRecord(headers)) return undefined;
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return match ? match[1] : undefined;
}

function hasCredential(value) {
  // A stored secret reference (object) counts as configured.
  const text = nonEmpty(value);
  if (text !== null) return !text.includes(REDACTED_MARKER);
  return isRecord(value);
}

export function gatewayIdentityKey(config) {
  const rawUrl = nonEmpty(config?.url);
  if (!rawUrl) return null;
  let url;
  try {
    const parsed = new URL(rawUrl);
    // ws:// and wss:// to the same host and path reach the same gateway.
    url = `${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    url = rawUrl.replace(/^wss?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
  }
  const agentId = isRecord(config?.payloadTemplate) ? nonEmpty(config.payloadTemplate.agentId) ?? "" : "";
  return `${url}#${agentId}`;
}

/**
 * @param {Array<{id: string, name: string, status: string, adapterConfig: unknown}>} agents
 *   live openclaw_gateway agents
 * @returns {Array<{agent: string, level: "PASS"|"WARN"|"FAIL"|"INFO", check: string, detail: string}>}
 */
export function evaluateOpenClawAgents(agents) {
  const results = [];
  const byGateway = new Map();

  for (const agent of agents) {
    const label = `${agent.name} (${String(agent.id).slice(0, 8)})`;
    const push = (level, check, detail) => results.push({ agent: label, level, check, detail });
    const config = isRecord(agent.adapterConfig) ? agent.adapterConfig : {};

    const redacted = findRedactedPaths(config);
    if (redacted.length > 0) {
      push("FAIL", "masked-placeholder", `These settings hold ${REDACTED_MARKER} instead of a real value: ${redacted.join(", ")}`);
    } else {
      push("PASS", "masked-placeholder", "No masked placeholders in the settings");
    }

    const url = nonEmpty(config.url);
    if (!url) {
      push("FAIL", "gateway-url", "No gateway URL");
    } else if (url.startsWith("wss://")) {
      push("PASS", "gateway-url", displayGateway(url));
    } else if (url.startsWith("ws://")) {
      push("WARN", "gateway-url", `${displayGateway(url)} is not encrypted (use wss:// for remote gateways)`);
    } else {
      push("FAIL", "gateway-url", "Gateway URL must start with ws:// or wss://");
    }

    const tokenConfigured =
      hasCredential(config.authToken) ||
      hasCredential(config.token) ||
      hasCredential(config.password) ||
      hasCredential(headerValue(config.headers, "x-openclaw-token")) ||
      hasCredential(headerValue(config.headers, "x-openclaw-auth")) ||
      hasCredential(headerValue(config.headers, "authorization"));
    push(tokenConfigured ? "PASS" : "FAIL", "gateway-token", tokenConfigured ? "Gateway token is set" : "No gateway token");

    const deviceAuthDisabled = config.disableDeviceAuth === true || config.disableDeviceAuth === "true";
    if (deviceAuthDisabled) {
      push("FAIL", "device-auth", "Device auth is disabled; OpenClaw will grant no operator scopes (missing scope: operator.write)");
    } else {
      const pem = nonEmpty(config.devicePrivateKeyPem);
      if (!pem) {
        push("WARN", "device-key", "No stored device key; every run uses a new temporary device that OpenClaw has not approved");
      } else {
        try {
          const key = crypto.createPrivateKey(pem);
          const type = key.asymmetricKeyType;
          push(type === "ed25519" ? "PASS" : "WARN", "device-key", `Device key is a valid ${type} key`);
        } catch {
          push("FAIL", "device-key", "Stored device key is not a valid PEM key; generate a new Ed25519 key and approve it in OpenClaw");
        }
      }
    }

    const scopes = Array.isArray(config.scopes)
      ? config.scopes
      : typeof config.scopes === "string"
        ? config.scopes.split(",").map((scope) => scope.trim())
        : null;
    if (scopes && !scopes.some((scope) => scope === "operator.admin" || scope === "operator.write")) {
      push("WARN", "scopes", "Requested scopes include neither operator.admin nor operator.write");
    }

    const customKeyPath = nonEmpty(config.claimedApiKeyPath);
    if (!customKeyPath) {
      push("INFO", "api-key-path", `Agent must keep its Paperclip key at ${DEFAULT_CLAIMED_API_KEY_PATH} on the OpenClaw host`);
    } else if (isSafeClaimedApiKeyPath(customKeyPath)) {
      push("INFO", "api-key-path", "Agent uses a custom key path (set in claimedApiKeyPath) on the OpenClaw host");
    } else {
      push("WARN", "api-key-path", `claimedApiKeyPath is not a plain .json file path, so Paperclip ignores it and uses ${DEFAULT_CLAIMED_API_KEY_PATH}`);
    }

    const key = gatewayIdentityKey(config);
    if (key) {
      const entry = byGateway.get(key) ?? { labels: [], host: displayGateway(nonEmpty(config.url) ?? "") };
      entry.labels.push(label);
      byGateway.set(key, entry);
    }
  }

  for (const { labels, host } of byGateway.values()) {
    if (labels.length > 1) {
      results.push({
        agent: labels.join(" + "),
        level: "WARN",
        check: "duplicate-agent",
        detail: `${labels.length} live agents point at the same OpenClaw gateway (${host}); archive the extra one`,
      });
    }
  }

  return results;
}

export function formatReport(results) {
  if (results.length === 0) return "No live openclaw_gateway agents found.\n";
  const lines = results.map((row) => `[${row.level}] ${row.agent} · ${row.check} · ${row.detail}`);
  const counts = ["PASS", "WARN", "FAIL"].map((level) => `${level} ${results.filter((row) => row.level === level).length}`);
  return `${lines.join("\n")}\n\nSummary: ${counts.join(" / ")}\n`;
}

async function loadAgentsFromDatabase() {
  const require = createRequire(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages/db/package.json"));
  const postgres = require("postgres");
  const url = process.env.DATABASE_URL || "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
  const sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 10 });
  try {
    return await sql.begin("read only", (tx) => tx`
      select id, name, status, adapter_config as "adapterConfig"
      from agents
      where adapter_type = 'openclaw_gateway' and status <> 'terminated'
      order by name`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  let agents;
  try {
    agents = await loadAgentsFromDatabase();
  } catch (error) {
    // Print only the error class and code; connection strings can hold passwords.
    const code = error && typeof error === "object" && "code" in error ? error.code : "unknown";
    process.stderr.write(`openclaw-doctor: could not read the database (${error?.name ?? "Error"}, code ${code}). Set DATABASE_URL if the database is not the embedded one.\n`);
    process.exit(2);
  }
  const results = evaluateOpenClawAgents(agents);
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    process.stdout.write(formatReport(results));
  }
  process.exit(results.some((row) => row.level === "FAIL") ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
