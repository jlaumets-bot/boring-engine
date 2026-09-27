#!/usr/bin/env node
// GATE rv3-hooks-1 — content-v3 F3: three different opening lines per script, none inventing a fact.
//
// WHY THIS EXISTS
//   The founder films hook 1 + script, then hook 2, then hook 3, and posts the best. Three lines are
//   three new chances to invent a number or a name, so each goes through the same fact guard as every
//   other line (api/_write.js guardHooks -> inventedFacts). If fewer than 2 survive, the script's own
//   first line is the only hook. `hook` stays hooks[0] for older clients. No new AI call: the hooks
//   ride on the existing shape call (v2 writer) and the existing batch call (generate-ideas).
//
// HOW — the REAL api/_write.js, api/_brain.js and api/generate-ideas.js run; callLLM answers from a
//   per-scenario plan (zero network); usage, session, hydration and access are stubbed. Every
//   behaviour is paired with its opposite.
//
// RUN:    node scripts/verify/rv3-hooks-1.mjs
// EXPECT: prints "HOOKS OK" and exits 0.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const Module = require_('module');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = path.join(ROOT, 'api');
const WALL = setTimeout(() => { console.log('FAIL: rv3-hooks-1 wall clock (60s) — something hung'); process.exit(1); }, 60000);

let failed = 0, passed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.log('FAIL: ' + m); } };
function stub(rel, exports) {
  const file = require_.resolve(path.join(API, rel));
  const m = new Module(file); m.filename = file; m.loaded = true; m.exports = exports; require_.cache[file] = m;
}
const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
let calls = [], plan = () => '';
stub('_llm.js', {
  callLLM: async (opts) => { const i = calls.length; calls.push({ opts, prompt: (opts.messages || []).map(m => m.content).join('\n') }); return plan(i, opts); },
  aiUnavailable: () => null, callGrokSearch: async () => null,
});
stub('_usage.js', {
  billingUserFor: async (u) => u, creditsFor: () => 1, checkLimit: async () => ({ ok: true, hold: null }), attachHoldRelease: () => {},
  logUsage: async () => {}, guard: async () => ({ user: { id: 'u1' }, over: false }), denyResponse: (res) => res.status(402).json({}),
});
stub('_brandctx.js', { loadBrandContext: async () => ({ ok: false, reason: 'no_brand_id' }) });
stub('_publish/store.js', { userCanAccessBrand: async () => true });
stub('_requireUser.js', async () => ({ id: 'u1' }));

const W = require_(path.join(API, '_write.js'));
const ideasH = require_(path.join(API, 'generate-ideas.js'));
const I = W._internals;
const words = (s) => String(s).split(/\s+/).filter(Boolean).length;
const distinct = (a) => new Set(a.map(x => x.toLowerCase())).size === a.length;

const BC = { brandName: 'Acme Salt', usps: 'Plain electrolyte powder with 500 mg sodium', tones: ['plain'], stories: [{ id: 's1', text: 'I cramped at a race in Tartu', tags: [] }], engine: 'grok' };
const SRC = { kind: 'note', text: 'People think electrolytes are only for athletes.' };
const ANG = { belief: 'Most people drink electrolytes at the wrong time', why: 'Ads show them after workouts' };
const SCRIPT = 'You drink it after the run. That is the wrong time. Take it before, when your body is about to lose salt.';
const H3 = ['Timing beats the powder.', 'Why do you drink it after the run?', 'I used to drink mine after every run.'];
const shape = (o) => JSON.stringify(Object.assign({ title: 'Before, not after', caption: 'Timing matters.', onScreen: ['Before'], shots: ['Desk'] }, o));
async function write(shapeReply, extra) {
  calls = []; skew = 0; plan = (i) => [SCRIPT, SCRIPT, shapeReply][i];
  return W.runWrite(Object.assign({ bc: BC, source: SRC, angle: ANG, deadlineMs: 200000 }, extra || {}));
}

// ═══ 1. the v2 writer: three hooks from the shape call ═══════════════════════════════════════════
{
  let o = await write(shape({ hooks: H3 }));
  ok(calls.length === 3 && /Do NOT rewrite it/.test(calls[2].prompt), 'no new AI call: draft, spoken, shape (' + calls.length + ' calls)');
  ok(/"hooks":\[/.test(calls[2].prompt) && /exactly 3 DIFFERENT opening lines/.test(calls[2].prompt) && /at most 20 words/.test(calls[2].prompt) && /bold claim, a question or tension, a personal moment/.test(calls[2].prompt), 'the shape prompt asks for 3 different hooks, <= 20 words, in the three styles');
  ok(Array.isArray(o.idea.hooks) && o.idea.hooks.length === 3 && JSON.stringify(o.idea.hooks) === JSON.stringify(H3), '3 clean hooks come back in order (' + JSON.stringify(o.idea.hooks) + ')');
  ok(distinct(o.idea.hooks) && o.idea.hooks.every(h => words(h) <= 20), 'the hooks are distinct and each <= 20 words');
  ok(o.idea.hook === o.idea.hooks[0], 'hook === hooks[0]');

  // an inventing hook is dropped, the others kept
  o = await write(shape({ hooks: [H3[0], 'I made $15,000 last month doing this.', H3[2]] }));
  ok(JSON.stringify(o.idea.hooks) === JSON.stringify([H3[0], H3[2]]) && o.idea.hook === H3[0], 'an inventing hook (money) is dropped, two survive (' + JSON.stringify(o.idea.hooks) + ')');
  o = await write(shape({ hooks: ['My client Sarah Jones swears by this.', H3[1], H3[2]] }));
  ok(JSON.stringify(o.idea.hooks) === JSON.stringify([H3[1], H3[2]]) && o.idea.hook === H3[1], 'an inventing hook (a name) is dropped; hook becomes the first survivor');
  // opposite: a number the brand itself wrote is allowed
  o = await write(shape({ hooks: ['Most powders skip the 500 mg sodium you need.', H3[1], H3[2]] }));
  ok(o.idea.hooks.length === 3 && /500 mg/.test(o.idea.hooks[0]), 'opposite: a number from the brand\'s own fields is allowed in a hook');
  // too long: one long sentence dropped; a long line whose first sentence fits is cut to it
  const LONG = 'You have probably been told for years that electrolytes are only for serious athletes who train for hours every single day in the heat';
  o = await write(shape({ hooks: [LONG, H3[1], H3[2]] }));
  ok(JSON.stringify(o.idea.hooks) === JSON.stringify([H3[1], H3[2]]), 'a hook over 20 words with no short first sentence is dropped');
  o = await write(shape({ hooks: ['Timing beats the powder. ' + LONG, H3[1], H3[2]] }));
  ok(o.idea.hooks[0] === 'Timing beats the powder.' && o.idea.hooks.every(h => words(h) <= 20), 'a long hook is cut to its first sentence when that fits');
  // duplicates, slots, labels
  o = await write(shape({ hooks: [H3[0], 'timing BEATS the powder!', H3[2]] }));
  ok(JSON.stringify(o.idea.hooks) === JSON.stringify([H3[0], H3[2]]), 'a near-duplicate hook counts once');
  o = await write(shape({ hooks: ['[your story: the race]', H3[1], H3[2]] }));
  ok(JSON.stringify(o.idea.hooks) === JSON.stringify([H3[1], H3[2]]), 'a slot is never a hook');
  o = await write(shape({ hooks: ['1) ' + H3[0], 'Question: ' + H3[1], 'Personal moment: ' + H3[2]] }));
  ok(JSON.stringify(o.idea.hooks) === JSON.stringify(H3), 'numbering / style labels the model adds are stripped');

  // fallback: fewer than 2 survive -> the script's first line is the only hook
  const FIRST = 'You drink it after the run.';
  o = await write(shape({ hooks: [H3[0], 'I made $15,000 last month.', 'Dr. Mark Lee says so.'] }));
  ok(JSON.stringify(o.idea.hooks) === JSON.stringify([FIRST]) && o.idea.hook === FIRST, 'only 1 survivor -> fallback to the script\'s first line as the only hook (' + JSON.stringify(o.idea.hooks) + ')');
  o = await write(shape({ hook: 'Timing beats the powder.' }));
  ok(JSON.stringify(o.idea.hooks) === JSON.stringify([FIRST]) && o.idea.hook === FIRST, 'a legacy reply with only `hook` -> fallback, hook === hooks[0]');
  o = await write('not json');
  ok(o.passes.shape === 'unparsed' && JSON.stringify(o.idea.hooks) === JSON.stringify([FIRST]), 'unparseable shape -> the script\'s first line');
  calls = []; skew = 0;
  plan = (i, op) => { if (i === 1) skew += op.deadlineMs; return [SCRIPT, SCRIPT, shape({ hooks: H3 })][i]; };
  o = await W.runWrite({ bc: BC, source: SRC, angle: ANG, deadlineMs: 40000 });   // shape reserve 6 s < MIN_SHAPE_MS
  ok(o.passes.shape === 'skipped_deadline' && calls.length === 2 && JSON.stringify(o.idea.hooks) === JSON.stringify([FIRST]), 'no time for the shape call -> still exactly one hook, the first line');
  skew = 0;
}

// ═══ 2. guardHooks directly ═════════════════════════════════════════════════════════════════════
{
  const g = I.guardHooks(['A.', 'B?', 'C.', 'D.'], 'x', 'first');
  ok(g.hooks.length === 3 && !g.fallback, 'never more than 3 hooks');
  ok(JSON.stringify(I.guardHooks([], 'x', 'first').hooks) === '["first"]' && JSON.stringify(I.guardHooks('nope', 'x', 'first').hooks) === '["first"]', 'no list -> the fallback');
  ok(JSON.stringify(I.guardHooks(['Twelve clients told me this.', 'Also fine.'], 'x', 'f').hooks) === '["f"]', 'a small-count customer claim is invented too');
  ok(I.HOOK_MAX_WORDS === 20, 'HOOK_MAX_WORDS is 20');
}

// ═══ 3. generate-ideas: hooks per idea, same guard, one call ════════════════════════════════════
const fakeRes = () => ({ statusCode: 0, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } });
async function gen(ideas, bc) {
  calls = []; plan = () => JSON.stringify(ideas);
  const res = fakeRes();
  await ideasH({ method: 'POST', headers: { origin: 'https://contentshrimp.com' }, body: { brandContext: Object.assign({}, bc || BC), count: ideas.length, learningContext: '' } }, res);
  return res;
}
const GI = (o) => Object.assign({ belief: 'Most people drink electrolytes at the wrong time', day: 'Monday', community: 'running', format: 'video', tone: 'plain',
  title: 'Before not after', hook: H3[0], hooks: H3, script: SCRIPT, emphasis: [], shots: 'Shot 1: desk', caption: '', reelTitle: 'r', tags: '#AcmeSalt' }, o);
{
  let r = await gen([GI({}), GI({ title: 'Two', hooks: [H3[0], 'I made $15,000 last month.', H3[2]] }), GI({ title: 'Three', hook: 'You drink it wrong.', hooks: ['Sarah Jones told me.', 'Dr. Mark Lee agrees.', H3[2]] })]);
  const P = calls[0] ? calls[0].prompt : '';
  ok(r.statusCode === 200 && calls.length === 1, 'generate-ideas: still one AI call, 200 (' + r.statusCode + ', ' + calls.length + ')');
  ok(/"hooks": \[/.test(P) && /HOOKS: for every idea also give "hooks": exactly 3 DIFFERENT opening lines/.test(P) && /at most 20 words/.test(P), 'generate-ideas: the prompt asks for 3 hooks per idea, <= 20 words');
  const [a, b, c] = r.body.ideas;
  ok(JSON.stringify(a.hooks) === JSON.stringify(H3) && distinct(a.hooks) && a.hooks.every(h => words(h) <= 20), 'generate-ideas: 3 clean hooks come back per idea');
  ok(JSON.stringify(b.hooks) === JSON.stringify([H3[0], H3[2]]), 'generate-ideas: an inventing hook is dropped (' + JSON.stringify(b.hooks) + ')');
  ok(JSON.stringify(c.hooks) === '["You drink it after the run."]', 'generate-ideas: < 2 survivors -> the script\'s first line (' + JSON.stringify(c.hooks) + ')');
  ok(r.body.ideas.every(i => i.hook === i.hooks[0]), 'generate-ideas: hook === hooks[0] on every idea');
  // statement: the first line of boldText; carousel numbering stripped
  r = await gen([GI({ format: 'statement', hooks: ['Only one.'], script: 'Deadpan to camera.', boldText: 'Salt before sweat. Not after.' }),
                 GI({ format: 'carousel', hooks: [], script: 'Design: big type.', boldText: '1: Timing is the whole trick.\n2: Before, not after.' })]);
  ok(JSON.stringify(r.body.ideas[0].hooks) === '["Salt before sweat."]' && JSON.stringify(r.body.ideas[1].hooks) === '["Timing is the whole trick."]', 'generate-ideas: statement/carousel fall back to the first line of boldText (' + JSON.stringify(r.body.ideas.map(i => i.hooks)) + ')');
  // opposite: a number in the idea's own script or the brand's fields is fine in a hook
  r = await gen([GI({ hooks: ['Most powders skip the 500 mg sodium.', H3[1], H3[2]] })]);
  ok(r.body.ideas[0].hooks.length === 3, 'generate-ideas: a number from the brand\'s own fields is allowed');
  // results / approved posts are NOT allowed material for the hook guard
  r = await gen([GI({ hooks: [H3[0], 'I sold 4,000 bottles in May.', H3[2]] })], Object.assign({}, BC, { results: [{ title: 't', hook: 'I sold 4,000 bottles in May.', hookAlts: [], hookUsed: null, result: 'great' }],
    approvedExamples: [{ title: 'old', text: 'I sold 4,000 bottles in May.', edited: false }] }));
  ok(JSON.stringify(r.body.ideas[0].hooks) === JSON.stringify([H3[0], H3[2]]), 'generate-ideas: a number found only in results / unedited approved posts is still invented');
  // a model that returns no hooks and no body: its own hook only if it invents nothing
  r = await gen([GI({ hooks: undefined, script: '', hook: 'I made $15,000 last month.', caption: 'c' })]);
  ok(r.statusCode === 200 && r.body.ideas[0].hook === '' && r.body.ideas[0].hooks.length === 0, 'generate-ideas: with no body to fall back on, an inventing hook is still refused');
  r = await gen([GI({ hooks: undefined, script: '', hook: 'Timing beats the powder.', caption: 'c' })]);
  ok(JSON.stringify(r.body.ideas[0].hooks) === '["Timing beats the powder."]' && r.body.ideas[0].hook === 'Timing beats the powder.', 'opposite: a clean own hook is kept as the only hook');
}

clearTimeout(WALL);
if (failed) { console.log('rv3-hooks-1: ' + passed + ' passed, ' + failed + ' failed'); process.exit(1); }
console.log('HOOKS OK — ' + passed + ' checks: 3 hooks, distinct, <= 20 words, fact guard, fallback, generate-ideas, hook === hooks[0]');
