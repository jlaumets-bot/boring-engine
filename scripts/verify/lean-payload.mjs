#!/usr/bin/env node
// GATE: Quick Post must stop re-uploading the brand brain — WITHOUT losing a single thing
// the model used to see.
//
// WHY THIS EXISTS — a measured failure, not a theory:
//   /api/generate-ideas returned 200 at 04:17:20, 04:19:05, 04:40:24 and 04:44:09 while the
//   owner's phone showed "Timed out" every time. The server wrote the post; the request body
//   (~18KB, mostly getBrandContext()) took longer to upload than the client would wait on a
//   link measured at 0.06-0.13 KB/s.
//
// The dangerous half of the fix is invisible: the brand row does NOT contain trends the user
// typed in by hand ('brand_trends' in localStorage), nor the auto-trend dismissals that
// getAutoTrends() subtracts. Read the brain server-side naively and those silently stop
// reaching the model — nothing breaks, the writing just quietly stops reflecting what the
// user taught it. So this gate does not grep; it RUNS both paths through the real
// api/generate-ideas handler with the LLM stubbed and compares the two assembled prompts.
//
// RUN:    node scripts/verify/lean-payload.mjs
// EXPECT: prints "PASS: lean-payload" and exits 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
const require_ = createRequire(path.join(root, 'api', 'x.js'));

const fails = [];
const check = (n, c, d) => { if (!c) fails.push(n + (d ? ' — ' + d : '')); };
const die = m => { console.error('FAIL: lean-payload — ' + m); process.exit(2); };

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
  const i = app.indexOf('function ' + name + '(');
  if (i < 0) die(`function ${name} not found in app.html (renamed? this gate is now blind)`);
  const end = braceFrom(app, i);
  if (end < 0) die(`could not brace-match ${name}`);
  return app.slice(i, end);
}
function grabAssign(name) {
  const i = app.indexOf('const ' + name + ' =');
  if (i < 0) die(`const ${name} not found in app.html (renamed? this gate is now blind)`);
  const end = braceFrom(app, i);
  if (end < 0) die(`could not brace-match ${name}`);
  return app.slice(i, end) + ';';
}
function grabLine(name) {
  const m = app.match(new RegExp('^const ' + name + ' = .*$', 'm'));
  if (!m) die(`const ${name} line not found in app.html`);
  return m[0];
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
  grabFn('getBrandContext'), grabFn('_tvBcFieldCount'), grabFn('_tvAvoidLocal'),
].join('\n');

const TV_BODY_SRC = grabAssign('_tvBody');

// ── fixture: one realistic brand, as a database row ──────────────────────────
// Every text field carries a unique SENTINEL so the prompt comparison can name exactly which
// field went missing rather than reporting "prompts differ".
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
  // defaults, so a rotation covering all 8 days makes the merge a no-op and a server that
  // returned the raw column would look identical. It must not.
  day_rotation: { Monday: 'hydration', Tuesday: 'endurance', Wednesday: 'keto' },
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
    masterPromptContent: pad('masterPromptContent', 2500),
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

// ideas, oldest-first — the order the client's `state` array holds them in. Sized like a
// real library (the owner's is ~95): the avoid-list the client used to upload was the last
// 40 of these, so a toy library would understate the saving.
const FMT = 'video';
const LIB = 60;
const IDEAS = [];
for (let i = 0; i < LIB; i++) {
  const approved = i % 3 !== 2;
  IDEAS.push({
    // AVOIDONLY sits mid-library: inside the last-40 avoid-list window, but NOT in the last
    // 10 approved/dismissed samples and NOT among the 4 approved winners — so the ONLY way
    // it can reach the prompt is the library avoid-list. (First attempt marked the last idea,
    // which learningContext also names, so the check could not fail. It does now.)
    title: 'Library idea ' + i + ' — a realistic content title of ordinary length'
      + (i === 25 ? ' AVOIDONLY_marker' : ''),
    format: i % 4 === 3 ? 'statement' : FMT,
    hook: 'Hook line ' + i,
    script: 'Script body ' + i + ' ' + 'a real spoken sentence that runs on. '.repeat(16),
    bold_text: '', caption: '',
    status: approved ? (i % 2 ? 'done' : 'filming') : 'dismissed',
  });
}

const HAND_TREND = 'HANDTAUGHT_the 3am shift-worker hydration angle';

// v665 — A REWRITTEN POST, AND A SHARPENED ONE, IN BOTH STORES.
// Provenance ranking is the strongest thing the brand brain does and this fixture never exercised
// it: with no edit signals anywhere, client and server both fell back to plain recency and agreed
// for the wrong reason. Two signals now:
//   * idea 4 was REWRITTEN BY HAND. It is approved but far outside the recency window, so it can
//     only reach the exemplars through provenance ranking — client via localStorage, server via
//     the edit_signals table.
//   * idea 7 was SHARPENED. `after` is the MODEL's rewrite, so it must be counted on NEITHER side.
// The parity check then proves the two paths agree on a case where agreeing is hard.
const EDITED_IDX = 4, SHARPENED_IDX = 7;
const editedAfter = 'Script body ' + EDITED_IDX + ' a real spoken sentence that runs on.';
const sharpenedAfter = 'Script body ' + SHARPENED_IDX + ' a real spoken sentence that runs on.';
const EDIT_SIGNALS = [
  { ts: 1, title: IDEAS[EDITED_IDX].title, format: IDEAS[EDITED_IDX].format,
    field: 'Script', before: 'the draft we wrote', after: editedAfter },
  { ts: 2, by: 'ai', title: IDEAS[SHARPENED_IDX].title, format: IDEAS[SHARPENED_IDX].format,
    field: 'sharpen:script', before: 'the draft we wrote', after: sharpenedAfter },
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
    CLIENT_SRC + '\n; return { brandToSettings, getBrandContext, getRecentTrends, getApprovedExamples, _tvBcFieldCount, _tvAvoidLocal, getDayCommunities, DAYS, CS_AVOID_MARK };');
  return fn(lsGet, () => {}, currentBrand, state, settings);
}
let api0;
try { api0 = clientApi({}); } catch (e) { die('client bundle would not construct: ' + e.message); }
const settings = api0.brandToSettings(BRAND_ROW);
const C = clientApi(settings);
const dc = C.getDayCommunities();
const communities = C.DAYS.map(d => `${d}: ${dc[d]}`).join(', ');
const dayMap = C.DAYS.map(d => `${d} = ${dc[d]}`).join(', ');

// A learningContext of the shape generateTodayTabPost builds, with the avoid-list marker in
// the position the real code puts it.
const learningContext =
  '\nIDEAS THE USER LIKED:\n' + IDEAS.filter(i => i.status !== 'dismissed').slice(-10)
    .map(i => `"${i.title}" (${i.format}, Monday) — loved: ` + S('approveReason')).join(', ') +
  '\nIDEAS THE USER REJECTED:\n' + IDEAS.filter(i => i.status === 'dismissed').slice(-10)
    .map(i => `"${i.title}" (${i.format}, Monday)`).join(', ') +
  '\nHOW THE USER EDITS OUR DRAFTS:\n• hook: was "x" → "y" ' + S('editSignal') +
  '\n\n' + C.CS_AVOID_MARK;

const _avoidExtra = JSON.parse(LS.tv_recent).map(t => String(t).trim());

// ── (a) MEASURE the two real request bodies ──────────────────────────────────
const bodyFn = new Function(
  'lean', 'communities', 'dayMap', 'pickedFormat', 'forcedGaps', 'learningContext',
  '_avoidExtra', '_leanBrandId', 'DELIVERY_FORMATS', 'window',
  'getBrandContext', 'getRecentTrends', 'getApprovedExamples', '_tvBcFieldCount', '_tvAvoidLocal',
  TV_BODY_SRC + '\n; return _tvBody(lean);');
const args = lean => [lean, communities, dayMap, FMT, [{ day: 'Monday', format: FMT, count: 0 }],
  learningContext, _avoidExtra, BRAND_ROW.id, new Set(['video', 'micro', 'qna', 'statement']),
  { _tvDelivery: 'faceon' },
  C.getBrandContext, C.getRecentTrends, C.getApprovedExamples, C._tvBcFieldCount, C._tvAvoidLocal];

let fullBody, leanBody;
try { fullBody = bodyFn(...args(false)); leanBody = bodyFn(...args(true)); }
catch (e) { die('the real _tvBody would not run: ' + e.message); }
const fullBytes = Buffer.byteLength(fullBody);
const leanBytes = Buffer.byteLength(leanBody);

check('the OLD payload is not big enough for this gate to mean anything', fullBytes > 12000,
  fullBytes + ' bytes — the fixture no longer resembles a real brand, so the saving proved here is not the real saving');
check('the lean request is still large', leanBytes < 5000, leanBytes + ' bytes');
check('the lean request is not dramatically smaller', leanBytes < fullBytes * 0.35,
  leanBytes + ' vs ' + fullBytes + ' bytes = ' + Math.round(leanBytes / fullBytes * 100) + '% of the old body');

const leanParsed = JSON.parse(leanBody);
const fullParsed = JSON.parse(fullBody);
check('the lean request does not name the brand, so the server cannot load it',
  leanParsed.brandId === BRAND_ROW.id);
check('the lean request still uploads brand fields',
  JSON.stringify(Object.keys(leanParsed.brandContext).sort()) === JSON.stringify(['communities', 'dayMap', 'recentTrends']),
  'brandContext keys: ' + Object.keys(leanParsed.brandContext).join(','));
check('the OLD-shape request must not carry brandId, or an old client would take the new path',
  !('brandId' in fullParsed));
check('the OLD-shape request must not leak the avoid-list marker to the model',
  fullParsed.learningContext.indexOf(C.CS_AVOID_MARK) === -1);
check('the OLD-shape request lost its avoid-list entirely',
  fullParsed.learningContext.indexOf('TOPICS & ANGLES ALREADY USED') !== -1);

// ── (b) hand-taught trends must be in what the client still sends ────────────
check('hand-taught trends are no longer uploaded — they exist ONLY in localStorage, so this is the one thing the server can never recover',
  (leanParsed.brandContext.recentTrends || []).indexOf(HAND_TREND) !== -1);
check('a dismissed auto-trend came back',
  !(leanParsed.brandContext.recentTrends || []).some(t => /AUTOTREND_dismissed/.test(t)));
check('the kept auto-trend went missing',
  (leanParsed.brandContext.recentTrends || []).some(t => /AUTOTREND_kept/.test(t)));

// ── stub the backend's world, then run the REAL handler both ways ────────────
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
  // answered a title query with library titles — so the server "discovered" eight rewritten posts
  // that never existed and the parity check failed for a reason that was purely the stub's.
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
  // v665: the by-name lookup the provenance path depends on. Without it the stub returns the
  // recency rows for that query and the rewritten post can never reach the exemplars.
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
stub('./_usage', { checkLimit: async () => ({ ok: true }), creditsFor: () => 1, logUsage: async () => {} });
stub('./_llm', {
  callLLM: async ({ messages }) => {
    prompts.push(messages[0].content);
    return JSON.stringify([{ day: 'Monday', community: 'hydration', format: FMT, tone: 'dry', title: 'A', hook: 'B', script: 'C', shots: 'D', caption: '', reelTitle: 'E', tags: '#x' }]);
  },
});
let handler;
try { handler = require_('./generate-ideas.js'); } catch (e) { die('generate-ideas would not load: ' + e.message); }

async function run(body) {
  const res = { _s: 200, _j: null, setHeader() {}, status(s) { this._s = s; return this; }, json(j) { this._j = j; return this; }, end() { return this; } };
  const before = prompts.length;
  await handler({ method: 'POST', headers: { origin: 'https://contentshrimp.com', authorization: 'Bearer t' }, body }, res);
  return { res, prompt: prompts.slice(before).join('\n') };
}

const out = await (async () => {
  const full = await run(JSON.parse(fullBody));
  const lean = await run(JSON.parse(leanBody));
  return { full, lean };
})();

check('the OLD full-context request stopped working', out.full.res._s === 200,
  'status ' + out.full.res._s + ' ' + JSON.stringify(out.full.res._j || {}).slice(0, 160));
check('the LEAN request did not succeed', out.lean.res._s === 200,
  'status ' + out.lean.res._s + ' ' + JSON.stringify(out.lean.res._j || {}).slice(0, 160));

// ── (c) every brand field the client used to send must reach the prompt ──────
const promptFull = out.full.prompt, promptLean = out.lean.prompt;
if (promptFull && promptLean) {
  const sentinels = [...new Set((promptFull.match(/SENTINEL_[A-Za-z0-9]+/g) || []))];
  check('the old path put almost nothing in the prompt — the fixture is not exercising the renderer',
    sentinels.length >= 18, sentinels.length + ' sentinels found');
  const missing = sentinels.filter(s => promptLean.indexOf(s) === -1);
  check('brand facts VANISHED from the server-assembled prompt', missing.length === 0,
    'missing: ' + missing.join(', ') + ' — every one is a permanent, invisible quality regression');
  check('the hand-taught trend never reached the model', promptLean.indexOf(HAND_TREND) !== -1);
  check('a dismissed auto-trend was resurrected into the model prompt',
    promptLean.indexOf('AUTOTREND_dismissed') === -1);
  check('the device-only recent Quick Post title never reached the model',
    promptLean.indexOf(S('tvRecent')) !== -1);
  check('the library half of the avoid-list never reached the model — anti-repetition silently weakens',
    promptLean.indexOf('AVOIDONLY_marker') !== -1);
  check('the library avoid-list is not actually being exercised on the OLD path either — the marker is unreachable, so the check above proves nothing',
    promptFull.indexOf('AVOIDONLY_marker') !== -1);
  check('the avoid-list marker leaked into the model prompt',
    promptLean.indexOf(C.CS_AVOID_MARK) === -1 && promptFull.indexOf(C.CS_AVOID_MARK) === -1);
}

// ── (c2) object-level: hydrated context vs the object the client used to send ─
const bctx = require_('./_brandctx.js');
const BRAIN = require_('./_brain.js');
const hyd = await bctx.loadBrandContext(BRAND_ROW.id, { userId: 'user-1' }, FMT);
check('server-side hydration failed outright', hyd.ok, hyd.reason);
if (hyd.ok) {
  const clientBc = { ...C.getBrandContext(), communities, dayMap, approvedExamples: C.getApprovedExamples(FMT) };
  const serverBc = { ...hyd.bc, ...leanParsed.brandContext };
  const diffs = [];
  for (const k of Object.keys(clientBc)) {
    if (k === 'dayMap') continue;                    // client-sent, identical by construction
    // v665 — approvedExamples is compared BY WHAT REACHES THE MODEL, not by array order.
    // The two sides deliberately order this list differently: the server hands rewritten posts
    // back first (api/_brandctx.js), the client leaves them where the slice landed. Neither order
    // survives — approvedWinnersBlock (api/_brain.js) re-groups into edited-then-plain before
    // rendering, so array order cannot change one word of the prompt while the SET and the
    // `edited` flags decide everything, including which of the two headings is used. Comparing
    // the rendered block is therefore both the honest check and the stricter one: it still fails
    // if either side picks a different post or loses a provenance flag.
    if (k === 'approvedExamples') {
      const rc = BRAIN.approvedWinnersBlock({ approvedExamples: clientBc[k] });
      const rs = BRAIN.approvedWinnersBlock({ approvedExamples: serverBc[k] });
      if (rc !== rs) {
        diffs.push('approvedExamples renders differently (client ' + JSON.stringify(rc.slice(0, 90)) +
                   ' | server ' + JSON.stringify(rs.slice(0, 90)) + ')');
      }
      // And the fixture must actually be exercising provenance, or this proves nothing.
      if (!/THE BRAND'S OWN WORDS/.test(rc)) {
        diffs.push('approvedExamples: neither side found the rewritten post, so the provenance ' +
                   'path is untested and the agreement above is an accident');
      }
      continue;
    }
    const a = JSON.stringify(clientBc[k]), b = JSON.stringify(serverBc[k]);
    if (a !== b) diffs.push(k + ' (client ' + String(a).slice(0, 70) + ' | server ' + String(b).slice(0, 70) + ')');
  }
  check('the server-assembled context does not match the one the client used to upload, field for field',
    diffs.length === 0, diffs.join(' ;; '));
  check('fewer than 30 brand-context fields were compared — the enumeration has drifted',
    Object.keys(clientBc).length >= 30, Object.keys(clientBc).length + ' keys');
}

// ── (d) the server must refuse rather than silently write a brainless post ────
const bad = await run({ ...JSON.parse(leanBody), brandId: 'brand-1', bcFields: 999 });
check('a stale/half-empty brand row is accepted silently instead of asking for the real one',
  bad.res._s === 424 && bad.res._j && bad.res._j.error === 'brand_context_unavailable',
  'got ' + bad.res._s + ' ' + JSON.stringify(bad.res._j || {}).slice(0, 120));

// A brand row we could not READ is the same danger as a stale one: writing a post with an
// empty brain, which looks fine and is silently off-voice forever.
DB_DOWN = true;
const down = await run(JSON.parse(leanBody));
DB_DOWN = false;
check('an unreadable brand row produces a post anyway, written against an empty brain',
  down.res._s === 424 && down.res._j && down.res._j.error === 'brand_context_unavailable',
  'got ' + down.res._s + ' ' + JSON.stringify(down.res._j || {}).slice(0, 120));

// ── the debounced-save window ────────────────────────────────────────────────
// Settings saves are debounced 600ms. Reading the brand row server-side means an edit made
// seconds ago must already BE in that row, so the pending save has to be flushed AND awaited
// before the request goes out — and a save that FAILED must send Quick Post back to
// uploading the context itself.
const fsSrc = grabFn('flushBrandSave');
const fsFn = new Function('_brandSaveTimer', '_queueBrandSave', '_brandSaveChain', 'clearTimeout',
  fsSrc + '\n; return flushBrandSave();');
check('flushBrandSave() returns nothing when a save is pending — Quick Post cannot await it',
  fsFn(1, () => 'QUEUED', 'CHAIN', () => {}) === 'QUEUED');
check('flushBrandSave() returns nothing when no save is pending — awaiting it would not wait for an in-flight write',
  fsFn(null, () => 'QUEUED', 'CHAIN', () => {}) === 'CHAIN');

const qpStart = app.indexOf('async function generateTodayTabPost');
const qpEnd = braceFrom(app, qpStart);
const qp = app.slice(qpStart, qpEnd);
const iLean = qp.indexOf('const _leanBrandId');
const iFlush = qp.indexOf('await flushBrandSave()');
const iSend = qp.indexOf('const _send =');
check('Quick Post does not flush the pending settings save before reading the brand row server-side',
  iFlush > -1, 'an edit made within the 600ms debounce would not be in the post');
check('the settings flush does not happen before the request is built/sent',
  iFlush > iLean && iLean > -1 && iFlush < iSend && iSend > -1,
  'flush@' + iFlush + ' lean@' + iLean + ' send@' + iSend);
check('the lean path is not gated on the brand save having succeeded — a stale row would be read as truth',
  /_leanBrandId[\s\S]{0,240}window\._brandSaveOk !== false/.test(qp));
check('nothing ever sets window._brandSaveOk, so the gate above can never trip',
  /window\._brandSaveOk = false/.test(app) && /window\._brandSaveOk = true/.test(app));
// data-integrity.mjs lifts saveBrandToDB and runs it in Node, where `window` is undefined —
// an unguarded assignment there is a ReferenceError that kills an unrelated gate.
check('window._brandSaveOk is written without a guard — that throws wherever saveBrandToDB is lifted and run outside a browser',
  (app.match(/window\._brandSaveOk = /g) || []).length ===
  (app.match(/try \{ window\._brandSaveOk = /g) || []).length);

// ── report ───────────────────────────────────────────────────────────────────
if (fails.length) {
  console.error('FAIL: lean-payload —');
  for (const f of fails) console.error('  ✗ ' + f);
  console.error(`  (measured: old ${fullBytes} bytes, lean ${leanBytes} bytes)`);
  process.exit(1);
}
console.log(`PASS: lean-payload — request ${fullBytes} -> ${leanBytes} bytes (${Math.round(100 - leanBytes / fullBytes * 100)}% smaller); every brand field still reaches the prompt; hand-taught trends and dismissals survive; the old full-context shape still works`);
