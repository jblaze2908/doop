DROP TABLE IF EXISTS "automation_runs" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "automations" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "github_connections" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "integrations" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "local_agent_preferences" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "memory_proposals" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "model_accounts" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "resident_usage" CASCADE;
--> statement-breakpoint
ALTER TABLE "canvases" DROP COLUMN IF EXISTS "published_at";
--> statement-breakpoint
ALTER TABLE "canvases" DROP COLUMN IF EXISTS "description";
--> statement-breakpoint
ALTER TABLE "canvases" DROP COLUMN IF EXISTS "category";
--> statement-breakpoint
ALTER TABLE "canvases" DROP COLUMN IF EXISTS "copy_count";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "status";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "plan";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "interval";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "seats";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "stripe_customer_id";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "stripe_subscription_id";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "current_period_end";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "cancel_at_period_end";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "billing_event_at";
--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "pipeline";
--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "stage";
--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "attachments";
--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "queued_by_user_id";
--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "kind";
--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "payload";
--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN IF EXISTS "scope";
--> statement-breakpoint
ALTER TABLE "feedback" DROP COLUMN IF EXISTS "target_agent";
--> statement-breakpoint
ALTER TABLE "feedback" DROP COLUMN IF EXISTS "from_user_id";
--> statement-breakpoint
ALTER TABLE "comments" DROP COLUMN IF EXISTS "from_user_id";
