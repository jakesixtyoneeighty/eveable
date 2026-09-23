CREATE TABLE "terminal_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"terminal_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"command" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"workflow_id" text,
	"output" text DEFAULT '' NOT NULL,
	"exit_code" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "terminals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"version_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"sandbox_name" text,
	"workflow_id" text,
	"active_command_id" uuid,
	"command_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "terminal_commands" ADD CONSTRAINT "terminal_commands_terminal_id_terminals_id_fk" FOREIGN KEY ("terminal_id") REFERENCES "public"."terminals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminals" ADD CONSTRAINT "terminals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminals" ADD CONSTRAINT "terminals_owner_id_members_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."members"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminals" ADD CONSTRAINT "terminals_version_id_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "terminal_command_request" ON "terminal_commands" USING btree ("terminal_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "terminal_request" ON "terminals" USING btree ("project_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "terminal_owner_time" ON "terminals" USING btree ("owner_id","created_at");