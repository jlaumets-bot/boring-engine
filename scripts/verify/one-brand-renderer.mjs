#!/usr/bin/env node
// G34 — ONE brand renderer.
//
// Twice now a surface has quietly built its own brand section instead of using the shared one,
// and each time it dropped fields nobody noticed were gone:
//   v612  generate-ideas had its own buildMasterPrompt — lost approvedExamples, learnedSignals,
//         competitors, channels, visualStyle. Measured: "APPROVED WINNERS" -> 0 occurrences.
//   v625  the coach hand-rolled an 18-line snapshot — saw 20 of 28 brand fields. The founder's
//         reviews, web mentions, category gripes, learned signals, channels, competitor moves and
//         approved winners never reached it. No error, no warning: just blander answers.
//
// A second renderer never announces itself. It just falls behind the first one, one field at a
// time, and the only symptom is output that feels generic — the exact complaint this project has
// been chasing for months. So this gate does two things:
//   1. measures REAL field reach through fullBrandBlock with a sentinel fixture (so a field
//      silently dropped from the shared renderer itself turns this red), and
//   2. fails if any endpoint hand-rolls a multi-field brand section without calling the shared one.
//
// Read-only. Run: node scripts/verify/one-brand-renderer.mjs

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const require_ = createRequire(import.meta.url);
const fails = [];
const check = (label, ok, detail) => { if (!ok) fails.push(label + (detail ? ' — ' + detail : '')); };

// ── 1. behavioural: does the shared renderer actually carry the whole brain? ──
const { fullBrandBlock } = require_(path.join(root, 'api/_brain.js'));

// One unique sentinel per brand field. If a field stops being rendered, its sentinel vanishes.
const SENTINEL = {
  brandName: 'ZQ1', website: 'ZQ2', tagline: 'ZQ3', usps: 'ZQ4', targetAudience: 'ZQ5',
  painPoints: 'ZQ6', brandVocab: 'ZQ7', avoidWords: 'ZQ8', productDetails: 'ZQ9',
  ctaStyle: 'ZQ10', originStory: 'ZQ11', socialProof: 'ZQ12', visualStyle: 'ZQ13',
  exampleContent: 'ZQ14', bannedTopics: 'ZQ15', competitors: 'ZQ16', coachNotes: 'ZQ17',
  /* masterPromptContent RETIRED v636 — the Master Prompt doc no longer reaches the model */ reviewInsights: 'ZQ19', webMentions: 'ZQ20',
  categoryGripes: 'ZQ21', learnedSignals: 'ZQ22', competitorMoves: 'ZQ27',
  voiceSample: 'ZQ30', // v649 — the founder's spoken transcript, rendered LAST
};
const bc = Object.assign({}, SENTINEL, {
  tones: ['ZQ23'], communities: ['ZQ24'], channels: ['ZQ25'], recentTrends: ['ZQ26'],
  approvedExamples: [{ text: 'ZQ29', format: 'video', title: 'w' }],
});
const ALL = [...Object.values(SENTINEL), 'ZQ23', 'ZQ24', 'ZQ25', 'ZQ26', 'ZQ29'];
const NAME_OF = Object.fromEntries([
  ...Object.entries(SENTINEL).map(([k, v]) => [v, k]),
  ['ZQ23', 'tones'], ['ZQ24', 'communities'], ['ZQ25', 'channels'],
  ['ZQ26', 'recentTrends'], ['ZQ29', 'approvedExamples'],
]);

const rendered = fullBrandBlock(bc);
const missing = ALL.filter(s => !new RegExp(s + '\\b').test(rendered));
check(
  `the shared brand renderer dropped ${missing.length} field(s) — every generator lost them at once`,
  missing.length === 0,
  missing.map(s => NAME_OF[s]).join(', ')
);

// ── 2. structural: no endpoint may grow a second brand renderer ──
// A hand-rolled brand section looks like a run of `bc.<field>` reads building a prompt. One or two
// is a targeted read; six or more IS a brand section, and it must come from the shared renderer.
const HAND_ROLLED_AT = 6;
const apiDir = path.join(root, 'api');
const files = fs.readdirSync(apiDir).filter(f => f.endsWith('.js'));

// people-also-ask is deliberately brand-free: it finds what the public searches for, and seeding
// it with the brand's own words would just echo the brand back at itself. Not a writing surface.
const NOT_A_WRITER = new Set(['people-also-ask.js', '_brain.js', '_brandctx.js']);

for (const f of files) {
  if (NOT_A_WRITER.has(f)) continue;
  const src = fs.readFileSync(path.join(apiDir, f), 'utf8');
  const distinctFields = new Set([...src.matchAll(/\bbc\.([a-zA-Z][a-zA-Z0-9_]*)/g)].map(m => m[1]));
  if (distinctFields.size < HAND_ROLLED_AT) continue;
  check(
    `api/${f} reads ${distinctFields.size} brand fields by hand but never calls fullBrandBlock — ` +
    `that is a second renderer, and it will fall behind the shared one`,
    /fullBrandBlock/.test(src)
  );
}

// ── 3. the coach specifically: uses the shared renderer, and is still a coach ──
const chat = fs.readFileSync(path.join(apiDir, 'brand-voice-chat.js'), 'utf8');
check('brand-voice-chat does not import the shared renderer', /require\(['"]\.\/_brain['"]\)/.test(chat));
// Assert where the brand section COMES FROM, not merely that a variable by that name exists.
// The first version of this gate only checked for the name `brandBlock` and for the word
// fullBrandBlock appearing somewhere in the file — so a mutant that kept the import, kept the
// variable, and rebuilt it by hand out of two fields sailed straight through. A check that can
// be satisfied by a name rather than by behaviour is not a check.
check(
  'brand-voice-chat builds its brand section by hand instead of from the shared renderer',
  /brandBlock\s*=\s*fullBrandBlock\s*\(/.test(chat)
);
check('brand-voice-chat imports the renderer but never puts it in the prompt', /\$\{brandBlock/.test(chat));
check('brand-voice-chat still hand-rolls a brandSnapshot array', !/brandSnapshot/.test(chat));

// Fixing field reach must not have gutted the coach itself.
for (const [what, re] of [
  ['its persona (COACH_NAME)', /COACH_NAME/],
  ['its cross-session memory (<coach_memory>)', /coach_memory/],
  ['its action buttons (<assistant_action>)', /assistant_action/],
  ['its live web-search branch', /callGrokSearch/],
  ['its settings-edit ability', /Valid fields:/],
]) {
  check(`brand-voice-chat lost ${what} — the brain fix broke the coach`, re.test(chat));
}

if (fails.length) {
  console.log('FAIL: one-brand-renderer');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log(`PASS: one-brand-renderer — shared renderer carries ${ALL.length}/${ALL.length} brand fields; no endpoint hand-rolls a second one`);
