#!/usr/bin/env node
// GATE (content-v3, leaf U): the app side of .unlazy/content-v3/PLAN.md — F1 the daily question card,
// F2 the "How did it do?" row, F3 the three hooks (saved as hook_alts, teleprompter passes, which one
// went out). It EXECUTES the real functions lifted from app.html (and the real sw.js) in node:vm with a
// fake DOM, a fake fetch answering in the PLAN's shapes and a fake PostgREST.
//   Q  get / answer / answeredToday / memory_full / memory_write_unknown / server words / 404+503 hide /
//      network error / "Turn into a script" → the rv2 sheet / q=1 opens the card and leaves the URL /
//      the service worker tells an open window to open it.
//   R  who is asked (done, no result, 24h+), the POST shape, optimistic + rollback, 503 hides quietly,
//      bad links refused, the idea view can change it, the result survives the next save and a reload.
//   H  hooks → hook_alts on the insert (+ the missing-column retry), read back, the idea view options,
//      teleprompter pass order, the toggle only with 2+ hooks, "which hook did you post?" → hookUsed.
// RUN: node scripts/verify/rv3-ui-1.mjs      EXPECT: prints "UI V3 OK", exit 0.
import fs from 'node:fs'; import vm from 'node:vm';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
setTimeout(() => { console.log('FAIL: wall clock (60s) exceeded'); process.exit(2); }, 60000).unref();
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
const els = {};
function mk(id, extra) {
  return Object.assign({ id, value: '', innerHTML: '', placeholder: '', disabled: false, textContent: '', className: '', attrs: {}, style: {}, scrolled: 0, focused: 0,
    classList: { _s: new Set(), add(k) { this._s.add(k); }, remove(k) { this._s.delete(k); }, toggle(k, on) { if (on === undefined ? !this._s.has(k) : on) this._s.add(k); else this._s.delete(k); }, contains(k) { return this._s.has(k); } },
    getAttribute(k) { return this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = String(v); },
    dispatchEvent() {}, scrollIntoView() { this.scrolled++; }, focus() { this.focused++; }, remove() { delete els[this.id]; } }, extra || {});
}
const put = (id, extra) => (els[id] = mk(id, extra));
const calls = []; let route = () => ({ status: 404, body: {} });
async function fakeFetch(url, init) {
  const body = init && init.body ? JSON.parse(init.body) : null;
  calls.push({ url, body });
  const r = await route(url, body);
  if (r instanceof Error) throw r;
  const txt = JSON.stringify(r.body == null ? {} : r.body);
  return { ok: r.status >= 200 && r.status < 300, status: r.status, url, text: async () => txt, json: async () => JSON.parse(txt), clone() { return this; } };
}
const callsTo = (u) => calls.filter(c => c.url === u);
function makeDb(columns) {
  const cols = new Set(columns); const rows = []; let seq = 0; const db = { rows, inserts: 0 };
  db.from = (table) => {
    const q = { op: null, filters: [], payload: null, order: null, range: null };
    const run = () => {
      if (q.op === 'insert') {
        db.inserts++;
        const list = Array.isArray(q.payload) ? q.payload : [q.payload];
        for (const r of list) for (const k of Object.keys(r)) if (!cols.has(k)) return { data: null, error: { code: 'PGRST204', message: `Could not find the '${k}' column of '${table}' in the schema cache` } };
        for (const r of list) { seq++; const st = { id: 'id-' + seq, created_at: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString() };
          for (const c of cols) if (!(c in st)) st[c] = (c in r) ? JSON.parse(JSON.stringify(r[c])) : null; rows.push(st); }
        return { data: null, error: null };
      }
      const hit = rows.filter(r => q.filters.every(f => f(r)));
      if (q.op === 'delete') { for (const r of hit) rows.splice(rows.indexOf(r), 1); return { data: hit.map(r => ({ id: r.id })), error: null }; }
      let out = hit.slice(); if (q.order) out.sort((a, b) => (a[q.order[0]] < b[q.order[0]] ? -1 : 1) * q.order[1]); if (q.range) out = out.slice(q.range[0], q.range[1] + 1);
      return { data: out.map(r => JSON.parse(JSON.stringify(r))), error: null };
    };
    const b = { select() { if (!q.op) q.op = 'select'; return b; }, insert(p) { q.op = 'insert'; q.payload = p; return b; }, delete() { q.op = 'delete'; return b; },
      eq(k, v) { q.filters.push(r => r[k] === v); return b; }, in(k, vs) { q.filters.push(r => vs.includes(r[k])); return b; },
      order(k, x) { q.order = [k, x && x.ascending === false ? -1 : 1]; return b; }, range(a, z) { q.range = [a, z]; return b; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); } };
    return b;
  };
  return db;
}
const BASE = ['id', 'brand_id', 'day', 'community', 'format', 'title', 'hook', 'script', 'shots', 'screen', 'caption', 'reel_title',
  'tags', 'bold_text', 'status', 'dismiss_reason', 'assignee', 'is_generated', 'created_at', 'is_remix', 'original_creator', 'emphasis', 'gen_flow'];
const V3 = ['result', 'result_at', 'post_url', 'hook_alts', 'hook_used'];
const store = new Map(); const toasts = []; const started = []; const dictated = []; const switched = []; let replaced = null;
const swl = {};
const c = {
  console: { log() {}, warn() {}, error() {}, info() {} }, JSON, Promise, Date, Math, String, Number, Array, Object, Set, Map, RegExp, Error, TypeError, URLSearchParams, isNaN,
  window: {}, state: [], IDEAS: [], currentBrand: { id: 'brand-1' }, sb: null, _switchSeq: 0, activeView: 'today', _ideasSaveChain: Promise.resolve(),
  navigator: { serviceWorker: { addEventListener(t, fn) { swl[t] = fn; } } },
  location: { search: '', pathname: '/app.html', hash: '' }, history: { state: null, replaceState(s, t, u) { replaced = u; } },
  document: { getElementById: id => els[id] || null, createElement: () => mk(''), body: { style: {}, appendChild(e) { if (e.id) els[e.id] = e; } }, querySelector: () => null, querySelectorAll: () => [] },
  fetch: fakeFetch, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  lsSet: (k, v) => { store.set(k, v); return true; }, lsGet: k => (store.has(k) ? store.get(k) : null), lsDel: k => store.delete(k),
  showToast: (m) => toasts.push(String(m)), saveState() { c.__saveState = (c.__saveState || 0) + 1; }, bmInvalidate() { c.__bmInv = (c.__bmInv || 0) + 1; },
  ICO: { mic: '<svg class="mic"></svg>' },
  rv2Start: (btn, src, opts) => { started.push({ src, opts }); return Promise.resolve(); },
  dictateInto: (...a) => { dictated.push(a); },
  switchView: (v) => { switched.push(v); c.activeView = v; },
  renderPipeline() {}, renderNav() {}, mascotReact() {}, autoRefillCheck() {},
  // teleprompter surroundings (the real formatting is tested by its own gates)
  tpFormatScript: (t) => '<p>' + String(t).replace(/</g, '&lt;') + '</p>', nl2br: (t) => String(t), tpPrimer: () => '', tpSetSmartSpeed() {}, tpEnsureCamera() {},
  tpSyncDoneBtn() {}, TP_VOICE_SUPPORTED: false, tpVoiceEnabled: () => false, tpFontSize: 30, _tpIdeaId: null, tpMediaRecorder: null,
};
vm.createContext(c);
for (const n of ['escapeHtml', 'escHtml', 'humanErr', '_leanNetFail', '_leanErrMsg', 'csAiPausedText', 'asText', 'brandGate', 'rv2Post', 'rv2ErrText', 'rv2TagFlow',
  'rv2Slots', 'rv2Paragraphs', 'rv2BuildIdea', 'rv2OriginFor',
  'tpEscape', 'tpOutsideTags', 'tpSenseLines', 'tpStressRx', 'tpEmphasise', 'tpPruneEmphasis', 'tpCleanEmphasis',
  '_buildIdeaRows', '_saveIdeasToDBNow', 'normalizeIdeaStatus', '_ideaRowRecency', 'loadIdeasFromDB', 'moveStage', 'openTeleprompter']) vm.runInContext(grab(n), c);
for (const m of html.matchAll(/^const (TP_STRESS_[AB]) = .*$/gm)) vm.runInContext(m[0].replace(/^const /, 'var '), c);
vm.runInContext(between('/* content-v3 (leaf U) — BEGIN', '/* content-v3 (leaf U) — END').replace(/^(let|const) /gm, 'var '), c);
const XSS = '<img src=x onerror=alert(1)>';
const Q = { id: 'q7', text: 'What did a customer say that surprised you? ' + XSS, kind: 'customer' };
let dqRoute = { get: { status: 200, body: { question: Q, date: '2026-09-27', answeredToday: false } }, answer: { status: 200, body: { ok: true, storyId: 's1' } } };
const defaultRoute = (u, b) => {
  if (u === '/api/daily-question') return dqRoute[b && b.action] || { status: 400, body: { error: 'bad action' } };
  if (u === '/api/idea-result') return { status: 200, body: { ok: true } };
  return { status: 404, body: {} };
};
const reset = () => { calls.length = 0; toasts.length = 0; started.length = 0; dictated.length = 0; switched.length = 0; replaced = null;
  for (const k of Object.keys(els)) delete els[k];
  vm.runInContext('_dq = null; _dqOpenPending = false; _resOff = false; _resBusy.clear(); tpHooks = { on: false, id: null }; state = []; currentBrand = { id: "brand-1" }; activeView = "today"; _tpIdeaId = null; tpMediaRecorder = null;', c);
  route = defaultRoute; dqRoute = { get: { status: 200, body: { question: Q, date: '2026-09-27', answeredToday: false } }, answer: { status: 200, body: { ok: true, storyId: 's1' } } }; store.clear(); };
const card = () => (els.dqSlot ? els.dqSlot.innerHTML : '');
const H = 3600 * 1000;
// the retry flags live on the vm's own global: clear them from inside (a delete on the sandbox object does not reach it)
const clearFlags = () => vm.runInContext('delete globalThis._ideasNoResultCols; delete globalThis._ideasNoEmphasisCol; delete globalThis._ideasNoGenFlowCol;', c);

(async () => {
  // ═══ Q THE DAILY QUESTION ═══
  reset(); put('dqSlot');
  c.dqMount(); await tick();
  let g = callsTo('/api/daily-question')[0];
  ok(g && J(g.body) === J({ action: 'get', brandId: 'brand-1' }), 'Q get: POST {action:"get", brandId}');
  ok(card().includes('What did a customer say that surprised you? &lt;img') && !card().includes(XSS), 'Q the question shows, escaped');
  ok(/id="dqText"/.test(card()) && /onclick="dqSave\(\)"/.test(card()) && /onclick="dqDictate\(this\)"/.test(card()), 'Q a text box, a mic and Save');
  c.dqMount(); await tick();
  ok(callsTo('/api/daily-question').length === 1, 'Q re-rendering Today does not load it again (once per brand per day)');
  c.dqDictate(mk('dqMic'));
  ok(dictated.length === 1 && dictated[0][0] === 'dqText', 'Q the mic runs the existing dictateInto into the answer box');
  put('dqText', { value: '   ' }); await c.dqSave();
  ok(callsTo('/api/daily-question').length === 1 && /Type or say your answer first/.test(card()), 'Q an empty answer is not sent');
  put('dqText', { value: '  A customer   told me\n she cried. ' });
  const saved = await c.dqSave(); await tick();
  let a = callsTo('/api/daily-question')[1];
  ok(saved === true && a && J(a.body) === J({ action: 'answer', brandId: 'brand-1', questionId: 'q7', text: 'A customer told me she cried.' }), 'Q Save: POST {action:"answer", brandId, questionId, text}');
  ok(/Saved — it’s in your story bank/.test(card()) && /Turn into a script/.test(card()) && !/id="dqText"/.test(card()), 'Q answered: "Saved — it\'s in your story bank" + "Turn into a script"');
  ok(c.__bmInv >= 1 && JSON.parse(store.get('dq_answer')).text === 'A customer told me she cried.', 'Q the story list is refreshed and the answer kept on this device');
  c.dqToScript(mk('dqScriptBtn'));
  ok(started.length === 1 && started[0].src.kind === 'note' && /THE QUESTION I WAS ASKED: What did a customer/.test(started[0].src.text) && /MY ANSWER, IN MY OWN WORDS: A customer told me she cried\./.test(started[0].src.text)
    && started[0].opts.host === 'rv2Sheet' && started[0].opts.origin.name === 'question', '"Turn into a script" starts the v2 writer with the answer as its source');
  const org = c.rv2OriginFor('question', {});
  ok(org.title === 'Turn your answer into a script' && org.extra.sparkSource === true && org.name === 'question', 'Q the sheet has its own title and saves as the founder\'s own idea (not a remix)');
  // long answers are clipped to the server's 600
  reset(); put('dqSlot'); c.dqMount(); await tick(); put('dqText', { value: ('word ').repeat(200) }); await c.dqSave();
  ok(callsTo('/api/daily-question')[1].body.text.length <= 600, 'Q an answer over 600 characters is clipped before sending');
  // memory_full
  reset(); put('dqSlot'); dqRoute.answer = { status: 409, body: { code: 'memory_full', error: 'memory_full' } };
  c.dqMount(); await tick(); put('dqText', { value: 'My story' });
  ok((await c.dqSave()) === false && /Your story bank is full — delete one in Settings\./.test(card()) && /My story<\/textarea>/.test(card()), 'Q memory_full: said plainly, the answer stays in the box');
  // a brand switch while the answer is saved: this brand's device store is never written from the other brand
  reset(); put('dqSlot'); { let rs; dqRoute.answer = new Promise(r => { rs = r; });
    c.dqMount(); await tick(); put('dqText', { value: 'My story' }); const pr = c.dqSave(); await tick();
    vm.runInContext('_switchSeq++; currentBrand = { id: "brand-2" }', c); rs({ status: 200, body: { ok: true } }); await pr;
    ok(!store.has('dq_answer'), 'Q an answer that lands after a brand switch is not kept under the other brand'); vm.runInContext('_switchSeq = 0', c); }
  // memory_write_unknown (whatever status carries it)
  for (const st of [502, 200]) {
    reset(); put('dqSlot'); dqRoute.answer = { status: st, body: { code: 'memory_write_unknown' } };
    c.dqMount(); await tick(); put('dqText', { value: 'My story' });
    ok((await c.dqSave()) === false && /Couldn’t confirm it was saved — check your stories/.test(card()) && !/Saved — it’s/.test(card()), 'Q memory_write_unknown (' + st + '): never claims it was saved');
  }
  reset(); put('dqSlot'); dqRoute.answer = { status: 400, body: { error: 'That answer needs a few more words.' } };
  c.dqMount(); await tick(); put('dqText', { value: 'Hi' }); await c.dqSave();
  ok(/That answer needs a few more words\./.test(card()), 'Q any other refusal shows the server\'s own words');
  // answered earlier today
  reset(); put('dqSlot'); dqRoute.get = { status: 200, body: { question: Q, date: '2026-09-27', answeredToday: true } };
  store.set('dq_answer', JSON.stringify({ date: '2026-09-27', questionId: 'q7', text: 'Earlier answer' }));
  c.dqMount(); await tick();
  ok(/Saved — it’s in your story bank/.test(card()) && /Turn into a script/.test(card()) && !/id="dqText"/.test(card()), 'Q answeredToday → the answered state (with this device\'s answer, "Turn into a script")');
  reset(); put('dqSlot'); dqRoute.get = { status: 200, body: { question: Q, date: '2026-09-27', answeredToday: true } };
  c.dqMount(); await tick();
  ok(/Saved — it’s in your story bank/.test(card()) && !/Turn into a script/.test(card()), 'Q answered on another device: no script button without the words');
  // not deployed / not ready → no card
  for (const st of [404, 503]) {
    reset(); put('dqSlot'); dqRoute.get = { status: st, body: st === 503 ? { code: 'memory_not_ready' } : {} };
    c.dqMount(); await tick();
    ok(card() === '', 'Q ' + st + ' → the card hides cleanly');
  }
  reset(); put('dqSlot'); route = (u, b) => u === '/api/daily-question' ? new TypeError('Failed to fetch') : defaultRoute(u, b);
  c.dqMount(); await tick();
  ok(/Couldn't reach the server/.test(card()) && /onclick="dqLoad\(\)"/.test(card()), 'Q a network failure says so, with Try again');
  reset(); put('dqSlot'); dqRoute.get = { status: 403, body: { error: 'You do not have access to this brand.' } };
  c.dqMount(); await tick();
  ok(/You do not have access to this brand\./.test(card()), 'Q a refused load shows the server\'s words');
  // brand switch: a card never shows on the wrong brand
  reset(); put('dqSlot'); c.dqMount(); await tick(); c.currentBrand = { id: 'brand-2' };
  ok(c.dqHtml(c._dq) === '', 'Q brand A\'s question never shows on brand B');
  c.dqMount(); await tick();
  ok(callsTo('/api/daily-question').filter(x => x.body.brandId === 'brand-2').length === 1, 'Q brand B loads its own question');
  // q=1
  reset(); put('dqSlot'); put('dqCard'); put('dqText'); c.activeView = 'ideas';
  let held; dqRoute.get = new Promise(r => { held = r; });
  c.location = { search: '?brand=b1&q=1', pathname: '/app.html', hash: '' };
  c.dqMount();
  ok(c.dqFromUrl() === true && replaced === '/app.html?brand=b1' && switched.includes('today'), 'Q q=1: Today opens and q leaves the address (other params kept)');
  ok(els.dqCard.scrolled === 0 && c._dqOpenPending === true, 'Q while the question loads the open waits');
  held({ status: 200, body: { question: Q, date: '2026-09-27', answeredToday: false } }); await tick();
  ok(els.dqCard.scrolled === 1 && els.dqText.focused === 1 && c._dqOpenPending === false, 'Q once it arrives the card is scrolled to and the box focused');
  reset(); c.location = { search: '?brand=b1', pathname: '/app.html', hash: '' };
  ok(c.dqFromUrl() === false && replaced === null && switched.length === 0, 'Q no q=1 → nothing moves');
  ok(/try \{ if \(typeof dqFromUrl === 'function'\) dqFromUrl\(\); \} catch\(e\) \{\}/.test(grab('initApp')), 'Q initApp checks q=1 after the brand is loaded');
  ok(/<div id="dqSlot"><\/div><div id="resSlot"><\/div>/.test(grab('renderTodayView')) && /dqMount\(\)/.test(grab('renderTodayView')) && /resTodayHtml\(\)/.test(grab('renderTodayView')), 'Q Today carries the question card and the results row');
  // an already-open window: sw.js → message → the card opens
  reset(); put('dqSlot'); put('dqCard'); put('dqText'); c.dqMount(); await tick(); c.activeView = 'pipeline';
  swl.message({ data: { type: 'cs-open-question' } });
  ok(switched.includes('today') && els.dqCard.scrolled === 1, 'Q the service worker\'s "open the question" message opens the card');
  {
    const handlers = {}; const msgs = []; const opened = []; let focused = 0; let wins = [];
    const sw = { self: { addEventListener(t, fn) { handlers[t] = fn; }, registration: {}, skipWaiting() {}, clients: {} }, caches: {}, fetch() {}, URL, console: { log() {}, warn() {}, error() {} },
      clients: { matchAll: async () => wins, openWindow: async (u) => opened.push(u) } };
    vm.createContext(sw); vm.runInContext(swSrc, sw);
    const click = async (url) => { let p; handlers.notificationclick({ notification: { close() {}, data: { url } }, waitUntil(x) { p = x; } }); await p; };
    wins = [{ url: 'https://contentshrimp.com/app.html', focus() { focused++; }, postMessage(m) { msgs.push(m); } }];
    await click('/app.html?brand=b1&q=1');
    ok(msgs.length === 1 && msgs[0].type === 'cs-open-question' && focused === 1, 'sw: an open window is focused AND told to open the question');
    await click('/app.html?brand=b1');
    ok(msgs.length === 1 && focused === 2, 'sw: an idea-only push does not open the question');
    wins = []; await click('/app.html?q=1');
    ok(J(opened) === J(['/app.html?q=1']), 'sw: with no window open, q=1 travels in the opened URL');
  }

  // ═══ R HOW DID IT DO? ═══
  reset();
  const now = Date.now();
  ok(c.resEligible({ status: 'done', doneAt: now - 25 * H }, now) === true, 'R done 25h ago, no result → asked');
  ok(c.resEligible({ status: 'done', doneAt: now - 23 * H }, now) === false, 'R done 23h ago → not yet');
  ok(c.resEligible({ status: 'done' }, now) === true, 'R done with no timestamp at all → asked (never silently skipped)');
  ok(c.resEligible({ status: 'done', doneAt: now - 48 * H, result: 'ok' }, now) === false && c.resEligible({ status: 'filming', doneAt: now - 48 * H }, now) === false, 'R has a result / not filmed → not asked');
  const db = makeDb(BASE.concat(V3)); c.sb = db;
  db.rows.push({ id: 'row-9', brand_id: 'brand-1', title: 'Filmed one', created_at: '2026-09-01T00:00:00Z' }, { id: 'row-x', brand_id: 'brand-2', title: 'Filmed one', created_at: '2026-09-02T00:00:00Z' });
  const fresh = () => ({ id: 0, title: 'Filmed one ' , status: 'done', doneAt: Date.now() - 25 * H, hookAlts: ['Bold claim.', 'Is it though?', 'Last week I cried.'], hookUsed: 1, format: 'video' });
  c.state = [Object.assign(fresh(), { title: 'Filmed one' })]; put('resSlot');
  els.resSlot.innerHTML = c.resTodayHtml();
  ok(/How did it do\?/.test(els.resSlot.innerHTML) && /Flopped/.test(els.resSlot.innerHTML) && />OK</.test(els.resSlot.innerHTML) && /Great/.test(els.resSlot.innerHTML) && /Post link \(optional\)/.test(els.resSlot.innerHTML), 'R Today shows "How did it do? Flopped · OK · Great" + an optional link');
  put('resUrl-t-0', { value: ' https://www.instagram.com/p/abc ' }); put('resMsg-t-0');
  let res; route = (u, b) => u === '/api/idea-result' ? new Promise(r => { res = r; }) : defaultRoute(u, b);
  let p = c.resSet(0, 'great', 't'); await tick();
  ok(c.state[0].result === 'great' && els.resSlot.innerHTML === '', 'R optimistic: the answer shows at once and the row goes');
  ok(J(callsTo('/api/idea-result')[0].body) === J({ ideaId: 'row-9', result: 'great', postUrl: 'https://www.instagram.com/p/abc', hookUsed: 1 }), 'R POST {ideaId (this brand\'s row, found by title), result, postUrl, hookUsed}');
  ok((await c.resSet(0, 'ok', 't')) === false && callsTo('/api/idea-result').length === 1, 'R a second tap while it sends does not send twice');
  res({ status: 200, body: { ok: true } }); ok((await p) === true && c.state[0].result === 'great' && c.resEligible(c.state[0]) === false, 'R saved: the idea keeps its result and is not asked again');
  // rollback
  c.state = [Object.assign(fresh(), { title: 'Filmed one', hookUsed: undefined })]; put('resUrl-t-0', { value: '' }); put('resMsg-t-0');
  route = (u, b) => u === '/api/idea-result' ? new Promise(r => { res = r; }) : defaultRoute(u, b);
  p = c.resSet(0, 'flop', 't'); await tick();
  ok(!('hookUsed' in callsTo('/api/idea-result')[1].body) && !('postUrl' in callsTo('/api/idea-result')[1].body), 'R no hook known / no link → neither is sent');
  res({ status: 500, body: { error: 'The database is having a moment.' } }); await p;
  ok(c.state[0].result === undefined && c.resEligible(c.state[0]) === true && /How did it do\?/.test(els.resSlot.innerHTML) && els['resMsg-t-0'].textContent === 'The database is having a moment.', 'R a failure rolls back, the row comes back with the server\'s words');
  // 503 results_not_ready → hidden, quietly
  route = (u, b) => u === '/api/idea-result' ? { status: 503, body: { code: 'results_not_ready' } } : defaultRoute(u, b);
  toasts.length = 0; put('resMsg-t-0');
  ok((await c.resSet(0, 'ok', 't')) === false && c.state[0].result === undefined && els.resSlot.innerHTML === '' && c.resTodayHtml() === '' && c.resDetailHtml(c.state[0]) === '' && toasts.length === 0 && els['resMsg-t-0'].textContent === '', 'R 503 results_not_ready → the rows hide quietly');
  // bad link
  reset(); c.sb = db; c.state = [Object.assign(fresh(), { title: 'Filmed one' })]; put('resUrl-d-0', { value: 'http://insecure.example/p' }); put('resMsg-d-0');
  ok((await c.resSet(0, 'ok', 'd')) === false && callsTo('/api/idea-result').length === 0 && /https:\/\//.test(els['resMsg-d-0'].textContent) && !c.state[0].result, 'R a link that is not https is refused before sending');
  // not found in the account → nothing sent, rolled back
  c.state = [Object.assign(fresh(), { title: 'Never saved' })]; put('resUrl-d-0', { value: '' });
  ok((await c.resSet(0, 'ok', 'd')) === false && callsTo('/api/idea-result').length === 0 && !c.state[0].result, 'R an idea that is not in the account yet sends nothing and rolls back');
  // idea view
  c.state = [Object.assign(fresh(), { title: 'Filmed one', doneAt: Date.now() })];
  const det = c.resDetailHtml(c.state[0]);
  ok(/id="resD-0"/.test(det) && /resSet\(0,'great','d'\)/.test(det) && c.resDetailHtml({ id: 1, status: 'filming' }) === '', 'R the idea view offers it any time once filmed (not before)');
  put('resD-0'); put('resUrl-d-0', { value: '' });
  await c.resSet(0, 'great', 'd');
  ok(/class="res-chip on" aria-pressed="true"[^>]*resSet\(0,'great','d'\)/.test(els['resD-0'].innerHTML), 'R the chosen answer shows as selected in the idea view');
  await c.resSet(0, 'flop', 'd');
  ok(c.state[0].result === 'flop' && callsTo('/api/idea-result').pop().body.result === 'flop', 'R it can be changed');
  ok(/resDetailHtml\(idea\)/.test(grab('renderDetailContent')) && /ideaHooksHtml\(idea\)/.test(grab('renderDetailContent')), 'R/H the idea view renders both');

  // ═══ H THREE HOOKS ═══
  reset();
  ok(J(c.rv2TagFlow({ title: 't', hooks: [' Bold claim. ', 'Is it though?', 'Last week I cried.'] }).hookAlts) === J(['Bold claim.', 'Is it though?', 'Last week I cried.']), 'H a generate-ideas reply\'s hooks become hookAlts');
  ok(!('hookAlts' in c.rv2TagFlow({ title: 't', hooks: ['Only one'] })) && !('hookAlts' in c.rv2TagFlow({ title: 't' })), 'H fewer than 2 hooks → none');
  { const s = { idea: { title: 'Cheap', hook: 'Bold claim.', script: 'Bold claim.\nBody.', format: 'talking', hooks: ['Bold claim.', 'Is it though?', 'Last week I cried.'] }, script: 'Bold claim.\nBody.', picked: { belief: 'b' }, origin: c.rv2OriginFor('note', { id: 'n1' }) };
    ok(J(c.rv2BuildIdea(s).idea.hookAlts) === J(s.idea.hooks), 'H the v2 writer\'s hooks are kept on the saved idea');
    delete s.idea.hooks; ok(!('hookAlts' in c.rv2BuildIdea(s).idea), 'H no hooks → no hookAlts'); }
  {
    const cdb = makeDb(BASE.concat(V3)); c.sb = cdb;
    c.state = [{ title: 'Three', hook: 'Bold claim.', script: 's', status: 'done', format: 'video', hookAlts: ['Bold claim.', 'Is it though?', 'Last week I cried.'], hookUsed: 2, result: 'great', resultAt: Date.UTC(2026, 8, 20), postUrl: 'https://x.com/p/1' },
               { title: 'Plain', hook: 'h', script: 's', status: 'pending', format: 'video' }];
    const rows = c._buildIdeaRows('brand-1');
    ok(J(rows[0].hook_alts) === J(['Bold claim.', 'Is it though?', 'Last week I cried.']) && rows[0].hook_used === 2 && rows[0].result === 'great' && rows[0].post_url === 'https://x.com/p/1' && rows[0].result_at === '2026-09-20T00:00:00.000Z', 'H the insert carries hook_alts, hook_used and the result');
    ok(!['hook_alts', 'hook_used', 'result', 'result_at', 'post_url'].some(k => k in rows[1]), 'H an idea without them names none of these columns');
    await c._saveIdeasToDBNow('brand-1', rows);
    ok(J(cdb.rows.find(r => r.title === 'Three').hook_alts) === J(rows[0].hook_alts), 'H saved to the database');
    store.clear();   // the database alone (this device's hook map is tested below)
    c.state = []; const back = await c.loadIdeasFromDB(); const t3 = back.find(i => i.title === 'Three');
    ok(J(t3.hookAlts) === J(rows[0].hook_alts) && t3.hookUsed === 2 && t3.result === 'great' && t3.postUrl === 'https://x.com/p/1' && t3.resultAt === Date.UTC(2026, 8, 20), 'H/R read back on reload, so the next save (which rewrites every row) keeps them');
    ok(!('result' in back.find(i => i.title === 'Plain')) && !('hookAlts' in back.find(i => i.title === 'Plain')), 'H/R an old row reads back without them');
    // missing columns: the insert retries without them (like emphasis), every other column still written
    for (const [label, cols] of [['results columns', BASE], ['results + emphasis + gen_flow', BASE.filter(x => x !== 'emphasis' && x !== 'gen_flow')]]) {
      const mdb = makeDb(cols); c.sb = mdb; clearFlags();
      c.state = [{ title: 'Three', hook: 'Bold claim.', script: 's', status: 'done', format: 'video', genFlow: 'v2', emphasis: [], hookAlts: ['A one', 'B two'], hookUsed: 0, result: 'ok', resultAt: Date.now() }];
      let err = null; try { await c._saveIdeasToDBNow('brand-1', c._buildIdeaRows('brand-1')); } catch (e) { err = e; }
      ok(!err && mdb.rows.length === 1 && mdb.rows[0].hook === 'Bold claim.' && vm.runInContext('globalThis._ideasNoResultCols', c) === true, 'H missing ' + label + ' → the idea is still saved, without them');
      const before = mdb.inserts; await c._saveIdeasToDBNow('brand-1', c._buildIdeaRows('brand-1'));
      ok(mdb.inserts - before === 1, 'H later saves skip them straight away (' + label + ')');
    }
    clearFlags();
    // hookUsed also kept on this device
    store.clear(); c.state = [{ title: 'Three', script: 's', status: 'done', hookAlts: ['A one', 'B two'], hookUsed: 1 }]; c._buildIdeaRows('brand-1');
    const ldb = makeDb(BASE); c.sb = ldb; ldb.rows.push({ id: 'r1', brand_id: 'brand-1', title: 'Three', status: 'done', created_at: '2026-09-01T00:00:00Z' });
    ok((await c.loadIdeasFromDB())[0].hookUsed === 1, 'H which hook went out survives a reload on this device even without the column');
  }
  // idea view options
  reset();
  c.state = [{ id: 0, title: 'Three', hook: 'Bold claim.', script: 'Bold claim.\nThe middle.\nThe end.', status: 'filming', format: 'video', hookAlts: ['Bold claim.', 'Is it ' + XSS, 'Last week I cried.'] }];
  const hv = c.ideaHooksHtml(c.state[0]);
  ok((hv.match(/class="hk-opt/g) || []).length === 3 && /class="hk-opt on"[^>]*hkPick\(0,0\)/.test(hv) && !hv.includes(XSS), 'H the idea view shows the 3 hooks as options (current one selected, escaped)');
  ok(c.ideaHooksHtml({ id: 1, hookAlts: ['one'] }) === '' && c.ideaHooksHtml({ id: 1 }) === '', 'H no hooks → nothing in the idea view');
  put('hk-0'); ok(c.hkPick(0, 2) === true && c.state[0].hook === 'Last week I cried.' && c.__saveState >= 1 && /class="hk-opt on"[^>]*hkPick\(0,2\)/.test(els['hk-0'].innerHTML), 'H tapping one makes it the main hook and saves');
  // teleprompter passes
  let ps = c.tpHookPasses(c.state[0]);
  ok(J(ps.map(x => x.text)) === J(['Bold claim.\nThe middle.\nThe end.', 'Is it ' + XSS, 'Last week I cried.']), 'H passes: hook 1 + script (its opening not said twice), then hook 2, then hook 3');
  ok(J(ps.map(x => x.label)) === J(['Hook 1 of 3 + script', 'Hook 2 of 3 — just this line', 'Hook 3 of 3 — just this line']), 'H each pass is labelled "Hook N of 3"');
  ok(c.tpHookPasses({ hookAlts: ['H1', 'H2'], script: 'A script with no hook line.' })[0].text === 'H1\nA script with no hook line.' && c.tpHookPasses({ hookAlts: ['H1', 'H2'], script: 'A' }).length === 2, 'H a script without the hook gets hook 1 in front; 2 hooks → 2 passes');
  ok(c.tpHookPasses({ hookAlts: ['H1'], script: 's' }) === null && c.tpHookPasses({ script: 's' }) === null, 'H fewer than 2 hooks → no 3-hook mode');
  // the real openTeleprompter
  for (const id of ['tpTitle', 'tpBody', 'teleprompterOverlay', 'tpVoiceBtn', 'tpHooksBtn']) put(id);
  c.openTeleprompter(0);
  ok(els.tpHooksBtn.style.display === 'inline-flex' && /3 hooks/.test(els.tpHooksBtn.innerHTML) && !/tp-pass/.test(els.tpBody.innerHTML), 'H the teleprompter offers "3 hooks" (off at first)');
  ok(c.tpToggleHooks() === true, 'H the toggle turns it on');
  const b = els.tpBody.innerHTML; const i1 = b.indexOf('data-label="Hook 1 of 3 + script"'), i2 = b.indexOf('data-label="Hook 2 of 3'), i3 = b.indexOf('data-label="Hook 3 of 3');
  ok(i1 >= 0 && i1 < b.indexOf('The middle.') && b.indexOf('The end.') < i2 && i2 < b.indexOf('Is it &lt;img') && i3 > b.indexOf('Is it &lt;img') && b.indexOf('Last week I cried.') > i3 && (b.match(/class="tp-script"/g) || []).length === 1,
    'H the teleprompter shows hook 1 + script, then "Hook 2 of 3" + hook 2, then "Hook 3 of 3" + hook 3 (one script block, so Follow me still works)');
  c.tpMediaRecorder = { state: 'recording' };
  ok(c.tpToggleHooks() === false && c.tpHooks.on === true && /Stop recording first/.test(toasts.pop()), 'H it never switches mid-take');
  c.tpMediaRecorder = null;
  c.state.push({ id: 1, title: 'No hooks', script: 'Just a script.', status: 'filming', format: 'video' });
  c.openTeleprompter(1);
  ok(els.tpHooksBtn.style.display === 'none' && !/tp-pass/.test(els.tpBody.innerHTML) && c.tpToggleHooks() === false, 'H no hooks → no toggle, normal script');
  c.state.push({ id: 2, title: 'St', boldText: 'A statement.', status: 'filming', format: 'statement', hookAlts: ['a b', 'c d'] });
  c.openTeleprompter(2);
  ok(els.tpHooksBtn.style.display === 'none', 'H statements have no 3-hook mode');
  c.openTeleprompter(0);
  ok(c.tpHooks.on === false && !/tp-pass/.test(els.tpBody.innerHTML), 'H opening another post resets it');
  // which hook did you post?
  reset(); c.state = [{ id: 0, title: 'Three', script: 's', status: 'filming', format: 'video', hookAlts: ['Bold claim.', 'Is it though?', 'Last week I cried.'] },
                      { id: 1, title: 'Plain', script: 's', status: 'filming', format: 'video' }];
  c.moveStage(0, 'done');
  ok(els.hkAsk && /Which hook did you post\?/.test(els.hkAsk.innerHTML) && (els.hkAsk.innerHTML.match(/hkSetUsed\(\d\)/g) || []).length === 3 && /hkAskSkip\(\)/.test(els.hkAsk.innerHTML), 'H marking it filmed asks which hook went out (1/2/3, skip allowed)');
  ok(c.hkSetUsed(2) === true && c.state[0].hookUsed === 2 && !els.hkAsk, 'H the choice is stored on the idea (sent later with the result)');
  ok(c._buildIdeaRows('brand-1')[0].hook_used === 2 && JSON.parse(store.get('hook_used_map')).Three === 2, 'H and saved with the idea + on this device');
  c.state[0].status = 'filming'; c.moveStage(0, 'done');
  ok(!els.hkAsk, 'H not asked again once known');
  c.moveStage(1, 'done');
  ok(!els.hkAsk, 'H an idea without hooks is not asked');
  reset(); c.state = [{ id: 0, title: 'Three', script: 's', status: 'filming', format: 'video', hookAlts: ['A one', 'B two'] }];
  c.moveStage(0, 'done'); c.hkAskSkip();
  ok(!els.hkAsk && c.state[0].hookUsed === undefined && c.state[0]._hkSkipped === true, 'H Skip stores nothing');
  c.state[0].status = 'filming'; c.moveStage(0, 'done');
  ok(!els.hkAsk, 'H a skipped idea is not asked again this session');
  reset(); c.state = [{ id: 0, title: 'Three', script: 's', status: 'filming', format: 'video', hookAlts: ['A one', 'B two'] }];
  c.moveStage(0, 'done'); c.currentBrand = { id: 'brand-2' }; c.state = [{ id: 0, title: 'Three', hookAlts: ['x y', 'z w'] }];
  ok(c.hkSetUsed(1) === false && c.state[0].hookUsed === undefined, 'H an answer after a brand switch never lands on the other brand\'s idea');
  ok(/id="tpHooksBtn" onclick="tpToggleHooks\(\)"/.test(html), 'H the teleprompter carries the toggle');

  if (fail) { console.log('\n' + fail + ' check(s) failed'); process.exit(1); }
  finished = true;
  console.log('\nUI V3 OK');
})().catch(e => { console.log('FAIL: gate crashed: ' + (e && e.stack || e)); process.exit(1); });
