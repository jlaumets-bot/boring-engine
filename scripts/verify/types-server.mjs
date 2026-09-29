#!/usr/bin/env node
// GATE types-server — "what is the post about" as a first-class choice, server half
// (.unlazy/types/PLAN.md, section "Server (S)").
//
// Runs the REAL api/generate-ideas.js, api/angles.js, api/write.js and api/send-daily.js handlers with
// the REAL api/_brain.js, api/_write.js and (for the row mapping) api/_brandctx.js. Only the edges are
// stubbed: callLLM (captures every prompt, answers from a per-scenario plan, zero network), the usage
// meter, the session, the brand hydration and the access check; send-daily runs on the shared
// virtual-clock harness (scripts/verify/_send-daily-harness.mjs). Every rule is paired with its
// opposite (typed vs untyped, about vs tip, fresh news vs none, valid index vs invalid).
//
// RUN:    node scripts/verify/types-server.mjs
// EXPECT: prints "TYPES SERVER OK" and exits 0.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const Module = require_('module');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = path.join(ROOT, 'api');
const WALL = setTimeout(() => { console.log('FAIL: types-server wall clock (60s) — something hung'); process.exit(1); }, 60000);
let failed = 0, passed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.log('FAIL: ' + m); } };
process.env.CRON_SECRET = 'cron-test';

const realLlm = require_(path.join(API, '_llm.js'));
const aiUnavailable = realLlm.aiUnavailable;
delete require_.cache[require_.resolve(path.join(API, '_llm.js'))];
function stub(rel, exports) {
  const file = require_.resolve(path.join(API, rel));
  const m = new Module(file); m.filename = file; m.loaded = true; m.exports = exports; require_.cache[file] = m;
}
let calls = [], plan = () => '';
stub('_llm.js', {
  callLLM: async (opts) => { const i = calls.length; const prompt = (opts.messages || []).map(m => m.content).join('\n'); calls.push({ opts, prompt }); return plan(i, prompt, opts); },
  aiUnavailable, callGrokSearch: async () => null,
});
stub('_usage.js', {
  billingUserFor: async (u) => u, creditsFor: () => 1, checkLimit: async () => ({ ok: true }), attachHoldRelease() {},
  guard: async () => ({ user: { id: 'u1' }, over: false, billingUserId: 'u1' }),
  denyResponse: (res) => res.status(402).json({ error: 'limit_reached' }), logUsage: async () => {},
});
stub('_publish/store.js', { userCanAccessBrand: async () => true });
stub('_requireUser.js', async () => ({ id: 'u1' }));

const B = require_(path.join(API, '_brain.js'));
const W = require_(path.join(API, '_write.js'));
const CTX = require_(path.join(API, '_brandctx.js'));   // the REAL row mapping, read before the stub below
let hydrated = null;
stub('_brandctx.js', { loadBrandContext: async () => ({ ok: true, bc: JSON.parse(JSON.stringify(hydrated)), fields: 5, avoidTitles: [] }) });
const H = {
  ideas: require_(path.join(API, 'generate-ideas.js')),
  angles: require_(path.join(API, 'angles.js')),
  write: require_(path.join(API, 'write.js')),
};

const DAY = 86400000, NOW = Date.now();
const NEWS = [
  { title: 'Electrolyte sales rose 40% this year', url: 'https://news.example/a', date: NOW - 1 * DAY, source: 'Daily Trade' },
  { title: 'Retailers pull sugary sports drinks from shelves', url: 'https://news.example/b', date: NOW - 2 * DAY, source: 'Shop Weekly' },
];
const BC = { brandName: 'Acme Salts', tones: ['dry'], usps: 'ZUSP salt sticks', productDetails: 'ZPROD 500mg sodium', stories: [{ id: 's1', text: 'ZSTORY a runner who cramped at mile 20' }], beliefs: [], engine: 'grok' };
const setHydrated = (extra) => { hydrated = Object.assign({}, BC, { freshNews: NEWS, typeMix: Object.assign({}, B.DEFAULT_TYPE_MIX) }, extra || {}); };
const fakeRes = () => ({ statusCode: 0, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } });
async function run(name, body, planFn, headers) {
  calls = []; plan = planFn || (() => '');
  const res = fakeRes();
  const q = console.error, w = console.warn, l = console.log; console.error = console.warn = console.log = () => {};
  try { await H[name]({ method: 'POST', headers: Object.assign({ origin: 'https://contentshrimp.com' }, headers || {}), body }, res); }
  finally { console.error = q; console.warn = w; console.log = l; }
  return res;
}
const idea = (o) => Object.assign({ belief: 'A belief', day: 'Monday', community: 'running', format: 'video', tone: 'dry', title: 'T', hook: 'Hook line.', script: 'A script line.', emphasis: [], shots: '', caption: '', reelTitle: 'R', tags: '#AcmeSalts' }, o);
const batch = (list) => () => JSON.stringify(list);
const LEGACY_BELIEF = "It is about the viewer's problem or situation, never about the brand's product or features.";
const PRODUCT_RULE = /never about the brand's product or features/;
const STAY = "STAY IN THE AUDIENCE'S WORLD, NOT THE PRODUCT'S:";
const BG_ONLY = 'Background only: mention at most one of these';
const FEATURES_LINE = "Talk about the viewer's problem, not the brand's features.";

// ═════ 1. the pure helpers (_brain) ═════
{
  const D = B.DEFAULT_TYPE_MIX;
  ok(JSON.stringify(D) === '{"tip":3,"about":1,"news":1,"qna":1,"story":1,"bts":0}' && B.POST_TYPES.join() === 'tip,about,news,qna,story,bts', 'DEFAULT_TYPE_MIX and the six ids match the plan');
  ok(JSON.stringify(B.validTypeMix({ tip: 2, news: 1 })) === '{"tip":2,"about":0,"news":1,"qna":0,"story":0,"bts":0}', 'a partial mix: missing keys are 0');
  ok(B.validTypeMix({ tip: 11 }) === null && B.validTypeMix({ tip: -1 }) === null && B.validTypeMix({ tip: 1.5 }) === null && B.validTypeMix({ tip: '3' }) === null, 'values outside integers 0..10 make the mix invalid');
  ok(B.validTypeMix({ tip: 0 }) === null && B.validTypeMix({ foo: 3 }) === null && B.validTypeMix([3]) === null && B.validTypeMix(null) === null, 'a zero total, no known key, an array or null are invalid');
  ok(JSON.stringify(B.validTypeMix({ tip: 10, bts: 0, extra: 99 })) === '{"tip":10,"about":0,"news":0,"qna":0,"story":0,"bts":0}', 'the max 10 is valid; unknown keys are ignored');
  const sc = (m, n) => JSON.stringify(B.scaleTypeMix(m, n));
  ok(sc(D, 7) === JSON.stringify(D), 'scaling the default to 7 is exactly the default');
  ok(sc(D, 3) === '{"tip":1,"about":1,"news":1,"qna":0,"story":0,"bts":0}', 'scaled to 3 by largest remainders, ties to the earlier type (' + sc(D, 3) + ')');
  ok(sc(D, 10) === '{"tip":4,"about":2,"news":2,"qna":1,"story":1,"bts":0}', 'scaled to 10 (' + sc(D, 10) + ')');
  ok(sc({ tip: 1, bts: 1 }, 1) === '{"tip":1,"about":0,"news":0,"qna":0,"story":0,"bts":0}' && sc({ story: 5, qna: 5 }, 4) === '{"tip":0,"about":0,"news":0,"qna":2,"story":2,"bts":0}', 'scaling always sums to n');
  for (let n = 1; n <= 10; n++) { const s = B.scaleTypeMix({ tip: 3, about: 2, news: 5, bts: 1 }, n); ok(Object.values(s).reduce((a, b) => a + b, 0) === n, 'scaled total = ' + n); }
  ok(B.typeSlots(D).join() === 'tip,tip,tip,about,news,qna,story', 'the slot order');
  // freshNews: the stored auto_trends shape { at, items:[{text, source, link, ts, hot}] }
  const at = { at: NOW - 3 * DAY, items: [
    { text: 'Older headline six days ago here', source: 'Paper', link: 'https://n/1', ts: NOW - 6 * DAY },
    { text: 'Newest headline from yesterday here', source: 'Paper', link: 'https://n/2', ts: NOW - 1 * DAY },
    { text: 'Stale headline eight days ago here', source: 'Paper', link: 'https://n/3', ts: NOW - 8 * DAY },
    { text: 'A headline with no link at all here', source: 'Paper', link: '', ts: NOW - DAY },
    { text: 'A tweet that is not news at all', source: '@someone · X', link: 'https://x.com/s/1', ts: NOW - DAY },
    { text: 'Undated headline takes the pull time', source: 'Paper', link: 'https://n/4' },
    { text: 'A headline the user dismissed here', source: 'Paper', link: 'https://n/5', ts: NOW - DAY },
  ] };
  const fn = B.freshNewsFrom(at, NOW, ['a headline the user dismissed here']);
  ok(fn.map(x => x.title).join('|') === 'Newest headline from yesterday here|Undated headline takes the pull time|Older headline six days ago here', 'freshNews: newest first, <= 7 days, links only, no X posts, no dismissed (' + fn.map(x => x.title).join('|') + ')');
  ok(fn[1].date === at.at && fn.every(x => x.url && x.date && Object.keys(x).every(k => ['title', 'url', 'date', 'source'].includes(k))), 'freshNews items are {title, url, date, source}; an undated item is dated by the pull time');
  const many = { at: NOW, items: Array.from({ length: 12 }, (_, i) => ({ text: 'Headline number ' + i + ' here', link: 'https://n/' + i, ts: NOW - i * 3600000 })) };
  ok(B.freshNewsFrom(many, NOW).length === 8, 'freshNews keeps at most 8');
  ok(B.freshNewsFrom(null, NOW).length === 0 && B.freshNewsFrom({ at: NOW }, NOW).length === 0, 'no stored trends -> no fresh news');
}

// ═════ 2. the brand row (_brandctx) ═════
{
  const row = (ve, atr) => CTX.contextFromBrandRow({ brand_name: 'A', voice_extra: ve, auto_trends: atr });
  ok(JSON.stringify(row({}).typeMix) === JSON.stringify(B.DEFAULT_TYPE_MIX), 'bc.typeMix: none saved -> the default');
  ok(JSON.stringify(row({ typeMix: { tip: 50 } }).typeMix) === JSON.stringify(B.DEFAULT_TYPE_MIX), 'bc.typeMix: an invalid saved mix -> the default');
  ok(JSON.stringify(row({ typeMix: { tip: 2, about: 2 } }).typeMix) === '{"tip":2,"about":2,"news":0,"qna":0,"story":0,"bts":0}', 'bc.typeMix: a valid saved mix is used');
  const fr = row({}, { at: NOW, items: [{ text: 'Fresh headline from today here', link: 'https://n/1', ts: NOW - 3600000, source: 'P' }, { text: 'Old headline from last month', link: 'https://n/2', ts: NOW - 30 * DAY }] }).freshNews;
  ok(fr.length === 1 && fr[0].title === 'Fresh headline from today here' && fr[0].url === 'https://n/1', 'bc.freshNews built from auto_trends with the age filter');
  const base = row({ painPoints: 'x' });
  ok(CTX.populatedFieldCount(base) === CTX.populatedFieldCount(Object.assign({}, base, { typeMix: { tip: 3 }, freshNews: [{ title: 't' }] })), 'typeMix / freshNews do not count as brand fields (the 424 thin check is unchanged)');
}

// ═════ 3. generate-ideas ═════
// 3a. no typeMix, no postType -> the prompt and behaviour of before types
setHydrated();
{
  const r = await run('ideas', { brandId: 'b1', count: 5, gaps: [{ day: 'Monday', format: 'qna' }, { day: 'Tuesday', format: 'qna' }] },
    batch([idea({ title: 'A' }), idea({ title: 'B', format: 'qna' })]));
  const P = (calls[0] || {}).prompt || '';
  ok(r.statusCode === 200 && calls.length === 1, 'untyped: one call, 200');
  ok(!/POST TYPES FOR THIS BATCH|"postType"|newsIndex|FRESH HEADLINES|KIND OF POST/.test(P) && !P.includes(NEWS[0].title), 'untyped: no type block, no postType key, no headlines in the prompt');
  ok(P.includes(LEGACY_BELIEF) && P.includes(STAY) && P.includes(FEATURES_LINE) && P.includes(BG_ONLY) && !/EXCEPT THE "about"/.test(P), 'untyped: every product rule is there, unscoped');
  ok(/At least 1 of the 5 ideas should use the "qna" format/.test(P), 'untyped: the qna gap quota still works');
  ok(/exactly 5 ideas/.test(P), 'untyped: count 5');
  const I = r.body.ideas || [];
  ok(I.length === 2 && I[0].postType === 'tip' && I[1].postType === 'qna' && I.every(x => !('newsSource' in x)), 'untyped: every idea gets postType (tip, qna for a Q&A-format idea), never newsSource');
  ok(JSON.stringify(r.body.warnings) === '[]', 'untyped: no type warning');
}
// 3b. the default mix, no count -> 7 ideas, exact slot counts, headlines only because there is a news slot
{
  const out = [idea({ title: 'n', postType: 'news', newsIndex: 2, newsSource: { title: 'FAKE', url: 'https://evil.example' } }), idea({ title: 'q', postType: 'qna', format: 'video' }),
    idea({ title: 't1', postType: 'tip' }), idea({ title: 't2', postType: 'tip' }), idea({ title: 't3', postType: 'tip' }), idea({ title: 'a', postType: 'about' }), idea({ title: 's', postType: 'story' })];
  const r = await run('ideas', { brandId: 'b1', typeMix: B.DEFAULT_TYPE_MIX, gaps: [{ day: 'Monday', format: 'qna' }] }, batch(out));
  const P = (calls[0] || {}).prompt || '';
  ok(r.statusCode === 200 && /exactly 7 ideas/.test(P), 'mix without count: asks for the mix total (7)');
  ok(P.includes('POST TYPES FOR THIS BATCH (exact counts, not a suggestion): tip x3, about x1, news x1, qna x1, story x1.'), 'mix: the prompt lists the exact slot counts');
  ok(P.includes('1=tip, 2=tip, 3=tip, 4=about, 5=news, 6=qna, 7=story'), 'mix: the prompt lists the slot order');
  ok(!P.includes('bts:') && P.includes('- news: ' + W.TYPE_RULES.news) && P.includes('- about: ' + W.TYPE_RULES.about) && P.includes('- story: ' + W.TYPE_RULES.story), 'mix: the rules of the used types only');
  ok(P.includes('1. "' + NEWS[0].title + '"') && P.includes('2. "' + NEWS[1].title + '"') && /"newsIndex"/.test(P), 'mix: the stored headlines are numbered in the prompt, with the newsIndex key');
  ok(/"postType": "tip\|about\|news\|qna\|story\|bts/.test(P), 'mix: the schema asks for postType');
  ok(!/At least \d+ of the 7 ideas should use the "qna"/.test(P), 'mix: the old qna-gap quota does not fight the mix');
  const I = r.body.ideas || [];
  ok(I.length === 7 && I.every(x => B.POST_TYPES.includes(x.postType)), 'mix: every idea carries a postType');
  const n = I.find(x => x.title === 'n');
  ok(n && n.postType === 'news' && JSON.stringify(n.newsSource) === JSON.stringify({ title: NEWS[1].title, url: NEWS[1].url }), 'news: newsSource is the STORED headline #2 (the model\'s own newsSource is ignored)');
  const q = I.find(x => x.title === 'q');
  ok(q && q.postType === 'qna' && q.format === 'qna', 'qna: a qna idea is forced to format qna');
  ok(I.filter(x => x.newsSource).length === 1, 'only the news idea has a newsSource');
  const counts = B.POST_TYPES.map(k => I.filter(x => x.postType === k).length).join();
  ok(counts === '3,1,1,1,1,0', 'mix: the returned types match the mix (' + counts + ')');
}
// 3c. the model mislabels: the server keeps the batch inside the mix (by slot)
{
  const r = await run('ideas', { brandId: 'b1', typeMix: { tip: 1, about: 1, story: 1 } }, batch([idea({ postType: 'tip' }), idea({ postType: 'tip' }), idea({ postType: 'banana' })]));
  const I = r.body.ideas || [];
  ok(I.map(x => x.postType).join() === 'tip,about,story', 'a mislabelled batch is re-labelled into the open slots (' + I.map(x => x.postType).join() + ')');
}
// 3d. scaling: a count with a mix
{
  const r = await run('ideas', { brandId: 'b1', typeMix: B.DEFAULT_TYPE_MIX, count: 3 }, batch([idea({ postType: 'tip' })]));
  const P = (calls[0] || {}).prompt || '';
  ok(/exactly 3 ideas/.test(P) && P.includes(': tip x1, about x1, news x1.') && P.includes('1=tip, 2=about, 3=news'), 'mix + count 3: scaled by largest remainders');
  const r2 = await run('ideas', { brandId: 'b1', typeMix: { tip: 7, qna: 7 } }, batch([idea({ postType: 'tip' })]));
  const P2 = (calls[0] || {}).prompt || '';
  ok(r2.statusCode === 200 && /exactly 10 ideas/.test(P2) && P2.includes(': tip x5, qna x5.'), 'a mix totalling 14 is clamped to MAX_IDEAS 10 and scaled');
}
// 3e. about: the product rules are lifted ONLY for about slots
{
  await run('ideas', { brandId: 'b1', postType: 'about', count: 2 }, batch([idea({ postType: 'about' })]));
  const PA = (calls[0] || {}).prompt || '';
  ok(!PRODUCT_RULE.test(PA) && !PA.includes(STAY) && !PA.includes(FEATURES_LINE) && !PA.includes(BG_ONLY), 'about only: every "never about the product" rule is absent');
  ok(PA.includes(B.ABOUT_BG_NOTE) && /ABOUT US, IN THE VIEWER'S WORDS/.test(PA) && PA.includes(B.NO_INVENTION_RULE) && /never a feature list/.test(PA), 'about only: the about rule replaces it, the no-invention rule stays');
  await run('ideas', { brandId: 'b1', postType: 'tip', count: 2 }, batch([idea({ postType: 'tip' })]));
  const PT = (calls[0] || {}).prompt || '';
  ok(PT.includes(LEGACY_BELIEF) && PT.includes(STAY) && PT.includes(FEATURES_LINE) && PT.includes(BG_ONLY) && !PT.includes(B.ABOUT_BG_NOTE) && !/EXCEPT THE "about"/.test(PT), 'tip only: every product rule is present, unscoped');
  await run('ideas', { brandId: 'b1', typeMix: { tip: 2, about: 1 } }, batch([idea({ postType: 'tip' })]));
  const PM = (calls[0] || {}).prompt || '';
  ok(PM.includes('EVERY IDEA EXCEPT THE "about" ONES — ' + STAY) && /never about the brand's product or features \(except the "about" ideas/.test(PM) && PM.includes(FEATURES_LINE) && PM.includes(BG_ONLY) && /THE "about" IDEAS ARE THE ONE EXCEPTION/.test(PM), 'mixed: the product rules stay, scoped to every idea except the about ones');
}
// 3f. news: invalid index -> converted to tip; no fresh news -> no news slot + warning
{
  const r = await run('ideas', { brandId: 'b1', typeMix: { tip: 1, news: 3 } }, batch([idea({ title: 'x0', postType: 'news', newsIndex: 0 }), idea({ title: 'x9', postType: 'news', newsIndex: 9 }), idea({ title: 'xs', postType: 'news', newsIndex: 'one' }), idea({ title: 'ok', postType: 'news', newsIndex: 1 })]));
  const I = r.body.ideas || [];
  ok(I.filter(x => x.postType === 'news').length === 1 && I.find(x => x.title === 'ok').newsSource.url === NEWS[0].url, 'news: the one valid index keeps its stored headline');
  ok(['x0', 'x9', 'xs'].every(t => !I.find(i => i.title === t)) && I.length === 1 && (r.body.warnings || []).includes('news_dropped'), 'news r2: an idea written as news with an invalid index (0, 9, "one") is DROPPED, warnings news_dropped');
  const rk = await run('ideas', { brandId: 'b1', typeMix: { tip: 1, news: 1 } }, batch([idea({ title: 'plain', postType: 'tip' }), idea({ title: 'slotted', postType: 'tip' })]));
  ok((rk.body.ideas || []).length === 2 && rk.body.ideas.every(x => x.postType === 'tip') && !(rk.body.warnings || []).includes('news_dropped'), 'news r2: an idea the server only PLACED in a news slot (not written as news) keeps its text as a tip');
  const rf = await run('ideas', { brandId: 'b1', typeMix: { tip: 1, news: 1 } }, batch([idea({ title: 'N1', postType: 'news', newsIndex: 1 }), idea({ title: 'N2', postType: 'news', newsIndex: 2 })]));
  ok((rf.body.ideas || []).map(x => x.postType + ':' + (x.newsSource && x.newsSource.url)).join() === 'news:' + NEWS[0].url + ',news:' + NEWS[1].url, 'news r2: an idea written as news about a real headline stays news (never relabelled a tip)');
  setHydrated({ freshNews: [] });
  const r2 = await run('ideas', { brandId: 'b1', typeMix: { tip: 1, news: 1 } }, batch([idea({ postType: 'news', newsIndex: 1 }), idea({ postType: 'tip' })]));
  const P2 = (calls[0] || {}).prompt || '';
  ok(P2.includes(': tip x2.') && !/FRESH HEADLINES|newsIndex|- news:/.test(P2), 'no fresh news: the news slot becomes a tip before the model is asked');
  ok((r2.body.ideas || []).every(x => x.postType === 'tip' && !x.newsSource) && (r2.body.warnings || []).includes('no_fresh_news'), 'no fresh news: no news idea, warnings says no_fresh_news');
  // a USER's body-sent brandContext is never a news source; the internal cron's (it hydrated it) is
  const r3 = await run('ideas', { brandContext: Object.assign({}, BC, { freshNews: NEWS }), typeMix: { news: 1 } }, batch([idea({ postType: 'news', newsIndex: 1 })]));
  ok((r3.body.warnings || []).includes('no_fresh_news') && !r3.body.ideas[0].newsSource, 'a user-sent brandContext.freshNews is ignored');
  const r4 = await run('ideas', { brandContext: Object.assign({}, BC, { freshNews: NEWS }), typeMix: { news: 1 }, forUserId: 'u9' }, batch([idea({ postType: 'news', newsIndex: 1 })]), { authorization: 'Bearer cron-test' });
  ok(r4.statusCode === 200 && r4.body.ideas[0].newsSource && r4.body.ideas[0].newsSource.url === NEWS[0].url, 'the internal cron\'s hydrated freshNews is used');
  setHydrated();
  const r5 = await run('ideas', { brandId: 'b1', typeMix: { news: 1 }, newsDismissed: [NEWS[0].title.toLowerCase()] }, batch([idea({ postType: 'news', newsIndex: 1 })]));
  ok(r5.body.ideas[0].newsSource && r5.body.ideas[0].newsSource.url === NEWS[1].url && !calls[0].prompt.includes(NEWS[0].title), 'a headline the user dismissed is left out');
  const stale = [{ title: 'A headline from ten days ago', url: 'https://n/old', date: NOW - 10 * DAY }];
  setHydrated({ freshNews: stale });
  const r6 = await run('ideas', { brandId: 'b1', typeMix: { news: 1 } }, batch([idea({ postType: 'news', newsIndex: 1 })]));
  ok((r6.body.warnings || []).includes('no_fresh_news'), 'the age filter is applied again at generate time');
  setHydrated();
}
// 3f2. types r2 — the FACT GUARD on every batch idea (about / news / legacy), no extra AI call
{
  const noSlot = (t) => String(t || '').replace(/\[your story:[^\]]*\]/g, '');
  const INV = 'Acme Salts has 3x more sodium than any competitor and is clinically proven to stop cramps in 94% of runners.';
  const r = await run('ideas', { brandId: 'b1', typeMix: { about: 1 } }, batch([idea({ postType: 'about', hook: 'We have 3x more sodium.', script: 'Our sticks carry ZPROD 500mg sodium. ' + INV, caption: 'Stocked in 400 gyms.', boldText: 'Harvard found it works.' })]));
  const I = (r.body.ideas || [])[0] || {};
  ok(calls.length === 1, 'fact guard: no extra AI call');
  ok(/500mg sodium/.test(noSlot(I.script)) && !/3x|94%|clinically/.test(noSlot(I.script)) && /\[your story:/.test(I.script), 'about: a real product fact stays, the invented 3x / clinically proven / 94% become a slot');
  ok(!/400/.test(noSlot(I.caption)) && /\[your story:/.test(I.caption) && !/Harvard/.test(noSlot(I.boldText)) && /\[your story:/.test(I.boldText), 'the caption and boldText are guarded too');
  ok(I.hook === 'Our sticks carry ZPROD 500mg sodium.', 'an inventing hook falls back to the first spoken line of the guarded script (' + I.hook + ')');
  const NI = 'Walmart pulled 4,000 SKUs of Gatorade yesterday, CEO Doug McMillon said sugar is dead.';
  const rn = await run('ideas', { brandId: 'b1', typeMix: { news: 1 } }, batch([idea({ postType: 'news', newsIndex: 1, script: 'Electrolyte sales rose 40% this year. ' + NI })]));
  const N = (rn.body.ideas || [])[0] || {};
  ok(/rose 40% this year/.test(noSlot(N.script)) && !/Walmart|4,000|McMillon/.test(noSlot(N.script)), 'news: the attached headline\'s own facts stay, details it never said become a slot');
  const rt = await run('ideas', { brandId: 'b1', typeMix: { tip: 1 } }, batch([idea({ postType: 'tip', script: 'Electrolyte sales rose 40% this year. Drink water.' })]));
  ok(!/40%/.test(noSlot(rt.body.ideas[0].script)), 'the headline is allowed material for its news idea ONLY (a tip citing it is slotted)');
  const rs = await run('ideas', { brandId: 'b1', typeMix: { story: 1 } }, batch([idea({ postType: 'story', script: 'A runner who cramped at mile 20 changed my mind. Anna said it saved her race.' })]));
  ok(/mile 20/.test(noSlot(rs.body.ideas[0].script)) && !/Anna/.test(noSlot(rs.body.ideas[0].script)), 'story: the story bank is allowed, an invented customer is slotted');
  const rc = await run('ideas', { brandId: 'b1', brandContext: { usps: 'We have 3x more sodium', socialProof: 'in 400 gyms' }, typeMix: { about: 1 } }, batch([idea({ postType: 'about', script: 'We have 3x more sodium. We are in 400 gyms.' })]));
  ok(!/3x|400/.test(noSlot(rc.body.ideas[0].script)), 'lean request: a client-sent brandContext never widens the allowed facts');
  const rl = await run('ideas', { brandId: 'b1', count: 1 }, batch([idea({ script: 'Most people drink water. ' + INV })]));
  const L = (rl.body.ideas || [])[0] || {};
  ok(!/94%/.test(noSlot(L.script)) && /Most people drink water\./.test(L.script) && Object.keys(L).sort().join() === 'belief,caption,community,day,emphasis,format,hook,postType,reelTitle,script,shots,tags,title,tone', 'an untyped (old) request is guarded too, same JSON shape');
  const rsd = await run('ideas', { brandId: 'b1', count: 1, seedIdea: 'our plan costs $29 a month' }, batch([idea({ script: 'It costs $29 a month. That matters.' })]));
  ok(/\$29 a month/.test(noSlot(rsd.body.ideas[0].script)), 'the user\'s own dropped idea is allowed material');
  const rnd = await run('ideas', { brandId: 'b1', count: 1 }, batch([idea({ script: 'It costs $29 a month. That matters.' })]));
  ok(!/\$29/.test(noSlot(rnd.body.ideas[0].script)), '...and without it the same price is slotted');
}
// 3g. bad input
{
  const r = await run('ideas', { brandId: 'b1', postType: 'gossip' });
  const r2 = await run('ideas', { brandId: 'b1', typeMix: { tip: 20 } });
  ok(r.statusCode === 400 && r2.statusCode === 400 && r.body.code === 'bad_input' && calls.length === 0, 'an unknown postType or an invalid typeMix is a 400, before any AI call');
}

// ═════ 4. /api/angles ═════
const ANG = (list) => () => JSON.stringify({ angles: list });
{
  const r = await run('angles', { brandId: 'b1', postType: 'news', source: { kind: 'note', text: '' } },
    ANG([{ belief: 'Most people drink too little salt', why: 'w', newsIndex: 1 }, { belief: 'Sugar is not fuel for a desk job', why: 'w', newsIndex: 2 }, { belief: 'Nobody needs a sports drink to walk', why: 'w', newsIndex: 7 }, { belief: 'Cramping is rarely about water', why: 'w' }]));
  const P = (calls[0] || {}).prompt || '';
  ok(r.statusCode === 200 && P.includes('1. "' + NEWS[0].title + '"') && /"newsIndex":1/.test(P) && P.includes(W.TYPE_RULES.news), 'angles news: stored headlines + the news rule in the prompt (no other source needed)');
  const A = r.body.angles || [];
  ok(A.length === 2 && A[0].newsSource.url === NEWS[0].url && A[1].newsSource.url === NEWS[1].url && A.every(a => a.postType === 'news' && !('newsIndex' in a)), 'angles news: newsSource attached by index; invalid/missing index dropped');
  setHydrated({ freshNews: [] });
  const r2 = await run('angles', { brandId: 'b1', postType: 'news', source: { kind: 'note', text: 'x' } });
  ok(r2.statusCode === 409 && r2.body.code === 'no_news' && /no fresh news/i.test(r2.body.error) && calls.length === 0, 'angles news with no fresh headline: 409 no_news, no AI call');
  const r3 = await run('angles', { brandContext: Object.assign({}, BC, { freshNews: NEWS }), postType: 'news', source: { kind: 'note', text: 'x' } });
  ok(r3.statusCode === 409 && r3.body.code === 'no_news', 'angles: a body-sent brandContext.freshNews is never trusted');
  setHydrated();
  const good = ANG([{ belief: 'Salt timing beats salt amount', why: 'w' }, { belief: 'Most cramps start before the race', why: 'w' }, { belief: 'Plain water can make it worse', why: 'w' }]);
  const ra = await run('angles', { brandId: 'b1', postType: 'about', source: { kind: 'note', text: 'x' } }, good);
  const PA = (calls[0] || {}).prompt || '';
  ok(!PRODUCT_RULE.test(PA) && !PA.includes(BG_ONLY) && PA.includes(B.ABOUT_BG_NOTE) && PA.includes(W.TYPE_RULES.about) && ra.body.angles.every(a => a.postType === 'about'), 'angles about: the product rule is lifted');
  const rt = await run('angles', { brandId: 'b1', source: { kind: 'note', text: 'x' } }, good);
  const PT = (calls[0] || {}).prompt || '';
  ok(PRODUCT_RULE.test(PT) && PT.includes(BG_ONLY) && !/EVERY BELIEF IS FOR THIS KIND OF POST/.test(PT) && rt.body.angles.every(a => !('postType' in a) && !('newsSource' in a)), 'angles untyped: unchanged prompt and angle shape');
  const rs = await run('angles', { brandId: 'b1', postType: 'story', source: { kind: 'note', text: 'x' } }, good);
  ok(calls[0].prompt.includes(W.TYPE_RULES.story) && PRODUCT_RULE.test(calls[0].prompt) && rs.body.angles.every(a => a.postType === 'story'), 'angles story: the story rule, product rule kept');
  const rb = await run('angles', { brandId: 'b1', postType: 'nope', source: { kind: 'note', text: 'x' } });
  ok(rb.statusCode === 400 && rb.body.code === 'bad_input', 'angles: an unknown postType is a 400');
}

// ═════ 5. /api/write ═════
{
  const DRAFT = 'Sales in the category rose 40% this year, per the headline. Most people still guess their salt. Sales rose 73% for us.';
  const wplan = (i, p) => (/^Below is a finished/.test(p) ? '{}' : (/^Rewrite this/.test(p) ? '' : DRAFT));
  const ANGLE = { belief: 'Salt timing beats salt amount', why: 'w', newsSource: { title: NEWS[0].title, url: NEWS[0].url } };
  const r = await run('write', { brandId: 'b1', postType: 'news', source: { kind: 'note', text: '' }, angle: ANGLE }, wplan);
  const P = (calls[0] || {}).prompt || '';
  ok(r.statusCode === 200 && P.includes('THE NEWS THIS POST REACTS TO') && P.includes('"' + NEWS[0].title + '"') && P.includes('Link: ' + NEWS[0].url) && P.includes('KIND OF POST. ' + W.TYPE_RULES.news), 'write news: the stored headline + link + the news rule in the draft prompt');
  const I = (r.body && r.body.idea) || {};
  ok(I.postType === 'news' && JSON.stringify(I.newsSource) === JSON.stringify({ title: NEWS[0].title, url: NEWS[0].url }), 'write news: idea.postType news + newsSource from the stored headline');
  const noSlots = String(I.script || '').replace(/\[your story:[^\]]*\]/g, '');
  ok(/rose 40% this year/.test(noSlots) && !/73%/.test(noSlots) && /\[your story:/.test(I.script || ''), 'write news: the fact guard still runs — the headline\'s 40% stays, the invented 73% becomes a slot');
  const r2 = await run('write', { brandId: 'b1', postType: 'news', source: { kind: 'note', text: 'x' }, angle: Object.assign({}, ANGLE, { newsSource: { title: 'Gone', url: 'https://news.example/gone' } }) }, wplan);
  ok(r2.statusCode === 409 && r2.body.code === 'no_news' && calls.length === 0, 'write news: a headline that is no longer fresh -> 409 no_news, no AI call');
  const r2b = await run('write', { brandId: 'b1', postType: 'news', source: { kind: 'note', text: 'x' }, angle: { belief: 'b', why: 'w' } }, wplan);
  ok(r2b.statusCode === 200 && r2b.body.idea.newsSource.url === NEWS[0].url, 'write news with no headline named: the newest stored one');
  setHydrated({ freshNews: [] });
  const r3 = await run('write', { brandId: 'b1', postType: 'news', source: { kind: 'note', text: 'x' }, angle: ANGLE }, wplan);
  ok(r3.statusCode === 409 && r3.body.code === 'no_news' && calls.length === 0, 'write news with no fresh headline: 409 no_news');
  setHydrated();
  const plain = (i, p) => (/^Below is a finished/.test(p) ? '{}' : (/^Rewrite this/.test(p) ? '' : 'People guess their salt. Timing matters more.'));
  const r4 = await run('write', { brandId: 'b1', source: { kind: 'note', text: 'x' }, angle: { belief: 'b', why: 'w' } }, plain);
  ok(r4.statusCode === 200 && r4.body.idea.postType === 'tip' && !('newsSource' in r4.body.idea) && !/KIND OF POST/.test(calls[0].prompt) && calls[0].prompt.includes(FEATURES_LINE), 'write untyped: postType tip, prompt unchanged');
  const r5 = await run('write', { brandId: 'b1', postType: 'about', source: { kind: 'note', text: 'x' }, angle: { belief: 'b', why: 'w' } }, plain);
  const PA = calls[0].prompt;
  ok(r5.body.idea.postType === 'about' && !PA.includes(FEATURES_LINE) && !PA.includes(BG_ONLY) && PA.includes(B.ABOUT_BG_NOTE) && PA.includes(B.NO_INVENTION_RULE), 'write about: the product rules lifted, no-invention kept');
  const r6 = await run('write', { brandId: 'b1', postType: 'qna', source: { kind: 'note', text: 'x' }, angle: { belief: 'b', why: 'w' } }, plain);
  ok(r6.body.idea.postType === 'qna' && calls[0].prompt.includes(W.TYPE_RULES.qna) && calls[0].prompt.includes(FEATURES_LINE), 'write qna: the qna rule, product rule kept');
  const r7 = await run('write', { brandId: 'b1', postType: 'x', source: { kind: 'note', text: 'x' }, angle: { belief: 'b', why: 'w' } }, plain);
  ok(r7.statusCode === 400 && r7.body.code === 'bad_input', 'write: an unknown postType is a 400');
}

// ═════ 6. send-daily (virtual-clock harness) ═════
{
  const { createHarness } = await import('./_send-daily-harness.mjs');
  const Hs = createHarness(ROOT);
  const { run: sd, ACTIVE, pendingRows, mkIdea } = Hs;
  const r = await sd({ rows: ACTIVE });
  const gb = (r.gens[0] || {}).body || {};
  ok(gb.count === 7 && JSON.stringify(gb.typeMix) === JSON.stringify(B.DEFAULT_TYPE_MIX), 'send-daily: 7 wanted, no saved mix -> exactly the default mix (' + JSON.stringify(gb.typeMix) + ')');
  const r2 = await sd({ rows: ACTIVE.concat(pendingRows(4)) });
  const gb2 = (r2.gens[0] || {}).body || {};
  const dayIdx = Math.floor(Date.now() / DAY);
  ok(gb2.count === 3 && JSON.stringify(gb2.typeMix) === JSON.stringify(B.topUpMix(B.DEFAULT_TYPE_MIX, 3, dayIdx)), 'send-daily: 3 wanted -> 3 slots of the mix cycle at today\'s rotating offset (' + JSON.stringify(gb2.typeMix) + ')');
  const r2b = await sd({ rows: ACTIVE.concat(pendingRows(6)) });
  const gb2b = (r2b.gens[0] || {}).body || {};
  ok(gb2b.count === 1 && JSON.stringify(gb2b.typeMix) === JSON.stringify(B.topUpMix(B.DEFAULT_TYPE_MIX, 1, dayIdx)), 'send-daily: a 1-idea top-up follows the rotation');
  // the source link rides in the saved caption, in the form app.html reads back
  const APP_RE = /(?:^|\n)Source: (https:\/\/\S+)\s*$/;
  const newsGen = (rq) => ({ status: 200, body: { ideas: [
    Object.assign(mkIdea('News one', rq.body.gaps[0].day), { postType: 'news', newsSource: { title: 'H', url: 'https://news.example/a' } }),
    Object.assign(mkIdea('News http', rq.body.gaps[0].day), { postType: 'news', newsSource: { title: 'H', url: 'http://news.example/b' } }),
    Object.assign(mkIdea('Tip one', rq.body.gaps[0].day), { postType: 'tip', newsSource: { title: 'H', url: 'https://news.example/c' } }),
    Object.assign(mkIdea('News twice', rq.body.gaps[0].day), { postType: 'news', caption: 'See https://news.example/d', newsSource: { title: 'H', url: 'https://news.example/d' } }) ] } });
  const rsrc = await sd({ rows: ACTIVE, gen: newsGen });
  const srows = ((rsrc.inserts[0] || {}).body) || [];
  const cap = (t) => (srows.find(x => x.title === t) || {}).caption;
  ok(cap('News one') === 'Post less.\n\nSource: https://news.example/a' && (APP_RE.exec(cap('News one')) || [])[1] === 'https://news.example/a', 'send-daily: a news idea\'s link is appended to the caption exactly as the app parses it back');
  ok(cap('News http') === 'Post less.' && cap('Tip one') === 'Post less.' && cap('News twice') === 'See https://news.example/d', 'send-daily: no link for http, a non-news idea, or a caption that already carries it');
  // the 7-day simulation: small top-ups follow the mix over a week
  for (const n of [1, 2]) {
    const tot = {}; const seen = new Set();
    for (let d = 0; d < 7; d++) { const m = B.topUpMix(B.DEFAULT_TYPE_MIX, n, dayIdx + d); for (const k of B.POST_TYPES) { tot[k] = (tot[k] || 0) + m[k]; if (m[k]) seen.add(k); } ok(Object.values(m).reduce((a, b) => a + b, 0) === n, 'top-up day ' + d + ' sums to ' + n); }
    ok(B.POST_TYPES.every(k => tot[k] === B.DEFAULT_TYPE_MIX[k] * n), 'over 7 days, ' + n + '-idea top-ups follow the mix exactly (' + JSON.stringify(tot) + ')');
    ok(['tip', 'about', 'news', 'qna', 'story'].every(k => seen.has(k)) && !seen.has('bts'), 'over 7 days every non-zero type appears (n=' + n + ')');
  }
  ok(JSON.stringify(B.topUpMix(B.DEFAULT_TYPE_MIX, 7, 123)) === JSON.stringify(B.DEFAULT_TYPE_MIX) && JSON.stringify(B.topUpMix(B.DEFAULT_TYPE_MIX, 1, 5)) === JSON.stringify(B.topUpMix(B.DEFAULT_TYPE_MIX, 1, 5)), 'a full top-up is the scaled mix; the rotation is deterministic');
  // the brand's own saved mix (re-stub the hydrator this unit reads)
  Hs.stub('_brandctx.js', { loadBrandContext: async (id) => ({ ok: true, bc: { brandName: 'Acme', brandId: id, typeMix: { tip: 0, about: 0, news: 0, qna: 0, story: 2, bts: 5 }, dayRotation: {} } }) });
  const withType = (rq) => ({ status: 200, body: { ideas: rq.body.gaps.map((g, k) => Object.assign(mkIdea('Typed ' + k, g.day), { postType: k === 0 ? 'story' : (k === 1 ? 'weird' : 'bts') })) } });
  const r3 = await sd({ rows: ACTIVE, gen: withType });
  const gb3 = (r3.gens[0] || {}).body || {};
  ok(JSON.stringify(gb3.typeMix) === '{"tip":0,"about":0,"news":0,"qna":0,"story":2,"bts":5}', 'send-daily: the brand\'s saved mix is sent');
  const rows = ((r3.inserts[0] || {}).body) || [];
  ok(rows.length === 7 && rows[0].post_type === 'story' && !('post_type' in rows[1]) && rows[2].post_type === 'bts', 'send-daily: post_type is inserted (only a known type)');
  let n = 0;
  const r4 = await sd({ rows: ACTIVE, gen: withType, insert: () => (n++ === 0 ? { status: 400, body: { code: 'PGRST204', message: "Could not find the 'post_type' column of 'ideas' in the schema cache" } } : { status: 201, body: null }) });
  const second = ((r4.inserts[1] || {}).body) || [];
  ok(r4.inserts.length === 2 && second.length === 7 && second.every(x => !('post_type' in x)) && second.every(x => x.gen_flow === 'daily'), 'send-daily: a missing post_type column -> retried without it (gen_flow kept)');
  let m = 0;
  const three = ['emphasis', 'gen_flow', 'post_type'];
  const r5 = await sd({ rows: ACTIVE, gen: withType, insert: () => (m < 3 ? { status: 400, body: { code: '42703', message: 'column "' + three[m++] + '" of relation "ideas" does not exist' } } : { status: 201, body: null }) });
  ok(r5.inserts.length === 4 && r5.heartbeats[0] && r5.heartbeats[0].detail.ideaSaved === 7, 'send-daily: all three optional columns missing -> still saved on the 4th attempt');
}

clearTimeout(WALL);
if (failed) { console.log('types-server: ' + passed + ' passed, ' + failed + ' failed'); process.exit(1); }
console.log('TYPES SERVER OK — ' + passed + ' checks');
