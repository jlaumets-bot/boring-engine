# Gates: voice sample — the founder's own speech becomes the brain's primary voice reference

OWNS: app.html, api/_brain.js, api/_brandctx.js, scripts/verify/voice-sample.mjs, scripts/verify/one-brand-renderer.mjs, scripts/verify/lean-payload.mjs, scripts/verify/lean-payload-all.mjs, CLAUDE.md, sw.js, api/_build.js

Scope: a new brain field `voiceSample` (an unedited transcript of the founder talking) is collected as a skippable onboarding step with a mic, editable in Settings with a mic, asked for by the shrimp, round-trips through settings/voice_extra/getBrandContext/server hydration, and is rendered LAST in the brand block of every generator, labelled as the voice and capped — so the strongest position in the prompt holds human speech instead of the app's own prior output.

- [x] G1: every shipped JS still parses after the change
  CHECK: node scripts/verify/parse-all.mjs
  EXPECT: parse verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/sessions/charming-brave-galileo/mnt/boring-content-engine-deploy; path=ce908b8efad4/6 entries; EXPECT=matched; output-sha256=051190752e1903da4fa5eba99f78417d05769f045d468399e7caf6252cddd846; output-bytes=64

- [x] G2: the field exists end to end and is rendered last, capped, and routed to a mic rather than the chat — measured by executing the real functions, not by grepping for names
  CHECK: node scripts/verify/voice-sample.mjs
  EXPECT: voice-sample verification passed
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/sessions/charming-brave-galileo/mnt/boring-content-engine-deploy; path=ce908b8efad4/6 entries; EXPECT=matched; output-sha256=e074ee72a6870ed85cab2f7bc2b1f484ccbd1910a99416530b2879d8d64e1410; output-bytes=67

- [x] G3: the ONE shared renderer still carries every brand field including the new one (sentinel fixture), and no second renderer has appeared
  CHECK: node scripts/verify/one-brand-renderer.mjs
  EXPECT: /PASS: one-brand-renderer .* carries 28\/28 brand fields/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/sessions/charming-brave-galileo/mnt/boring-content-engine-deploy; path=ce908b8efad4/6 entries; EXPECT=matched; output-sha256=ad504abf029fa7fa053dc425a553ded0cb2f9c7647837099c424112ec6042e47; output-bytes=109

- [x] G4: the lean path's server-side hydration produces the SAME context as the client for the new field — a field added on one side only goes red here
  CHECK: node scripts/verify/lean-payload.mjs
  EXPECT: /PASS: lean-payload — .*every brand field still reaches the prompt/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/sessions/charming-brave-galileo/mnt/boring-content-engine-deploy; path=ce908b8efad4/6 entries; EXPECT=matched; output-sha256=a067fed4f740b7e3b810bf70f14ba443536752139d3b7689b5ad29a266fc0ce1; output-bytes=192

- [x] G5: every lean call site still delivers the full brain (incl. the new field) to its endpoint's prompt
  CHECK: node scripts/verify/lean-payload-all.mjs
  EXPECT: /PASS: lean-payload-all —/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/sessions/charming-brave-galileo/mnt/boring-content-engine-deploy; path=ce908b8efad4/6 entries; EXPECT=matched; output-sha256=ed56d077d79ff09f7800d4fb709eb918969e52cab42ef032cc01ed7dd00d2943; output-bytes=608

- [x] G6: the assembled generate-ideas prompt keeps its ordering guarantees (brand block last, winners within reach of the output instruction) with the sample appended
  CHECK: node scripts/verify/brand-prompt.mjs
  EXPECT: /verification passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/sessions/charming-brave-galileo/mnt/boring-content-engine-deploy; path=ce908b8efad4/6 entries; EXPECT=matched; output-sha256=0eb898444f8685b23deb668cb7dc03953b4082e14aa6125b1cc4cdc14f4a3098; output-bytes=874

- [x] G7: the spoken-script rules still reach every script generator (the new block must not displace them)
  CHECK: node scripts/verify/spoken-shape.mjs
  EXPECT: /spoken-shape: \d+ passed, 0 failed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/sessions/charming-brave-galileo/mnt/boring-content-engine-deploy; path=ce908b8efad4/6 entries; EXPECT=matched; output-sha256=030672c3c2948fa001f91a43eaf7cb0ad68e90a77ba27f0fd40474f69773d8aa; output-bytes=2001

- [x] G8: the QA harness still parses and no test asserts the old 3-step wizard or a fixed brain-field count
  CHECK: node scripts/verify/harness-coverage.mjs
  EXPECT: PASS — harness coverage verified
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/sessions/charming-brave-galileo/mnt/boring-content-engine-deploy; path=ce908b8efad4/6 entries; EXPECT=matched; output-sha256=8be5bb27abf7eb12eda71215e818b4d3e810396d632b1b5664486de88be41959; output-bytes=15822

- [x] G9: Jörgen records a voice memo (onboarding on a throwaway brand, or Settings → "How you actually talk" on a real one), then generates a Quick Post, and the script's rhythm is recognisably closer to how he talks than the previous build's output
  EVIDENCE: MANUAL — Jörgen 2026-09-13: "notes worked, voice seemed to work". Met on his own
  judgement, and recorded with the hedge intact: "seemed" is weaker than the gate's "recognisably
  closer", so treat this as provisionally met. If later output drifts generic, re-open G9 rather
  than assuming the voice sample is reaching the prompt — scripts/verify/voice-sample.mjs proves
  the round-trip and rendering, NOT that the result sounds like him.
