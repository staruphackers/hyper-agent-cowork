import { describe, expect, it } from "vitest";
import {
  buildOpenClawReplayAdapterConfig,
  findOpenClawCredentialsCarriedToNewGateway,
  findOpenClawReplayLockedChanges,
} from "../routes/openclaw-credential-guard.js";

const stored = {
  url: "wss://gateway.example/ws?session=abc",
  authToken: "stored-auth-token",
  password: "stored-password",
  headers: { "x-openclaw-token": "stored-header-token" },
  devicePrivateKeyPem: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
};

describe("findOpenClawCredentialsCarriedToNewGateway", () => {
  it("flags every stored credential restored from placeholders when the gateway host changes", () => {
    const requested = {
      url: "wss://other-gateway.example/ws",
      authToken: "***REDACTED***",
      password: "***REDACTED***",
      headers: { "x-openclaw-token": "***REDACTED***" },
      devicePrivateKeyPem: "***REDACTED***",
    };
    const effective = { ...stored, url: requested.url };
    expect(
      findOpenClawCredentialsCarriedToNewGateway({ requestedConfig: requested, existingConfig: stored, effectiveConfig: effective }),
    ).toEqual(["authToken", "password", "headers.x-openclaw-token"]);
  });

  it("flags credentials a partial PATCH would merge in when only the url is sent", () => {
    const effective = { ...stored, url: "wss://other-gateway.example/ws" };
    expect(
      findOpenClawCredentialsCarriedToNewGateway({
        requestedConfig: { url: effective.url },
        existingConfig: stored,
        effectiveConfig: effective,
      }),
    ).toEqual(["authToken", "password", "headers.x-openclaw-token"]);
  });

  it("allows a new gateway when every credential is typed in again (even with the same value)", () => {
    const requested = {
      url: "wss://other-gateway.example/ws",
      authToken: "stored-auth-token",
      password: "new-password",
      headers: { "x-openclaw-token": "new-header-token" },
    };
    const effective = { ...stored, ...requested };
    expect(
      findOpenClawCredentialsCarriedToNewGateway({ requestedConfig: requested, existingConfig: stored, effectiveConfig: effective }),
    ).toEqual([]);
  });

  it("does not ask for the device private key, which never leaves this server", () => {
    const { authToken: _a, password: _p, headers: _h, ...keyOnly } = stored;
    const effective = { ...keyOnly, url: "wss://other-gateway.example/ws" };
    expect(
      findOpenClawCredentialsCarriedToNewGateway({
        requestedConfig: { ...effective, devicePrivateKeyPem: "***REDACTED***" },
        existingConfig: keyOnly,
        effectiveConfig: effective,
      }),
    ).toEqual([]);
  });

  it.each([
    ["same url", "wss://gateway.example/ws?session=abc"],
    ["trailing slash and case", "wss://GATEWAY.example/ws/"],
    ["different query token", "wss://gateway.example/ws?session=***REDACTED***"],
  ])("treats %s as the same gateway", (_label, url) => {
    const effective = { ...stored, url };
    expect(
      findOpenClawCredentialsCarriedToNewGateway({
        requestedConfig: { url, authToken: "***REDACTED***" },
        existingConfig: stored,
        effectiveConfig: effective,
      }),
    ).toEqual([]);
  });

  it("treats a downgrade from wss to ws as a new destination (credentials would travel unencrypted)", () => {
    const effective = { ...stored, url: "ws://gateway.example/ws" };
    expect(
      findOpenClawCredentialsCarriedToNewGateway({
        requestedConfig: { url: effective.url, authToken: "***REDACTED***" },
        existingConfig: stored,
        effectiveConfig: effective,
      }),
    ).toEqual(["authToken", "password", "headers.x-openclaw-token"]);
  });

  it("allows an upgrade from ws to wss on the same gateway without re-entry", () => {
    const plain = { ...stored, url: "ws://gateway.example/ws" };
    const effective = { ...plain, url: "wss://gateway.example/ws" };
    expect(
      findOpenClawCredentialsCarriedToNewGateway({
        requestedConfig: { url: effective.url, authToken: "***REDACTED***" },
        existingConfig: plain,
        effectiveConfig: effective,
      }),
    ).toEqual([]);
  });

  it("treats a different path on the same host as a different gateway", () => {
    const effective = { ...stored, url: "wss://gateway.example/other" };
    expect(
      findOpenClawCredentialsCarriedToNewGateway({ requestedConfig: { url: effective.url }, existingConfig: stored, effectiveConfig: effective }),
    ).toContain("authToken");
  });
});

describe("invite replay on an approved agent (zhtw.10 D1-A whitelist)", () => {
  const live = {
    url: "wss://gateway.example/ws",
    headers: { "x-openclaw-token": "old-token", "x-trace": "kept" },
    claimedApiKeyPath: "/data/.openclaw/workspace/paperclip-claimed-api-key.json",
    paperclipApiUrl: "https://cowork.example",
    timeoutSec: 600,
  };

  it("allows only the gateway token, and ignores fields the request did not send", () => {
    const normalized = { ...live, url: "wss://stale-from-first-join.example/ws", headers: { "x-openclaw-token": "new-token" } };
    expect(findOpenClawReplayLockedChanges(live, normalized, ["headers"])).toEqual([]);
  });

  it("treats the same Paperclip URL with or without a trailing slash as unchanged", () => {
    expect(
      findOpenClawReplayLockedChanges(
        { ...live, paperclipApiUrl: "https://cowork.example" },
        { ...live, paperclipApiUrl: "https://cowork.example/" },
        ["paperclipApiUrl"],
      ),
    ).toEqual([]);
  });

  it("refuses a new Paperclip URL (Kimi D2-A: the agent sends its Paperclip API key there)", () => {
    expect(
      findOpenClawReplayLockedChanges(live, { ...live, paperclipApiUrl: "https://attacker.example" }, ["paperclipApiUrl"]),
    ).toEqual(["paperclipApiUrl"]);
  });

  it("refuses every other field the request changes, including payloadTemplate and scopes", () => {
    const normalized = {
      ...live,
      url: "ws://gateway.example/ws",
      claimedApiKeyPath: "~/.openclaw/x.json",
      disableDeviceAuth: true,
      payloadTemplate: { agentId: "other" },
      scopes: ["operator.admin"],
    };
    expect(
      findOpenClawReplayLockedChanges(live, normalized, [
        "url", "claimedApiKeyPath", "disableDeviceAuth", "payloadTemplate", "scopes",
      ]),
    ).toEqual(["url", "claimedApiKeyPath", "disableDeviceAuth", "payloadTemplate", "scopes"]);
  });

  it("does not refuse a sent field whose value is unchanged (case, trailing slash, false vs unset)", () => {
    const normalized = { ...live, url: "wss://GATEWAY.example/ws/", disableDeviceAuth: false };
    expect(findOpenClawReplayLockedChanges(live, normalized, ["url", "disableDeviceAuth"])).toEqual([]);
  });

  it("writes only the sent refreshable fields on top of the live config", () => {
    const normalized = {
      url: "wss://stale-from-first-join.example/ws",
      headers: { "X-OpenClaw-Token": "new-token", "x-trace": "stale" },
      devicePrivateKeyPem: "stale-key",
      paperclipApiUrl: "https://cowork-2.example",
    };
    expect(
      buildOpenClawReplayAdapterConfig(live, normalized, ["headers"], { "x-openclaw-token": "new-token" }),
    ).toEqual({ ...live, headers: { "X-OpenClaw-Token": "new-token", "x-trace": "kept" } });
  });
});
