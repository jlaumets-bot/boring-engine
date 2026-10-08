#!/usr/bin/env node
// GATE (v693, content-v2 leaf-U): the app side of the writing-quality rebuild RUNS correctly.
//
// WHAT IT PROVES — by EXECUTING the real functions lifted from app.html in node:vm, with a fake DOM,
// a fake fetch answering in the shapes of .unlazy/content-v2/PLAN.md (C-API-1..5), a fake
// MediaRecorder and a fake PostgREST. The Content Lab section talks to the REAL api/blind-test.js
// handler (store / LLM stubbed), so it cannot pass against a server of a different shape.
//   A  Remix: angles → pick → write → slots as chips → voice / typed fill of EXACTLY the slot that
//      asked (by what it asks, not where it is) → save; the belief is kept only on SAVE; the save is
//      only claimed once the database confirms; brand A→B→A can still save; statements / carousels
//      are built from the FINAL script and refuse an open slot; the panel and the sheet are two runs;
//      drafts per host, a week old at most; double taps start one recorder; stale answers never land
//      in a newer run; missing gen_flow / emphasis columns never lose an idea (3 attempts).
//   B  errors said honestly.   C  tones.   D  Content Lab against the real handler.
//   E  filmed rate (v2, v2-batch, v1).   F  brand memory lists incl. speech, deletes only on success.
//   G  XSS.   H  real speech → kind 'speech', and "Forget this one" deletes the server copy.
// RUN: node scripts/verify/rv2-ui-1.mjs      EXPECT: prints "UI V2 OK", exit 0.
import fs from 'node:fs'; import vm from 'node:vm';
import Module, { createRequire } from 'node:module';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = path.join(ROOT, 'api');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
setTimeout(() => { console.log('FAIL: wall clock (90s) exceeded'); process.exit(2); }, 90000).unref();
// a promise that never settles would let node exit 0 half-way: that is a failure, not a pass
let finished = false; process.on('exit', (code) => { if (!finished && code === 0) { console.log('FAIL: the gate ended before all checks ran (a promise never settled)'); process.exitCode = 1; } });
let fail = 0; const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('ok:', m); };
const J = v => JSON.stringify(v);
const grab = n => {
  let i = html.indexOf('\nfunction ' + n + '('); if (i < 0) i = html.indexOf('\nasync function ' + n + '(');
  if (i < 0) throw new Error('no ' + n + ' in app.html');
  const eol = html.indexOf('\n', i + 1), first = html.slice(i + 1, eol);
  let d = 0, seen = false; for (const ch of first) { if (ch === '{') { d++; seen = true; } else if (ch === '}') d--; }
  if (seen && d === 0) return first;
  return html.slice(i + 1, html.indexOf('\n}', i) + 2);
};
const between = (a, b) => { const i = html.indexOf(a); const j = html.indexOf(b, i); if (i < 0 || j < 0) throw new Error('marker missing: ' + a.slice(0, 40)); return html.slice(i, j); };
const tick = async (n = 14) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const unent = s => String(s).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const deferred = () => { let res; const p = new Promise(r => { res = r; }); return { p, res }; };

// ── fake DOM ─────────────────────────────────────────────────────────────────────────────────────
const els = {};
function mk(id, extra) {
  return Object.assign({ id, value: '', innerHTML: '', placeholder: '', disabled: false, textContent: '', attrs: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    getAttribute(k) { return this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = String(v); },
    dispatchEvent() {}, scrollIntoView() {}, focus() {}, remove() { delete els[this.id]; } }, extra || {});
}
const put = (id, extra) => (els[id] = mk(id, extra));
// ── fake fetch ───────────────────────────────────────────────────────────────────────────────────
const calls = []; let route = () => ({ status: 404, body: { error: 'no route' } });
async function fakeFetch(url, init) {
  const body = init && init.body ? JSON.parse(init.body) : null;
  calls.push({ url, body });
  const r = await route(url, body);
  if (r instanceof Error) throw r;
  const txt = typeof r.body === 'string' ? r.body : JSON.stringify(r.body == null ? {} : r.body);
  return { ok: r.status >= 200 && r.status < 300, status: r.status, url, text: async () => txt, json: async () => JSON.parse(txt), clone() { return this; } };
}
const callsTo = (u, action) => calls.filter(c => c.url === u && (!action || (c.body && c.body.action === action)));
// ── fake recorder ────────────────────────────────────────────────────────────────────────────────
const timers = [], timerFns = []; let recorders = 0, smallBlob = false;
class FakeRec {
  constructor() { this.state = 'inactive'; recorders++; }
  static isTypeSupported(t) { return t === 'audio/webm;codecs=opus'; }
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.ondataavailable && this.ondataavailable({ data: new Blob([new Uint8Array(smallBlob ? 10 : 2000)]) }); this.onstop && this.onstop(); }
}
class FakeReader { readAsDataURL() { this.result = 'data:audio/webm;base64,AAAA'; setImmediate(() => { this.onloadend && this.onloadend(); this.onload && this.onload(); }); } }
// ── fake PostgREST (same behaviour as emphasis-persist.mjs: unknown column → PGRST204) ───────────
function makeDb(columns, opts) {
  const cols = new Set(columns); const rows = []; let seq = 0; const inserts = []; const o = opts || {};
  const db = { rows, inserts };
  db.from = (table) => {
    const q = { op: null, filters: [], payload: null, order: null, range: null };
    const run = () => {
      if (q.op === 'insert') {
        const list = Array.isArray(q.payload) ? q.payload : [q.payload];
        inserts.push(JSON.parse(JSON.stringify(list)));
        for (const r of list) for (const k of Object.keys(r)) if (!cols.has(k))
          return { data: null, error: o.pg ? { code: '42703', message: `column "${k}" of relation "${table}" does not exist` }
            : { code: 'PGRST204', message: `Could not find the '${k}' column of '${table}' in the schema cache` } };
        for (const r of list) { seq++; const st = { id: 'id-' + seq, created_at: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString() };
          for (const c of cols) if (!(c in st)) st[c] = (c in r) ? JSON.parse(JSON.stringify(r[c])) : null; rows.push(st); }
        return { data: null, error: null };
      }
      const hit = rows.filter(r => q.filters.every(f => f(r)));
      if (q.op === 'delete') { for (const r of hit) rows.splice(rows.indexOf(r), 1); return { data: hit.map(r => ({ id: r.id })), error: null }; }
      let out = hit.slice();
      if (q.order) out.sort((a, b) => (a[q.order[0]] < b[q.order[0]] ? -1 : 1) * q.order[1]);
      if (q.range) out = out.slice(q.range[0], q.range[1] + 1);
      return { data: out.map(r => JSON.parse(JSON.stringify(r))), error: null };
    };
    const b = { select() { if (!q.op) q.op = 'select'; return b; }, insert(p) { q.op = 'insert'; q.payload = p; return b; },
      delete() { q.op = 'delete'; return b; }, eq(k, v) { q.filters.push(r => r[k] === v); return b; },
      in(k, vs) { q.filters.push(r => vs.includes(r[k])); return b; }, order(k, x) { q.order = [k, x && x.ascending === false ? -1 : 1]; return b; },
      range(a, z) { q.range = [a, z]; return b; }, then(res, rej) { return Promise.resolve().then(run).then(res, rej); } };
    return b;
  };
  return db;
}
const COLS = ['id', 'brand_id', 'day', 'community', 'format', 'title', 'hook', 'script', 'shots', 'screen', 'caption', 'reel_title',
  'tags', 'bold_text', 'status', 'dismiss_reason', 'assignee', 'is_generated', 'created_at', 'is_remix', 'original_creator', 'emphasis'];

// ── the real app code, in a vm ───────────────────────────────────────────────────────────────────
const store = new Map(); const toasts = [];
let micGate = null;           // when set, getMicStream waits for it (to prove a double tap starts one recorder)
let saveResult = { ok: true };
const c = {
  console: { log() {}, warn() {}, error() {}, info() {} }, JSON, Promise, Blob, Date, Math, String, Number, Array, Object, Set, Map, RegExp, Error, TypeError,
  window: {}, globalThis: null, state: [], IDEAS: [], currentBrand: { id: 'brand-1' }, sb: null, settings: { tones: [], voiceLog: [], voiceLearn: true },
  currentRemixMode: 'remix', _switchSeq: 0, _micHold: null, _dictRec: null, _dictStarting: false, _dictStartTok: 0,
  document: { getElementById: id => els[id] || null, createElement: () => mk(''), body: { appendChild(e) { if (e.id) els[e.id] = e; } },
    querySelector: () => null, querySelectorAll: () => [] },
  fetch: fakeFetch, MediaRecorder: FakeRec, FileReader: FakeReader, Event: class { constructor(t) { this.type = t; } },
  setTimeout: (fn, ms) => { timers.push(ms); timerFns.push({ fn, ms }); return 0; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  // brand-scoped like the real bkey(): '<base>::<open brand id>'
  lsSet: (k, v) => { store.set(k + '::' + c.currentBrand.id, v); return true; }, lsGet: k => { const kk = k + '::' + c.currentBrand.id; return store.has(kk) ? store.get(kk) : null; },
  lsDel: k => store.delete(k + '::' + c.currentBrand.id),
  localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: k => { store.delete(k); } },
  showToast: (m) => toasts.push(String(m)), btnWork: () => () => {}, flushBrandSave: async () => {}, getBrandContext: () => ({ brandName: 'X', usps: 'y' }),
  _humanEditedTitles: () => [], saveState() {}, saveGeneratedIdeas() { c.__saves = (c.__saves || 0) + 1; return Promise.resolve(saveResult); },
  renderNav() {}, switchView() {}, mascotReact() {},
  saveSettings() { c.__settingsSaved = (c.__settingsSaved || 0) + 1; }, renderSettingsPanel() {},
  getMicStream: async () => { c.__mics = (c.__mics || 0) + 1; if (micGate) await micGate; return { getTracks: () => [{ stop() {} }] }; },
  showVoicePill() {}, hideVoicePill() {}, micErrMsg: () => 'mic', _micReleaseHandled() {}, _micRelease() {},
  alert: (m) => toasts.push('ALERT ' + m), DELIVERY_FORMATS: new Set(['video', 'micro', 'qna', 'statement']), refShotClear() {}, saveRemixes() {}, renderRemixResults() {}, remixes: [], remixRefImage: null,
  leanBrandFetch: async () => { c.__classic = (c.__classic || 0) + 1; return fakeFetch('/api/remix', { body: '{}' }); },
  nbDevelop: (id) => { c.__nbClassic = id; },
};
c.globalThis = c;
vm.createContext(c);
const FNS = ['escapeHtml', 'escHtml', 'humanErr', '_leanNetFail', '_leanErrMsg', 'csAiPausedText', '_tvBcFieldCount', 'brandGate', 'remixContent',
  'tpEscape', 'tpOutsideTags', 'tpSenseLines', 'tpStressRx', 'tpEmphasise', 'tpPruneEmphasis', 'tpCleanEmphasis',
  '_buildIdeaRows', '_saveIdeasToDBNow', 'normalizeIdeaStatus', '_ideaRowRecency', 'loadIdeasFromDB', 'toggleTone', 'dictateInto'];
for (const n of FNS) vm.runInContext(grab(n), c);
for (const m of html.matchAll(/^const (TP_STRESS_[AB]) = .*$/gm)) vm.runInContext(m[0].replace(/^const /, 'var '), c);
vm.runInContext(between('const VOICE_LOG_MAX', 'function brainFieldKeys(){').replace(/^const /gm, 'var '), c);
// the whole v693 block, top-level let/const turned into context vars so the gate can inspect them
vm.runInContext(between('/* v693 — REMIX, REBUILT', '\nfunction removeRemix(idx) {').replace(/^(let|const) /gm, 'var '), c);

const SRC = 'Transcript: a creator says everyone should post daily or the algorithm buries you.';
const XSS = '<img src=x onerror=alert(1)>';
const ANGLES = [
  { id: 'a1', belief: 'Posting daily is how small brands stay invisible', why: 'Everyone was told volume wins.' },
  { id: 'a2', belief: 'Your worst post teaches more than your best ' + XSS, why: 'People hide flops ' + XSS },
  { id: 'a3', belief: 'Three posts a week beat seven', why: 'Feels lazy.' },
  { id: 'a4', belief: 'The algorithm rewards replies, not reach', why: 'Reach is what dashboards show.' },
  { id: 'a5', belief: 'Stop batching content', why: 'Batching is sold as discipline.' },
  { id: 'a6', belief: 'A boring post filmed beats a clever one planned', why: 'Clever feels safer.' },
];
const SCRIPT = 'Everyone says post every day ' + XSS + '.\nI did that for a year.\n[your story: the week the numbers dropped]\nSo I stopped.\n[your story: what you ' + XSS + ' did instead]\nAnd it worked.';
const ASK0 = 'the week the numbers dropped', ASK1 = 'what you ' + XSS + ' did instead';
const IDEA = { title: 'Stop posting daily', hook: 'I stopped posting daily. Here is what happened.', script: SCRIPT,
  storySlots: [{ marker: '[your story: ' + ASK0 + ']', ask: ASK0 }],
  onScreen: ['Daily posting is a trap', 'Then [your story: the week the numbers dropped]'], caption: 'Less, but real.', shots: ['Talking head', 'Screen of analytics'], format: 'talking',
  emphasis: ['So I stopped'], belief: ANGLES[0].belief, genFlow: 'v2' };
const reset = () => { calls.length = 0; toasts.length = 0; timers.length = 0; store.clear(); for (const k of Object.keys(els)) delete els[k];
  put('rv2Panel'); put('remixBtn'); put('remixDescription', { value: SRC }); put('remixPostUrl', { value: 'https://www.tiktok.com/@x/video/1' });
  put('youtubeUrl'); put('articleUrl'); put('remixCreatorName', { value: '@creator' }); put('remixPlatform', { value: 'tiktok' });
  saveResult = { ok: true }; micGate = null;
  vm.runInContext('rv2SetRun("rv2Panel", null); rv2SetRun("rv2Sheet", null); state = []; IDEAS = []; window = {}; currentRemixMode = "remix"; currentBrand = { id: "brand-1" }; _dictRec = null; _dictStarting = false;', c); };
const panel = () => els.rv2Panel.innerHTML;
const HAPPY = (over) => (u, b) => {
  const o = over || {};
  if (u === '/api/angles') return { status: 200, body: { angles: ANGLES, flow: 'v2' } };
  if (u === '/api/write') return o.write ? o.write(b) : { status: 200, body: { idea: IDEA, usedStories: [], usedSpeechSamples: 0, passes: { inventedRemoved: ['$200', '$15,000'] } } };
  if (u === '/api/brand-memory' && b.kind === 'belief') return o.belief ? o.belief(b) : { status: 500, body: { error: 'boom' } };
  if (u === '/api/brand-memory' && b.kind === 'story') return o.story ? o.story(b) : { status: 200, body: { item: { id: 's1' } } };
  if (u === '/api/brand-memory' && b.kind === 'speech') return { status: 200, body: { item: { id: 'sp' } } };
  if (u === '/api/transcribe-voice') return { status: 200, body: { text: o.said || 'Our views halved in one week and I panicked.' } };
  return { status: 404, body: {} };
};
async function toScript(over) { reset(); route = HAPPY(over); await c.remixContent(); await tick(); await c.rv2Pick(0); await tick(); }
const belAdds = () => callsTo('/api/brand-memory', 'add').filter(x => x.body.kind === 'belief');

(async () => {
  // ═══ A. the whole happy path ════════════════════════════════════════════════════════════════
  reset(); route = HAPPY();
  await c.remixContent(); await tick();
  const ang = callsTo('/api/angles');
  ok(ang.length === 1 && c.__classic === undefined, 'Remix (default mode) calls /api/angles, not the classic /api/remix');
  const ab = ang[0] && ang[0].body;
  ok(ab && ab.brandId === 'brand-1' && ab.count === 6 && ab.source && ab.source.kind === 'remix' && ab.source.text.startsWith('Transcript:')
    && ab.source.url.includes('tiktok') && ab.source.creator === 'creator' && ab.bcFields === 2, 'the angles request carries brandId, bcFields and the contract source shape (' + J(ab && ab.source).slice(0, 90) + ')');
  ok((panel().match(/class="rv2-angle[ "]/g) || []).length === 6 && panel().includes('Why most disagree: Everyone was told volume wins.'), 'six belief cards render, each with its "why most disagree" line');
  ok(!panel().includes(XSS) && panel().includes('&lt;img src=x onerror=alert(1)&gt;'), 'G1 a belief / why containing <img onerror> renders escaped');
  ok(c._rv2.stage === 'angles' && store.has('rv2_draft::brand-1'), 'the opinions are kept as a draft (a reload does not lose them)');
  vm.runInContext('rv2SetRun("rv2Panel", null)', c); c.rv2Restore();
  ok(c._rv2 && c._rv2.stage === 'angles' && c._rv2.angles.length === 6 && c._rv2.source.text.startsWith('Transcript:'), 'after a reload the draft comes back with its opinions and source');
  { const d = JSON.parse(store.get('rv2_draft::brand-1'));
    d.brandId = 'brand-OTHER'; store.set('rv2_draft::brand-1', JSON.stringify(d)); vm.runInContext('rv2SetRun("rv2Panel", null)', c); c.rv2Restore();
    ok(c._rv2 === null, 'a draft that belongs to another brand is never restored here');
    d.brandId = 'brand-1'; d.at = Date.now() - 8 * 86400000; store.set('rv2_draft::brand-1', JSON.stringify(d)); c.rv2Restore();
    ok(c._rv2 === null, 'M9 a draft older than a week is not restored');
    d.at = Date.now(); store.set('rv2_draft::brand-1', JSON.stringify(d)); c.rv2Restore(); }
  await c.rv2Pick(0); await tick();
  ok(belAdds().length === 0, 'picking an opinion does NOT keep it as a brand belief (only saving does)');
  const wr = callsTo('/api/write');
  ok(wr.length === 1 && wr[0].body.angle.belief === ANGLES[0].belief && wr[0].body.angle.why === ANGLES[0].why && wr[0].body.format === 'talking' && wr[0].body.source.text.startsWith('Transcript:'),
    '/api/write gets that angle and the source');
  ok(c._rv2.stage === 'script' && (panel().match(/class="rv2-slot"/g) || []).length === 2, 'the script renders with both [your story: …] slots as tappable chips');
  ok(panel().includes('Everyone says post every day &lt;img src=x onerror=alert(1)&gt;.<br>I did that for a year.<br>') && !/\[your story:/.test(panel()), 'M2 the script between slots is escaped; line breaks kept; no raw slot marker');
  ok(panel().includes('the week the numbers dropped') && panel().includes('what you &lt;img src=x onerror=alert(1)&gt; did instead') && !panel().includes(XSS), 'G2 slot asks show in the chips, escaped');
  ok(/make up 2 details/.test(panel()), 'the writer\'s removed inventions are said (passes.inventedRemoved)');
  // voice-fill slot #1 (the SECOND slot) through the real dictateInto
  c.rv2OpenSlot(1);
  ok(panel().includes('Tell it in 20 seconds') && panel().includes('rv2SlotMic(1, this)'), 'tapping a slot opens "Tell it in 20 seconds" for that slot');
  { vm.runInContext('_dictRec = { stop() { globalThis.__otherStopped = true; } }', c); toasts.length = 0; c.__otherStopped = false;
    c.rv2SlotMic(1, mk('mic'));
    ok(!c.__otherStopped && !c._rv2.recording && toasts.some(t => /Finish the other recording first/.test(t)), '#7 a slot mic never stops another dictation (and does not lock itself)');
    vm.runInContext('_dictRec = null', c); }
  recorders = 0; c.__mics = 0;
  c.rv2SlotMic(1, mk('mic')); c.rv2SlotMic(1, mk('mic')); await tick();
  ok(c._dictRec && recorders === 1 && c.__mics === 1 && timers.includes(30000), '#7 a double tap starts ONE recorder, capped at 30 s');
  ok(/disabled>Listening… press the pill to stop/.test(panel()), '#7 the mic button is disabled while recording');
  // M1: while recording slot 1, the person types slot 0 — the positions shift, the question does not
  c.rv2OpenSlot(0); put('rv2SlotText', { value: 'Views went from 9k to 900.' }); c.rv2SlotTyped(); await tick();
  ok(c.rv2Slots(c._rv2.script).length === 1 && c.rv2Slots(c._rv2.script)[0].ask === ASK1, 'the typed story filled slot 0; slot 1 is now the only one');
  c._dictRec.stop(); await tick(30);
  ok(callsTo('/api/transcribe-voice').length === 1, 'the recording goes to /api/transcribe-voice');
  ok(c.rv2Slots(c._rv2.script).length === 0 && c._rv2.script.includes('Our views halved in one week and I panicked.') && c._rv2.script.includes('Views went from 9k to 900.'),
    'M1 the voice note filled the slot that ASKED for it, though it had moved (' + J(c._rv2.script.slice(60, 170)) + ')');
  ok(!/disabled>Listening/.test(panel()), '#7 the mic button comes back when recording ends');
  const st = callsTo('/api/brand-memory', 'add').filter(x => x.body.kind === 'story');
  ok(st.length === 2 && st.some(x => x.body.text === 'Our views halved in one week and I panicked.' && J(x.body.tags) === J([ASK1])), 'each story is kept via /api/brand-memory add kind story, tagged with its slot');
  ok(/Kept in your story bank/.test(panel()), 'the person is told it was kept');
  { const before = calls.length; await c.rv2MemAdd('brand-1', 'belief', 'word '.repeat(60), []); await c.rv2MemAdd('brand-1', 'story', 'story '.repeat(200), []);
    const [b1, s1] = calls.slice(before).map(x => x.body.text);
    ok(b1.length <= 140 && s1.length <= 600 && !/\s$/.test(b1) && b1.endsWith('word') && s1.endsWith('story'), 'memory writes are cut to the server caps (belief 140, story 600) at a word boundary, never refused'); }
  c.rv2ToggleEdit(); ok(panel().includes('id="rv2ScriptEdit"'), 'Edit script shows the script in a text box');
  c.rv2EditInput(c._rv2.script.replace('And it worked.', 'And it worked. Honestly.')); c.rv2ToggleEdit();
  ok(c._rv2.script.endsWith('Honestly.'), 'a hand edit is kept');
  // save — claimed only after the database confirms; the belief is kept after that
  const p = c.rv2Save(); const p2 = c.rv2Save();
  ok(/disabled>Saving…/.test(panel()) && c.state.length === 1, '#3 while saving the button says so and cannot be tapped again');
  const idea = await p; await tick();
  ok((await p2) === false && c.state.length === 1, '#3 a double tap on Save saves once');
  ok(idea && c.state.length === 1 && c.state[0].genFlow === 'v2' && c.state[0].status === 'pending' && c.state[0].isGenerated === true && c.__saves === 1,
    'Save idea files it into Ideas as pending, generated, gen flow v2 — once');
  const s0 = c.state[0];
  ok(s0.hook === IDEA.hook && s0.script.includes('Honestly.') && s0.screen === 'Daily posting is a trap' && s0.caption === 'Less, but real.'
    && s0.shots === 'Talking head\nScreen of analytics' && s0.format === 'video' && J(s0.emphasis) === J(['So I stopped']) && s0.boldText === '',
    'hook / script / onScreen→screen (a line still holding a slot marker dropped) / caption / shots / emphasis land in the existing fields');
  ok(!store.has('rv2_draft::brand-1') && panel() === '' && els.remixDescription.value === '' && toasts.some(t => /^Saved to Ideas/.test(t)), 'after the confirmed save, the draft, panel and source are cleared and it says Saved');
  ok(belAdds().filter(x => x.body.text === ANGLES[0].belief).length === 1, 'the kept opinion is saved as a brand belief after saving (the 500 there changed nothing)');
  let rows = c._buildIdeaRows('brand-1');
  ok(rows[0].gen_flow === 'v2' && rows[0].is_generated === true && rows[0].status === 'pending', 'the database row carries gen_flow v2');
  vm.runInContext('state.push({ title: "Old idea", hook: "h", script: "s", status: "pending", format: "video" })', c);
  rows = c._buildIdeaRows('brand-1');
  ok(!('gen_flow' in rows[1]), 'an idea from the old flow names no gen_flow at all (old databases are never asked for it)');
  let db = makeDb([...COLS, 'gen_flow']); c.sb = db; c._ideasNoGenFlowCol = false; c._ideasNoEmphasisCol = false;
  await c._saveIdeasToDBNow('brand-1', rows);
  ok(db.rows.find(r => r.title === 'Stop posting daily').gen_flow === 'v2' && db.rows.find(r => r.title === 'Old idea').gen_flow === null, 'stored: v2 on the new idea, nothing on the old');
  c.state = await c.loadIdeasFromDB();
  ok(c.state.find(i => i.title === 'Stop posting daily').genFlow === 'v2' && !('genFlow' in c.state.find(i => i.title === 'Old idea')), 'a reload reads gen_flow back as genFlow');
  await c._saveIdeasToDBNow('brand-1', c._buildIdeaRows('brand-1'));
  ok(db.rows.length === 2 && db.rows.find(r => r.title === 'Stop posting daily').gen_flow === 'v2', 'saving the reloaded library keeps it (no duplicate, no loss)');
  for (const pg of [false, true]) {
    db = makeDb(COLS, { pg }); c.sb = db; c._ideasNoGenFlowCol = false; c._ideasNoEmphasisCol = false;
    let threw = null; try { await c._saveIdeasToDBNow('brand-1', c._buildIdeaRows('brand-1')); } catch (e) { threw = e; }
    ok(!threw && db.rows.length === 2 && db.inserts.length === 2 && db.inserts[0].some(r => 'gen_flow' in r) && db.inserts[1].every(r => !('gen_flow' in r)) && c._ideasNoGenFlowCol === true,
      (pg ? '42703' : 'PGRST204') + ': a database without gen_flow still saves the idea, retried once without the column');
  }
  await c._saveIdeasToDBNow('brand-1', c._buildIdeaRows('brand-1'));
  ok(db.inserts.length === 3 && db.inserts[2].every(r => !('gen_flow' in r)), 'the next save skips the missing column straight away');
  db = makeDb(COLS.filter(x => x !== 'emphasis')); c.sb = db; c._ideasNoGenFlowCol = false; c._ideasNoEmphasisCol = false;
  { let threw = null; try { await c._saveIdeasToDBNow('brand-1', c._buildIdeaRows('brand-1')); } catch (e) { threw = e; }
    ok(!threw && db.rows.length === 2 && c._ideasNoGenFlowCol && c._ideasNoEmphasisCol, 'with BOTH new columns missing the idea is still saved');
    ok(db.inserts.length === 3 && db.inserts[2].length === 2, 'M6 in ONE batch with three attempts (no fall-back to row-by-row: ' + db.inserts.length + ' inserts)'); }
  db = makeDb([...COLS, 'gen_flow']); c.sb = db; c._ideasNoGenFlowCol = false; c._ideasNoEmphasisCol = false;
  const realFrom = db.from; db.from = t => { const b = realFrom(t); const ins = b.insert; b.insert = p => { ins(p); return { then: (res) => Promise.resolve({ data: null, error: { code: '42501', message: 'new row violates row-level security policy (gen_flow)' } }).then(res) }; }; return b; };
  { let threw = null; try { await c._saveIdeasToDBNow('brand-1', c._buildIdeaRows('brand-1')); } catch (e) { threw = e; }
    ok(threw && !c._ideasNoGenFlowCol, 'opposite arm: an RLS refusal still fails loudly and is not mistaken for a missing column'); }

  // ── #3 a failed save keeps the script; ideas are only claimed saved on success ──
  await toScript(); saveResult = { ok: false };
  let r3 = await c.rv2Save(); await tick();
  ok(r3 === false && c.state.length === 0 && c._rv2 && c._rv2.stage === 'script' && store.has('rv2_draft::brand-1') && /Couldn.t save it to your account/.test(unent(panel()))
    && !toasts.some(t => /^Saved to Ideas/.test(t)) && belAdds().length === 0, '#3 a failed save: the idea is taken back out, the script and draft stay, it is said, no belief kept');
  saveResult = { ok: true }; r3 = await c.rv2Save(); await tick();
  ok(r3 && c.state.length === 1 && !store.has('rv2_draft::brand-1'), '#3 tapping Save again then works');
  // ── #1 brand A → B → A: still savable; while on B, refused ──
  await toScript();
  vm.runInContext('_switchSeq++; currentBrand = { id: "brand-2" }', c);
  ok((await c.rv2Save()) === false && c.state.length === 0 && c._rv2 === null, '#1 while another brand is open nothing is saved (its run is not the active one)');
  vm.runInContext('_switchSeq++; currentBrand = { id: "brand-1" }; window._ideasSwitching = true', c);
  ok((await c.rv2Save()) === false && c.state.length === 0, '#1 not while that brand\'s ideas are still loading');
  vm.runInContext('window._ideasSwitching = false', c);
  c.rv2BackToAngles(); await c.rv2Pick(2); await tick();
  ok(c._rv2.stage === 'script' && callsTo('/api/write').length === 2, '#1 back on the brand, "Pick another opinion" and a new pick still work');
  ok((await c.rv2Save()) && c.state.length === 1, '#1 and the script saves (A→B→A no longer locks it)');
  // ── #2 statements / carousels are built from the FINAL script and refuse an open slot ──
  const ST_SCRIPT = 'Cheap is not worse.\n\n[your story: the day a customer switched]\n\nPrice is not quality.';
  await toScript({ write: () => ({ status: 200, body: { idea: { title: 'Cheap', hook: 'Cheap is not worse.', script: ST_SCRIPT, onScreen: ['Cheap is not worse.', '[your story: the day a customer switched]', 'Price is not quality.'], format: 'carousel' } } }) });
  let rs = await c.rv2Save();
  ok(rs === false && c.state.length === 0 && /Tell “the day a customer switched” first — on a carousel it would show on screen/.test(unent(panel())), '#2 a carousel with an open slot is not saved, and says which slot');
  await c.rv2FillSlot(0, 'Sam switched from the $40 one [your story: sneaky] and never looked back.', false, 'the day a customer switched'); await tick();
  ok(c.rv2Slots(c._rv2.script).length === 0 && c._rv2.script.includes('the $40 one sneaky and never'), 'a transcript holding "[your story: …]" can never create a new slot');
  rs = await c.rv2Save();
  ok(rs && rs.format === 'carousel' && rs.boldText === 'Slide 1: Cheap is not worse.\nSlide 2: Sam switched from the $40 one sneaky and never looked back.\nSlide 3: Price is not quality.' && rs.screen === '',
    '#2 the carousel slides come from the final script, the story included (' + J(rs && rs.boldText).slice(0, 80) + ')');
  await toScript({ write: () => ({ status: 200, body: { idea: { title: 'Stmt', hook: 'h', script: 'Price is not quality. [your story: proof]', onScreen: ['Price is not quality. [your story: proof]'], format: 'statement' } } }) });
  ok((await c.rv2Save()) === false, '#2 a statement with an open slot is refused too');
  c.rv2ToggleEdit(); c.rv2EditInput('Price is not quality. I proved it twice.'); c.rv2ToggleEdit();
  rs = await c.rv2Save();
  ok(rs && rs.boldText === 'Price is not quality. I proved it twice.', '#2 the statement text is the final (hand-edited) script');
  // ── M4 a stale answer never lands in a newer run ──
  { reset(); const hold = deferred(); route = (u, b) => u === '/api/write' ? hold.p : HAPPY()(u, b);
    await c.remixContent(); await tick(); const pick = c.rv2Pick(0); await tick();
    const first = c._rv2;
    await c.remixContent(); await tick();
    const second = c._rv2;
    hold.res({ status: 200, body: { idea: IDEA } }); await pick; await tick();
    ok(first !== second && second.stage === 'angles' && second.script === '' && !second.idea, 'M4 a write for an older run does not land in the newer one'); }
  // ── exactly the slot asked for: fill the SECOND slot while the first is still open ──
  await toScript();
  await c.rv2FillSlot(1, 'Second one first.', false, ASK1); await tick();
  ok(c.rv2Slots(c._rv2.script).length === 1 && c.rv2Slots(c._rv2.script)[0].ask === ASK0 && c._rv2.script.includes('So I stopped.\nSecond one first.\nAnd it worked.'), 'the second slot is filled, the first stays a chip');
  await toScript();
  c.rv2OpenSlot(1); put('rv2SlotText', { value: 'Typed into the second.' }); c.rv2SlotTyped(); await tick();
  ok(c.rv2Slots(c._rv2.script).length === 1 && c.rv2Slots(c._rv2.script)[0].ask === ASK0 && c._rv2.script.includes('Typed into the second.'), 'M8 typed words go to the slot that was opened, not the first one');
  // ── M8 the typed story goes to the slot that was OPENED, even when a voice note moved it ──
  await toScript();
  c.rv2OpenSlot(1); c.rv2SlotDraft('Typed for slot one.');
  put('rv2SlotText', { value: '' });
  await c.rv2FillSlot(0, 'Voice for slot zero.', true, ASK0); await tick();
  ok(panel().includes('>Typed for slot one.</textarea>'), 'typed words survive a re-render of the panel');
  c.rv2SlotTyped(); await tick();
  ok(c.rv2Slots(c._rv2.script).length === 0 && c._rv2.script.indexOf('Voice for slot zero.') < c._rv2.script.indexOf('Typed for slot one.'), 'M8 the typed story filled the slot it was opened for');
  // ── #4 panel and sheet are two runs; sheet drafts; closing asks while paid work is on screen ──
  await toScript();
  const remixRun = c._rv2;
  const hold2 = deferred(); route = (u, b) => u === '/api/angles' ? hold2.p : HAPPY()(u, b);
  const sp = c.rv2Start(null, { kind: 'note', text: 'A note' }, { host: 'rv2Sheet', origin: { name: 'note', meta: { id: 'n1' } } }); await tick();
  ok(c._rv2 !== remixRun && c._rv2Runs.rv2Panel === remixRun && remixRun.stage === 'script' && els.rv2Sheet, '#4 starting a sheet keeps the Remix run as it was');
  c.rv2CloseSheet();
  ok(els.rv2Sheet && /Press again to discard/.test(els.rv2Sheet.innerHTML) && c._rv2Runs.rv2Sheet, '#4 closing while it is still working asks first');
  hold2.res({ status: 200, body: { angles: ANGLES } }); await sp; await tick();
  ok(!/Tap again/.test(els.rv2Sheet.innerHTML), 'the question is reset once the sheet changed');
  ok(store.has('rv2_draft_sheet::brand-1') && JSON.parse(store.get('rv2_draft_sheet::brand-1')).origin.name === 'note', '#4 the sheet keeps its own draft');
  vm.runInContext('rv2SetRun("rv2Sheet", null)', c); c.rv2Restore();
  ok(c._rv2Runs.rv2Sheet && c._rv2Runs.rv2Sheet.stage === 'angles' && c._rv2Runs.rv2Sheet.origin.name === 'note' && c._rv2Runs.rv2Panel === remixRun, '#4 after a reload the sheet run comes back from its draft (the Remix run untouched)');
  c.rv2Render();
  ok(els.rv2Sheet && /Develop your note/.test(els.rv2Sheet.innerHTML) && /Use the classic develop instead/.test(els.rv2Sheet.innerHTML), '#4 …with its own title and classic path');
  c.rv2CloseSheet();
  ok(!els.rv2Sheet && c._rv2 === remixRun && !store.has('rv2_draft_sheet::brand-1') && panel().includes('rv2-script'), '#4 closing the sheet brings the Remix script back, untouched');

  // ═══ round 4: saves, drafts and brands ═════════════════════════════════════════════════════
  { // R1 a new Remix cannot replace a run whose idea is being saved; the save's ending belongs to that run
    await toScript(); let rel; c.saveGeneratedIdeas = () => new Promise(r => rel = r);
    const run = c._rv2; const sp = c.rv2Save(); await tick();
    els.remixDescription.value = 'A brand new source text for another remix';
    toasts.length = 0; await c.remixContent(); await tick();
    ok(c._rv2Runs.rv2Panel === run && toasts.some(t => /Saving your script/.test(t)) && callsTo('/api/angles').length === 1, 'R1 starting another Remix while one saves is refused (the saving run stays)');
    rel({ ok: true }); await sp; await tick();
    ok(c._rv2Runs.rv2Panel === null && !store.has('rv2_draft::brand-1') && c.state.length === 1, 'R1 …and the confirmed save clears exactly that run');
    c.saveGeneratedIdeas = function () { c.__saves = (c.__saves || 0) + 1; return Promise.resolve(saveResult); }; }
  { // R1 a failed save of a run that is no longer on screen (sign-out during the save) keeps the script
    await toScript(); let rel; c.saveGeneratedIdeas = () => new Promise(r => rel = r);
    const sp = c.rv2Save(); await tick();
    c.rv2ResetAll();
    rel({ ok: false }); await sp; await tick();
    const d = JSON.parse(store.get('rv2_draft::brand-1') || 'null');
    ok(d && d.stage === 'script' && /post every day/.test(d.script) && toasts.some(t => /it is kept and comes back/.test(t)), 'R1 the script is kept as the Remix draft and it says so');
    c.rv2Restore();
    ok(c._rv2Runs.rv2Panel && c._rv2Runs.rv2Panel.stage === 'script', 'R1 …and comes back');
    c.saveGeneratedIdeas = function () { c.__saves = (c.__saves || 0) + 1; return Promise.resolve(saveResult); }; }
  { // R1 same, but a newer run took the host meanwhile: the old script waits as "recovered", then returns
    await toScript(); let rel; c.saveGeneratedIdeas = () => new Promise(r => rel = r);
    const sp = c.rv2Save(); await tick();
    c.rv2ResetAll(); els.remixDescription.value = 'newer source'; route = HAPPY(); await c.remixContent(); await tick();
    const newer = c._rv2Runs.rv2Panel;
    rel({ ok: false }); await sp; await tick();
    ok(c._rv2Runs.rv2Panel === newer && JSON.parse(store.get('rv2_draft::brand-1')).source.text === 'newer source' && /post every day/.test(JSON.parse(store.get('rv2_draft_recovered::brand-1') || '{}').script || ''), 'R1 the newer run and its draft are untouched; the old script is kept as recovered');
    vm.runInContext('rv2SetRun("rv2Panel", null)', c); store.delete('rv2_draft::brand-1'); c.rv2Restore();
    ok(c._rv2Runs.rv2Panel && /post every day/.test(c._rv2Runs.rv2Panel.script) && !store.has('rv2_draft_recovered::brand-1') && store.has('rv2_draft::brand-1'), 'R1 once the host is free the recovered script comes back (and becomes the draft)');
    c.saveGeneratedIdeas = function () { c.__saves = (c.__saves || 0) + 1; return Promise.resolve(saveResult); }; }
  { // R1 a run cleared by a sign-out during its save: the save's ending leaves a NEWER run alone
    await toScript(); let rel; c.saveGeneratedIdeas = () => new Promise(r => rel = r);
    const sp = c.rv2Save(); await tick();
    c.rv2ResetAll(); els.remixDescription.value = 'newer source two'; route = HAPPY(); await c.remixContent(); await tick();
    const newer = c._rv2Runs.rv2Panel;
    rel({ ok: true }); await sp; await tick();
    ok(newer && c._rv2Runs.rv2Panel === newer && JSON.parse(store.get('rv2_draft::brand-1')).source.text === 'newer source two' && els.remixDescription.value === 'newer source two', 'R1 the old save succeeding does not clear the newer run, its draft or its source');
    c.saveGeneratedIdeas = function () { c.__saves = (c.__saves || 0) + 1; return Promise.resolve(saveResult); }; }
  { // R2 while saving: pick another / edit are no-ops; a story told meanwhile is put in and saved again
    await toScript(); let rel; c.__saves = 0; c.saveGeneratedIdeas = () => { c.__saves++; return new Promise(r => rel = r); };
    const sp = c.rv2Save(); await tick();
    c.rv2BackToAngles(); c.rv2ToggleEdit(); c.rv2EditInput('WIPED');
    ok(c._rv2.stage === 'script' && !c._rv2.editing && /post every day/.test(c._rv2.script), 'R2 "Pick another opinion" and Edit do nothing while it saves');
    await c.rv2FillSlot(0, 'Late story during the save.', false, ASK0); await tick();
    ok(/as soon as the save finishes/.test(panel()) && c.rv2Slots(c._rv2.script).length === 2, 'R2 a story told during the save waits');
    rel({ ok: true }); await tick(); rel({ ok: true }); const saved = await sp; await tick();
    ok(saved && c.state.length === 1 && c.state[0].script.includes('Late story during the save.') && c.__saves === 2 && c._rv2Runs.rv2Panel === null, 'R2 …then goes into the saved idea, which is saved again (one idea, two saves)');
    await toScript(); c.saveGeneratedIdeas = () => new Promise(r => rel = r);
    const sp2 = c.rv2Save(); await tick();
    await c.rv2FillSlot(0, 'Story during a failing save.', false, ASK0);
    rel({ ok: false }); await sp2; await tick();
    ok(c.state.length === 0 && c._rv2.script.includes('Story during a failing save.') && /Couldn.t save it/.test(unent(panel())), 'R2 if that save fails, the story is still in the script');
    c.saveGeneratedIdeas = function () { c.__saves = (c.__saves || 0) + 1; return Promise.resolve(saveResult); }; }
  { // R3 a late answer for brand A never writes into brand B's draft
    reset(); store.set('rv2_draft::brand-2', JSON.stringify({ brandId: 'brand-2', host: 'rv2Panel', origin: { name: 'remix' }, source: { kind: 'remix', text: 'B source' }, stage: 'script', script: 'B PAID SCRIPT', angles: [{ id: 'x', belief: 'b' }], at: Date.now() }));
    const hold = deferred(); route = (u, b) => u === '/api/write' ? hold.p : HAPPY()(u, b);
    await c.remixContent(); await tick(); const pk = c.rv2Pick(0); await tick();
    vm.runInContext('_switchSeq++; currentBrand = { id: "brand-2" }', c);
    hold.res({ status: 200, body: { idea: IDEA } }); await pk; await tick();
    await c.rv2FillSlot(0, 'x', false, ASK0, c._rv2Runs.rv2Panel); await tick();
    const b2 = JSON.parse(store.get('rv2_draft::brand-2')), b1 = JSON.parse(store.get('rv2_draft::brand-1'));
    ok(b2.brandId === 'brand-2' && b2.script === 'B PAID SCRIPT', 'R3 brand B\'s paid script is untouched');
    ok(b1.brandId === 'brand-1' && b1.stage === 'script' && /post every day/.test(b1.script) && b1.script.includes('x'), 'R3 brand A\'s draft got the script (keyed by the run\'s brand)');
    // R4 while brand B is open, brand A's run is not the active one; B's own draft comes back
    ok(c._rv2 === null || c._rv2.brandId === 'brand-2', 'R4 a run of another brand is never the active one');
    c.rv2Restore(); c.rv2Render();
    ok(c._rv2 && c._rv2.brandId === 'brand-2' && c._rv2.script === 'B PAID SCRIPT' && c._rv2Runs.rv2Panel.brandId === 'brand-2', 'R4 brand B\'s own draft is restored on B');
    vm.runInContext('currentBrand = { id: "brand-1" }', c); }
  { // R4 a leftover sheet of another brand never takes the buttons from the panel on screen
    reset(); route = HAPPY();
    vm.runInContext('currentBrand = { id: "brand-2" }', c);
    await c.rv2Start(null, { kind: 'note', text: 'n' }, { host: 'rv2Sheet', origin: { name: 'note', meta: { id: 'x' } } }); await tick();
    vm.runInContext('currentBrand = { id: "brand-1" }', c);
    await c.remixContent(); await tick();
    ok(c._rv2 === c._rv2Runs.rv2Panel && c._rv2.brandId === 'brand-1' && !els.rv2Sheet, 'R4 the panel of the open brand is the active run; the other brand\'s sheet is hidden');
    await c.rv2Pick(0); await tick();
    ok(c._rv2Runs.rv2Panel.stage === 'script', 'R4 and picking on it works');
    c.rv2ResetAll();
    ok(c._rv2 === null && !c._rv2Runs.rv2Panel && !c._rv2Runs.rv2Sheet && panel() === '', 'R4 signing out clears the runs held in memory');
    // the REAL auth listener, with a fake Supabase: sign-out and a different account reset; the same account does not
    const ac = { resets: 0, cb: null, currentUser: { id: 'u1' }, _initAppDone: true, _initAppRunning: false, currentBrand: { id: 'brand-1' }, bvState: { messages: [] },
      console: { log() {}, error() {}, warn() {} }, debugLog() {}, dismissCsSplash() {}, _consumeAuthLinkError() { return false; }, Promise,
      document: { getElementById: () => ({ style: {}, classList: { add() {}, remove() {} }, textContent: '' }), querySelector: () => null },
      sb: { auth: { onAuthStateChange(f) { ac.cb = f; }, getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) } } };
    ac.rv2ResetAll = () => { ac.resets++; };
    vm.createContext(ac); vm.runInContext(grab('startAuthListener'), ac); vm.runInContext('startAuthListener()', ac); await tick();
    ac.cb('TOKEN_REFRESHED', { user: { id: 'u1' } });
    const same = ac.resets;
    ac.cb('SIGNED_IN', { user: { id: 'u2' } });
    const other = ac.resets;
    try { ac.cb('SIGNED_OUT', null); } catch (e) {}
    ok(same === 0 && other === 1 && ac.resets === 2, 'R4 the real auth listener resets the runs on sign-out and on another account, not on a token refresh (' + [same, other, ac.resets] + ')'); }
  // a same-title idea gets a distinct title (the save replaces rows by title)
  reset(); c.state = [{ title: 'Stop posting daily', status: 'pending' }];
  ok(c.rv2BuildIdea({ brandId: 'brand-1', stage: 'script', script: 'x', idea: { title: 'Stop posting daily' }, picked: { belief: 'b' }, source: { text: 't' }, origin: { name: 'remix' } }).idea.title === 'Stop posting daily (2)',
    'a v2 idea whose title already exists is renamed, never overwrites the other');
  // the classic escape hatch
  reset(); c.__classic = 0; route = HAPPY(); await c.remixContent(); await tick(); calls.length = 0;
  await c.rv2Classic();
  ok(c.__classic === 1 && callsTo('/api/angles').length === 0 && c._rv2 === null, '"Use the classic remix instead" runs the old /api/remix path');
  vm.runInContext('currentRemixMode = "series"', c); await c.remixContent();
  ok(c.__classic === 2 && callsTo('/api/angles').length === 0, 'the other modes (Series etc.) stay on the classic path');

  // ═══ B. errors, said honestly ═══════════════════════════════════════════════════════════════
  reset();
  const PAUSED = 'The AI writer is paused on our side right now. Please try again later.';
  route = (u) => u === '/api/angles' ? { status: 503, body: { error: PAUSED, code: 'AI_UNAVAILABLE' } } : { status: 404, body: {} };
  await c.remixContent(); await tick(30);
  ok(panel().includes(PAUSED) && !panel().includes('rv2RetryBtn'), 'AI_UNAVAILABLE shows the server\'s own words and offers no pointless retry');
  ok(callsTo('/api/angles').length === 1, 'and it is NOT retried in a loop (1 call)');
  reset();
  route = (u) => u === '/api/angles' ? { status: 424, body: { error: 'brand_context_unavailable' } } : { status: 404, body: {} };
  await c.remixContent(); await tick();
  ok(/Your brand brain wasn.t ready/.test(unent(panel())), '424 is said in words');
  ok(!panel().includes('brand_context_unavailable') && panel().includes('rv2RetryBtn'), 'never the raw code, and a manual Try again is offered');
  reset();
  route = (u) => u === '/api/angles' ? { status: 424, body: {} } : { status: 404, body: {} };
  await c.remixContent(); await tick();
  ok(/Your brand brain wasn.t ready/.test(unent(panel())), 'a bare 424 (no body) is still said as the brand brain not being ready');
  route = (u) => u === '/api/angles' ? { status: 200, body: { angles: ANGLES.slice(0, 5) } } : { status: 404, body: {} };
  await c.rv2Retry(); await tick();
  ok(callsTo('/api/angles').length === 2 && c._rv2.stage === 'angles' && J(callsTo('/api/angles')[1].body.source) === J(callsTo('/api/angles')[0].body.source), 'Try again re-asks with the same source and recovers');
  route = (u) => u === '/api/write' ? { status: 503, body: { error: PAUSED, code: 'AI_UNAVAILABLE' } } : { status: 200, body: {} };
  await c.rv2Pick(2); await tick();
  ok(c._rv2.stage === 'angles' && panel().includes(PAUSED) && (panel().match(/class="rv2-angle[ "]/g) || []).length === 5 && callsTo('/api/write').length === 1,
    'a write failure keeps the opinions on screen with the reason, one call');
  route = (u) => u === '/api/write' ? { status: 502, body: { error: 'That came back cut off — try again' } } : { status: 200, body: {} };
  await c.rv2Pick(2); await tick();
  ok(c._rv2.stage === 'angles' && panel().includes('That came back cut off — try again'), 'a cut-off write (502) is said as such');
  reset();
  route = () => new TypeError('Failed to fetch');
  await c.remixContent(); await tick();
  ok(/connection dropped/.test(panel()), 'a dropped connection is named as the connection');
  await toScript({ story: () => ({ status: 503, body: { code: 'memory_not_ready', error: 'Brand memory is not set up yet.' } }) });
  await c.rv2FillSlot(0, 'The week we lost half our views.', false); await tick();
  ok(c._rv2.stage === 'script' && c._rv2.script.includes('The week we lost half our views.') && c.rv2Slots(c._rv2.script).length === 1, '503 memory_not_ready: the story is still in the script');
  ok(/story bank isn.t ready yet/.test(unent(panel())), 'and the person is told it was not kept for later');
  await toScript({ story: () => ({ status: 409, body: { code: 'memory_full', max: 30 } }) });
  await c.rv2FillSlot(0, 'The week we lost half our views.', false); await tick();
  ok(/story bank is full/.test(panel()), 'a full story bank is said plainly');
  await toScript({ story: () => ({ status: 503, body: { code: 'memory_write_unknown', error: 'x' } }) });
  await c.rv2FillSlot(0, 'Unknown outcome story.', false); await tick();
  ok(/couldn.t confirm it was kept in your story bank/.test(unent(panel())) && !/couldn.t be kept/.test(unent(panel())), 'r7 503 memory_write_unknown is said honestly (not confirmed), not as a failure');
  { const before = c._rv2.script;
    ok((await c.rv2FillSlot(5, 'x', false, 'no such slot')) === false && c._rv2.script === before, 'a fill for a slot that no longer exists is refused and changes nothing'); }
  ok(toasts.some(t => /already filled/.test(t)), 'with a plain message');
  route = (u) => u === '/api/write' ? { status: 200, body: { idea: { script: '   ' } } } : { status: 200, body: {} };
  c.rv2BackToAngles(); await c.rv2Pick(1); await tick();
  ok(c._rv2.stage === 'angles' && /came back empty/.test(panel()), 'an empty script is refused, the opinions stay');
  reset(); route = (u) => u === '/api/angles' ? { status: 200, body: { angles: [{ belief: '  ' }, {}] } } : { status: 200, body: {} };
  await c.remixContent(); await tick();
  ok(c._rv2.stage === 'error' && /without any opinions/.test(panel()), 'an answer with no usable belief is an error, not an empty list');
  reset(); els.remixDescription.value = ''; await c.remixContent(); await tick();
  ok(callsTo('/api/angles').length === 0 && toasts.some(t => /needs the words/.test(t)), 'no source text → no call, and says why');
  // belief memory full on save
  await toScript({ belief: () => ({ status: 409, body: { code: 'memory_full', max: 20 } }) });
  await c.rv2FillSlot(0, 'a', false); await c.rv2FillSlot(0, 'b', false);
  await c.rv2Save(); await tick();
  ok(c.state.length === 1 && toasts.some(t => /opinions list is full/.test(t)), 'a belief not kept because the list is full is said');

  // ═══ C. tones ═══════════════════════════════════════════════════════════════════════════════
  c.settings.tones = ['bold', 'witty', 'calm']; toasts.length = 0;
  c.toggleTone('expert');
  ok(J(c.settings.tones) === J(['bold', 'witty', 'calm']) && toasts.some(t => /Pick up to 3/.test(t)), 'a 4th tone is refused, with the reason');
  c.toggleTone('calm'); c.toggleTone('expert');
  ok(J(c.settings.tones) === J(['bold', 'witty', 'expert']), 'untick one, and another can be picked (still max 3)');
  ok(!/vague/.test(c.toneNudgeHtml()) && /3 of 3 picked/.test(c.toneNudgeHtml()), 'at 3 tones: no nudge');
  c.settings.tones = ['a', 'b', 'c', 'd', 'e'];
  ok(/Pick up to 3 — more makes the voice vague/.test(c.toneNudgeHtml()) && /untick 2/.test(c.toneNudgeHtml()), 'a brand that already has 5 tones sees the nudge');
  const sp2 = grab('renderSettingsPanel');
  ok(sp2.includes('${toneNudgeHtml()}') && sp2.includes('bmSectionHtml()') && sp2.includes('clEntryHtml()') && sp2.includes('rv2MetricsHtml()'), 'the settings panel renders the nudge, the memory lists, the metrics and the Lab entry');
  ok(/obSelectedTones\.length < 3\) obSelectedTones\.push/.test(grab('obToggleTone')), 'onboarding also stops at 3 tones');

  // ═══ D. Content Lab — against the REAL api/blind-test.js ════════════════════════════════════
  await labSection();

  // ═══ E. filmed rate ═════════════════════════════════════════════════════════════════════════
  reset(); c._rv2Metrics = { brandId: null, at: 0, html: '' }; put('rv2Metrics');
  route = (u) => u === '/api/content-metrics' ? { status: 200, body: { flows: [{ flow: 'v1', generated: 40, filmed: 6, rate: 0.15 }, { flow: 'v2', generated: 10, filmed: 4, rate: 0.4 }, { flow: 'v2-batch', generated: 8, filmed: 2 }], since: '2026-09-26' } } : { status: 404, body: {} };
  c.rv2MetricsHtml(); await tick();
  ok(els.rv2Metrics.innerHTML.includes('Filmed: new flow 4 of 10 (40%) · batch with beliefs 2 of 8 (25%) · old flow 6 of 40 (15%)'), 'metrics text shows the opinion-first panel, the belief-first batch and the old flow apart');
  ok(callsTo('/api/content-metrics')[0].body.brandId === 'brand-1', 'asked for this brand');
  reset(); c._rv2Metrics = { brandId: null, at: 0, html: '' }; put('rv2Metrics', { innerHTML: 'stale' });
  route = () => ({ status: 500, body: { error: 'x' } });
  c.rv2MetricsHtml(); await tick();
  ok(els.rv2Metrics.innerHTML === '', 'on error the card is hidden');

  // ═══ F. beliefs + story bank + speech samples ═══════════════════════════════════════════════
  reset(); c.bmInvalidate(); put('bmLists');
  let delAnswer = () => ({ status: 200, body: { ok: true } });
  route = (u, b) => {
    if (u !== '/api/brand-memory') return { status: 404, body: {} };
    if (b.action === 'list' && b.kind === 'belief') return { status: 200, body: { items: [{ id: 'b"1', kind: 'belief', text: 'Belief ' + XSS, tags: [] }, { id: 'b2', kind: 'belief', text: 'Second belief', tags: [] }] } };
    if (b.action === 'list' && b.kind === 'story') return { status: 200, body: { items: [{ id: 's1', kind: 'story', text: 'Story ' + XSS, tags: ['the day ' + XSS] }] } };
    if (b.action === 'list' && b.kind === 'speech') return { status: 200, body: { items: [{ id: 'sp1', kind: 'speech', text: 'So basically ' + XSS, tags: [] }, { id: 'sp2', kind: 'speech', text: 'Another sample', tags: [] }] } };
    if (b.action === 'delete') return delAnswer(b);
    return { status: 400, body: {} };
  };
  c.bmSectionHtml(); await tick();
  const bh = els.bmLists.innerHTML;
  ok(/Your opinions/.test(bh) && /Your story bank/.test(bh) && /Your speech samples/.test(bh) && bh.includes('Belief &lt;img') && bh.includes('Story &lt;img') && bh.includes('So basically &lt;img') && !bh.includes(XSS), 'G4 opinions, stories and speech samples list, escaped');
  ok(bh.includes('data-id="b&quot;1"') && !bh.includes('data-id="b"1"'), 'G5 an id with a quote cannot break out of its attribute');
  delAnswer = () => ({ status: 500, body: { error: 'x' } });
  await c.bmDelete(mk('x', { attrs: { 'data-kind': 'belief', 'data-id': 'b2' } })); await tick();
  ok(els.bmLists.innerHTML.includes('Second belief') && toasts.some(t => /Couldn't delete that/.test(t)), 'M7 a failed delete keeps the row on screen and says so');
  { delAnswer = () => ({ status: 503, body: { code: 'memory_write_unknown', error: 'x' } }); toasts.length = 0;
    const lists = callsTo('/api/brand-memory', 'list').length;
    await c.bmDelete(mk('x', { attrs: { 'data-kind': 'belief', 'data-id': 'b2' } })); await tick(20);
    ok(toasts.some(t => /Couldn't confirm it was deleted/.test(t)) && callsTo('/api/brand-memory', 'list').length === lists + 3, 'r7 a delete with an unknown outcome says so and reloads the list instead of guessing'); }
  delAnswer = () => ({ status: 403, body: { code: 'owner_only', error: 'x' } });
  await c.bmDelete(mk('x', { attrs: { 'data-kind': 'belief', 'data-id': 'b2' } })); await tick();
  ok(els.bmLists.innerHTML.includes('Second belief') && toasts.some(t => /Only the brand owner can delete this one/.test(t)), 'owner_only is said as such');
  delAnswer = () => ({ status: 200, body: { ok: true } });
  await c.bmDelete(mk('x', { attrs: { 'data-kind': 'belief', 'data-id': unent('b&quot;1') } })); await tick();
  const del = callsTo('/api/brand-memory', 'delete').filter(x => x.body.id === 'b"1');
  ok(del.length === 1 && del[0].body.kind === 'belief' && !els.bmLists.innerHTML.includes('Belief &lt;img'), 'delete sends the id and removes the row once the server confirms');
  await c.bmDelete(mk('x', { attrs: { 'data-kind': 'speech', 'data-id': 'sp1' } })); await tick();
  ok(!els.bmLists.innerHTML.includes('So basically') && els.bmLists.innerHTML.includes('Another sample'), 'a speech sample can be deleted from the list');
  ok(!/Voice learning is off/.test(els.bmLists.innerHTML), 'with voice learning on there is no "delete all"');
  c.settings.voiceLearn = false; c.bmPaint();
  ok(/Voice learning is off — delete the 1 saved sample/.test(els.bmLists.innerHTML), 'with voice learning off it offers to delete the saved samples');
  await c.bmDeleteAllSpeech(mk('x')); await tick();
  ok(!els.bmLists.innerHTML.includes('Another sample') && toasts.some(t => /Saved speech samples deleted/.test(t)), 'and does it');
  c.settings.voiceLearn = true;
  c.bmSectionHtml(); await tick();
  ok(callsTo('/api/brand-memory', 'list').length === 6, 'loaded once per brand (plus the one reload after an unknown delete), not on every settings repaint');
  reset(); c.bmInvalidate(); put('bmLists');
  route = () => ({ status: 503, body: { code: 'memory_not_ready', error: 'Brand memory is not set up yet.' } });
  c.bmSectionHtml(); await tick();
  ok(/aren't available yet/.test(unent(els.bmLists.innerHTML)), '503 → said plainly');

  // ═══ H. real speech → kind 'speech'; forget deletes the server copy ═════════════════════════
  reset(); let speechDel = () => ({ status: 200, body: { ok: true } });
  route = (u, b) => (u === '/api/brand-memory' && b.action === 'delete') ? speechDel(b) : { status: 200, body: { item: { id: 'mem-' + calls.length } } };
  const LONG = Array.from({ length: 35 }, (_, i) => 'word' + i).join(' ');
  c.settings.voiceLog = []; c.settings.voiceLearn = true;
  c.voiceLogAdd(LONG, 'notebook', () => true); await tick();
  let sp1 = callsTo('/api/brand-memory', 'add').filter(x => x.body.kind === 'speech');
  ok(sp1.length === 1 && sp1[0].body.text === LONG && sp1[0].body.brandId === 'brand-1', 'a kept voice note is also sent as a speech sample');
  ok(/^mem-/.test(c.settings.voiceLog[0].memId || ''), '#5 the saved copy\'s id is kept with the note');
  const memId = c.settings.voiceLog[0].memId;
  c.voiceLogRemove(0); await tick();
  const sd = callsTo('/api/brand-memory', 'delete');
  ok(c.settings.voiceLog.length === 0 && sd.length === 1 && sd[0].body.kind === 'speech' && sd[0].body.id === memId, '#5 "Forget this one" deletes the server copy too');
  c.voiceLogAdd(LONG + ' again', 'coach', () => true); await tick();
  speechDel = () => ({ status: 500, body: {} }); toasts.length = 0;
  c.voiceLogRemove(0); await tick();
  ok(toasts.some(t => /saved copy couldn't be deleted/.test(t)), '#5 if the server copy could not be deleted, it says where to delete it');
  c.voiceLogAdd(LONG, 'coach', () => false); c.settings.voiceLearn = false; c.voiceLogAdd(LONG, 'coach', () => true); c.settings.voiceLearn = true;
  c.voiceLogAdd('too short to count', 'coach', () => true);
  ok(c.rv2SendSpeech('only a handful of words here', () => true) === false, 'rv2SendSpeech refuses a handful of words (not a speech sample)');
  await tick();
  ok(callsTo('/api/brand-memory', 'add').filter(x => x.body.kind === 'speech').length === 2, 'not after a brand switch, not with voice learning off, not for a few words');
  route = (u) => u === '/api/transcribe-voice' ? { status: 200, body: { text: 'So basically what annoys me is that everyone sells this like it is magic and it is not magic at all.' } } : { status: 200, body: { item: { id: 'x' } } };
  put('spVoiceSample'); await c.dictateInto('spVoiceSample', mk('m'), 'Talking'); c._dictRec.stop(); await tick(30);
  ok(callsTo('/api/brand-memory', 'add').filter(x => x.body.kind === 'speech').length === 3 && timers.includes(60000), 'the "How you actually talk" recording is sent as a speech sample (and keeps its 60 s cap)');
  put('remixDescription'); await c.dictateInto('remixDescription', mk('m'), 'x'); c._dictRec.stop(); await tick(30);
  ok(callsTo('/api/brand-memory', 'add').filter(x => x.body.kind === 'speech').length === 3 && els.remixDescription.value.startsWith('So basically'), 'a short Remix dictation fills its box and is not sent (under 30 words)');
  route = (u) => u === '/api/transcribe-voice' ? { status: 503, body: { error: 'Transcription is paused right now.' } } : { status: 200, body: {} };
  toasts.length = 0; await c.dictateInto('remixDescription', mk('m'), 'x'); c._dictRec.stop(); await tick(30);
  ok(toasts.includes('Transcription is paused right now.'), 'a failed transcription says the server\'s reason');
  { // mic start that never answers (permission prompt left open): 15 s later the mic works again
    const g = deferred(); micGate = g.p; recorders = 0; let ends = 0; timerFns.length = 0; toasts.length = 0;
    const a1 = c.dictateInto(null, mk('m'), 'x', { onEnd: () => ends++ }); await tick();
    ok(c._dictStarting === true, 'the mic is starting');
    timerFns.filter(t => t.ms === 15000).forEach(t => t.fn());
    ok(c._dictStarting === false && ends === 1 && toasts.some(t => /microphone didn.t start/.test(t)), 'LOW an unanswered start is timed out: said, and the caller is told it is over');
    g.res(); await a1; await tick();
    ok(recorders === 0 && !c._dictRec, 'LOW a mic that answers after the timeout is closed, not recorded');
    micGate = null; route = () => ({ status: 200, body: {} });
    await c.dictateInto(null, mk('m'), 'x', {}); await tick();
    ok(recorders === 1 && c._dictRec, 'LOW the next tap records normally'); c._dictRec.stop(); await tick(20); }
  { // N10 a refused microphone does not leave the mic "starting" forever
    const realGet = c.getMicStream; c.getMicStream = async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); };
    let ends = 0; await c.dictateInto(null, mk('m'), 'x', { onEnd: () => ends++ }); await tick();
    ok(c._dictStarting === false && ends === 1, 'N10 a refused microphone resets the start and tells the caller');
    c.getMicStream = realGet; recorders = 0; await c.dictateInto(null, mk('m'), 'x', {}); await tick();
    ok(recorders === 1, 'N10 …so the next tap works'); c._dictRec.stop(); await tick(20); }
  { // N13 "Too short" also ends the recording for the caller
    let ends = 0; smallBlob = true; await c.dictateInto(null, mk('m'), 'x', { onEnd: () => ends++ }); c._dictRec.stop(); await tick(20); smallBlob = false;
    ok(ends === 1 && toasts.some(t => /Too short/.test(t)), 'N13 a too-short recording tells the caller it is over'); }
  { // the "How you actually talk" recording sends no speech sample with voice learning off
    route = (u) => u === '/api/transcribe-voice' ? { status: 200, body: { text: 'So basically what annoys me is that everyone sells this like it is magic and it is not magic at all.' } } : { status: 200, body: { item: { id: 'x' } } };
    const before = callsTo('/api/brand-memory', 'add').filter(x => x.body.kind === 'speech').length;
    c.settings.voiceLearn = false; put('spVoiceSample'); await c.dictateInto('spVoiceSample', mk('m'), 'Talking'); c._dictRec.stop(); await tick(30); c.settings.voiceLearn = true;
    ok(callsTo('/api/brand-memory', 'add').filter(x => x.body.kind === 'speech').length === before && els.spVoiceSample.value.startsWith('So basically'), 'LOW voice learning off: the recording fills the box but is not sent as a sample'); }
  { // forgetting a note before its server copy was saved deletes that copy when it arrives
    const hold = deferred(); route = (u, b) => (u === '/api/brand-memory' && b.action === 'add') ? hold.p : { status: 200, body: { ok: true } };
    c.settings.voiceLog = []; const LONG2 = Array.from({ length: 35 }, (_, i) => 'late' + i).join(' ');
    c.voiceLogAdd(LONG2, 'notebook', () => true); await tick();
    c.voiceLogRemove(0); await tick();
    hold.res({ status: 200, body: { item: { id: 'mem-late' } } }); await tick(20);
    const dl = callsTo('/api/brand-memory', 'delete').filter(x => x.body.id === 'mem-late');
    ok(c.settings.voiceLog.length === 0 && dl.length === 1 && dl[0].body.kind === 'speech', 'LOW a note forgotten before its copy was saved: the copy is deleted when it arrives'); }
  { // #7 the shared mic: a second tap while the mic is still opening starts nothing
    const g = deferred(); micGate = g.p; recorders = 0; c.__mics = 0; let ends = 0;
    const a1 = c.dictateInto(null, mk('m'), 'x', { onEnd: () => ends++ }); const a2 = c.dictateInto(null, mk('m'), 'x', { onEnd: () => ends++ });
    g.res(); await a1; await a2; await tick();
    ok(recorders === 1 && c.__mics === 1, '#7 dictateInto: a second tap while opening the mic does not start a second recorder');
    micGate = null; route = () => ({ status: 200, body: {} }); c._dictRec.stop(); await tick(30);
    ok(ends === 1, '#7 and the caller is told once when it is over (nothing heard)'); }

  if (fail) { console.log('\n' + fail + ' check(s) failed'); process.exit(1); }
  finished = true;
  console.log('\nUI V2 OK');
})().catch(e => { console.log('FAIL: gate crashed: ' + (e && e.stack || e)); process.exit(1); });

// ── D: the Lab screen against the real api/blind-test.js (store, auth, brand, LLM stubbed) ──────
async function labSection() {
  const clone = x => JSON.parse(JSON.stringify(x));
  const db = { rows: [] }; let nid = 1;
  const qs = (p) => { const q = {}; const i = p.indexOf('?'); if (i < 0) return q; for (const kv of p.slice(i + 1).split('&')) { const j = kv.indexOf('='); q[decodeURIComponent(kv.slice(0, j))] = decodeURIComponent(kv.slice(j + 1)); } return q; };
  const fakeStore = {
    async userCanAccessBrand(uid, bid) { return bid === 'brand-1'; },
    async rest(method, p, opts = {}) {
      const body = opts.body;
      if (p === '/rpc/blind_test_set_cell') {
        const row = db.rows.find(r => r.id === body.p_id); if (!row) return { status: 200, data: null };
        if (body.p_claim === true) {
          const cc = row.cells[body.p_index]; if (!cc) return { status: 200, data: null };
          const st = cc.status || 'pending';
          if (!(st === 'pending' || st === 'error' || (body.p_force && st === 'done') || (st === 'running' && (cc.startedAt || 0) < Date.now() - 330000))) return { status: 200, data: null };
          Object.assign(cc, { status: 'running', startedAt: Date.now() }); return { status: 200, data: true };
        }
        row.cells[body.p_index] = clone(body.p_cell); return { status: 200, data: true };
      }
      // the database steps of sql/blind-tests.sql, as the handler relies on them: guarded by the generation
      const gen = (row) => Number(row.generation) || 0;
      if (p === '/rpc/blind_test_set_pick') { const row = db.rows.find(r => r.id === body.p_id); if (!row || body.p_generation !== gen(row)) return { status: 200, data: null }; row.picks = row.picks || {}; row.picks[String(body.p_input)] = body.p_label; return { status: 200, data: true }; }
      if (p === '/rpc/blind_test_reset') { const row = db.rows.find(r => r.id === body.p_id); if (!row || body.p_generation !== gen(row) || J(row.cells) !== J(body.p_old_cells)) return { status: 200, data: null };
        row.cells = clone(body.p_new_cells); row.picks = {}; row.revealed_at = null; row.generation = gen(row) + 1; return { status: 200, data: row.generation }; }
      if (p === '/rpc/blind_test_reveal') { const row = db.rows.find(r => r.id === body.p_id); if (!row || body.p_generation !== gen(row)) return { status: 200, data: null }; row.revealed_at = new Date().toISOString(); return { status: 200, data: true }; }
      const table = p.slice(1).split('?')[0], q = qs(p);
      if (table === 'blind_tests') {
        if (method === 'POST') { const row = Object.assign({ id: 'bt-' + (nid++), created_at: new Date().toISOString() }, clone(body)); db.rows.push(row); return { status: 201, data: [clone(row)] }; }
        let rows = db.rows; if (q.id) rows = rows.filter(r => 'eq.' + r.id === q.id); if (q.created_by) rows = rows.filter(r => 'eq.' + r.created_by === q.created_by);
        if (method === 'GET') return { status: 200, data: clone(rows) };
        if (method === 'PATCH') { for (const r of rows) Object.assign(r, clone(body)); return { status: 200, data: clone(rows) }; }
      }
      return { status: 500, data: { message: 'fake: unhandled ' + method + ' ' + p } };
    },
  };
  let grokFails = 1, claudeOn = true;
  const STUBS = {
    './_publish/store': fakeStore,
    './_requireUser': async (req) => ({ id: 'owner' }),
    './_brandctx': { loadBrandContext: async () => ({ ok: true, bc: { brandName: 'T' } }) },
    './remix': { _legacyRemix: async () => ({ remixTitle: 'Old title', remixHook: 'OLD HOOK', remixScript: 'old script body ' + XSS, remixCaption: 'old caption' }) },
    './_llm': { claudeConfigured: () => claudeOn, withThinkingHeadroom: (fn) => fn(), CLAUDE_DEFAULT_MODEL: 'claude-x', callLLM: async () => '' },
    './_write': {
      runAngles: async () => ({ angles: [{ id: 'a1', belief: 'FIRST-BELIEF', why: 'w' }] }),
      runWrite: async (a) => { if (a.provider === 'claude') { const e = new Error('Claude refused'); e.code = 'AI_UNAVAILABLE'; throw e; }
        if (a.provider === 'grok' && grokFails > 0) { grokFails--; throw new Error('the writer timed out'); }
        return { idea: { title: 'New ' + a.provider, hook: 'NEW HOOK', script: 'I think ' + a.angle.belief + ' [your story: the day it broke]', caption: 'new caption' } }; },
    },
  };
  const origLoad = Module._load;
  Module._load = function (request, parent) {
    if (parent && parent.filename && path.dirname(parent.filename) === API && Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
    return origLoad.apply(this, arguments);
  };
  process.env.CONTENT_LAB_USER_IDS = 'owner';
  const handler = require_(path.join(API, 'blind-test.js'));   // the stub loader stays on: the handler requires lazily
  const quiet = async (fn) => { const l = console.log, e = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = l; console.error = e; } };
  const callHandler = async (body, allowed) => {
    if (!allowed) return { status: 403, body: { error: 'The Content Lab is not enabled for this account.', code: 'not_allowed' } };
    const out = { status: 200, body: null };
    const res = { statusCode: 200, setHeader() {}, status(x) { out.status = x; return this; }, json(b) { out.body = b; return b; }, end() { return this; } };
    await quiet(() => handler({ method: 'POST', headers: { authorization: 'Bearer owner' }, body }, res));
    return out;
  };
  let hookBefore = null, failIf = null, respHook = null, createHook = null;
  const labRoute = (allowed) => async (u, b) => {
    if (u !== '/api/blind-test') return { status: 404, body: {} };
    if (hookBefore) await hookBefore(b);
    if (failIf && failIf(b)) return { status: 503, body: { error: 'Could not start this cell — try again.' } };
    if (createHook && b.action === 'create') { const x = createHook(b); if (x) return x; }
    const out = await callHandler(clone(b), allowed);
    return respHook ? respHook(b, out) : out;
  };
  reset(); route = labRoute(false);
  c._cl.probed = false; c._cl.allowed = false; put('clEntry');
  const e0 = c.clEntryHtml(); await tick();
  ok(e0 === '<div id="clEntry"></div>' && els.clEntry.innerHTML === '' && callsTo('/api/blind-test', 'list').length === 1, 'D 403 → the Lab entry renders nothing at all');
  c.clEntryHtml(); c.clOpen(); await tick();
  ok(callsTo('/api/blind-test', 'list').length === 1 && !els.clOverlay, 'D probed once only, and it cannot be opened');
  reset(); route = labRoute(true); c._cl.probed = false; c.clNew();
  put('clEntry'); c.clEntryHtml(); await tick();
  ok(/Content Lab/.test(els.clEntry.innerHTML), 'D allowed → the Lab entry appears');
  c.clOpen();
  ok(els.clOverlay && (els.clOverlay.innerHTML.match(/id="clText\d"/g) || []).length === 5, 'D the Lab takes up to 5 inputs');
  put('clText0', { value: 'first input' }); put('clKind0', { value: 'idea' }); put('clText1', { value: 'second ' + XSS }); put('clKind1', { value: 'note' });
  { let once = true; failIf = (b) => b.action === 'runCell' && b.index === 2 && once && !(once = false); }
  // r6: the cells run in a random order — pinned here (Math.random → 0) so the order is known
  const realMath = c.Math; c.Math = Object.assign(Object.create(Math), { random: () => 0 });
  let firstScreen = '';
  hookBefore = async (b) => { if (b.action === 'runCell' && !firstScreen) firstScreen = els.clOverlay.innerHTML; };
  await c.clCreate(); await tick(40);
  hookBefore = null;
  ok(/Writing — 0 of 6 finished/.test(firstScreen) && !/data-index|Output \d|[ABC] is being/.test(firstScreen), 'r6 the screen counts finished outputs only — no letter, no step being written');
  ok(c._cl.paused && c._cl.paused.index === 2 && J(callsTo('/api/blind-test', 'runCell').map(x => x.body.index)) === J([1, 2]), 'r6 cells run in a shuffled order (not letter order), and a cell the server could not start stops the run there');
  ok(els.clOverlay.innerHTML.includes('One output failed: Could not start this cell') && !/Output \d/.test(els.clOverlay.innerHTML) && /clRetry\(\)/.test(els.clOverlay.innerHTML) && /clSkip\(\)/.test(els.clOverlay.innerHTML), 'D said in the server\'s words (without saying which one), with Retry and Skip');
  c.clRetry(); await tick(60); failIf = null; c.Math = realMath;
  const row = db.rows[0];
  const cr = callsTo('/api/blind-test', 'create');
  ok(cr.length === 1 && cr[0].body.brandId === 'brand-1' && row && row.inputs.length === 2, 'D create sends the brand and the non-empty inputs to the real handler');
  const runs = callsTo('/api/blind-test', 'runCell');
  ok(J(runs.map(x => x.body.index)) === J([1, 2, 2, 3, 4, 5, 0]) && runs.every(x => !x.body.force), 'D Retry runs that cell again and the rest, one by one, reshuffled, without force (' + J(runs.map(x => x.body.index)) + ')');
  ok(c._cl.stage === 'judge', 'D then the outputs load');
  const jh = els.clOverlay.innerHTML;
  ok(!/baseline|grok-high|claude|Claude|Grok|Old flow|New flow/.test(jh), 'D no arm name on screen before reveal');
  ok(/rv2-lab-label">A/.test(jh) && /rv2-lab-label">B/.test(jh) && /rv2-lab-label">C/.test(jh), 'D outputs shown under A / B / C');
  ok(jh.includes('I think FIRST-BELIEF …') && !jh.includes('[story]') && !jh.includes('[your story') && jh.includes('old script body &lt;img') && !jh.includes(XSS), 'D slots appear as … before reveal, text escaped');
  ok((jh.match(/Not available for this one\./g) || []).length === 3, 'D the failed Grok cell and the Claude cells (refused) show as not available (' + (jh.match(/Not available/g) || []).length + ')');
  // re-run the failed Grok cell with force
  const grokCell = row.cells.find(x => x.arm === 'grok-high' && x.status === 'error');
  ok(!!grokCell && new RegExp('data-index="' + grokCell.index + '" onclick="clRerun').test(jh), 'D an error cell has a Re-run button');
  await c.clRerun(mk('b', { attrs: { 'data-index': String(grokCell.index) } })); await tick(20);
  const rr = callsTo('/api/blind-test', 'runCell').slice(-1)[0];
  ok(rr.body.index === grokCell.index && rr.body.force === true && row.cells[grokCell.index].status === 'done' && (els.clOverlay.innerHTML.match(/Not available/g) || []).length === 2, 'D Re-run sends force:true and the output appears');
  // already_done / already_running from the real handler are handled
  { const saved = c._cl.cells.map(x => x.status); c._cl.cells.forEach(x => { x.status = 'pending'; }); c._cl.stage = 'running';
    row.cells[5].status = 'running'; row.cells[5].startedAt = Date.now();
    await c.clRunAll(); await tick(20);
    const st = c._cl.cells.map(x => x.status);
    ok(st.filter(x => x === 'done').length === 5 && st[5] === 'elsewhere' && !c._cl.paused && c._cl.stage === 'judge', 'D 409 already_done counts as done, already_running as "being written elsewhere" — no crash, no pause (' + J(st) + ')');
    ok(!/data-ii="1" data-label/.test(els.clOverlay.innerHTML) && /Still writing — 2 of 3 finished/.test(els.clOverlay.innerHTML), 'D an input with a cell still running shows progress and no pick buttons (progress[i].ready)');
    row.cells[5].status = 'done'; row.cells[5].text = 'late text'; await c.clShowResults(); await tick();
    ok(/data-ii="1" data-label="/.test(els.clOverlay.innerHTML), 'D "Check again" shows it once ready'); c._cl.cells.forEach((x, i) => { x.status = saved[i] || 'done'; }); }
  // picks
  const lab = (ii) => row.cells.filter(x => x.inputIndex === ii && x.status === 'done')[0].label;
  let L0 = lab(0); const L1 = lab(1);
  await c.clPick(mk('b', { attrs: { 'data-ii': '0', 'data-label': L0 } })); await tick();
  ok(/disabled>Pick one for every input/.test(els.clOverlay.innerHTML), 'D reveal is locked until every input has a pick');
  ok(/data-ii="1" data-label="none"/.test(els.clOverlay.innerHTML), 'D "None of these are good" is offered per input');
  await c.clPick(mk('b', { attrs: { 'data-ii': '1', 'data-label': L1 } })); await tick();
  const pk = callsTo('/api/blind-test', 'pick');
  ok(pk.every(x => x.body.generation === 0), 'r6 each pick carries the generation of the letters it saw');
  ok(pk.length === 2 && J(pk.map(x => [x.body.inputIndex, x.body.label])) === J([[0, L0], [1, L1]]) && J(row.picks) === J({ 0: L0, 1: L1 }), 'D picks are sent and stored');
  await c.clShowResults(); await tick();
  ok(c._cl.stage === 'judge' && !c._cl.reveal && !/Old flow|New flow|baseline|grok-high/.test(els.clOverlay.innerHTML), 'D every input picked (complete) still reveals nothing — only the explicit reveal does');
  await c.clPick(mk('b', { attrs: { 'data-ii': '0', 'data-label': L0 } })); await tick();
  ok(c._cl.final && /picks are final/.test(els.clOverlay.innerHTML) && /clResetPicks\(this\)/.test(els.clOverlay.innerHTML), 'D a pick after all picks (409 picks_final) says so and offers Reset');
  { // a reset while a cell is being written is refused (409 cells_running) and said
    const keep = Object.assign({}, row.cells[0]); row.cells[0].status = 'running'; row.cells[0].startedAt = Date.now();
    await c.clResetPicks(mk('b')); await tick(20);
    ok(/still working on this test/.test(els.clOverlay.innerHTML) && c._cl.final, 'D reset while a writer works (409 cells_running) is said, nothing changes');
    row.cells[0] = keep; }
  c._cl.cells.forEach(x => { x.label = 'STALE'; });   // whatever mapping was cached before the reshuffle must go
  await c.clResetPicks(mk('b')); await tick(20);
  ok(!c._cl.final && J(row.picks) === '{}' && J(c._cl.picks) === '{}' && callsTo('/api/blind-test', 'reset').length === 2, 'D Reset clears the picks on the server and here');
  ok(J(c._cl.cells.map(x => [x.index, x.label])) === J(row.cells.map(x => [x.index, x.label])) && J(c._cl.view.cells.map(x => [x.index, x.inputIndex, x.label])) === J(row.cells.map(x => [x.index, x.inputIndex, x.label])),
    'D after the reshuffle the screen uses the NEW index → label mapping, not the cached one');
  const L0b = lab(0);
  await c.clPick(mk('b', { attrs: { 'data-ii': '0', 'data-label': L0b } })); await c.clPick(mk('b', { attrs: { 'data-ii': '1', 'data-label': 'none' } })); await tick();
  ok(J(row.picks) === J({ 0: L0b, 1: 'none' }), 'D picks after the reset use the reshuffled labels');
  await c.clReveal(mk('rb')); await tick(20);
  await c.clShowResults(); await tick();
  ok(c._cl.stage === 'revealed' && !!row.revealed_at, 'D after the explicit reveal the server says revealed, and reloading keeps it revealed');
  const rh = els.clOverlay.innerHTML;
  L0 = L0b;
  const arm0 = row.cells.find(x => x.inputIndex === 0 && x.label === L0).arm;
  const NAMES = { baseline: 'Old flow', 'grok-high': 'New flow · Grok', claude: 'New flow · Claude' };
  ok(c._cl.stage === 'revealed' && rh.includes('You picked ' + L0 + ' — ' + NAMES[arm0]) && /You picked none of them\./.test(rh), 'D reveal names the writer behind each pick (' + arm0 + ')');
  ok(rh.includes(NAMES[arm0] + ': 1 of 2') && /None of them: 1 of 2/.test(rh), 'D and the tally');
  { // r6: the letter generation, and the guards around it — against the real handler
    await c.clResetPicks(mk('b')); await tick(20);
    const g1 = row.generation;
    ok(g1 >= 1 && c._cl.generation === g1, 'r6 the app carries the generation the server reports (' + g1 + ')');
    await callHandler({ action: 'reset', id: row.id }, true);          // another tab resets meanwhile
    const La = lab(0); toasts.length = 0;
    await c.clPick(mk('b', { attrs: { 'data-ii': '0', 'data-label': La } })); await tick(20);
    ok(J(row.picks) === '{}' && /letters were reshuffled/.test(els.clOverlay.innerHTML) && c._cl.generation === row.generation && J(c._cl.picks) === '{}', 'r6 a pick on old letters (409 labels_changed): nothing stored, the test reloads, the owner is asked to pick again');
    await c.clPick(mk('b', { attrs: { 'data-ii': '0', 'data-label': lab(0) } })); await tick(20);
    ok(J(row.picks) === J({ 0: lab(0) }), 'r6 …and the next pick (new generation) is stored');
    const i1 = row.cells.findIndex(x => x.inputIndex === 1); const keep = Object.assign({}, row.cells[i1]);
    row.cells[i1].status = 'running'; row.cells[i1].startedAt = Date.now();
    await c.clPick(mk('b', { attrs: { 'data-ii': '1', 'data-label': 'none' } })); await tick(20);
    ok(!('1' in row.picks) && /still being written/.test(els.clOverlay.innerHTML) && !/data-ii="1" data-label/.test(els.clOverlay.innerHTML), 'r6 a pick on an input not finished yet (409 input_not_ready) is said, and its letters are hidden again');
    row.cells[i1] = keep; await c.clShowResults(); await tick(20);
    await c.clReveal(mk('rb')); await tick(20);
    ok(c._cl.stage === 'judge' && !row.revealed_at && /Not every input has a pick yet/.test(els.clOverlay.innerHTML), 'r6 reveal with a pick missing (409) is said, nothing revealed');
    const resets = callsTo('/api/blind-test', 'reset').length;
    c._cl.running = true; c._cl.final = true; c.clRender();
    ok(/onclick="clResetPicks\(this\)"[^>]*disabled>Reset the picks/.test(els.clOverlay.innerHTML), 'r6 Reset is disabled while any cell is being run');
    await c.clResetPicks(mk('b')); await tick(10);
    ok(callsTo('/api/blind-test', 'reset').length === resets, 'r6 …and does nothing if tapped');
    c._cl.running = false; c._cl.final = false; }
  // M10 a test replaced while a cell is running: the old loop stops, the new test is untouched
  { c.clNew(); put('clText0', { value: 'x' }); put('clKind0', { value: 'idea' });
    const hold = deferred(); let first = true, failHeld = true;
    hookBefore = async (b) => { if (b.action === 'runCell' && first) { first = false; await hold.p; } };
    failIf = (b) => b.action === 'runCell' && failHeld && !(failHeld = false);
    const oldRun = c.clCreate(); await tick(20);
    const oldTest = c._cl.test;
    c.clNew(); c._cl.test = { id: 'other', inputs: [] }; c._cl.cells = [{ index: 0, label: 'A', status: 'pending' }]; c._cl.stage = 'running';
    const before = callsTo('/api/blind-test', 'runCell').length;
    hold.res(); await oldRun; await tick(20); hookBefore = null; failIf = null;
    ok(oldTest && c._cl.test.id === 'other' && c._cl.cells[0].status === 'pending' && !c._cl.paused && callsTo('/api/blind-test', 'runCell').length === before, 'M10 an answer for the old test (even a failure) never touches the new one'); }
  { // leaf-T r4 shapes: create may refuse a writer that cannot run → offer the test without it
    c.clNew(); c.clOpen();
    put('clText0', { value: 'typed one' }); put('clKind0', { value: 'question' });
    claudeOn = false;   // the REAL handler refuses the Claude writer with no key: 400 arm_unavailable
    await c.clCreate(); await tick();
    const ov = els.clOverlay.innerHTML;
    ok(/Claude isn’t set up yet — add the Anthropic key, or run without the Claude writer\./.test(ov) && /data-arm="claude" onclick="clCreateWithout\(this\)"[^>]*>Run without the Claude writer/.test(ov) && ov.includes('>typed one</textarea>') && /<option value="question" selected>/.test(ov), 'arm_unavailable on create: said plainly, typed inputs kept, "Run without the Claude writer" offered');
    put('clText0', { value: 'typed one' }); put('clKind0', { value: 'question' });
    await c.clCreateWithout(mk('b', { attrs: { 'data-arm': 'claude' } })); await tick(60);
    const cr2 = callsTo('/api/blind-test', 'create').slice(-1)[0];
    ok(J(cr2.body.arms) === J(['baseline', 'grok-high']) && c._cl.test && db.rows.slice(-1)[0].cells.length === 4 && db.rows.slice(-1)[0].cells.every(x => x.arm !== 'claude'), 'the test starts without that writer (' + J(cr2.body.arms) + ')');
    claudeOn = true;
    // a writer stuck mid-run (progress.stale): the real get marks it, and the app runs that input again by itself
    const rowS = db.rows.slice(-1)[0];
    rowS.cells[1].status = 'running'; rowS.cells[1].startedAt = Date.now() - 400000; rowS.cells[1].text = null;
    let staleSeen = false; respHook = (b, out) => { if (b.action === 'get' && out.body && Array.isArray(out.body.progress) && out.body.progress[0].stale) staleSeen = true; return out; };
    const n0 = callsTo('/api/blind-test', 'runCell').length;
    await c.clShowResults(); await tick(40);
    const rc = callsTo('/api/blind-test', 'runCell').slice(n0);
    ok(staleSeen, 'the real get reports the stuck input as stale');
    ok(rc.length === 2 && J(rc.map(x => x.body.index)) === J([0, 1]) && rc.every(x => !x.body.force) && rowS.cells[1].status === 'done' && /data-ii="0" data-label="/.test(els.clOverlay.innerHTML), 'it re-sends runCell for every cell of that input by itself (the finished one answers 409 and is left alone) and the outputs appear');
    await c.clShowResults(); await tick(20);
    ok(callsTo('/api/blind-test', 'runCell').length === n0 + 2, 'and does not loop');
    // the button is there when the automatic run was already tried
    rowS.cells[3].status = 'running'; rowS.cells[3].startedAt = Date.now() - 400000; c._cl.staleTried[c._cl.test.id + ':1'] = true;
    await c.clShowResults(); await tick(20);
    ok(/data-ii="1" onclick="clRerunInput\(this\)"/.test(els.clOverlay.innerHTML), 'a stale input already tried offers "run it again"');
    respHook = null; }
  { // r7: "Skip it" is told to the server; an input stuck unfinished always has a way out
    c.clNew(); c.clOpen(); claudeOn = true; grokFails = 0;
    put('clText0', { value: 'skip me' }); put('clKind0', { value: 'idea' }); put('clText1', { value: '' });
    let skipFails = 1;
    failIf = (b) => (b.action === 'runCell' && b.index === 1 && !b.force) || (b.action === 'skip' && skipFails-- > 0);
    await c.clCreate(); await tick(40);
    const rowK = db.rows.slice(-1)[0];
    ok(c._cl.paused && c._cl.paused.index === 1, 'r7 a run that could not start pauses');
    await c.clSkip(); await tick(20);
    ok(c._cl.paused && /clSkip\(\)/.test(els.clOverlay.innerHTML) && /clRetry\(\)/.test(els.clOverlay.innerHTML) && /Could not start this cell/.test(els.clOverlay.innerHTML) && rowK.cells[1].status === 'pending', 'r7 if the skip fails, the Retry / Skip choice stays and nothing changed');
    await c.clSkip(); await tick(60);
    const sk = callsTo('/api/blind-test', 'skip').slice(-1)[0];
    ok(sk && sk.body.index === 1 && sk.body.generation === 0 && rowK.cells[1].status === 'error' && rowK.cells[1].error === 'skipped', 'r7 "Skip it" sends action skip {id, index, generation}; the server finishes that cell as skipped');
    ok(c._cl.stage === 'judge' && /data-ii="0" data-label="/.test(els.clOverlay.innerHTML), 'r7 …so its input is ready and can be picked (no endless input_not_ready)');
    failIf = null;
    // an input stuck unfinished while nothing runs: run the missing writers, or skip them
    const pi = rowK.cells.findIndex(x => x.arm !== 'claude' && x.status === 'done');   // a writer that can succeed
    rowK.cells[pi].status = 'pending'; delete rowK.cells[pi].text;
    await c.clShowResults(); await tick(20);
    ok(/data-ii="0" onclick="clRunMissing\(this\)">Run the missing writers/.test(els.clOverlay.innerHTML) && /data-ii="0" onclick="clSkipMissing\(this\)">Skip the missing ones/.test(els.clOverlay.innerHTML), 'r7 an unfinished input with nothing running offers "Run the missing writers" and "Skip the missing ones"');
    const n1 = callsTo('/api/blind-test', 'runCell').length;
    await c.clRunMissing(mk('b', { attrs: { 'data-ii': '0' } })); await tick(40);
    ok(callsTo('/api/blind-test', 'runCell').length === n1 + 3 && rowK.cells[pi].status === 'done' && /data-ii="0" data-label="/.test(els.clOverlay.innerHTML), 'r7 "Run the missing writers" runs that input\'s cells (finished ones answer 409) and it becomes ready');
    rowK.cells[pi].status = 'pending'; delete rowK.cells[pi].text;
    await c.clShowResults(); await tick(20);
    const doneBefore = rowK.cells.filter(x => x.status === 'done').map(x => x.index);
    await c.clSkipMissing(mk('b', { attrs: { 'data-ii': '0' } })); await tick(40);
    ok(rowK.cells[pi].status === 'error' && rowK.cells[pi].error === 'skipped' && doneBefore.length && doneBefore.every(i => rowK.cells[i].status === 'done') && /data-ii="0" data-label="/.test(els.clOverlay.innerHTML), 'r7 "Skip the missing ones" skips only what was missing and the input becomes ready');
    rowK.cells[pi].status = 'pending'; delete rowK.cells[pi].text; await c.clShowResults(); await tick(20);
    ok(/clRunMissing/.test(els.clOverlay.innerHTML), 'r7 (unfinished again: offered)');
    c._cl.running = true; c.clRender();
    ok(!/clRunMissing|clSkipMissing/.test(els.clOverlay.innerHTML), 'r7 the way out is not offered while something runs'); c._cl.running = false; }
  c.clClose(); ok(!els.clOverlay, 'D the Lab closes');
  Module._load = origLoad;
}
