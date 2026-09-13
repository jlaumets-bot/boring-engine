#!/usr/bin/env node
// Brand-prompt verification.
//
// WHAT THIS DOES: stubs callLLM (via require.cache) so nothing hits the network, invokes each
// generator's real handler with a fully-populated fake brand context, captures the REAL assembled
// prompt string, and asserts the brand's own data actually reaches the model.
//
// Every brand field below carries a unique ZKEY_* token, so "did this field survive into the
// prompt?" is a substring test with no false positives.
//
//   node scripts/verify/brand-prompt.mjs             → run the assertions (exit 1 on failure)
//   node scripts/verify/brand-prompt.mjs --snapshot  → record the CURRENT prompt as the "before"
//                                                      fixture (run this before changing the code)
//
// The "before" fixture is a literal capture of the pre-fix assembled prompt, so the before/after
// numbers printed at the end are measured, not asserted.

import { createRequire } from 'module';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const API = join(ROOT, 'api');
const FIXTURES = join(__dirname, 'fixtures');
const BEFORE_FIXTURE = join(FIXTURES, 'generate-ideas.before.txt');
const SNAPSHOT = process.argv.includes('--snapshot');
const RECONSTRUCT = process.argv.includes('--reconstruct');

const require = createRequire(import.meta.url);

// ── stub plumbing ────────────────────────────────────────────────────────────
function stub(relPath, exports) {
  const resolved = require.resolve(join(API, relPath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports, children: [], paths: [] };
}

let captured = [];      // every callLLM({messages, ...}) the handler made, in order
let nextReplies = [];   // queued stub responses, consumed in order

stub('_llm.js', {
  callLLM: async (opts) => {
    captured.push(opts);
    const r = nextReplies.shift();
    if (r == null) throw new Error('verify: handler made more callLLM calls than expected');
    return r;
  },
  callGrokSearch: async () => null,
});
stub('_usage.js', {
  guard: async () => ({ user: { id: 'u1' }, over: false, gate: {} }),
  checkLimit: async () => ({ ok: true }),
  creditsFor: () => 1,
  costFor: () => 0,
  logUsage: async () => {},
});
stub('_requireUser.js', async () => ({ id: 'u1' }));
stub('_publish/store.js', {
  getUser: async () => ({ id: 'u1' }),
  userCanAccessBrand: async () => true,
  rest: async () => ({ data: [{ gemini_key_enc: 'enc' }] }),
});
stub('_publish/crypto.js', { encrypt: () => 'enc', decrypt: () => ({ key: 'fake-gemini-key' }) });

process.env.CRON_SECRET = 'verify-secret'; // lets generate-ideas take its internal path (no auth I/O)

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

async function run(handlerFile, body, replies, headers = {}) {
  captured = [];
  nextReplies = replies.slice();
  const handler = require(join(API, handlerFile));
  const req = { method: 'POST', headers: { origin: 'https://contentshrimp.com', ...headers }, body };
  const res = mkRes();
  await handler(req, res);
  return { res, calls: captured.slice() };
}

// ── the fake brand ───────────────────────────────────────────────────────────
const BC = {
  brandId: 'brand-1',
  brandName: 'Boring Electrolytes',
  website: 'https://zkey-website.example.com',
  tagline: 'ZKEY_TAGLINE Three ingredients. No marketing.',
  usps: 'ZKEY_USPS Sodium 1000mg, potassium 200mg, magnesium 60mg per stick. No sweeteners, no colouring, no flavour oils. Thirty sticks per box.',
  targetAudience: 'ZKEY_AUDIENCE Endurance runners and lifters aged 25 to 45 who read the label before they read the ad and distrust supplement marketing.',
  tones: ['deadpan', 'blunt', 'technical'],
  communities: ['marathon training', 'hyrox', 'shift work'],
  competitors: 'ZKEY_RIVALS LMNT, Liquid IV and Prime all lead with flavour and celebrity faces rather than the actual dose on the label.',
  bannedTopics: 'ZKEY_BANNED weight loss promises; curing hangovers; anything that sounds medical',
  painPoints: 'ZKEY_PAIN Cramping at mile eighteen. Paying premium money for sugar water. Labels that bury the sodium dose inside a proprietary blend.',
  brandVocab: 'ZKEY_VOCAB dose, stick, label, boring, the actual numbers',
  avoidWords: 'ZKEY_AVOIDWORD gamechanger; hydration hack; unlock your potential',
  productDetails: 'ZKEY_PRODUCT The Boring Stick is a 6g unflavoured powder sachet. The Boring Box holds thirty. Nothing else is sold.',
  exampleContent: 'ZKEY_EXAMPLECONTENT We could have added strawberry flavour. We did the maths on what that would cost you in sodium per serving and stopped.',
  ctaStyle: 'ZKEY_CTA Never a hard sell. Close by naming the label and letting the reader go compare it themselves.',
  originStory: 'ZKEY_ORIGIN Started after a coach spent an hour comparing labels in a shop and found four brands hiding the same tiny dose.',
  socialProof: 'ZKEY_SOCIALPROOF Used by 412 runners in the 2025 Tallinn marathon field. Featured once in a running podcast, never paid for.',
  webMentions: 'ZKEY_WEBMENTIONS Reddit threads praise the honesty of the label and complain the powder does not dissolve fast in cold water.',
  categoryGripes: 'ZKEY_GRIPES People across the whole category complain about proprietary blends, sweetener aftertaste and paying for branding.',
  reviewInsights: 'ZKEY_REVIEWS Reviewers repeatedly praise the plain label and the dose. The recurring complaint is that it tastes like the sea.',
  channels: 'ZKEY_CHANNELS Instagram Reels and TikTok, plus a small email list that gets one message a month.',
  visualStyle: 'ZKEY_VISUALSTYLE Flat cream backgrounds, one product, hard shadow, no lifestyle stock imagery ever.',
  coachNotes: 'ZKEY_COACHNOTES Never open with a question. Always name the dose in the first two lines. Never say hydration hack.',
  learnedSignals: 'ZKEY_SIGNALS Recently APPROVED (favor these): the label comparison post, the mile eighteen cramp story. Recently DISMISSED (avoid): the generic morning routine post.',
  competitorMoves: 'ZKEY_COMPETITORMOVES LMNT launched a chocolate flavour last week and Prime cut its price by a fifth.',
  approvedExamples: [
    { title: 'The label test', format: 'video', text: 'ZKEY_WINNER_ONE Pick up whatever you are drinking and find the sodium number on the back. If it is under 500mg it is a flavoured drink, not an electrolyte. That is the entire test and it takes four seconds.' },
    { title: 'Sugar water maths', format: 'statement', text: 'ZKEY_WINNER_TWO You are not underhydrated. You are undersalted. Water without sodium just leaves faster.' },
    // Deliberately longer than 300 characters: this is the case the old flat 300-char cut mangled,
    // turning a full spoken script into a third of itself. If the cap regresses, this example gets
    // chopped and the FIX3 truncation assertion below fails.
    { title: 'Mile eighteen', format: 'video', text: 'ZKEY_WINNER_THREE The cramp at mile eighteen did not start at mile eighteen. It started at breakfast, when you drank a litre of plain water and ate nothing salty with it. Then you drank more water on the start line, and more at every station, and every one of those bottles washed a bit more sodium out of you. By the time your calf locks up you are not short of water. You are short of salt, and you have been since seven in the morning. The fix is boring and it is also the whole fix.' },
  ],
  recentTrends: ['ZKEY_TREND label-reading videos are outperforming product demos this month'],
  dayMap: 'Monday = ZKEY_DAYMAP label breakdowns, Tuesday = training, Wednesday = shift work, Thursday = myths, Friday = founder, Saturday = long run, Sunday = recovery',
  engine: 'grok',
};

// Values worth measuring as "this brand's own data". Short scalars are excluded as noise.
function brandValues(bc) {
  const out = [];
  for (const [k, v] of Object.entries(bc)) {
    if (k === 'approvedExamples' || k === 'engine' || k === 'brandId') continue;
    if (Array.isArray(v)) { const s = v.join(', '); if (s.length >= 12) out.push([k, s]); continue; }
    if (typeof v === 'string' && v.length >= 12) out.push([k, v]);
  }
  for (const [i, e] of (bc.approvedExamples || []).entries()) out.push([`approvedExamples[${i}]`, e.text]);
  return out;
}

// How many characters of `value` actually survived into `prompt` (longest present prefix —
// truncation always cuts the tail, so a prefix search measures it exactly).
// PROBE is deliberately long: a short probe collides across fields that share a token prefix
// (ZKEY_COMPETITORS vs ZKEY_COMPETITORMOVES) and silently reports an ABSENT field as present.
const PROBE = 40;
function presentChars(prompt, value) {
  if (!value) return 0;
  const probe = Math.min(PROBE, value.length);
  if (!prompt.includes(value.slice(0, probe))) return 0;
  let lo = probe, hi = value.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (prompt.includes(value.slice(0, mid))) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// Comma/whitespace normalisation, applied to BOTH sides so before and after are compared on equal
// terms (the old renderer stringified arrays as "a,b,c", the new one joins them as "a, b, c" —
// that is formatting, not a dropped field, and must not be scored as one).
const norm = s => String(s).replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim();

function measure(rawPrompt, bc) {
  const prompt = norm(rawPrompt);
  let brandChars = 0;
  const missing = [];
  for (const [k, raw] of brandValues(bc)) {
    const v = norm(raw);
    const got = presentChars(prompt, v);
    brandChars += got;
    if (got === 0) missing.push(k);
  }
  return { total: rawPrompt.length, brandChars, share: rawPrompt.length ? brandChars / rawPrompt.length : 0, missing };
}

// ── canned model replies ─────────────────────────────────────────────────────
const IDEAS_REPLY = JSON.stringify([{
  day: 'Monday', community: 'label breakdowns', format: 'video', tone: 'deadpan',
  title: 'Read the back of the packet', hook: 'Turn the packet over.',
  script: 'Turn it over and find the sodium number. Under 500mg and it is a flavoured drink.',
  emphasis: ['sodium number'], shots: 'Shot 1: hand turning a sachet over.',
  caption: '', reelTitle: 'The label test', tags: '#BoringElectrolytes #running #sodium',
}]);
const REMIX_REPLY = JSON.stringify({ originalSummary: 's', remixTitle: 't', remixHook: 'h', remixScript: 'sc', remixFormat: 'video', remixCaption: 'c', remixHashtags: '#a', whyItWorks: 'w' });
const TWIST_REPLY = JSON.stringify({ angles: [{ angle: 'Contrarian', hook: 'h', why: 'w' }], spicy: { hook: 'h', why: 'w' }, tip: 't' });
const REWRITE_REPLY = JSON.stringify({ title: 't', hook: 'h', script: 's', shots: '', screen: '', boldText: '', caption: '', tags: '#a' });
const BLOG_REPLY = JSON.stringify([{ question: 'q', answer: 'a', htmlContent: '<article></article>', category: 'Hydration', wordCount: 300 }]);
const SHARPEN_CRITIQUE = 'The hook buries the number.';
const SHARPEN_REPLY = JSON.stringify({ hook: 'Turn the packet over.', script: 'Find the sodium number.' });

// ── assertions ───────────────────────────────────────────────────────────────
const failures = [];
const notes = [];
const recency = [];

// ── RECENCY ─────────────────────────────────────────────────────────────────
// v640 moved generate-ideas' brand block to the end of its prompt because positional mass beats a
// precedence sentence: a model weights the tail of what it reads hardest, and the brand block was
// sitting at ~2% with 13,465 chars of universal house rules between it and the task.
//
// This measures the SAME property for every generator, so the class cannot come back one file at a
// time. The probe is the START OF THE APPROVED WINNERS, because fullBrandBlock renders the winners
// last inside the block — they are both the strongest brand signal and the block's own tail, so
// "where do the winners sit" is the honest measure of whether the brand reached the recency zone.
//
// TAIL_CAP matches the 4000-char window FIX3 already applies to generate-ideas. WINNERS_MIN_PCT is
// the positional half: a prompt can satisfy an absolute tail cap and still be enormous, so the
// winners must ALSO land in the last 40%. Measured reality when these were set: every generator
// lands its winners at 78-89% with a 2.3-3.1k tail; pre-fix remix.js sat at 32.1% with 9.8k.
const TAIL_CAP = 4000;
const WINNERS_MIN_PCT = 0.60;
function checkRecency(label, prompt) {
  const iWin = prompt.indexOf('ZKEY_WINNER_ONE');
  ok(iWin > -1, `RECENCY ${label}: approved winners reach the model at all`);
  if (iWin < 0) return;
  const pct = iWin / prompt.length;
  const tail = prompt.length - iWin;
  recency.push(`  ${label.padEnd(20)} winners at ${(pct * 100).toFixed(1).padStart(5)}% · ${String(tail).padStart(5)} chars read after them`);
  ok(pct >= WINNERS_MIN_PCT, `RECENCY ${label}: brand winners sit in the recency zone`,
    `winners at ${(pct * 100).toFixed(1)}% of the prompt, needs >= ${(WINNERS_MIN_PCT * 100).toFixed(0)}%`);
  ok(tail <= TAIL_CAP, `RECENCY ${label}: little enough is read after the brand`,
    `${tail} chars follow the winners, cap ${TAIL_CAP}`);
}
function ok(cond, label, detail) { if (!cond) failures.push(label + (detail ? ' — ' + detail : '')); }
function has(prompt, needle, label) { ok(prompt.includes(needle), label, `"${needle.slice(0, 60)}" not found in prompt`); }
function hasNot(prompt, needle, label) { ok(!prompt.includes(needle), label, `"${needle.slice(0, 60)}" is STILL in the prompt`); }

const IDEAS_BODY = { brandContext: BC, count: 3, learningContext: '' };
const CRON = { authorization: 'Bearer verify-secret' };

const main = async () => {
  // ── 1 · generate-ideas: the prompt that powers Ideas, Quick Post, Idea Catcher, PAA, refill ──
  const ideas = await run('generate-ideas.js', IDEAS_BODY, [IDEAS_REPLY], CRON);
  ok(ideas.res._status === 200, 'generate-ideas returned 200', 'status ' + ideas.res._status + ' ' + JSON.stringify(ideas.res._json).slice(0, 200));
  ok(ideas.calls.length === 1, 'generate-ideas made exactly one LLM call', 'made ' + ideas.calls.length);
  const P = ideas.calls[0].messages.map(m => m.content).join('\n');

  // RECONSTRUCT the "before" baseline. Use this INSTEAD of --snapshot if the fixture is ever lost:
  // --snapshot on current code writes the CURRENT prompt as the "before", which silently makes the
  // three DELTA assertions compare the code against itself and pass/fail meaninglessly. (That is
  // exactly how the original literal capture was destroyed — it is untracked, so there is no undo.)
  // This mode instead re-renders the prompt through the CURRENT code with the five brand fields the
  // pre-v612 buildMasterPrompt is documented to have silently dropped, which reproduces everything
  // measure() actually looks at (brandChars, share, missing) without pretending to be a capture.
  if (RECONSTRUCT) {
    const DROPPED = ['approvedExamples', 'learnedSignals', 'competitors', 'channels', 'visualStyle'];
    const oldBC = { ...BC };
    for (const k of DROPPED) delete oldBC[k];
    const old = await run('generate-ideas.js', { ...IDEAS_BODY, brandContext: oldBC }, [IDEAS_REPLY], CRON);
    const oldP = old.calls[0].messages.map(m => m.content).join('\n');
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(BEFORE_FIXTURE, oldP, 'utf8');
    const m = measure(oldP, BC);
    console.log('RECONSTRUCTED baseline written (not a literal capture):', BEFORE_FIXTURE);
    console.log(`  simulates the pre-v612 renderer dropping: ${DROPPED.join(', ')}`);
    console.log(`  prompt chars: ${m.total}  brand chars: ${m.brandChars}  brand share: ${(m.share * 100).toFixed(1)}%`);
    console.log('  fields NOT reaching the model:', m.missing.join(', ') || '(none)');
    process.exit(0);
  }

  if (SNAPSHOT) {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(BEFORE_FIXTURE, P, 'utf8');
    const m = measure(P, BC);
    console.log('snapshot written:', BEFORE_FIXTURE);
    console.log(`  prompt chars: ${m.total}  brand chars: ${m.brandChars}  brand share: ${(m.share * 100).toFixed(1)}%`);
    console.log('  fields NOT reaching the model:', m.missing.join(', ') || '(none)');
    process.exit(0);
  }

  // FIX 1 — the fields the old buildMasterPrompt silently dropped
  has(P, 'ZKEY_WINNER_ONE', 'FIX1 approved-winner example text reaches generate-ideas');
  has(P, 'ZKEY_WINNER_TWO', 'FIX1 second approved-winner reaches generate-ideas');
  has(P, 'ZKEY_SIGNALS', 'FIX1 learnedSignals reaches generate-ideas');
  has(P, 'ZKEY_RIVALS', 'FIX1 competitors reaches generate-ideas');
  has(P, 'ZKEY_CHANNELS', 'FIX1 channels reaches generate-ideas');
  has(P, 'ZKEY_VISUALSTYLE', 'FIX1 visualStyle reaches generate-ideas');
  // FIX 1 — and the fields fullBrandBlock used to drop, which must NOT regress
  has(P, 'ZKEY_REVIEWS', 'FIX1 reviewInsights still reaches generate-ideas');
  has(P, 'ZKEY_GRIPES', 'FIX1 categoryGripes still reaches generate-ideas');
  has(P, 'ZKEY_COMPETITORMOVES', 'FIX1 competitorMoves still reaches generate-ideas');
  has(P, 'ZKEY_WEBMENTIONS', 'FIX1 webMentions still reaches generate-ideas');
  has(P, 'ZKEY_DAYMAP', 'FIX1 dayMap still reaches generate-ideas');
  has(P, 'zkey-website.example.com', 'FIX1 website still reaches generate-ideas');
  // and the rest of the union, so nothing was lost in the merge
  // ZKEY_MASTERDOC removed v636 — the Master Prompt doc feature was retired, so it is no
  // longer rendered into any prompt. Every other field in the union still is.
  for (const t of ['ZKEY_TAGLINE', 'ZKEY_USPS', 'ZKEY_AUDIENCE', 'ZKEY_BANNED', 'ZKEY_PAIN', 'ZKEY_VOCAB',
    'ZKEY_AVOIDWORD', 'ZKEY_PRODUCT', 'ZKEY_EXAMPLECONTENT', 'ZKEY_CTA', 'ZKEY_ORIGIN', 'ZKEY_SOCIALPROOF']) {
    has(P, t, 'FIX1 ' + t + ' reaches generate-ideas');
  }

  // FIX 2 — generic voice prescriptions that contradicted the brand are gone
  hasNot(P, 'knowledgeable friend', 'FIX2 "knowledgeable friend" prescription removed');
  hasNot(P, 'Mix tones across posts', 'FIX2 "mix tones across posts" instruction removed');
  hasNot(P, 'Pick a different tone for each idea', 'FIX2 per-idea tone rotation removed');

  // FIX 3 — approved winners sit AFTER the generic writing rules, near the output instruction
  const iWinners = P.indexOf('ZKEY_WINNER_ONE');
  const iClarity = P.indexOf('CLARITY & FLOW');
  const iRhythm = P.indexOf('RHYTHM & DRAMA TELLS');
  const iHooks = P.indexOf('HOOK RULES');
  const iOutput = P.lastIndexOf('Return ONLY the JSON array');
  ok(iClarity > -1 && iRhythm > -1 && iHooks > -1 && iOutput > -1, 'FIX3 prompt landmarks found',
    `clarity=${iClarity} rhythm=${iRhythm} hooks=${iHooks} output=${iOutput}`);
  ok(iWinners > iClarity, 'FIX3 winners appear AFTER the clarity rules', `winners=${iWinners} clarity=${iClarity}`);
  ok(iWinners > iRhythm, 'FIX3 winners appear AFTER the anti-slop rhythm rules', `winners=${iWinners} rhythm=${iRhythm}`);
  ok(iWinners > iHooks, 'FIX3 winners appear AFTER the hook rules', `winners=${iWinners} hooks=${iHooks}`);
  ok(iWinners < iOutput, 'FIX3 winners appear BEFORE the final output instruction', `winners=${iWinners} output=${iOutput}`);
  ok(iOutput - iWinners < 4000, 'FIX3 winners sit close to the output instruction',
    `${iOutput - iWinners} chars away (recency window)`);
  // and the truncation is no longer cutting a real spoken script down to a third
  const nP = norm(P);
  const long = BC.approvedExamples[2]; // a >300-char spoken (video) script
  const longGot = presentChars(nP, norm(long.text));
  ok(long.text.length > 300, 'FIX3 the truncation probe example really is longer than the old cap',
    `probe is only ${long.text.length} chars — it cannot detect a 300-char cut`);
  ok(longGot > 300, 'FIX3 example truncation raised above the old 300-char cut',
    `only ${longGot} of ${long.text.length} chars of a spoken script survived`);
  for (const [i, e] of BC.approvedExamples.entries()) {
    const got = presentChars(nP, norm(e.text));
    ok(got === norm(e.text).length, `FIX3 approved example ${i + 1} reaches the model uncut`,
      `${got} of ${norm(e.text).length} chars survived`);
  }

  // FIX 4 — rulePrecedence must point at the brand section by NAME, not by position
  hasNot(P, 'at the top of this prompt', 'FIX4 positional "top of this prompt" wording removed');
  has(P, 'BRAND PROFILE', 'FIX4 brand section carries the literal heading rulePrecedence references');

  // FIX 2 (cont.) — with no tones set, nothing is invented on the brand's behalf
  const noTones = await run('generate-ideas.js', { ...IDEAS_BODY, brandContext: { ...BC, tones: [] } }, [IDEAS_REPLY], CRON);
  const PN = noTones.calls[0].messages.map(m => m.content).join('\n');
  hasNot(PN, 'witty, educational', 'FIX2 empty tones no longer default to "witty, educational"');

  // FIX 5 — a whitespace-only field must not render a bare label into the prompt
  const blankBC = { ...BC, painPoints: '   ', coachNotes: '\n\t ', exampleContent: '  ', learnedSignals: ' ' };
  const blank = await run('generate-ideas.js', { ...IDEAS_BODY, brandContext: blankBC }, [IDEAS_REPLY], CRON);
  const PB = blank.calls[0].messages.map(m => m.content).join('\n');
  for (const label of ['Customer pain points', 'Voice memory', 'Example content the brand loved', 'Recent taste signal']) {
    hasNot(PB, label, 'FIX5 whitespace-only field renders no bare "' + label + '" label');
  }

  // A brand-new account has an EMPTY brand profile, and fullBrandBlock now returns '' for that
  // (it used to always emit a stub "BRAND: My Brand"). That path must still produce a usable
  // prompt with no "undefined"/"[object Object]" leaking into it.
  const empty = await run('generate-ideas.js', { brandContext: {}, count: 3 }, [IDEAS_REPLY], CRON);
  ok(empty.res._status === 200, 'empty brand profile still generates', 'status ' + empty.res._status);
  const PE = empty.calls.length ? empty.calls[0].messages.map(m => m.content).join('\n') : '';
  hasNot(PE, 'undefined', 'empty brand profile leaks no "undefined" into the prompt');
  hasNot(PE, '[object Object]', 'empty brand profile leaks no "[object Object]" into the prompt');
  has(PE, 'CONTENT FORMATS', 'empty brand profile still gets the format rules');

  // ── 2 · rulePrecedence is genuinely LAST in every generator that uses it ──
  const PRECEDENCE_MARK = 'RULE PRECEDENCE';
  const PRECEDENCE_TEXT = require(join(API, '_brain.js')).rulePrecedence();
  const others = [
    ['viral-twist.js', { idea: { title: 't', hook: 'h', script: 's', format: 'video' }, brandContext: BC }, [TWIST_REPLY], 0],
    ['viral-rewrite.js', { idea: { title: 't', hook: 'h', script: 's', format: 'video' }, angle: { angle: 'Contrarian', hook: 'h' }, brandContext: BC }, [REWRITE_REPLY], 0],
    ['meme.js', { action: 'generate', brandId: 'brand-1', topic: 'labels', brandContext: BC }, ['not json — stop before the image call'], 0],
    ['sharpen.js', { kind: 'post', format: 'video', content: { hook: 'Turn it over.', script: 'Find the sodium number on the back.' }, brandContext: BC }, [SHARPEN_CRITIQUE, SHARPEN_REPLY], 1],
    ['remix.js', { postDescription: 'a viral label-reading video', creatorName: 'someone', platform: 'tiktok', remixMode: 'remix', brandContext: BC }, [REMIX_REPLY], 0],
    // generate-blog.js: RETIRED v627 (410 stub — the blog feature was removed). Do not re-add.
  ];
  for (const [file, body, replies, callIdx] of others) {
    const r = await run(file, body, replies);
    ok(r.calls.length > callIdx, file + ' reached its LLM call', 'made ' + r.calls.length + ' calls, status ' + r.res._status);
    if (r.calls.length <= callIdx) continue;
    const msgs = r.calls[callIdx].messages;
    const joined = msgs.map(m => m.content).join('\n');
    const last = String(msgs[msgs.length - 1].content);
    const occurrences = joined.split(PRECEDENCE_MARK).length - 1;
    ok(occurrences === 1, `FIX4 ${file}: rule precedence appears exactly once`, `found ${occurrences}`);
    ok(last.includes(PRECEDENCE_MARK), `FIX4 ${file}: rule precedence is in the LAST message`);
    // "Genuinely last" means the message ENDS with the precedence text — not merely that the text
    // is present somewhere. (An earlier version of this check measured from the START of the block
    // and so counted the block's own body as "text that follows it": a broken oracle.)
    const tail = last.trim();
    ok(tail.endsWith(PRECEDENCE_TEXT.trim()),
      `FIX4 ${file}: rule precedence is genuinely LAST in the prompt`,
      `prompt ends with: ...${tail.slice(-90).replace(/\n/g, ' ')}`);
    hasNot(joined, 'at the top of this prompt', `FIX4 ${file}: positional wording removed`);
    has(joined, 'ZKEY_WINNER_ONE', `${file}: approved winners reach the model`);
    has(joined, 'ZKEY_SIGNALS', `${file}: learned signals reach the model`);
    // FIX 5 — the duplicated humanizer boilerplate is gone (writingCraft already carries it)
    if (file === 'remix.js') {
      const dupes = joined.split('delve').length - 1;
      ok(dupes === 1, `FIX5 ${file}: AI-tell word blacklist appears once, not twice`, `found ${dupes} copies`);
      const emdash = joined.split('No em dashes').length - 1 + (joined.split('NEVER use em dashes').length - 1);
      ok(emdash <= 1, `FIX5 ${file}: em-dash rule appears once`, `found ${emdash} copies`);
    }
    checkRecency(file, joined);
    notes.push(`  ${file.padEnd(20)} prompt ${String(joined.length).padStart(6)} chars · brand ${(measure(joined, BC).share * 100).toFixed(1)}%`);
  }

  // generate-ideas is measured on the same scale as the rest, so the reference bar the others are
  // held to is a number this run produced, not a number copied out of a changelog.
  checkRecency('generate-ideas.js', P);

  // ── remix with a reference screenshot ──────────────────────────────────────
  // The remix fixture above sends no refImage, so it never exercised the path where `imgNote` is
  // appended — and remix used to append imgNote AFTER rulePrecedence(), meaning the precedence
  // block was NOT last for any user who attached a screenshot, or on any retry. The gate said
  // "genuinely LAST" and was right about the only path it drove. This drives the other one.
  const remixImg = await run('remix.js', {
    postDescription: 'a viral label-reading video', creatorName: 'someone', platform: 'tiktok',
    remixMode: 'remix', brandContext: BC,
    refImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
  }, [REMIX_REPLY]);
  ok(remixImg.calls.length === 1, 'remix with a screenshot reached its LLM call',
    'made ' + remixImg.calls.length + ' calls, status ' + remixImg.res._status);
  if (remixImg.calls.length === 1) {
    const msgsI = remixImg.calls[0].messages;
    const lastI = String(msgsI[msgsI.length - 1].content).trim();
    has(lastI, 'A REFERENCE SCREENSHOT is attached', 'remix screenshot path really did append imgNote');
    ok(lastI.endsWith(PRECEDENCE_TEXT.trim()),
      'FIX4 remix.js: rule precedence is STILL last when a screenshot is attached',
      `prompt ends with: ...${lastI.slice(-90).replace(/\n/g, ' ')}`);
    ok((lastI.split(PRECEDENCE_MARK).length - 1) === 1,
      'FIX4 remix.js: screenshot path does not duplicate the precedence block');
    checkRecency('remix.js+screenshot', lastI);
  }

  // ── 3 · measured before/after ────────────────────────────────────────────────
  const after = measure(P, BC);
  let before = null;
  if (existsSync(BEFORE_FIXTURE)) before = measure(readFileSync(BEFORE_FIXTURE, 'utf8'), BC);
  else failures.push('missing "before" fixture — run with --snapshot on the pre-fix code first');

  console.log('\n── generate-ideas prompt (powers Ideas, Quick Post, Idea Catcher, Notebook, PAA, refill) ──');
  if (before) {
    console.log(`BEFORE  ${String(before.total).padStart(6)} chars total · ${String(before.brandChars).padStart(5)} brand chars · brand share ${(before.share * 100).toFixed(1)}%`);
    console.log(`        brand data NOT reaching the model: ${before.missing.join(', ') || '(none)'}`);
  }
  console.log(`AFTER   ${String(after.total).padStart(6)} chars total · ${String(after.brandChars).padStart(5)} brand chars · brand share ${(after.share * 100).toFixed(1)}%`);
  console.log(`        brand data NOT reaching the model: ${after.missing.join(', ') || '(none)'}`);
  if (before) {
    console.log(`DELTA   brand chars ${before.brandChars} → ${after.brandChars} (${after.brandChars - before.brandChars >= 0 ? '+' : ''}${after.brandChars - before.brandChars}), share ${(before.share * 100).toFixed(1)}% → ${(after.share * 100).toFixed(1)}% (${((after.share - before.share) * 100) >= 0 ? '+' : ''}${((after.share - before.share) * 100).toFixed(1)}pt)`);
    ok(after.brandChars > before.brandChars, 'MEASURED: more of the brand reaches the model than before',
      `${before.brandChars} → ${after.brandChars}`);
    ok(after.share > before.share, 'MEASURED: brand share of the prompt increased',
      `${(before.share * 100).toFixed(1)}% → ${(after.share * 100).toFixed(1)}%`);
    ok(after.missing.length === 0, 'MEASURED: every brand field reaches the model', 'missing: ' + after.missing.join(', '));
    ok(before.missing.length > 0, 'the "before" fixture really was dropping fields (proves the check can fail)',
      'before dropped nothing — fixture may be stale');
  }
  console.log('\n── other generators ──');
  for (const n of notes) console.log(n);

  console.log('\n── brand recency (where the approved winners land, and how much follows them) ──');
  for (const r of recency) console.log(r);

  console.log('');
  if (!failures.some(f => f.startsWith('RECENCY '))) {
    console.log(`RECENCY OK — every generator lands its winners past ${(WINNERS_MIN_PCT * 100).toFixed(0)}% with under ${TAIL_CAP} chars after them`);
  }
  if (failures.length) {
    console.error(`FAILED — ${failures.length} check(s):`);
    for (const f of failures) console.error('  ✗ ' + f);
    process.exit(1);
  }
  console.log('brand prompt verification passed');
};

main().catch(e => { console.error('verify crashed:', e); process.exit(1); });
