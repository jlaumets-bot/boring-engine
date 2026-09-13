# Gates: landing page rewrite — never wonder what to post

OWNS: index.html, scripts/verify/landing.mjs, app.html, sw.js, api/_build.js, CLAUDE.md

Scope: index.html is rewritten around the locked positioning (don't know what to post → volume → on-brand → several formats → an ever-evolving brain that hears you). Skeleton, pain strip, brain animation, pricing cards, FAQ shell and JSON-LD stay. The phone/"THE LOOP" iframe section and the hidden hero demo card are removed. New "What comes out" (6 formats) and "Where the ideas come from" sections; learn section 3→4 with "It hears you" first; feature grid 22→8; ChatGPT table 7→4 rows; FAQ refreshed. index.html is in the SW CORE list so the app build stamp must move.

- [x] G1: the rewritten page is structurally sound and says only true things — tags balance, JSON-LD parses with the live prices, every inline script parses, every nav anchor resolves, no shelved feature or removed section is advertised, and the section counts are exactly the agreed ones (6 formats, 8 tools, 4 learn cards, 4 comparison rows)
  CHECK: node scripts/verify/landing.mjs
  EXPECT: landing verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/sessions/charming-brave-galileo/mnt/boring-content-engine-deploy; path=ce908b8efad4/6 entries; EXPECT=matched; output-sha256=a236b4d9a5808abf364e57162281ad9188cdfefb34e24035198dde370f863f84; output-bytes=44

- [x] G2: every JS the app ships still parses
  CHECK: node scripts/verify/parse-all.mjs
  EXPECT: parse verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/sessions/charming-brave-galileo/mnt/boring-content-engine-deploy; path=ce908b8efad4/6 entries; EXPECT=matched; output-sha256=051190752e1903da4fa5eba99f78417d05769f045d468399e7caf6252cddd846; output-bytes=64

- [x] G3: the build stamp moved with the edit (index.html rides the SW CORE cache) and /sw.js keeps its no-store header
  CHECK: node scripts/verify/build-stamp.mjs
  EXPECT: build stamp verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/sessions/charming-brave-galileo/mnt/boring-content-engine-deploy; path=ce908b8efad4/6 entries; EXPECT=matched; output-sha256=e700946d7af23d26d73361ffb48256b72b077d68a1bb85c620fd579898c08bc8; output-bytes=148

- [x] G4: nothing in the public surface regressed — shipped files, headers, long-running function budgets
  CHECK: node scripts/verify/public-exposure.mjs
  EXPECT: /PASS — no internal file is publishable/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/sessions/charming-brave-galileo/mnt/boring-content-engine-deploy; path=ce908b8efad4/6 entries; EXPECT=matched; output-sha256=ab4dc19e7d0ac4f372fd2e04437e3e5c5e58bed93308ef1372b6079c100f3050; output-bytes=106

- [ ] G5: Jörgen opens contentshrimp.com on his phone after deploy and the page reads in the agreed order with no clipped section, and the loop animation is gone
  EVIDENCE: pending
