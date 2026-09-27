CREATE TABLE IF NOT EXISTS "components" (
  "canvas_id" text NOT NULL,
  "name" text NOT NULL,
  "html" text NOT NULL,
  "css" text NOT NULL,
  "props" jsonb NOT NULL,
  "description" text,
  "version" integer NOT NULL,
  "updated_at" bigint NOT NULL,
  "updated_by" text NOT NULL,
  "deleted_at" bigint,
  CONSTRAINT "components_canvas_id_name_pk" PRIMARY KEY("canvas_id","name")
);
