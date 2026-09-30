import { unprocessable } from "../errors.js";
import { restoreRedactedApprovalSnapshot } from "../redaction.js";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const APPROVAL_SNAPSHOT_RECORD_FIELDS = ["adapterConfig", "runtimeConfig", "metadata"] as const;

/**
 * The hire route stores a redacted copy of the pending agent's frozen config
 * as the approval snapshot. Put the frozen values back before the snapshot is
 * reapplied, and refuse (422) when a masked value has nothing to map back to,
 * so "***REDACTED***" never becomes a stored credential.
 */
export function resolveHireApprovalSnapshot(
  payload: Record<string, unknown>,
  frozen: Partial<Record<(typeof APPROVAL_SNAPSHOT_RECORD_FIELDS)[number], unknown>>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...payload };
  const unresolved: string[] = [];
  for (const field of APPROVAL_SNAPSHOT_RECORD_FIELDS) {
    const snapshot = payload[field];
    if (!isPlainRecord(snapshot)) continue;
    const frozenRecord = isPlainRecord(frozen[field]) ? frozen[field] : {};
    const { config, unresolvedPaths } = restoreRedactedApprovalSnapshot(snapshot, frozenRecord);
    resolved[field] = config;
    unresolved.push(...unresolvedPaths.map((path) => `${field}.${path}`));
  }
  if (unresolved.length > 0) {
    throw unprocessable(
      "This hire approval still contains masked (***REDACTED***) values that cannot be restored. Ask the requester to resubmit with the real values.",
      { code: "hire_approval_redacted_values", fields: unresolved },
    );
  }
  return resolved;
}
