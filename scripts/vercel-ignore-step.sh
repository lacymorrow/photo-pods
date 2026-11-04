#!/usr/bin/env bash
# Vercel "Ignored Build Step". Exit 0 = skip the build, exit 1 = build.
#
# THIS PROJECT IS PARKED. EVERY BUILD IS SKIPPED, PRODUCTION INCLUDED.
#
# photo-pods was parked 2026-10-26 (LAC-5545): the production Supabase was let
# go, and knowledge/properties.md already records photo-pods.vercel.app
# erroring as an accepted outcome rather than an incident. Freezing a
# production build that is already accepted-broken costs nothing, and this
# project was the largest single consumer of Vercel build minutes among the
# projects carrying this override, at 72 min/wk across all targets.
#
# CEO ruling, LAC-6903 decision 1(a), 2026-11-04. This is a deliberate, scoped
# exception to the fleet rule that production must keep building. It applies to
# photo-pods ONLY and must not be copied to any other project.
#
# ---------------------------------------------------------------------------
# REVIVING THIS PROJECT? Removing this skip is STEP 1 of revival.
# Delete "ignoreCommand" from vercel.json, or restore the opt-in preview policy
# that the other projects use (see any sibling repo's copy of this file).
# Until you do, nothing you merge to main will ever deploy.
# ---------------------------------------------------------------------------
#
# A redeploy from the Vercel dashboard bypasses this step entirely, so a
# one-off build is still available without touching this file.
set -eu

echo "photo-pods is parked (LAC-5545 / LAC-6903 decision 1a): skipping every build"
exit 0
