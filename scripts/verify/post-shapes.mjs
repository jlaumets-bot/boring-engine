#!/usr/bin/env node
// GATE post-shapes — v706 content quality, agent P (.unlazy/quality/PLAN.md). Proves, with the REAL
// api/_write.js, api/generate-ideas.js, api/write.js, api/angles.js and api/_brain.js:
//   1. every post type carries its own SHAPE (tip how-to, qna answer-first, story arc, news what/why/do,
//      bts a real moment, about the v704 story-or-lesson wording) in TYPE_RULES, the angles step, the
//      draft and the ideas batch; the angles step offers points that fit the type;
//   2. the opinion framing ("THE OPINION TO ARGUE", "does NOT share yet", the argue beats) appears only for
//      an opinion angle, and only a tip (or an untyped post) may be one;
//   3. CHECKED FACTS: the `facts` ids a writer returns are parsed, invented ids are stripped, a fact used as
//      written is never slotted, and the caption ends with "\n\nSource: <url>" or "\n\nSources: <u1> · <u2>"
//      (max 2, deduped, https only, never doubled, none on news which keeps its own line, kept by guardNoSell);
//      on a lean ideas request only the server-loaded facts count;
//   4. the lifted clips: a 1,800-char caption and a 280-char point survive; 2,200 is the caption ceiling;
//   5. one usage row per request and no extra AI call (write 3 calls, angles 1, ideas 1).
// Only the edges are stubbed: callLLM (captures prompts, answers from a plan, zero network), the usage
// meter, the session, the brand hydration and the access check. No real AI call is made.
//
// RUN:    node scripts/verify/post-shapes.mjs
// EXPECT: prints "POST SHAPES OK" and exits 0.
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const Module = require_('module');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = path.join(ROOT, 'api');
const WALL = setTimeout(() => { console.log('FAIL: post-shapes wall clock (60s) — something hung'); process.exit(1); }, 60000);
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

const URL_A = 'https://www.nih.gov/hydration/water-loss';
const URL_B = 'https://www.who.int/news/use-code-and-buy-now-guide';   // sales words in a path must not trip the guard
const FACTS = [
  { id: 'F1', text: 'Adults lose about 2.5 litres of water a day through breathing and sweat.', url: URL_A, title: 'NIH' },
  { id: 'F2', text: 'Thirst usually starts after the body has lost 1 to 2 percent of its water.', url: URL_B, title: 'WHO' },
  { id: 'F3', text: 'Coffee counts toward daily fluid intake for regular drinkers.', url: URL_A, title: 'NIH again' },   // same url as F1
  { id: 'F4', text: 'Sweat holds more sodium in some people than in others.', url: 'http://plain.example/sodium', title: 'Plain' },   // not https
];
const DAY = 86400000, NOW = Date.now();
const NEWS = [{ title: 'Retailers pull sugary sports drinks from shelves', url: 'https://news.example/b', date: NOW - DAY, source: 'Shop Weekly' }];
const BC = { brandName: 'Acme Salts', tones: ['dry'], usps: 'ZUSP salt sticks', productDetails: 'ZPROD 500mg sodium', stories: [], beliefs: [], engine: 'grok' };
let hydrated = null;
stub('_brandctx.js', { loadBrandContext: async () => ({ ok: true, bc: JSON.parse(JSON.stringify(hydrated)), fields: 5, avoidTitles: [] }) });
const setHydrated = (extra) => { hydrated = Object.assign({}, BC, { freshNews: NEWS, facts: FACTS }, extra || {}); };

const B = require_(path.join(API, '_brain.js'));
const W = require_(path.join(API, '_write.js'));
const I = W._internals;
const H = {
  ideas: require_(path.join(API, 'generate-ideas.js')),
  angles: require_(path.join(API, 'angles.js')),
  write: require_(path.join(API, 'write.js')),
};
const fakeRes = () => ({ statusCode: 0, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } });
const quiet = async (fn) => { const q = console.error, w = console.warn, l = console.log; console.error = console.warn = console.log = () => {}; try { return await fn(); } finally { console.error = q; console.warn = w; console.log = l; } };
async function run(name, body, planFn) {
  calls = []; plan = planFn || (() => ''); usageRows = 0;
  const res = fakeRes();
  await quiet(() => H[name]({ method: 'POST', headers: { origin: 'https://contentshrimp.com' }, body }, res));
  return res;
}
const SRC = I.normSource({ kind: 'note', text: 'People drink only when they feel thirsty.' });
const OPINION_WORDS = /THE OPINION TO ARGUE|does NOT share yet|contrarian but defensible/;
const sourceLines = (c) => (String(c).match(/^Sources?: .*$/gm) || []);

// ═════ 1. SHAPES PER TYPE ═════
{
  const T = W.TYPE_RULES, S = W.TYPE_SHAPES;
  ok(/practical how-to/i.test(T.tip) && /2 to 4 concrete steps/.test(S.tip) && /the problem/.test(S.tip) && /the result/.test(S.tip) && T.tip.includes(S.tip), 'tip: the problem, 2-4 concrete steps, the result');
  ok(/Only when the point is an opinion/.test(T.tip), 'tip: a sharp opinion only when the point is one');
  ok(/direct answer in the first sentence, then why/.test(S.qna) && T.qna.includes(S.qna), 'qna: the direct answer first, then why');
  ok(/the moment, the turn, the lesson/.test(S.story) && T.story.includes(S.story), 'story: moment, turn, lesson');
  ok(/what happened, why it matters to the viewer, what to do/.test(S.news) && T.news.includes(S.news), 'news: what happened, why it matters, what to do');
  ok(/real moment from the work/.test(S.bts) && T.bts.includes(S.bts), 'bts: a real moment from the work');
  ok(/ABOUT US, AS A STORY OR A LESSON/.test(T.about) && /it never sells/.test(T.about) && /Never an offer, a price, a feature list or a pitch/.test(T.about) && /Still spoken, still ONE point/.test(T.about), 'about: the v704 wording, one point');
  const all = Object.values(T).join('\n');
  ok(!/does not hold yet|The belief is your take/.test(all), 'TYPE_RULES: the universal "belief the viewer does not hold yet" framing is gone');
  const src = fs.readFileSync(path.join(API, '_write.js'), 'utf8') + fs.readFileSync(path.join(API, 'generate-ideas.js'), 'utf8');
  ok(!/a belief the viewer does not hold yet|starts from a belief its audience does not share/.test(src.replace(/^\s*\/\/.*$/gm, '')), 'no prompt says "a belief the viewer does not hold yet" any more');

  // the draft: each type's shape, framed as ONE point
  for (const t of W.POST_TYPES || B.POST_TYPES) {
    const p = I.draftPrompt(BC, SRC, { belief: 'Drink before you are thirsty.', why: 'w', kind: 'point' }, 'talking', [], t, t === 'news' ? NEWS[0] : null);
    ok(p.includes('THE ONE POINT THIS POST MAKES') && p.includes(S[t]) && !p.includes(W.OPINION_SHAPE) && !/THE OPINION TO ARGUE/.test(p), 'draft ' + t + ': one point, its own shape, no opinion beats');
  }
  // the angles step offers points that fit the type
  const AP = (t) => I.anglesPrompt(BC, SRC, 6, t, t === 'news' ? NEWS : undefined);
  ok(/write 6 practical how-tos/.test(AP('tip')) && /"kind":"point\|opinion"/.test(AP('tip')), 'angles tip: practical how-tos, kind labelled');
  ok(/real questions this audience asks/.test(AP('qna')) && /answered directly/.test(AP('qna')), 'angles qna: questions with direct answers');
  ok(/story points/.test(AP('story')) && /the moment and the turn/.test(AP('story')), 'angles story: story beats');
  ok(/what ONE of the headlines below means for the viewer/.test(AP('news')) && /what the viewer should do/.test(AP('news')), 'angles news: what a headline means, what to do');
  ok(/real moments from the work/.test(AP('bts')), 'angles bts: real moments');
  ok(/never a feature list or an offer/.test(AP('about')), 'angles about: story or lesson, never an offer');
  for (const t of ['qna', 'story', 'news', 'bts', 'about']) ok(!OPINION_WORDS.test(AP(t)) && !/"kind"/.test(AP(t)), 'angles ' + t + ': no opinion framing');
  ok(/does NOT share yet/.test(AP('tip')) && /does NOT share yet/.test(I.anglesPrompt(BC, SRC, 6)), 'angles tip + untyped: an opinion is allowed (labelled)');
  ok(I.anglesPrompt(BC, SRC, 6).includes(String(I.MAX_BELIEF)) && I.MAX_BELIEF === 300 && I.MAX_WHY === 400, 'angles: the 300 / 400 caps are the ones asked for');
}

// ═════ 2. OPINION FRAMING ONLY FOR OPINION ANGLES ═════
{
  const D = (kind, t) => I.draftPrompt(BC, SRC, Object.assign({ belief: 'Thirst is a late signal.', why: 'w' }, kind ? { kind } : {}), 'talking', [], t, null);
  const op = D('opinion', 'tip');
  ok(/THE OPINION TO ARGUE/.test(op) && op.includes(W.OPINION_SHAPE) && /Why most people disagree: w/.test(op) && !op.includes('THE ONE POINT THIS POST MAKES'), 'tip + opinion angle: argued as an opinion');
  ok(/THE OPINION TO ARGUE/.test(D('opinion', '')), 'untyped + opinion angle: argued as an opinion');
  for (const t of ['qna', 'story', 'bts', 'about']) { const p = D('opinion', t); ok(!/THE OPINION TO ARGUE/.test(p) && !p.includes(W.OPINION_SHAPE) && p.includes(W.TYPE_SHAPES[t]), t + ' + an "opinion" angle: still a point in its own shape'); }
  const pt = D('point', 'tip');
  ok(!/THE OPINION TO ARGUE/.test(pt) && !pt.includes(W.OPINION_SHAPE) && pt.includes(W.TYPE_SHAPES.tip) && /Why it matters: w/.test(pt), 'tip + point angle: a how-to, no opinion beats');
  const nk = D('', '');
  ok(nk.includes('THE ONE POINT THIS POST MAKES') && /If the point is a how-to/.test(nk) && nk.includes(W.OPINION_SHAPE) && /Context: w/.test(nk), 'no kind (older app) + untyped: one point, the writer picks how-to or opinion');
  ok(!D('', 'qna').includes(W.OPINION_SHAPE), 'no kind + qna: never the opinion beats');
  const na = I.normAngle({ belief: 'x', kind: 'opinion' }), nb = I.normAngle({ belief: 'x', kind: 'rant' });
  ok(na.kind === 'opinion' && !('kind' in nb), 'normAngle keeps a valid kind only');
  // runAngles labels kinds: a tip keeps opinions, any other type turns them into points
  const reply = JSON.stringify({ angles: [
    { kind: 'opinion', belief: 'Thirst is a late signal, so waiting for it is waiting too long.', why: 'most think thirst is early' },
    { kind: 'point', belief: 'Keep a full bottle where you work and finish it by lunch.', why: 'w' },
    { belief: 'Drink a glass with every meal.', why: 'w' },
  ] });
  calls = []; plan = () => reply;
  const ta = (await quiet(() => W.runAngles({ bc: BC, source: SRC, postType: 'tip', deadlineMs: 60000 }))).angles;
  ok(ta[0].kind === 'opinion' && ta[1].kind === 'point' && ta[2].kind === 'point', 'runAngles tip: opinion kept, how-tos are points');
  calls = []; plan = () => reply;
  const qa = (await quiet(() => W.runAngles({ bc: BC, source: SRC, postType: 'qna', deadlineMs: 60000 }))).angles;
  ok(qa.length === 3 && qa.every(a => a.kind === 'point'), 'runAngles qna: an "opinion" label becomes a point');
}

// ═════ 3. CHECKED FACTS ═════
const bcF = Object.assign({}, BC, { facts: FACTS });
const DRAFT = 'Most people only drink when they feel thirsty.\nAdults lose about 2.5 litres of water a day.\nSo keep a full bottle on your desk and finish it by lunch.';
const DRAFT2 = DRAFT + '\nThirst usually starts once your body has lost 1 to 2 percent of its water.';
const SHAPE = (caption) => JSON.stringify({ title: 'Drink before thirst', hook: 'Most people only drink when they feel thirsty.', onScreen: ['Drink early'], caption, shots: ['Desk with bottle'], emphasis: ['thirsty'] });
const writeWith = async (draftTail, caption, extra, draftText) => {
  const d = draftText || DRAFT;
  calls = []; plan = (i) => [d + draftTail, d, SHAPE(caption)][i];
  return quiet(() => W.runWrite(Object.assign({ bc: bcF, source: SRC, angle: { belief: 'Drink before you are thirsty.', why: 'w', kind: 'point' }, format: 'talking', postType: 'tip', deadlineMs: 200000 }, extra || {})));
};
{
  ok(W.factsBlockFor(bcF).startsWith('CHECKED FACTS (you may use these; cite by id)') && /\[F1\] Adults lose/.test(W.factsBlockFor(bcF)) && W.factsBlockFor(BC) === '', 'facts block: rendered only when the brand has facts');
  const p = I.draftPrompt(bcF, SRC, { belief: 'x' }, 'talking', [], 'tip', null);
  ok(p.includes('CHECKED FACTS') && /USED FACTS: followed by the ids/.test(p) && /exactly as written/.test(p) && /at most 2/.test(p), 'draft prompt: the facts, use-as-written, at most 2, USED FACTS trailer');
  ok(!/CHECKED FACTS|USED FACTS/.test(I.draftPrompt(BC, SRC, { belief: 'x' }, 'talking', [], 'tip', null)), 'draft prompt without facts: no facts block, no trailer');
  ok(JSON.stringify(W.knownFactIds(bcF, ['F1', 'F9', '[f2]', 'F1', 'none'])) === '["F1","F2"]', 'knownFactIds: invented ids stripped, canonical, once');

  let out = await writeWith('\nUSED FACTS: F1, F9, f2', 'Drink early. Your future self says thanks.', null, DRAFT2);
  let idea = out.idea;
  ok(JSON.stringify(idea.facts) === '["F1","F2"]', 'runWrite: facts = the real ids the draft named (F9 stripped) (' + JSON.stringify(idea.facts) + ')');
  ok(idea.caption === 'Drink early. Your future self says thanks.\n\nSources: ' + URL_A + ' · ' + URL_B, 'runWrite: two sources → "\\n\\nSources: <u1> · <u2>" (' + JSON.stringify(idea.caption) + ')');
  ok(!/USED FACTS/.test(idea.script) && !/USED FACTS/.test(calls[1].prompt) && /2\.5 litres/.test(idea.script) && !/\[your story/.test(idea.script), 'runWrite: the trailer never reaches the script; a fact used as written is not slotted');
  ok(calls.length === 3, 'runWrite: still 3 calls (draft, spoken, shape) with facts');

  out = await writeWith('', 'Drink early.');
  ok(JSON.stringify(out.idea.facts) === '["F1"]' && out.idea.caption === 'Drink early.\n\nSource: ' + URL_A, 'runWrite: a fact used without naming it is still cited, one source → "\\n\\nSource: <url>" (' + JSON.stringify(out.idea.caption) + ')');
  out = await writeWith('\nUSED FACTS: F1, F3', 'Drink early.');
  ok(out.idea.caption === 'Drink early.\n\nSource: ' + URL_A, 'runWrite: two facts on one url → one Source line (deduped)');
  out = await writeWith('\nUSED FACTS: F9', 'Drink early.', { bc: Object.assign({}, BC, { facts: FACTS.slice(1) }) });
  ok(!('facts' in out.idea) && sourceLines(out.idea.caption).length === 0 && /\[your story/.test(out.idea.script), 'runWrite: only invented ids → no facts, no Source line; the unchecked number is slotted');
  out = await writeWith('\nUSED FACTS: F4', 'Drink early.', { bc: Object.assign({}, BC, { facts: [Object.assign({}, FACTS[3], { text: 'Adults lose about 2.5 litres of water a day.' })] }) });
  ok(sourceLines(out.idea.caption).length === 0, 'runWrite: an http (not https) source is never linked');
  out = await writeWith('\nUSED FACTS: F1', 'Drink early.\n\nSource: https://made.up/x');
  ok(sourceLines(out.idea.caption).length === 1 && out.idea.caption.endsWith('Source: ' + URL_A) && !out.idea.caption.includes('made.up'), 'runWrite: a Source line the model wrote is replaced, never doubled');
  // news keeps its headline line only
  calls = []; plan = (i) => [DRAFT + '\nUSED FACTS: F1', DRAFT, SHAPE('Big news.')][i];
  out = await quiet(() => W.runWrite({ bc: bcF, source: SRC, angle: { belief: 'Shelves are changing.', why: 'w' }, format: 'talking', postType: 'news', news: NEWS[0], deadlineMs: 200000 }));
  ok(out.idea.postType === 'news' && out.idea.newsSource && out.idea.newsSource.url === NEWS[0].url && sourceLines(out.idea.caption).length === 0 && JSON.stringify(out.idea.facts) === '["F1"]', 'runWrite news: facts recorded, no fact Source line (the app adds the headline line once)');
  ok(W.captionWithFactSources('News.', [{ url: URL_A }], 'news') === 'News.', 'captionWithFactSources: news is left alone');
  // the guard keeps it
  const cap = 'Drink early.\n\nSources: ' + URL_A + ' · ' + URL_B;
  const g = W.guardNoSell(cap);
  ok(g.ok && g.text === cap && g.hits.length === 0, 'guardNoSell keeps the Source line (sales words in a URL path do not trip it)');
  const gi = W.guardIdeaNoSell({ caption: cap, format: 'carousel' });
  ok(gi.idea.caption === cap && gi.hits.length === 0, 'guardIdeaNoSell keeps it too');
  ok(W.captionWithFactSources('x', [{ url: URL_A }, { url: URL_B }, { url: 'https://third.example/c' }], 'tip').split(' · ').length === 2, 'max 2 sources');
  ok(W.captionWithFactSources('', [{ url: URL_A }], 'tip') === 'Source: ' + URL_A, 'an empty caption gets only the line');
  ok(W.captionWithFactSources('x', [{ url: 'http://plain.example/a' }, { url: 'javascript:alert(1)' }], 'tip') === 'x', 'only https links are ever appended');
  ok(W.captionWithFactSources('x', [{ url: URL_A }, { url: URL_A }], 'tip') === 'x\n\nSource: ' + URL_A, 'the same url twice → one Source line');
}

// ═════ 3b. REVIEW (v706 r2): a fact's numbers only in a sentence that USES the fact ═════
{
  const URL_C = 'https://www.cdc.gov/water/survey';
  const F5 = { id: 'F5', text: 'About 50% of adults do not drink enough water, a 2019 survey found.', url: URL_C, title: 'CDC' };
  const bc5 = Object.assign({}, BC, { facts: [F5], originStory: 'We started in 2019.' });
  const W5 = async (draft, tail) => { calls = []; plan = (i) => [draft + (tail || ''), draft, SHAPE('Drink early.')][i];
    return quiet(() => W.runWrite({ bc: bc5, source: SRC, angle: { belief: 'Drink before you are thirsty.', why: 'w', kind: 'point' }, format: 'talking', postType: 'tip', deadlineMs: 200000 })); };
  // the reviewer's scenario: a made-up customer statistic that shares only the number with a fact
  let o = await W5('50% of my customers reorder every month.\nSo keep a bottle close.', '\nUSED FACTS: F5');
  ok(/\[your story/.test(o.idea.script) && !/^50% of my customers/m.test(o.idea.script) && (o.passes.inventedRemoved || []).includes('50%'), 'review: "50% of my customers reorder" is flagged (the fact\'s 50% is not free material) (' + JSON.stringify(o.passes.inventedRemoved) + ')');
  ok(!('facts' in o.idea) && sourceLines(o.idea.caption).length === 0, 'review: the made-up statistic gets no facts and no Source (the named F5 is dropped: the text never uses it)');
  ok(W.inventedFactsIn('50% of my customers reorder.', 'brand stuff', [F5]).includes('50%') && W.inventedFactsIn('50% of my customers reorder.', 'brand stuff', []).includes('50%'), 'review: inventedFactsIn flags the borrowed number, with or without the fact pack');
  // as written: passes and is cited (named or not)
  o = await W5('About 50% of adults do not drink enough water, a 2019 survey found.\nSo keep a bottle close.');
  ok(!/\[your story/.test(o.idea.script) && /About 50% of adults/.test(o.idea.script) && JSON.stringify(o.idea.facts) === '["F5"]' && o.idea.caption.endsWith('Source: ' + URL_C), 'review: the fact as written passes and is cited');
  // reworded faithfully: passes and is cited
  o = await W5('A 2019 survey found that 50% of adults are not drinking enough water.\nSo keep a bottle close.', '\nUSED FACTS: F5');
  ok(!/\[your story/.test(o.idea.script) && JSON.stringify(o.idea.facts) === '["F5"]' && o.idea.caption.endsWith('Source: ' + URL_C), 'review: a reworded faithful use passes and is cited');
  // both in one draft: only the made-up sentence becomes a slot
  o = await W5('About 50% of adults do not drink enough water, a 2019 survey found.\n50% of my customers reorder every month.');
  ok(/^About 50% of adults do not drink enough water/m.test(o.idea.script) && /\[your story[^\]]*customers/.test(o.idea.script) && JSON.stringify(o.idea.facts) === '["F5"]', 'review: in one draft the faithful fact sentence stays and the borrowed one is slotted');
  // a year-only overlap (2019 is also in the brand's own story): never cited
  o = await W5('We started in 2019.\nSo keep a bottle close.');
  ok(!('facts' in o.idea) && sourceLines(o.idea.caption).length === 0 && !/\[your story/.test(o.idea.script), 'review: a year-only overlap does not cite the fact');
  ok(W.factIdsUsedIn(bc5, 'We started in 2019. Half of us drink coffee.').length === 0 && JSON.stringify(W.factIdsUsedIn(bc5, 'Most adults do not drink enough water, a survey found.')) === '["F5"]', 'factIdsUsedIn: key words, never a number alone');
  ok(JSON.stringify(W.citedFactIds(bc5, ['F5'], 'We started in 2019.')) === '[]', 'citedFactIds: a named fact the text never uses is dropped');
  // the ideas batch: the same rule through guardIdeaFacts
  const g = W.guardIdeaFacts({ script: '50% of my customers reorder. About 50% of adults do not drink enough water, a 2019 survey found.' }, 'brand', [F5]);
  ok(/\[your story[^\]]*50% of my customers/.test(g.idea.script) && /About 50% of adults do not drink/.test(g.idea.script) && !/\[your story[^\]]*About 50% of adults/.test(g.idea.script), 'guardIdeaFacts: the borrowed number is slotted, the faithful fact sentence is kept');
  // a picked point that carries the fact does not hand its number to the whole draft
  calls = []; plan = (i) => ['50% of my customers reorder every month.\nSo keep a bottle close.', '50% of my customers reorder every month.\nSo keep a bottle close.', SHAPE('Drink early.')][i];
  o = await quiet(() => W.runWrite({ bc: bc5, source: SRC, angle: { belief: 'About 50% of adults do not drink enough water.', why: 'A 2019 survey found it.', kind: 'point' }, format: 'talking', postType: 'tip', deadlineMs: 200000 }));
  ok(/\[your story/.test(o.idea.script) && (o.passes.inventedRemoved || []).includes('50%'), 'review: a fact inside the picked point does not make its 50% free for a made-up sentence');
  // the angles step: same rule
  calls = []; plan = () => JSON.stringify({ angles: [{ belief: '50% of my customers reorder every month.', why: 'w' }, { belief: 'About 50% of adults do not drink enough water.', why: 'w' }, { belief: 'Keep a bottle close.', why: 'w' }, { belief: 'Drink with every meal.', why: 'w' }] });
  const an = (await quiet(() => W.runAngles({ bc: bc5, source: SRC, postType: 'tip', deadlineMs: 60000 }))).angles;
  ok(!an.some(x => /customers/.test(x.belief)) && an.some(x => /About 50% of adults/.test(x.belief)), 'review: runAngles drops the borrowed-number point, keeps the faithful fact point');
  // facts never come from the request body
  setHydrated({ facts: [] });
  const rw = await run('write', { brandId: 'b1', brandContext: { facts: [F5] }, source: { kind: 'note', text: 'People drink only when thirsty.' }, angle: { belief: 'Drink before you are thirsty.', why: 'w' }, format: 'talking', postType: 'tip' },
    (i) => ['About 50% of adults do not drink enough water, a 2019 survey found.\nUSED FACTS: F5', 'About 50% of adults do not drink enough water, a 2019 survey found.', SHAPE('Drink early.')][i]);
  ok(rw.statusCode === 200 && !('facts' in rw.body.idea) && sourceLines(rw.body.idea.caption).length === 0 && !calls[0].prompt.includes('CHECKED FACTS'), 'write endpoint: a body-sent facts list is ignored');
  const ra = await run('angles', { brandId: 'b1', brandContext: { facts: [F5] }, source: { kind: 'note', text: 'x' }, postType: 'tip' }, () => JSON.stringify({ angles: [{ belief: 'a b c', why: 'w' }] }));
  ok(ra.statusCode === 200 && !calls[0].prompt.includes('CHECKED FACTS'), 'angles endpoint: a body-sent facts list is ignored');
  const ri = await run('ideas', { count: 1, brandContext: Object.assign({}, BC, { facts: [F5] }) }, () => JSON.stringify([{ belief: 'b', title: 'T', hook: 'H.', script: 'About 50% of adults do not drink enough water, a 2019 survey found.', facts: ['F5'], format: 'video', caption: '' }]));
  ok(ri.statusCode === 200 && !calls[0].prompt.includes('CHECKED FACTS') && !('facts' in ri.body.ideas[0]) && sourceLines(ri.body.ideas[0].caption).length === 0, 'ideas without a brandId: a body-sent facts list is ignored');
  setHydrated();
}

// ═════ 4. LIFTED CLIPS ═════
{
  const longCap = ('Keep a bottle where you work and drink from it every hour. ').repeat(31).trim();   // ~1,800 chars
  const b = I.buildIdea('Keep a bottle where you work.', { caption: longCap }, { belief: 'b' }, 'talking', 'Acme Salts');
  ok(longCap.length >= 1800 && b.caption === longCap, 'buildIdea: a 1,800-char caption survives (' + b.caption.length + ')');
  ok(I.buildIdea('x y z.', { caption: longCap + ' ' + longCap }, { belief: 'b' }, 'talking', '').caption.length <= 2200, 'buildIdea: 2,200 is the ceiling');
  const withSrc = W.captionWithFactSources(longCap + ' ' + longCap.slice(0, 380), [{ url: URL_A }, { url: URL_B }], 'tip');
  ok(withSrc.length <= 2200 && withSrc.endsWith('Sources: ' + URL_A + ' · ' + URL_B), 'caption + Source line stays within 2,200 (' + withSrc.length + ')');
  const point = ('Keep a bottle on your desk and refill it at lunch so you never wait for thirst ').repeat(4).slice(0, 280).trim();
  ok(I.normAngle({ belief: point, why: point + ' ' + point.slice(0, 100) }).belief === point && I.normAngle({ belief: point, why: point }).why === point, 'normAngle: a 280-char point and why survive');
  const af = I.anglesFrom({ angles: [{ belief: point, why: 'w' }] }, 5, false, 'tip');
  ok(af[0].belief === point, 'anglesFrom: a 280-char point survives');
}

// ═════ 5. THE IDEAS BATCH ═════
setHydrated();
{
  const idea = (o) => Object.assign({ belief: 'A point', day: 'Monday', community: 'running', format: 'carousel', tone: 'dry', title: 'T', hook: 'Hook line.', script: 'A script line.', emphasis: [], shots: '', caption: 'Save this.', reelTitle: 'R', tags: '#AcmeSalts', boldText: '1: Drink early. 2: Keep a bottle.' }, o);
  const point280 = ('Keep a bottle on your desk and refill it at lunch so you never wait for thirst ').repeat(4).slice(0, 280).trim();
  let r = await run('ideas', { brandId: 'b1', count: 3, typeMix: { tip: 1, qna: 1, story: 1 }, brandContext: { facts: [{ id: 'F1', text: 'evil', url: 'https://evil.example/x', title: 'x' }] } },
    () => JSON.stringify([idea({ title: 'A', postType: 'tip', facts: ['F1', 'F7'], belief: point280, script: 'Adults lose about 2.5 litres of water a day. So keep a bottle close.' }), idea({ title: 'B', postType: 'qna', format: 'qna', caption: '' }), idea({ title: 'C', postType: 'story', facts: ['F2', 'F3'], script: 'Thirst usually starts after the body has lost 1 to 2 percent of its water. Coffee counts toward your daily fluid intake too.' })]));
  const P = calls[0] ? calls[0].prompt : '';
  const L = (r.body && r.body.ideas) || [];
  ok(r.statusCode === 200 && L.length === 3, 'ideas: 200, 3 ideas (' + r.statusCode + ')');
  for (const t of ['tip', 'qna', 'story']) ok(P.includes('- ' + t + ': ' + W.TYPE_RULES[t]) && P.includes(W.TYPE_SHAPES[t]), 'ideas prompt: the ' + t + ' shape');
  ok(/THE POINT FIRST/.test(P) && /State the ONE point the idea makes/.test(P) && /A tip idea may instead make a sharp opinion/.test(P), 'ideas prompt: the point first; the opinion only for a tip idea');
  ok(P.includes('CHECKED FACTS') && P.includes('[F1] Adults lose') && !P.includes('evil') && /"facts": \["F1"\]/.test(P), 'ideas prompt: the SERVER-loaded facts (never the body list) and the facts key');
  ok(JSON.stringify(L[0].facts) === '["F1"]' && L[0].caption === 'Save this.\n\nSource: ' + URL_A, 'ideas: invented id stripped, the source of the hydrated fact (not the body url) (' + JSON.stringify(L[0].caption) + ')');
  ok(!('facts' in L[1]) && L[1].caption === '', 'ideas: an idea without facts has no facts key and no Source line');
  ok(L[2].caption === 'Save this.\n\nSources: ' + URL_B + ' · ' + URL_A, 'ideas: two sources, in the order named');
  ok(L[0].belief === point280, 'ideas: a 280-char point survives');
  ok(/2\.5 litres/.test(L[0].script) && !/\[your story/.test(L[0].script) && /1 to 2 percent/.test(L[2].script) && !/\[your story/.test(L[2].script), 'ideas: a CHECKED FACT used as written is not slotted');
  ok(calls.length === 1 && usageRows === 1, 'ideas: one call, one usage row (' + calls.length + '/' + usageRows + ')');

  r = await run('ideas', { brandId: 'b1', count: 2, typeMix: { qna: 1, story: 1 } }, () => JSON.stringify([idea({ title: 'Q', postType: 'qna', format: 'qna' }), idea({ title: 'S', postType: 'story' })]));
  const P2 = calls[0].prompt;
  ok(!/does NOT share yet|contrarian but defensible/.test(P2) && !P2.includes(W.OPINION_SHAPE), 'ideas without a tip slot: no opinion framing at all');
  ok(!/the belief as a claim|the middle argues it|The answer argues a belief/.test(P2) && /direct answer first, then why/.test(P2), 'ideas formats: point wording, qna answers first');

  r = await run('ideas', { brandId: 'b1', count: 2, typeMix: { news: 1, tip: 1 } }, () => JSON.stringify([idea({ title: 'N', postType: 'news', newsIndex: 1, facts: ['F1'], script: 'Adults lose about 2.5 litres of water a day.' }), idea({ title: 'T2', postType: 'tip', facts: ['F2'] })]));
  const N = (r.body.ideas || []).find(x => x.postType === 'news');
  ok(N && sourceLines(N.caption).length === 0 && JSON.stringify(N.facts) === '["F1"]', 'ideas news: facts recorded, no fact Source line (send-daily / the app add the headline line once)');

  setHydrated({ facts: [] });
  r = await run('ideas', { brandId: 'b1', count: 1, typeMix: { tip: 1 } }, () => JSON.stringify([idea({ title: 'X', postType: 'tip', facts: ['F1'] })]));
  ok(!/CHECKED FACTS|"facts":/.test(calls[0].prompt) && !('facts' in r.body.ideas[0]) && sourceLines(r.body.ideas[0].caption).length === 0, 'ideas without a fact pack: no facts block, key or Source line');
}

// ═════ 6. ENDPOINTS: one usage row, no extra call ═════
setHydrated();
{
  let r = await run('write', { brandId: 'b1', source: { kind: 'note', text: 'People drink only when thirsty.' }, angle: { belief: 'Drink before you are thirsty.', why: 'w', kind: 'point' }, format: 'talking', postType: 'tip' },
    (i) => [DRAFT2 + '\nUSED FACTS: F2', DRAFT2, SHAPE('Drink early.')][i]);
  ok(r.statusCode === 200 && calls.length === 3 && usageRows === 1, 'write endpoint: 3 calls, one usage row (' + r.statusCode + ' ' + calls.length + '/' + usageRows + ')');
  ok(r.body && r.body.idea && JSON.stringify(r.body.idea.facts) === '["F2","F1"]' && r.body.idea.caption.endsWith('Sources: ' + URL_B + ' · ' + URL_A), 'write endpoint: named fact first, the used-but-unnamed one after');
  r = await run('angles', { brandId: 'b1', source: { kind: 'note', text: 'People drink only when thirsty.' }, postType: 'qna' },
    () => JSON.stringify({ angles: [{ belief: 'Is coffee dehydrating? No, it counts toward your fluids.', why: 'w' }, { belief: 'Do you need 8 glasses? Roughly, but food counts too.', why: 'w' }, { belief: 'Is thirst enough? Mostly, unless you sweat a lot.', why: 'w' }] }));
  ok(r.statusCode === 200 && calls.length === 1 && usageRows === 1 && r.body.angles.every(a => a.kind === 'point'), 'angles endpoint: one call, one usage row, qna points');
  ok(calls[0].prompt.includes('CHECKED FACTS'), 'angles prompt: the facts are offered');
  ok(JSON.stringify(W.CLAUDE_CALL_PLAN.write.map(x => x.max)) === JSON.stringify([3000, 3000, 6000, 6000, 3000, 1200]) && W.CLAUDE_CALL_PLAN.ideas.length === 3 && W.CLAUDE_CALL_PLAN.angles.length === 2, 'CLAUDE_CALL_PLAN unchanged');
}

clearTimeout(WALL);
if (failed) { console.log('post-shapes: ' + failed + ' failed, ' + passed + ' passed'); process.exit(1); }
console.log('POST SHAPES OK — ' + passed + ' checks: shapes per type, opinion only for opinion angles, checked facts + Source line, lifted clips, one usage row');
