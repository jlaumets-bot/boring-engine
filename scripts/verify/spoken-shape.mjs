#!/usr/bin/env node
// Spoken-script shape verification.
//
// WHY THIS GATE EXISTS: the rule describing how a spoken script should FLOW lived only inside
// writingCraft's opts.spoken branch. generate-ideas.js — which writes every Quick Post, Ideas,
// Idea Catcher, Notebook-develop, PAA and auto-refill script, i.e. every script a user actually
// films — does NOT call writingCraft. So that rule never reached the scripts people read to camera.
// Measured on the real assembled prompt at the time: 0 flow rules present, 4 compression rules
// present. The model resolved that by stripping sentences to noun phrases ("Sales follow-ups eating
// hours. Tools that don't talk.") — unreadable into a lens.
//
// The failure was SILENT and invisible from the code: both files looked fine on their own. Only
// assembling the real prompt shows the rule missing. So this gate assembles it.
//
// It asserts BEHAVIOUR (the rule reaches the model) and CONTENT (the rule still carries its
// load-bearing mechanics), never exact wording — an assertion coupled to copy punishes improving
// the copy (the v619 lesson).
//
//   node scripts/verify/spoken-shape.mjs

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const API = join(ROOT, 'api');
const require = createRequire(import.meta.url);

const fails = [];
const ok = [];
const check = (cond, label, detail) => (cond ? ok : fails).push(detail ? `${label} — ${detail}` : label);

// ── stub plumbing (same shape as brand-prompt.mjs) ───────────────────────────
function stub(relPath, exports) {
  const resolved = require.resolve(join(API, relPath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
}

let captured = [];
stub('_llm.js', {
  callLLM: async (opts) => { captured.push(opts); return JSON.stringify([]); },
  callGrokSearch: async () => null,
});
stub('_usage.js', {
  guard: async () => ({ user: { id: 'u1' }, over: false, gate: {} }),
  checkLimit: async () => ({ ok: true }),
  creditsFor: () => 1, costFor: () => 0, logUsage: async () => {},
});
stub('_requireUser.js', async () => ({ id: 'u1' }));
stub('_publish/store.js', {
  getUser: async () => ({ id: 'u1' }),
  userCanAccessBrand: async () => true,
  rest: async () => ({ data: [] }),
});
process.env.CRON_SECRET = 'verify-secret';

function mkRes() {
  const res = {
    _status: 0, _json: null,
    setHeader() { return res; },
    status(c) { res._status = c; return res; },
    json(o) { res._json = o; return res; },
    end() { return res; },
  };
  return res;
}

async function promptFor(handlerFile, body) {
  captured = [];
  const handler = require(join(API, handlerFile));
  const res = mkRes();
  await handler({ method: 'POST', headers: { origin: 'https://contentshrimp.com' }, body }, res);
  return captured.map(c => (c.messages || []).map(m => m.content).join('\n')).join('\n');
}

const BC = {
  brandName: 'Boring Electrolytes',
  tagline: 'Three ingredients. No marketing.',
  usps: 'Sodium 1000mg per stick.',
  targetAudience: 'Endurance runners aged 25 to 45.',
  tones: ['deadpan', 'blunt'],
  communities: ['marathon training'],
  painPoints: 'Cramping at mile eighteen.',
  brandVocab: 'dose, stick, label',
  coachNotes: 'Name the dose in the first two lines.',
  approvedExamples: [], recentTrends: [], engine: 'grok',
};

// ── 1. the rule reaches the surfaces that write spoken scripts ───────────────
// A file-level grep would pass on an unwired import. Only the assembled prompt proves delivery.
const { spokenShape } = require(join(API, '_brain.js'));
const SHAPE = spokenShape();
const anchor = 'SPOKEN-SCRIPT SHAPE';

check(typeof spokenShape === 'function' && SHAPE.length > 400,
  'spokenShape() is exported and substantive',
  `${SHAPE.length} chars`);

const genPrompt = await promptFor('generate-ideas.js', {
  brandContext: BC, count: 5, gaps: [{ day: 'Monday', format: 'video' }],
});
check(genPrompt.includes(anchor),
  'generate-ideas prompt carries the spoken rule',
  'THE regression this gate exists for: this surface does not call writingCraft, so the rule must be appended directly');

// viral-rewrite gets it via writingCraft({spoken:true}) — proves the delegation path also works,
// so the two callers can never drift to different rules.
const vrPrompt = await promptFor('viral-rewrite.js', {
  brandContext: BC,
  idea: { title: 'The label test', format: 'video', hook: 'Check the sodium number', script: 'A short original script about electrolytes.' },
  angle: { angle: 'the label test', hook: 'Check the sodium number on the back' },
});
check(vrPrompt.includes(anchor),
  'viral-rewrite prompt carries the same spoken rule (via writingCraft)');

// ── 2. the rule still carries its load-bearing mechanics ────────────────────
// Concept-level, not phrasing-level: reword freely, but do not gut it back to a metaphor.
// Each mechanic is one thing a model can check its own draft against.
const mechanics = [
  ['complete sentences', /complete sentence|subject and a verb/i],
  ['connective tissue',  /connect(ive|or)|joining words|because/i],
  ['listener cannot re-read', /cannot re-?read|listener/i],
  ['varied sentence length', /vary|varied/i],
  // Grammatical sentences can still drone if they all share one shape. The second draft came back
  // with 3 of 5 sentences opening "You ..." and every one subject-verb-object — correct grammar,
  // metronome rhythm. Length variation alone does not catch that.
  ['varied sentence CONSTRUCTION', /construction|same way|same-shape/i],
  ['a countable word floor', /count the words|under the minimum|floor/i],
  ['overrides the compression rules', /overrid|never be applied|must not be applied/i],
];
for (const [label, re] of mechanics) {
  check(re.test(SHAPE), `spoken rule keeps its mechanic: ${label}`);
}

// ── 2b. the audience-world counterweight reaches the FIRST DRAFT ────────────
// generate-ideas' own self-check says "lean on the brand's REAL specifics — pain points, USPs,
// facts", which pushes TOWARD describing the product; writingCraft carries the counterweight
// ("about the READER's situation rather than a product pitch") and generate-ideas never called it.
// Result was a five-sentence walkthrough of how the product works. Same shape as the spoken bug:
// a rule with no counterweight. Measured: of 7 apparent writingCraft/generate-ideas gaps, 6 were
// false positives (its own wording) and THIS was the only genuine one.
check(/audience'?s world|listener'?s experience|reader'?s situation/i.test(genPrompt),
  'first-draft prompt carries the audience-world counterweight',
  'without it the generator writes a feature tour, however well-formed the sentences');
check(/feature tour|walkthrough of how/i.test(genPrompt),
  'first-draft prompt names the feature-tour failure mode explicitly');

// ── 2c. the worked example is a FLOOR, and cannot become a template ─────────
// An example teaches shape far better than a rule — which is also why it is dangerous. A single
// fixed example shown to every brand is the same mistake as the hardcoded "Alex Hormozi style"
// removed in v640. Three guarantees keep it safe, and all three are asserted here.
const { spokenExample } = require(join(API, '_brain.js'));
const LONG = 'x'.repeat(200);

check(spokenExample({ approvedExamples: [] }).length > 400,
  'worked example SHOWS for a brand with no approved posts',
  'exactly when approvedWinnersBlock returns 0 chars and the prompt has no demonstration at all');
check(spokenExample({ approvedExamples: [{ format: 'statement', text: LONG }] }).length > 400,
  'worked example SHOWS when the only winners are non-spoken formats',
  'a statement winner teaches voice but not script shape');
check(spokenExample({ approvedExamples: [{ format: 'video', text: LONG }] }) === '',
  'worked example HIDES once the brand has a spoken winner of its own',
  'THE anti-convergence guarantee: the brand\'s own post replaces it and it never renders again');

// Rotation: one fixed arc would teach every new brand the same structure. Read the first quoted
// line, which is the part that differs between variants (the surrounding headings are shared —
// slicing those instead reports 1 variant and is a broken measurement, not a broken rotation).
const seen = new Set();
for (let i = 0; i < 300; i++) {
  const m = spokenExample({ approvedExamples: [] }).match(/say\):\n"([^"]{0,40})/);
  if (m) seen.add(m[1]);
}
check(seen.size >= 3, 'worked example rotates between distinct arcs', `${seen.size} distinct variants seen`);
check(/WHAT NOT TO COPY/i.test(spokenExample({})) && /not a template/i.test(spokenExample({})),
  'worked example names what must NOT be copied (structure, topic, voice)');

// The subject rule must not harden into one opening formula — that is how every brand starts
// sounding the same even when each individual script is well written.
check(/RULE ABOUT SUBJECT, NOT ABOUT SHAPE/i.test(genPrompt),
  'audience-world rule is scoped to SUBJECT, not to how a script opens');
check(/blunt claim|ways in/i.test(genPrompt),
  'prompt offers a MENU of openings rather than one prescribed move');

// ── 3. no surviving contradiction in the video format spec ──────────────────
// "short sentences" in the format spec sat right next to the task and pulled the opposite way from
// the flow rule. Statements are legitimately short, so only the VIDEO line is checked.
const genSrc = readFileSync(join(API, 'generate-ideas.js'), 'utf8');
const videoLine = (genSrc.match(/^- video:.*$/m) || [''])[0];
check(videoLine.length > 0, 'video format spec line found');
check(!/short sentences/i.test(videoLine),
  'video format spec no longer says "short sentences"',
  'it contradicted the flow rule from the position closest to the task');
check(/floor|90-150/i.test(videoLine),
  'video format spec still states its word range');

// ── report ───────────────────────────────────────────────────────────────────
for (const o of ok) console.log('  ok   ' + o);
for (const f of fails) console.log('  FAIL ' + f);
console.log(`\nspoken-shape: ${ok.length} passed, ${fails.length} failed`);
if (fails.length) process.exitCode = 1;
