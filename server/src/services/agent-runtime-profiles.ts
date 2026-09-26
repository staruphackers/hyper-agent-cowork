import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  agentRuntimeProfiles,
  agentTaskSessions,
  agents,
  heartbeatRuns,
  type Db,
} from "@paperclipai/db";
import {
  ADAPTER_AGNOSTIC_KEYS,
  AGENT_RUNTIME_PROFILE_MAX_PER_AGENT,
  aiConnectionBindingSchema,
  type AgentRuntimeProfilePreflight,
  type AgentRuntimeProfileTier,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";

type AgentRow = typeof agents.$inferSelect;
type ProfileRow = typeof agentRuntimeProfiles.$inferSelect;

/** Sessions of an agent without runtime profiles live under the empty key. */
export function runtimeProfileKeyFor(agent: { activeRuntimeProfileId?: string | null }): string {
  return agent.activeRuntimeProfileId ?? "";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Only the AI connection binding travels with a profile; other runtime keys stay per agent. */
export function profileRuntimeConfigFrom(runtimeConfig: unknown): Record<string, unknown> {
  const binding = aiConnectionBindingSchema.safeParse(
    isPlainRecord(runtimeConfig) ? runtimeConfig.aiConnection : undefined,
  );
  return binding.success ? { aiConnection: binding.data } : {};
}

/**
 * Compose the adapter config a profile activation applies. Adapter-agnostic
 * keys (instructions, cwd, skills, timeouts, prompt templates) belong to the
 * agent and come from its current config; `env` is merged so a profile keeps
 * the provider keys it was saved with while other keys survive; every other
 * key is harness specific and comes from the profile.
 */
export function composeActivationAdapterConfig(
  current: Record<string, unknown>,
  profile: Record<string, unknown>,
): Record<string, unknown> {
  const agnostic = new Set<string>(ADAPTER_AGNOSTIC_KEYS);
  const composed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(profile)) {
    if (!agnostic.has(key)) composed[key] = value;
  }
  for (const key of ADAPTER_AGNOSTIC_KEYS) {
    if (key === "env") continue;
    if (Object.prototype.hasOwnProperty.call(current, key)) composed[key] = current[key];
  }
  const currentEnv = isPlainRecord(current.env) ? current.env : null;
  const profileEnv = isPlainRecord(profile.env) ? profile.env : null;
  if (currentEnv || profileEnv) {
    composed.env = { ...(currentEnv ?? {}), ...(profileEnv ?? {}) };
  }
  return composed;
}

export function agentRuntimeProfileService(db: Db) {
  async function list(agentId: string): Promise<ProfileRow[]> {
    return db
      .select()
      .from(agentRuntimeProfiles)
      .where(eq(agentRuntimeProfiles.agentId, agentId))
      .orderBy(asc(agentRuntimeProfiles.sortOrder), asc(agentRuntimeProfiles.createdAt));
  }

  async function getById(agentId: string, profileId: string): Promise<ProfileRow | null> {
    const [row] = await db
      .select()
      .from(agentRuntimeProfiles)
      .where(and(eq(agentRuntimeProfiles.agentId, agentId), eq(agentRuntimeProfiles.id, profileId)));
    return row ?? null;
  }

  async function assertNameAvailable(agentId: string, name: string, excludeProfileId?: string) {
    const rows = await db
      .select({ id: agentRuntimeProfiles.id })
      .from(agentRuntimeProfiles)
      .where(and(eq(agentRuntimeProfiles.agentId, agentId), sql`lower(${agentRuntimeProfiles.name}) = lower(${name})`));
    if (rows.some((row) => row.id !== excludeProfileId)) {
      throw conflict(`A runtime profile named "${name}" already exists for this agent`, {
        code: "runtime_profile_name_taken",
      });
    }
  }

  /**
   * Snapshot the agent's current runtime into a new profile. When the agent
   * has no active profile yet, the new profile becomes active and the agent's
   * existing task sessions move under it, so nothing that was resumable stops
   * being resumable.
   */
  async function createFromCurrent(
    agent: AgentRow,
    input: { name: string; tier?: AgentRuntimeProfileTier },
  ): Promise<{ profile: ProfileRow; activated: boolean }> {
    const existing = await list(agent.id);
    if (existing.length >= AGENT_RUNTIME_PROFILE_MAX_PER_AGENT) {
      throw unprocessable(
        `An agent can keep at most ${AGENT_RUNTIME_PROFILE_MAX_PER_AGENT} runtime profiles`,
        { code: "runtime_profile_limit" },
      );
    }
    await assertNameAvailable(agent.id, input.name);
    const activate = !agent.activeRuntimeProfileId;
    const now = new Date();
    return db.transaction(async (tx) => {
      const [profile] = await tx
        .insert(agentRuntimeProfiles)
        .values({
          companyId: agent.companyId,
          agentId: agent.id,
          name: input.name,
          tier: input.tier ?? "primary",
          adapterType: agent.adapterType,
          adapterConfig: isPlainRecord(agent.adapterConfig) ? agent.adapterConfig : {},
          runtimeConfig: profileRuntimeConfigFrom(agent.runtimeConfig),
          defaultEnvironmentId: agent.defaultEnvironmentId ?? null,
          sortOrder: existing.length,
          lastActivatedAt: activate ? now : null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (activate) {
        await tx
          .update(agents)
          .set({ activeRuntimeProfileId: profile.id, updatedAt: now })
          .where(eq(agents.id, agent.id));
        await tx
          .update(agentTaskSessions)
          .set({ runtimeProfileKey: profile.id, updatedAt: now })
          .where(
            and(
              eq(agentTaskSessions.companyId, agent.companyId),
              eq(agentTaskSessions.agentId, agent.id),
              eq(agentTaskSessions.runtimeProfileKey, ""),
            ),
          );
      }
      return { profile, activated: activate };
    });
  }

  async function update(
    agentId: string,
    profileId: string,
    patch: { name?: string; tier?: AgentRuntimeProfileTier; enabled?: boolean; sortOrder?: number },
  ): Promise<ProfileRow> {
    const profile = await getById(agentId, profileId);
    if (!profile) throw notFound("Runtime profile not found");
    if (patch.name !== undefined && patch.name !== profile.name) {
      await assertNameAvailable(agentId, patch.name, profileId);
    }
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (patch.enabled === false && agent?.activeRuntimeProfileId === profileId) {
      throw conflict("The active runtime profile cannot be disabled", {
        code: "runtime_profile_active",
      });
    }
    const [updated] = await db
      .update(agentRuntimeProfiles)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.tier !== undefined ? { tier: patch.tier } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
        updatedAt: new Date(),
      })
      .where(eq(agentRuntimeProfiles.id, profileId))
      .returning();
    return updated;
  }

  async function remove(agentId: string, profileId: string): Promise<void> {
    const profile = await getById(agentId, profileId);
    if (!profile) throw notFound("Runtime profile not found");
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (agent?.activeRuntimeProfileId === profileId) {
      throw conflict("Activate another runtime profile before deleting the active one", {
        code: "runtime_profile_active",
      });
    }
    await db.transaction(async (tx) => {
      // Sessions saved under the profile are no longer reachable once it is gone.
      await tx
        .delete(agentTaskSessions)
        .where(and(eq(agentTaskSessions.agentId, agentId), eq(agentTaskSessions.runtimeProfileKey, profileId)));
      await tx.delete(agentRuntimeProfiles).where(eq(agentRuntimeProfiles.id, profileId));
    });
  }

  async function countSessions(agent: AgentRow, runtimeProfileKey: string): Promise<number> {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(agentTaskSessions)
      .where(
        and(
          eq(agentTaskSessions.companyId, agent.companyId),
          eq(agentTaskSessions.agentId, agent.id),
          eq(agentTaskSessions.runtimeProfileKey, runtimeProfileKey),
        ),
      );
    return Number(count ?? 0);
  }

  async function preflight(agent: AgentRow, profileId: string): Promise<AgentRuntimeProfilePreflight> {
    const profile = await getById(agent.id, profileId);
    if (!profile) throw notFound("Runtime profile not found");
    const [{ count: activeRunCount }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agent.id),
          inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
        ),
      );
    const currentConfig = isPlainRecord(agent.adapterConfig) ? agent.adapterConfig : {};
    const profileConfig = isPlainRecord(profile.adapterConfig) ? profile.adapterConfig : {};
    return {
      profileId: profile.id,
      isActive: agent.activeRuntimeProfileId === profile.id,
      activeRunCount: Number(activeRunCount ?? 0),
      targetSessionCount: await countSessions(agent, profile.id),
      currentSessionCount: await countSessions(agent, runtimeProfileKeyFor(agent)),
      harnessChanges: profile.adapterType !== agent.adapterType,
      modelChanges: String(profileConfig.model ?? "") !== String(currentConfig.model ?? ""),
    };
  }

  /** The agent patch that applies a profile; it runs through the ordinary agent update validation. */
  function buildActivationPatch(agent: AgentRow, profile: ProfileRow): Record<string, unknown> {
    const currentConfig = isPlainRecord(agent.adapterConfig) ? agent.adapterConfig : {};
    const profileConfig = isPlainRecord(profile.adapterConfig) ? profile.adapterConfig : {};
    const currentRuntime = isPlainRecord(agent.runtimeConfig) ? agent.runtimeConfig : {};
    const profileRuntime = profileRuntimeConfigFrom(profile.runtimeConfig);
    const { aiConnection: _dropped, ...runtimeWithoutBinding } = currentRuntime;
    return {
      adapterType: profile.adapterType,
      adapterConfig: composeActivationAdapterConfig(currentConfig, profileConfig),
      replaceAdapterConfig: true,
      // `null` tells the update route to clear a binding the profile does not carry.
      runtimeConfig: {
        ...runtimeWithoutBinding,
        aiConnection: profileRuntime.aiConnection ?? null,
      },
      defaultEnvironmentId: profile.defaultEnvironmentId ?? null,
      activeRuntimeProfileId: profile.id,
    };
  }

  return {
    list,
    getById,
    createFromCurrent,
    update,
    remove,
    preflight,
    buildActivationPatch,
  };
}

export type AgentRuntimeProfileService = ReturnType<typeof agentRuntimeProfileService>;
