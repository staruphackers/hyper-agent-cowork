import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { environments } from "./environments.js";

/**
 * A named, durable snapshot of an agent's execution settings (harness, model,
 * AI connection binding, default environment). The agent row remains the
 * source of truth for the active runtime; the profile pointed to by
 * `agents.active_runtime_profile_id` mirrors it, and other profiles wait to be
 * re-applied through the ordinary agent update path.
 */
export const agentRuntimeProfiles = pgTable(
  "agent_runtime_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tier: text("tier").notNull().default("primary"),
    adapterType: text("adapter_type").notNull(),
    adapterConfig: jsonb("adapter_config").$type<Record<string, unknown>>().notNull().default({}),
    runtimeConfig: jsonb("runtime_config").$type<Record<string, unknown>>().notNull().default({}),
    defaultEnvironmentId: uuid("default_environment_id").references(() => environments.id, { onDelete: "set null" }),
    enabled: boolean("enabled").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    lastActivatedAt: timestamp("last_activated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentNameUniqueIdx: uniqueIndex("agent_runtime_profiles_agent_name_uniq").on(table.agentId, table.name),
    companyAgentSortIdx: index("agent_runtime_profiles_company_agent_sort_idx").on(
      table.companyId,
      table.agentId,
      table.sortOrder,
    ),
  }),
);
