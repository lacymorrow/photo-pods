# Photopods QA test infra (LAC-3138)

Bootstraps the Playwright pass that backs the LAC-2860 MVP QA plan
(functional §2, performance §1.1, ACL §1.2 S1-S3).

## What ships in this bundle

| Piece                                     | Path                                    | Purpose                                                                                                          |
| ----------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Seed script for QA users + fixture pods   | `scripts/seed-qa-fixtures.ts`           | Creates credential users A + B and three fixture pods (private-A, public-A, private-B). Idempotent.              |
| Playwright fixture                        | `tests/e2e/qa-fixtures.ts`              | SSO bypass, credentials sign-in, 4G throttle, manifest reader.                                                   |
| Media generator                           | `scripts/gen-e2e-media.ts`              | Builds real JPEGs and MP4s at the size boundaries the plan calls out. Large files are NOT committed.             |
| Committed EXIF fixture                    | `tests/e2e/fixtures/gps-tagged.jpg`     | Real JPEG with GPS EXIF for verifying the LAC-2917 strip step (S4).                                              |
| Representative smoke spec (DoD for -3138) | `tests/e2e/qa-smoke.spec.ts`            | Signs in as A, creates a public pod, uploads a photo, deletes the pod.                                           |

## Required env

Set these once (locally or in the Playwright CI job) — the fixture and the
seed script both read them:

```env
# Target DB for the seed script (prod or persistent staging).
DATABASE_URL=postgres://...
PAYLOAD_SECRET=...

# Passwords the fixture will use to sign in — refuse to seed without them.
E2E_USER_A_PASSWORD=<strong random>
E2E_USER_B_PASSWORD=<strong random>

# Optional overrides (defaults shown).
E2E_USER_A_EMAIL=qa-user-a@photo-pods.test
E2E_USER_B_EMAIL=qa-user-b@photo-pods.test

# Vercel SSO bypass token — required to hit preview URLs (LAC-2916).
VERCEL_AUTOMATION_BYPASS_SECRET=<from Vercel project settings>

# Base URL the Playwright suite targets. Defaults to http://localhost:3000.
E2E_BASE_URL=https://photo-pods.vercel.app
```

## First-time bootstrap

```bash
# 1. Seed users + fixture pods once against the target DB. Idempotent, so
#    re-running is safe — existing rows are reused.
bun run scripts/seed-qa-fixtures.ts

# 2. Generate the media fixtures (writes into tests/e2e/fixtures/).
bun run scripts/gen-e2e-media.ts

# 3. Sanity-run the DoD smoke against the target base URL.
E2E_BASE_URL=https://photo-pods.vercel.app bunx playwright test tests/e2e/qa-smoke.spec.ts
```

Only `gps-tagged.jpg` and the batch generator inputs are committed; the
50/51 MB photos and 500/501 MB videos are generated on demand and
gitignored.

## Fixture pods the manifest produces

- `privateOwnedByA` — A owner, B member. Baseline for "member can view"
  ACL checks.
- `publicOwnedByA` — A owner. Public visibility feed / follow tests.
- `privateOwnedByB` — B owner, A **not** a member. Negative ACL check:
  A must not see it (S1) even if the URL is guessed (S2 direct-fetch).

## Notes for reviewers

- The Vercel bypass header is only applied when
  `VERCEL_AUTOMATION_BYPASS_SECRET` is set — running against localhost
  or a public URL is a no-op.
- The 4G throttle is a Chromium-only CDP call; other browsers no-op.
- `signInAs` uses the credentials form deliberately; OAuth would require
  a real Google/GitHub account and is out of scope for this bundle.
- The seed script talks to Payload CMS (source of truth for credentials)
  and Drizzle (pod tables). It refuses to run without a strong password
  supplied via env — no hard-coded default passwords land in the repo.
