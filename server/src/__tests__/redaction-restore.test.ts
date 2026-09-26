import { describe, expect, it } from "vitest";
import {
  REDACTED_EVENT_VALUE,
  containsRedactedPlaceholder,
  redactAgentAdapterConfig,
  restoreRedactedAgentAdapterConfig,
} from "../redaction.js";

const PEM = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIFAKEFAKEFAKE\n-----END PRIVATE KEY-----\n";

const storedOpenClawConfig = {
  url: "wss://gateway.example.test/ws",
  authToken: "stored-auth-token",
  password: "stored-password",
  devicePrivateKeyPem: PEM,
  headers: {
    "x-openclaw-token": "stored-header-token",
    "x-trace": "visible",
  },
  env: {
    PLAIN_STRING: "stored-env-string",
    PLAIN_BINDING: { type: "plain", value: "stored-env-binding" },
  },
};

describe("restoreRedactedAgentAdapterConfig", () => {
  it("round-trips a redacted read back to the stored config", () => {
    const displayed = redactAgentAdapterConfig(storedOpenClawConfig);
    // Guard the premise: the read really hides these values.
    expect(displayed.devicePrivateKeyPem).toBe(REDACTED_EVENT_VALUE);
    expect((displayed.headers as Record<string, unknown>)["x-openclaw-token"]).toBe(REDACTED_EVENT_VALUE);
    expect(displayed.authToken).toBe(REDACTED_EVENT_VALUE);
    expect(displayed.password).toBe(REDACTED_EVENT_VALUE);

    const { config, unresolvedPaths } = restoreRedactedAgentAdapterConfig(displayed, storedOpenClawConfig);
    expect(unresolvedPaths).toEqual([]);
    expect(config).toEqual(storedOpenClawConfig);
    expect(containsRedactedPlaceholder(config)).toBe(false);
  });

  it("keeps genuinely changed values and restores only untouched placeholders", () => {
    const displayed = redactAgentAdapterConfig(storedOpenClawConfig) as Record<string, any>;
    const edited = {
      ...displayed,
      authToken: "new-auth-token",
      headers: { ...displayed.headers, "x-trace": "changed" },
    };
    const { config } = restoreRedactedAgentAdapterConfig(edited, storedOpenClawConfig);
    expect(config.authToken).toBe("new-auth-token");
    expect(config.headers).toEqual({ "x-openclaw-token": "stored-header-token", "x-trace": "changed" });
    expect(config.devicePrivateKeyPem).toBe(PEM);
  });

  it("drops a placeholder with no stored value instead of persisting it", () => {
    const { config, unresolvedPaths } = restoreRedactedAgentAdapterConfig(
      {
        authToken: REDACTED_EVENT_VALUE,
        headers: { "x-new-token": REDACTED_EVENT_VALUE },
        env: { MISSING: { type: "plain", value: REDACTED_EVENT_VALUE } },
      },
      { env: {} },
    );
    expect(unresolvedPaths).toEqual([]);
    expect(config).toEqual({ headers: {}, env: {} });
  });

  it("never moves a stored secret to a different key", () => {
    // `url` is stored in the clear, so a placeholder there cannot map to it,
    // and `authToken`'s value must not leak into `url`.
    const { config } = restoreRedactedAgentAdapterConfig(
      { url: REDACTED_EVENT_VALUE, token: REDACTED_EVENT_VALUE },
      { url: "wss://gateway.example.test/ws", authToken: "stored-auth-token" },
    );
    expect(config).toEqual({});
  });

  it("reports placeholders it cannot resolve instead of guessing", () => {
    const { unresolvedPaths } = restoreRedactedAgentAdapterConfig(
      {
        args: ["--token", REDACTED_EVENT_VALUE, "--extra"],
        headers: { authorization: `Bearer ${REDACTED_EVENT_VALUE} extra` },
      },
      { args: ["--verbose"], headers: { authorization: "Bearer stored" } },
    );
    expect(unresolvedPaths).toEqual(["args[1]", "headers.authorization"]);
  });

  it("restores unchanged array elements by position", () => {
    const stored = { commandArgs: ["--token", "stored-cli-token", "--verbose"] };
    const displayed = redactAgentAdapterConfig(stored);
    expect(displayed.commandArgs).toEqual(["--token", REDACTED_EVENT_VALUE, "--verbose"]);
    const { config, unresolvedPaths } = restoreRedactedAgentAdapterConfig(displayed, stored);
    expect(unresolvedPaths).toEqual([]);
    expect(config).toEqual(stored);
  });

  it("shows boolean flags under auth-looking keys and round-trips them unchanged", () => {
    const stored = { disableDeviceAuth: true, requireAuth: false, autoPairOnFirstConnect: true, authTimeoutMs: 5000 };
    const displayed = redactAgentAdapterConfig(stored);
    expect(displayed.disableDeviceAuth).toBe(true);
    expect(displayed.requireAuth).toBe(false);
    expect(displayed.autoPairOnFirstConnect).toBe(true);
    // Numbers stay hidden (they can hold a PIN) but are restored on save.
    expect(displayed.authTimeoutMs).toBe(REDACTED_EVENT_VALUE);
    const { config, unresolvedPaths } = restoreRedactedAgentAdapterConfig(displayed, stored);
    expect(unresolvedPaths).toEqual([]);
    expect(config).toEqual(stored);
  });

  it("repairs a placeholder already written into a boolean flag by an older client", () => {
    // Pre-fix reads showed `disableDeviceAuth` as the placeholder; a client that
    // echoes it back must get the stored boolean, not the string.
    const { config } = restoreRedactedAgentAdapterConfig(
      { disableDeviceAuth: REDACTED_EVENT_VALUE },
      { disableDeviceAuth: true },
    );
    // The stored boolean is now displayed as-is, so the placeholder no longer
    // matches it and is dropped; a merge-mode PATCH then keeps the stored value.
    expect(config).toEqual({});
  });
});
