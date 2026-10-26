import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("does not embed the model catalogue when the configured model is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paperclip-pi-models-"));
    const command = join(directory, "pi");
    const modelIds = Array.from({ length: 13 }, (_, index) => `provider/model-${index}`);
    await writeFile(
      command,
      `#!/bin/sh\nprintf 'provider  model\\n';\n${modelIds
        .map((id) => {
          const [provider, model] = id.split("/");
          return `printf '${provider}  ${model}\\n'`;
        })
        .join(";\n")}\n`,
    );
    await chmod(command, 0o755);

    try {
      await expect(
        ensurePiModelConfiguredAndAvailable({
          command,
          model: "provider/missing",
        }),
      ).rejects.toMatchObject({
        message:
          "Configured Pi model is unavailable: provider/missing. 13 models are available; list them with `pi --list-models`.",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
