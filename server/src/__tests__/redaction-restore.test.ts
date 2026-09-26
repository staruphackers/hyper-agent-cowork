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
    const { config, unresolvedPaths } = restoreRedactedAgentAdapterConfig(
      { url: REDACTED_EVENT_VALUE, token: REDACTED_EVENT_VALUE },
      { url: "wss://gateway.example.test/ws", authToken: "stored-auth-token" },
    );
    // `url` has a stored value it cannot be mapped to, so it must be re-entered
    // (dropping it would delete the stored url on a replace-mode save).
    expect(unresolvedPaths).toEqual(["url"]);
    expect(JSON.stringify(config)).not.toContain("stored-auth-token");
    expect(config).not.toHaveProperty("token");
  });

  it("reports placeholders it cannot resolve instead of guessing", () => {
    const { unresolvedPaths } = restoreRedactedAgentAdapterConfig(
      {
        args: ["--token", REDACTED_EVENT_VALUE, "--extra"],
        headers: { authorization: `Bearer ${REDACTED_EVENT_VALUE} extra` },
      },
      { args: ["--verbose"], headers: { authorization: "Bearer stored" } },
    );
    expect(unresolvedPaths).toEqual(["args", "headers.authorization"]);
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
    // A boolean cannot be a credential, so the stored flag comes back as-is.
    expect(config).toEqual({ disableDeviceAuth: true });
  });

  it("refuses to restore by position in a reordered or shortened array", () => {
    const stored = {
      commandArgs: ["--api-key", "stored-api-key", "--token", "stored-token"],
      mcpServers: [{ name: "a", apiKey: "key-a" }, { name: "b", apiKey: "key-b" }],
    };
    const { config, unresolvedPaths } = restoreRedactedAgentAdapterConfig(
      {
        commandArgs: ["--token", REDACTED_EVENT_VALUE],
        mcpServers: [{ name: "b", apiKey: REDACTED_EVENT_VALUE }, { name: "a", apiKey: REDACTED_EVENT_VALUE }],
      },
      stored,
    );
    expect(unresolvedPaths).toEqual(["commandArgs", "mcpServers"]);
    expect(JSON.stringify(config)).not.toMatch(/stored-api-key|stored-token|key-a|key-b/);
  });

  it("does not treat a stored placeholder as a real value", () => {
    const { unresolvedPaths } = restoreRedactedAgentAdapterConfig(
      { devicePrivateKeyPem: REDACTED_EVENT_VALUE, env: { API_KEY: { type: "plain", value: REDACTED_EVENT_VALUE } } },
      { devicePrivateKeyPem: REDACTED_EVENT_VALUE, env: { API_KEY: REDACTED_EVENT_VALUE } },
    );
    expect(unresolvedPaths).toEqual(["devicePrivateKeyPem", "env.API_KEY"]);
  });

  it("reports edited env placeholders and drops env placeholders with no stored value", () => {
    const { config, unresolvedPaths } = restoreRedactedAgentAdapterConfig(
      {
        env: {
          EDITED: { type: "plain", value: `${REDACTED_EVENT_VALUE}x` },
          MISSING: { type: "plain", value: REDACTED_EVENT_VALUE },
        },
      },
      {},
    );
    expect(unresolvedPaths).toEqual(["env.EDITED"]);
    expect(config.env).not.toHaveProperty("MISSING");
  });

  it("does not let stored secrets follow a changed destination", () => {
    const stored = {
      url: "wss://gateway.example.test/ws",
      authToken: "stored-auth-token",
      headers: { "x-openclaw-token": "stored-header-token" },
      server: { baseUrl: "https://old.example.test", apiKey: "stored-server-key" },
    };
    const displayed = redactAgentAdapterConfig(stored);
    const moved = restoreRedactedAgentAdapterConfig({ ...displayed, url: "wss://other.example.test/ws" }, stored);
    expect(moved.unresolvedPaths).toEqual(["authToken", "headers.x-openclaw-token", "server.apiKey"]);
    expect(JSON.stringify(moved.config)).not.toMatch(/stored-/);

    const nested = restoreRedactedAgentAdapterConfig(
      { ...displayed, server: { baseUrl: "https://new.example.test", apiKey: REDACTED_EVENT_VALUE } },
      stored,
    );
    expect(nested.unresolvedPaths).toEqual(["server.apiKey"]);
    expect(nested.config.authToken).toBe("stored-auth-token");
  });
});
