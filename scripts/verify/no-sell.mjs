#!/usr/bin/env node
// GATE no-sell — "the content can not be salesy never. it needs to be entertaining and educational."
// (.unlazy/no-sell). Proves, with the REAL api/_write.js, api/_brain.js and every post-writing handler:
//   1. every post-writing prompt carries the ONE shared NO_SELL_RULE (and NO_INVENTION_RULE still);
//   2. the "about us" type is a story or a lesson (why / how it is made / the problem / a myth), never
//      the product pitched to the viewer, in TYPE_RULES and in the ideas batch;
//   3. ctaStyle is passed as TONE only, with the never-copy-a-sales-ask note, and the crawlers /
//      settings helpers ask for engagement CTAs only;
//   4. guardNoSell blocks sales asks and keeps educational / entertaining text (tricky pairs included);
//   5. every writer's OUTPUT path runs the guard: a stubbed model that sells comes back clean, and the
//      one retry for a pitch-at-its-core draft is shared with the existing retry (one usage row).
// Only the edges are stubbed: callLLM (captures prompts, answers from a per-scenario plan, zero
// network), the usage meter, the session, the brand hydration and the access check.
//
// RUN:    node scripts/verify/no-sell.mjs
// EXPECT: prints "NO SELL OK" and exits 0.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const Module = require_('module');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = path.join(ROOT, 'api');
const WALL = setTimeout(() => { console.log('FAIL: no-sell wall clock (60s) — something hung'); process.exit(1); }, 60000);
let failed = 0, passed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.log('FAIL: ' + m); } };

const realLlm = require_(path.join(API, '_llm.js'));
const aiUnavailable = realLlm.aiUnavailable;
delete require_.cache[require_.resolve(path.join(API, '_llm.js'))];
function stub(rel, exports) {
  const file = require_.resolve(path.join(API, rel));
  const m = new Module(file); m.filename = file; m.loaded = true; m.exports = exports; require_.cache[file] = m;
}
let calls = [], plan = () => '', usageRows = 0;
stub('_llm.js', {
  callLLM: async (opts) => { const i = calls.length; const prompt = (opts.messages || []).map(m => m.content).join('\n'); calls.push({ opts, prompt }); return plan(i, prompt, opts); },
  aiUnavailable, callGrokSearch: async () => null, claudeConfigured: () => false,
});
stub('_usage.js', {
  billingUserFor: async (u) => u, creditsFor: () => 1, checkLimit: async () => ({ ok: true }), attachHoldRelease() {},
  guard: async () => ({ user: { id: 'u1' }, over: false, billingUserId: 'u1' }),
  denyResponse: (res) => res.status(402).json({ error: 'limit_reached' }), logUsage: async () => { usageRows++; },
});
stub('_publish/store.js', { userCanAccessBrand: async () => true });
stub('_requireUser.js', async () => ({ id: 'u1' }));
const BC = { brandName: 'Acme Salts', tones: ['dry'], usps: 'ZUSP salt sticks', productDetails: 'ZPROD 500mg sodium', ctaStyle: 'ZCTA Shop now, link in bio, use code SALT10', stories: [], beliefs: [], engine: 'grok' };
stub('_brandctx.js', { loadBrandContext: async () => ({ ok: true, bc: JSON.parse(JSON.stringify(BC)), fields: 5, avoidTitles: [] }) });

const B = require_(path.join(API, '_brain.js'));
const W = require_(path.join(API, '_write.js'));
const H = {
  ideas: require_(path.join(API, 'generate-ideas.js')),
  remix: require_(path.join(API, 'remix.js')),
  sharpen: require_(path.join(API, 'sharpen.js')),
  viralRewrite: require_(path.join(API, 'viral-rewrite.js')),
  viralTwist: require_(path.join(API, 'viral-twist.js')),
  viralAnalyze: require_(path.join(API, 'viral-analyze.js')),
  beats: require_(path.join(API, 'video-beats.js')),
};
const R = H.remix;
const RULE = W.NO_SELL_RULE;
const fakeRes = () => ({ statusCode: 0, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } });
async function run(name, body, planFn) {
  calls = []; usageRows = 0; plan = planFn || (() => '');
  const res = fakeRes();
  const q = console.error, w = console.warn, l = console.log; console.error = console.warn = console.log = () => {};
  try { await H[name]({ method: 'POST', headers: { origin: 'https://contentshrimp.com' }, body }, res); }
  finally { console.error = q; console.warn = w; console.log = l; }
  return res;
}
const quiet = async (fn) => { const q = console.error, w = console.warn, l = console.log; console.error = console.warn = console.log = () => {}; try { return await fn(); } finally { console.error = q; console.warn = w; console.log = l; } };
const allText = (o) => JSON.stringify(o);
const SELLS = /link in bio|shop now|buy now|use code|SAVE10|SALT10|% off|limited time|order now|book now|#shopnow|get yours/i;

// ═════ 0. the rule itself ═════
ok(typeof RULE === 'string' && /entertains or teaches/.test(RULE) && /link in bio/.test(RULE) && /use code/.test(RULE) && /engagement: save, follow, comment, share/.test(RULE) && /feature tour/.test(RULE) && /urgency, scarcity/.test(RULE), 'NO_SELL_RULE says: entertain or teach; no pitch/offer/code/link in bio/urgency/feature tour; engagement CTAs only');
ok(W.noSellRule() === RULE && W.noSellNote().includes(RULE), 'noSellRule() / noSellNote() render the same rule');
ok(RULE.length < 520, 'the rule stays one tight paragraph (' + RULE.length + ' chars)');
ok(B.NO_INVENTION_RULE.startsWith('NEVER INVENT FACTS: no made-up numbers, prices, names, customer cases, results or quotes.') && /\[your story: <what to tell>\]/.test(B.NO_INVENTION_RULE), 'NO_INVENTION_RULE is unchanged');

// ═════ 1. every post-writing prompt carries the rule ═════
{
  const sg = W.styleGuide(), sga = W.styleGuide({ about: true });
  ok(sg.includes('- HARD RULE. ' + RULE) && sga.includes('- HARD RULE. ' + RULE), 'styleGuide (both variants) carries the rule');
  ok(sg.includes('- HARD RULE. ' + B.NO_INVENTION_RULE) && sga.includes('- HARD RULE. ' + B.NO_INVENTION_RULE), 'styleGuide still carries NO_INVENTION_RULE');
  const I = W._internals;
  const src = I.normSource({ kind: 'note', text: 'Salt and cramps.' });
  ok(I.anglesPrompt(BC, src, 6).includes(RULE) && I.anglesPrompt(BC, src, 6, 'about', []).includes(RULE), 'anglesPrompt (untyped and about) carries the rule');
}
// runWrite: draft, spoken and shape prompts
{
  calls = []; plan = (i) => i === 2 ? '{"title":"Salt facts","hook":"Salt is not the enemy.","caption":"Salt matters.","onScreen":[],"shots":[],"emphasis":[]}' : 'Salt is not the enemy. Most people drink plain water and still cramp. Sodium is what your muscles fire on. Sweat takes it out faster than you think.';
  await quiet(() => W.runWrite({ bc: BC, source: { kind: 'note', text: 'salt' }, angle: { belief: 'Salt is not the enemy' }, format: 'talking', deadlineMs: 270000 }));
  ok(calls.length === 3 && calls.every(c => c.prompt.includes(RULE)), 'runWrite: the draft, spoken and shape prompts all carry the rule (' + calls.length + ' calls)');
}
const IDEA = { belief: 'Salt is not the enemy', day: 'Monday', community: 'running', format: 'video', tone: 'dry', title: 'Salt facts', hook: 'Salt is not the enemy.', script: 'Salt is not the enemy. Most people drink plain water and still cramp. Sodium is what your muscles fire on. Sweat takes it out faster than you think.', emphasis: [], shots: 'Shot 1: a glass of water', caption: '', reelTitle: 'Salt', tags: '#AcmeSalts #running' };
const PROMPT_OF = {};
{
  const r = await run('ideas', { brandId: 'b1', count: 1 }, () => JSON.stringify([IDEA]));
  PROMPT_OF.ideas = (calls[0] || {}).prompt || '';
  ok(r.statusCode === 200 && PROMPT_OF.ideas.includes(RULE), 'generate-ideas (Ideas, Quick Post, send-daily) carries the rule');
  const ra = await run('ideas', { brandId: 'b1', postType: 'about', count: 1 }, () => JSON.stringify([Object.assign({}, IDEA, { postType: 'about' })]));
  PROMPT_OF.ideasAbout = (calls[0] || {}).prompt || '';
  ok(ra.statusCode === 200 && PROMPT_OF.ideasAbout.includes(RULE), 'generate-ideas (about only) carries the rule');
  const rm = await run('ideas', { brandId: 'b1', typeMix: { tip: 1, about: 1 } }, () => JSON.stringify([IDEA, Object.assign({}, IDEA, { postType: 'about' })]));
  PROMPT_OF.ideasMixed = (calls[0] || {}).prompt || '';
  ok(rm.statusCode === 200 && PROMPT_OF.ideasMixed.includes(RULE), 'generate-ideas (mixed types) carries the rule');
}
{
  const r = await run('remix', { brandId: 'b1', postDescription: 'A video about cramps.' }, () => JSON.stringify({ originalSummary: 's', remixTitle: 'T', remixHook: 'H.', remixScript: 'Salt matters.', remixFormat: 'video', remixCaption: 'Salt matters.', remixHashtags: '#salt', whyItWorks: 'w' }));
  const P = (calls[0] || {}).prompt || '';
  ok(r.statusCode === 200 && P.includes(RULE) && !/Caption with CTA/.test(P) && /engagement invite/.test(P), 'remix (the classic one-pass writer and the blind test baseline) carries the rule; its caption asks for an engagement invite, not "a CTA"');
}
{
  const r = await run('sharpen', { brandId: 'b1', kind: 'post', format: 'video', content: { hook: 'Salt is not the enemy.', script: 'Salt matters a lot.' } }, (i) => i === 0 ? '1. weak hook' : JSON.stringify({ hook: 'Salt is not your enemy.', script: 'Salt matters more than you think.' }));
  ok(r.statusCode === 200 && calls.length === 2 && calls[1].prompt.includes(RULE), 'sharpen: the rewrite prompt carries the rule');
}
{
  const r = await run('viralRewrite', { brandId: 'b1', idea: IDEA, angle: { angle: 'Contrarian', hook: 'Water is not enough.' } }, () => JSON.stringify({ title: 'T', hook: 'H.', script: 'S.', shots: '', boldText: '', caption: '', tags: '#a' }));
  ok(r.statusCode === 200 && (calls[0] || {}).prompt.includes(RULE), 'viral-rewrite carries the rule');
  const t = await run('viralTwist', { brandId: 'b1', idea: IDEA }, () => JSON.stringify({ angles: [{ angle: 'a', hook: 'h', why: 'w' }], spicy: { hook: 'h', why: 'w' }, tip: 't' }));
  ok(t.statusCode === 200 && (calls[0] || {}).prompt.includes(RULE), 'viral-twist carries the rule');
  const a = await run('viralAnalyze', { brandId: 'b1', content: 'A transcript of a viral video.' }, () => JSON.stringify({ whyItWorks: ['x'], hook: 'h', structure: 's', trigger: 't', ideas: [{ format: 'video', title: 'T', hook: 'H.', angle: 'A belief', script: 'S.' }], takeaway: 'k' }));
  ok(a.statusCode === 200 && (calls[0] || {}).prompt.includes(RULE), 'viral-analyze carries the rule');
  const b = await run('beats', { brandId: 'b1', script: 'Salt matters. Sweat takes it out.' }, () => JSON.stringify({ beats: [{ kind: 'statement', eyebrow: 'THE HOOK', headline: 'Salt matters', cue: 'Salt matters' }] }));
  ok(b.statusCode === 200 && (calls[0] || {}).prompt.includes(RULE), 'video-beats (on-screen text) carries the rule');
}
{
  const chat = fs.readFileSync(path.join(API, 'brand-voice-chat.js'), 'utf8');
  ok(/NEVER SALESY: every post this app writes entertains or teaches/.test(chat), 'brand-voice-chat (the coach) is told never to steer toward selling');
}

// ═════ 2. about us is a story or a lesson ═════
{
  const A = W.TYPE_RULES.about;
  ok(!/does for the viewer/i.test(A) && /why the product or service exists/.test(A) && /how it is made/.test(A) && /the problem it was built for/.test(A) && /myth/.test(A) && /story or a lesson/i.test(A), 'TYPE_RULES.about: why / how it is made / the problem / a myth, as a story or a lesson');
  ok(/it never sells/.test(A) && /Never an offer, a price, a feature list or a pitch/.test(A) && /ONLY the real facts/.test(A) && /\[your story: <what to tell>\]/.test(A), 'TYPE_RULES.about: never an offer/price/feature list/pitch; real facts only, slots for the rest');
  const sga = W.styleGuide({ about: true });
  ok(!/does for the viewer/.test(sga) && /story or a lesson/.test(sga), 'styleGuide(about) has no product-for-the-viewer pitch line');
  const ap = W._internals.anglesPrompt(BC, W._internals.normSource({ kind: 'note', text: 'x' }), 6, 'about', []);
  ok(!/does for the viewer/.test(ap) && /never a feature list or an offer/.test(ap), 'anglesPrompt(about): no product-for-the-viewer wording');
  for (const k of ['ideasAbout', 'ideasMixed']) ok(!/does for the viewer/.test(PROMPT_OF[k]) && /why (?:the brand's product or service|the product|it) exists/.test(PROMPT_OF[k]), 'generate-ideas ' + k + ': the about wording is why/how/problem/myth, never "what it does for the viewer"');
}

// ═════ 3. ctaStyle: tone only ═════
{
  for (const v2 of [true, false]) {
    const blk = B.fullBrandBlock(BC, { v2 });
    const line = blk.split('\n').find(l => l.includes('ZCTA')) || '';
    ok(!/how this brand asks for action/i.test(blk) && /TONE only/.test(line) && /Never copy a sales ask/.test(blk.slice(blk.indexOf('ZCTA'))), 'fullBrandBlock v2=' + v2 + ': ctaStyle is labelled tone-only with the never-copy-a-sales-ask note');
  }
  const cs = fs.readFileSync(path.join(API, 'crawl-social.js'), 'utf8');
  ok(!/How this brand actually asks for action/.test(cs) && /Leave out every sales ask/.test(cs), 'crawl-social extracts the engagement-CTA tone only');
  const cb = fs.readFileSync(path.join(API, 'crawl-brand.js'), 'utf8');
  ok(!/How the brand asks for action/.test(cb) && /Never a sales ask/.test(cb), 'crawl-brand extracts engagement CTAs only');
  const ef = fs.readFileSync(path.join(API, 'expand-field.js'), 'utf8');
  ok(!/hard CTAs/.test(ef) && /engagement calls-to-action/.test(ef), 'expand-field no longer asks for hard CTAs');
  const se = fs.readFileSync(path.join(API, 'settings-examples.js'), 'utf8');
  ok(/ctaStyle: 'engagement calls-to-action/.test(se), 'settings-examples suggests engagement CTAs only');
}

// ═════ 4. the guard: narrow, removal only, slots untouchable ═════
const SALESY = [
  'Link in bio!', 'Grab a pack, link in our bio.', 'The full recipe is in my bio.', 'Shop now.', 'Buy now and thank me later.',
  'Order now at acme.com.', 'Shop our electrolytes now.', 'Use code SAVE10 at checkout.', 'Enter code HYDRATE for a treat.', 'Use my code SALT15.',
  'Our promo code is in the caption.', 'Discount codes are in the caption.', 'Get 20% off your first order.', '30% off everything this weekend.', 'Limited-time offer: two for one.',
  'While stocks last.', 'Today only: free shipping.', 'The sale ends Sunday.', 'DM us to order.', 'DM me to book a session.',
  'DM me SALT for the guide.', 'Comment SALT and I will send you the link.', 'Comment GUIDE to get the checklist.', 'Add it to your cart before Friday.', 'Pre-order now.',
  'Start your free trial.', 'Shop the collection.', 'Available now at our store.', 'Message us to buy a starter pack.', 'Osta kohe!', 'Kasuta koodi SOOL10.',
];
const CLEAN = [
  // the reviewer's cases
  'Book a slot in your calendar for a walk.', 'Use the code in the recipe card.', 'Follow the link between sleep and cramps.', 'Get yours checked by a doctor.',
  'Grab yours from the fridge.', 'Half off the sugar.', 'We tried a limited edition flavour once and it flopped.', "Visit our store in Tallinn and you'll see how we mix it.",
  'Only 3 left in the pack.', 'This weekend only my legs hurt.', 'Starting at $5 a day, coffee costs more than you think.', 'In order to sweat less, cool down slowly.',
  'This book changed how I train.', 'Your code review can wait; your water cannot.', 'Give yourself some free time after a long run.', 'My garage sale story starts with a box of old salt tins.',
  'I only today realised how much salt I sweat.',
  // more teaching / story sentences that share words with sales asks
  'Most discounts train customers to wait.', 'Salt is not the enemy; plain water is not enough.', 'Most parents have limited time in the morning.', 'This book now sits on my desk.',
  'People buy now, pay later and regret it.', 'Save this for your next long run.', 'Tell me in the comments how you hydrate.', 'Follow for more salt myths.',
  'Share this with the friend who cramps at mile 20.', 'When you go to the store, read the label.', 'Free shipping is a tax on your margin.', 'A coffee costs $5 and nobody blinks.',
  'Price anchoring is why the middle option sells.', 'Before you book a consultation with any clinic, ask these three questions.', 'Every sale has a story behind it.', 'The code of a good recipe is balance.',
  'Here is how a salt stick is pressed.', 'Comment below with your worst cramp story.', 'Shopping for electrolytes is confusing.', 'Black Friday discounts are mostly theatre.',
  'The link between salt and cramps is real.', 'Stretch for just 5 minutes a day.', 'Sold out shelves tell you what people actually want.', 'A 20% off sticker makes people buy things they never needed.',
  'Get the 20% off myth out of your head.', 'Promo season is when brands train you to wait.', 'The sale ended and nobody noticed.', 'Use code words your audience already says.',
  'Grab a pen and write down how much you drink.', 'Message me if this helped.', 'Today only three people showed up to the run club.', 'Back in stock is the most clicked email subject line for a reason.',
  'When the shop opens, people buy whatever is at eye level.', 'Order matters: salt first, then water.',
];
{
  const G = W.guardNoSell;
  const miss = SALESY.filter(t => !G('Salt matters. ' + t).hits.length);
  ok(SALESY.length >= 25 && !miss.length, 'guardNoSell blocks every sales sample (' + (SALESY.length - miss.length) + '/' + SALESY.length + ')' + (miss.length ? ': missed ' + JSON.stringify(miss) : ''));
  const removed = SALESY.filter(t => G('Salt matters. ' + t).text === 'Salt matters.');
  ok(removed.length === SALESY.length, 'each sales sentence is REMOVED and nothing is written in its place (' + removed.length + '/' + SALESY.length + ')');
  const fp = CLEAN.filter(t => G(t).hits.length || G(t).text !== t);
  ok(CLEAN.length >= 40 && !fp.length, 'guardNoSell cuts 0/' + CLEAN.length + ' innocent sentences' + (fp.length ? ': cut ' + JSON.stringify(fp) : ''));
  ok(!('ENGAGE_CTA' in W), 'there is no engagement line to insert any more');
  const tricky = G('Most discounts train customers to wait. So we never run one. Use code SAVE10.');
  ok(tricky.ok && tricky.text === 'Most discounts train customers to wait. So we never run one.', 'the educational "discount" sentence stays, the ask goes (' + JSON.stringify(tricky.text) + ')');
  const start = G('Shop now. Salt matters.');
  ok(start.text === 'Salt matters.', 'an ask at the start is removed; nothing is put at the start (' + JSON.stringify(start.text) + ')');
  const two = G('Sodium matters. Link in bio. Salt is cheap. Shop now.');
  ok(two.text === 'Sodium matters. Salt is cheap.', 'several asks: all removed, nothing added (' + JSON.stringify(two.text) + ')');
  const only = G('Shop now.');
  ok(only.ok === false && only.text === 'Shop now.' && only.hits.length, 'a cut that would empty the field is NOT made: ok:false and the original text');
  const s1 = G('[your story: the day we sold out] Use code SAVE10 today. Water matters.');
  ok(s1.ok && s1.text === '[your story: the day we sold out] Water matters.', 'reviewer case 1: the slot stays, the ask after it goes, the next sentence is judged alone (' + JSON.stringify(s1.text) + ')');
  const s2 = G('Link in bio [your story: the day we sold out] then drink water.');
  ok(s2.ok && s2.text === '[your story: the day we sold out] then drink water.', 'reviewer case 2: the slot and "then drink water." stay (' + JSON.stringify(s2.text) + ')');
  const s3 = G('[your story: how we answer "link in bio" requests] Salt matters.');
  ok(!s3.hits.length && s3.text === '[your story: how we answer "link in bio" requests] Salt matters.', 'a slot is never judged, even when it quotes a sales phrase');
  const keep = G('  Two  spaces  here.\nLink in bio.');
  ok(keep.text === '  Two  spaces  here.', 'a script line that only sold goes; a line nothing was taken from comes back byte for byte (' + JSON.stringify(keep.text) + ')');
  const slides = 'Salt is what your muscles fire on.\n\nSweat takes it out.\n\nSlide three: the full guide, link in bio.';
  const c1 = G(slides, { keepLines: true });
  ok(c1.ok && c1.text === 'Salt is what your muscles fire on.\n\nSweat takes it out.\n\nSlide three: the full guide.', 'carousel: a slide keeps its text once the selling clause is cut (' + JSON.stringify(c1.text) + ')');
  const c2 = G('Salt is what your muscles fire on.\n\nSweat takes it out.\n\nLink in bio.', { keepLines: true });
  ok(c2.ok === false && c2.text.split('\n\n').length === 3, 'carousel: a slide that would be emptied is never lost (ok:false, the original slides)');
  const c3 = G('Salt is what your muscles fire on.\n\nSweat takes it out. Shop now.', { keepLines: true });
  ok(c3.ok && c3.text === 'Salt is what your muscles fire on.\n\nSweat takes it out.', 'carousel: a selling sentence inside a slide is removed, the slide stays');
  const tags = G('Salt matters. #running #shopnow #linkinbio');
  ok(tags.text === 'Salt matters. #running' && tags.hits.length === 2, 'sales hashtags are stripped, the rest of the line kept (' + JSON.stringify(tags.text) + ')');
  ok(!W.strongSales('Salt matters. #shopnow') && W.strongSales('Salt matters. Shop now.'), 'a sales hashtag alone is not a strong (retry-worthy) hit');
  ok(W.noSellCore('Shop now. Use code SAVE10. Salt matters.') && !W.noSellCore('Salt matters. Sweat takes it out. Most people drink water. Cramps follow. Link in bio.'), 'noSellCore: a third or more of the sentences sell = salesy at its core; one stray line is not');
  const gi = W.guardIdeaNoSell({ title: 'Salt facts', hook: 'Salt is not the enemy. Link in bio.', script: 'Salt is not the enemy. Link in bio.', caption: 'Salt matters. Shop now.', shots: 'Shot 1: a glass\nShot 2: show the promo code on screen', tags: '#salt #sale', emphasis: ['not the enemy', 'Link in bio'] });
  ok(gi.ok && gi.idea.hook === 'Salt is not the enemy.' && gi.idea.script === 'Salt is not the enemy.' && gi.idea.caption === 'Salt matters.' && gi.idea.shots === 'Shot 1: a glass' && gi.idea.tags === '#salt' && JSON.stringify(gi.idea.emphasis) === '["not the enemy"]', 'guardIdeaNoSell: selling sentences, shots and tags removed, stale stress marks dropped (' + allText(gi.idea) + ')');
  const hollow = W.guardIdeaNoSell({ title: 'Shop now', hook: 'Use code SAVE10.', script: 'Salt matters.', caption: 'Get 20% off your first order.' });
  ok(!hollow.ok && hollow.kept.join() === 'caption,hook,title' && hollow.idea.hook === 'Use code SAVE10.' && hollow.idea.title === 'Shop now' && hollow.idea.caption === 'Get 20% off your first order.', 'a field the cut would empty is LEFT AS IT WAS, named in kept, ok:false; a hook never falls back to anything (' + hollow.kept.join() + ')');
  const car = W.guardIdeaNoSell({ format: 'carousel', hook: 'Salt matters.', boldText: '1: Salt matters.\n2: Link in bio.' });
  ok(!car.ok && car.kept.join() === 'boldText', 'a carousel idea that would lose a slide is not ok');
}

// ═════ 5. every writer's output runs the guard ═════
const CLEAN_SCRIPT = 'Salt is not the enemy. Most people drink plain water and still cramp. Sodium is what your muscles fire on. Sweat takes it out faster than you think.';
const SALES_SCRIPT = CLEAN_SCRIPT + ' Link in bio, use code SALT10.';
const writeOpts = (format) => ({ bc: BC, source: { kind: 'note', text: 'salt' }, angle: { belief: 'Salt is not the enemy' }, format: format || 'talking', deadlineMs: 270000 });
{
  // runWrite — a stray sales line is removed, the selling shape fields fall back, no retry
  calls = []; plan = (i) => i === 2 ? '{"title":"Shop now","hook":"Use code SALT10.","caption":"Get 20% off your first order.","onScreen":["Link in bio"],"shots":["Hold the pack, link in bio"],"emphasis":["Link in bio"]}' : SALES_SCRIPT;
  const w = await quiet(() => W.runWrite(writeOpts()));
  ok(w.idea.script === CLEAN_SCRIPT && w.idea.hook === 'Salt is not the enemy.' && w.idea.title === 'Salt is not the enemy' && w.idea.caption === 'Salt is not the enemy' && !SELLS.test(allText(w.idea)) && calls.length === 3 && w.passes.salesRemoved.length > 0 && w.passes.draft === 'done', 'runWrite: the ask is removed, selling title/hook/caption/overlays/shots fall back to the script\'s own words, no extra call (' + allText({ s: w.idea.script, h: w.idea.hook, t: w.idea.title }) + ')');
  // a pitch at its core shares the ONE retry
  const isDraft = (p) => /Write ONE (?:script|carousel)/.test(p);
  calls = []; plan = (i, p) => isDraft(p) && !p.includes(W.noSellNote()) ? 'Shop now. Use code HYDRATE. Link in bio.' : (/^Below is a finished/.test(p) ? '{}' : CLEAN_SCRIPT);
  const w2 = await quiet(() => W.runWrite(writeOpts()));
  const drafts = calls.filter(c => isDraft(c.prompt));
  ok(drafts.length === 2 && drafts[1].prompt.includes(W.noSellNote()) && w2.passes.draft === 'retried_sales' && JSON.stringify(w2.passes.retryReasons) === '["sales"]' && !SELLS.test(allText(w2.idea)), 'runWrite: a pitch-at-its-core draft is retried ONCE with the rule restated (' + drafts.length + ' draft calls, ' + w2.passes.draft + ')');
  // facts AND sales: one retry, both reasons listed
  calls = []; plan = (i, p) => isDraft(p) && !p.includes(W.noSellNote()) ? 'My client Sarah cut her cramps by 80% in 2 weeks. Shop now. Use code SALT10.' : (/^Below is a finished/.test(p) ? '{}' : CLEAN_SCRIPT);
  const w3 = await quiet(() => W.runWrite(writeOpts()));
  ok(calls.filter(c => isDraft(c.prompt)).length === 2 && w3.passes.draft === 'retried_facts_sales' && JSON.stringify(w3.passes.retryReasons) === '["facts","sales"]', 'runWrite: a retry for both reasons is labelled retried_facts_sales (' + w3.passes.draft + ')');
  // still only a pitch after the retry: EMPTY_RESULT, never a hollow script
  calls = []; plan = (i, p) => /^Below is a finished/.test(p) ? '{}' : 'Shop now. Use code SALT10.';
  let e3 = null; try { await quiet(() => W.runWrite(writeOpts())); } catch (e) { e3 = e; }
  ok(e3 && e3.code === 'EMPTY_RESULT' && calls.filter(c => isDraft(c.prompt)).length === 2, 'runWrite: a draft that is only a pitch after the retry is an EMPTY_RESULT (no usage row), never shipped');
  // carousel: a slide that would be lost earns the retry; the slide count never shrinks
  calls = []; plan = (i, p) => isDraft(p) && !p.includes(W.noSellNote()) ? 'Salt is what your muscles fire on.\n\nSweat takes it out.\n\nLink in bio.' : (/^Below is a finished/.test(p) ? '{}' : 'Salt is what your muscles fire on.\n\nSweat takes it out.\n\nPlain water does not put it back.');
  const wc = await quiet(() => W.runWrite(writeOpts('carousel')));
  ok(calls.filter(c => isDraft(c.prompt)).length === 2 && wc.passes.draft === 'retried_sales' && wc.idea.onScreen.length === 3, 'runWrite carousel: a slide the guard would lose earns the retry; 3 slides in, 3 slides out');
  calls = []; plan = (i, p) => /^Below is a finished/.test(p) ? '{}' : 'Salt is what your muscles fire on.\n\nSweat takes it out.\n\nPlain water does not put it back.\n\nLink in bio.';
  let ec = null; try { await quiet(() => W.runWrite(writeOpts('carousel'))); } catch (e) { ec = e; }
  ok(ec && ec.code === 'EMPTY_RESULT', 'runWrite carousel: a slide still lost after the retry is an EMPTY_RESULT, never a silent 4 of 5');
  // runAngles — selling belief dropped, selling why sentence and hookSeed removed
  calls = []; plan = () => JSON.stringify({ angles: [
    { belief: 'Salt is not the enemy', why: 'People fear sodium. Link in bio.', hookSeed: 'Shop now.' },
    { belief: 'Plain water is not enough', why: 'Water feels healthy.' },
    { belief: 'Cramps are a sodium problem', why: 'Everyone blames stretching.' },
    { belief: 'Use code SALT10 for the best salt', why: 'x' },
  ] });
  const a = await quiet(() => W.runAngles({ bc: BC, source: { kind: 'note', text: 'salt' }, deadlineMs: 90000 }));
  ok(a.angles.length === 3 && !SELLS.test(allText(a.angles)) && a.angles[0].why === 'People fear sodium.' && !('hookSeed' in a.angles[0]), 'runAngles: a selling belief is dropped, a selling why sentence and hookSeed are removed');
}
{
  const stray = Object.assign({}, IDEA, { title: 'Stray', script: SALES_SCRIPT, caption: 'Salt matters. Shop now.', tags: '#AcmeSalts #shopnow' });
  const hollow = Object.assign({}, IDEA, { title: 'Hollow', hook: 'Shop now.' });
  // a) one idea with a stray ask: cleaned, no regeneration, one usage row
  const r = await run('ideas', { brandId: 'b1', count: 2 }, () => JSON.stringify([stray, IDEA]));
  const I = (r.body && r.body.ideas) || [];
  const s0 = I.find(x => x.title === 'Stray') || {};
  ok(r.statusCode === 200 && I.length === 2 && s0.script === CLEAN_SCRIPT && s0.caption === 'Salt matters.' && s0.tags === '#AcmeSalts' && calls.length === 1 && usageRows === 1, 'generate-ideas: a stray ask is removed, no regeneration for ONE selling idea, one usage row (' + calls.length + ' calls)');
  // b) one hollow idea: dropped from the batch (warnings sales_dropped), no regeneration
  const rb = await run('ideas', { brandId: 'b1', count: 2 }, () => JSON.stringify([IDEA, hollow]));
  const Ib = (rb.body && rb.body.ideas) || [];
  ok(rb.statusCode === 200 && Ib.length === 1 && Ib[0].title === IDEA.title && (rb.body.warnings || []).includes('sales_dropped') && calls.length === 1 && usageRows === 1, 'generate-ideas: an idea the cut would hollow out is DROPPED (sales_dropped), never shipped hollow, no regeneration');
  // c) 2+ ideas with strong asks: the ONE existing regeneration, rule restated, one usage row
  const rc = await run('ideas', { brandId: 'b1', count: 2 }, (i) => JSON.stringify(i === 0 ? [stray, Object.assign({}, stray, { title: 'Stray2' })] : [IDEA, Object.assign({}, IDEA, { title: 'Two' })]));
  ok(rc.statusCode === 200 && calls.length === 2 && calls[1].prompt.includes(W.noSellNote()) && (rc.body.ideas || []).every(x => x.script === IDEA.script) && usageRows === 1, 'generate-ideas: 2 selling ideas earn the one regeneration (rule restated), the cleaner batch is kept, one usage row (' + calls.length + ' calls, ' + usageRows + ' rows)');
  // d) a 1-idea batch that is only hollow: an honest 502, nothing charged, no regeneration
  const rd = await run('ideas', { brandId: 'b1', count: 1 }, () => JSON.stringify([hollow]));
  ok(rd.statusCode === 502 && usageRows === 0 && calls.length === 1, 'generate-ideas: nothing usable left = 502, no usage row, no regeneration');
  // e) 2 hollow ideas, regeneration still hollow: 502, nothing charged, exactly 2 calls
  const re2 = await run('ideas', { brandId: 'b1', count: 2 }, () => JSON.stringify([hollow, Object.assign({}, hollow, { title: 'H2' })]));
  ok(re2.statusCode === 502 && usageRows === 0 && calls.length === 2, 'generate-ideas: an all-pitch batch gets ONE regeneration; still nothing usable = 502, no usage row (' + calls.length + ' calls)');
}
{
  const r = await run('remix', { brandId: 'b1', postDescription: 'A video about cramps.' }, () => JSON.stringify({ originalSummary: 's', remixTitle: 'Shop now', remixHook: 'Salt is not the enemy. Use code SALT10.', remixScript: SALES_SCRIPT, remixFormat: 'video', remixCaption: 'Salt matters. Link in bio.', remixHashtags: '#salt #shopnow', whyItWorks: 'w' }));
  const X = r.body.remix || {};
  ok(r.statusCode === 200 && X.remixScript === CLEAN_SCRIPT && X.remixHook === 'Salt is not the enemy.' && X.remixCaption === 'Salt matters.' && X.remixHashtags === '#salt' && X.remixTitle === 'Shop now' && X.noSellKept === 'remixTitle', 'remix: selling sentences removed; a field the cut would empty is kept as it was and flagged (noSellKept=' + X.noSellKept + ')');
  const rs = await run('remix', { brandId: 'b1', postDescription: 'x', remixMode: 'series' }, () => JSON.stringify({ originalSummary: 's', seriesParts: [{ partNumber: 1, remixTitle: 'T', remixHook: 'Salt matters. Order now.', remixScript: SALES_SCRIPT, remixFormat: 'video' }], remixCaption: 'Salt matters. Shop now.', remixHashtags: '#salt' }));
  ok(rs.statusCode === 200 && !SELLS.test(allText(rs.body.remix)) && rs.body.remix.seriesParts[0].remixScript === CLEAN_SCRIPT, 'remix series: every part comes back clean');
  calls = []; plan = () => JSON.stringify({ originalSummary: 's', remixTitle: 'T', remixHook: 'H.', remixScript: SALES_SCRIPT, remixFormat: 'video', remixCaption: 'Salt. Buy now.', remixHashtags: '#a', whyItWorks: 'w' });
  const lr = await quiet(() => R._legacyRemix({ bc: BC, source: { text: 'x' } }));
  ok(!SELLS.test(allText(lr)) && calls[0].prompt.includes(RULE), 'the blind test baseline arm (_legacyRemix) is guarded and carries the rule');
}
{
  const r = await run('sharpen', { brandId: 'b1', kind: 'post', format: 'video', content: { hook: 'Salt is not the enemy.', script: 'Salt matters a lot.', caption: 'Salt.' } }, (i) => i === 0 ? '1. weak hook' : JSON.stringify({ hook: 'Salt is not your enemy.', script: SALES_SCRIPT, caption: 'Use code SALT10.' }));
  const S = r.body.sharpened || {};
  ok(r.statusCode === 200 && S.script === CLEAN_SCRIPT && S.caption === 'Salt.' && JSON.stringify(r.body.noSellKept) === '["caption"]', 'sharpen: selling sentences removed; a field the cut would empty keeps the user\'s original and is flagged');
  const v = await run('viralRewrite', { brandId: 'b1', idea: IDEA, angle: { angle: 'Contrarian', hook: 'Water is not enough.' } }, () => JSON.stringify({ title: 'Buy now', hook: 'Water is not enough. Link in bio.', script: SALES_SCRIPT, shots: 'Shot 1: pack\nShot 2: link in bio card', boldText: '', caption: 'Salt matters. Get 20% off your first order.', tags: '#salt #discount' }));
  const V = v.body.idea || {};
  ok(v.statusCode === 200 && V.hook === 'Water is not enough.' && V.script === CLEAN_SCRIPT && V.shots === 'Shot 1: pack' && V.caption === 'Salt matters.' && V.tags === '#salt' && V.title === 'Buy now' && JSON.stringify(v.body.noSellKept) === '["title"]', 'viral-rewrite: selling sentences removed; an emptied field is kept and flagged');
  const t = await run('viralTwist', { brandId: 'b1', idea: IDEA }, () => JSON.stringify({ angles: [{ angle: 'Urgency', hook: 'Shop now.', why: 'w' }, { angle: 'Contrarian', hook: 'Water is overrated. Use code SALT10.', why: 'w' }], spicy: { hook: 'Link in bio.', why: 'w' }, tip: 't' }));
  const tw = t.body.twist || {};
  ok(t.statusCode === 200 && tw.angles.length === 1 && tw.angles[0].hook === 'Water is overrated.' && tw.spicy.hook === 'Link in bio.' && JSON.stringify(t.body.noSellKept) === '["spicy.hook"]', 'viral-twist: a hook that was only an ask drops its angle, a selling sentence is removed, no hook is replaced by another line');
  const t2 = await run('viralTwist', { brandId: 'b1', idea: IDEA }, () => JSON.stringify({ angles: [{ angle: 'a', hook: 'Shop now.', why: 'w' }], spicy: { hook: 'h', why: 'w' }, tip: 't' }));
  ok(t2.statusCode === 502 && usageRows === 0, 'viral-twist: every angle only an ask = an honest 502, nothing charged');
  const an = await run('viralAnalyze', { brandId: 'b1', content: 'A transcript.' }, () => JSON.stringify({ whyItWorks: ['x'], hook: 'h', structure: 's', trigger: 't', ideas: [{ format: 'video', title: 'Shop now', hook: 'Order now.', angle: 'A belief', script: SALES_SCRIPT }, { format: 'video', title: 'Salt', hook: 'Salt matters. Link in bio.', angle: 'A belief', script: SALES_SCRIPT }], takeaway: 'k' }));
  const AI = (an.body.analysis || {}).ideas || [];
  ok(an.statusCode === 200 && AI.length === 1 && AI[0].hook === 'Salt matters.' && AI[0].script === CLEAN_SCRIPT, 'viral-analyze: a hollow idea is dropped, the other comes back clean');
  const b = await run('beats', { brandId: 'b1', script: 'Salt matters. Link in bio.' }, () => JSON.stringify({ beats: [{ kind: 'statement', headline: 'Salt matters', sub: 'Use code SALT10', cue: 'Salt matters' }, { kind: 'statement', headline: 'Link in bio', cue: 'Link in bio' }, { kind: 'chips', headline: 'Pick one', chips: ['Shop now', 'x'], cue: 'x' }] }));
  ok(b.statusCode === 200 && b.body.beats.length === 1 && b.body.beats[0].sub === '' && !SELLS.test(allText(b.body.beats)), 'video-beats: a selling beat is dropped and a selling sub-line blanked');
}

clearTimeout(WALL);
if (failed) { console.log('no-sell: ' + failed + ' failed, ' + passed + ' passed'); process.exit(1); }
console.log('NO SELL OK (' + passed + ' checks)');
