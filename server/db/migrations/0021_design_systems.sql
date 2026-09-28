ALTER TABLE "canvases" ADD COLUMN IF NOT EXISTS "design_system_id" text;
--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN IF NOT EXISTS "design_system_pin" integer;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "design_systems" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "source_canvas_id" text NOT NULL,
  "workspace_id" text,
  "owner_id" text NOT NULL,
  "published_version" integer NOT NULL,
  "published_stamp" text,
  "published_at" bigint,
  "published_by" text,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  CONSTRAINT "design_systems_source_canvas_id_unique" UNIQUE("source_canvas_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "design_system_versions" (
  "system_id" text NOT NULL,
  "version" integer NOT NULL,
  "snapshot" jsonb NOT NULL,
  "note" text,
  "published_at" bigint NOT NULL,
  "published_by" text NOT NULL,
  CONSTRAINT "design_system_versions_system_id_version_pk" PRIMARY KEY("system_id","version")
);
