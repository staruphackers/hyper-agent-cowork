import { describe, expect, it } from "vitest";
import {
  buildOpenClawReplayAdapterConfig,
  findOpenClawCredentialsCarriedToNewGateway,
  findOpenClawReplayLockedChanges,
  redactUrlSecrets,
  reviewOpenClawReplayHeaders,
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

  it("writes only the gateway token on top of the live config, under x-openclaw-token", () => {
    expect(buildOpenClawReplayAdapterConfig(live, "new-token")).toEqual({
      ...live,
      headers: { "x-trace": "kept", "x-openclaw-token": "new-token" },
    });
    expect(buildOpenClawReplayAdapterConfig(live, null)).toEqual(live);
  });

  it("takes the token from the request, whatever the header name case", () => {
    expect(reviewOpenClawReplayHeaders(live, { "X-OpenClaw-Token": " new-token " })).toEqual({
      token: "new-token",
      lockedFields: [],
      invalidToken: false,
    });
  });

  // Fifth review: comparing with the live value would tell the invite holder
  // whether a guess matches a stored header (e.g. Authorization).
  it("refuses any non-token header, even one equal to the live value", () => {
    expect(reviewOpenClawReplayHeaders(live, { "X-Trace": "kept" }).lockedFields).toEqual(["headers.X-Trace"]);
    expect(reviewOpenClawReplayHeaders(live, { "x-trace": "other" }).lockedFields).toEqual(["headers.x-trace"]);
  });

  it("refuses a refresh when the agent has no gateway token header to replace", () => {
    const noHeaderToken = { ...live, headers: { "x-trace": "kept" }, password: "gateway-password" };
    expect(reviewOpenClawReplayHeaders(noHeaderToken, { "x-openclaw-token": "new-token" })).toEqual({
      token: null,
      lockedFields: ["headers.x-openclaw-token"],
      invalidToken: false,
    });
  });

  it("refuses a refresh when the owner also set Authorization, even with the current token (no guessing)", () => {
    const withAuthorization = { ...live, headers: { ...live.headers, Authorization: "Bearer owner-token" } };
    expect(reviewOpenClawReplayHeaders(withAuthorization, { "x-openclaw-token": "old-token" }).lockedFields).toEqual([
      "headers.x-openclaw-token",
    ]);
  });

  it("treats a bare 'Bearer' as an invalid token, not as the token itself", () => {
    expect(reviewOpenClawReplayHeaders(live, { "x-openclaw-token": "Bearer" }).invalidToken).toBe(true);
    expect(reviewOpenClawReplayHeaders(live, { "x-openclaw-token": "Bearer   " }).invalidToken).toBe(true);
  });

  it("accepts a legacy 'Bearer <token>' value and stores just the token", () => {
    expect(reviewOpenClawReplayHeaders(live, { "x-openclaw-auth": "Bearer new-token" }).token).toBe("new-token");
  });

  it("flags a token with whitespace or control characters", () => {
    expect(reviewOpenClawReplayHeaders(live, { "x-openclaw-token": "a b" }).invalidToken).toBe(true);
    expect(reviewOpenClawReplayHeaders(live, { "x-openclaw-token": 42 }).invalidToken).toBe(true);
  });
});

describe("redactUrlSecrets", () => {
  it("masks the whole userinfo even when the password contains @, and the fragment", () => {
    expect(redactUrlSecrets("wss://user:p@ss@gw.example/x#frag")).toBe("wss://***@gw.example/x#***");
  });

  // Sixth review N1/N2/N4.
  it("does not stop at a quote inside the URL", () => {
    expect(redactUrlSecrets("wss://user:pa'ss@host/x?token=abc'def")).toBe("wss://***@host/x?***");
  });

  it("masks URLs whose scheme run starts with a non-letter", () => {
    expect(redactUrlSecrets("1wss://u:PW@h/")).toBe("1wss://***@h/");
    expect(redactUrlSecrets("-wss://u:PW@h/?t=1")).toBe("-wss://***@h/?***");
  });

  it("does not overflow the stack on deeply nested input", () => {
    let nested: unknown = "wss://u:p@h/";
    for (let i = 0; i < 20_000; i += 1) nested = [nested];
    expect(() => redactUrlSecrets(nested)).not.toThrow();
  });

  it("runs in linear time on hostile input (fifth review ReDoS)", () => {
    const inputs = ["a".repeat(200_000), `http://${"a".repeat(200_000)}`, "a://".repeat(50_000), `x?${"y".repeat(200_000)}`];
    for (const input of inputs) {
      const started = performance.now();
      redactUrlSecrets({ message: input });
      expect(performance.now() - started).toBeLessThan(250);
    }
  });

  it("masks user:password@ and query strings inside URLs, deeply", () => {
    expect(
      redactUrlSecrets({
        message: "Gateway endpoint set to wss://u:pw@gw.example/x?token=SECRET",
        list: ["https://cowork.example/path"],
      }),
    ).toEqual({
      message: "Gateway endpoint set to wss://***@gw.example/x?***",
      list: ["https://cowork.example/path"],
    });
  });
});
