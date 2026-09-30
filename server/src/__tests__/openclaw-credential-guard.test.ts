import { describe, expect, it } from "vitest";
import { findOpenClawCredentialsCarriedToNewGateway } from "../routes/openclaw-credential-guard.js";

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
    ["ws instead of wss", "ws://gateway.example/ws"],
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

  it("treats a different path on the same host as a different gateway", () => {
    const effective = { ...stored, url: "wss://gateway.example/other" };
    expect(
      findOpenClawCredentialsCarriedToNewGateway({ requestedConfig: { url: effective.url }, existingConfig: stored, effectiveConfig: effective }),
    ).toContain("authToken");
  });
});
