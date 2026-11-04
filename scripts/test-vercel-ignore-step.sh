#!/usr/bin/env bash
# Regression test for scripts/vercel-ignore-step.sh on photo-pods (LAC-6903 1a).
#
# This project is PARKED: every build is skipped, production included. That is a
# deliberate scoped exception, so the test asserts the exception rather than the
# fleet rule. If someone revives photo-pods they should see this test go red,
# which is the point: it is the tripwire that says "finish step 1 of revival".
#
# Convention: exit 0 = SKIP, exit 1 = BUILD. Here everything is 0.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SUT="${1:-$HERE/vercel-ignore-step.sh}"
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

pass=0; fail=0
check() {
  desc="$1"; want="$2"; venv="$3"; ref="$4"; msg="$5"
  ( cd "$SANDBOX" && env -i PATH="$PATH" HOME="$SANDBOX" \
      VERCEL_ENV="$venv" VERCEL_GIT_COMMIT_REF="$ref" VERCEL_GIT_COMMIT_MESSAGE="$msg" \
      bash "$SUT" ) >/dev/null 2>&1
  got=$?
  if [ "$got" -eq "$want" ]; then pass=$((pass+1)); printf '  ok    %s (rc=%s)\n' "$desc" "$got"
  else fail=$((fail+1)); printf '  FAIL  %s (want rc=%s, got rc=%s)\n' "$desc" "$want" "$got"; fi
}

echo "testing: $SUT  (parked project: everything skips)"
check "production skips (parked, scoped exception)" 0 production main "chore: routine"
check "production skips even with the marker"       0 production main "feat: x [preview]"
check "plain preview skips"                         0 preview LAC-1/feature "feat: x"
check "preview with the marker still skips"         0 preview LAC-1/feature "feat: x [preview]"
check "dependabot preview skips"                    0 preview dependabot/npm_and_yarn/qs-6.17.1 "chore(deps)"
check "empty env and message skip"                  0 "" "" ""
echo "  -- $pass passed, $fail failed"
[ "$fail" -eq 0 ] || exit 1
