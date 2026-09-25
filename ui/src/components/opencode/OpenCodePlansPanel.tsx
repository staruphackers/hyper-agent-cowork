import type { ReactNode } from "react";
import type { OpenCodePlansResult } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { summarizeOpenCodePlan, type OpenCodePlanSummary } from "@/lib/opencode-plans";
import { cn } from "@/lib/utils";

function PlanStatus({ summary }: { summary: OpenCodePlanSummary }) {
  const tone =
    summary.status === "active" && !summary.freeOnly
      ? "text-foreground"
      : summary.status === "unknown"
        ? "text-muted-foreground"
        : "text-destructive";
  return (
    <div className="flex flex-wrap items-baseline gap-2 text-sm">
      <span className="font-medium">
        {summary.plan === "go" ? "OpenCode Go · subscription" : "OpenCode Zen · pay-as-you-go"}
      </span>
      <span className={cn(tone)}>
        {summary.status === "active" && summary.freeOnly ? (
          <>Free models only. Add credits or subscribe to unlock the rest.</>
        ) : summary.status === "active" ? (
          <>Enabled</>
        ) : summary.status === "inactive" ? (
          <>Not enabled for this key</>
        ) : (
          <>Could not verify</>
        )}
      </span>
      {summary.status === "active" && (
        <span className="text-xs text-muted-foreground">
          {summary.paidModels} paid · {summary.freeModels} free
        </span>
      )}
      {summary.status === "unknown" && summary.message && (
        <span className="text-xs text-muted-foreground">{summary.message}</span>
      )}
    </div>
  );
}

export function OpenCodePlansPanel({
  result,
  error,
  detecting,
  canDetect,
  onDetect,
  hiddenCount,
  showUncovered,
  onToggleUncovered,
  detectHint,
}: {
  result: OpenCodePlansResult | null;
  error: string | null;
  detecting: boolean;
  canDetect: boolean;
  onDetect: () => void;
  hiddenCount: number;
  showUncovered: boolean;
  onToggleUncovered: (next: boolean) => void;
  detectHint?: ReactNode;
}) {
  const bothInactive = result && result.zen.status === "inactive" && result.go.status === "inactive";
  return (
    <section className="space-y-3" aria-label="OpenCode plans">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" disabled={!canDetect || detecting} onClick={onDetect}>
          {detecting ? "Checking plans…" : result ? "Check plans again" : "Check plans"}
        </Button>
        {!result && !error && (
          <span className="text-xs text-muted-foreground">
            {detectHint ?? "Asks OpenCode which plans this key can use, then labels and filters the model list."}
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {result && (
        <div className="space-y-2 rounded-md border border-border p-3">
          <PlanStatus summary={summarizeOpenCodePlan(result, "go")} />
          <PlanStatus summary={summarizeOpenCodePlan(result, "zen")} />
          {bothInactive && (
            <p className="text-sm text-destructive">
              OpenCode rejected this key for both plans. Check that the key is correct.
            </p>
          )}
          {(hiddenCount > 0 || showUncovered) && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                aria-label="Show models this key cannot use"
                checked={showUncovered}
                onChange={(event) => onToggleUncovered(event.target.checked)}
              />
              <span>
                Show models this key cannot use ({hiddenCount} hidden)
              </span>
            </label>
          )}
        </div>
      )}
    </section>
  );
}
