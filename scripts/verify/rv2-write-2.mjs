#!/usr/bin/env node
// GATE rv2-write-2 — the content-v2 FACT GUARD, executed (v693 r2).
//
// An independent attack on the pipeline showed "never invent facts" was only a request: a draft
// with "$200 a month… my client Sarah Jones… 15,000 dollar lab bill" shipped as the script, and a
// spoken pass could add "two hundred dollars", "2 million", "Anna", or a whole anecdote next to a
// slot. This gate runs the REAL api/_write.js, api/angles.js and api/write.js (callLLM, usage and
// brand reads stubbed, zero network, fake clock) and proves, each with its opposite:
//   1  the guard itself: what it catches and what it deliberately allows (brand facts, source
//      numbers, story names, platforms, days, ordinary capitals, Title Case)
//   2  the draft is checked: one corrective retry, then invented sentences become story slots
//   3  the spoken pass cannot add numbers, money, names, or a sentence next to a slot
//   4  slot-looking text in any spelling never reaches hook/title/caption/onScreen/shots
//   5  truncated replies are never shipped as finished text
//   6  usage is attributed only to the brand loadBrandContext authorised
// RUN:    node scripts/verify/rv2-write-2.mjs
// EXPECT: prints "FACT GUARD OK" and exits 0.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const Module = require_('module');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = path.join(ROOT, 'api');
const WALL = setTimeout(() => { console.log('FAIL: rv2-write-2 wall clock (60s) — something hung'); process.exit(1); }, 60000);
let failed = 0, passed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.log('FAIL: ' + m); } };

const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
function stub(rel, exports) {
  const file = require_.resolve(path.join(API, rel));
  const m = new Module(file); m.filename = file; m.loaded = true; m.exports = exports; require_.cache[file] = m;
}
let calls = [], plan = () => '', headDepth = 0, claudeOn = false;
stub('_llm.js', {
  callLLM: async (opts) => { const i = calls.length; calls.push({ opts, inHead: headDepth > 0, prompt: (opts.messages || []).map(m => m.content).join('\n') }); return plan(i, opts); },
  withThinkingHeadroom: async (fn) => { headDepth++; try { return await fn(); } finally { headDepth--; } },
  claudeConfigured: () => claudeOn,
  aiUnavailable: (e) => (e && e.code === 'AI_UNAVAILABLE') ? { status: 503, body: { error: 'paused', code: 'AI_UNAVAILABLE' } } : null,
  callGrokSearch: async () => null,
});
let usageLogs = [], accessChecks = 0;
stub('_usage.js', {
  guard: async () => ({ user: { id: 'u1' }, over: false, billingUserId: 'bill-1' }),
  checkLimit: async () => ({ ok: true }), creditsFor: () => 1, billingUserFor: async (u) => u, attachHoldRelease: () => {},
  denyResponse: (res) => res.status(402).json({ error: 'limit_reached' }),
  logUsage: async (evt) => { usageLogs.push(evt); },
});
let hydrate = () => ({ ok: true, bc: {}, fields: 8 });
stub('_brandctx.js', { loadBrandContext: async (id) => hydrate(id) });
let accessMode = 'yes';
stub('_publish/store.js', { userCanAccessBrand: async () => { accessChecks++; if (accessMode === 'throw') throw new Error('PostgREST stalled'); return accessMode === 'yes'; } });
stub('_requireUser.js', async () => ({ id: 'u1' }));

const W = require_(path.join(API, '_write.js'));
const I = W._internals;
const anglesH = require_(path.join(API, 'angles.js'));
const writeH = require_(path.join(API, 'write.js'));
const reset = () => { calls = []; usageLogs = []; accessChecks = 0; skew = 0; };
const code = async (p) => { try { await p; return 'resolved'; } catch (e) { return e.code || e.message; } };
const fakeRes = () => ({ statusCode: 0, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } });
const hit = async (h, body) => { const res = fakeRes(); await h({ method: 'POST', headers: {}, body }, res); return res; };

const BC = {
  brandName: 'Acme Hydration', tones: ['dry'], usps: 'Acme makes a 3-ingredient powder sold at 29 euros a tub. Founded by Maria Tamm in Tallinn.',
  stories: [{ id: 's1', text: 'My friend Kristjan ran 12 marathons on water alone.' }],
};
const SRC = { kind: 'remix', text: 'A creator says 70% of office workers are dehydrated and spend 40 dollars a month on drinks.' };
const ANGLE = { belief: 'Electrolytes are overrated for desk workers', why: 'Ads say everyone needs them' };
const SLOT = '[your story: a day water was enough]';
const CLEAN = 'Most people at a desk do not need electrolytes. ' + SLOT + ' So drink water first and see how you feel. The ads will tell you otherwise.';
const SPOKEN = 'Most people at a desk don\'t need electrolytes.\n' + SLOT + '\nSo drink water first... and see how you feel.\nThe ads will tell you otherwise.';
const SHAPE = JSON.stringify({ title: 'Water first', hook: 'Most people at a desk don\'t need electrolytes.', caption: 'Drink water first.', onScreen: ['Water first'], shots: ['At a desk'] });
const run = (p, extra) => { reset(); plan = p; return W.runWrite(Object.assign({ bc: BC, source: SRC, angle: ANGLE, deadlineMs: 200000 }, extra || {})); };

// ═════ 1. the guard ═════
{
  const allowed = I.allowedMaterial(BC, I.normSource(SRC), I.normAngle(ANGLE), I.normStories(BC.stories));
  const caught = [
    ['I spent $200 a month until my client Sarah Jones showed me her 15,000 dollar lab bill.', ['200', '15000', 'Sarah', 'Jones']],
    ['It costs £9 or ninety-nine bucks.', ['9', 'money:pound', '99']],
    ['My client Anna saved two hundred dollars a month and fifteen thousand over five years.', ['200', '15000', 'Anna']],
    ['I tried 2 million brands, 2x the price.', ['2000000', '2x']],
    ['Our customer Dr. Mark Lee cut costs by half in thirty days.', ['50%', 'Lee']],
    ['Harvard study proves it', ['Harvard']],
    ['Twelve thousand people agree', ['12000']],
    ['Dozens of clients doubled their sales.', ['q:dozen', '2x']],
    ['It costs 5k and 12% of people quit.', ['5000', '12%']],
    ['Last Tuesday my coworker Jim fainted.', ['Jim']],
    ['My friend Anna\'s results were great.', ['Anna']],
    ['Ask Dr. Lee.', ['Dr. Lee']],
  ];
  for (const [t, want] of caught) {
    const got = I.inventedFacts(t, allowed);
    ok(want.every(w => got.includes(w)), 'guard catches ' + JSON.stringify(want) + ' in "' + t + '" (got ' + JSON.stringify(got) + ')');
  }
  const allowedOk = [
    'Acme makes a 3-ingredient powder for 29 euros.',          // the brand's own facts
    'Maria Tamm started it in Tallinn.',                        // names from the brand facts
    'About 70% of office workers are dehydrated, and they spend 40 dollars a month.', // the source
    'My friend Kristjan ran 12 marathons on water alone.',     // a story from the bank
    'Hydration matters. Most people skip water. Everyone tells you to buy powder.', // ordinary capitals
    'Post it on TikTok every Monday.',                           // platforms and days
    'One video a week is enough.',                               // "one" alone
    'Why Most Desk Workers Skip Water',                          // Title Case headline
    'Electrolytes are overrated for desk workers.',             // the belief
  ];
  for (const t of allowedOk) {
    const got = I.inventedFacts(t, allowed);
    ok(got.length === 0, 'opposite: guard allows "' + t + '" (flagged ' + JSON.stringify(got) + ')');
  }
  // v693 r3 — less trigger-happy: everyday rhetoric is not a fact; claims still are.
  const RELAXED = ['Three steps fix it.', 'Ask two questions.', 'One supplier is enough.', 'Give it two minutes.', 'Wait a week.', 'The first 30 seconds decide it.',
    'It took 2.5 hours.', 'First, second, third.', 'A few people, many people, most people.', 'I said it twice.', 'Ask three clients.', 'I post 7 videos.', 'Twelve posts later.'];
  for (const t of RELAXED) { const got = I.inventedFacts(t, 'nothing'); ok(got.length === 0, 'relaxed: "' + t + '" is rhetoric, not a claim (flagged ' + JSON.stringify(got) + ')'); }
  const STRICT = [['It costs $5.', '5'], ['12% quit.', '12%'], ['fifty percent quit.', '50%'], ['3x faster.', '3x'], ['Twice as fast.', '2x'], ['Three times the price.', '3x'],
    ['Sales doubled.', '2x'], ['3 clients asked me.', '3'], ['250 clients.', '250'], ['I lost 5 kg.', '5'], ['7 followers.', '7'], ['10,000 views.', '10000'], ['In 2019 it changed.', '2019'],
    ['Fifteen thousand people.', '15000'], ['A 2.5 rating.', '2.5'], ['After 90 days.', '90'], ['5k people.', '5000']];
  for (const [t, want] of STRICT) { const got = I.inventedFacts(t, 'nothing'); ok(got.includes(want), 'strict: "' + t + '" is still a claim (' + want + '; got ' + JSON.stringify(got) + ')'); }
  ok(I.inventedFacts('I tried 2 brands.', 'I tried 2 brands.').length === 0 && I.inventedFacts('I tried 2 million brands.', 'I tried 2 brands.').length === 1, 'a multiplier on an existing number is a new number; the number itself is not');
  const sl = I.slotifyInvented('I paid $200 for it [your story: x] and it failed. Water works.', '');
  ok(sl.includes('[your story: x]') && !I.inventedFacts(sl, '').length && sl.endsWith('Water works.') && /your real version of "I paid \$200 for it and it failed\."/.test(sl), 'slotting a sentence keeps a slot that was inside it (' + sl + ')');
  ok(I.inventedFacts('One video a week is enough. Nobody told me that. Everyone says so.', 'nothing here').length === 0, '"one" on its own and ordinary openers are never facts, whatever the material');
  ok(I.inventedFacts('fifteen people', 'we had 15 people').length === 0, 'a spelled number equal to an allowed digit is allowed');
}

// ═════ 2. the draft is checked ═════
{
  const BAD = 'Most people at a desk do not need electrolytes. I spent $200 a month until my client Sarah Jones showed me her 15,000 dollar lab bill. ' + SLOT + ' So drink water first.';
  let o = await run((i) => [BAD, CLEAN, SPOKEN, SHAPE][i]);
  ok(calls.length === 4 && /CORRECTION/.test(calls[1].prompt) && /"200"/.test(calls[1].prompt) && /"Sarah"/.test(calls[1].prompt) && calls[1].prompt.includes(BAD), 'an inventing draft gets ONE retry naming the invented facts and quoting the draft');
  ok(o.idea.script === SPOKEN && o.passes.draft === 'retried_facts' && JSON.stringify(o.passes.inventedRemoved) === '[]', 'a clean retry is used');
  o = await run((i) => [BAD, BAD, BAD.replace(/\. /g, '.\n'), SHAPE][i]);
  const s = o.idea.script;
  const outside = s.replace(/\[your story:[^\]]*\]/g, ' ');
  ok(!/200|15,000|Sarah|Jones|dollar/.test(outside), 'a retry that still invents: the invented sentence never ships outside a slot (' + s.slice(0, 160) + ')');
  ok(o.passes.draft === 'retried_then_slotted' && o.idea.storySlots.length === 2 && s.includes(SLOT) && /\[your story: your real version of "I spent \$200 a month until my client Sarah Jones/.test(s), 'it becomes a story slot; the original slot survives');
  ok(s.startsWith('Most people at a desk') && /So drink water first/.test(s), 'the clean sentences around it are untouched');
  ok(!/200|Sarah|15,000/.test(o.idea.hook + o.idea.title + o.idea.caption + o.idea.onScreen.join(' ')), 'nothing invented reaches hook/title/caption/onScreen');
  o = await run((i) => { if (i === 0) skew += 160000; return [BAD, SPOKEN, SHAPE][i]; });
  ok(calls.length === 2 && o.passes.draft === 'slotted' && !/Sarah|200/.test(o.idea.script.replace(/\[your story:[^\]]*\]/g, ' ')), 'no time for a retry: slotted straight away');
  o = await run((i) => { if (i === 1 || i === 2) throw new Error('blip'); return [BAD, null, null, SPOKEN, SHAPE][i]; });
  ok(!/Sarah|200/.test(o.idea.script.replace(/\[your story:[^\]]*\]/g, ' ')) && o.passes.draft === 'retried_then_slotted', 'a failed retry: the first draft is slotted, never shipped');
  const OWN = 'Acme makes a 3-ingredient powder at 29 euros a tub, and Maria Tamm started it. ' + SLOT + ' My friend Kristjan ran 12 marathons on water alone. About 70% of office workers are dehydrated.';
  o = await run((i) => [OWN, OWN, SHAPE][i]);
  ok(calls.length === 3 && !/CORRECTION/.test(calls.map(c => c.prompt).join('')) && o.idea.script === OWN && o.passes.draft === 'done' && o.passes.inventedRemoved.length === 0, 'opposite: brand facts, source numbers and story names pass with no retry');
}

// ═════ 2b. angles cannot smuggle facts in ═════
{
  reset(); plan = () => JSON.stringify({ angles: [
    { belief: '73% of desk workers waste money on powders', why: 'ads' },
    { belief: 'Water is enough for most desk days', why: 'Dr. Mark Lee says so' },
    { belief: 'Most people drink too little water', why: 'about 70% of office workers are dehydrated', hookSeed: 'I saved 300 dollars.' },
    { belief: 'Acme started in Tallinn for a reason', why: 'Maria Tamm hated sugar', hookSeed: 'Plain water first.' },
  ] });
  const r = await W.runAngles({ bc: BC, source: SRC, deadlineMs: 60000 });
  const B = r.angles.map(a => a.belief);
  ok(calls.length === 1 && r.angles.length === 3 && !B.some(b => /73%/.test(b)), 'only an angle whose BELIEF invents a fact is dropped (' + JSON.stringify(B) + ')');
  ok(r.angles[0].belief === 'Water is enough for most desk days' && r.angles[0].why === '', 'an inventing why loses its sentence, the belief stays');
  ok(r.angles[1].belief === 'Most people drink too little water' && !('hookSeed' in r.angles[1]) && /70%/.test(r.angles[1].why), 'an inventing hookSeed is removed; a source number in why stays');
  ok(r.angles[2].hookSeed === 'Plain water first.' && /Maria Tamm/.test(r.angles[2].why), 'opposite: brand names and a clean hookSeed stay');
  // fewer than 3 survivors -> ONE re-ask naming the rejected beliefs, merged in
  reset(); plan = (i) => i === 0 ? JSON.stringify({ angles: [
    { belief: '9 out of 10 desk workers overbuy', why: 'w' }, { belief: 'Harvard found powders useless', why: 'w' },
    { belief: 'Our 7 stockists all say the same', why: 'w' }, { belief: 'Plain water beats powder at a desk', why: 'w' },
  ] }) : JSON.stringify({ angles: [{ belief: 'Thirst is a bad timer at a desk', why: 'w' }, { belief: 'Salt tabs are for sweat, not spreadsheets', why: 'w' }, { belief: 'Plain water beats powder at a desk', why: 'dup' }] });
  const r2 = await W.runAngles({ bc: BC, source: SRC, deadlineMs: 60000 });
  ok(calls.length === 2 && /were rejected/.test(calls[1].prompt) && /Harvard found/.test(calls[1].prompt), 'under 3 survivors: one re-ask that names the rejected beliefs');
  ok(r2.angles.length === 3 && r2.angles[0].belief === 'Plain water beats powder at a desk' && r2.angles.some(a => /Thirst/.test(a.belief)), 'the re-ask is merged in, duplicates dropped (' + JSON.stringify(r2.angles.map(a => a.belief)) + ')');
  reset(); plan = () => JSON.stringify({ angles: [{ belief: 'Alpha', why: 'w' }, { belief: 'Beta', why: 'w' }, { belief: 'Gamma', why: 'w' }] });
  await W.runAngles({ bc: BC, source: SRC, deadlineMs: 60000 });
  ok(calls.length === 1, 'opposite: 3 clean survivors need no re-ask');
  reset(); plan = (i) => i === 0 ? JSON.stringify({ angles: [{ belief: 'Alpha one', why: 'w' }, { belief: 'Harvard found it', why: 'w' }] })
    : JSON.stringify({ angles: ['Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'].map(b => ({ belief: b + ' belief', why: 'w' })) });
  const r3 = await W.runAngles({ bc: BC, source: SRC, count: 5, deadlineMs: 60000 });
  ok(calls.length === 2 && r3.angles.length === 5, 'the merged re-ask never returns more than count (' + r3.angles.length + ')');
}

// ═════ 3. the spoken pass ═════
{
  for (const [label, spoken, why] of [
    ['adds spelled numbers and a name', CLEAN + ' My client Anna saved two hundred dollars a month.', 'rejected_new_number'],
    ['adds a name only', CLEAN.replace('The ads will', 'Ask my neighbour Anna, the ads will'), 'rejected_new_name'],
    ['inflates a number', 'I tried 3 million brands. ' + CLEAN, 'rejected_new_number'],
    ['multiplies a number', 'I tried 3 brands, 3x the price. ' + CLEAN, 'rejected_new_number'],
    ['adds an anecdote next to the slot', CLEAN.replace(SLOT, SLOT + ' Last week my coworker fainted at the office.'), 'rejected_slot_adjacent'],
  ]) {
    const d = /plies a number|inflates/.test(label) ? 'I tried 3 brands, the price. ' + CLEAN : CLEAN;
    const o = await run((i) => [d, spoken, SHAPE][i]);
    ok(o.passes.spoken === why && o.idea.script === d, 'spoken pass that ' + label + ' is refused (' + o.passes.spoken + '), the draft stands');
  }
  const o = await run((i) => [CLEAN, SPOKEN, SHAPE][i]);
  ok(o.passes.spoken === 'done' && o.idea.script === SPOKEN, 'opposite: a reworded spoken pass is accepted');
}

// ═════ 4. slot-looking text in any spelling ═════
{
  const o = await run((i) => [CLEAN, SPOKEN, JSON.stringify({ title: '[Your  Story: x]', hook: '[ your story: y ]', caption: 'your story: z', onScreen: ['[YOUR STORY: z]', '［your story: fullwidth］', 'Water first'], shots: ['［your story: shot］', 'At a desk'] })][i]);
  const fields = [o.idea.title, o.idea.hook, o.idea.caption].concat(o.idea.onScreen, o.idea.shots).join(' | ');
  ok(!/your\s+story/i.test(fields), 'no slot in any spelling reaches title/hook/caption/onScreen/shots (' + fields + ')');
  ok(JSON.stringify(o.idea.onScreen) === '["Water first"]' && JSON.stringify(o.idea.shots) === '["At a desk"]', 'opposite: the clean items are kept');
  ok(I.slotsOf('A [YOUR STORY: the first client] b [Your  story:  second ] c').length === 2, 'slot detection is case- and spacing-insensitive');
  const d = 'Most people at a desk do not need electrolytes. [Your Story: a day water was enough] So drink water.';
  const o2 = await run((i) => [d, 'Most people at a desk don\'t need electrolytes.\n[YOUR STORY: a day water was enough]\nSo drink water.', SHAPE][i]);
  ok(o2.passes.spoken === 'done' && JSON.stringify(o2.idea.storySlots) === JSON.stringify([{ marker: SLOT, ask: 'a day water was enough' }]) && o2.idea.script.includes(SLOT), 'an odd-case slot is normalised to the contract spelling and survives both passes');
  const o3 = await run((i) => [d, 'Most people at a desk don\'t need electrolytes.\nSo drink water.', SHAPE][i]);
  ok(o3.passes.spoken === 'rejected_slots_changed', 'opposite: dropping an odd-case slot is still caught');
  const o4 = await run((i) => [CLEAN.replace(SLOT, '［your story: a day water was enough］'), SPOKEN, SHAPE][i]);
  ok(o4.idea.storySlots.length === 1 && o4.idea.script === SPOKEN, 'a full-width slot counts as a slot');
}

// ═════ 5. truncated replies ═════
{
  const T = (text) => ({ text, truncated: true }), F = (text) => ({ text, truncated: false });
  let o = await run((i) => [T('Most people at a desk do not'), F(CLEAN), F(SPOKEN), SHAPE][i]);
  ok(calls.length === 4 && calls[1].opts.max_tokens > calls[0].opts.max_tokens && o.passes.draft === 'retried_truncated' && o.idea.script === SPOKEN, 'a cut-off draft is retried once with more room');
  ok(calls[0].opts.wantMeta === true && calls[2].opts.wantMeta === true, 'draft and spoken pass ask callLLM for the truncation flag');
  reset(); plan = (i) => [T('Most'), T('Most people')][i];
  ok(await code(W.runWrite({ bc: BC, source: SRC, angle: ANGLE, deadlineMs: 200000 })) === 'TRUNCATED' && calls.length === 2, 'cut off twice: TRUNCATED, never shipped');
  reset(); plan = (i) => { skew += 160000; return T('Most'); };
  ok(await code(W.runWrite({ bc: BC, source: SRC, angle: ANGLE, deadlineMs: 200000 })) === 'TRUNCATED' && calls.length === 1, 'cut off with no time to retry: TRUNCATED after one call');
  o = await run((i) => [F(CLEAN), T(SPOKEN), SHAPE][i]);
  ok(o.passes.spoken === 'rejected_truncated' && o.idea.script === CLEAN, 'a cut-off spoken pass is refused; the draft stands');
  o = await run((i) => [F(CLEAN), F(SPOKEN), SHAPE][i]);
  ok(o.passes.draft === 'done' && o.passes.spoken === 'done' && o.idea.script === SPOKEN, 'opposite: {truncated:false} replies are used as-is');
  reset(); hydrate = () => ({ ok: true, bc: Object.assign({}, BC), fields: 8 }); plan = (i) => [T('Most'), T('Most people')][i];
  const r = await hit(writeH, { brandId: 'b1', source: SRC, angle: ANGLE });
  ok(r.statusCode === 502 && /cut off/.test(r.body.error) && usageLogs.length === 0, 'the endpoint answers a cut-off write with 502 and charges nothing');
}

// ═════ 6. usage attribution ═════
{
  hydrate = () => ({ ok: true, bc: Object.assign({}, BC), fields: 8 });
  const A = JSON.stringify({ angles: [{ belief: 'Alpha', why: 'w' }] });
  reset(); plan = () => A;
  let r = await hit(anglesH, { brandContext: Object.assign({ brandId: 'someone-elses-brand', brand_id: 'x2' }, BC), source: SRC });
  ok(r.statusCode === 200 && usageLogs.length === 1 && usageLogs[0].brandId === null, 'angles never attributes usage to an unchecked brandContext.brandId');
  reset(); plan = (i) => [CLEAN, SPOKEN, SHAPE][i];
  r = await hit(writeH, { brandContext: Object.assign({ brandId: 'someone-elses-brand' }, BC), source: SRC, angle: ANGLE });
  ok(r.statusCode === 200 && usageLogs.length === 1 && usageLogs[0].brandId === null, 'write never attributes usage to an unchecked brandContext.brandId');
  reset(); plan = () => A;
  r = await hit(anglesH, { brandId: 'b1', source: SRC });
  ok(r.statusCode === 200 && usageLogs[0].brandId === 'b1' && accessChecks === 0, 'opposite: the brand loadBrandContext authorised is attributed, with no second access read after the AI work');
  reset(); plan = (i) => [CLEAN, SPOKEN, SHAPE][i];
  r = await hit(writeH, { brandId: 'b1', source: SRC, angle: ANGLE });
  ok(r.statusCode === 200 && usageLogs[0].brandId === 'b1' && accessChecks === 0, 'write: same');
}

// ═════ 7. depth with headroom, the provider switch, room to write (v693 r3) ═════
{
  const env = (k, v) => { if (v == null) delete process.env[k]; else process.env[k] = v; };
  let o = await run((i) => [CLEAN, SPOKEN, SHAPE][i], { angle: ANGLE });
  ok(calls[0].opts.effort === 'medium' && calls[1].opts.effort === 'medium' && calls[2].opts.effort === 'low', 'production defaults: draft medium, spoken medium, shape low (' + calls.map(c => c.opts.effort).join() + ')');
  ok(calls.every(c => c.inHead), 'every pipeline call runs inside the thinking headroom');
  ok(calls.every(c => c.opts.provider === 'grok'), 'default provider is Grok');
  ok(calls[0].opts.max_tokens >= 3000 && calls[1].opts.max_tokens >= 3000, 'draft and spoken pass have room to write (>= 3000 tokens)');
  reset(); plan = () => JSON.stringify({ angles: [{ belief: 'Alpha', why: 'w' }] });
  await W.runAngles({ bc: BC, source: SRC });
  ok(calls[0].opts.effort === 'medium' && calls[0].inHead && calls[0].opts.max_tokens >= 4000, 'angles: medium, with headroom, >= 4000 tokens');
  env('WRITER_EFFORT_DRAFT', 'medium'); env('WRITER_EFFORT_SPOKEN', 'low');
  o = await run((i) => [CLEAN, SPOKEN, SHAPE][i]);
  ok(calls[0].opts.effort === 'medium' && calls[1].opts.effort === 'low', 'WRITER_EFFORT_DRAFT / _SPOKEN move the levels without a deploy');
  env('WRITER_EFFORT_DRAFT', 'turbo');
  o = await run((i) => [CLEAN, SPOKEN, SHAPE][i]);
  ok(calls[0].opts.effort === 'medium', 'an invalid level falls back to the default');
  env('WRITER_EFFORT_DRAFT', null); env('WRITER_EFFORT_SPOKEN', null);
  env('WRITER_PROVIDER', 'claude'); claudeOn = false;
  o = await run((i) => [CLEAN, SPOKEN, SHAPE][i]);
  ok(o.idea.script === SPOKEN && calls.every(c => c.opts.provider === 'grok'), 'WRITER_PROVIDER=claude without Claude configured: Grok, and the request still succeeds');
  claudeOn = true;
  o = await run((i) => [CLEAN, SPOKEN, SHAPE][i]);
  ok(calls.every(c => c.opts.provider === 'claude'), 'WRITER_PROVIDER=claude with Claude configured: every pipeline call goes to Claude');
  o = await run((i) => [CLEAN, SPOKEN, SHAPE][i], { provider: 'grok', effort: 'high' });
  ok(calls.every(c => c.opts.provider === 'grok') && calls[1].opts.effort === 'high', 'opposite: an explicit caller choice (the blind test) beats the env');
  // the other writers
  const bcw = Object.assign({}, BC);
  const WR = [
    ['generate-ideas', { brandContext: bcw, count: 1 }, '[{"title":"t","hook":"h","script":"s","format":"video"}]', 'medium'],
    ['viral-rewrite', { idea: { title: 'why water' }, angle: { angle: 'myth', hook: 'It is not salt' }, brandContext: bcw }, '{"title":"t","hook":"h","script":"s"}', 'medium'],
    ['viral-twist', { idea: { title: 'why water' }, brandContext: bcw }, '{"angles":[{"angle":"a","hook":"h","why":"w"}],"tip":"t"}', 'medium'],
    ['viral-analyze', { content: 'transcript: why water works', brandContext: bcw }, '{"hook":"h","ideas":[],"takeaway":"t"}', 'medium'],
    ['sharpen', { content: { hook: 'Water tips', script: 'Drink water first.' }, kind: 'idea', format: 'video', brandContext: bcw }, 'STRONG', 'medium'],
    ['expand-field', { fieldName: 'brandVocab', currentValue: 'water first', brandContext: bcw }, 'water first, plain water', undefined],
    ['settings-examples', { brandContext: bcw }, '{"usps":["a"]}', undefined],
    ['brand-voice-chat', { messages: [{ role: 'user', content: 'help me with my hook' }], brandContext: bcw }, 'Try opening on the desk.', undefined],
  ];
  for (const [name, body, reply, eff] of WR) {
    env('WRITER_PROVIDER', 'claude'); claudeOn = true;
    reset(); plan = () => reply;
    const h = require_(path.join(API, name + '.js'));
    const res = await hit(h, body);
    ok(calls.length >= 1 && calls.every(c => c.opts.provider === 'claude'), name + ': follows WRITER_PROVIDER (status ' + res.statusCode + ', calls ' + calls.length + ')');
    if (eff) ok(calls.every(c => c.opts.effort === eff && c.inHead), name + ': effort ' + eff + ' with thinking headroom');
    else ok(calls.every(c => c.opts.effort == null && !c.inHead), name + ': default depth, untouched');
    claudeOn = false; reset(); plan = () => reply;
    await hit(h, body);
    ok(calls.every(c => c.opts.provider === 'grok'), name + ': falls back to Grok when Claude is not configured');
  }
  env('WRITER_PROVIDER', null); claudeOn = false;
  env('WRITER_EFFORT_BATCH', 'high'); reset(); plan = () => WR[0][2];
  await hit(require_(path.join(API, 'generate-ideas.js')), WR[0][1]);
  ok(calls[0].opts.effort === 'high' && calls[0].inHead, 'WRITER_EFFORT_BATCH moves the batch writer');
  env('WRITER_EFFORT_BATCH', null);
  env('WRITER_EFFORT_EDIT', 'low'); reset(); plan = () => WR[1][2];
  await hit(require_(path.join(API, 'viral-rewrite.js')), WR[1][1]);
  ok(calls[0].opts.effort === 'low', 'WRITER_EFFORT_EDIT moves the viral/sharpen writers');
  env('WRITER_EFFORT_EDIT', null);
}

// ═════ 7b. the brand check started before the AI work never breaks the request ═════
{
  const vr = require_(path.join(API, 'viral-rewrite.js'));
  const body = { idea: { title: 'why water' }, angle: { angle: 'myth', hook: 'h' }, brandContext: Object.assign({ brandId: 'b-ok' }, BC) };
  for (const [mode, want] of [['yes', 'b-ok'], ['no', null], ['throw', null]]) {
    accessMode = mode; reset(); plan = () => '{"title":"t","hook":"h","script":"s"}';
    const r = await hit(vr, body);
    ok(r.statusCode === 200 && usageLogs.length === 1 && usageLogs[0].brandId === want, 'brand attribution (' + mode + '): 200 and brand ' + want + ' (got ' + r.statusCode + ' ' + (usageLogs[0] && usageLogs[0].brandId) + ')');
  }
  accessMode = 'yes';
}

// ═════ 8. no clipping rule is left in the writers ═════
{
  const fs = require_('fs');
  const CLIP = /\bmax(?:imum)?\s*~?\s*\d+\s*words|fragments beat|use specific numbers|number beats an adjective|verifiable stats|\d+\s*-\s*\d+\s*words total/i;
  for (const f of ['_write.js', '_brain.js', 'generate-ideas.js', 'viral-rewrite.js', 'viral-twist.js', 'viral-analyze.js', 'sharpen.js', 'expand-field.js', 'remix.js']) {
    const src = fs.readFileSync(path.join(API, f), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    const m = code.match(CLIP);
    ok(!m, 'api/' + f + ' has no clipping rule left (found: ' + (m && m[0]) + ')');
  }
  ok(CLIP.test('Hook: max 8 words.') && CLIP.test('MAX 60 words') && CLIP.test('15-40 words total'), 'opposite: the clipping detector still recognises the old rules');
}

// ═════ 9. v693 r4 — the phrase battery (the verifier's list, both ways) ═════
{
  const allowed = 'Most desk workers overpay for electrolyte powders. Boring Electrolytes sells plain salt tabs.';
  const MUST_CATCH = [
    'In two weeks we tripled our sales.', '12 clients told me the same thing.', 'Twelve of my clients switched.', '3 of my clients quit powders.',
    'A dozen suppliers said no.', '9 out of 10 dentists agree.', '3 out of 4 customers come back.', 'We grew 5 times faster.',
    'Our revenue went up 3 times.', 'I saved 8 hours a week.', 'It took me 11 years to learn this.', 'Eleven customers signed in one week.',
    'I lost 10 pounds.', 'Anna quit powders last year.', 'Jim fainted at his desk.', 'Harvard found the same thing.',
    'Stanford researchers showed it.', 'A study from MIT proved it.', 'The FDA says most of it is useless.', 'We sold out in 48 hours.',
    'We sold out in 2 days.', 'Half my customers came back.', 'Our first 10 customers were gyms.', 'Every one of our 7 stockists reordered.',
    'Our 3 biggest clients left.', '13 customers wrote in.', 'We have 15 clients now.', 'It grew 4× in a year.', 'My client Sarah Jones called.',
  ];
  const MUST_PASS = [
    'In two weeks we went from nothing to real sales.', "After 30 days you'll feel the difference.", "After 30 days you'll sleep better.",
    'Research shows most people are fine.', 'Sales went up a lot in 5 months.', 'Most of my customers came back.', 'I once spent 60 hours on this.',
    'I sell mine on Amazon.', 'Most people track it in Excel.', 'This is normal across Europe.', 'Gen Z drinks less soda.',
    'Black Friday is the worst time to buy.', "Water's cheaper than any powder.", "Life's too short for fancy powders.", "Salt's been around forever.",
    'I asked ChatGPT the same question.', 'Coffee is not the enemy.', 'Coffee drinkers need this less.', 'Most gyms push the Keto thing.',
    'Fifteen minutes a day is enough.', 'Buy it on Shopify.', 'Nobody at Whole Foods will tell you.', 'We ship to the US and Canada.',
    'STOP buying powder.', "Coffee's ruined my sleep.", "Juice's ruined my teeth.", 'Three steps fix it.', 'Give it two minutes.', 'It took 2.5 hours.', 'I post 7 videos a week.',
  ];
  for (const t of MUST_CATCH) { const g = I.inventedFacts(t, allowed); ok(g.length > 0, 'must catch: "' + t + '"'); }
  for (const t of MUST_PASS) { const g = I.inventedFacts(t, allowed); ok(g.length === 0, 'must pass: "' + t + '" (flagged ' + JSON.stringify(g) + ')'); }
  const al2 = 'Our tabs cost €15 for 60. Customers see a 2x return. We cut sugar by 50%. Founded in 2019 by Anna Kask.';
  for (const t of ['A tub is fifteen euros for sixty tabs.', 'Customers get twice the return.', 'Customers doubled their return.', 'We halved the sugar.',
    'Anna started this in 2019.', 'Kask started it in 2019.', 'Our founder Anna started it.', 'We cut sugar in half.']) {
    const g = I.inventedFacts(t, al2); ok(g.length === 0, 'equivalence allowed by the brand: "' + t + '" (flagged ' + JSON.stringify(g) + ')');
  }
  for (const [t, want] of [['Customers get three times the return.', '3x'], ['We cut sugar by a third and 40%.', '40%'], ['Anna Tamm started it.', 'Tamm']]) {
    const g = I.inventedFacts(t, al2); ok(g.includes(want), 'opposite: a DIFFERENT number or name is still caught: "' + t + '" (' + JSON.stringify(g) + ')');
  }
  const sl = I.slotifyInvented("Water's cheaper than any powder. I sell mine on Amazon. Anna quit powders last year.", allowed);
  ok(sl === "Water's cheaper than any powder. I sell mine on Amazon. [your story: your real version of \"Anna quit powders last year.\"]", 'slotify: clean sentences untouched, the ask quotes the original sentence intact (' + sl + ')');
}

// ═════ 10. v693 r4 — allowed facts come only from what a person wrote or chose ═════
{
  const EX = [{ title: 'Old AI post', text: 'I spent $15,000 before my client Sarah told me.', edited: false }];
  const bcU = Object.assign({}, BC, { approvedExamples: EX });
  const al = I.allowedMaterial(bcU, I.normSource(SRC), I.normAngle(ANGLE), []);
  ok(I.inventedFacts('I spent $15,000 and Sarah agreed.', al).length >= 2, 'an UNEDITED approved AI post is not a source of facts');
  const bcE = Object.assign({}, BC, { approvedExamples: [Object.assign({}, EX[0], { edited: true })] });
  const alE = I.allowedMaterial(bcE, I.normSource(SRC), I.normAngle(ANGLE), []);
  ok(I.inventedFacts('I spent $15,000 and Sarah agreed.', alE).length === 0, 'opposite: a post the user EDITED is theirs, so its facts are allowed');
  ok(!/Old AI post|15,000/.test(I.userFacts(bcU)) && /Maria Tamm/.test(I.userFacts(bcU)), 'userFacts carries the brand fields, not unedited AI posts');
  const bcL = Object.assign({}, BC, { learnedSignals: 'Approved: 250 clients doubled' });
  ok(I.inventedFacts('250 clients doubled.', I.allowedMaterial(bcL, I.normSource(SRC), I.normAngle(ANGLE), [])).length > 0, 'titles of AI ideas (learned signals) are not facts either');
}

// ═════ 11. v693 r4 — retries that save a request ═════
{
  const env = (k, v) => { if (v == null) delete process.env[k]; else process.env[k] = v; };
  // a failed (timed-out) draft is retried once a level lower
  let o = await run((i) => { if (i === 0) { skew += 100000; throw new Error('The AI is having a moment'); } return [null, CLEAN, SPOKEN, SHAPE][i]; });
  ok(calls.length === 4 && calls[0].opts.effort === 'medium' && calls[1].opts.effort === 'low' && o.idea.script === SPOKEN, 'a failed draft is retried once at the next lower effort (' + calls.map(c => c.opts.effort).join() + ')');
  ok(calls[1].opts.deadlineMs >= 40000 && calls[1].opts.deadlineMs <= 200000 - 100000, 'the retry uses only the time that is left');
  reset(); plan = (i) => { skew += 170000; throw new Error('timeout'); };
  ok(await code(W.runWrite({ bc: BC, source: SRC, angle: ANGLE, deadlineMs: 200000 })) === 'timeout' && calls.length === 1, 'opposite: under 40 s left, no retry — the honest error');
  reset(); plan = () => { const e = new Error('refused'); e.code = 'AI_UNAVAILABLE'; throw e; };
  ok(await code(W.runWrite({ bc: BC, source: SRC, angle: ANGLE, deadlineMs: 200000 })) === 'AI_UNAVAILABLE' && calls.length === 1, 'an AI refusal on Grok is never retried');
  // generate-ideas batch
  const gi = require_(path.join(API, 'generate-ideas.js'));
  reset(); plan = (i) => { if (i === 0) throw new Error('timeout'); return '[{"title":"t","hook":"h","script":"s","format":"video"}]'; };
  let r = await hit(gi, { brandContext: Object.assign({}, BC), count: 1 });
  ok(r.statusCode === 200 && calls.length === 2 && calls[0].opts.effort === 'medium' && calls[1].opts.effort === 'low', 'ideas batch: a failed call is retried once a level lower (' + r.statusCode + ' ' + calls.map(c => c.opts.effort).join() + ')');
  // sharpen critique
  const sh = require_(path.join(API, 'sharpen.js'));
  reset(); plan = (i) => { if (i === 0) throw new Error('timeout'); if (i === 1) return 'STRONG'; return '{}'; };
  r = await hit(sh, { content: { hook: 'Water tips', script: 'Drink water first.' }, kind: 'idea', format: 'video', brandContext: Object.assign({}, BC) });
  ok(calls.length === 2 && calls[1].opts.effort === 'low' && r.statusCode === 200, 'sharpen critique: retried once a level lower (' + calls.map(c => c.opts.effort).join() + ')');
  // claude -> grok
  env('WRITER_PROVIDER', 'claude'); claudeOn = true;
  o = await run((i) => { if (i === 0) throw new Error('Claude 400: model not found'); return [null, CLEAN, SPOKEN, SHAPE][i]; });
  ok(calls[0].opts.provider === 'claude' && calls[1].opts.provider === 'grok' && calls[1].opts.effort === calls[0].opts.effort && o.idea.script === SPOKEN, 'WRITER_PROVIDER=claude: a Claude error falls back to Grok once');
  o = await run((i) => { if (i === 0) { const e = new Error('no key'); e.code = 'AI_UNAVAILABLE'; throw e; } return [null, CLEAN, SPOKEN, SHAPE][i]; });
  ok(calls[1].opts.provider === 'grok' && o.idea.script === SPOKEN, 'a refused Claude account also falls back (the switch must never fail a request)');
  reset(); plan = (i) => { const e = new Error('declined'); e.code = 'MODEL_REFUSAL'; throw e; };
  ok(await code(W.runWrite({ bc: BC, source: SRC, angle: ANGLE, deadlineMs: 200000 })) === 'MODEL_REFUSAL' && calls.length === 1, 'a model declining the content is not retried elsewhere');
  reset(); plan = (i) => { throw new Error('Claude 400'); };
  ok(await code(W.runWrite({ bc: BC, source: SRC, angle: ANGLE, provider: 'claude', effort: 'high', deadlineMs: 200000 })) !== 'resolved' && calls.every(c => c.opts.provider === 'claude'), 'opposite: an explicit provider (the blind test) never falls back');
  for (const [name, body, reply] of [['viral-rewrite', { idea: { title: 'w' }, angle: { angle: 'a', hook: 'h' }, brandContext: Object.assign({}, BC) }, '{"title":"t","hook":"h","script":"s"}'],
    ['expand-field', { fieldName: 'brandVocab', currentValue: 'water', brandContext: Object.assign({}, BC) }, 'water, plain water']]) {
    reset(); plan = (i) => { if (i === 0) throw new Error('Claude 529 overloaded'); return reply; };
    const rr = await hit(require_(path.join(API, name + '.js')), body);
    ok(rr.statusCode === 200 && calls.length === 2 && calls[1].opts.provider === 'grok' && usageLogs[0] && usageLogs[0].model === 'claude', name + ': Claude outage falls back to Grok; the usage row is priced as Claude');
  }
  env('WRITER_PROVIDER', null); claudeOn = false;
  reset(); plan = () => '{"title":"t","hook":"h","script":"s"}';
  await hit(require_(path.join(API, 'viral-rewrite.js')), { idea: { title: 'w' }, angle: { angle: 'a', hook: 'h' }, brandContext: Object.assign({}, BC) });
  ok(usageLogs[0] && usageLogs[0].model !== 'claude', 'opposite: a Grok-written row is not priced as Claude');
}

// ═════ 12. v693 r4 — the cost fuse knows Claude ═════
{
  const U = require_('fs').readFileSync(path.join(API, '_usage.js'), 'utf8');
  const env = (k, v) => { if (v == null) delete process.env[k]; else process.env[k] = v; };
  delete require_.cache[require_.resolve(path.join(API, '_usage.js'))];
  const Mod = require_('module'); const real = new Mod(path.join(API, '_usage.js'));
  real.filename = path.join(API, '_usage.js'); real.paths = Mod._nodeModulePaths(API); real._compile(U, real.filename);
  const RU = real.exports;
  ok(RU.costFor('write', 'claude') > RU.costFor('write', 'grok') * 10 && RU.costFor('write', 'grok') === RU.ACTION_COST.write, 'a Claude-written write costs its Claude ceiling; a Grok one its old cost');
  env('ANTHROPIC_MODEL', 'claude-something-else');
  ok(Math.abs(RU.costFor('write', 'claude') - RU.claudeCeiling('write') * 2.5) < 1e-9, 'an unpriced ANTHROPIC_MODEL is scaled to the highest cited price');
  env('ANTHROPIC_MODEL', null);
  env('WRITER_PROVIDER', 'claude'); env('ANTHROPIC_API_KEY', 'k'); ok(RU.currentWriterModel() === 'claude', 'the fuse prices the next call as Claude when the switch is on');
  env('ANTHROPIC_API_KEY', null); ok(RU.currentWriterModel() === 'grok', '...and as Grok when Claude is not configured');
  env('WRITER_PROVIDER', null);
  ok(/select=action,created_at,model/.test(U) && /costFor\(row\.action, row\.model\)/.test(U), 'the period cost reads each row\'s model');
}

// ═════ 13. v693 r5 — the attacker's findings ═════
{
  const fs = require_('fs');
  // 1 + 2 + 4 + 7: the battery, both ways
  const allowed = "Boring Electrolytes. Electrolyte powder with no sugar. Sodium, potassium, magnesium. For people who sweat a lot and will train hard. Grace under pressure. Sold next to Trader Joe's snacks.";
  const R5_CATCH = [
    '3 in 4 people walk around dehydrated.', 'Nine in ten people get this wrong.', 'One in three adults is low on magnesium.', '1 in 5 runners cramps.',
    'Two thirds of gym-goers quit by March.', 'Three quarters of people are dehydrated.', 'Half the people at my gym drink sugar water.', 'Sales went up by a third.',
    'Research shows dehydration cuts focus by a fifth.', 'We hit seven figures last year.', 'We did six figures in our first year.',
    'My client Joe told me he quit soda.', 'My client Will quit soda.', 'My client Grace cut her cramps completely.', 'I asked my buddy Tom.', 'Coach Mike swears by it.',
    'John quit coffee.', 'Harvard found the same thing.', 'Stanford found salt helps.', 'A Mayo Clinic study backs this.', 'The WHO says adults eat too much salt.',
    'Nike sponsored our first race.', 'Costco stocks us now.', 'Amazon ranked us the best seller in our category.', 'Tesla uses our powder in their offices.',
    'We are sold in Costco and Whole Foods now.', 'It is clinically proven to hydrate faster.', 'Doctors recommend it.', 'Dermatologists recommend it.',
    'We are the number one electrolyte brand in the Baltics.', 'Endorsed by Nike athletes.', "John's results were great.", 'The best-selling electrolyte in Estonia.', "We're the #1 electrolyte in Estonia.",
  ];
  const R5_PASS = [
    'Stress wrecked my sleep for years.', 'Running changed that.', 'Athletes learned this the hard way.', 'Walking helped more than the gym did.',
    'Magnesium fixed my sleep.', 'Soda ruined my afternoons.', 'Winter killed my motivation.', 'Headaches followed every run.',
    'Grandma put salt in everything and she was fine.', 'I was twice as tired.', 'Half of this is habit.', 'That is half the battle.', 'Summer showed me the problem.',
    'Cramps ended my first race.', 'Travel killed my routine.', 'Nurses learned this years ago.', 'Farmers always knew it.', 'Hydration changed everything for me.',
    'Rule number one: salt before sweat.', "Juice's called liquid candy for a reason.", 'Doctors tell you to cut salt, but athletes need it.', 'Research shows most people are fine.', 'Science backs this up.',
    'Mom always said drink more water.', 'Gym bros figured this out ages ago.', 'Friday nights used to wreck my Saturday runs.', 'Christmas is the worst week for this.',
    'Swapping soda for water changed my afternoons.', 'Sitting all day dries you out too.', 'Twice a day is enough.', 'Do this once or twice a week.',
    'After two weeks my cramps stopped.', 'It takes five minutes a day.', 'Everyone says drink eight glasses a day.', 'I drank two coffees and crashed.',
    'Keto flu is mostly just low salt.', 'Marathoners carry salt tabs for a reason.', 'Plot twist, it was my water bottle.', 'I sell mine on Amazon.', 'Nobody at Whole Foods will tell you.',
  ];
  for (const t of R5_CATCH) ok(I.inventedFacts(t, allowed).length > 0, 'r5 must catch: "' + t + '"');
  for (const t of R5_PASS) { const g = I.inventedFacts(t, allowed); ok(g.length === 0, 'r5 must pass: "' + t + '" (flagged ' + JSON.stringify(g) + ')'); }
  // equivalences and allowed claims
  ok(I.inventedFacts('3 in 4 customers reorder.', 'Our survey: 75% of customers reorder.').length === 0, 'the brand\'s "75%" allows "3 in 4"');
  ok(I.inventedFacts('Two thirds of our customers reorder.', 'About 67% of customers reorder.').length === 0 && I.inventedFacts('Two thirds of our customers reorder.', 'About 50% reorder.').includes('67%'), 'fractions key as percentages both ways');
  ok(I.inventedFacts('It is clinically tested.', 'Our formula is clinically tested in Tallinn.').length === 0, 'a claim the brand itself makes is allowed');
  ok(I.inventedFacts('Costco stocks us now.', 'We are stocked at Costco across Estonia.').length === 0, 'a retailer the brand names is allowed');
  ok(I.inventedFacts('My client Maria told me.', 'Founded by Maria Tamm.').length === 0 && I.inventedFacts('My client Will told me.', 'Will you train hard?').length > 0, 'a person name must appear capitalised mid-sentence in the material, not only as a sentence opener');
  ok(I.inventedFacts('The WHO says so.', 'The WHO guidelines apply.').length === 0 && I.inventedFacts('The WHO says so.', 'people who sweat').length > 0, 'ALL-CAPS institutions match case-sensitively');
  // 3: the splitter
  for (const t of ['Salt matters. Losing just 2.5% of your body water cuts your focus. So drink up.', 'Our tub is $4.99 and lasts a month. That is it.',
    'Salt matters, e.g. for runners. Dr. Lee says 3 in 4 people cramp. So drink up.', 'It works vs. soda. Most people need 1.5 litres more. Drink.']) {
    const sl = I.slotifyInvented(t, 'nothing');
    ok(!/\d\s*\[your story/i.test(sl) && !/\d\.\s*\[/.test(sl) && !/\[your story:[^\]]*\]\s*\d/.test(sl) && !/\b(?:Dr|Mr|Mrs|Ms|St|vs|e\.g|i\.e)\.\s*\[your story/i.test(sl), 'the splitter never cuts inside a number or abbreviation (' + sl + ')');
  }
  const sl2 = I.slotifyInvented('Salt matters. Losing just 2.5% of your body water cuts your focus. So drink up.', 'nothing');
  ok(sl2 === 'Salt matters. [your story: your real version of "Losing just 2.5% of your body water cuts your focus."] So drink up.', 'a decimal sentence is slotted whole (' + sl2 + ')');
  ok(I.slotifyInvented('Dr. Lee explains it. Salt matters.', 'Dr. Lee explains it.') === 'Dr. Lee explains it. Salt matters.', 'an untouched "Dr." keeps its dot');
  const DR = 'Most people think water is enough. 1 in 3 adults walks around low on salt, and Athletes learned this the hard way. Losing just 2.5% of your body water cuts your focus. Our tub is $4.99. So salt your water.';
  const o5 = await run((i) => [DR, DR, DR, SHAPE][i], { source: { kind: 'note', text: 'people think plain water hydrates them' } });
  ok(!/\d\s*\[your story/i.test(o5.idea.script) && /Athletes learned this the hard way/.test(o5.idea.script) && !/2\.5%[^"]*$/.test(o5.idea.script.replace(/\[your story:[^\]]*\]/g, ' ')), 'runWrite end to end: no digit is ever followed by a slot, clean sentences survive (' + o5.idea.script + ')');
  // 6: AI-filled fields are not facts
  const base = { brandName: 'B', usps: 'We sell 3210 tubs a year.' };
  for (const f of I.AI_FILLED_FIELDS) {
    const bc = Object.assign({}, base, { [f]: 'Liquid IV grew 40% via Costco and sold 4321 units.' });
    ok(I.inventedFacts('Liquid IV grew 40% via Costco and sold 4321 units.', I.userFacts(bc)).length > 0, 'AI-filled field ' + f + ' is not a source of facts');
  }
  ok(I.inventedFacts('We sell 3210 tubs a year.', I.userFacts(base)).length === 0, 'opposite: a user-written field (usps) still is');
  ok(!I.USER_FACT_FIELDS.some(f => I.AI_FILLED_FIELDS.includes(f)), 'no field is both user-written and AI-filled');
  // 5: the fuse ceiling covers every worst-case call, derived here independently
  const LSrc = fs.readFileSync(path.join(API, '_llm.js'), 'utf8');
  const H = JSON.parse(LSrc.match(/const THINKING_HEADROOM = (\{[^}]*\})/)[1].replace(/(\w+):/g, '"$1":'));
  ok(JSON.stringify(H) === JSON.stringify(W.CLAUDE_THINKING_HEADROOM), 'the plan uses _llm.js\'s real thinking headroom');
  const U2 = fs.readFileSync(path.join(API, '_usage.js'), 'utf8');
  delete require_.cache[require_.resolve(path.join(API, '_usage.js'))];
  const Mod2 = require_('module'); const real2 = new Mod2(path.join(API, '_usage.js'));
  real2.filename = path.join(API, '_usage.js'); real2.paths = Mod2._nodeModulePaths(API); real2._compile(U2, real2.filename);
  const RU2 = real2.exports;
  const src = (f) => fs.readFileSync(path.join(API, f), 'utf8');
  const maxIn = (f) => Math.max(...[...src(f).matchAll(/max_tokens:\s*(\d+)/g)].map(m => +m[1]));
  const WS = src('_write.js');
  const P = W.CLAUDE_CALL_PLAN;
  ok(/max_tokens: ANGLES_MAX_TOKENS/.test(WS) && P.angles.length >= 2 && P.angles.every(l => l.max === W.ANGLES_MAX_TOKENS), 'angles: first ask + re-ask at the real max_tokens');
  ok(/draftCall\(basePrompt, DRAFT_MAX_TOKENS \* 2/.test(WS) && P.write.length >= 6 && P.write.filter(l => l.kind === 'draft').length >= 4 && P.write.filter(l => l.max === W.DRAFT_MAX_TOKENS * 2).length >= 2 && P.write.some(l => l.max === W.SPOKEN_MAX_TOKENS) && P.write.some(l => l.max === W.SHAPE_MAX_TOKENS), 'write: two draft calls, each with its lower-effort retry, the truncation size, spoken and shape');
  ok(P.ideas.length >= 3 && P.ideas.every(l => l.max >= maxIn('generate-ideas.js')), 'ideas: batch + lower retry + regeneration at generate-ideas\' largest max_tokens');
  ok(P.sharpen.length >= 3 && P.sharpen.some(l => l.max === 1500) && P.sharpen.some(l => l.max >= maxIn('sharpen.js')), 'sharpen: critique + its retry + rewrite at sharpen\'s max_tokens');
  ok(P.viral[0].max >= Math.max(maxIn('viral-rewrite.js'), maxIn('viral-twist.js'), maxIn('viral-analyze.js')), 'viral: the largest viral max_tokens');
  ok(P.expand[0].max >= maxIn('expand-field.js') && P.settingsexamples[0].max >= maxIn('settings-examples.js') && P.voicechat[0].max >= maxIn('brand-voice-chat.js'), 'expand / settingsexamples / voicechat at their real max_tokens');
  for (const a of Object.keys(P)) {
    let usd = 0;
    for (const l of P[a]) { let e = l.kind ? W.writerEffort(l.kind) : 'medium'; if (l.lower) e = ({ high: 'medium', medium: 'low', low: 'low' })[e]; usd += l.in * 4e-6 + (l.max + H[e]) * 20e-6; }
    ok(RU2.claudeCeiling(a) >= usd - 0.001, 'fuse ceiling for ' + a + ' (' + RU2.claudeCeiling(a) + ') covers its worst-case calls (' + usd.toFixed(3) + ')');
  }
  const before = RU2.claudeCeiling('write');
  process.env.WRITER_EFFORT_DRAFT = 'high';
  ok(RU2.claudeCeiling('write') > before, 'a deeper draft (WRITER_EFFORT_DRAFT=high) raises the write ceiling');
  delete process.env.WRITER_EFFORT_DRAFT;
}

// ═════ 14. v693 r6 — fewer false positives, the remaining leaks ═════
{
  const A = 'Boring Electrolytes. Electrolyte powder with no sugar, for people who sweat and will train hard. Sodium, potassium, magnesium.';
  const R6_CATCH = [
    // 2 — first names outside the list, opening with a person action
    'Kelly fainted halfway through her first marathon.', 'Priya switched to salt water and her headaches stopped.', 'Marcus cut sugar for a month.',
    'Olga told me the same thing.', 'Travis quit soda last year.', 'Kadi and her sister tried it.',
    // 3 — statistics
    '1 in every 3 adults is low on magnesium.', 'One in every four runners cramps.', 'Three of every four adults are short on potassium.',
    'A quarter of your sweat loss is salt.', 'Roughly 8 per cent of people never drink water.', '1 in every 3 is low on magnesium.', 'Three of every four quit.',
    // 4 — medical / authority about us
    'It is clinically studied.', 'It is clinically tested.', 'Proven in clinical trials.', 'It is dermatologist-tested.', 'Dermatologist-approved formula.',
    'Research proves it works.', 'Doctors swear by it.', 'Most doctors agree it works.', 'Nurses love it.', 'Doctors recommend it.', 'Doctors recommend Boring Electrolytes.',
    'Trusted by pro athletes.', 'Olympic athletes drink this.', 'It is the most popular electrolyte in Estonia.', 'Award-winning formula.',
    "America's favorite electrolyte.", "Amazon's Choice for electrolytes.", 'We are the fastest-growing electrolyte brand in Europe.', 'Doctor-recommended.',
    // 5 — retail
    'You can find us at Costco now.', 'We just landed Costco.', 'We are on the shelves at Lidl.', 'Now in every Rimi store.', 'Our customers include Nike.',
    'We are an Amazon #1 new release.', 'Whole Foods carries us.', 'Available at Selver and Prisma.', 'Selver carries us.',
    // 6 — number one / best-selling about us
    'We are the number one electrolyte brand in the Baltics.', "We're the #1 electrolyte in Estonia.", 'Our powder is the number one choice of runners.',
    'The best-selling electrolyte in Estonia.', 'It is a best seller.',
  ];
  const R6_PASS = [
    // 1 — advice, not endorsement of us
    'Doctors recommend eating less salt, but athletes are different.', 'Most doctors recommend eight glasses a day.', 'Recommended by experts? Not really.',
    'Nurses recommend drinking before you feel thirsty.', 'Doctors tell you to cut salt.', 'Coaches recommend that you drink early.',
    // 2 — everyday openers
    'Stress wrecked my sleep for years.', 'Magnesium fixed my sleep.', 'Running changed that.', 'Soda ruined my afternoons.', 'Winter killed my motivation.',
    'Athletes learned this the hard way.', 'Headaches followed every run.', 'Sugar cut my energy every afternoon.', 'Salt stopped my cramps.', 'Travel killed my routine.', 'Beetroot cut my recovery time.', 'Caffeine left me shaky.', 'Runners quit too early.', 'Nurses started carrying salt tabs.',
    // 6 — number one as emphasis
    'The number one mistake in summer is plain water.', 'Rule number one in the heat: salt first.', 'Water is still the number one drink you need.',
    'My number one pick for long runs is salt water.', 'That is my number one rule in hot weather.', 'This is the number one thing people get wrong.',
    // 7 — other false positives
    'I read a best-selling book on sleep last year.', 'Step 2 in 5 is the hard one.', 'Drop 1 in 500 ml of water.', 'Give it 3 in 2 weeks.',
    'At 6 a.m. I drink salt water. Then I train.', 'In the U.S. people drink more soda. Here it is coffee.', 'I watched the Tour de France and felt thirsty.',
    'I ran my first race in Tartu.', 'Dr. Google told me I was dying.', 'I use Liquid IV sometimes.', 'On race day, Mom packs pickles.', 'A quarter of an hour is enough.',
  ];
  for (const t of R6_CATCH) ok(I.inventedFacts(t, A).length > 0, 'r6 must catch: "' + t + '"');
  for (const t of R6_PASS) { const g = I.inventedFacts(t, A); ok(g.length === 0, 'r6 must pass: "' + t + '" (flagged ' + JSON.stringify(g) + ')'); }
  // allowed when the material makes the same claim / names the retailer
  ok(I.inventedFacts('It is clinically tested.', 'Our formula is clinically tested.').length === 0, 'r6: a claim the brand makes is allowed');
  ok(I.inventedFacts('Roughly 8 per cent of people never drink water.', 'About 8% of people never drink water.').length === 0, 'r6: "per cent" is a percentage, not money');
  ok(I.inventedFacts('Now in every Rimi store.', 'Stocked in Rimi across Estonia.').length === 0 && I.inventedFacts('Now in every Rimi store.', A).length > 0, 'r6: a retailer the brand names is allowed, otherwise caught');
  ok(I.inventedFacts('Doctors swear by it.', 'Doctors swear by it — Tallinn clinic survey.').length === 0, 'r6: the same endorsement in the material is allowed');
  // 8 — Claude empty replies are billed once, not up to four times
  const LS = require_('fs').readFileSync(path.join(API, '_llm.js'), 'utf8');
  const ei = LS.indexOf("console.log('Claude EMPTY 200");
  const tail = LS.slice(ei, ei + 800);
  ok(ei > 0 && !/continue;/.test(tail.slice(0, tail.indexOf('return null;'))), 'r6: an empty 200 from Claude is not retried (each planned call is billed at most once)');
}

clearTimeout(WALL);
if (failed) { console.log('rv2-write-2: ' + failed + ' failed, ' + passed + ' passed'); process.exit(1); }
console.log('FACT GUARD OK — ' + passed + ' checks: guard, draft check, spoken pass, slot spellings, truncation, attribution');
process.exit(0);
