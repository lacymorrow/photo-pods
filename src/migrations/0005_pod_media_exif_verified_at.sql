-- LAC-2932: exif_stripped_at meant two things at once (the strip ran / the
-- bytes were proven clean). Split the verification event into its own column
-- so audits and the LAC-2855 §3 R2 finalize worker can tell them apart.
ALTER TABLE "db_pod_photo" ADD COLUMN "exif_verified_at" timestamp with time zone;
-- No backfill on purpose. Historical rows only prove a strip returned ok;
-- there was no verify pass before this migration, which is strictly weaker
-- than what this column now asserts ("re-scanned and proven metadata-free").
-- Copying exif_stripped_at across would put a claim on rows nothing checked
-- (LAC-4972 F4). Nothing reads the column yet, so null costs nothing, and
-- the LAC-2855 §3 R2 worker stamps rows when it actually re-verifies them.
