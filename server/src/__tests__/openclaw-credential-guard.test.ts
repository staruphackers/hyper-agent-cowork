import { describe, expect, it } from "vitest";
import {
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

describe("findOpenClawReplayLockedChanges (invite replay on an approved agent)", () => {
  const live = {
    url: "wss://gateway.example/ws",
    headers: { "x-openclaw-token": "old-token" },
    claimedApiKeyPath: "/data/.openclaw/workspace/paperclip-claimed-api-key.json",
    paperclipApiUrl: "https://cowork.example",
  };

  it("allows the upstream uses: a new gateway token and a new Paperclip URL", () => {
    expect(
      findOpenClawReplayLockedChanges(live, {
        ...live,
        headers: { "x-openclaw-token": "new-token" },
        paperclipApiUrl: "https://cowork-2.example",
        url: "wss://GATEWAY.example/ws/",
      }),
    ).toEqual([]);
  });

  it("refuses a new gateway URL, a wss→ws downgrade, a new key path and turning device auth off", () => {
    expect(
      findOpenClawReplayLockedChanges(live, {
        ...live,
        url: "wss://attacker.example/ws",
        claimedApiKeyPath: "~/.openclaw/x.json",
        disableDeviceAuth: true,
      }),
    ).toEqual(["url", "claimedApiKeyPath", "disableDeviceAuth"]);
    expect(findOpenClawReplayLockedChanges(live, { ...live, url: "ws://gateway.example/ws" })).toEqual(["url"]);
  });

  it("treats a removed key path as a change", () => {
    const { claimedApiKeyPath: _gone, ...withoutPath } = live;
    expect(findOpenClawReplayLockedChanges(live, withoutPath)).toEqual(["claimedApiKeyPath"]);
  });
});
