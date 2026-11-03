#!/usr/bin/env node
// v709 — CONSISTENCY S1 (.unlazy/consistency/CONTRACT.md): the shared post rules and the new writer.
// Covers the audit findings fixed in api/_write.js, api/_brain.js, api/_brandctx.js, api/angles.js and
// api/write.js, with stubbed prompts and outputs (no AI, no network: _llm, _usage and the store are stubs).
// Prints "CONSISTENCY S1 OK" only when every check passes.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const Module = require_('module');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = path.join(ROOT, 'api');
const WALL = setTimeout(() => { console.log('FAIL: consistency-S1 wall clock (60s)'); process.exit(1); }, 60000);
for (const k of Object.keys(process.env)) if (/KEY|SECRET|TOKEN|SUPABASE/i.test(k)) delete process.env[k];

let failed = 0, passed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.log('FAIL: ' + m); } };
function stub(rel, exports) {
  const file = require_.resolve(path.join(API, rel));
  const m = new Module(file); m.filename = file; m.loaded = true; m.exports = exports; require_.cache[file] = m;
}
let calls = [], plan = () => '';
stub('_llm.js', {
  callLLM: async (opts) => { const i = calls.length; const prompt = (opts.messages || []).map(m => m.content).join('\n'); calls.push({ opts, prompt }); return plan(i, prompt); },
  aiUnavailable: () => null, callGrokSearch: async () => null,
});
stub('_publish/store.js', { userCanAccessBrand: async () => true, rest: async () => ({ status: 500, data: null }) });
let usage = [];
stub('_usage.js', {
  guard: async () => ({ user: { id: 'u1' }, over: false, billingUserId: 'u1' }),
  denyResponse: (res) => res.status(402).json({ error: 'limit_reached' }),
  logUsage: async (e) => { usage.push(e); },
});
const BCX = require_(path.join(API, '_brandctx.js'));       // the REAL hydrator helpers (store is a stub)
let hydrate = () => ({ ok: false, reason: 'none' });
stub('_brandctx.js', { loadBrandContext: async () => hydrate() });
const B = require_(path.join(API, '_brain.js'));
const W = require_(path.join(API, '_write.js'));
const I = W._internals;
const anglesH = require_(path.join(API, 'angles.js'));
const writeH = require_(path.join(API, 'write.js'));
const fakeRes = () => ({ statusCode: 0, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } });
const hit = async (h, body) => { const r = fakeRes(); await h({ method: 'POST', headers: { origin: 'https://contentshrimp.com' }, body }, r); return r; };
const quiet = async (fn) => { const e = console.error, w = console.warn; console.error = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.error = e; console.warn = w; } };
const STOCK = /tell me in the comments/i;

// ═════ 0. THE CONTRACT HELPERS — exactly these signatures ═════
ok(typeof W.postRules === 'function' && W.postRules.length === 1, 'postRules({ type, format, delivery }) is exported (1 parameter)');
ok(typeof W.hashtagsFor === 'function' && W.hashtagsFor.length === 1, 'hashtagsFor(bc) is exported (1 parameter)');
ok(typeof W.guardPost === 'function' && W.guardPost.length === 3, 'guardPost(post, bc, opts) is exported (3 parameters)');
ok(typeof W.sourceLine === 'function' && W.sourceLine.length === 2, 'sourceLine(bc, factIds) is exported (2 parameters)');
ok(typeof B.effectiveTypeMix === 'function' && B.effectiveTypeMix.length === 1, '_brain.effectiveTypeMix(bc) is exported');
{
  const g = W.guardPost({ format: 'video', title: 't', hook: 'h', script: 'Salt matters.' }, {}, {});
  ok(g && typeof g === 'object' && g.post && typeof g.drop === 'boolean' && Array.isArray(g.reasons), 'guardPost returns { post, drop: boolean, reasons: string[] }');
  ok(typeof W.postRules({}) === 'string' && Array.isArray(W.hashtagsFor({})) && W.sourceLine({}, []) === '', 'postRules -> string, hashtagsFor -> array, sourceLine -> "" with no facts');
  ok(typeof W.postRules() === 'string' && W.guardPost(null, null).post && W.hashtagsFor().length === 0, 'helpers tolerate missing arguments');
}

// ═════ 1. postRules: never salesy, ending, hashtags, delivery, the shape fitted to the format ═════
const PR_FACE = W.postRules({ type: 'tip', format: 'talking', delivery: 'face' });
const PR_FACELESS = W.postRules({ type: 'tip', format: 'statement', delivery: 'faceless' });
ok(PR_FACE.includes(W.NO_SELL_RULE) && /ENDING: end on the point/.test(PR_FACE) && /HASHTAGS: write none/.test(PR_FACE), 'postRules carries NEVER SALESY, the ending and the hashtag policy');
ok(/FACE-ON/.test(PR_FACE) && /to camera/.test(PR_FACE) && !/FACELESS/.test(PR_FACE), 'face-on: the person films themselves to camera');
ok(/FACELESS/.test(PR_FACELESS) && /voiceover/.test(PR_FACELESS) && /b-roll/.test(PR_FACELESS) && !/saying it to camera|says it to camera/.test(PR_FACELESS), 'faceless: voiceover over b-roll, never a piece to camera');
ok(PR_FACE.includes(W.TYPE_SHAPES.tip), 'a tip as a talking video keeps its steps shape');
ok(!PR_FACELESS.includes(W.TYPE_SHAPES.tip) && !/2 to 4/.test(PR_FACELESS) && PR_FACELESS.includes(W.SHORT_SHAPES.tip) && /No lists, no numbered steps/.test(PR_FACELESS), 'a tip as a statement: ONE step + why, no step list (A4)');
ok(/No call to action of any kind/.test(PR_FACELESS) && /optional/.test(PR_FACE), 'statement ends with no CTA; elsewhere an invite is optional, in the brand\'s words');
ok(W.postRules({ type: 'tip', format: 'micro' }).includes(W.SHORT_SHAPES.tip) && W.postRules({ type: 'qna', format: 'static' }).includes(W.SHORT_SHAPES.qna), 'micro and image posts get the compressed shape too');
ok(W.postRules({ type: 'story', format: 'carousel' }).includes(W.TYPE_SHAPES.story + ', one beat per slide'), 'a carousel keeps the full shape, one beat per slide');
ok(/FACE-ON/.test(W.postRules({ format: 'video', delivery: 'faceon' })) && /FACELESS/.test(W.postRules({ format: 'video', delivery: 'FACELESS' })) && /FACE-ON/.test(W.postRules({ format: 'video', delivery: 'nonsense' })), 'delivery: face | faceon | faceless understood, anything else is face');
ok(!/2 to 4/.test(Object.values(W.TYPE_RULES).join(' ').replace(/\(in a statement[^)]*\)/g, '').replace(W.TYPE_SHAPES.tip, '')) && W.TYPE_RULES.tip.includes(W.SHORT_SHAPES.tip), 'TYPE_RULES (the batch) names the short shape next to the full one');
ok(!STOCK.test(PR_FACE + PR_FACELESS + W.NO_SELL_RULE + W.styleGuide()), 'no stock "Tell me in the comments" line in the shared rules (A9)');
// review 1 — slots never in on-screen text, said everywhere slots are described
for (const f of ['talking', 'micro', 'statement', 'carousel', 'static', 'video', 'qna']) ok(W.postRules({ type: 'tip', format: f }).includes("Never put a [your story: …] slot in on-screen text (statement text, carousel slides, image text, overlays, title, hook). Where on-screen text would need proof you don't have, cut that claim instead."), 'postRules (' + f + ') says: never a slot in on-screen text');
ok(/no slot at all/.test(PR_FACELESS) && /no slot at all/.test(W.postRules({ format: 'carousel' })) && !/no slot at all/.test(PR_FACE), 'a read post (statement/carousel/image) is told it carries no slot at all; a spoken one is not');
ok(/spoken line needs proof/.test(B.NO_INVENTION_RULE) && /On-screen text[^.]*get no slot: cut the claim/.test(B.NO_INVENTION_RULE) && !/Where a line needs proof/.test(B.NO_INVENTION_RULE), 'NO_INVENTION_RULE agrees: slots only in a spoken line');
ok(/in on-screen text the claim is cut/.test(B.ABOUT_BG_NOTE) && /in on-screen text/.test(W.TYPE_RULES.about) && /on-screen text keeps to the lesson/.test(W.TYPE_RULES.story) && /in on-screen text it is cut/.test(W.TYPE_RULES.bts), 'the about/story/bts rules say where a slot may go');
// review 3 — a statement has no CTA at all, so its NEVER SALESY line mentions none
ok(PR_FACELESS.includes(W.NO_SELL_CORE) && !/optional/i.test(PR_FACELESS) && !/calls to action are engagement/.test(PR_FACELESS) && /calls to action are engagement/.test(PR_FACE), 'statement: no "optional engagement CTA" next to "No call to action of any kind"');

// ═════ 2. the brand block: no promote wording, ONE priority statement, tones, trends label ═════
const FULL = { brandName: 'Saltline', tones: ['dry', 'warm', 'blunt', 'playful'], usps: 'No sugar.', productDetails: 'Sachets.', socialProof: 'Stocked in 40 gyms.',
  painPoints: 'Cramps.', categoryGripes: 'Too sweet.', reviewInsights: 'Tastes like the sea.', webMentions: 'Liked on Reddit.', competitorMoves: 'LMNT launched a sale.',
  ctaStyle: 'Stay salty.', coachNotes: 'Never say hydration hack.\nShort words.', voiceSample: 'So the thing is, I just salt my water and that is it.', recentTrends: ['Salt in coffee', 'Heat wave in Tallinn'],
  beliefs: ['Most cramps are a salt problem'] };
const V2 = B.fullBrandBlock(FULL, { v2: true }), LEG = B.fullBrandBlock(FULL);
const PROMO = /show how this brand is different|Amplify|Differentiate from|counter, or ride|weave in for credibility|name the real product|answer the complaints head on|lead with the praise|earns instant trust/i;
ok(!PROMO.test(V2) && !PROMO.test(LEG), 'no promote-the-brand wording in the v2 or the legacy brand block (A3)');
ok(/use these as background facts/i.test(V2) && /use these as background facts/i.test(LEG), 'brand notes say: use these as background facts');
ok(/optional and only in this brand.s own words/.test(LEG) && !/ends, if at all, by inviting/.test(V2 + LEG), 'the sign-off note uses the same ending rule as postRules (A9)');
const count = (t, s) => t.split(s).length - 1;
ok(count(V2, B.PRIORITY_RULE) === 1 && count(LEG, B.PRIORITY_RULE) === 1 && B.PRIORITY_RULE === 'Brand facts and voice guide the post; NEVER SALESY and NEVER INVENT override everything.', 'exactly ONE priority statement, the contract sentence, in both brand blocks (A7)');
ok(!/outrank|obey ALL|beats every description/i.test(V2 + LEG + B.rulePrecedence() + B.approvedWinnersBlock({ approvedExamples: [{ text: 'x', edited: true }] })), 'no other block claims to outrank anything (voice sample, winners, voice memory, rulePrecedence)');
ok(/Voice \/ tones: dry, warm, blunt\n/.test(V2) && !/playful/.test(V2) && /lists 4 tones; these are its first 3/.test(V2), 'more than 3 tones: the first 3, and the prompt says so (C8)');
ok(!/from real viral videos|RIGHT NOW/.test(V2) && /RECENT HEADLINES/.test(V2), 'trends + auto headlines are labelled as what they are (C7)');
ok(!/to camera|down a lens/.test(B.spokenV2()) && !/looking down a lens/.test(B.spokenShape()), 'the shared spoken rules are not "to camera" only (faceless brands speak a voiceover)');

// ═════ 3. _brandctx: delivery, newsDismissed, formatsOff, beliefs at 300, dismissed news excluded ═════
{
  const NOW = Date.now();
  const at = { at: NOW, items: [
    { text: 'Battery electrolyte prices jump', link: 'https://news.example/battery', ts: NOW - 3600e3, source: 'Wire' },
    { text: 'Runners rethink salt in the heat', link: 'https://news.example/salt', ts: NOW - 7200e3, source: 'Wire' },
    { text: 'Sports drinks lose shelf space', link: 'https://news.example/shelf', ts: NOW - 9000e3, source: 'Wire' } ] };
  const row = { brand_name: 'Saltline', auto_trends: at, voice_extra: { delivery: 'faceless', newsDismissed: ['battery electrolyte PRICES jump', 'https://news.example/shelf'], formatsOff: ['qna', 'nope', 'QNA'] } };
  const c = BCX.contextFromBrandRow(row);
  ok(c.delivery === 'faceless' && BCX.contextFromBrandRow({ voice_extra: {} }).delivery === 'face' && BCX.contextFromBrandRow({ voice_extra: { delivery: 'faceon' } }).delivery === 'face', '_brandctx: bc.delivery from voice_extra (default face)');
  ok(JSON.stringify(c.formatsOff) === '["qna"]', '_brandctx: bc.formatsOff, known formats only, once each');
  ok(c.newsDismissed.length === 2 && c.freshNews.length === 1 && c.freshNews[0].title === 'Runners rethink salt in the heat', 'dismissed headlines (by text in any case, or by link) never come back as news (C3)');
  const many = Array.from({ length: 250 }, (_, i) => 'old ' + i);
  ok(BCX.newsDismissedFrom(many).length === 200 && BCX.newsDismissedFrom(many)[199] === 'old 249', 'newsDismissed keeps the newest 200');
  ok(B.normFreshNews([{ title: 'Runners rethink salt in the heat', url: 'https://news.example/salt', date: NOW }], NOW, many.concat(['runners rethink salt in the heat'])).length === 0, 'normFreshNews: a dismissal at the END of a long list still counts (newest kept)');
  ok(BCX.populatedFieldCount(c) === BCX.populatedFieldCount(Object.assign({}, c, { delivery: undefined, newsDismissed: undefined, formatsOff: undefined })), 'the three settings never count as brand fields (the 424 stale-row check)');
  const long = 'B'.repeat(290);
  const mem = BCX.memoryFromRows([{ kind: 'belief', text: long, created_at: '2026-11-01' }]);
  ok(mem.beliefs[0] === long, 'beliefs load at 300 characters, not 140 (C5)');
  ok(JSON.stringify(B.effectiveTypeMix({ typeMix: { tip: 3, about: 1, news: 1, qna: 1, story: 1, bts: 0 }, formatsOff: ['qna'] })) === JSON.stringify({ tip: 4, about: 1, news: 1, qna: 0, story: 1, bts: 0 }), 'effectiveTypeMix: a type whose format is off gives its slots to tip');
  ok(JSON.stringify(B.effectiveTypeMix({ typeMix: { tip: 3, qna: 2 } })) === JSON.stringify({ tip: 3, about: 0, news: 0, qna: 2, story: 0, bts: 0 }), 'effectiveTypeMix (opposite): nothing off, the mix is unchanged');
}

// ═════ 4. guardPost: brand proof allowed, facts, no-sell, on-screen safety, fallbacks ═════
{
  const BRAND = { brandName: 'Saltline', socialProof: 'Stocked in 40 gyms across the Baltics.', reviewInsights: 'Rated 4.8 stars from 600 reviews.', stories: [{ id: 's1', text: 'In 2019 I cramped at mile 18 of the Tallinn marathon.' }] };
  let g = W.guardPost({ format: 'statement', title: 'Forty gyms', hook: 'h', boldText: 'We are stocked in 40 gyms across the Baltics. Not one asked for sugar.', script: 'Deadpan.' }, BRAND, { mode: 'batch' });
  ok(!g.drop && g.post.boldText === 'We are stocked in 40 gyms across the Baltics. Not one asked for sugar.', 'brand proof (social proof) is allowed material, never slotted (A2)');
  g = W.guardPost({ format: 'video', title: 't', hook: 'h', script: 'I cramped at mile 18 once. Salt fixed it.' }, BRAND, { mode: 'batch' });
  ok(!/\[your story/.test(g.post.script), 'brand-memory stories are allowed material too');
  ok(W.brandProof(BRAND).includes('40 gyms') && W.userFacts(BRAND).includes('40 gyms'), 'userFacts (the shared allowed material) carries the typed brand proof');
  // review 2 — AI-written lines are never proof
  const AIB = { brandName: 'Saltline', usps: 'No sugar. Rated 4.9 by 1200 buyers.',
    socialProof: 'Stocked in 40 gyms.\n[web] Featured in Runner\'s World 2025.\nRated 4.8 stars from 600 reviews on Trustpilot.\n4.9 stars from 1200 reviews on Google.',
    painPoints: 'Cramps at mile 20.\n[web] Customers say it cut cramps by 50%.', reviewInsights: 'Average 4.7 stars across 900 reviews.' };
  const P2 = W.brandProof(AIB), U2 = W.userFacts(AIB);
  ok(P2.includes('40 gyms') && P2.includes('Cramps at mile 20') && !/\[web\]|Runner|50%/.test(P2 + U2), 'brandProof/userFacts leave out [web]-tagged lines (crawl-brand appends)');
  ok(!/600 reviews|900 reviews/.test(P2 + U2), 'an untagged socialProof rating with a platform name, and every reviewInsights line, are not proof');
  ok(/1200 reviews on Google/.test(P2), 'opposite: the same kind of rating line stays when the brand\'s own USPs state its numbers');
  g = W.guardPost({ format: 'video', title: 't', hook: 'h', script: 'It cut cramps by 50%. We are rated 4.8 stars from 600 reviews on Trustpilot. We are stocked in 40 gyms.' }, AIB, { mode: 'batch' });
  ok(/your real version of "It cut cramps by 50%\."/.test(g.post.script) && /your real version of "We are rated 4\.8/.test(g.post.script) && /We are stocked in 40 gyms\./.test(g.post.script.replace(/\[your story:[^\]]*\]/g, '')), 'the guard slots AI-written proof, keeps typed proof');
  const CB = require_('fs').readFileSync(path.join(API, 'crawl-brand.js'), 'utf8');
  ok(/'\[web\] ' \+ l/.test(CB) && /webLines\(sj\.socialProofWeb\)/.test(CB) && /webLines\(sj\.customerVoice\)/.test(CB), 'crawl-brand tags every appended web line with "[web] "');
  // on-screen safety
  const INV = { format: 'statement', title: 'Save money', hook: 'Our customers save $400 a year.', boldText: 'Our customers save $400 a year. Most never notice the leak.', script: 'Deadpan, straight into camera. One take.', caption: 'Rinse less.\n\nOur customers save $400 a year.\n\nSave this.' };
  g = W.guardPost(INV, BRAND, { mode: 'batch' });
  ok(g.drop === true && g.reasons.includes('onscreen_slot'), 'batch: a statement whose on-screen text would need a slot is DROPPED, never drawn (B1)');
  const gs = W.guardPost(INV, BRAND, { mode: 'single' });
  ok(gs.drop === false && /\[your story/.test(gs.post.boldText), 'single post (the sheet fills slots before saving): kept, with the slot');
  ok(!/\$400|your story/.test(gs.post.caption) && gs.post.caption === 'Rinse less.\n\nSave this.', 'caption: the inventing sentence is REMOVED (no slot, line breaks kept)');
  ok(gs.post.hook === 'Most never notice the leak.' && !/Deadpan/.test(gs.post.hook), 'hook fallback = the first sentence of the post TEXT, never the shooting notes (B2)');
  const car = W.guardPost({ format: 'carousel', hook: 'We cut returns by 43%.', boldText: '1: Stop rinsing rice. 2: It washes off nothing useful. 3: Soak it instead.', script: 'Dark background, big white type.' }, BRAND, { mode: 'batch' });
  ok(!car.drop && car.post.hook === 'Stop rinsing rice.', 'carousel hook fallback = slide 1 text, never the design notes');
  const carInv = W.guardPost({ format: 'carousel', hook: 'h', title: 't', slides: ['Stop rinsing rice.', 'We cut returns by 43%.', 'Soak it instead.'] }, BRAND, { mode: 'batch' });
  ok(carInv.drop === true, 'batch: a carousel slide that would need a slot drops the post');
  const vid = W.guardPost({ format: 'video', title: 't', hook: 'h', script: 'We cut returns by 43%. Soak it instead.', overlays: ['We cut returns by 43%', 'Soak it'] }, BRAND, { mode: 'batch' });
  ok(!vid.drop && /\[your story/.test(vid.post.script) && JSON.stringify(vid.post.overlays) === '["Soak it"]', 'a spoken script keeps its slot (filled while filming); an inventing overlay is removed');
  const sl = W.guardPost({ format: 'video', title: '[your story: the day]', hook: 'h', script: 'Most people rinse rice because a grandparent did it, not because it helps the texture at all. Soak it.', onScreen: ['[your story: x]', 'Soak'] }, BRAND, { mode: 'batch' });
  ok(sl.post.title === 'Most people rinse rice because a grandparent did it, not because it helps the texture at' && JSON.stringify(sl.post.onScreen) === '["Soak"]', 'title fallback: the first full sentence cut on a WORD, never mid-word; a slotted overlay goes (' + sl.post.title + ')');
  ok(I.clipWord('Electrolytes matter enormously', 20) === 'Electrolytes matter' && I.clipWord('Supercalifragilistic', 5) === 'Supercalifragilistic', 'clipWord never cuts inside a word');
  // B8 — titles and beliefs are fact-checked
  const b8 = W.guardPost({ format: 'video', title: 'How we cut returns 43%', belief: 'We cut returns by 43% in a month', hook: 'h', script: 'Returns drop when the label is clear. Say the dose plainly.' }, BRAND, { mode: 'batch' });
  ok(b8.post.title === 'Returns drop when the label is clear' && b8.post.belief === '' && b8.reasons.includes('facts_belief_cleared'), 'batch titles and beliefs are fact-checked: inventing title falls back, inventing belief is cleared (B8)');
  const gif = W.guardIdeaFacts({ title: 'How we cut returns 43%', belief: 'We cut returns by 43%', hook: 'ok', script: 'Returns drop when the label is clear.' }, 'Saltline', []);
  ok(gif.idea.title === 'Returns drop when the label is clear' && gif.idea.belief === '', 'guardIdeaFacts (the older batch guard) checks titles and beliefs too');
  // no-sell: one selling slide / sentence goes, never the whole post
  const ns = W.guardPost({ format: 'carousel', hook: 'Salt matters.', title: 'Salt', boldText: 'Salt is what your muscles fire on.\n\nSweat takes it out.\n\nLink in bio.' }, BRAND, { mode: 'batch' });
  ok(!ns.drop && ns.post.boldText === 'Salt is what your muscles fire on.\n\nSweat takes it out.', 'one selling slide is removed, the carousel ships (B10)');
  const ns2 = W.guardPost({ format: 'video', hook: 'Use code SALT10.', title: 'Shop now', script: 'Salt matters. Shop now.', caption: 'Salt matters. #sale' }, BRAND, { mode: 'batch' });
  ok(!ns2.drop && ns2.post.script === 'Salt matters.' && ns2.post.hook === 'Salt matters.' && ns2.post.title === 'Salt matters' && ns2.post.caption === 'Salt matters.', 'a selling hook/title falls back to the text; a selling sentence and #sale are removed, not the post');
  const ns3 = W.guardPost({ format: 'video', hook: 'h', title: 't', script: 'Shop now. Use code SALT10.' }, BRAND, { mode: 'single' });
  ok(ns3.drop === true, 'nothing usable left (only a pitch): dropped');
}

// ═════ 5. hashtagsFor, sourceLine ═════
{
  const bc = { brandName: 'Acme Studio', communities: ['One', 'Two', 'FYP', 'Three', 'Four', 'Five', 'Viral'] };
  const t = W.hashtagsFor(bc);
  ok(t.length === 5 && t[0] === '#acmestudio' && t[1] === '#one' && !t.includes('#fyp') && !t.includes('#viral'), 'hashtagsFor(bc): the brand tag first, then themes, max 5, no hype tags (' + t.join(' ') + ')');
  ok(W.hashtagsFor({ brandName: 'X', communities: ['Sleep', 'Salt'] }, { script: 'salt salt' }).join(' ') === '#x #salt #sleep', 'an idea may rank the themes');
  ok(JSON.stringify(W.hashtagsFor({ brandName: 'Calm Co' })) === '["#calmco"]' && JSON.stringify(W.hashtagsFor({ brandName: 'Calm Co', communities: ['FYP'] })) === '["#calmco"]' && W.hashtagsFor({}).length === 0, 'no Content Themes: the brand tag alone, never [] for a named brand (review 4)');
  const fb = { facts: [{ id: 'F1', text: 'Adults lose about 2.5 litres of water a day.', url: 'https://a.example/1', title: 'A' }, { id: 'F2', text: 'Thirst starts after a 1 to 2 percent loss.', url: 'https://b.example/2', title: 'B' }] };
  ok(W.sourceLine(fb, ['F1']) === '\n\nSource: https://a.example/1' && W.sourceLine(fb, ['F1', 'F2']) === '\n\nSources: https://a.example/1 · https://b.example/2' && W.sourceLine(fb, ['F9']) === '', 'sourceLine: "" | "\\n\\nSource: url" | "\\n\\nSources: a · b"');
}

// ═════ 6. buildIdea: caption line breaks, #sale, title fallback ═════
{
  const S = 'Rinse less. Soak more.';
  const a = I.buildIdea(S, { title: 'Rinse less', hook: 'Rinse less.', caption: 'Rinse less.\n\nSoak more. #sale' }, { belief: 'Most people rinse rice because a grandparent did it, not because it helps' }, 'talking', 'Acme');
  ok(a.caption === 'Rinse less.\n\nSoak more.', 'caption keeps its line breaks; one "#sale" no longer replaces the whole caption (B9) (' + JSON.stringify(a.caption) + ')');
  const b = I.buildIdea(S, { title: 'Shop now' }, { belief: 'Most people rinse rice because a grandparent did it, not because it helps' }, 'talking', 'Acme');
  ok(b.title === 'Rinse less', 'fallback title = the script\'s first full sentence, never a belief cut mid-sentence (' + b.title + ')');
}

// ═════ 7. the new writer: faceless in every pass, voice in the spoken pass, prompt order, B8, trends, avoid ═════
const SRC = { kind: 'note', text: 'Most people rinse rice out of habit.' };
const DRAFT = 'Most people rinse rice out of habit. Soak it instead, so it cooks evenly.\n\nThe water does the work.';
const SHAPE = JSON.stringify({ title: 'Soak, do not rinse', hook: 'Most people rinse rice out of habit.', onScreen: ['Soak it'], caption: 'Soak it.', shots: ['Bowl of rice'], emphasis: ['Soak it'] });
{
  const BC = { brandName: 'Saltline', delivery: 'faceless', tones: ['dry'], coachNotes: 'Never say "hack".\nKeep sentences under 20 words.', voiceSample: 'So basically I just put a pinch in and that is it, nothing fancy.', avoidWords: 'hack', communities: ['Rice'] };
  calls = []; plan = () => JSON.stringify({ angles: [{ belief: 'Soak rice instead of rinsing it', why: 'w' }, { belief: 'B two', why: 'w' }, { belief: 'C three', why: 'w' }] });
  await W.runAngles({ bc: BC, source: SRC, postType: 'tip', avoidTitles: ['Why I stopped rinsing rice'] });
  const AP = calls[0].prompt;
  ok(/FACELESS/.test(AP), 'faceless reaches the angles prompt (A1/C1)');
  ok(/ALREADY POSTED OR PLANNED[^\n]*\n- Why I stopped rinsing rice/.test(AP), 'the angles step gets the anti-repeat titles (C6)');
  ok(AP.indexOf('EVERY POINT IS FOR THIS KIND OF POST') > AP.indexOf('BRAND PROFILE'), 'angles: the type rule comes after the long brand block (prompt size)');
  calls = []; plan = (i) => [DRAFT, DRAFT, SHAPE][i];
  const o = await W.runWrite({ bc: BC, source: SRC, angle: { belief: 'Soak rice instead of rinsing it', why: 'It cooks evenly.' }, format: 'talking', postType: 'tip' });
  const [DP, SP, HP] = calls.map(c => c.prompt);
  ok(calls.length === 3 && /FACELESS/.test(DP) && /FACELESS/.test(SP) && /FACELESS/.test(HP), 'faceless reaches the draft, spoken and shape prompts');
  ok(/no face in them/.test(HP) && !/one person can film on a phone/.test(HP), 'faceless shape pass: shots without a face');
  ok(/One or two slots is normal/.test(DP) && /SLOTS: Never put/.test(DP + SP + HP), 'a spoken draft may use slots; every pass carries the slot rule');
  ok(!/one thought per line/i.test(SP) && /joined by "and", "so", "because"/.test(SP), 'spoken pass: the draft\'s rhythm rule, not "one thought per line" (A8)');
  ok(/VOICE RULES[^\n]*\n- Never say "hack"\.\n- Keep sentences under 20 words\./.test(SP) && /recorded voice sample[^\n]*\n"So basically I just put a pinch in/.test(SP), 'spoken pass: the brand\'s voice memory and voice sample (A8)');
  const iB = DP.indexOf('BRAND PROFILE'), iT = DP.indexOf('THIS POST:'), iR = DP.indexOf('POST RULES:'), iF = DP.indexOf('FORMAT: ');
  ok(iB > 0 && iT > iB && iR > iT && iF > iT, 'draft: kind, format and post rules come AFTER the long brand block (prompt size)');
  ok(count(DP, B.PRIORITY_RULE) === 1 && !/outrank/i.test(DP + SP + HP), 'draft: one priority statement, nothing claims to outrank');
  ok(!STOCK.test(calls.map(c => c.prompt).join('\n')) && /HASHTAGS: write none/.test(DP) && /HASHTAGS: write none/.test(HP), 'no stock comment line in any prompt; every pass says no hashtags (A9)');
  ok(Array.isArray(o.idea.hashtags) && o.idea.hashtags.join(' ') === '#saltline #rice' && !('delivery' in o.idea), 'hashtags from the brand themes; the idea keys are unchanged');
  // face-on override on a faceless brand
  calls = []; plan = (i) => [DRAFT, DRAFT, SHAPE][i];
  await W.runWrite({ bc: BC, source: SRC, angle: { belief: 'Soak rice instead of rinsing it' }, format: 'talking', delivery: 'face' });
  ok(!/FACELESS/.test(calls[0].prompt) && /FACE-ON/.test(calls[0].prompt) && /one person can film on a phone/.test(calls[2].prompt), 'a per-post delivery override beats the brand setting');
  // statement: no step lists
  calls = []; plan = (i) => ['Soak rice. It cooks evenly.', 'Soak rice. It cooks evenly.', SHAPE][i];
  await W.runWrite({ bc: { brandName: 'Saltline' }, source: SRC, angle: { belief: 'Soak rice', kind: 'point' }, format: 'statement', postType: 'tip' });
  ok(!calls[0].prompt.includes(W.TYPE_SHAPES.tip) && calls[0].prompt.includes(W.SHORT_SHAPES.tip), 'a tip statement draft has the compressed shape, no "2 to 4 steps" (A4)');
  ok(!/One or two slots is normal/.test(calls[0].prompt) && /this post is on-screen text, so it carries no \[your story: …\] slot/.test(calls[0].prompt), 'a statement draft is never asked for a slot (review 1)');
  // B8 — a client-sent belief that invents does not license the number
  calls = []; plan = (i) => ['We cut returns by 43% in a month. Say the dose plainly.', 'We cut returns by 43% in a month. Say the dose plainly.', '{}'][i];
  const b8 = await W.runWrite({ bc: { brandName: 'Saltline' }, source: { kind: 'note', text: 'labels' }, angle: { belief: 'We cut returns by 43% in a month' }, format: 'talking' });
  ok(/\[your story/.test(b8.idea.script) && !/^We cut returns by 43%/.test(b8.idea.script), 'a belief that invents a number is not trusted material (B8)');
}
// handlers: delivery, dismissed news, trends, avoid titles
{
  const NOW = Date.now();
  const HBC = { brandName: 'Saltline', delivery: 'faceless', newsDismissed: ['runners rethink salt in the heat'], freshNews: [{ title: 'Runners rethink salt in the heat', url: 'https://n.example/a', date: NOW }, { title: 'Sports drinks lose shelf space', url: 'https://n.example/b', date: NOW }] };
  hydrate = () => ({ ok: true, bc: Object.assign({}, HBC), fields: 5, avoidTitles: ['Library title one'] });
  calls = []; plan = () => JSON.stringify({ angles: [{ belief: 'A one', why: 'w', newsIndex: 1 }, { belief: 'B two', why: 'w', newsIndex: 1 }, { belief: 'C three', why: 'w', newsIndex: 1 }] });
  let r = await quiet(() => hit(anglesH, { brandId: 'b1', postType: 'news', source: { kind: 'note', text: '' }, newsDismissed: ['sports drinks lose shelf space'] }));
  ok(r.statusCode === 409, 'news: the brand\'s dismissed headline AND the request\'s are both left out (409, nothing left)');
  calls = []; r = await quiet(() => hit(anglesH, { brandId: 'b1', postType: 'news', source: { kind: 'note', text: '' } }));
  ok(r.statusCode === 200 && !/Runners rethink salt/.test(calls[0].prompt) && /Sports drinks lose shelf space/.test(calls[0].prompt), 'news: a headline the brand dismissed never reaches the prompt');
  calls = []; plan = () => JSON.stringify({ angles: [{ belief: 'A one', why: 'w' }, { belief: 'B two', why: 'w' }, { belief: 'C three', why: 'w' }] });
  r = await quiet(() => hit(anglesH, { brandId: 'b1', source: SRC, delivery: 'face', recentTrends: ['Salt in coffee'], avoidTitles: ['Device title two'] }));
  ok(r.statusCode === 200 && /FACE-ON/.test(calls[0].prompt) && !/FACELESS/.test(calls[0].prompt), 'angles.js: the request\'s delivery overrides the brand\'s');
  ok(/- Salt in coffee/.test(calls[0].prompt) && /- Library title one/.test(calls[0].prompt) && /- Device title two/.test(calls[0].prompt), 'angles.js: trends and avoid titles (server + request) reach the prompt (C6)');
  calls = []; r = await quiet(() => hit(anglesH, { brandId: 'b1', source: SRC }));
  ok(r.statusCode === 200 && /FACELESS/.test(calls[0].prompt), 'angles.js: no override -> the brand\'s delivery');
  calls = []; plan = (i) => [DRAFT, DRAFT, SHAPE][i];
  r = await quiet(() => hit(writeH, { brandId: 'b1', source: SRC, angle: { belief: 'Soak rice' }, recentTrends: ['Salt in coffee'] }));
  ok(r.statusCode === 200 && /FACELESS/.test(calls[0].prompt) && /FACELESS/.test(calls[2].prompt) && /- Salt in coffee/.test(calls[0].prompt), 'write.js: brand delivery + trends reach the writer');
  calls = []; r = await quiet(() => hit(writeH, { brandId: 'b1', source: SRC, angle: { belief: 'Soak rice' }, delivery: 'face' }));
  ok(r.statusCode === 200 && !/FACELESS/.test(calls[0].prompt + calls[1].prompt + calls[2].prompt), 'write.js: the request\'s delivery overrides the brand\'s in every pass');
}

clearTimeout(WALL);
if (failed) { console.log('consistency-S1: ' + failed + ' failed, ' + passed + ' passed'); process.exit(1); }
console.log('CONSISTENCY S1 OK — ' + passed + ' checks: contract helpers, postRules (delivery/ending/hashtags/shape), brand block (no promote wording, one priority line, tones, trends label), _brandctx settings + dismissed news + beliefs 300, guardPost (proof allowed, on-screen drop, text fallbacks, titles/beliefs checked, one selling slide), new writer (faceless in every pass, voice in the spoken pass, rules after the brand block, trends, anti-repeat)');
