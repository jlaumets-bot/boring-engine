#!/usr/bin/env node
// GATE consistency-S2 — v709 consistency fix, agent S2 (.unlazy/consistency/CONTRACT.md): the older writers
// and the jobs follow the SAME shared rules as the new writer.
//
// Runs the REAL handlers api/generate-ideas.js, remix.js, sharpen.js, viral-rewrite.js, viral-twist.js,
// viral-analyze.js, video-beats.js, brand-voice-chat.js and send-daily.js (on the shared virtual-clock
// harness), plus api/_trends.js, api/fact-pack.js, with the REAL api/_write.js / api/_brain.js helpers
// (postRules, hashtagsFor, guardPost, sourceLine). Only the edges are stubbed: callLLM (captures every
// prompt, answers from a per-scenario plan, zero network), the usage meter, the session, the brand
// hydration, the access check and https. Every rule is paired with its opposite where one exists.
//
// RUN:    node scripts/verify/consistency-S2.mjs
// EXPECT: prints "CONSISTENCY S2 OK" and exits 0.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const Module = require_('module');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = path.join(ROOT, 'api');
const WALL = setTimeout(() => { console.log('FAIL: consistency-S2 wall clock (90s) — something hung'); process.exit(1); }, 90000);
let failed = 0, passed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.log('FAIL: ' + m); } };
process.env.CRON_SECRET = 'cron-test';
delete process.env.XAI_API_KEY; delete process.env.APIFY_API_TOKEN;

const realLlm = require_(path.join(API, '_llm.js'));
const aiUnavailable = realLlm.aiUnavailable;
delete require_.cache[require_.resolve(path.join(API, '_llm.js'))];
function stub(rel, exports) {
  const file = require_.resolve(path.join(API, rel));
  const m = new Module(file); m.filename = file; m.loaded = true; m.exports = exports; require_.cache[file] = m;
}
let calls = [], plan = () => '', usage = [], limitOpts = [];
stub('_llm.js', {
  callLLM: async (opts) => { const i = calls.length; const prompt = (opts.messages || []).map(m => m.content).join('\n'); calls.push({ opts, prompt }); return plan(i, prompt, opts); },
  aiUnavailable, callGrokSearch: async () => null,
});
stub('_usage.js', {
  billingUserFor: async (u) => u, creditsFor: () => 1,
  checkLimit: async (u, c, a, o) => { limitOpts.push(o || null); return { ok: true }; }, attachHoldRelease() {},
  guard: async () => ({ user: { id: 'u1' }, over: false, billingUserId: 'u1' }),
  denyResponse: (res) => res.status(402).json({ error: 'limit_reached' }),
  logUsage: async (r) => { usage.push(r && r.action); },
});
stub('_publish/store.js', { userCanAccessBrand: async () => true });
stub('_requireUser.js', async () => ({ id: 'u1' }));
const BC = { brandName: 'Acme Salts', tones: ['dry'], usps: 'ZUSP salt sticks', productDetails: 'ZPROD 500mg sodium',
  socialProof: '40,000 packs sold', communities: ['Sleep habits', 'Evening routines'], stories: [], beliefs: [], engine: 'grok' };
let hydrated = BC, avoidTitles = [];
stub('_brandctx.js', { loadBrandContext: async () => ({ ok: true, bc: JSON.parse(JSON.stringify(hydrated)), fields: 6, avoidTitles: avoidTitles.slice() }) });

const W = require_(path.join(API, '_write.js'));
const B = require_(path.join(API, '_brain.js'));
const T = require_(path.join(API, '_trends.js'));
const FP = require_(path.join(API, 'fact-pack.js'));
const H = {
  ideas: require_(path.join(API, 'generate-ideas.js')), remix: require_(path.join(API, 'remix.js')),
  sharpen: require_(path.join(API, 'sharpen.js')), rewrite: require_(path.join(API, 'viral-rewrite.js')),
  twist: require_(path.join(API, 'viral-twist.js')), analyze: require_(path.join(API, 'viral-analyze.js')),
  beats: require_(path.join(API, 'video-beats.js')), chat: require_(path.join(API, 'brand-voice-chat.js')),
};
const SRC = (f) => fs.readFileSync(path.join(API, f), 'utf8');
const fakeRes = () => ({ statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } });
const QUIET = () => { const s = { e: console.error, w: console.warn, l: console.log }; console.error = console.warn = console.log = () => {}; return () => { console.error = s.e; console.warn = s.w; console.log = s.l; }; };
async function run(name, body, planFn, opts) {
  calls = []; usage = []; limitOpts = []; plan = planFn || (() => '');
  hydrated = (opts && opts.bc) || BC; avoidTitles = (opts && opts.avoid) || [];
  const res = fakeRes();
  const back = QUIET();
  try { await H[name]({ method: 'POST', headers: { origin: 'https://contentshrimp.com' }, body }, res); }
  finally { back(); }
  return res;
}
const P0 = () => (calls[0] ? calls[0].prompt : '');
const idea = (o) => Object.assign({ belief: 'Salt timing matters', day: 'Monday', community: 'Sleep habits', format: 'video', tone: 'dry', title: 'T',
  hook: 'Salt before bed changes your night.', script: 'Salt before bed changes your night. Most people only think about water. Try a pinch with dinner and see.',
  emphasis: [], shots: '', caption: '', reelTitle: 'R', tags: '#cureinsomnia #magnesiumcures' }, o);
const batch = (list) => () => JSON.stringify(list);
const noSlot = (t) => String(t || '').replace(/\[your story:[^\]]*\]/g, '');
const tagsOf = (bc, i) => (W.hashtagsFor(bc, i) || []).join(' ');
const STALE = [/films a quick answer on camera/, /straight into camera/i, /ANGLE VARIETY \(mandatory\)/, /TAGS: start with the brand hashtag/,
  /"tags":/, /or common knowledge/, /End with a question or quiet prompt/, /and tones the user approved/, /Do NOT simply answer/,
  /3 parts\. One price/, /30 days of/, /one surprising fact/i, /tell me in the comments/i];
const stale = (P) => STALE.filter(re => re.test(P)).map(String);

// ═════ 0. the shared helpers this gate runs against are S1's real ones ═════
for (const k of ['postRules', 'hashtagsFor', 'guardPost', 'sourceLine']) ok(typeof W[k] === 'function', 'api/_write.js exports ' + k + ' (the contract helper)');

// ═════ 1. generate-ideas: shared rules, no conflicting lines, code hashtags, faceless from the brand ═════
{
  const FL = Object.assign({}, BC, { delivery: 'faceless' });
  const r = await run('ideas', { brandId: 'b1', typeMix: { tip: 2, qna: 1 } }, batch([idea({ title: 'A' }), idea({ title: 'B' }), idea({ title: 'C', format: 'qna', postType: 'qna' })]), { bc: FL });
  const P = P0();
  ok(r.statusCode === 200 && P.includes(W.postRules({ type: '', format: '', delivery: 'faceless' })), 'ideas: the prompt carries the shared POST RULES with the brand\'s FACELESS setting (no request delivery)');
  ok(stale(P).length === 0, 'ideas: no conflicting writer-own lines remain (found: ' + stale(P).join(' | ') + ')');
  ok(!/DELIVERY STYLE — FACE-ON/.test(P) && !/DELIVERY: FACE-ON/.test(P), 'ideas (faceless): no face-on instruction anywhere');
  const I = r.body.ideas || [];
  ok(I.length === 3 && I.every(x => x.tags === tagsOf(FL, x)) && I.every(x => !/cureinsomnia|magnesiumcures/.test(x.tags)) && I[0].tags.includes('#acmesalts'), 'ideas: hashtags are hashtagsFor(bc) — the model\'s tags never ship (' + (I[0] && I[0].tags) + ')');
  ok(limitOpts[0] && limitOpts[0].brandId === 'b1', 'ideas: the usage reservation names the brand (the morning batch\'s in-flight check reads it)');
  const r2 = await run('ideas', { brandId: 'b1', typeMix: { tip: 1 }, delivery: 'face' }, batch([idea({ title: 'A' })]), { bc: FL });
  ok(r2.statusCode === 200 && P0().includes(W.postRules({ type: 'tip', format: '', delivery: 'face' })) && !P0().includes(W.deliveryRule('faceless')), 'ideas: a request delivery (face) overrides the brand setting for that post; one type → its shape');
  const r3 = await run('ideas', { brandId: 'b1', typeMix: { tip: 1 } }, batch([idea({ title: 'A' })]), { bc: BC });
  ok(r3.statusCode === 200 && P0().includes(W.deliveryRule('face')) && !P0().includes(W.deliveryRule('faceless')), 'ideas (opposite): a brand with no setting is face-on');
  ok(/VARIETY WITHIN EACH TYPE: the POST TYPES counts above decide what every idea is/.test(P) && !/customer story \(a real one/.test(P), 'ideas: the angle rotation only flavours within a type, never mandatory (A5)');
}

// ═════ 2. Q&A / "Answer this" answers the question first (A6) ═════
{
  await run('ideas', { brandContext: BC, count: 1, seedQuestion: 'how much salt before a run?' }, batch([idea({ format: 'qna' })]));
  const P = P0();
  ok(/THE SEED IS A SEARCH QUESTION: "how much salt before a run\?"\. Answer it: the first sentence of the script gives the direct answer/.test(P) && !/Do NOT simply answer/.test(P) && !/ignore any line above/.test(P), 'PAA: the question is answered first');
}

// ═════ 3. guardPost (mode batch) runs on every batch idea ═════
{
  const list = [
    idea({ title: 'Invented', format: 'statement', boldText: 'We sold 90,000 packs last year. Salt matters at night.', script: 'Deadpan. One take.' }),
    idea({ title: 'Real proof', format: 'statement', boldText: 'Acme Salts has 40,000 packs sold. Salt matters at night.', script: 'Deadpan. One take.' }),
    idea({ title: 'How we cut returns 43%', belief: 'We cut returns 43%', hook: 'We cut returns 43%.' }),
  ];
  const r = await run('ideas', { brandId: 'b1', count: 3 }, batch(list));
  const I = r.body.ideas || [];
  ok(!I.find(x => /90,000/.test(JSON.stringify(x))) && (r.body.warnings || []).includes('onscreen_slot_dropped'), 'guardPost batch: a statement whose on-screen text invents a number is DROPPED, never printed (warnings onscreen_slot_dropped)');
  ok(!!I.find(x => x.title === 'Real proof' && /40,000/.test(x.boldText)), 'guardPost batch (opposite): the brand\'s own proof (social proof) is allowed material, the statement stays');
  ok(I.length === 2 && I.every(x => !/43/.test(x.title + x.belief + x.hook)), 'guardPost batch: an inventing title, belief and hook are replaced (B8) (' + I.map(x => x.title).join(' / ') + ')');
}

// ═════ 4. formats switched off (C4/D4) ═════
{
  const OFF = Object.assign({}, BC, { formatsOff: ['qna', 'carousel'] });
  const r = await run('ideas', { brandId: 'b1', typeMix: { tip: 2, qna: 1 } }, batch([idea({ title: 'A', format: 'carousel', boldText: '1: Salt. 2: At night.' }), idea({ title: 'B' }), idea({ title: 'C' })]), { bc: OFF });
  const P = P0();
  ok(/FORMATS SWITCHED OFF for this brand \(never use them, not even as a bonus\): qna, carousel\./.test(P), 'formats off: the prompt names them');
  ok(/POST TYPES FOR THIS BATCH \(exact counts, not a suggestion\): tip x3\./.test(P), 'formats off: the type mix loses its qna slot (qna needs the qna format) — tip x3');
  const I = r.body.ideas || [];
  ok(I.length === 2 && I.every(x => x.format !== 'carousel') && (r.body.warnings || []).includes('format_off_dropped'), 'formats off: an idea in a switched-off format is never returned');
  const q = await run('ideas', { brandId: 'b1', postType: 'qna', count: 1 }, batch([idea({ title: 'Q', format: 'qna', postType: 'qna' })]), { bc: OFF });
  ok(q.statusCode === 200 && (q.body.ideas || [])[0] && q.body.ideas[0].postType === 'qna', 'formats off (opposite): ONE Q&A asked for by name is the person\'s own pick and is kept');
}

// ═════ 5. the avoid-word scan reads only what people see (B6) ═════
{
  const AV = Object.assign({}, BC, { avoidWords: 'hook, story, news' });
  const slotIdea = idea({ title: 'S', script: 'Salt before bed changes your night. [your story: the night I cramped] Try a pinch with dinner.' });
  await run('ideas', { brandId: 'b1', count: 1 }, batch([slotIdea]), { bc: AV });
  ok(calls.length === 1, 'avoid-words: JSON keys ("hook"), the slot marker ("story") and enum values never trigger a paid regeneration (' + calls.length + ' calls)');
  await run('ideas', { brandId: 'b1', count: 1 }, batch([idea({ title: 'S', script: 'This hook is the whole news story.' })]), { bc: AV });
  ok(calls.length === 2, 'avoid-words (opposite): a word people would SEE still earns the one regeneration');
  const first = [idea({ title: 'A', script: 'A hook nobody needs.' }), idea({ title: 'B' }), idea({ title: 'C' })];
  const r = await run('ideas', { brandId: 'b1', count: 3 }, (i) => JSON.stringify(i === 0 ? first : [idea({ title: 'Only one' })]), { bc: AV });
  ok(calls.length === 2 && (r.body.ideas || []).length === 3, 'avoid-words: a cleaner retry with FEWER usable ideas never replaces the first batch');
}

// ═════ 6. dedupe — the same rule as the morning batch ═════
{
  const r = await run('ideas', { brandId: 'b1', count: 3 }, batch([idea({ title: 'Same' }), idea({ title: 'Same' }), idea({ title: 'Lib title' })]), { avoid: ['Lib title'] });
  const titles = (r.body.ideas || []).map(x => x.title);
  ok(titles.join('|') === 'Same|Same (2)' && (r.body.warnings || []).includes('duplicate_dropped'), 'dedupe: a twin title in the batch gets a suffix, a library title is not added again (' + titles.join('|') + ')');
  const one = await run('ideas', { brandId: 'b1', count: 1 }, batch([idea({ title: 'Lib title' })]), { avoid: ['Lib title'] });
  ok((one.body.ideas || []).length === 1, 'dedupe (opposite): a single idea (a redo replacing its own card) is never dropped');
}

// ═════ 6b. a THIN batch earns the one existing regeneration; still short = said, with counts ═════
{
  const inv = (t) => idea({ title: t, format: 'statement', boldText: 'We sold 90,000 packs last year. Salt matters at night.', script: 'Deadpan.' });
  const good = (t) => idea({ title: t });
  let r = await run('ideas', { brandId: 'b1', count: 3 }, (i) => JSON.stringify(i === 0 ? [inv('I1'), inv('I2'), good('G1')] : [good('A'), good('B'), good('C')]));
  ok(calls.length === 2 && (calls[1].prompt || '').includes('too few of your ideas were usable') && /never put a \[your story: \.\.\.\] slot/.test(calls[1].prompt) && (r.body.ideas || []).length === 3 && !r.body.short && usage.length === 1, 'thin batch: 1 of 3 usable after the guards → the ONE regeneration (restating no on-screen slots), the larger set is kept, one usage row');
  r = await run('ideas', { brandId: 'b1', count: 3 }, () => JSON.stringify([inv('I1'), inv('I2'), good('G1')]));
  ok(calls.length === 2 && (r.body.ideas || []).length === 1 && r.body.short === true && r.body.requested === 3 && r.body.delivered === 1 && usage.length === 1, 'thin batch still short after the regeneration: short:true with the counts, never a third call');
  r = await run('ideas', { brandId: 'b1', count: 3 }, batch([good('A'), good('B'), good('C')]));
  ok(calls.length === 1 && !r.body.short, 'thin batch (opposite): a full batch makes one call and is not short');
  r = await run('ideas', { brandId: 'b1', count: 3 }, batch([good('A'), good('B'), inv('I1')]));
  ok(calls.length === 1 && (r.body.ideas || []).length === 2 && !r.body.short, 'thin batch (opposite): 2 of 3 (>= 60%) makes no extra call');
  const OFF = Object.assign({}, BC, { formatsOff: ['carousel'] });
  r = await run('ideas', { brandId: 'b1', count: 3 }, (i) => JSON.stringify(i === 0 ? [idea({ title: 'K1', format: 'carousel' }), idea({ title: 'K2', format: 'carousel' }), good('G')] : [good('A'), good('B'), good('C')]), { bc: OFF, avoid: [] });
  ok(calls.length === 2 && /never use these switched-off formats: carousel/.test(calls[1].prompt), 'thin batch: format-off drops count too, and the regeneration names the formats');
  r = await run('ideas', { brandId: 'b1', count: 3 }, (i) => JSON.stringify(i === 0 ? [good('Lib title'), good('Lib two'), good('G')] : [good('A'), good('B'), good('C')]), { avoid: ['Lib title', 'Lib two'] });
  ok(calls.length === 2 && /never reuse these titles: "Lib title"/.test(calls[1].prompt) && (r.body.ideas || []).length === 3, 'thin batch: library duplicates count too, and the regeneration names the titles to avoid');
}

// ═════ 7. Redo with notes / Generate more keep the post type (D5) ═════
{
  const NS = { title: 'Retailers pull sugary drinks from shelves', url: 'https://news.example/x' };
  const r = await run('ideas', { brandId: 'b1', postType: 'news', count: 1, newsSource: NS }, batch([idea({ title: 'N', postType: 'news', newsIndex: 1, script: 'Retailers pull sugary drinks from shelves. Here is why that matters for your runs.' })]), { bc: Object.assign({}, BC, { freshNews: [] }) });
  const I = (r.body.ideas || [])[0] || {};
  ok(I.postType === 'news' && I.newsSource && I.newsSource.url === NS.url && P0().includes(NS.title), 'redo: a News idea keeps its type and its source link when the topic stays (no fresh stored headline needed)');
  const a = await run('ideas', { brandId: 'b1', postType: 'about', count: 3 }, batch([idea({ title: 'X', postType: 'tip' }), idea({ title: 'Y' }), idea({ title: 'Z' })]));
  ok((a.body.ideas || []).length === 3 && a.body.ideas.every(x => x.postType === 'about'), 'Generate more: a sent postType is kept, never defaulted to Tip');
}

// ═════ 8. banned topics filter headlines, trends and facts (C9) ═════
{
  const DAY = 86400000, NOW = Date.now();
  const BAN = Object.assign({}, BC, { bannedTopics: 'crypto', freshNews: [
    { title: 'Crypto miners turn to salt caverns for storage', url: 'https://news.example/c', date: NOW - DAY, source: 'S' },
    { title: 'Retailers pull sugary sports drinks from shelves', url: 'https://news.example/r', date: NOW - DAY, source: 'S' }] });
  await run('ideas', { brandId: 'b1', typeMix: { news: 1 } }, batch([idea({ title: 'N', postType: 'news', newsIndex: 1 })]), { bc: BAN });
  ok(P0().includes('Retailers pull sugary sports drinks') && !P0().includes('Crypto miners'), 'banned topics: a stored headline naming one never reaches a news slot');
  ok(T.hitsBanned('New KETO DIET study', T.bannedTermsFrom('Don\'t mention "keto diet". gambling')) === 'keto diet' && !T.hitsBanned('cryptography wins', 'crypto'), 'banned topics: quoted words are the rule; whole words only');
  // pullAllTrends (the cron and the manual pull): https stubbed to one RSS answer
  const https = require_('https'); const realReq = https.request;
  const RSS = '<rss><item><title>Crypto crash hits salt futures - Wire</title><link>https://n.example/1</link><pubDate>' + new Date().toUTCString() + '</pubDate></item>' +
    '<item><title>Study links evening salt to fewer night cramps - Wire</title><link>https://n.example/2</link><pubDate>' + new Date().toUTCString() + '</pubDate></item></rss>';
  https.request = (o, cb) => { const r = new EventEmitter(); r.end = () => { const resp = new EventEmitter(); resp.statusCode = 200; resp.headers = {}; resp.resume = () => {}; setImmediate(() => { cb(resp); resp.emit('data', Buffer.from(RSS)); resp.emit('end'); }); }; r.destroy = () => {}; return r; };
  const back = QUIET();
  let items = [];
  try { items = await T.pullAllTrends(['salt'], undefined, 48, 1000, { banned_topics: 'crypto' }, 1000); } finally { back(); https.request = realReq; }
  ok(items.length === 1 && /evening salt/.test(items[0].text), 'banned topics: pulled trends naming one are never kept (' + items.map(x => x.text).join(' | ') + ')');
  ok(/select=id,brand_name,[^`]*banned_topics/.test(SRC('pull-trends-cron.js')), 'banned topics: the nightly trends cron reads banned_topics');
  const v = await FP.verifyCandidates([{ text: 'Crypto prices fell sharply this year according to the central bank report', url: 'https://www.example.gov/report' }], { brand_name: 'Acme', banned_topics: 'crypto' }, { deadlineAt: Date.now() + 1000 });
  ok(v.kept.length === 0 && v.dropped.banned_topic === 1, 'banned topics: a fact-pack fact naming one is dropped before any fetch');
}

// ═════ 9. remix (classic): shared rules, code hashtags, guard ═════
{
  const FL = Object.assign({}, BC, { delivery: 'faceless' });
  const r = await run('remix', { brandId: 'b1', postDescription: 'A video about cramps.', remixMode: 'simplify' }, () => JSON.stringify({ originalSummary: 's', remixTitle: 'Night salt',
    remixHook: 'Salt before bed matters.', remixScript: 'Salt before bed matters. 87% of runners cramp at night.', remixFormat: 'video', remixCaption: 'Salt at night.', remixHashtags: '#cureinsomnia', whyItWorks: 'w' }), { bc: FL });
  const P = P0(), X = r.body.remix || {};
  ok(P.includes(W.postRules({ type: '', format: '', delivery: 'faceless' })), 'remix: the prompt carries the shared POST RULES with the brand\'s delivery');
  ok(stale(P).length === 0 && !/HASHTAG RULES/.test(P) && !/remixHashtags/.test(P) && !/If the original uses 100 words, use 20/.test(P) && !/HOOK STRUCTURE/.test(P) && !/ends with an engagement invite/.test(P), 'remix: no writingCraft hook examples, own hashtag/CTA rules or "100 words → 20" (found: ' + stale(P).join(' | ') + ')');
  ok(X.remixHashtags === tagsOf(FL, { title: X.remixTitle, hook: X.remixHook, script: X.remixScript, caption: X.remixCaption }) && !/cureinsomnia/.test(X.remixHashtags), 'remix: hashtags are the brand\'s own (' + X.remixHashtags + ')');
  ok(!/87%/.test(noSlot(X.remixScript)) && /\[your story:/.test(X.remixScript), 'remix: guardPost (single) slots an invented number');
  const bad = await run('remix', { brandId: 'b1', postDescription: 'x' }, () => JSON.stringify({ originalSummary: 's', remixTitle: 'T', remixHook: 'Shop now.', remixScript: 'Shop now. Link in bio.', remixFormat: 'video', remixCaption: '', whyItWorks: 'w' }));
  ok(bad.statusCode === 502 && usage.length === 0, 'remix: nothing usable after the guard = 502, not charged');
}

// ═════ 10. sharpen: 2200 caption, Source line, guard, no charge for nothing, one run per repeat ═════
{
  const body = 'Salt timing matters more than salt amount for most people who train in the evening. ';
  let cap = ''; while (cap.length < 2100) cap += body;
  cap = cap.trim() + ' THE_LAST_LINE_MARK.';
  const SRCLINE = 'Source: https://example.org/salt-study';
  const content = { hook: 'Salt timing matters.', caption: cap + '\n\n' + SRCLINE };
  const r = await run('sharpen', { brandId: 'b1', kind: 'post', format: 'static', content }, (i) => i === 0 ? '1. The hook is flat.' : JSON.stringify({ hook: 'Salt timing beats salt amount.', caption: 'Salt timing beats salt amount for evening training.' }));
  const S = r.body.sharpened || {};
  ok(calls[1] && calls[1].prompt.includes('THE_LAST_LINE_MARK') && !calls[1].prompt.includes(SRCLINE), 'sharpen: a 2100+ character caption reaches the model whole (no 2000 cut), its Source line held back');
  ok(S.caption && S.caption.endsWith('\n\n' + SRCLINE) && usage.length === 1, 'sharpen: the Source line is put back as the caption\'s last line; one usage row');
  ok(calls[1] && calls[1].prompt.includes(W.postRules({ type: '', format: 'static', delivery: 'face' })), 'sharpen: the rewrite carries the shared POST RULES');
  const gs = await run('sharpen', { brandId: 'b1', kind: 'post', format: 'video', content: { script: 'Salt matters at night.' } }, (i) => i === 0 ? '1. weak' : JSON.stringify({ script: 'Salt matters at night. 87% of runners agree.' }));
  ok(!/87%/.test(noSlot((gs.body.sharpened || {}).script)), 'sharpen: guardPost (single) — an invented number never ships');
  const st = await run('sharpen', { brandId: 'b1', kind: 'post', format: 'video', content: { hook: 'Salt matters.' } }, () => 'STRONG');
  ok(st.body && st.body.unchanged === true && usage.length === 1, 'sharpen: "already sharp" ran a paid critique, so it is charged (one row, as at HEAD)');
  const un = await run('sharpen', { brandId: 'b1', kind: 'post', format: 'video', content: { hook: 'Salt matters.' } }, (i) => i === 0 ? '1. weak' : JSON.stringify({ hook: 'Salt matters.' }));
  ok(un.body && un.body.unchanged === true && usage.length === 1, 'sharpen: an unchanged rewrite (two paid calls) is charged once');
  const fl = await run('sharpen', { brandId: 'b1', kind: 'post', format: 'video', content: { hook: 'Salt matters.' } }, (i) => i === 0 ? '1. weak' : 'not json');
  ok(fl.statusCode === 502 && usage.length === 0, 'sharpen (opposite): a failed rewrite is not charged');
  // two identical requests at once on one instance: ONE AI run, ONE usage row, the same answer
  calls = []; usage = []; plan = (i) => i === 0 ? '1. weak' : JSON.stringify({ hook: 'Salt timing beats salt amount.' });
  const back = QUIET();
  const rq = () => ({ method: 'POST', headers: { origin: 'https://contentshrimp.com' }, body: { brandId: 'b1', kind: 'post', format: 'video', content: { hook: 'Salt timing matters a lot.' } } });
  const ra = fakeRes(), rb = fakeRes();
  try { await Promise.all([H.sharpen(rq(), ra), H.sharpen(rq(), rb)]); } finally { back(); }
  ok(calls.length === 2 && usage.length === 1 && rb.body && rb.body.repeat === true && JSON.stringify(rb.body.sharpened) === JSON.stringify(ra.body.sharpened), 'sharpen: a repeat of the same request while it runs is answered by the first run — no second charge (' + calls.length + ' calls, ' + usage.length + ' rows)');
}

// ═════ 11. viral-rewrite / viral-twist / viral-analyze ═════
{
  const I0 = idea({ title: 'Night salt', caption: 'Salt at night.\n\nSource: https://example.org/s', format: 'video', postType: 'about' });
  const r = await run('rewrite', { brandId: 'b1', idea: I0, angle: { angle: 'Contrarian', hook: 'Water is not enough.' } },
    () => JSON.stringify({ title: 'Water is not enough', hook: 'Water is not enough.', script: 'Water is not enough at night. 92% of people get this wrong.', shots: 'Shot 1: glass', boldText: '', caption: 'New caption.', tags: '#cureinsomnia' }));
  const P = P0(), V = r.body.idea || {};
  ok(P.includes(W.postRules({ type: 'about', format: 'video', delivery: 'face' })) && stale(P).length === 0, 'viral-rewrite: shared POST RULES (type + format kept), no own tags/"surprising fact" lines (found: ' + stale(P).join(' | ') + ')');
  ok(V.tags === tagsOf(BC, V) && !/cureinsomnia/.test(V.tags), 'viral-rewrite: hashtags are the brand\'s own');
  ok(!/92%/.test(noSlot(V.script)) && /\[your story:/.test(V.script), 'viral-rewrite: guardPost (single) slots an invented number');
  ok(V.caption === 'New caption.\n\nSource: https://example.org/s', 'viral-rewrite: the original caption\'s Source line is kept');

  const tw = await run('twist', { brandId: 'b1', idea: I0 }, () => JSON.stringify({ angles: [{ angle: 'a', hook: '9 out of 10 runners cramp at night.', why: 'w' }, { angle: 'b', hook: 'Night cramps start at dinner.', why: 'w' }], spicy: { hook: 'Your dinner is the problem.', why: 'w' }, tip: 't' }));
  const TP = P0();
  ok(TP.includes(W.postRules({ type: 'about', format: 'video', delivery: 'face' })) && !/contrarian/i.test(TP), 'viral-twist: an about post gets the shared POST RULES and never a contrarian push (M6)');
  ok((tw.body.twist.angles || []).length === 1 && tw.body.twist.angles[0].hook === 'Night cramps start at dinner.', 'viral-twist: a hook that invents a number is dropped');
  await run('twist', { brandId: 'b1', idea: Object.assign({}, I0, { postType: 'tip' }) }, () => JSON.stringify({ angles: [{ angle: 'a', hook: 'h', why: 'w' }], spicy: { hook: 'h2', why: 'w' }, tip: 't' }));
  ok(/contrarian/i.test(P0()), 'viral-twist (opposite): a tip may still go contrarian');

  const an = await run('analyze', { brandId: 'b1', content: 'A transcript.' }, () => JSON.stringify({ whyItWorks: ['x'], hook: 'h', structure: 's', trigger: 't', ideas: [
    { format: 'statement', title: 'Stat', hook: 'Night salt.', angle: 'A point', script: 'We helped 12,000 runners sleep. Salt matters.' },
    { format: 'video', title: 'Ok', hook: 'Salt at dinner helps.', angle: 'A point', script: 'Salt at dinner helps the night.' }], takeaway: 'k' }));
  const AP = P0(), AI = (an.body.analysis || {}).ideas || [];
  ok(AP.includes(W.postRules({ type: '', format: '', delivery: 'face' })) && !/does not share yet/.test(AP), 'viral-analyze: shared POST RULES, one point per idea (not "a belief the audience does not share")');
  ok(AI.length === 1 && AI[0].title === 'Ok', 'viral-analyze: guardPost (batch) drops an idea whose on-screen text invents');
  const empty = await run('analyze', { brandId: 'b1', content: 'A transcript.' }, () => JSON.stringify({ whyItWorks: [], hook: '', structure: '', trigger: '', ideas: [{ format: 'video', title: 'x', hook: 'Shop now.', angle: 'a', script: 'Shop now. Link in bio.' }], takeaway: '' }));
  ok(empty.statusCode === 502 && usage.length === 0, 'viral-analyze: nothing usable = 502, not charged');
}

// ═════ 12. video-beats: no slot text, no invented figures ═════
{
  const script = 'Most runners drink water and still cramp. [your story: your real version of "We saved 40% on returns"] Salt timing is the fix.';
  const r = await run('beats', { brandId: 'b1', script, title: 't', hook: 'h' }, () => JSON.stringify({ beats: [
    { kind: 'statement', headline: 'Water is not enough', cue: 'Most runners drink water' },
    { kind: 'number', headline: '', value: '94%', sub: 'of runners', cue: 'Salt timing is the fix' },
    { kind: 'statement', headline: 'Salt timing is the fix', cue: 'Salt timing is the fix' }] }));
  const P = P0(), BT = r.body.beats || [];
  ok(!P.includes('40%') && !P.includes('your story') && !/34g|1,000mg/.test(P) && !/WHAT'S IN IT/.test(P), 'video-beats: the slot text (with its invented figure) never reaches the prompt; no product-number examples');
  ok(BT.length === 2 && !BT.some(b => b.value === '94%'), 'video-beats: a beat with a figure the script does not say is dropped');
}

// ═════ 13. coach: knows the fixed rules; never buys text-to-speech ═════
{
  const r = await run('chat', { brandId: 'b1', messages: [{ role: 'user', content: 'How should my posts end?' }] }, () => 'End on the point.');
  const P = P0();
  ok(/FIXED RULES EVERY POST ALREADY FOLLOWS/.test(P) && P.includes('HASHTAGS: write none, anywhere'), 'coach: told the shared rules, so it never saves a Voice Memory rule that fights them (L9)');
  ok(r.statusCode === 200 && calls.length === 1 && usage.join() === 'voicechat' && !/api\/speak|'speak'/.test(SRC('brand-voice-chat.js')), 'coach: one chat call, one voicechat row — the server never runs or charges text-to-speech');
}

// ═════ 14. send-daily: the morning batch follows the same rules (last: the harness stubs https globally) ═════
{
  const { createHarness } = await import(path.join(ROOT, 'scripts', 'verify', '_send-daily-harness.mjs'));
  const SD = createHarness(ROOT);
  const ctx = (extra) => SD.stub('_brandctx.js', { loadBrandContext: async (id) => ({ ok: true, bc: Object.assign({ brandName: 'Acme Studio', brandId: id, communities: ['Founders'],
    dayRotation: { Monday: 'Founders' }, typeMix: { tip: 2, about: 0, news: 0, qna: 2, story: 0, bts: 0 } }, extra) }) });
  // The side reads send-daily makes: voice_extra.formatsOff (answered here) and the in-flight reservation
  // (answered with a non-empty list when BUSY, by routing it to a path the harness answers with rows).
  const https = require_('https'); const inner = https.request;
  let OFF_ROW = null, BUSY = false;
  https.request = (o, cb) => {
    const p = String(o.path || '');
    if (p.startsWith('/rest/v1/brands') && OFF_ROW) {
      const r = new EventEmitter(); r.write = () => {}; r.destroy = () => {};
      r.end = () => setImmediate(() => { const resp = new EventEmitter(); resp.statusCode = 200; cb(resp); resp.emit('data', JSON.stringify([{ formatsOff: OFF_ROW }])); resp.emit('end'); });
      return r;
    }
    if (p.startsWith('/rest/v1/usage_events') && BUSY) return inner(Object.assign({}, o, { path: '/rest/v1/push_subscriptions?x' }), cb);
    return inner(o, cb);
  };
  const rows = SD.ACTIVE.concat(SD.pendingRows(5, { format: 'video' }), SD.pendingRows(2, { format: 'carousel', title: 'Hidden' }).map((x, k) => Object.assign(x, { title: 'Hidden ' + k })));
  ctx({ delivery: 'faceless', formatsOff: ['carousel', 'qna'] }); OFF_ROW = ['carousel', 'qna'];
  const a = await SD.run({ rows });
  const g = a.gens[0] && a.gens[0].body;
  ok(a.gens.length === 1 && g && g.count === 2, 'morning batch: ideas in a switched-off format do not count as waiting (5 visible of 7 → a top-up of 2)');
  ok(g && g.delivery === 'faceless' && (g.formatsOff || []).includes('carousel') && g.typeMix && g.typeMix.qna === 0, 'morning batch: the brand\'s Faceless setting (not a hard-coded face-on), formats off, and no qna slot when qna is off');
  ok(g && Array.isArray(g.libraryTitles) && g.libraryTitles.includes('Hidden 0'), 'morning batch: sends the library titles for the same dedupe as Plan my week');
  ctx({ delivery: 'face', formatsOff: [] }); OFF_ROW = null;
  const b = await SD.run({ rows });
  ok(b.gens.length === 0, 'morning batch (opposite): with nothing switched off, 7 waiting means no generation');
  // a manual generate in flight for this brand (a live hold:ideas: reservation) → no morning batch, no charge
  ctx({ formatsOff: [] }); BUSY = true;
  let c;
  try { c = await SD.run({ rows: SD.ACTIVE }); } finally { BUSY = false; }
  ok(c.gens.length === 0 && c.pushes.length === 1, 'morning batch: a manual generate in flight for the brand → the morning batch is skipped (no charge), the push still goes out');
  const d = await SD.run({ rows: SD.ACTIVE });
  ok(d.gens.length === 1, 'morning batch (opposite): no reservation → the batch runs');
  // a SHORT top-up is saved and blocks nothing: no pause recorded, the next run tops up again
  const shortGen = (rq) => ({ status: 200, body: { ideas: [SD.mkIdea('Short one', 'Monday')], short: true, requested: rq.body.count, delivered: 1 }, ms: 5 });
  const e1 = await SD.run({ rows: SD.ACTIVE, gen: shortGen });
  const hb = (e1.heartbeats[0] || {}).detail || {};
  ok(e1.inserts.length === 1 && hb.genShort === 1 && !Object.keys(hb.genTimeouts || {}).length, 'morning batch: a short top-up is saved, counted (genShort) and never recorded as a pause');
  const e2 = await SD.run({ rows: SD.ACTIVE, gen: shortGen, hbDetail: hb });
  ok(e2.gens.length === 1, 'morning batch: after a short top-up the next run tops up again');
  https.request = inner;
}

clearTimeout(WALL);
if (failed) { console.log('consistency-S2: ' + failed + ' failed, ' + passed + ' passed'); process.exit(1); }
console.log('CONSISTENCY S2 OK (' + passed + ' checks)');
