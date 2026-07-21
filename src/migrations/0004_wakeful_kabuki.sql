ALTER TABLE "db_pod_photo" ADD COLUMN "exif_verified_at" timestamp with time zone;--> statement-breakpoint
-- LAC-2932: split verified-vs-stripped. Backfill existing rows so audits can
-- distinguish "server ran the strip" (exif_stripped_at) from "server verified
-- no GPS remained" (exif_verified_at). Before this migration the single
-- exif_stripped_at column meant both.
UPDATE "db_pod_photo" SET "exif_verified_at" = "exif_stripped_at" WHERE "exif_stripped_at" IS NOT NULL;
