#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# check-bleed.sh — guards against "vertical bleed": Boring Electrolytes' own
# niche (or any single industry) getting hardcoded into the SHARED, multi-brand
# surfaces (generation prompts in api/*.js, and the in-app UI/prompts in app.html).
#
# Content Shrimp serves every brand. No shared prompt, placeholder, default, or
# example should assume the user sells electrolytes/supplements/fitness. When it
# does, a sourcing company (or a law firm, or a bakery) gets electrolyte content.
#
# This is a REGRESSION GATE, not a bug finder: run it before every deploy.
#   HARD terms  -> exit 1 (must never appear in shared prompts; fix before deploy)
#   SOFT terms  -> printed for a human to eyeball (often legit, e.g. "ingredients"
#                  inside a "never invent prices/ingredients" anti-fabrication rule)
#
# NOTE: index.html / faq.html (Content Shrimp's OWN marketing) are intentionally
# NOT hard-checked — the landing page may use a vivid example brand to sell.
# Usage:  bash scripts/check-bleed.sh
# ---------------------------------------------------------------------------
set -uo pipefail
cd "$(dirname "$0")/.."

# Surfaces that must stay vertical-neutral (shared across all brands).
FILES=$(ls api/*.js app.html 2>/dev/null | grep -v -E 'api/meme\.js|api/_publish/')

# HARD: words that have no legitimate reason to sit in a neutral, multi-brand prompt.
HARD='electrolyt|hydrat|sodium|potassium|magnesium|\bLMNT\b|1000mg|zero sugar|\bketo\b|\bmacros\b|gatorade|liquid iv|boring electrolytes|health-conscious'
# SOFT: often legitimate (anti-fabrication lists, generic words) — review, don't fail.
SOFT='ingredient|flavou?r|\bpouch\b|\bsupplement|serving|\bgym\b|workout|fitness|nutrition|wellness|fasting'

hard_hits=$(grep -rniE "$HARD" $FILES 2>/dev/null || true)
soft_hits=$(grep -rniE "$SOFT" $FILES 2>/dev/null | grep -viE 'never invent|do NOT invent|used to be|check-bleed' || true)

echo "== vertical-bleed check =="
if [ -n "$soft_hits" ]; then
  echo "--- SOFT (review; usually fine) ---"
  echo "$soft_hits"
  echo
fi

if [ -n "$hard_hits" ]; then
  echo "!!! HARD FAIL — vertical-specific terms in shared prompts/UI:"
  echo "$hard_hits"
  echo
  echo "Fix these (make them brand-neutral or brand-derived) before deploying."
  exit 1
fi

echo "OK — no hard vertical-bleed terms in shared prompts/UI."
