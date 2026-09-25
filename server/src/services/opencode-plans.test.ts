import { describe, expect, it, vi } from "vitest";
import {
  OPENCODE_GO_MODELS_URL,
  OPENCODE_ZEN_MODELS_URL,
  extractOpenCodeModelIds,
  probeOpenCodePlans,
} from "./opencode-plans.js";

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

type ProbeInit = { headers: Record<string, string>; signal: AbortSignal };

describe("extractOpenCodeModelIds", () => {
  it("reads OpenAI-style lists and strips provider prefixes", () => {
    expect(
      extractOpenCodeModelIds({
        object: "list",
        data: [{ id: "opencode/claude-sonnet-5" }, { id: "gpt-6-luna" }, { id: "opencode-go/kimi-k3" }, { id: "" }],
      }),
    ).toEqual(["claude-sonnet-5", "gpt-6-luna", "kimi-k3"]);
  });
  it("reads bare arrays and { models } lists, deduplicating", () => {
    expect(extractOpenCodeModelIds(["b", "a", "a"])).toEqual(["a", "b"]);
    expect(extractOpenCodeModelIds({ models: [{ name: "glm-5.3" }, { id: "glm-5.3" }] })).toEqual(["glm-5.3"]);
  });
  it("returns nothing for unrecognised payloads", () => {
    expect(extractOpenCodeModelIds({ error: "nope" })).toEqual([]);
    expect(extractOpenCodeModelIds(null)).toEqual([]);
    expect(extractOpenCodeModelIds("text")).toEqual([]);
  });
});

describe("probeOpenCodePlans", () => {
  it("parses the live gateway shape: Zen lists free models only, Go lists the subscription catalog", async () => {
    const fetchImpl = vi.fn(async (url: string, _init: ProbeInit) =>
      url === OPENCODE_ZEN_MODELS_URL
        ? jsonResponse(200, {
            object: "list",
            data: [
              { id: "big-pickle", object: "model", created: 1790330410, owned_by: "opencode" },
              { id: "ling-3.0-flash-fin-free", object: "model", created: 1790330410, owned_by: "opencode" },
            ],
          })
        : jsonResponse(200, {
            object: "list",
            data: [
              { id: "deepseek-v4-flash", object: "model", created: 1790330411, owned_by: "opencode" },
              { id: "glm-5.2", object: "model", created: 1790330411, owned_by: "opencode" },
            ],
          }),
    );
    const result = await probeOpenCodePlans("sk-test-key", { fetchImpl });
    expect(result.zen).toEqual({ status: "active", models: ["big-pickle", "ling-3.0-flash-fin-free"], httpStatus: 200 });
    expect(result.go).toEqual({ status: "active", models: ["deepseek-v4-flash", "glm-5.2"], httpStatus: 200 });
  });

  it("marks both plans active when both endpoints list models for the key", async () => {
    const fetchImpl = vi.fn(async (url: string, _init: ProbeInit) =>
      url === OPENCODE_ZEN_MODELS_URL
        ? jsonResponse(200, { data: [{ id: "claude-sonnet-5" }, { id: "big-pickle" }] })
        : jsonResponse(200, { data: [{ id: "opencode-go/kimi-k3" }, { id: "qwen3.8-max" }] }),
    );
    const result = await probeOpenCodePlans("sk-test-key", { fetchImpl });
    expect(result.zen).toEqual({ status: "active", models: ["big-pickle", "claude-sonnet-5"], httpStatus: 200 });
    expect(result.go).toEqual({ status: "active", models: ["kimi-k3", "qwen3.8-max"], httpStatus: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const call of fetchImpl.mock.calls) {
      expect(call[1].headers.Authorization).toBe("Bearer sk-test-key");
      expect(call[1].signal).toBeInstanceOf(AbortSignal);
    }
    expect(typeof result.checkedAt).toBe("string");
  });

  it("marks a plan inactive on an auth-class rejection and active on the other", async () => {
    const fetchImpl = vi.fn(async (url: string, _init: ProbeInit) =>
      url === OPENCODE_GO_MODELS_URL ? jsonResponse(403, { error: "not subscribed" }) : jsonResponse(200, ["gpt-6-luna"]),
    );
    const result = await probeOpenCodePlans("sk-test-key", { fetchImpl });
    expect(result.go).toEqual({ status: "inactive", models: [], httpStatus: 403 });
    expect(result.zen.status).toBe("active");
  });

  it("reports unknown for server errors, empty lists, bad JSON and network failures without leaking the key", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, { error: "boom" }))
      .mockRejectedValueOnce(new Error("The operation was aborted due to timeout"));
    const first = await probeOpenCodePlans("sk-secret-value", { fetchImpl });
    expect(first.zen).toEqual({ status: "unknown", models: [], httpStatus: 500, message: "HTTP 500" });
    expect(first.go.status).toBe("unknown");
    expect(first.go.message).toContain("timeout");
    expect(JSON.stringify(first)).not.toContain("sk-secret-value");

    const empty = vi.fn(async () => jsonResponse(200, { data: [] }));
    const second = await probeOpenCodePlans("sk-secret-value", { fetchImpl: empty });
    expect(second.zen).toEqual({ status: "unknown", models: [], httpStatus: 200, message: "No models in response" });

    const badJson = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad"); } }));
    const third = await probeOpenCodePlans("sk-secret-value", { fetchImpl: badJson });
    expect(third.go).toEqual({ status: "unknown", models: [], httpStatus: 200, message: "Unparseable response" });
  });
});
