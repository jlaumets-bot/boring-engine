#!/usr/bin/env node
// GATE rv2-write-1 — the content-v2 writing pipeline, EXECUTED (v693).
//
// Runs the REAL api/_write.js, api/_brain.js, api/angles.js, api/write.js, api/remix.js and the real
// weight maps in api/_usage.js. Only the edges are stubbed: callLLM (captures every prompt and option,
// answers from a per-scenario plan, zero network), guard/logUsage, loadBrandContext, the brand-access
// check. Time is a FAKE CLOCK (Date.now + skew) so "this call took 45s" costs no wall time.
// Every behaviour is paired with its opposite, so a check that cannot fail is visible as one.
//
// RUN:    node scripts/verify/rv2-write-1.mjs
// EXPECT: prints "PIPELINE OK" and exits 0.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const Module = require_('module');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = path.join(ROOT, 'api');
const WALL = setTimeout(() => { console.log('FAIL: rv2-write-1 wall clock (60s) — something hung'); process.exit(1); }, 60000);

let failed = 0, passed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.log('FAIL: ' + m); } };

// ── the real weight maps, read BEFORE _usage is stubbed for the endpoints ──
const realUsage = require_(path.join(API, '_usage.js'));
delete require_.cache[require_.resolve(path.join(API, '_usage.js'))];

// ── fake clock ──
const realNow = Date.now.bind(Date);
let skew = 0, T0 = 0;
Date.now = () => realNow() + skew;

function stub(rel, exports) {
  const file = require_.resolve(path.join(API, rel));
  const m = new Module(file); m.filename = file; m.loaded = true; m.exports = exports; require_.cache[file] = m;
}

// callLLM plan: plan(i, opts) returns a string or throws; it may advance `skew` to simulate duration.
let calls = [], plan = () => '';
const aiErr = () => { const e = new Error('refused'); e.code = 'AI_UNAVAILABLE'; e.refused = 403; return e; };
stub('_llm.js', {
  callLLM: async (opts) => {
    const i = calls.length;
    calls.push({ at: Date.now() - T0, opts, prompt: (opts.messages || []).map(m => m.content).join('\n') });
    return plan(i, opts);
  },
  aiUnavailable: (e) => (e && e.code === 'AI_UNAVAILABLE') ? { status: 503, body: { error: 'paused', code: 'AI_UNAVAILABLE' } } : null,
  callGrokSearch: async () => null,
});
let usageLogs = [], guardCalls = [], guardMode = 'ok', guardCostMs = 0;
stub('_usage.js', {
  guard: async (req, action, res) => {
    guardCalls.push({ action, hasRes: !!res }); skew += guardCostMs;
    if (guardMode === 'nouser') return { user: null, over: false };
    if (guardMode === 'over') return { user: { id: 'u1' }, over: true, gate: { reason: 'limit_reached' } };
    return { user: { id: 'u1' }, over: false, billingUserId: 'bill-1' };
  },
  denyResponse: (res) => res.status(402).json({ error: 'limit_reached' }),
  logUsage: async (evt) => { usageLogs.push(evt); },
});
let hydrate = null, hydCalls = [];
stub('_brandctx.js', { loadBrandContext: async (id, opts, fmt) => { hydCalls.push({ id, opts, fmt }); return hydrate(id); } });
stub('_publish/store.js', { userCanAccessBrand: async () => true });
stub('_requireUser.js', async () => ({ id: 'u1' }));

const brain = require_(path.join(API, '_brain.js'));
const W = require_(path.join(API, '_write.js'));
const anglesH = require_(path.join(API, 'angles.js'));
const writeH = require_(path.join(API, 'write.js'));
const remix = require_(path.join(API, 'remix.js'));

const reset = () => { calls = []; usageLogs = []; guardCalls = []; hydCalls = []; skew = 0; T0 = Date.now(); guardMode = 'ok'; guardCostMs = 0; };
const fakeRes = () => ({ statusCode: 0, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } });
const post = (body) => ({ method: 'POST', headers: { origin: 'https://contentshrimp.com' }, body });
const code = async (p) => { try { await p; return 'resolved'; } catch (e) { return e.code || e.message; } };
const SLOT = '[your story: the day a client called me at midnight]';
const SRC = { kind: 'remix', text: 'A creator says you should post three times a day to grow. ZSRC_MARK', creator: 'someone', platform: 'tiktok' };
const ANGLE = { belief: 'Posting more often is the slowest way to grow', why: 'Everyone has been told volume beats everything' };
const BC = {
  brandName: 'Acme Studio', tones: ['dry', 'warm', 'blunt'], usps: 'ZUSP_MARK we edit videos',
  productDetails: 'ZPROD_MARK weekly edits', socialProof: 'ZPROOF_MARK featured in a newsletter',
  beliefs: ['ZBELIEF_MARK one good video a week beats seven rushed ones'],
  stories: [{ id: 's1', text: 'ZSTORY1 I once filmed the same video eleven times', tags: [] }, { id: 's2', text: 'ZSTORY2 A client doubled her replies by posting less', tags: [] }],
  speechSamples: ['ZSPEECH1 so, um, the thing is, right, you post and nobody sees it', 'ZSPEECH2 and honestly that is fine because'],
  avoidWords: 'hustle',
};
const DRAFT = 'You have been told to post every day. ' + SLOT + ' So you post, and it gets quieter every week, because nobody has time to care about a rushed video. The fix is boring. Post less, and make each one worth the minute.';
const SPOKEN = 'Everyone tells you to post every day.\n' + SLOT + '\nSo you post... and it gets quieter every week.\nBecause nobody has time for a rushed video.\nThe fix is boring.\nPost less, and make each one worth the minute.';
const SHAPE = JSON.stringify({ script: 'HIJACK SCRIPT', title: 'Post less, grow faster', hook: 'Everyone tells you to post every day.', onScreen: ['Post less', 'Make it worth the minute'], caption: 'Posting more is not the fix.', shots: ['Talk to camera at a desk'], emphasis: ['make each one worth the minute', 'this phrase is not in the script', 'THE FIX IS BORING'] });

// ═════ 1. style guide + writingCraft ═════
{
  const sg = W.styleGuide();
  ok(sg.length < 1200, 'styleGuide is short (' + sg.length + ' chars, must be < 1200)');
  ok(sg.includes('[your story: <what to tell>]'), 'styleGuide carries the exact slot format');
  ok(/never invent/i.test(sg), 'styleGuide states the no-invention rule');
  ok(!/8 words/i.test(sg) && !/number beats an adjective/i.test(sg), 'styleGuide lacks the two dropped rules');
  ok(sg.includes('Did you know') && /em dash/i.test(sg), 'styleGuide keeps the AI-tell openers and the worst patterns');
  for (const [label, wc] of [['default', brain.writingCraft()], ['spoken', brain.writingCraft({ spoken: true, precedence: false })], ['no hooks', brain.writingCraft({ hooks: false })]]) {
    ok(wc.includes('[your story: <what to tell>]'), 'writingCraft(' + label + ') has the slot rule');
    ok(!/Max ~8 words/.test(wc) && !/a number beats an adjective/i.test(wc), 'writingCraft(' + label + ') dropped "Max ~8 words" and "a number beats an adjective"');
    ok(wc.includes('WORD-LEVEL HUMANIZER') && wc.includes('Did you know') && wc.includes('RHYTHM & DRAMA TELLS'), 'writingCraft(' + label + ') keeps its other rules');
  }
  ok(/HOOK \(the first line/.test(brain.writingCraft()) && !/HOOK \(the first line/.test(brain.writingCraft({ hooks: false })), 'writingCraft still gates the hook block on opts.hooks');
}

// ═════ 2. the v2 brand block ═════
{
  const b = W._internals.brandBlockV2(BC);
  ok(/Voice \/ tones: dry, warm, blunt/.test(b), 'v2 block renders 3 tones');
  ok(!/NEVER contradict/.test(b) && !/use ONLY these/.test(b), 'v2 block drops the legacy "NEVER contradict" / "use ONLY these" framing');
  ok(/Background facts about the brand[^\n]*:\nZUSP_MARK/.test(b) && /mention at most one/.test(b) && /Never as a pitch/.test(b), 'USPs are framed as background facts (at most one, never a pitch)');
  ok(/Background facts: product details[^\n]*:\nZPROD_MARK/.test(b) && /Background facts: real proof[^\n]*:\nZPROOF_MARK/.test(b), 'product details and proof are background facts too');
  ok(/Beliefs this brand already holds[^\n]*\n- ZBELIEF_MARK/.test(b), 'held beliefs rendered, stay-consistent framing');
  ok(/never permits inventing facts/.test(b), 'v2 heading says the brand never licenses invention');
  const legacy = brain.fullBrandBlock(BC);
  ok(/Voice \/ tones \(NEVER contradict\)/.test(legacy) && /use ONLY these/.test(legacy) && !/Beliefs this brand/.test(legacy) && !/never permits/.test(legacy), 'opposite: the legacy renderer is unchanged');
  const four = Object.assign({}, BC, { tones: ['a1', 'b2', 'c3', 'd4'] });
  const b4 = W._internals.brandBlockV2(four);
  ok(!/Voice \/ tones/.test(b4) && !/a1/.test(b4), 'tones > 3: v2 block uses none');
  ok(JSON.stringify(W._internals.warningsFor(four)) === '["tones_over_limit"]' && JSON.stringify(W._internals.warningsFor(BC)) === '[]', 'tones > 3 warns tones_over_limit; 3 tones do not');
  const bare = W._internals.brandBlockV2({ brandName: 'Bare', beliefs: [], stories: [], speechSamples: [] });
  ok(/Brand: Bare/.test(bare) && !/Beliefs this brand/.test(bare) && !/Background facts/.test(bare) && !/undefined|null/.test(bare), 'empty arrays render cleanly');
  ok(/No brand profile yet/.test(W._internals.brandBlockV2({})), 'a missing brand renders a no-invention placeholder');
}

// ═════ 3. runAngles ═════
{
  reset();
  const long = 'Most people think a bigger audience fixes a weak offer but really the offer decides whether any audience ever turns into a single paying customer at all ever';
  plan = () => JSON.stringify({ angles: [
    { belief: long, why: 'x'.repeat(50) + ' ' + 'because y '.repeat(40), hookSeed: 'Your audience is not the problem.' },
    { belief: 'Posting daily makes you invisible', why: 'volume feels safe' },
    { belief: 'posting daily makes you invisible', why: 'dup' },
    { belief: '', why: 'empty' },
    'Consistency is overrated when nobody is watching',
    { belief: 'Belief alpha', why: 'w' }, { belief: 'Belief beta', why: 'w' }, { belief: 'Belief gamma', why: 'w' }, { belief: 'Belief delta', why: 'w' }, { belief: 'Belief epsilon', why: 'w' },
  ] });
  const out = await W.runAngles({ bc: BC, source: SRC, count: 6, provider: 'claude', effort: 'high', deadlineMs: 60000 });
  const A = out.angles;
  ok(calls.length === 1, 'runAngles makes ONE call (made ' + calls.length + ')');
  ok(A.length === 6, 'runAngles returns exactly `count` angles (got ' + A.length + ')');
  ok(A.every(a => typeof a.id === 'string' && a.id && a.belief.length <= 140 && a.why.length <= 200), 'every angle has an id, belief <= 140, why <= 200');
  ok(A[0].belief.length < long.length && long.startsWith(A[0].belief), 'a long belief is clipped on a word boundary');
  ok(new Set(A.map(a => a.id)).size === A.length && new Set(A.map(a => a.belief.toLowerCase())).size === A.length, 'no duplicate beliefs or ids');
  ok(A[0].hookSeed === 'Your audience is not the problem.' && !('hookSeed' in A[1]), 'hookSeed kept only where given');
  ok(A.some(a => a.belief === 'Consistency is overrated when nobody is watching'), 'a bare-string angle is kept');
  const p = calls[0].prompt;
  ok(p.includes('ZSRC_MARK') && /does NOT share/.test(p) && /Never reuse the creator/.test(p), 'angles prompt: source + not-shared beliefs + never copy the creator');
  ok(p.includes('never permits inventing facts') && p.includes('[your story: <what to tell>]'), 'angles prompt carries the v2 brand block and the no-invention rule');
  ok(calls[0].opts.provider === 'claude' && calls[0].opts.effort === 'high', 'runAngles passes provider/effort through');
  ok(calls[0].opts.deadlineMs <= 60000, 'runAngles honours deadlineMs');
  ok(JSON.stringify(out.warnings) === '[]', 'no warnings with 3 tones');
  reset(); plan = () => JSON.stringify({ angles: [{ belief: 'Alpha', why: 'w' }] });
  await W.runAngles({ bc: BC, source: SRC, count: 20 }); ok(/write 8 beliefs/.test(calls[0].prompt), 'count 20 is clamped to 8');
  reset(); await W.runAngles({ bc: BC, source: SRC, count: 2 }); ok(/write 5 beliefs/.test(calls[0].prompt), 'count 2 is clamped to 5');
  reset(); await W.runAngles({ bc: BC, source: SRC }); ok(/write 6 beliefs/.test(calls[0].prompt), 'count defaults to 6');
  reset(); plan = (i) => i === 0 ? 'not json' : JSON.stringify({ angles: [{ belief: 'Beta', why: 'w' }] });
  const r2 = await W.runAngles({ bc: BC, source: SRC, deadlineMs: 60000 });
  ok(calls.length === 2 && r2.angles[0].belief === 'Beta' && /ONLY the JSON/.test(calls[1].prompt), 'an unparseable reply gets ONE clean-JSON retry');
  reset(); plan = (i) => { if (i === 0) { skew += 50000; } return 'still not json'; };
  const c3 = await code(W.runAngles({ bc: BC, source: SRC, deadlineMs: 60000 }));
  ok(c3 === 'EMPTY_RESULT' && calls.length === 1, 'opposite: with 10s left the retry is skipped and EMPTY_RESULT thrown (calls=' + calls.length + ')');
  reset(); plan = () => 'x';
  ok(await code(W.runAngles({ bc: BC, source: { kind: 'note', text: '   ' } })) === 'BAD_INPUT' && calls.length === 0, 'an empty source is BAD_INPUT with zero AI calls');
  reset(); plan = () => { throw aiErr(); };
  ok(await code(W.runAngles({ bc: BC, source: SRC })) === 'AI_UNAVAILABLE' && calls.length === 1, 'an AI refusal propagates after one call');
  const four = Object.assign({}, BC, { tones: ['a1', 'b2', 'c3', 'd4'] });
  reset(); plan = () => JSON.stringify({ angles: [{ belief: 'Alpha', why: 'w' }] });
  const r4 = await W.runAngles({ bc: four, source: SRC });
  ok(JSON.stringify(r4.warnings) === '["tones_over_limit"]' && !/a1, b2/.test(calls[0].prompt), 'runAngles: tones > 3 -> none in the prompt + warning');
}

// ═════ 4. runWrite — the happy path ═════
const happy = (i) => [DRAFT + '\nUSED STORIES: s2, s9, [s2]', SPOKEN, SHAPE][i];
{
  reset(); plan = happy;
  const out = await W.runWrite({ bc: BC, source: SRC, angle: ANGLE, provider: 'claude', effort: 'high', deadlineMs: 200000 });
  const I = out.idea;
  ok(calls.length === 3, 'runWrite makes 3 calls (made ' + calls.length + ')');
  ok(/THE BELIEF TO ARGUE/.test(calls[0].prompt) && /Rewrite this script so it sounds like the person SAYING it/.test(calls[1].prompt) && /Do NOT rewrite it/.test(calls[2].prompt), 'calls run in order: draft, spoken pass, shape');
  ok(calls[0].prompt.includes(ANGLE.belief) && calls[0].prompt.includes('ZSRC_MARK') && /about 60 to 160 words: a guide, not a limit/.test(calls[0].prompt), 'draft prompt: the belief, the source, ~60-160 words for talking as guidance');
  ok(/why people believe the opposite, what goes wrong because of it, then the reframe/.test(calls[0].prompt), 'draft prompt: reason -> what goes wrong -> reframe');
  ok(calls[0].prompt.includes('[your story: <what to tell>]') && calls[0].prompt.includes('STYLE GUIDE'), 'draft prompt: slot rule + style guide');
  ok(!/"title"|JSON/.test(calls[0].prompt), 'draft prompt asks for plain text, not JSON');
  ok(/\[s1\] ZSTORY1/.test(calls[0].prompt) && /\[s2\] ZSTORY2/.test(calls[0].prompt) && /never force one in/.test(calls[0].prompt) && /USED STORIES:/.test(calls[0].prompt), 'stories offered with ids, never forced, report line requested');
  ok(/Background facts about the brand/.test(calls[0].prompt) && /Beliefs this brand already holds/.test(calls[0].prompt) && /Voice \/ tones: dry, warm, blunt/.test(calls[0].prompt), 'draft prompt carries the v2 brand block');
  ok(calls[1].prompt.includes(DRAFT) && !calls[1].prompt.includes('USED STORIES: s2'), 'spoken pass rewrites the draft (trailer stripped)');
  ok(calls[1].prompt.includes('ZSPEECH1') && calls[1].prompt.includes('ZSPEECH2') && /HOW THIS PERSON ACTUALLY TALKS/.test(calls[1].prompt), 'spoken pass imitates the speech samples');
  ok(/Do not add any fact/.test(calls[1].prompt) && /Keep every \[your story: \.\.\.\] slot exactly/.test(calls[1].prompt), 'spoken pass: no new facts, keep every slot');
  ok(calls[2].prompt.includes(SPOKEN), 'shape call sees the pass-2 script');
  ok(I.script === SPOKEN, 'the returned script is the pass-2 text');
  ok(I.script !== 'HIJACK SCRIPT' && !('passes' in I), 'the shape reply cannot overwrite the script');
  ok(JSON.stringify(I.storySlots) === JSON.stringify([{ marker: SLOT, ask: 'the day a client called me at midnight' }]), 'storySlots derived from the script ({marker, ask})');
  ok(JSON.stringify(out.usedStories) === '["s2"]' && !I.script.includes('USED STORIES'), 'usedStories = only real ids the draft reported, once each (s9 dropped, s2 not repeated)');
  ok(out.usedSpeechSamples === 2, 'usedSpeechSamples = 2');
  ok(JSON.stringify(I.emphasis) === JSON.stringify(['make each one worth the minute', 'The fix is boring']), 'emphasis = verbatim script phrases only, in the script\'s own spelling (' + JSON.stringify(I.emphasis) + ')');
  ok(I.title === 'Post less, grow faster' && I.hook === 'Everyone tells you to post every day.' && I.caption === 'Posting more is not the fix.' && I.onScreen.length === 2 && I.shots.length === 1, 'shape fields are used when clean');
  ok(I.genFlow === 'v2' && I.format === 'talking' && I.belief === ANGLE.belief, 'idea carries genFlow v2, format and belief');
  // fix7: `hashtags` joins the C-LIB idea keys (derived in the same shape call; see fix7-server.mjs)
  // types: `postType` joins them ('tip' when no type was asked for; see types-server.mjs)
  const keys = ['title', 'hook', 'script', 'storySlots', 'onScreen', 'caption', 'shots', 'format', 'emphasis', 'hashtags', 'belief', 'genFlow', 'postType'];
  ok(keys.every(k => k in I) && Object.keys(I).every(k => keys.includes(k)), 'idea has exactly the C-LIB keys');
  ok(calls[0].opts.provider === 'claude' && calls[0].opts.effort === 'high' && calls[1].opts.provider === 'claude' && calls[1].opts.effort === 'high', 'draft + spoken pass get provider/effort straight through');
  ok(calls[2].opts.provider === 'claude' && calls[2].opts.effort === 'low', 'the shape call keeps the provider and is always cheap (effort low)');
  ok(calls.every(c => c.at + c.opts.deadlineMs <= 200000 + 50), 'every call ends inside the one deadline');
  ok(calls[0].opts.deadlineMs <= 200000 * 0.5 + 1, 'the draft may use at most half the budget (' + calls[0].opts.deadlineMs + ')');
  ok(calls[1].at + calls[1].opts.deadlineMs <= 200000 * 0.85 + 50, 'the spoken pass leaves the shape reserve');
  ok(out.passes.spoken === 'done' && out.passes.shape === 'done', 'passes reported');
  ok(!/possible first line/.test(calls[0].prompt), 'no hookSeed: no first-line suggestion');
  reset(); plan = (i) => [SLOT + '\n' + DRAFT, SPOKEN, 'x'][i];
  const hs = await W.runWrite({ bc: BC, source: SRC, angle: Object.assign({ hookSeed: 'ZHOOKSEED line' }, ANGLE), deadlineMs: 200000 });
  ok(/possible first line[^\n]*ZHOOKSEED line/.test(calls[0].prompt), 'an angle hookSeed reaches the draft as an optional first line');
  reset(); plan = (i) => [SLOT + '\n' + DRAFT, SLOT + '\n' + DRAFT, 'x'][i];
  const sl = await W.runWrite({ bc: BC, source: SRC, angle: ANGLE, deadlineMs: 200000 });
  ok(sl.idea.hook === 'You have been told to post every day.' && !/your story/.test(sl.idea.hook), 'a script opening on a slot: the local hook skips the slot line');
}

// ═════ 5. runWrite — absent memory, formats, rejections, fallbacks ═════
{
  reset(); plan = (i) => [DRAFT, SPOKEN, SHAPE][i];
  const bare = { brandName: 'Bare' };
  const out = await W.runWrite({ bc: bare, source: SRC, angle: ANGLE, deadlineMs: 200000 });
  ok(!/REAL STORIES/.test(calls[0].prompt) && !/USED STORIES/.test(calls[0].prompt) && JSON.stringify(out.usedStories) === '[]', 'no stories: none offered, none reported');
  ok(/HOW SPOKEN SCRIPTS SOUND/.test(calls[1].prompt) && !/HOW THIS PERSON ACTUALLY TALKS/.test(calls[1].prompt) && out.usedSpeechSamples === 0, 'no speech samples: generic spoken rules, usedSpeechSamples 0');
  ok(!/Beliefs this brand/.test(calls[0].prompt) && !/undefined/.test(calls[0].prompt + calls[1].prompt), 'no beliefs: nothing rendered, no "undefined"');
  ok(out.idea.script === SPOKEN, 'bare brand still gets the full pipeline');
  reset(); plan = (i) => [DRAFT, SPOKEN, SHAPE][i];
  await W.runWrite({ bc: Object.assign({}, bare, { stories: [], speechSamples: [], beliefs: [] }), source: SRC, angle: ANGLE, deadlineMs: 200000 });
  ok(calls.length === 3 && !/REAL STORIES/.test(calls[0].prompt), 'empty arrays are fine');
  for (const [fmt, re] of [['micro', /25 to 70 words/], ['statement', /15 to 60 words/], ['carousel', /70 to 220 words/], ['bogus', /60 to 160 words/]]) {
    reset(); plan = (i) => [DRAFT, SPOKEN, SHAPE][i];
    const o = await W.runWrite({ bc: BC, source: SRC, angle: ANGLE, format: fmt, deadlineMs: 200000 });
    ok(re.test(calls[0].prompt) && o.idea.format === (fmt === 'bogus' ? 'talking' : fmt), 'format ' + fmt + ' sets its own length');
  }
  // read formats keep their layout; a carousel's slides are its paragraphs
  const CAR = 'Slide one says the belief.\n\nSlide two: ' + SLOT + '\n\nSlide three is the reframe.';
  const CAR2 = 'I think slide one says it.\n\nSlide two: ' + SLOT + '\n\nAnd slide three is the reframe.';
  reset(); plan = (i) => [CAR, CAR2, SHAPE][i];
  let oc = await W.runWrite({ bc: BC, source: SRC, angle: ANGLE, format: 'carousel', deadlineMs: 200000 });
  ok(/Write ONE carousel post/.test(calls[0].prompt) && !/said out loud/.test(calls[0].prompt) && /HOW IT SHOULD READ|HOW THIS PERSON ACTUALLY TALKS/.test(calls[1].prompt), 'carousel: the draft is a written post, not a spoken script');
  ok(/each paragraph is one slide/.test(calls[1].prompt) && !/SAYING it/.test(calls[1].prompt), 'carousel: pass 2 keeps the written layout (not a spoken rewrite)');
  ok(oc.idea.script === CAR2 && JSON.stringify(oc.idea.onScreen) === JSON.stringify(['I think slide one says it.', 'Slide two: ' + SLOT, 'And slide three is the reframe.']), 'carousel: onScreen = the slides, taken from the script');
  reset(); plan = (i) => [CAR, CAR2.replace(/\n\n/g, ' '), SHAPE][i];
  oc = await W.runWrite({ bc: BC, source: SRC, angle: ANGLE, format: 'carousel', deadlineMs: 200000 });
  ok(oc.idea.script === CAR && oc.passes.spoken === 'rejected_layout_changed', 'carousel: a pass 2 that merged the slides is refused');
  reset(); plan = (i) => [DRAFT, SPOKEN, SHAPE][i];
  const ot = await W.runWrite({ bc: BC, source: SRC, angle: ANGLE, format: 'talking', deadlineMs: 200000 });
  ok(/said out loud/.test(calls[0].prompt), 'opposite: talking drafts a script to be said out loud');
  ok(/SAYING it/.test(calls[1].prompt) && /natural pauses/.test(calls[1].prompt) && JSON.stringify(ot.idea.onScreen) === '["Post less","Make it worth the minute"]', 'opposite: talking gets the spoken rewrite and the shape overlays');
  // spoken pass that changed WHAT is said -> the draft stands
  for (const [label, bad, why] of [['drops the slot', SPOKEN.replace(SLOT, 'a client called'), 'rejected_slots_changed'], ['adds a number', SPOKEN + '\nI did this for 37 clients.', 'rejected_new_number'], ['adds a slot', SPOKEN + ' [your story: another]', 'rejected_slots_changed'], ['is empty', '   ', 'rejected_empty']]) {
    reset(); plan = (i) => [DRAFT, bad, SHAPE][i];
    const o = await W.runWrite({ bc: BC, source: SRC, angle: ANGLE, deadlineMs: 200000 });
    ok(o.idea.script === DRAFT && o.passes.spoken === why && o.usedSpeechSamples === 0, 'spoken pass that ' + label + ' is refused, the draft stands (' + o.passes.spoken + ')');
  }
  reset(); plan = (i) => { if (i === 1) throw new Error('blip'); return [DRAFT, '', SHAPE][i]; };
  let o = await W.runWrite({ bc: BC, source: SRC, angle: ANGLE, deadlineMs: 200000 });
  ok(o.idea.script === DRAFT && o.passes.spoken === 'failed' && calls.length === 3, 'a failed spoken pass keeps the draft and still shapes');
  // deadline: the draft ate the time -> no spoken pass
  reset(); plan = (i) => { if (i === 0) skew += 45000; return [DRAFT, SPOKEN, SHAPE][i]; };
  o = await W.runWrite({ bc: BC, source: SRC, angle: ANGLE, deadlineMs: 60000 });
  ok(calls.length === 2 && /Do NOT rewrite it/.test(calls[1].prompt) && o.idea.script === DRAFT && o.passes.spoken === 'skipped_deadline', 'deadline: no room for pass 2 -> the draft is returned and shaped (calls=' + calls.length + ')');
  ok(calls.every(c => c.at + c.opts.deadlineMs <= 60000 + 50), '...and every call stays inside the deadline');
  // deadline: the spoken pass used its whole budget -> no shape call, local fields
  reset(); plan = (i, op) => { if (i === 1) skew += op.deadlineMs; return [DRAFT, SPOKEN, SHAPE][i]; };
  o = await W.runWrite({ bc: BC, source: SRC, angle: ANGLE, deadlineMs: 40000 });
  ok(calls.length === 2 && o.idea.script === SPOKEN && o.passes.shape === 'skipped_deadline', 'deadline: no room for the shape -> 2 calls, pass-2 script kept');
  ok(o.idea.hook === 'Everyone tells you to post every day.' && o.idea.title && o.idea.title.length <= 60 && JSON.stringify(o.idea.onScreen) === JSON.stringify([o.idea.hook]) && Array.isArray(o.idea.shots) && o.idea.emphasis.length === 0 && o.idea.storySlots.length === 1, 'minimal fields derived locally');
  reset(); plan = (i) => [DRAFT, SPOKEN, 'no json here'][i];
  o = await W.runWrite({ bc: BC, source: SRC, angle: ANGLE, deadlineMs: 200000 });
  ok(o.passes.shape === 'unparsed' && o.idea.script === SPOKEN && o.idea.hook === 'Everyone tells you to post every day.', 'unparseable shape -> local fields');
  reset(); plan = (i) => { if (i === 2) throw aiErr(); return [DRAFT, SPOKEN][i]; };
  o = await W.runWrite({ bc: BC, source: SRC, angle: ANGLE, deadlineMs: 200000 });
  ok(o.passes.shape === 'failed' && o.idea.script === SPOKEN, 'a failed shape call -> local fields, the script survives');
  // invented numbers in shape fields fall back; clean ones are kept
  reset(); plan = (i) => [DRAFT, SPOKEN, JSON.stringify({ hook: 'I saved 500 dollars doing this', title: 'Post less', caption: 'Posting less works. [your story: x]' })][i];
  o = await W.runWrite({ bc: BC, source: SRC, angle: ANGLE, deadlineMs: 200000 });
  ok(o.idea.hook === 'Everyone tells you to post every day.' && o.idea.title === 'Post less' && o.idea.caption === ANGLE.belief, 'a shape field with an invented number or a slot falls back; a clean one is kept');
  // draft failures are the answer
  reset(); plan = () => { throw aiErr(); };
  ok(await code(W.runWrite({ bc: BC, source: SRC, angle: ANGLE })) === 'AI_UNAVAILABLE' && calls.length === 1, 'an AI refusal on the draft propagates after ONE call');
  reset(); plan = () => '```\n\n```';
  ok(await code(W.runWrite({ bc: BC, source: SRC, angle: ANGLE })) === 'EMPTY_RESULT' && calls.length === 1, 'an empty draft is EMPTY_RESULT');
  reset();
  ok(await code(W.runWrite({ bc: BC, source: SRC, angle: { why: 'x' } })) === 'BAD_INPUT' && calls.length === 0, 'no belief is BAD_INPUT with zero calls');
  const four = Object.assign({}, BC, { tones: ['a1', 'b2', 'c3', 'd4'] });
  reset(); plan = (i) => [DRAFT, SPOKEN, SHAPE][i];
  o = await W.runWrite({ bc: four, source: SRC, angle: ANGLE, deadlineMs: 200000 });
  ok(JSON.stringify(o.warnings) === '["tones_over_limit"]' && !/a1, b2/.test(calls[0].prompt + calls[1].prompt), 'runWrite: tones > 3 -> none in either prompt + warning');
  ok(/Voice: dry, warm, blunt/.test((reset(), plan = (i) => [DRAFT, SPOKEN, SHAPE][i], await W.runWrite({ bc: BC, source: SRC, angle: ANGLE, deadlineMs: 200000 }), calls[1].prompt)), 'opposite: 3 tones reach the spoken pass');
}

// ═════ 6. the endpoints ═════
const goodHyd = () => ({ ok: true, bc: Object.assign({}, BC), fields: 8, avoidTitles: [] });
async function hit(h, body) { const res = fakeRes(); await h(post(body), res); return res; }
{
  const ANG_BODY = { brandId: 'b1', bcFields: 8, source: SRC, count: 6, humanEditedTitles: ['t'] };
  reset(); hydrate = goodHyd; guardCostMs = 5000; plan = () => JSON.stringify({ angles: [{ belief: 'Alpha', why: 'w' }, { belief: 'Beta', why: 'w' }] });
  let r = await hit(anglesH, ANG_BODY);
  ok(r.statusCode === 200 && Array.isArray(r.body.angles) && r.body.angles.length === 2 && r.body.flow === 'v2' && Array.isArray(r.body.warnings), 'angles 200 {angles, flow:v2, warnings}');
  ok(guardCalls.length === 1 && guardCalls[0].action === 'angles' && guardCalls[0].hasRes, "angles is gated as 'angles' with res (hold release)");
  ok(hydCalls.length === 1 && hydCalls[0].id === 'b1' && hydCalls[0].opts.userId === 'u1' && JSON.stringify(hydCalls[0].opts.humanEdited) === '["t"]', 'angles hydrates the brand by brandId like remix');
  ok(usageLogs.length === 1 && usageLogs[0].action === 'angles' && usageLogs[0].brandId === 'b1' && usageLogs[0].userId === 'bill-1', 'angles logs usage ONCE on success, to the billing user and the brand');
  ok(calls[0].opts.deadlineMs <= 90000 - 5000 + 50, 'angles budget is measured from handler start (' + calls[0].opts.deadlineMs + ')');
  const WR_BODY = { brandId: 'b1', bcFields: 8, source: SRC, angle: ANGLE };
  reset(); hydrate = goodHyd; guardCostMs = 5000; plan = (i) => [DRAFT, SPOKEN, SHAPE][i];
  r = await hit(writeH, WR_BODY);
  ok(r.statusCode === 200 && r.body.idea && r.body.idea.script === SPOKEN && r.body.flow === 'v2' && Array.isArray(r.body.usedStories) && typeof r.body.usedSpeechSamples === 'number', 'write 200 returns the runWrite result');
  ok(guardCalls[0].action === 'write' && guardCalls[0].hasRes && usageLogs.length === 1 && usageLogs[0].action === 'write', "write is gated and logged as 'write', once");
  ok(calls.length === 3 && calls[0].opts.deadlineMs <= (270000 - 5000) * 0.5 + 50, 'write budget is measured from handler start');
  // failures: 503, 424, 400, 402, 401, 502 — never logged
  for (const [label, h, body, setup, want] of [
    ['angles AI refused', anglesH, ANG_BODY, () => { plan = () => { throw aiErr(); }; }, 503],
    ['write AI refused', writeH, WR_BODY, () => { plan = () => { throw aiErr(); }; }, 503],
    ['angles brand read failed', anglesH, ANG_BODY, () => { hydrate = () => ({ ok: false, reason: 'db_error' }); }, 424],
    ['write brand read failed', writeH, WR_BODY, () => { hydrate = () => ({ ok: false, reason: 'db_error' }); }, 424],
    ['angles thin brand row', anglesH, ANG_BODY, () => { hydrate = () => ({ ok: true, bc: {}, fields: 1 }); }, 424],
    ['write thin brand row', writeH, WR_BODY, () => { hydrate = () => ({ ok: true, bc: {}, fields: 1 }); }, 424],
    ['angles no source', anglesH, { brandId: 'b1', source: { kind: 'note', text: '' } }, () => {}, 400],
    ['angles no brand', anglesH, { source: SRC }, () => {}, 400],
    ['write no angle', writeH, { brandId: 'b1', source: SRC }, () => {}, 400],
    ['write no source', writeH, { brandId: 'b1', angle: ANGLE }, () => {}, 400],
    ['write bad format', writeH, Object.assign({}, WR_BODY, { format: 'essay' }), () => {}, 400],
    ['angles over limit', anglesH, ANG_BODY, () => { guardMode = 'over'; }, 402],
    ['write signed out', writeH, WR_BODY, () => { guardMode = 'nouser'; }, 401],
    ['angles empty reply', anglesH, ANG_BODY, () => { plan = () => 'nothing'; }, 502],
    ['write empty draft', writeH, WR_BODY, () => { plan = () => ''; }, 502],
  ]) {
    reset(); hydrate = goodHyd; plan = () => JSON.stringify({ angles: [{ belief: 'Alpha', why: 'w' }] }); setup();
    const rr = await hit(h, body);
    ok(rr.statusCode === want, label + ': status ' + want + ' (got ' + rr.statusCode + ' ' + JSON.stringify(rr.body).slice(0, 120) + ')');
    ok(usageLogs.length === 0, label + ': no usage logged on failure');
    if (want === 503) ok(rr.body && rr.body.code === 'AI_UNAVAILABLE', label + ': body code AI_UNAVAILABLE');
    if (want === 424) ok(rr.body && rr.body.error === 'brand_context_unavailable' && calls.length === 0, label + ': brand_context_unavailable before any AI call');
    if (want === 400) ok(calls.length === 0 && hydCalls.length === 0, label + ': bad input is refused before the brand read and any AI call');
  }
  reset(); hydrate = () => ({ ok: true, bc: Object.assign({}, BC), fields: 1 }); plan = () => JSON.stringify({ angles: [{ belief: 'Alpha', why: 'w' }] });
  r = await hit(anglesH, Object.assign({}, ANG_BODY, { bcFields: 2 }));
  ok(r.statusCode === 200 && usageLogs.length === 1, 'opposite: a small device count (bcFields 2) is not "thin"');
  reset(); plan = (i) => [DRAFT, SPOKEN, SHAPE][i];
  r = await hit(writeH, { brandContext: Object.assign({}, BC, { tones: ['a', 'b', 'c', 'd'] }), source: SRC, angle: ANGLE, format: 'micro' });
  ok(r.statusCode === 200 && hydCalls.length === 0 && JSON.stringify(r.body.warnings) === '["tones_over_limit"]' && r.body.idea.format === 'micro', 'write without brandId uses the sent brandContext and returns warnings:[tones_over_limit]');
}

// ═════ 7. weights ═════
ok(realUsage.ACTION_CREDITS.angles > 0 && realUsage.ACTION_COST.angles > 0 && realUsage.ACTION_CREDITS.write > 0 && realUsage.ACTION_COST.write > 0, "'angles' and 'write' are priced in both weight maps");
ok(realUsage.ACTION_COST.write > realUsage.ACTION_COST.angles && realUsage.ACTION_CREDITS.write >= realUsage.ACTION_CREDITS.angles, 'write (three calls) costs more than angles (one call)');

// ═════ 8. the baseline arm ═════
{
  ok(typeof remix === 'function' && typeof remix._legacyRemix === 'function', 'remix.js still exports the handler AND _legacyRemix');
  const OLD = JSON.stringify({ originalSummary: 'o', remixTitle: 't', remixHook: 'h', remixScript: ['line 1', 'line 2'], remixFormat: 'video', remixCaption: 'c', remixHashtags: '#a', whyItWorks: 'w' });
  reset(); plan = () => OLD;
  const L = await remix._legacyRemix({ bc: BC, source: SRC, provider: 'claude', effort: 'high', deadlineMs: 100000 });
  ok(L.remixTitle === 't' && L.remixScript === 'line 1\nline 2' && L.originalSummary === 'o' && L.whyItWorks === 'w', '_legacyRemix returns the old fields, normalized to strings');
  ok(calls.length === 1 && /ORIGINAL CONTENT TO REMIX/.test(calls[0].prompt) && /REMIX MODE: REMIX/.test(calls[0].prompt) && calls[0].prompt.includes('ZSRC_MARK'), '_legacyRemix sends the old remix prompt');
  ok(calls[0].opts.provider === 'claude' && calls[0].opts.effort === 'high' && calls[0].opts.deadlineMs <= 100000, '_legacyRemix passes provider/effort/deadline');
  const legacyPrompt = calls[0].prompt;
  reset(); plan = () => OLD;
  const rr = await hit(remix, { postDescription: SRC.text, creatorName: SRC.creator, platform: SRC.platform, remixMode: 'remix', brandContext: BC });
  ok(rr.statusCode === 200 && rr.body.remix && rr.body.remix.remixTitle === 't', 'the Remix HTTP endpoint is still backward compatible');
  ok(calls[0].prompt === legacyPrompt, 'the baseline arm sends byte-for-byte what the old endpoint sends');
  ok(!('provider' in calls[0].opts) && !('effort' in calls[0].opts), 'opposite: the HTTP handler adds no provider/effort');
  reset(); plan = () => 'not json';
  ok(await code(remix._legacyRemix({ bc: BC, source: SRC, deadlineMs: 100000 })) === 'PARSE_FAILED', '_legacyRemix: unparseable twice -> PARSE_FAILED');
  reset();
  ok(await code(remix._legacyRemix({ bc: BC, source: { text: '' } })) === 'BAD_INPUT' && calls.length === 0, '_legacyRemix: nothing to remix -> BAD_INPUT');
}

clearTimeout(WALL);
if (failed) { console.log('rv2-write-1: ' + failed + ' failed, ' + passed + ' passed'); process.exit(1); }
console.log('PIPELINE OK — ' + passed + ' checks: angles, 3-pass write, style guide, v2 brand block, endpoints, baseline arm');
process.exit(0);
