# Gates: put the brand block in the recency zone for remix — and prove the others were already there

Scope: CLAUDE.md recorded that `remix.js`, `meme.js` and `viral-rewrite.js` all "still put the brand
block near the FRONT" and deferred the fix as one risky three-generator round. Measured first, against
the post-v640 `generate-ideas.js` as the reference bar, and TWO OF THE THREE CLAIMS ARE WRONG:

    generator            brand heading   winners   winners -> output instruction
    generate-ideas  REF        66.2%      88.8%              2932
    viral-twist                45.4%      80.5%              1674
    viral-rewrite              51.2%      81.7%              1892
    meme                       40.9%      81.1%              1472
    sharpen                    43.0%      78.4%               n/a
    remix                       0.3%      32.1%              9771

`fullBrandBlock` renders the APPROVED WINNERS last inside the block, so meme / viral-rewrite /
viral-twist / sharpen already land their strongest brand signal at 78-82% of the prompt with a
TIGHTER tail than the reference. They do not need re-ordering and are deliberately not touched —
churning four working generators for a 1.5k -> 1.1k tail change is risk without payoff.

`remix.js` is the real one and is worse than the table shows: the 9771-char gap is measured with a
28-char source description, and production sends up to 12,000 chars of transcript in that same gap.

Also fixed here, found while reading: remix appends `imgNote` (and the retry note) AFTER
`rulePrecedence()`, so on the reference-screenshot path the precedence block is NOT last. The
existing gate never caught it because its remix fixture sends no screenshot.

OWNS: api/remix.js, scripts/verify/brand-prompt.mjs, .unlazy/brand-recency/GATES.md, CLAUDE.md,
api/_build.js, sw.js

- [x] G1: the brand block in remix reaches the model in the recency zone rather than at the top — the approved winners now sit AFTER the general writing rules and AFTER the source content being remixed, and within the same distance of the output instruction as every other generator, so a 12,000-char transcript can no longer sit between the brand and the task
  CHECK: node scripts/verify/brand-prompt.mjs
  EXPECT: brand prompt verification passed
  EVIDENCE: exit=0; EXPECT=matched; remix brand heading 0.3% -> 51.8%, winners 32.1% -> 82.7%, chars read after the winners 9771 -> 2816 — now inside the 78-89% band every other generator already occupied

- [x] G2: no generator can silently lose brand recency again — the gate now measures, for EVERY generator it drives, that the winners appear in the last 40% of the prompt and within 4000 chars of its end, and prints the measured position so a regression is visible as a number rather than only as a pass
  CHECK: node scripts/verify/brand-prompt.mjs
  EXPECT: RECENCY OK
  EVIDENCE: exit=0; EXPECT=matched; 7 prompts measured (viral-twist 80.5%, viral-rewrite 81.7%, meme 81.1%, sharpen 78.3%, remix 82.7%, generate-ideas 88.8%, remix+screenshot 81.2%). Mutation-proven 4 ways, 4 caught: M1 brand block back at the front of remix -> both recency assertions red on both remix cases (31.2%, 11207 chars); M3 4000 chars padded AFTER the brand -> the TAIL cap alone goes red while the percentage stays green, proving the two halves are independent; M4 brand block removed from viral-rewrite, an UNTOUCHED file -> "approved winners reach the model at all" goes red naming it, proving this is a scan across every generator rather than a remix checklist. api/remix.js and api/viral-rewrite.js both sha256-identical after restore.

- [x] G3: the precedence block is genuinely last on EVERY remix path, including the reference-screenshot path the old fixture never exercised
  CHECK: node scripts/verify/brand-prompt.mjs
  EXPECT: brand prompt verification passed
  EVIDENCE: exit=0; EXPECT=matched; new fixture drives remix with a refImage, asserts imgNote really was appended and that the prompt still ENDS with the precedence text. Mutation M2 (append precedence to the prompt body again, so imgNote lands after it) -> red naming "rule precedence is STILL last when a screenshot is attached", while RECENCY stayed OK — the two checks do not mask each other. api/remix.js sha256-identical after restore.

- [x] G4: remix still works — it returns 200, parses the model's JSON, every brand field still reaches the model, and the humanizer boilerplate still appears once
  CHECK: node scripts/verify/brand-prompt.mjs
  EXPECT: brand prompt verification passed
  EVIDENCE: exit=0; EXPECT=matched; remix reached its LLM call, ZKEY_WINNER_ONE and ZKEY_SIGNALS both present, "delve" appears once, em-dash rule appears once, brand share 21.9% -> 21.3% (the framing line added length; no field was lost)

- [x] G5: every JS the app ships still parses
  CHECK: node scripts/verify/parse-all.mjs
  EXPECT: parse verification passed
  EVIDENCE: exit=0; EXPECT=matched; parsed 51 files/blocks with no errors

- [x] G6: nothing else in the gate suite regressed — the shared brand renderer still reaches every generator, the spoken-shape rule still reaches the script generators, the prompt contract holds, spend is still capped, and no internal file became publishable
  CHECK: node scripts/verify/prompt-contract.mjs && node scripts/verify/spoken-shape.mjs && node scripts/verify/one-brand-renderer.mjs && node scripts/verify/spend-cap.mjs && node scripts/verify/public-exposure.mjs && node scripts/verify/lean-hydration.mjs
  EXPECT: prompt contract verification passed
  EVIDENCE: exit=0; EXPECT=matched; prompt-contract 55/0, spoken-shape 22/0, one-brand-renderer 28/28 fields, spend-cap green, public-exposure green, lean-hydration all 8 endpoints hydrate and can refuse

- [x] G7: the server build stamp moved for this backend-only change, and the phone stamp did not (no needless ~196KB download to every device)
  CHECK: node scripts/verify/build-stamp.mjs
  EXPECT: build stamp verification passed
  EVIDENCE: exit=0; EXPECT=matched; phone stamp unchanged at v654-b337b221, server stamp api.3ea7e294 -> api.26e75c52 across 45 api files — exactly the split the stamp exists to produce
