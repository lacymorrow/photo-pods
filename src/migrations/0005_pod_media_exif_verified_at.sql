-- LAC-2932: exif_stripped_at meant two things at once (the strip ran / the
-- bytes were proven clean). Split the verification event into its own column
-- so audits and the LAC-2855 §3 R2 finalize worker can tell them apart.
ALTER TABLE "db_pod_photo" ADD COLUMN "exif_verified_at" timestamp with time zone;--> statement-breakpoint
-- Backfill: before this split, every row that got exif_stripped_at went
-- through a code path that stripped and checked inline, so the strip time is
-- the best available verification time. Rows with no strip stay null.
UPDATE "db_pod_photo" SET "exif_verified_at" = "exif_stripped_at" WHERE "exif_stripped_at" IS NOT NULL;
