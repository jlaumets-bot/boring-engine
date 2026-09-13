#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# check-brain.sh — guards two things the /api/health endpoint can't see from
# the outside, so they're checked statically against the repo:
#
#   1) FUNCTION INTEGRITY — every api/*.js (and api/**/ helper) parses cleanly
#      (node -c) AND has a module.exports. A serverless function that doesn't
#      parse or doesn't export is a dead route.
#
#   2) BRAIN COVERAGE — every TEXT-generation surface routes through the shared
#      brand-brain (require('./_brain')) and emits the COMPLETE brand profile via
#      fullBrandBlock(). This is what "use all the brain everywhere" means: what
#      the user teaches in Settings must reach every generator, so no surface
#      silently drops taught signals by hand-rolling its own brand context.
#
# REGRESSION GATE, not a bug finder. Run before every deploy.
#   any failure -> exit 1 (fix before deploy)
# Usage:  bash scripts/check-brain.sh
# ---------------------------------------------------------------------------
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0

echo "== brain + function-integrity check =="

# ── 1) Function integrity: parse + export ───────────────────────────────────
# Every JS under api/ must PARSE. Only top-level api/*.js are deployed routes, so
# only those must export a handler (api/_publish/ holds local dev tools too).
syntax_bad=""
export_bad=""
while IFS= read -r f; do
  node -c "$f" 2>/dev/null || syntax_bad="$syntax_bad $f"
done < <(find api -name '*.js' | sort)
while IFS= read -r f; do
  grep -q "module.exports" "$f" || export_bad="$export_bad $f"
done < <(find api -maxdepth 1 -name '*.js' | sort)

if [ -n "$syntax_bad" ]; then
  echo "!!! SYNTAX FAIL:$syntax_bad"
  fail=1
fi
if [ -n "$export_bad" ]; then
  echo "!!! MISSING module.exports:$export_bad"
  fail=1
fi

# ── 2) Brain coverage: text-gen surfaces must use the shared brain ──────────
# Surfaces that generate brand copy for the user. Each MUST require _brain and
# render the full profile via fullBrandBlock(). Add new text generators here.
TEXT_GEN="expand-field generate-blog generate-ideas meme remix settings-examples viral-analyze viral-rewrite viral-twist"

brain_bad=""
block_bad=""
for name in $TEXT_GEN; do
  f="api/$name.js"
  if [ ! -f "$f" ]; then
    echo "!!! MISSING expected generator: $f"
    fail=1
    continue
  fi
  grep -q "require('./_brain')" "$f" || brain_bad="$brain_bad $name"
  grep -q "fullBrandBlock" "$f"       || block_bad="$block_bad $name"
done

if [ -n "$brain_bad" ]; then
  echo "!!! NOT wired to shared brain (require('./_brain')):$brain_bad"
  fail=1
fi
if [ -n "$block_bad" ]; then
  echo "!!! NOT emitting full brand profile (fullBrandBlock):$block_bad"
  fail=1
fi

# ── 3) Client → endpoint wiring: every /api/X the app calls must exist ───────
# app.html fetches routes by literal path. If a route file is renamed/removed but
# a caller isn't updated, the app 404s at runtime (broken "open app" / onboarding).
# This catches that at build time. (Dynamic/templated paths are ignored — we only
# check literal /api/<name> references.)
# Exclude tokens ending in '-' : those are dynamic/templated (e.g. `/api/viral-${x}`)
# or prefix classifiers (indexOf('/api/viral-')), never a literal endpoint.
missing_routes=""
for route in $(grep -oE "/api/[a-z0-9-]+" app.html | grep -vE -- '-$' | sort -u); do
  name="${route#/api/}"
  [ -f "api/$name.js" ] || missing_routes="$missing_routes $route"
done
if [ -n "$missing_routes" ]; then
  echo "!!! app.html calls routes with no api/*.js file:$missing_routes"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "Fix the above before deploying — a broken, brain-bypassing, or unwired"
  echo "surface either 404s or drops what the user taught."
  exit 1
fi

echo "OK — functions parse/export, every text generator uses the full brain,"
echo "     and every endpoint the app calls exists."
