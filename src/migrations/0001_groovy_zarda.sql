CREATE TYPE "public"."pod_media_status" AS ENUM('processing', 'ready', 'hidden', 'removed');--> statement-breakpoint
CREATE TYPE "public"."pod_media_type" AS ENUM('photo', 'video');--> statement-breakpoint
CREATE TYPE "public"."pod_report_reason" AS ENUM('nudity_sexual', 'violence', 'harassment', 'spam', 'illegal', 'other');--> statement-breakpoint
CREATE TYPE "public"."pod_report_status" AS ENUM('pending', 'confirmed', 'dismissed');--> statement-breakpoint
CREATE TABLE "db_pod_media_reaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"media_id" uuid NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"reaction" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "db_pod_media_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"media_id" uuid NOT NULL,
	"reporter_id" varchar(255) NOT NULL,
	"reason" "pod_report_reason" NOT NULL,
	"details" text,
	"status" "pod_report_status" DEFAULT 'pending' NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "db_pod_follow" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pod_id" uuid NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "db_pod_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pod_id" uuid NOT NULL,
	"reporter_id" varchar(255) NOT NULL,
	"reason" "pod_report_reason" NOT NULL,
	"details" text,
	"status" "pod_report_status" DEFAULT 'pending' NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "db_pod_invite" ALTER COLUMN "role" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "db_pod_invite" ALTER COLUMN "role" SET DEFAULT 'member'::text;--> statement-breakpoint
ALTER TABLE "db_pod_member" ALTER COLUMN "role" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "db_pod_member" ALTER COLUMN "role" SET DEFAULT 'member'::text;--> statement-breakpoint
-- LAC-2857 data migration: collapse contributor/viewer to member.
UPDATE "db_pod_invite" SET "role" = 'member' WHERE "role" IN ('contributor', 'viewer');--> statement-breakpoint
UPDATE "db_pod_member" SET "role" = 'member' WHERE "role" = 'contributor';--> statement-breakpoint
-- Non-owner viewers become members. Owners keep 'owner'.
UPDATE "db_pod_member" SET "role" = 'member' WHERE "role" = 'viewer';--> statement-breakpoint
DROP TYPE "public"."pod_member_role";--> statement-breakpoint
CREATE TYPE "public"."pod_member_role" AS ENUM('owner', 'member');--> statement-breakpoint
ALTER TABLE "db_pod_invite" ALTER COLUMN "role" SET DEFAULT 'member'::"public"."pod_member_role";--> statement-breakpoint
ALTER TABLE "db_pod_invite" ALTER COLUMN "role" SET DATA TYPE "public"."pod_member_role" USING "role"::"public"."pod_member_role";--> statement-breakpoint
ALTER TABLE "db_pod_member" ALTER COLUMN "role" SET DEFAULT 'member'::"public"."pod_member_role";--> statement-breakpoint
ALTER TABLE "db_pod_member" ALTER COLUMN "role" SET DATA TYPE "public"."pod_member_role" USING "role"::"public"."pod_member_role";--> statement-breakpoint
ALTER TABLE "db_pod" ALTER COLUMN "visibility" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "db_pod" ALTER COLUMN "visibility" SET DEFAULT 'group'::text;--> statement-breakpoint
-- LAC-2857 data migration: invite-only maps to group.
UPDATE "db_pod" SET "visibility" = 'group' WHERE "visibility" = 'invite-only';--> statement-breakpoint
DROP TYPE "public"."pod_visibility";--> statement-breakpoint
CREATE TYPE "public"."pod_visibility" AS ENUM('private', 'group', 'public');--> statement-breakpoint
ALTER TABLE "db_pod" ALTER COLUMN "visibility" SET DEFAULT 'group'::"public"."pod_visibility";--> statement-breakpoint
ALTER TABLE "db_pod" ALTER COLUMN "visibility" SET DATA TYPE "public"."pod_visibility" USING "visibility"::"public"."pod_visibility";--> statement-breakpoint
DROP INDEX "pod_photo_pod_idx";--> statement-breakpoint
DROP INDEX "pod_photo_uploaded_by_idx";--> statement-breakpoint
ALTER TABLE "db_pod_photo" ALTER COLUMN "url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "db_pod_photo" ALTER COLUMN "size" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "db_pod_invite" ADD COLUMN "short_code" varchar(8);--> statement-breakpoint
ALTER TABLE "db_pod_invite" ADD COLUMN "max_uses" integer;--> statement-breakpoint
ALTER TABLE "db_pod_invite" ADD COLUMN "use_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "db_pod_invite" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "db_pod_photo" ADD COLUMN "type" "pod_media_type" DEFAULT 'photo' NOT NULL;--> statement-breakpoint
ALTER TABLE "db_pod_photo" ADD COLUMN "status" "pod_media_status" DEFAULT 'processing' NOT NULL;--> statement-breakpoint
ALTER TABLE "db_pod_photo" ADD COLUMN "storage_key" text;--> statement-breakpoint
ALTER TABLE "db_pod_photo" ADD COLUMN "variants" json;--> statement-breakpoint
ALTER TABLE "db_pod_photo" ADD COLUMN "stream_id" varchar(128);--> statement-breakpoint
ALTER TABLE "db_pod_photo" ADD COLUMN "playback_id" varchar(128);--> statement-breakpoint
ALTER TABLE "db_pod_photo" ADD COLUMN "duration_seconds" integer;--> statement-breakpoint
ALTER TABLE "db_pod_photo" ADD COLUMN "exif_stripped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "db_pod_photo" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "db_pod_photo" ADD COLUMN "report_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "db_pod_photo" ADD COLUMN "ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "db_pod" ADD COLUMN "media_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "db_pod" ADD COLUMN "member_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "db_pod" ADD COLUMN "follower_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- LAC-2857 backfill: rows added before this migration keep their DEFAULT
-- (0 / 1 / 0), which would make existing pods report the wrong counts.
-- Backfill from the source-of-truth tables so cached counters match reality.
UPDATE "db_pod" SET "member_count" = COALESCE((
	SELECT COUNT(*) FROM "db_pod_member" WHERE "db_pod_member"."pod_id" = "db_pod"."id"
), 0);--> statement-breakpoint
UPDATE "db_pod" SET "media_count" = COALESCE((
	SELECT COUNT(*) FROM "db_pod_photo"
	WHERE "db_pod_photo"."pod_id" = "db_pod"."id"
		AND "db_pod_photo"."status" = 'ready'
		AND "db_pod_photo"."hidden_at" IS NULL
), 0);--> statement-breakpoint
ALTER TABLE "db_pod" ADD COLUMN "retain_location_exif_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "db_pod" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "db_pod_media_reaction" ADD CONSTRAINT "db_pod_media_reaction_media_id_db_pod_photo_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."db_pod_photo"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_pod_media_reaction" ADD CONSTRAINT "db_pod_media_reaction_user_id_db_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."db_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_pod_media_report" ADD CONSTRAINT "db_pod_media_report_media_id_db_pod_photo_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."db_pod_photo"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_pod_media_report" ADD CONSTRAINT "db_pod_media_report_reporter_id_db_user_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."db_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_pod_media_report" ADD CONSTRAINT "db_pod_media_report_reviewed_by_id_db_user_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."db_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_pod_follow" ADD CONSTRAINT "db_pod_follow_pod_id_db_pod_id_fk" FOREIGN KEY ("pod_id") REFERENCES "public"."db_pod"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_pod_follow" ADD CONSTRAINT "db_pod_follow_user_id_db_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."db_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_pod_report" ADD CONSTRAINT "db_pod_report_pod_id_db_pod_id_fk" FOREIGN KEY ("pod_id") REFERENCES "public"."db_pod"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_pod_report" ADD CONSTRAINT "db_pod_report_reporter_id_db_user_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."db_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "db_pod_report" ADD CONSTRAINT "db_pod_report_reviewed_by_id_db_user_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."db_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pod_media_reaction_unique_idx" ON "db_pod_media_reaction" USING btree ("media_id","user_id");--> statement-breakpoint
CREATE INDEX "pod_media_reaction_media_idx" ON "db_pod_media_reaction" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "pod_media_report_media_idx" ON "db_pod_media_report" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "pod_media_report_status_idx" ON "db_pod_media_report" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "pod_follow_unique_idx" ON "db_pod_follow" USING btree ("pod_id","user_id");--> statement-breakpoint
CREATE INDEX "pod_follow_user_idx" ON "db_pod_follow" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pod_report_pod_idx" ON "db_pod_report" USING btree ("pod_id");--> statement-breakpoint
CREATE INDEX "pod_report_status_idx" ON "db_pod_report" USING btree ("status");--> statement-breakpoint
CREATE INDEX "pod_invite_short_code_idx" ON "db_pod_invite" USING btree ("short_code");--> statement-breakpoint
CREATE UNIQUE INDEX "pod_member_unique_idx" ON "db_pod_member" USING btree ("pod_id","user_id");--> statement-breakpoint
CREATE INDEX "pod_media_pod_idx" ON "db_pod_photo" USING btree ("pod_id");--> statement-breakpoint
CREATE INDEX "pod_media_uploaded_by_idx" ON "db_pod_photo" USING btree ("uploaded_by_id");--> statement-breakpoint
CREATE INDEX "pod_media_pod_created_idx" ON "db_pod_photo" USING btree ("pod_id","created_at");--> statement-breakpoint
CREATE INDEX "pod_media_status_idx" ON "db_pod_photo" USING btree ("status");--> statement-breakpoint
CREATE INDEX "pod_public_recent_idx" ON "db_pod" USING btree ("visibility","created_at");