/**
 * Instance-wide cap on simultaneously running heartbeat runs, across every
 * company and agent. Unset (or invalid) keeps the historical behavior where
 * only the per-agent `maxConcurrentRuns` applies. Small self-hosted machines
 * set it so a burst of wakes cannot spawn more CLI processes than the host
 * can serve; queued runs wait and are promoted by later scheduler ticks.
 */
export const INSTANCE_MAX_CONCURRENT_RUNS_ENV_KEY = "PAPERCLIP_MAX_CONCURRENT_RUNS";

export function readInstanceMaxConcurrentRuns(
  env: Record<string, string | undefined> = process.env,
): number | null {
  const raw = env[INSTANCE_MAX_CONCURRENT_RUNS_ENV_KEY];
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}

/**
 * Slots an agent may still fill under both caps. `instanceRunning` is the
 * number of running runs across the whole instance; `instanceCap` null means
 * no instance-wide cap is configured.
 */
export function availableRunSlots(input: {
  agentCap: number;
  agentRunning: number;
  instanceCap: number | null;
  instanceRunning: number;
}): number {
  const agentSlots = Math.max(0, input.agentCap - input.agentRunning);
  if (input.instanceCap === null) return agentSlots;
  return Math.min(agentSlots, Math.max(0, input.instanceCap - input.instanceRunning));
}
