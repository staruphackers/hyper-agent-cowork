import type { AdapterModel } from "../api/agents";
import type { OpenCodePlanId, OpenCodePlanProbe, OpenCodePlansResult } from "@paperclipai/shared";

// OpenCode bills through two plans behind one key. Zen is pay-as-you-go over
// provider id `opencode`; Go is a monthly subscription over provider id
// `opencode-go`. The gateway's models endpoints list exactly what a key can
// use, so the setup UI probes them and derives coverage from the result.
export const OPENCODE_PLAN_PROVIDERS: Record<OpenCodePlanId, string> = {
  zen: "opencode",
  go: "opencode-go",
};

export function openCodePlanForProvider(provider: string): OpenCodePlanId | null {
  if (provider === "opencode-go") return "go";
  if (provider === "opencode") return "zen";
  return null;
}

export function openCodePlanForModel(modelId: string): OpenCodePlanId | null {
  if (modelId.startsWith("opencode-go/")) return "go";
  if (modelId.startsWith("opencode/")) return "zen";
  return null;
}

export function openCodeBareModelId(modelId: string): string {
  if (modelId.startsWith("opencode-go/")) return modelId.slice("opencode-go/".length);
  if (modelId.startsWith("opencode/")) return modelId.slice("opencode/".length);
  return modelId;
}

/** OpenCode marks its no-cost models with a `-free` suffix; Big Pickle is the
 * one documented free model without it. */
export function isOpenCodeFreeModel(modelId: string): boolean {
  const bare = openCodeBareModelId(modelId).toLowerCase();
  return bare.endsWith("-free") || bare === "big-pickle";
}

export function openCodeModelId(plan: OpenCodePlanId, bareId: string): string {
  return `${OPENCODE_PLAN_PROVIDERS[plan]}/${bareId}`;
}

export type OpenCodePlanSummary = {
  plan: OpenCodePlanId;
  status: OpenCodePlanProbe["status"];
  /** Active, but the key only unlocked free models (no credits or no subscription). */
  freeOnly: boolean;
  paidModels: number;
  freeModels: number;
  message?: string;
};

export function summarizeOpenCodePlan(result: OpenCodePlansResult, plan: OpenCodePlanId): OpenCodePlanSummary {
  const probe = plan === "go" ? result.go : result.zen;
  const freeModels = probe.models.filter((id) => isOpenCodeFreeModel(id)).length;
  const paidModels = probe.models.length - freeModels;
  return {
    plan,
    status: probe.status,
    freeOnly: probe.status === "active" && paidModels === 0,
    paidModels,
    freeModels,
    message: probe.message,
  };
}

/** Adds every model the probe reported so the dropdown is complete even when
 * the container's own `opencode models` run had no key. */
export function mergeOpenCodeModels(models: AdapterModel[], result: OpenCodePlansResult | null): AdapterModel[] {
  if (!result) return models;
  const merged = [...models];
  const seen = new Set(models.map((model) => model.id));
  for (const plan of ["go", "zen"] as const) {
    const probe = plan === "go" ? result.go : result.zen;
    if (probe.status !== "active") continue;
    for (const bare of probe.models) {
      const id = openCodeModelId(plan, bare);
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push({ id, label: id });
    }
  }
  return merged;
}

export type OpenCodeModelCoverage = "covered" | "uncovered" | "unknown";

/** Whether the probed key can run a model. Non-OpenCode ids and unverifiable
 * plans stay "unknown" so nothing is hidden on a guess. */
export function openCodeModelCoverage(modelId: string, result: OpenCodePlansResult | null): OpenCodeModelCoverage {
  const plan = openCodePlanForModel(modelId);
  if (!plan || !result) return "unknown";
  const probe = plan === "go" ? result.go : result.zen;
  if (probe.status === "unknown") return "unknown";
  if (probe.status === "inactive") return "uncovered";
  return probe.models.includes(openCodeBareModelId(modelId)) ? "covered" : "uncovered";
}

export function filterOpenCodeModels(
  models: AdapterModel[],
  result: OpenCodePlansResult | null,
  showUncovered: boolean,
): { visible: AdapterModel[]; hiddenCount: number } {
  if (!result || showUncovered) return { visible: models, hiddenCount: 0 };
  const visible = models.filter((model) => openCodeModelCoverage(model.id, result) !== "uncovered");
  return { visible, hiddenCount: models.length - visible.length };
}
