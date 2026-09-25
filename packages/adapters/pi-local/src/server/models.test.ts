import { afterEach, describe, expect, it } from "vitest";
import {
  PI_LISTING_PLACEHOLDER_ENV_KEYS,
  PI_LISTING_PLACEHOLDER_VALUE,
  ensurePiModelConfiguredAndAvailable,
  listPiModels,
  resetPiModelsCacheForTests,
  withPiListingPlaceholders,
} from "./models.js";

describe("pi models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_PI_COMMAND;
    resetPiModelsCacheForTests();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(listPiModels()).resolves.toEqual([]);
  });

  it("fills placeholder credentials only for providers that have none", () => {
    const env = withPiListingPlaceholders({ OPENCODE_API_KEY: "real-key", GROQ_API_KEY: "   ", HOME: "/paperclip" });
    expect(env.OPENCODE_API_KEY).toBe("real-key");
    expect(env.GROQ_API_KEY).toBe(PI_LISTING_PLACEHOLDER_VALUE);
    expect(env.HOME).toBe("/paperclip");
    for (const key of PI_LISTING_PLACEHOLDER_ENV_KEYS) expect(env[key]).toBeTruthy();
    expect(Object.keys(env).sort()).toEqual([...PI_LISTING_PLACEHOLDER_ENV_KEYS, "HOME"].sort());
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensurePiModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("Pi requires `adapterConfig.model`");
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.PAPERCLIP_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(
      ensurePiModelConfiguredAndAvailable({
        model: "xai/grok-4",
      }),
    ).rejects.toThrow();
  });
});
