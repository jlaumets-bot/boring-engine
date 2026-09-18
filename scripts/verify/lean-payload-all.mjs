#!/usr/bin/env node
// GATE: the Ideas tab and Remix must stop re-uploading the brand brain — WITHOUT losing a
// single thing the model used to see.
//
// WHY THIS EXISTS — the same measured failure that produced lean-payload.mjs, one endpoint over:
//   /api/generate-ideas returned 200 four times while the owner's phone showed "Timed out".
//   The server wrote the post; the ~18KB request body (mostly getBrandContext()) took longer to
//   upload than the client would wait on a link measured at 0.06-0.13 KB/s. Quick Post was fixed
//   in v620. `generateNewIdeas` hits the SAME endpoint with the SAME payload, and `remixContent`
//   (plus its 6-parallel "Try all modes" lane) does the same thing to /api/remix.
//
// The dangerous half of the fix is invisible. The brand row does NOT contain the trends the user
// typed by hand ('brand_trends' in localStorage), nor the auto-trend dismissals getAutoTrends()
// subtracts, nor — for Ideas — the visibility rule that decides which library titles belong in the
// anti-repetition list (`sparkSource` has no column; format_mix hiding is a v600 decision). Read
// the brain server-side naively and those stop reaching the model: nothing breaks, the writing
// just quietly stops reflecting what the user taught it.
//
// So this gate does not grep for a shape. It lifts the REAL call expressions out of app.html, runs
// them through the REAL leanBrandFetch helper to produce the REAL request bodies, feeds those
// bodies to the REAL api/generate-ideas.js and api/remix.js handlers with only the LLM and the
// database stubbed, and compares the two assembled prompts field by field.
//
// RUN:    node scripts/verify/lean-payload-all.mjs
// EXPECT: prints "PASS: lean-payload-all" and exits 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
const require_ = createRequire(path.join(root, 'api', 'x.js'));

const fails = [];
const notes = [];
const check = (n, c, d) => { if (!c) fails.push(n + (d ? ' — ' + d : '')); };
const die = m => { console.error('FAIL: lean-payload-all — ' + m); process.exit(2); };

// ── lift real source out of app.html ─────────────────────────────────────────
function braceFrom(s, from) {
  let d = 0;
  for (let k = s.indexOf('{', from); k < s.length; k++) {
    if (s[k] === '{') d++;
    else if (s[k] === '}') { d--; if (!d) return k + 1; }
  }
  return -1;
}
function grabFn(name) {
  const i = app.search(new RegExp('(?:async )?function ' + name + '\\('));
  if (i < 0) die(`function ${name} not found in app.html (renamed? this gate is now blind)`);
  const end = braceFrom(app, i);
  if (end < 0) die(`could not brace-match ${name}`);
  return app.slice(i, end);
}
function grabLine(name) {
  const m = app.match(new RegExp('^const ' + name + ' = .*$', 'm'));
  if (!m) die(`const ${name} line not found in app.html`);
  return m[0];
}
// Paren-match a call expression, skipping over quoted strings so a '(' inside a string
// literal cannot desynchronise the depth counter.
function callExpr(from) {
  const open = app.indexOf('(', from);
  if (open < 0) return null;
  let d = 0, q = null;
  for (let k = open; k < app.length; k++) {
    const c = app[k];
    if (q) {
      if (c === '\\') { k++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { q = c; continue; }
    if (c === '(') d++;
    else if (c === ')') { d--; if (!d) return app.slice(from, k + 1); }
  }
  return null;
}
function leanCallSites(url) {
  const needle = `leanBrandFetch('${url}'`;
  const out = [];
  let i = -1;
  while ((i = app.indexOf(needle, i + 1)) !== -1) {
    const e = callExpr(i);
    if (!e) die(`could not paren-match the leanBrandFetch call for ${url} at offset ${i}`);
    out.push(e);
  }
  return out;
}

const CLIENT_SRC = [
  grabLine('DAYS'), grabLine('DAY_COMMUNITIES_DEFAULT'), grabLine('DELIVERY_FORMATS'),
  grabLine('VL_TREND_TTL_MS'), grabLine('VL_TREND_CAP'), grabLine('CS_AVOID_MARK'),
  grabFn('defaultSettings'), grabFn('brandToSettings'), grabFn('getDayCommunities'),
  grabLine('CM_MAX_AGE_MS'), grabFn('getCompetitorMoves'),
  grabFn('getEngine'), grabFn('getLearnedSignalsCompact'),
  grabFn('humanEditSignals'),   /* v673: the shared edit-signal filter getApprovedExamples now calls */
  grabFn('getApprovedExamples'),
  grabFn('getTrendStore'), grabFn('_atDismissed'), grabFn('getAutoTrends'), grabFn('getRecentTrends'),
  grabFn('getBrandContext'), grabFn('_tvBcFieldCount'),
].join('\n');

// The REAL shared helper under test, plus the network classifier it calls from its catch.
const HELPER_SRC = [grabFn('_leanNetFail'), grabFn('leanBrandFetch')].join('\n');

// ── fixture: one realistic brand, as a database row ──────────────────────────
// Every text field carries a unique SENTINEL so a prompt comparison can name exactly which field
// went missing rather than reporting "prompts differ". Sizes match a real brand: understate them
// and the saving proved here is not the saving the owner gets.
const S = k => 'SENTINEL_' + k;
const pad = (k, n) => S(k) + ' ' + 'the brand actually says this out loud. '.repeat(Math.ceil(n / 40)).slice(0, n);

const BRAND_ROW = {
  id: 'brand-1',
  brand_name: S('brandName') + ' Boring Electrolytes',
  website: 'https://' + S('website').toLowerCase() + '.com',
  tagline: pad('tagline', 60),
  usps: pad('usps', 900),
  tones: ['deadpan ' + S('tones'), 'blunt', 'dry'],
  communities: ['hydration ' + S('communities0'), 'endurance', 'keto', 'shift work', 'sauna'],
  target_audience: pad('targetAudience', 300),
  competitors_text: pad('competitors', 150),
  banned_topics: S('bannedTopics') + ', politics',
  // PARTIAL on purpose: getDayCommunities() merges the stored rotation over the all-"General"
  // defaults, so a rotation covering all 8 days would make the merge a no-op and a server that
  // returned the raw column would look identical. It must not.
  day_rotation: { Monday: 'hydration', Tuesday: 'endurance', Wednesday: 'keto' },
  format_mix: { video: 3, carousel: 2, statement: 2, micro: 1, static: 1, bonus: 1, qna: 99 },
  voice_extra: {
    painPoints: pad('painPoints', 700),
    brandVocab: pad('brandVocab', 300),
    avoidWords: S('avoidWords') + ', gamechanger, supercharge',
    productDetails: pad('productDetails', 1200),
    exampleContent: pad('exampleContent', 900),
    ctaStyle: pad('ctaStyle', 150),
    originStory: pad('originStory', 700),
    socialProof: pad('socialProof', 400),
    webMentions: pad('webMentions', 600),
    categoryGripes: pad('categoryGripes', 600),
    reviewInsights: pad('reviewInsights', 900),
    voiceSample: pad('voiceSample', 1200),
    voiceLog: [{ ts: 1, src: 'notebook', text: pad('voiceLog0', 300) }, { ts: 2, src: 'coach', text: pad('voiceLog1', 300) }],
    channels: pad('channels', 120),
    visualStyle: pad('visualStyle', 200),
    coachNotes: pad('coachNotes', 1200),
    socialUrl: 'https://x.com/boring',
  },
  auto_trends: {
    at: Date.now(),
    competitorMoves: pad('competitorMoves', 800),
    // v665: a digest with no `compAt` is of unknown age and BOTH sides now drop it — the fixture
    // has to say when this one was gathered or it tests the expiry instead of the payload.
    compAt: Date.now(),
    items: [
      { text: 'AUTOTREND_kept sodium loading goes mainstream', ts: Date.now() },
      { text: 'AUTOTREND_dismissed battery electrolyte breakthrough', ts: Date.now() },
    ],
  },
};

// ideas, oldest-first — the order the client's `state` array holds them in. Sized like a real
// library (the owner's is ~95).
const LIB = 60;
const IDEAS = [];
for (let i = 0; i < LIB; i++) {
  const approved = i % 3 !== 2;
  IDEAS.push({
    // AVOIDONLY sits mid-library: inside the 60-title window Ideas sends, but NOT among the last
    // 15 approved/dismissed samples and NOT among the 4 approved winners — so the ONLY way it can
    // reach the prompt is the library title list. That is what makes the check able to fail.
    title: 'Library idea ' + i + ' — a realistic content title of ordinary length'
      + (i === 25 ? ' AVOIDONLY_marker' : ''),
    format: i % 4 === 3 ? 'statement' : 'video',
    hook: 'Hook line ' + i,
    script: 'Script body ' + i + ' ' + 'a real spoken sentence that runs on. '.repeat(16),
    bold_text: '', caption: '',
    status: approved ? (i % 2 ? 'done' : 'filming') : 'dismissed',
  });
}

const HAND_TREND = 'HANDTAUGHT_the 3am shift-worker hydration angle';

// v665 — a post the user REWROTE, and one the model SHARPENED, in both stores. See the same
// fixture note in lean-payload.mjs: with no edit signals anywhere, both sides fell back to plain
// recency and agreed for the wrong reason, leaving the strongest thing the brand brain does
// completely untested. Idea 4 is approved but far outside the recency window, so it can only
// reach the exemplars through provenance ranking. Idea 7's `after` is the MODEL's rewrite and
// must count on neither side.
const EDITED_IDX = 4, SHARPENED_IDX = 7;
const EDIT_SIGNALS = [
  { ts: 1, title: IDEAS[EDITED_IDX].title, format: IDEAS[EDITED_IDX].format, field: 'Script',
    before: 'the draft we wrote', after: 'Script body ' + EDITED_IDX + ' a real spoken sentence that runs on.' },
  { ts: 2, by: 'ai', title: IDEAS[SHARPENED_IDX].title, format: IDEAS[SHARPENED_IDX].format, field: 'sharpen:script',
    before: 'the draft we wrote', after: 'Script body ' + SHARPENED_IDX + ' a real spoken sentence that runs on.' },
];

const LS = {
  brand_trends: JSON.stringify([{ text: HAND_TREND, ts: Date.now() }]),
  auto_trends_dismissed: JSON.stringify(['autotrend_dismissed battery electrolyte breakthrough']),
  tv_recent: JSON.stringify(['Recent quick post ' + S('tvRecent')]),
  edit_signals: JSON.stringify(EDIT_SIGNALS),
};

// ── drive the real client code ───────────────────────────────────────────────
function clientApi(settings) {
  const state = IDEAS.map((r, i) => ({
    id: i, title: r.title, format: r.format, hook: r.hook, script: r.script,
    boldText: r.bold_text, caption: r.caption, status: r.status, day: 'Monday',
  }));
  const lsGet = k => (k in LS ? LS[k] : null);
  const currentBrand = { id: BRAND_ROW.id, auto_trends: BRAND_ROW.auto_trends };
  const fn = new Function('lsGet', 'lsSet', 'currentBrand', 'state', 'settings',
    CLIENT_SRC + '\n; return { brandToSettings, getBrandContext, getRecentTrends, getApprovedExamples, _tvBcFieldCount, getDayCommunities, DAYS };');
  return fn(lsGet, () => {}, currentBrand, state, settings);
}
let api0;
try { api0 = clientApi({}); } catch (e) { die('client bundle would not construct: ' + e.message); }
const settings = api0.brandToSettings(BRAND_ROW);
const C = clientApi(settings);
const dc = C.getDayCommunities();
const communities = C.DAYS.map(d => `${d}: ${dc[d]}`).join(', ');
const dayMap = C.DAYS.map(d => `${d} = ${dc[d]}`).join(', ');

// ── the REAL leanBrandFetch, wired to stubs ──────────────────────────────────
let capturedBodies = [];
let nextStatus = [];                       // queue of statuses the stub fetch should return
function makeFetch() {
  return async (url, init) => {
    capturedBodies.push({ url, body: init.body });
    const st = nextStatus.length ? nextStatus.shift() : 200;
    return {
      status: st, ok: st < 300,
      clone() { return this; },
      async json() { return st === 424 ? { error: 'brand_context_unavailable', reason: 'stale_brand_row' } : {}; },
    };
  };
}
let helperFactory;
try {
  // v640: _humanEditedTitles supplies the titles the user actually REWROTE — localStorage-only
  // knowledge the server cannot derive, sent so the hydrated winners can be ranked by human
  // provenance instead of by mere 'approved' status. Provided here so this gate exercises the
  // REAL call rather than the typeof fallback.
  helperFactory = new Function('currentBrand', 'window', 'flushBrandSave', 'fetch',
    'getRecentTrends', '_tvBcFieldCount', '_humanEditedTitles', HELPER_SRC + '\n; return leanBrandFetch;');
} catch (e) { die('the real leanBrandFetch would not construct: ' + e.message); }

let flushed = 0;
function helper(lean) {
  return helperFactory(
    { id: BRAND_ROW.id },
    { _brandSaveOk: lean ? true : false },   // false = the brand save failed => full-upload fallback
    async () => { flushed++; },
    makeFetch(),
    C.getRecentTrends,
    C._tvBcFieldCount,
    () => ['A post the user rewrote']   // v640 provenance titles
  );
}

// ── lift the REAL call expressions and capture their arguments ───────────────
// Evaluating the actual source text is the point: a fixture I wrote myself could pass while the
// real call site sends something else entirely.
const IDEAS_LC =
  '\nIDEAS THE USER LIKED (approved — generate MORE like these):\n' +
  IDEAS.filter(i => i.status !== 'dismissed').slice(-15).map(i => `"${i.title}" (${i.format}, Monday)`).join(', ') +
  '\nIDEAS THE USER REJECTED (dismissed — AVOID similar angles):\n' +
  IDEAS.filter(i => i.status === 'dismissed').slice(-15).map(i => `"${i.title}" (${i.format}, Monday)`).join(', ') +
  '\nTITLES ALREADY IN THE LIBRARY — do NOT repeat or lightly reword any of these; produce different angles/hooks:\n' +
  IDEAS.map(i => i.title).slice(-60).map(t => `"${t}"`).join(', ');

const GAPS = [];
for (const d of C.DAYS) for (const f of ['video', 'qna', 'statement']) GAPS.push({ day: d, format: f, count: 0 });

// A realistic pasted transcript — the half of a remix request the server can never look up.
const REMIX_DESC = 'REMIXSRC_marker ' + 'so the thing nobody tells you about sodium is this. '.repeat(24);

const ARG_NAMES = ['count', 'gaps', 'learningContext', 'window', 'getBrandContext', 'communities',
  'dayMap', 'getRecentTrends', '_genCtrl', 'postUrl', 'postDescription', 'creatorName', 'platform',
  'currentRemixMode', 'mode', 'remixRefImage', 'leanBrandFetch'];
function captureArgs(expr, label) {
  const seen = [];
  let f;
  try { f = new Function(...ARG_NAMES, 'return ' + expr + ';'); }
  catch (e) { die(`${label}: the lifted call expression will not compile: ${e.message}`); }
  try {
    f(5, GAPS.slice(0, 21), IDEAS_LC, { _ideaDelivery: 'faceon', _remixDelivery: 'faceon' },
      C.getBrandContext, communities, dayMap, C.getRecentTrends, { signal: 'SIG' },
      'https://tiktok.com/@x/video/1', REMIX_DESC, 'darren', 'tiktok', 'flip', 'roast', undefined,
      (...a) => { seen.push(a); return { status: 200 }; });
  } catch (e) {
    die(`${label}: the real call expression would not run (a new identifier the gate does not supply?): ${e.message}`);
  }
  if (seen.length !== 1) die(`${label}: expected exactly one leanBrandFetch call, saw ${seen.length}`);
  return seen[0];
}

// IDENTIFY the Ideas-tab call site, do not COUNT the call sites. This used to assert
// `=== 1`, which made the gate fail the moment more callers were moved onto the lean path —
// i.e. an assertion that had to be re-tuned every time the code it guards improved, which is
// the definition of a bad assertion. /api/generate-ideas now serves eight lean callers (the
// Ideas tab, auto-refill, PAA-to-post, Notebook develop, Idea Catcher x2, idea redo, scenes);
// the Ideas tab is the only one that carries the face-on/faceless choice, so pick it by that.
// Section (h) below still ratchets EVERY lean endpoint, so the extra callers are not unguarded.
const allIdeaSites = leanCallSites('/api/generate-ideas');
const ideaSites = allIdeaSites.filter(e => /window\._ideaDelivery/.test(e));
const remixSites = leanCallSites('/api/remix');
check('the Ideas tab no longer goes through leanBrandFetch — the lean path, the brand-save gate, the 424 fallback and the network retry are all gone with it',
  ideaSites.length === 1, ideaSites.length + ' Ideas-tab call sites found among ' + allIdeaSites.length + ' lean /api/generate-ideas callers');
check('Remix does not have both of its lanes on the lean path (remixContent + the 6-parallel Try-all-modes lane)',
  remixSites.length === 2, remixSites.length + ' call sites found');
if (ideaSites.length !== 1 || remixSites.length !== 2) {
  console.error('FAIL: lean-payload-all —');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}

async function bodiesFor(expr, label) {
  const args = captureArgs(expr, label);
  const out = {};
  for (const lean of [true, false]) {
    capturedBodies = [];
    const before = flushed;
    await helper(lean)(...args);
    if (capturedBodies.length !== 1) die(`${label}: expected one request, saw ${capturedBodies.length}`);
    out[lean ? 'lean' : 'full'] = capturedBodies[0].body;
    if (lean) out.flushedBeforeSend = flushed > before;
    out.url = capturedBodies[0].url;
  }
  return out;
}

const ideasB = await bodiesFor(ideaSites[0], 'ideas');
const remixB = await bodiesFor(remixSites[0], 'remix');
const tryAllB = await bodiesFor(remixSites[1], 'try-all-modes');

check('a pending Settings edit is not flushed to the database before the server reads the brand row (Ideas)', ideasB.flushedBeforeSend);
check('a pending Settings edit is not flushed to the database before the server reads the brand row (Remix)', remixB.flushedBeforeSend);

const B = s => Buffer.byteLength(s);
const M = {
  ideas: { full: B(ideasB.full), lean: B(ideasB.lean) },
  remix: { full: B(remixB.full), lean: B(remixB.lean) },
  tryall: { full: B(tryAllB.full) * 6, lean: B(tryAllB.lean) * 6 },
};

// ── (a) the measured saving ──────────────────────────────────────────────────
check('the OLD Ideas payload is not big enough for this gate to mean anything', M.ideas.full > 15000,
  M.ideas.full + ' bytes — the fixture no longer resembles a real brand, so the saving proved here is not the real saving');
check('the OLD Remix payload is not big enough for this gate to mean anything', M.remix.full > 12000,
  M.remix.full + ' bytes');
// Ideas keeps its whole learningContext (~4KB of it is the visible-title avoid-list that no
// database query can reproduce), so it cannot reach Quick Post's 2.9KB. It must still lose the
// brand snapshot.
check('the lean Ideas request is not dramatically smaller', M.ideas.lean < M.ideas.full * 0.45,
  M.ideas.lean + ' vs ' + M.ideas.full + ' bytes = ' + Math.round(M.ideas.lean / M.ideas.full * 100) + '% of the old body');
check('the lean Remix request is not dramatically smaller', M.remix.lean < M.remix.full * 0.30,
  M.remix.lean + ' vs ' + M.remix.full + ' bytes = ' + Math.round(M.remix.lean / M.remix.full * 100) + '% of the old body');

// A percentage is not enough on its own: it moves with the fixture. Pin each lean body to the ONE
// thing it is obliged to carry and allow only request-shaping overhead on top, so re-adding any
// brand field is immediately over budget (painPoints alone is ~700 bytes; the snapshot is ~17KB).
// These scale with the library/transcript, so they cannot be quietly satisfied by a smaller fixture.
const lcBytes = B(JSON.stringify(IDEAS_LC));                 // the visible-title avoid-list etc.
const descBytes = B(JSON.stringify(REMIX_DESC));             // the user's pasted source material
check('the lean Ideas request carries more than its learningContext + request shaping — something brand-shaped is riding along again',
  M.ideas.lean - lcBytes < 2500,
  `${M.ideas.lean} bytes total, ${lcBytes} of it the learningContext it must carry => ${M.ideas.lean - lcBytes} bytes of other payload`);
check('the lean Remix request carries more than its source material + request shaping — something brand-shaped is riding along again',
  M.remix.lean - descBytes < 1200,
  `${M.remix.lean} bytes total, ${descBytes} of it the pasted source => ${M.remix.lean - descBytes} bytes of other payload`);

// ── (b) shape: what travels, and what an OLD client still sends ──────────────
const iLean = JSON.parse(ideasB.lean), iFull = JSON.parse(ideasB.full);
const rLean = JSON.parse(remixB.lean), rFull = JSON.parse(remixB.full);

// The saving must BE the brand snapshot, not an accident of some other field shrinking.
for (const [label, full, lean, m] of [['ideas', iFull, iLean, M.ideas], ['remix', rFull, rLean, M.remix]]) {
  const bcDelta = B(JSON.stringify(full.brandContext)) - B(JSON.stringify(lean.brandContext));
  check(`${label}: the byte saving is not the brand snapshot — something else changed size`,
    Math.abs((m.full - m.lean) - bcDelta) < 200,
    `body saved ${m.full - m.lean} bytes, brandContext shrank ${bcDelta}`);
}

check('the lean Ideas request does not name the brand, so the server cannot load it', iLean.brandId === BRAND_ROW.id);
check('the lean Remix request does not name the brand, so the server cannot load it', rLean.brandId === BRAND_ROW.id);
check('the lean Ideas request still uploads brand fields',
  JSON.stringify(Object.keys(iLean.brandContext).sort()) === JSON.stringify(['communities', 'dayMap', 'recentTrends']),
  'brandContext keys: ' + Object.keys(iLean.brandContext).join(','));
check('the lean Remix request still uploads brand fields',
  JSON.stringify(Object.keys(rLean.brandContext).sort()) === JSON.stringify(['recentTrends']),
  'brandContext keys: ' + Object.keys(rLean.brandContext).join(','));
check('the OLD-shape Ideas request carries brandId, so an old cached client would take the new path and its uploaded brain would be ignored',
  !('brandId' in iFull));
check('the OLD-shape Remix request carries brandId', !('brandId' in rFull));
check('the OLD-shape Ideas request lost the full brand snapshot — the _brandSaveOk fallback is broken',
  !!iFull.brandContext && !!iFull.brandContext.painPoints && Array.isArray(iFull.brandContext.approvedExamples));
check('the OLD-shape Remix request lost the full brand snapshot', !!rFull.brandContext && !!rFull.brandContext.painPoints);

// Ideas' request-shaping payload must survive the move onto the shared helper.
check('the lean Ideas request dropped `count`', iLean.count === 5);
check('the lean Ideas request dropped the priority `gaps`', Array.isArray(iLean.gaps) && iLean.gaps.length === 21);
check('the lean Ideas request dropped the face-on/faceless delivery choice', iLean.delivery === 'faceon');
check('the lean Ideas request dropped learningContext', typeof iLean.learningContext === 'string' && iLean.learningContext.length > 1000);
check('Ideas emits Quick Post\'s avoid-list marker — the server would compose a list from ALL library rows, resurrecting the hidden ideas v600 deliberately excluded',
  iLean.learningContext.indexOf('<<CS_AVOID_LIST>>') === -1);
check('the visible-title avoid-list is no longer travelling with the Ideas request — anti-repetition silently weakens and the "all generated ideas already exist" dead-end comes back',
  iLean.learningContext.indexOf('AVOIDONLY_marker') !== -1);
// Remix's own inputs.
check('the lean Remix request dropped the source material the server cannot look up',
  rLean.postDescription === REMIX_DESC && rLean.postUrl === 'https://tiktok.com/@x/video/1');
check('the lean Remix request dropped the remix mode', rLean.remixMode === 'flip');
check('the lean Remix request dropped creator/platform', rLean.creatorName === 'darren' && rLean.platform === 'tiktok');
const tLean = JSON.parse(tryAllB.lean);
check('the Try-all-modes lane lost its per-card mode', tLean.remixMode === 'roast');
check('the Try-all-modes lane is not lean', !!tLean.brandId && !tLean.brandContext.painPoints);

// ── (c) hand-taught trends and dismissals must be in what the client still sends ──
for (const [label, body] of [['Ideas', iLean], ['Remix', rLean]]) {
  const tr = (body.brandContext && body.brandContext.recentTrends) || [];
  check(`${label}: hand-taught trends are no longer uploaded — they exist ONLY in localStorage, so this is the one thing the server can never recover`,
    tr.indexOf(HAND_TREND) !== -1);
  check(`${label}: a dismissed auto-trend came back`, !tr.some(t => /AUTOTREND_dismissed/.test(t)));
  check(`${label}: the kept auto-trend went missing`, tr.some(t => /AUTOTREND_kept/.test(t)));
}

// ── stub the backend's world, then run the REAL handlers both ways ───────────
process.env.SUPABASE_URL = 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-key';
const prompts = [];
function stub(rel, exports) {
  const p = require_.resolve(rel);
  require_.cache[p] = { id: p, filename: p, loaded: true, exports, children: [], paths: [] };
}
let DB_DOWN = false;
function dbRows(pathStr) {
  if (DB_DOWN) return { status: 500, data: null };
  if (pathStr.startsWith('/brands')) return { status: 200, data: [BRAND_ROW] };
  const q = pathStr.slice(pathStr.indexOf('?') + 1);
  const p = new URLSearchParams(q);
  // v665: edit_signals is its own table. It used to fall through to the IDEAS branch below, which
  // answered a title query with library titles — so the server "discovered" rewritten posts that
  // never existed.
  if (pathStr.startsWith('/edit_signals')) {
    let sig = EDIT_SIGNALS.map(x => ({ title: x.title, authored_by: x.by === 'ai' ? 'ai' : null }));
    if (p.get('authored_by') === 'is.null') sig = sig.filter(r => r.authored_by === null);
    if (p.get('title') === 'not.is.null') sig = sig.filter(r => r.title);
    if (p.get('order') === 'created_at.desc') sig = sig.slice().reverse();
    const sl = Number(p.get('limit') || 0);
    return { status: 200, data: sl ? sig.slice(0, sl) : sig };
  }
  let rows = IDEAS.slice();
  const st = p.get('status');
  if (st === 'in.(filming,done)') rows = rows.filter(r => r.status === 'filming' || r.status === 'done');
  else if (st === 'eq.dismissed') rows = rows.filter(r => r.status === 'dismissed');
  const f = p.get('format');
  if (f && f.startsWith('eq.')) rows = rows.filter(r => r.format === f.slice(3));
  if (f && f.startsWith('neq.')) rows = rows.filter(r => r.format !== f.slice(4));
  // v665: the by-name lookup the provenance path depends on.
  const tq = p.get('title');
  if (tq && tq.startsWith('in.(')) {
    const want = new Set((tq.slice(4, -1).match(/"(?:[^"\\]|\\.)*"/g) || [])
      .map(v => v.slice(1, -1).replace(/\\(.)/g, '$1')));
    rows = rows.filter(r => want.has(r.title));
  }
  if (p.get('order') === 'created_at.desc') rows = rows.slice().reverse();
  const lim = Number(p.get('limit') || 0);
  if (lim) rows = rows.slice(0, lim);
  return { status: 200, data: rows };
}
stub('./_publish/store', { rest: async (m, pth) => dbRows(pth), userCanAccessBrand: async () => true, getUser: async () => ({ id: 'user-1' }) });
stub('./_requireUser', async () => ({ id: 'user-1' }));
stub('./_usage', {
  checkLimit: async () => ({ ok: true }), creditsFor: () => 1, logUsage: async () => {},
  guard: async () => ({ user: { id: 'user-1' }, over: false, gate: {} }),
});
const IDEA_JSON = JSON.stringify([{ day: 'Monday', community: 'hydration', format: 'video', tone: 'dry', title: 'A', hook: 'B', script: 'C', shots: 'D', caption: '', reelTitle: 'E', tags: '#x' }]);
const REMIX_JSON = JSON.stringify({ originalSummary: 'x', remixTitle: 'T', remixHook: 'H', remixScript: 'S', remixFormat: 'video', remixCaption: 'C', remixHashtags: '#a', whyItWorks: 'w' });
let LLM_RETURNS = IDEA_JSON;
stub('./_llm', {
  callLLM: async ({ messages }) => {
    prompts.push(messages.map(m => m.content).join('\n'));
    return LLM_RETURNS;
  },
});
let ideasHandler, remixHandler;
try { ideasHandler = require_('./generate-ideas.js'); } catch (e) { die('generate-ideas would not load: ' + e.message); }
try { remixHandler = require_('./remix.js'); } catch (e) { die('remix would not load: ' + e.message); }

async function run(handler, body, ret) {
  LLM_RETURNS = ret;
  const res = { _s: 200, _j: null, setHeader() {}, status(s) { this._s = s; return this; }, json(j) { this._j = j; return this; }, end() { return this; } };
  const before = prompts.length;
  await handler({ method: 'POST', headers: { origin: 'https://contentshrimp.com', authorization: 'Bearer t' }, body }, res);
  return { res, prompt: prompts.slice(before).join('\n') };
}

const R = {
  ideasFull: await run(ideasHandler, iFull, IDEA_JSON),
  ideasLean: await run(ideasHandler, iLean, IDEA_JSON),
  remixFull: await run(remixHandler, rFull, REMIX_JSON),
  remixLean: await run(remixHandler, rLean, REMIX_JSON),
};
check('the OLD full-context Ideas request stopped working — every device still on the cached app.html breaks',
  R.ideasFull.res._s === 200, 'status ' + R.ideasFull.res._s + ' ' + JSON.stringify(R.ideasFull.res._j || {}).slice(0, 160));
check('the LEAN Ideas request did not succeed', R.ideasLean.res._s === 200,
  'status ' + R.ideasLean.res._s + ' ' + JSON.stringify(R.ideasLean.res._j || {}).slice(0, 160));
check('the OLD full-context Remix request stopped working', R.remixFull.res._s === 200,
  'status ' + R.remixFull.res._s + ' ' + JSON.stringify(R.remixFull.res._j || {}).slice(0, 160));
check('the LEAN Remix request did not succeed', R.remixLean.res._s === 200,
  'status ' + R.remixLean.res._s + ' ' + JSON.stringify(R.remixLean.res._j || {}).slice(0, 160));

// ── (d) every brand field the client used to send must reach the prompt ──────
function comparePrompts(label, full, lean, extra) {
  if (!full || !lean) { check(label + ': no prompt was assembled at all', false); return; }
  const sentinels = [...new Set((full.match(/SENTINEL_[A-Za-z0-9]+/g) || []))];
  check(`${label}: the old path put almost nothing in the prompt — the fixture is not exercising the renderer`,
    sentinels.length >= 18, sentinels.length + ' sentinels found');
  const missing = sentinels.filter(s => lean.indexOf(s) === -1);
  check(`${label}: brand facts VANISHED from the server-assembled prompt`, missing.length === 0,
    'missing: ' + missing.join(', ') + ' — every one is a permanent, invisible quality regression');
  check(`${label}: the hand-taught trend never reached the model`, lean.indexOf(HAND_TREND) !== -1);
  check(`${label}: a dismissed auto-trend was resurrected into the model prompt`, lean.indexOf('AUTOTREND_dismissed') === -1);
  // v640: assert the winners' CONTENT reaches the prompt, not the heading's exact wording. The
  // old check grepped /APPROVED WINNERS/ and so went red purely because the label was reworded —
  // an assertion coupled to copy punishes improving the copy. The heading now varies by
  // provenance ("THE BRAND'S OWN WORDS" when the user rewrote a post, "POSTS THIS BRAND APPROVED"
  // when they only tapped approve), and either way what must survive is the example text itself.
  check(`${label}: the brand's approved winners are missing — the strongest voice signal in the product`,
    /OWN WORDS|APPROVED/.test(lean) && /Script body \d/.test(lean),
    'the winners heading and/or a winner body did not reach the assembled prompt');
  if (extra) extra(full, lean);
}
comparePrompts('ideas', R.ideasFull.prompt, R.ideasLean.prompt, (full, lean) => {
  check('ideas: the library half of the avoid-list never reached the model — anti-repetition silently weakens',
    lean.indexOf('AVOIDONLY_marker') !== -1);
  check('ideas: the library avoid-list is not exercised on the OLD path either, so the check above proves nothing',
    full.indexOf('AVOIDONLY_marker') !== -1);
  check('ideas: the priority gap instruction was lost', /PRIORITY GAPS TO FILL/.test(lean));
  check('ideas: the avoid-list marker leaked into the model prompt',
    lean.indexOf('<<CS_AVOID_LIST>>') === -1 && full.indexOf('<<CS_AVOID_LIST>>') === -1);
});
comparePrompts('remix', R.remixFull.prompt, R.remixLean.prompt, (full, lean) => {
  check('remix: the user\'s own source material never reached the model', lean.indexOf('REMIXSRC_marker') !== -1);
  check('remix: the remix MODE task was lost', /REMIX MODE: FLIP/.test(lean));
});

// ── (e) object-level: hydrated context vs the object the client used to send ─
const bctx = require_('./_brandctx.js');
const hyd = await bctx.loadBrandContext(BRAND_ROW.id, { userId: 'user-1' }, '');
check('server-side hydration failed outright', hyd.ok, hyd.reason);
if (hyd.ok) {
  // Both new call sites use getBrandContext() with NO format, so the winners must be the generic
  // most-recent four. A format-matched server set here would be a silent swap of the exemplars.
  const clientBc = C.getBrandContext();
  const serverBc = Object.assign({}, hyd.bc, { recentTrends: C.getRecentTrends() });
  const BRAIN = require_('./_brain.js');
  const diffs = [];
  for (const k of Object.keys(clientBc)) {
    // v665 — compare approvedExamples BY WHAT REACHES THE MODEL, not by array order. The two sides
    // order this list differently on purpose (the server returns rewritten posts first), and
    // approvedWinnersBlock re-groups into edited-then-plain before rendering, so array order cannot
    // change one word of the prompt. Comparing the rendered block is the stricter check: it still
    // fails if either side picks a different post or loses a provenance flag.
    if (k === 'approvedExamples') {
      const rc = BRAIN.approvedWinnersBlock({ approvedExamples: clientBc[k] });
      const rs = BRAIN.approvedWinnersBlock({ approvedExamples: serverBc[k] });
      if (rc !== rs) diffs.push('approvedExamples renders differently (client ' +
        JSON.stringify(rc.slice(0, 90)) + ' | server ' + JSON.stringify(rs.slice(0, 90)) + ')');
      if (!/THE BRAND'S OWN WORDS/.test(rc)) diffs.push('approvedExamples: neither side found the ' +
        'rewritten post, so the provenance path is untested and the agreement above is an accident');
      continue;
    }
    const a = JSON.stringify(clientBc[k]), b = JSON.stringify(serverBc[k]);
    if (a !== b) diffs.push(k + ' (client ' + String(a).slice(0, 70) + ' | server ' + String(b).slice(0, 70) + ')');
  }
  check('the server-assembled context does not match the one the client used to upload, field for field',
    diffs.length === 0, diffs.join(' ;; '));
  check('fewer than 29 brand-context fields were compared — the enumeration has drifted',
    Object.keys(clientBc).length >= 29, Object.keys(clientBc).length + ' keys');

  // The 424 guard compares the client's own field count against the server's. If those two ways of
  // counting drift, a perfectly healthy brand gets told its row is "stale" and EVERY generation
  // pays a wasted round trip plus a full re-upload — the slow-link failure this change exists to
  // remove, reintroduced by its own safety net. Assert real headroom, not just "it happens to pass".
  const clientFields = C._tvBcFieldCount(clientBc);
  check('a healthy brand is rejected as stale — every generation would pay an extra round trip and re-upload the whole brain',
    hyd.fields >= Math.ceil(clientFields / 2),
    `server counted ${hyd.fields} populated fields, client claimed ${clientFields}, 424 fires below ${Math.ceil(clientFields / 2)}`);
  check('the client and server field counts have drifted apart — the 424 guard is drifting toward firing on healthy brands',
    Math.abs(hyd.fields - clientFields) <= 3,
    `server ${hyd.fields} vs client ${clientFields}`);
}

// ── (f) the server must refuse rather than silently write a brainless post ───
for (const [label, handler, body, ret] of [
  ['ideas', ideasHandler, iLean, IDEA_JSON],
  ['remix', remixHandler, rLean, REMIX_JSON],
]) {
  const bad = await run(handler, { ...body, bcFields: 999 }, ret);
  check(`${label}: a stale/half-empty brand row is accepted silently instead of asking for the real one`,
    bad.res._s === 424 && bad.res._j && bad.res._j.error === 'brand_context_unavailable',
    'got ' + bad.res._s + ' ' + JSON.stringify(bad.res._j || {}).slice(0, 120));
  DB_DOWN = true;
  const down = await run(handler, body, ret);
  DB_DOWN = false;
  check(`${label}: an unreadable brand row produces content anyway, written against an empty brain`,
    down.res._s === 424 && down.res._j && down.res._j.error === 'brand_context_unavailable',
    'got ' + down.res._s + ' ' + JSON.stringify(down.res._j || {}).slice(0, 120));
}

// ── (g) the client must actually recover from that 424 ───────────────────────
// A server that refuses is only half the guard: if the client does not re-send the full context,
// the user just gets an error instead of a post.
for (const [label, expr] of [['ideas', ideaSites[0]], ['remix', remixSites[0]]]) {
  const args = captureArgs(expr, label);
  capturedBodies = []; nextStatus = [424, 200];
  const resp = await helper(true)(...args);
  nextStatus = [];
  check(`${label}: a 424 from the server is not answered by re-sending the full context — the generation just fails`,
    capturedBodies.length === 2, capturedBodies.length + ' request(s) sent');
  if (capturedBodies.length === 2) {
    const second = JSON.parse(capturedBodies[1].body);
    check(`${label}: the 424 retry did not carry the brand context, so the retry is as brain-less as the first attempt`,
      !second.brandId && !!second.brandContext && !!second.brandContext.painPoints);
    check(`${label}: the 424 retry response was not returned to the caller`, resp && resp.status === 200);
  }
}

// ── (h) ratchet: nothing may send brandId to an endpoint that ignores it ─────
// This is not hypothetical. app.html was once routing /api/viral-twist and /api/viral-rewrite
// through leanBrandFetch while neither handler implemented the brandId protocol — so they
// received a brandContext of just {recentTrends} and wrote with NO brand brain at all, silently,
// and could never answer 424. Both were fixed in v625, so the exemption list is now EMPTY and
// every lean endpoint must hydrate. Leave it empty: adding an entry here is how that class of bug
// gets waved through a second time.
const KNOWN_UNHYDRATED = [];
const leanUrls = [...new Set((app.match(/leanBrandFetch\('([^']+)'/g) || []).map(m => m.slice(16, -1)))];
check('no endpoint is called through leanBrandFetch at all — the helper has been bypassed', leanUrls.length > 0);
for (const u of leanUrls) {
  const file = path.join(root, 'api', u.replace('/api/', '') + '.js');
  const src = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const hydrates = /_brandctx/.test(src) && /brand_context_unavailable/.test(src);
  if (KNOWN_UNHYDRATED.includes(u)) {
    if (hydrates) notes.push(`${u} now hydrates server-side — remove it from KNOWN_UNHYDRATED in this gate.`);
    else notes.push(`KNOWN BUG (pre-existing, not fixed here): ${u} is sent brandId + a thin brandContext but its handler never calls _brandctx — every request to it is written with NO brand brain and it can never return 424.`);
    continue;
  }
  check(`${u} is sent a lean request but its handler never hydrates the brand — it writes against an empty brain, silently`,
    hydrates, 'api/' + u.replace('/api/', '') + '.js has no _brandctx / brand_context_unavailable');
}

// ── (i) structural: the client-only pieces must stay client-built ────────────
const gni = grabFn('generateNewIdeas');
check('generateNewIdeas no longer builds its avoid-list from getVisibleIdeas() — hidden ideas would be back in the 60-title window (the v600 regression)',
  /getVisibleIdeas\(\)\.map\(s => s\.title\)/.test(gni));
check('generateNewIdeas no longer sends learningContext it built itself',
  /learningContext,/.test(gni));
const rc = grabFn('remixContent');
check('remixContent stopped sending the pasted source material', /postDescription/.test(rc));
check('the lean path is not gated on the brand save having succeeded — a stale row would be read as truth',
  /leanId[\s\S]{0,240}window\._brandSaveOk !== false/.test(HELPER_SRC));
check('leanBrandFetch builds the request before flushing the pending settings save',
  HELPER_SRC.indexOf('await flushBrandSave()') < HELPER_SRC.indexOf('const body ='));

// ── report ───────────────────────────────────────────────────────────────────
const fmt = m => `${m.full} -> ${m.lean} bytes (${Math.round(100 - m.lean / m.full * 100)}% smaller)`;
for (const n of notes) console.log('  ! ' + n);
if (fails.length) {
  console.error('FAIL: lean-payload-all —');
  for (const f of fails) console.error('  ✗ ' + f);
  console.error(`  (measured: ideas ${fmt(M.ideas)}; remix ${fmt(M.remix)}; try-all-modes x6 ${fmt(M.tryall)})`);
  process.exit(1);
}
console.log(`PASS: lean-payload-all — ideas ${fmt(M.ideas)}; remix ${fmt(M.remix)}; try-all-modes x6 ${fmt(M.tryall)}; every brand field still reaches both prompts; hand-taught trends and dismissals survive; the visible-title avoid-list still travels; both old full-context shapes still work; both endpoints refuse a stale brain and the client re-sends`);
