#!/usr/bin/env node
// GATE rv2-gen-1 — the remaining writers on the content-v2 rules, EXECUTED (v693, leaf-G).
//
// Runs the REAL api/generate-ideas.js, viral-rewrite.js, viral-twist.js, viral-analyze.js and
// sharpen.js handlers with the REAL api/_brain.js and api/_write.js. Only the edges are stubbed:
// callLLM (captures every prompt + option, answers from a per-scenario plan, zero network), the
// usage meter (records gate / hold / log calls), the session, the brand hydration and the brand
// access check. aiUnavailable is the REAL one from api/_llm.js.
// Every behaviour is paired with its opposite (3 tones vs 4, a question seed vs none, spoken vs
// written, v2 vs the legacy renderer, an overlong belief vs a fitting one), so a check that cannot
// fail shows up as one.
//
// RUN:    node scripts/verify/rv2-gen-1.mjs
// EXPECT: prints "GEN V2 OK" and exits 0.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const Module = require_('module');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = path.join(ROOT, 'api');
const WALL = setTimeout(() => { console.log('FAIL: rv2-gen-1 wall clock (60s) — something hung'); process.exit(1); }, 60000);

let failed = 0, passed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.log('FAIL: ' + m); } };

// ── the REAL aiUnavailable, read before _llm is stubbed ──
const realLlm = require_(path.join(API, '_llm.js'));
const aiUnavailable = realLlm.aiUnavailable;
delete require_.cache[require_.resolve(path.join(API, '_llm.js'))];

function stub(rel, exports) {
  const file = require_.resolve(path.join(API, rel));
  const m = new Module(file); m.filename = file; m.loaded = true; m.exports = exports; require_.cache[file] = m;
}

let calls = [], plan = () => '';
const aiErr = () => { const e = new Error('refused'); e.code = 'AI_UNAVAILABLE'; e.refused = 403; return e; };
stub('_llm.js', {
  callLLM: async (opts) => {
    const i = calls.length;
    calls.push({ opts, prompt: (opts.messages || []).map(m => m.content).join('\n') });
    return plan(i, opts);
  },
  aiUnavailable,
  callGrokSearch: async () => null,
});
let usageLogs = [], gates = [], holds = [], gateMode = 'ok', userMode = 'ok';
stub('_usage.js', {
  // generate-ideas' own lane
  billingUserFor: async (u) => u,
  creditsFor: () => 1,
  checkLimit: async (u, credits, action) => {
    gates.push({ u, action });
    return gateMode === 'over' ? { ok: false, reason: 'limit_reached' } : { ok: true, hold: { token: 'h1', action } };
  },
  attachHoldRelease: (res, hold) => { holds.push(hold); },
  // the guard()ed endpoints
  guard: async (req, action) => {
    gates.push({ action });
    if (userMode === 'none') return { user: null, over: false };
    if (gateMode === 'over') return { user: { id: 'u1' }, over: true, gate: { reason: 'limit_reached' } };
    return { user: { id: 'u1' }, over: false, billingUserId: 'bill-1' };
  },
  denyResponse: (res) => res.status(402).json({ error: 'limit_reached' }),
  logUsage: async (evt) => { usageLogs.push(evt); },
});
let hydrate = null;
stub('_brandctx.js', { loadBrandContext: async (id) => hydrate(id) });
stub('_publish/store.js', { userCanAccessBrand: async () => true });
stub('_requireUser.js', async () => (userMode === 'none' ? null : { id: 'u1' }));

const brain = require_(path.join(API, '_brain.js'));
const W = require_(path.join(API, '_write.js'));
const H = {
  ideas: require_(path.join(API, 'generate-ideas.js')),
  rewrite: require_(path.join(API, 'viral-rewrite.js')),
  twist: require_(path.join(API, 'viral-twist.js')),
  analyze: require_(path.join(API, 'viral-analyze.js')),
  sharpen: require_(path.join(API, 'sharpen.js')),
};

const reset = () => { calls = []; usageLogs = []; gates = []; holds = []; gateMode = 'ok'; userMode = 'ok'; plan = () => ''; hydrate = null; };
const fakeRes = () => ({ statusCode: 0, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } });
async function run(name, body, planFn) {
  reset(); if (planFn) plan = planFn;
  const res = fakeRes();
  await H[name]({ method: 'POST', headers: { origin: 'https://contentshrimp.com' }, body }, res);
  return res;
}
// Some scenarios need a mode set AFTER reset(): run with a setup callback.
async function runWith(name, body, planFn, setup) {
  reset(); if (planFn) plan = planFn; if (setup) setup();
  const res = fakeRes();
  await H[name]({ method: 'POST', headers: { origin: 'https://contentshrimp.com' }, body }, res);
  return res;
}

// ── the rules, derived from the functions that produce them (copy may change freely) ──
const STYLE = W.styleGuide();
const NOINV = brain.NO_INVENTION_RULE;
const SPOKEN = brain.spokenV2();
const V2HEAD = brain.fullBrandBlock({ brandName: 'x' }, { v2: true }).split('\n')[0];
const LEGACYHEAD = brain.fullBrandBlock({ brandName: 'x' }).split('\n')[0];
const BG = 'Background facts about the brand';
// The dropped clipping / rulebook rules. Case-insensitive where the old copy varied its casing.
const DROPPED = [
  ['max 8 words', /max\s*~?\s*8 words/i],
  ['fragments beat sentences', /fragments? (sentences )?beat (full )?sentences/i],
  ['a number beats an adjective', /a number beats an adjective/i],
  ['rule-of-three ban', /two items or four, never three|rule-of-three/i],
  ['"use specific numbers, names"', /use specific numbers, names/i],
  ['HOOK RULES rulebook', /HOOK RULES/],
  ['clarityFlow compression', /CLARITY & FLOW|cut every word/i],
  ['rhythm list', /RHYTHM & DRAMA TELLS/],
  ['spokenShape override', /SPOKEN-SCRIPT SHAPE/],
];
const droppedIn = (t) => DROPPED.filter(([, re]) => re.test(t)).map(([n]) => n);

// Opposite: the detector itself fires on the legacy texts it exists to catch.
ok(droppedIn('HOOK RULES (the hook...):\n- Max 8 words. Shorter = better. Fragment sentences beat full sentences.').length >= 2, 'detector: finds the old HOOK RULES clipping rule');
ok(droppedIn(brain.clarityFlow()).includes('clarityFlow compression') && droppedIn(brain.spokenShape()).includes('spokenShape override'), 'detector: finds clarityFlow and spokenShape');
ok(V2HEAD !== LEGACYHEAD && /invent/i.test(V2HEAD) && V2HEAD.startsWith(brain.BRAND_HEADING), 'v2 brand heading differs from the legacy one and forbids inventing facts');
ok(STYLE.includes(NOINV), 'the style guide carries the no-invention rule');

const BC = {
  brandId: 'brand-1', brandName: 'Acme Studio', tones: ['dry', 'warm', 'blunt'],
  usps: 'ZUSP_MARK we edit videos in 48 hours', productDetails: 'ZPROD_MARK weekly edits',
  socialProof: 'ZPROOF_MARK featured in a newsletter', painPoints: 'ZPAIN_MARK nobody watches past three seconds',
  beliefs: ['ZBELIEF_MARK one good video a week beats seven rushed ones'],
  stories: [{ id: 's1', text: 'ZSTORY1 I once filmed the same video eleven times', tags: [] }],
  approvedExamples: [], recentTrends: [], engine: 'grok',
};
const BC4 = { ...BC, tones: ['dry', 'warm', 'blunt', 'playful'] };
const IDEA = (o) => ({ day: 'Monday', community: 'editing', format: 'video', tone: 'dry', title: 'Post less', hook: 'You are posting too much.', script: 'You post every day and it gets quieter. [your story: a week you posted less]', emphasis: ['too much'], shots: 'Shot 1: desk', caption: '', reelTitle: 'Post less', tags: '#AcmeStudio', ...o });
const IDEA_KEYS = ['belief', 'day', 'community', 'format', 'tone', 'title', 'hook', 'script', 'emphasis', 'shots', 'caption', 'reelTitle', 'tags'];
const sameKeys = (o, keys) => JSON.stringify(Object.keys(o || {}).sort()) === JSON.stringify(keys.slice().sort());

// ═════ 1. generate-ideas: the prompt ═════
{
  const res = await run('ideas', { brandContext: BC, count: 3, learningContext: '' },
    () => JSON.stringify([IDEA({ belief: 'Posting every day is the slowest way to grow' })]));
  const P = calls[0] ? calls[0].prompt : '';
  ok(res.statusCode === 200 && calls.length === 1, 'ideas: one call, 200 (got ' + res.statusCode + ', ' + calls.length + ' calls)');
  ok(P.includes(STYLE), 'ideas: the prompt carries the short style guide');
  ok(P.includes(NOINV), 'ideas: the prompt carries the no-invention slot rule');
  ok(P.includes(SPOKEN), 'ideas: the prompt carries the short spoken rule (spoken scripts breathe)');
  ok(P.includes(V2HEAD) && !P.includes(LEGACYHEAD), 'ideas: the brand renders through the v2 block, not the legacy one');
  ok(droppedIn(P).length === 0, 'ideas: the dropped rules are gone (found: ' + droppedIn(P).join(', ') + ')');
  ok(!P.includes(brain.rulePrecedence()), 'ideas: the legacy precedence block is gone (the v2 heading carries precedence)');
  // belief first: stated before the idea is written, and the first schema key
  ok(/BELIEF FIRST/.test(P) && /does NOT share yet/.test(P) && /never about the brand's product or features/.test(P), 'ideas: the belief-first instruction is present');
  const schema = P.slice(P.indexOf('Each idea:'));
  const firstKey = (schema.match(/\{\s*\n\s*"([a-zA-Z]+)"/) || [])[1];
  ok(firstKey === 'belief', 'ideas: "belief" is the FIRST key of the schema (committed before the hook) — got ' + firstKey);
  ok(P.indexOf('BELIEF FIRST') < P.indexOf('CONTENT FORMATS'), 'ideas: the belief step comes before the format rules');
  // USPs as background facts, beliefs, stories, 3 tones rendered
  const iBg = P.indexOf(BG), iUsp = P.indexOf('ZUSP_MARK');
  ok(iBg > -1 && iUsp > iBg && /mention at most one/i.test(P.slice(iUsp, iUsp + 400)), 'ideas: USPs are framed as background facts (at most one mention)');
  ok(!/What the brand is \/ key facts/.test(P), 'ideas: USPs are NOT the legacy pitch list');
  ok(P.includes('ZBELIEF_MARK') && P.includes('ZSTORY1'), 'ideas: the brand\'s held beliefs and its story bank reach the prompt');
  ok(/Voice \/ tones: dry, warm, blunt/.test(P), 'ideas: 3 tones are rendered as the voice');
  ok(/"tone": "dry /.test(P), 'ideas: the schema labels the brand\'s primary tone');
  ok(/\[your story: <what to tell>\]/.test(P) && !/no placeholders, no "\[insert X\]"/.test(P), 'ideas: slots are allowed (the old "no placeholders" rule no longer forbids them)');
  // shape, belief, warnings, behaviour kept
  const b = res.body || {};
  ok(Array.isArray(b.ideas) && b.ideas.length === 1 && sameKeys(b.ideas[0], IDEA_KEYS), 'ideas: the idea keeps its shape plus `belief` (got ' + Object.keys((b.ideas || [])[0] || {}).join(',') + ')');
  ok(b.ideas && b.ideas[0].belief === 'Posting every day is the slowest way to grow', 'ideas: `belief` is returned intact');
  ok(Array.isArray(b.warnings) && b.warnings.length === 0, 'ideas: warnings is [] when tones <= 3');
  ok(calls[0].opts.timeoutMs === 90000 && calls[0].opts.deadlineMs === 93333 && calls[0].opts.max_tokens === 16000, 'ideas: the time budget and token size are unchanged');
  ok(gates.length === 1 && gates[0].action === 'ideas' && holds.length === 1 && usageLogs.length === 1 && usageLogs[0].action === 'ideas', 'ideas: gated, hold-release attached, metered once as "ideas"');
}

// ═════ 2. the belief field: missing / overlong / odd shapes vs a fitting one ═════
{
  const long = 'Most people think posting every single day is what grows an account, but the thing that actually grows it is posting fewer videos that each say one thing well';
  const exact = 'x'.repeat(140);
  const res = await run('ideas', { brandContext: BC, count: 5 }, () => JSON.stringify([
    IDEA({ title: 'a', belief: long }), IDEA({ title: 'b' }), IDEA({ title: 'c', belief: ['Less is', 'more'] }),
    IDEA({ title: 'd', belief: '"Quoted belief here"' }), IDEA({ title: 'e', belief: exact }),
  ]));
  const I = (res.body && res.body.ideas) || [];
  const [a, bb, c, d, e] = I;
  ok(I.length === 5 && I.every(i => typeof i.belief === 'string'), 'belief: every idea returns a string belief');
  ok(a && a.belief.length <= 140 && long.startsWith(a.belief) && long[a.belief.length] === ' ' && !/[,;:\-]$/.test(a.belief), 'belief: an overlong one is cut to <= 140 on a word boundary (got ' + (a && a.belief.length) + ')');
  ok(bb && bb.belief === '', 'belief: a missing one is "" (never derived from the hook)');
  ok(c && c.belief === 'Less is more', 'belief: a list is coerced to one line');
  ok(d && d.belief === 'Quoted belief here', 'belief: surrounding quotes are dropped');
  ok(e && e.belief === exact, 'belief (opposite): a belief of exactly 140 chars is untouched');
  // a belief alone is not an idea: the no-blank-card rule still holds
  const blank = await run('ideas', { brandContext: BC, count: 1 }, () => JSON.stringify([{ belief: 'only a belief' }]));
  ok(blank.statusCode === 502 && usageLogs.length === 0, 'belief: an idea with only a belief is still an empty result (502, not metered)');
}

// ═════ 3. tones: > 3 -> none + warning (and its opposite above) ═════
{
  const res = await run('ideas', { brandContext: BC4, count: 1 }, () => JSON.stringify([IDEA({ belief: 'b', tone: 'dry' })]));
  const P = calls[0] ? calls[0].prompt : '';
  ok(!/Voice \/ tones:/.test(P) && !/BRAND VOICE — TONE/.test(P), 'tones>3: no tone is rendered anywhere in the prompt');
  ok(!/"tone": "dry/.test(P) && /"tone": "\s*\(leave this an empty string/.test(P), 'tones>3: the schema asks for an empty tone');
  ok(res.body && JSON.stringify(res.body.warnings) === '["tones_over_limit"]', 'tones>3: the response carries warnings:["tones_over_limit"]');
  ok(res.body && res.body.ideas && res.body.ideas[0].tone === '', 'tones>3: an idea is never labelled with a tone the brand block declined');
  const str = await run('ideas', { brandContext: { ...BC, tones: 'dry, warm' }, count: 1 }, () => JSON.stringify([IDEA({ belief: 'b', tone: 'nonsense' })]));
  ok(str.statusCode === 200 && str.body.ideas[0].tone === 'dry' && str.body.warnings.length === 0, 'tones as a comma string: parsed, clamped to the primary tone, no warning');
}

// ═════ 4. question seeds become beliefs (PAA), and nothing else does ═════
{
  const PAA_LC = 'Recently approved: x\n\nSEED QUESTION (base the idea on answering this real search question):\n"ZQ_MARK how often should I post?"\nSource: Google PAA, Keyword: "posting"\n\nCreate one content idea that directly addresses this question. The hook should reference the question. The script should answer it in an engaging way.';
  await run('ideas', { brandContext: BC, count: 1, learningContext: PAA_LC }, () => JSON.stringify([IDEA({ belief: 'b' })]));
  const P = calls[0] ? calls[0].prompt : '';
  const iSeed = P.indexOf('ZQ_MARK'), iTurn = P.indexOf('THE SEED IS A SEARCH QUESTION');
  ok(iTurn > -1 && /belief about the viewer's situation/.test(P) && /Do NOT simply answer it/.test(P), 'PAA: the question is turned into a belief about the viewer\'s situation');
  ok(iSeed > -1 && iTurn > iSeed && iTurn > P.indexOf('The script should answer it'), 'PAA: the belief instruction comes AFTER the old "answer it" text, so it overrides it');
  await run('ideas', { brandContext: BC, count: 1, seedQuestion: 'ZQ2_MARK is  daily posting bad?' }, () => JSON.stringify([IDEA({ belief: 'b' })]));
  const P2 = calls[0] ? calls[0].prompt : '';
  ok(P2.includes('THE SEED IS A SEARCH QUESTION: "ZQ2_MARK is daily posting bad?"'), 'PAA: a structured seedQuestion is quoted into the belief instruction');
  await run('ideas', { brandContext: BC, count: 1, learningContext: 'Recently approved: the label post' }, () => JSON.stringify([IDEA({ belief: 'b' })]));
  ok(calls[0] && !calls[0].prompt.includes('THE SEED IS A SEARCH QUESTION'), 'PAA (opposite): an ordinary batch gets no question instruction');
  await run('ideas', { brandContext: BC, count: 1, seedIdea: 'ZSEED_MARK posting less made me grow' }, () => JSON.stringify([IDEA({ belief: 'b' })]));
  const P3 = calls[0] ? calls[0].prompt : '';
  ok(P3.includes('ZSEED_MARK') && /find the belief inside it/.test(P3) && !P3.includes('THE SEED IS A SEARCH QUESTION'), 'Idea Catcher: a dropped idea is developed from the belief inside it');
}

// ═════ 5. empty brand, hydrated brand, 424, guardrail regeneration ═════
{
  const res = await run('ideas', { brandContext: {}, count: 1 }, () => JSON.stringify([IDEA({ belief: 'b' })]));
  const P = calls[0] ? calls[0].prompt : '';
  ok(res.statusCode === 200 && !/undefined|\[object Object\]/.test(P) && P.includes(STYLE) && P.includes('#MyBrand'), 'empty brand: usable prompt, no "undefined", style guide present');

  hydrate = null;
  const hyd = await runWith('ideas', { brandId: 'brand-1', count: 1 }, () => JSON.stringify([IDEA({ belief: 'b' })]),
    () => { hydrate = () => ({ ok: true, fields: 12, bc: { brandName: 'Acme Studio', stories: [{ id: 'h1', text: 'ZHYD_STORY the client who posted once a week' }], beliefs: ['ZHYD_BELIEF'] }, avoidTitles: [] }); });
  ok(hyd.statusCode === 200 && calls[0] && calls[0].prompt.includes('ZHYD_STORY') && calls[0].prompt.includes('ZHYD_BELIEF'), 'lean request: hydrated stories and beliefs reach the prompt');
  const down = await runWith('ideas', { brandId: 'brand-1', count: 1 }, () => '[]', () => { hydrate = () => ({ ok: false, reason: 'read_failed' }); });
  ok(down.statusCode === 424 && down.body.error === 'brand_context_unavailable' && calls.length === 0, 'lean request: an unreadable brand is a 424 before any AI call');
  const thin = await runWith('ideas', { brandId: 'brand-1', bcFields: 20, count: 1 }, () => '[]', () => { hydrate = () => ({ ok: true, fields: 3, bc: { brandName: 'x' }, avoidTitles: [] }); });
  ok(thin.statusCode === 424 && thin.body.reason === 'stale_brand_row' && calls.length === 0, 'lean request: a half-empty brand row is a 424 (stale_brand_row)');

  const g = await run('ideas', { brandContext: { ...BC, avoidWords: 'hustle' }, count: 1 }, (i) => i === 0
    ? JSON.stringify([IDEA({ belief: 'b1', script: 'hustle harder' })])
    : JSON.stringify([IDEA({ belief: 'b2', script: 'work less' })]));
  ok(calls.length === 2 && g.body.ideas[0].belief === 'b2' && g.body.ideas[0].script === 'work less', 'guardrail: an avoid-word still triggers ONE regeneration, and its belief survives');
}

// ═════ 6. generate-ideas guard / usage / aiUnavailable ═════
{
  const over = await runWith('ideas', { brandContext: BC, count: 1 }, () => '[]', () => { gateMode = 'over'; });
  ok(over.statusCode === 402 && calls.length === 0 && usageLogs.length === 0, 'ideas: over the limit -> denied before any AI call');
  const anon = await runWith('ideas', { brandContext: BC, count: 1 }, () => '[]', () => { userMode = 'none'; });
  ok(anon.statusCode === 401 && calls.length === 0, 'ideas: signed out -> 401, no AI call');
  const ai = await run('ideas', { brandContext: BC, count: 1 }, () => { throw aiErr(); });
  ok(ai.statusCode === 503 && ai.body && ai.body.code === 'AI_UNAVAILABLE' && usageLogs.length === 0 && holds.length === 1, 'ideas: a refused AI account -> 503 AI_UNAVAILABLE, not metered, hold release attached');
  const boom = await run('ideas', { brandContext: BC, count: 1 }, () => { throw new Error('socket hang up'); });
  ok(boom.statusCode === 500 && usageLogs.length === 0, 'ideas (opposite): an ordinary failure stays a 500');
}

// ═════ 7. viral-rewrite ═════
const REWRITE = JSON.stringify({ title: 't', hook: 'h', script: 's [your story: x]', shots: 'Shot 1', boldText: '', caption: '', tags: '#a' });
{
  const body = (fmt) => ({ brandContext: BC, idea: { title: 't', hook: 'h', script: 'orig [your story: the client call]', format: fmt }, angle: { angle: 'Contrarian', hook: 'Posting daily is the slow way' } });
  const res = await run('rewrite', body('video'), () => REWRITE);
  const P = calls[0] ? calls[0].prompt : '';
  ok(res.statusCode === 200 && P.includes(STYLE) && P.includes(NOINV), 'viral-rewrite: style guide + no-invention rule');
  ok(P.includes(V2HEAD) && P.indexOf('ZUSP_MARK') > P.indexOf(BG), 'viral-rewrite: v2 brand block with USPs as background facts');
  ok(P.includes('ZSTORY1'), 'viral-rewrite: the story bank can fill proof');
  ok(droppedIn(P).length === 0, 'viral-rewrite: dropped rules gone (found: ' + droppedIn(P).join(', ') + ')');
  ok(!/WORD-LEVEL HUMANIZER/.test(P), 'viral-rewrite: writingCraft\'s rulebook is replaced by the style guide');
  ok(P.includes(SPOKEN), 'viral-rewrite: a spoken format gets the spoken rule');
  ok(/keep every \[your story: \.\.\.\] slot/i.test(P), 'viral-rewrite: existing slots are kept');
  ok(P.trim().endsWith(brain.rulePrecedence().trim()), 'viral-rewrite: precedence still last');
  ok(res.body && sameKeys(res.body.idea, Object.keys(brain.VIRAL_REWRITE_SHAPE)), 'viral-rewrite: output shape unchanged');
  ok(usageLogs.length === 1 && usageLogs[0].action === 'viral', 'viral-rewrite: metered once as "viral"');
  await run('rewrite', body('statement'), () => REWRITE);
  ok(calls[0] && !calls[0].prompt.includes(SPOKEN) && calls[0].prompt.includes(STYLE), 'viral-rewrite (opposite): a statement gets no spoken rule');
  await run('rewrite', { ...body('video'), brandContext: BC4 }, () => REWRITE);
  ok(calls[0] && !/Voice \/ tones:/.test(calls[0].prompt), 'viral-rewrite: > 3 tones render no tone');
  const over = await runWith('rewrite', body('video'), () => REWRITE, () => { gateMode = 'over'; });
  ok(over.statusCode === 402 && calls.length === 0, 'viral-rewrite: over the limit -> denied, no AI call');
  const anon = await runWith('rewrite', body('video'), () => REWRITE, () => { userMode = 'none'; });
  ok(anon.statusCode === 401 && calls.length === 0, 'viral-rewrite: signed out -> 401');
  const ai = await run('rewrite', body('video'), () => { throw aiErr(); });
  ok(ai.statusCode === 503 && ai.body.code === 'AI_UNAVAILABLE' && usageLogs.length === 0, 'viral-rewrite: refused AI -> 503, not metered');
}

// ═════ 8. viral-twist ═════
{
  const body = { brandContext: BC, idea: { title: 't', hook: 'h', script: 's', format: 'video' } };
  const res = await run('twist', body, () => JSON.stringify({ angles: [{ angle: 'a', hook: 'h', why: 'w' }], spicy: { hook: 'h', why: 'w' }, tip: 't' }));
  const P = calls[0] ? calls[0].prompt : '';
  ok(res.statusCode === 200 && P.includes(STYLE) && P.includes(NOINV) && P.includes(V2HEAD), 'viral-twist: style guide + no-invention + v2 brand block');
  ok(droppedIn(P).length === 0 && !/WORD-LEVEL HUMANIZER/.test(P), 'viral-twist: dropped rules gone (found: ' + droppedIn(P).join(', ') + ')');
  ok(P.indexOf('ZUSP_MARK') > P.indexOf(BG), 'viral-twist: USPs as background facts');
  ok(P.trim().endsWith(brain.rulePrecedence().trim()), 'viral-twist: precedence still last');
  ok(res.body && sameKeys(res.body.twist, ['angles', 'spicy', 'tip']) && sameKeys(res.body.twist.angles[0], ['angle', 'hook', 'why']), 'viral-twist: output shape unchanged');
  const ai = await run('twist', body, () => { throw aiErr(); });
  ok(ai.statusCode === 503 && usageLogs.length === 0, 'viral-twist: refused AI -> 503, not metered');
  const over = await runWith('twist', body, () => '{}', () => { gateMode = 'over'; });
  ok(over.statusCode === 402 && calls.length === 0, 'viral-twist: over the limit -> denied');
}

// ═════ 9. viral-analyze ═════
{
  const body = { brandContext: BC, content: 'transcript: a creator says ZTRANS_NUM 3 posts a day took her to 1 million', platform: 'tiktok' };
  const res = await run('analyze', body, () => JSON.stringify({ whyItWorks: ['a'], hook: 'h', structure: 's', trigger: 't', ideas: [{ format: 'video', title: 't', hook: 'h', angle: 'a', script: 's' }], takeaway: 'k' }));
  const P = calls[0] ? calls[0].prompt : '';
  ok(res.statusCode === 200 && P.includes(NOINV) && P.includes(V2HEAD), 'viral-analyze: no-invention rule + v2 brand block');
  ok(droppedIn(P).length === 0, 'viral-analyze: "max 8 words" and friends gone (found: ' + droppedIn(P).join(', ') + ')');
  ok(/"angle": "the belief this idea argues/.test(P) && /does not share yet/.test(P), 'viral-analyze: each adapted idea argues a belief');
  ok(/never present them as the brand's/.test(P), 'viral-analyze: the source\'s numbers are never borrowed as the brand\'s');
  ok(res.body && sameKeys(res.body.analysis, Object.keys(brain.VIRAL_ANALYZE_SHAPE)) && sameKeys(res.body.analysis.ideas[0], ['format', 'title', 'hook', 'angle', 'script']), 'viral-analyze: output shape unchanged');
  const ai = await run('analyze', body, () => { throw aiErr(); });
  ok(ai.statusCode === 503 && usageLogs.length === 0, 'viral-analyze: refused AI -> 503, not metered');
}

// ═════ 10. sharpen ═════
{
  const body = (fmt) => ({ brandContext: BC, kind: 'post', format: fmt, content: { hook: 'Post less.', script: 'You post every day. [your story: the week I stopped] It gets quieter.' } });
  const res = await run('sharpen', body('video'), (i) => i === 0 ? 'The hook is flat.' : JSON.stringify({ hook: 'Post less, grow more.', script: 'You post every day. [your story: the week I stopped] And it gets quieter.' }));
  const crit = calls[0] ? calls[0].prompt : '', rew = calls[1] ? calls[1].prompt : '';
  ok(res.statusCode === 200 && calls.length === 2, 'sharpen: two passes');
  ok(crit.includes(V2HEAD) && rew.includes(V2HEAD) && rew.indexOf('ZUSP_MARK') > rew.indexOf(BG), 'sharpen: both passes see the v2 brand block, USPs as background');
  ok(rew.includes(STYLE) && rew.includes(NOINV), 'sharpen: the rewrite carries the style guide + no-invention rule');
  ok(droppedIn(crit + '\n' + rew).length === 0, 'sharpen: dropped rules gone (found: ' + droppedIn(crit + '\n' + rew).join(', ') + ')');
  ok(/Keep every \[your story: \.\.\.\] slot exactly as written/.test(rew) && /filling a \[your story: \.\.\.\] slot/.test(crit), 'sharpen: slots are kept by the editor and never "fixed" by the critic');
  ok(rew.includes(SPOKEN), 'sharpen: a spoken draft gets the spoken rule');
  ok(rew.trim().endsWith(brain.rulePrecedence().trim()), 'sharpen: precedence still last');
  ok(res.body && sameKeys(res.body.sharpened, ['hook', 'script']) && !res.body.unchanged, 'sharpen: output shape unchanged (same keys back)');
  await run('sharpen', body('carousel'), (i) => i === 0 ? 'x' : JSON.stringify({ hook: 'a', script: 'b' }));
  ok(calls[1] && !calls[1].prompt.includes(SPOKEN) && calls[1].prompt.includes(STYLE), 'sharpen (opposite): a carousel gets no spoken rule');
  const strong = await run('sharpen', body('video'), () => 'STRONG');
  ok(strong.body && strong.body.unchanged === true && calls.length === 1 && usageLogs.length === 1, 'sharpen: STRONG still short-circuits, metered once');
  const ai = await run('sharpen', body('video'), () => { throw aiErr(); });
  ok(ai.statusCode === 503 && calls.length === 1 && usageLogs.length === 0, 'sharpen: a refused critique stops at one call -> 503, not metered');
  const over = await runWith('sharpen', body('video'), () => 'x', () => { gateMode = 'over'; });
  ok(over.statusCode === 402 && calls.length === 0, 'sharpen: over the limit -> denied');
}

// ═════ 11. storiesBlock bounds (the renderer the single-call writers share) ═════
{
  const many = Array.from({ length: 25 }, (_, i) => ({ id: 's' + i, text: 'story ' + i + ' ' + 'w'.repeat(700) }));
  const sb = brain.storiesBlock({ stories: many }, 3000);
  const lines = sb.split('\n').filter(l => l.startsWith('- '));
  ok(lines.length >= 1 && lines.length <= 10 && lines.every(l => l.length <= 602), 'storiesBlock: at most 10 stories, each <= 600 chars');
  ok(sb.length < 3000 + 400, 'storiesBlock: bounded by its cap');
  const short = brain.storiesBlock({ stories: Array.from({ length: 30 }, (_, i) => ({ id: 'q' + i, text: 'short story ' + i })) }, 3000);
  ok(short.split('\n').filter(l => l.startsWith('- ')).length === 10, 'storiesBlock: 30 short stories -> exactly 10 rendered (count cap binds, not just the char cap)');
  ok(brain.storiesBlock({ stories: [] }) === '' && brain.storiesBlock({}) === '' && brain.storiesBlock({ stories: [{ text: '  ' }, null] }) === '', 'storiesBlock (opposite): nothing to render -> ""');
}

clearTimeout(WALL);
console.log(`rv2-gen-1: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
console.log('GEN V2 OK');
