CREATE TABLE "db_pod_storage_delete_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_key" text NOT NULL,
	"reason" varchar(32) DEFAULT 'delete' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pod_storage_delete_queue_created_idx" ON "db_pod_storage_delete_queue" USING btree ("created_at");