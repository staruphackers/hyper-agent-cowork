CREATE TABLE "agent_runtime_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"tier" text DEFAULT 'primary' NOT NULL,
	"adapter_type" text NOT NULL,
	"adapter_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"runtime_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"default_environment_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"last_activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "agent_task_sessions_company_agent_adapter_task_uniq";--> statement-breakpoint
ALTER TABLE "agent_task_sessions" ADD COLUMN "runtime_profile_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "active_runtime_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runtime_profiles" ADD CONSTRAINT "agent_runtime_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_profiles" ADD CONSTRAINT "agent_runtime_profiles_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runtime_profiles" ADD CONSTRAINT "agent_runtime_profiles_default_environment_id_environments_id_fk" FOREIGN KEY ("default_environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runtime_profiles_agent_name_uniq" ON "agent_runtime_profiles" USING btree ("agent_id","name");--> statement-breakpoint
CREATE INDEX "agent_runtime_profiles_company_agent_sort_idx" ON "agent_runtime_profiles" USING btree ("company_id","agent_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_task_sessions_company_agent_adapter_profile_task_uniq" ON "agent_task_sessions" USING btree ("company_id","agent_id","adapter_type","runtime_profile_key","task_key");