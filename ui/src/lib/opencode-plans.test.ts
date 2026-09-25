import { describe, expect, it } from "vitest";
import type { OpenCodePlansResult } from "@paperclipai/shared";
import {
  filterOpenCodeModels,
  isOpenCodeFreeModel,
  mergeOpenCodeModels,
  openCodeModelCoverage,
  openCodePlanForModel,
  summarizeOpenCodePlan,
} from "./opencode-plans";

const probe: OpenCodePlansResult = {
  zen: { status: "active", models: ["big-pickle", "ling-3.0-flash-fin-free"], httpStatus: 200 },
  go: { status: "active", models: ["deepseek-v4-flash", "glm-5.2", "space-bunny-free"], httpStatus: 200 },
  checkedAt: "2026-09-25T10:00:00Z",
};

describe("opencode plan helpers", () => {
  it("maps provider prefixes to plans and spots free models", () => {
    expect(openCodePlanForModel("opencode-go/glm-5.2")).toBe("go");
    expect(openCodePlanForModel("opencode/claude-sonnet-5")).toBe("zen");
    expect(openCodePlanForModel("openrouter/deepseek/deepseek-v4")).toBeNull();
    expect(isOpenCodeFreeModel("opencode/big-pickle")).toBe(true);
    expect(isOpenCodeFreeModel("opencode-go/space-bunny-free")).toBe(true);
    expect(isOpenCodeFreeModel("opencode-go/glm-5.2")).toBe(false);
  });

  it("summarises a key that only unlocked Zen's free tier", () => {
    expect(summarizeOpenCodePlan(probe, "zen")).toMatchObject({ status: "active", freeOnly: true, paidModels: 0, freeModels: 2 });
    expect(summarizeOpenCodePlan(probe, "go")).toMatchObject({ status: "active", freeOnly: false, paidModels: 2, freeModels: 1 });
  });

  it("merges probed models into the catalog without duplicates", () => {
    const merged = mergeOpenCodeModels([{ id: "opencode/big-pickle", label: "opencode/big-pickle" }], probe);
    expect(merged.map((m) => m.id)).toEqual([
      "opencode/big-pickle",
      "opencode-go/deepseek-v4-flash",
      "opencode-go/glm-5.2",
      "opencode-go/space-bunny-free",
      "opencode/ling-3.0-flash-fin-free",
    ]);
  });

  it("hides models the key cannot use unless asked to show them", () => {
    const catalog = [
      { id: "opencode/claude-sonnet-5", label: "opencode/claude-sonnet-5" },
      { id: "opencode/big-pickle", label: "opencode/big-pickle" },
      { id: "opencode-go/glm-5.2", label: "opencode-go/glm-5.2" },
      { id: "openrouter/deepseek/deepseek-v4", label: "openrouter/deepseek/deepseek-v4" },
    ];
    expect(openCodeModelCoverage("opencode/claude-sonnet-5", probe)).toBe("uncovered");
    expect(openCodeModelCoverage("opencode/big-pickle", probe)).toBe("covered");
    expect(openCodeModelCoverage("openrouter/deepseek/deepseek-v4", probe)).toBe("unknown");
    const hidden = filterOpenCodeModels(catalog, probe, false);
    expect(hidden.visible.map((m) => m.id)).toEqual(["opencode/big-pickle", "opencode-go/glm-5.2", "openrouter/deepseek/deepseek-v4"]);
    expect(hidden.hiddenCount).toBe(1);
    expect(filterOpenCodeModels(catalog, probe, true).hiddenCount).toBe(0);
    expect(filterOpenCodeModels(catalog, null, false).visible).toHaveLength(4);
  });

  it("treats an inactive plan as uncovered and an unverifiable plan as unknown", () => {
    const partial: OpenCodePlansResult = {
      zen: { status: "inactive", models: [], httpStatus: 401 },
      go: { status: "unknown", models: [], message: "timeout" },
      checkedAt: "2026-09-25T10:00:00Z",
    };
    expect(openCodeModelCoverage("opencode/big-pickle", partial)).toBe("uncovered");
    expect(openCodeModelCoverage("opencode-go/glm-5.2", partial)).toBe("unknown");
  });
});
