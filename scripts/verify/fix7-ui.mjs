#!/usr/bin/env node
// GATE (fix7, leaf U): the seven core-path fixes in app.html / sw.js, EXECUTED — the real functions
// lifted from app.html (and sw.js's real notificationclick handler) run in node:vm against a fake DOM,
// a fake fetch and a fake PostgREST. See .unlazy/fix7/PLAN.md.
//   1  push link open=ideas&b=<brand>: switches to that brand if the user can open it, merges the morning
//      batch in from the DB (never replacing the list), Ideas on Pending from the top, params removed; sw.js
//      hands an already-open window the URL; back in the foreground after 30+ min the ideas are merged
//      again (debounced, brand-guarded, never while an ideas save is on the wire).
//   1b a list left open since yesterday can never delete the row the server saved overnight — even when
//      it holds an idea with the SAME title — while its own superseded copies are still cleaned up.
//   2  Plan my week = 7 by default.      3 Generate More really generates 3 pending versions (lean request),
//      one request per idea at a time, even across a re-render of the card.
//   4  "Mark as filmed?" after every way a take leaves the app; never for an unsaved Quick Post take.
//   5  "Film it now →" after a filmable Quick Post save: approves + opens the teleprompter with Mark Done.
//   6  writer hashtags saved as tags; Caption (with copy) shown for every format.
//   7  "Restore dismissed ideas" touches dismissed ideas only; Copy All Approved includes Done.
// RUN: node scripts/verify/fix7-ui.mjs      EXPECT: prints "FIX7 UI OK", exit 0.
import fs from 'node:fs'; import vm from 'node:vm';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
setTimeout(() => { console.log('FAIL: wall clock (60s) exceeded'); process.exit(2); }, 60000).unref();
let finished = false; process.on('exit', (code) => { if (!finished && code === 0) { console.log('FAIL: the gate ended before all checks ran'); process.exitCode = 1; } });
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
const lift = (c, names) => { for (const n of names) vm.runInContext(grab(n), c); };
const EMPH = ['tpEscape', 'tpOutsideTags', 'tpSenseLines', 'tpStressRx', 'tpEmphasise', 'tpPruneEmphasis', 'tpCleanEmphasis'];
const liftEmph = (c) => { lift(c, EMPH); for (const m of html.matchAll(/^const (TP_STRESS_[AB]) = .*$/gm)) vm.runInContext(m[0].replace(/^const /, 'var '), c); };

// ── fake DOM ──
function makeDom() {
  const els = {}; const created = [];
  function mk(id, extra) {
    const e = Object.assign({ id, value: '', innerHTML: '', textContent: '', className: '', disabled: false, attrs: {}, style: {}, dataset: {}, children: [],
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      getAttribute(k) { return this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; },
      appendChild(ch) { this.children.push(ch); return ch; }, querySelector() { return null; },
      pause() {}, load() {}, click() { this.clicked = (this.clicked || 0) + 1; }, focus() {}, scrollIntoView() { this.scrolled = (this.scrolled || 0) + 1; },
      remove() { if (els[this.id] === this) delete els[this.id]; this.removed = true; } }, extra || {});
    return e;
  }
  const cards = {};
  const document = {
    getElementById: id => els[id] || (/^tpSplit/.test(id) ? (els[id] = mk(id)) : null),
    createElement: (tag) => { const e = mk(''); e.tag = tag; created.push(e); return e; },
    body: { style: {}, appendChild(e) { if (e.id) els[e.id] = e; e.inBody = true; return e; }, removeChild() {} },
    querySelector: (sel) => { const m = /data-id="(\d+)"/.exec(sel); if (!m) return null; return (cards[m[1]] = cards[m[1]] || mk('card' + m[1])); },
    querySelectorAll: () => [],
  };
  return { els, created, mk, document, cards, put: (id, extra) => (els[id] = mk(id, extra)) };
}
// ── fake PostgREST (insert … .select() hands back the new rows' ids, as supabase-js does) ──
function makeDb(opts = {}) {
  const db = { rows: [], seq: 0, log: [] };
  db.add = (r) => { const row = Object.assign({ id: 'id-' + (++db.seq), created_at: new Date(Date.UTC(2026, 8, 1) + db.seq * 1000).toISOString() }, r); db.rows.push(row); return row; };
  db.from = () => {
    const q = { op: null, filters: [], payload: null, ret: null, order: null, range: null };
    const run = () => {
      db.log.push(q.op);
      if (q.op === 'insert') {
        const list = Array.isArray(q.payload) ? q.payload : [q.payload];
        const made = list.map(r => db.add(JSON.parse(JSON.stringify(r))));
        return { data: (q.ret && !opts.noReturn) ? made.map(r => ({ id: r.id, title: r.title })) : null, error: null };
      }
      const hit = db.rows.filter(r => q.filters.every(f => f(r)));
      if (q.op === 'delete') { for (const r of hit) db.rows.splice(db.rows.indexOf(r), 1); return { data: hit.map(r => ({ id: r.id })), error: null }; }
      let out = hit.slice(); if (q.order) out.sort((a, b) => (a[q.order[0]] < b[q.order[0]] ? -1 : 1) * q.order[1]); if (q.range) out = out.slice(q.range[0], q.range[1] + 1);
      return { data: out.map(r => JSON.parse(JSON.stringify(r))), error: null };
    };
    const b = { select(cols) { if (!q.op) q.op = 'select'; else q.ret = cols || '*'; return b; }, insert(p) { q.op = 'insert'; q.payload = p; return b; }, delete() { q.op = 'delete'; return b; },
      eq(k, v) { q.filters.push(r => r[k] === v); return b; }, in(k, vs) { q.filters.push(r => vs.includes(r[k])); return b; },
      order(k, x) { q.order = [k, x && x.ascending === false ? -1 : 1]; return b; }, range(a, z) { q.range = [a, z]; return b; },
      then(res, rej) { return Promise.resolve().then(run).then(r => db.delay ? db.delay(q, r) : r).then(res, rej); } };
    return b;
  };
  return db;
}
const baseCtx = (dom, extra) => Object.assign({
  console: { log() {}, warn() {}, error() {}, info() {} }, JSON, Promise, Date, Math, String, Number, Array, Object, Set, Map, RegExp, Error, TypeError, URL, AbortController,
  window: {}, state: [], IDEAS: [], currentBrand: { id: 'b1' }, _switchSeq: 0, document: dom.document,
  setTimeout: () => 0, clearTimeout() {}, lsSet: () => true, lsGet: () => null,
}, extra || {});

(async () => {
  // ═════════ 1b — a stale list can never delete the server's overnight row ═════════
  {
    const dom = makeDom(); const db = makeDb();
    const c = baseCtx(dom, { sb: db });
    vm.createContext(c); liftEmph(c);
    lift(c, ['_buildIdeaRows', '_saveIdeasToDBNow', 'normalizeIdeaStatus', '_ideaRowRecency', 'loadIdeasFromDB', 'reindexIdeas']);
    const load = async () => { const r = await c.loadIdeasFromDB(); c.state = r.map((x, i) => Object.assign({}, x, { id: i })); };
    const save = () => c._saveIdeasToDBNow('b1', c._buildIdeaRows('b1'));
    const byTitle = t => db.rows.filter(r => r.title === t);
    db.add({ brand_id: 'b1', title: 'Old A', script: 'a', status: 'pending', format: 'video' });
    db.add({ brand_id: 'b1', title: 'Old B', script: 'b', status: 'filming', format: 'video' });
    await load();                                              // yesterday: the app opens and is left open
    const P = db.add({ brand_id: 'b1', title: 'Push post', script: 'server', status: 'pending', format: 'video' });   // overnight: send-daily saves it
    c.state.find(x => x.title === 'Old A').status = 'filming'; await save();               // this morning: an approve on the stale list
    ok(byTitle('Push post').length === 1 && byTitle('Push post')[0].id === P.id, '1b the stale list\'s save leaves the server\'s overnight row alone');
    ok(byTitle('Old A').length === 1 && byTitle('Old A')[0].status === 'filming' && byTitle('Old B').length === 1, '1b ...and still replaces its own rows exactly once (no duplicates)');
    // the same stale device now ALSO holds an idea with that exact title (written locally before it synced)
    c.state.push({ id: c.state.length, title: 'Push post', script: 'local', status: 'pending', format: 'video' });
    await save();
    ok(db.rows.some(r => r.id === P.id), '1b even with the SAME title on the stale device, the server row it never loaded is not deleted');
    await save(); await save();
    ok(byTitle('Push post').length === 2 && byTitle('Old A').length === 1 && byTitle('Old B').length === 1,
      '1b repeated saves clean up this device\'s own previous copies (ids it wrote are known) — ' + byTitle('Push post').length + ' Push post rows');
    // control: the pre-fix rule (no known-ids record) deletes the server row in exactly this situation
    const db2 = makeDb(); const c2 = baseCtx(makeDom(), { sb: db2 }); vm.createContext(c2); liftEmph(c2); lift(c2, ['_buildIdeaRows', '_saveIdeasToDBNow']);
    const P2 = db2.add({ brand_id: 'b1', title: 'Push post', script: 'server', status: 'pending', format: 'video' });
    c2.state = [{ id: 0, title: 'Push post', script: 'local', status: 'pending', format: 'video' }];
    await c2._saveIdeasToDBNow('b1', c2._buildIdeaRows('b1'));
    ok(!db2.rows.some(r => r.id === P2.id), '1b [control] without the known-ids record (the old title rule) that same save DOES delete the server row');
    // a database that does not hand ids back: tracking switches off, the old rule applies, no duplicates pile up
    const db3 = makeDb({ noReturn: true }); const c3 = baseCtx(makeDom(), { sb: db3 }); vm.createContext(c3); liftEmph(c3);
    lift(c3, ['_buildIdeaRows', '_saveIdeasToDBNow', 'normalizeIdeaStatus', '_ideaRowRecency', 'loadIdeasFromDB']);
    db3.add({ brand_id: 'b1', title: 'Old A', script: 'a', status: 'pending', format: 'video' });
    const r3 = await c3.loadIdeasFromDB(); c3.state = r3.map((x, i) => Object.assign({}, x, { id: i }));
    await c3._saveIdeasToDBNow('b1', c3._buildIdeaRows('b1')); await c3._saveIdeasToDBNow('b1', c3._buildIdeaRows('b1'));
    ok(db3.rows.filter(r => r.title === 'Old A').length === 1 && !(c3._ideasKnownIds && c3._ideasKnownIds.b1), '1b no ids returned → falls back to the by-title rule, still exactly one copy');
  }

  // ═════════ 1 — the push opens Ideas (brand from b=, merged, never replaced) + foreground refresh ═════════
  {
    const dom = makeDom(); const db = makeDb(); const toasts = []; const views = []; const timers = []; const hist = []; const switched = []; let scrolledTop = 0;
    const c = baseCtx(dom, { sb: db, showToast: m => toasts.push(String(m)), switchView: v => views.push(v), renderNav() {}, renderStats() {}, renderIdeas() {}, activeView: 'today',
      expandedIds: new Set(), ideaStatusFilter: 'approved', activeFilter: 'Monday', activeFormat: 'carousel', allBrands: [{ id: 'b1' }, { id: 'b2' }],
      setTimeout: (f) => { timers.push(f); return timers.length; }, navigator: {}, location: { origin: 'https://contentshrimp.com' },
      notifyIdeasSaveFailed() {} });
    c.switchBrand = async (id) => { switched.push(id); c.currentBrand = { id }; c._switchSeq++; const r = await c.loadIdeasFromDB(); c.state = r.map((x, i) => Object.assign({}, x, { id: i })); };
    c.window = { location: { href: '' }, history: { replaceState: (a, b, u) => hist.push(u) }, scrollTo: () => { scrolledTop++; } };
    vm.createContext(c); liftEmph(c);
    lift(c, ['normalizeIdeaStatus', '_ideaRowRecency', 'loadIdeasFromDB', 'reindexIdeas', 'brandGate', 'csReadOpen', 'csStripOpenParams', 'csReloadIdeasMerge', 'csOpenPushIdeas', 'csHandleOpenIdeas',
      'csOnVisibility', 'csForegroundReload', '_buildIdeaRows', '_saveIdeasToDBNow', 'saveIdeasToDB']);
    vm.runInContext('var CS_FG_AWAY_MS = 30 * 60 * 1000; var _ideasSaveChain = Promise.resolve(); var _lastIdeasSave = null;', c);
    const selects = () => db.log.filter(x => x === 'select').length;
    const seed = () => { db.rows.length = 0;
      ['A', 'Batch 1', 'Batch 2'].forEach(t => db.add({ brand_id: 'b1', title: t, status: 'pending', format: 'video', script: 's' }));
      ['B2 one', 'B2 two'].forEach(t => db.add({ brand_id: 'b2', title: t, status: 'pending', format: 'video', script: 's' })); };
    const reset = (st) => { seed(); c.currentBrand = { id: 'b1' }; c.state = st.map((t, i) => ({ id: i, title: t, status: 'pending', format: 'video', script: 'local' }));
      views.length = 0; toasts.length = 0; timers.length = 0; hist.length = 0; db.log.length = 0; switched.length = 0; scrolledTop = 0; dom.put('view-ideas');
      c.window._csAppReady = true; c.window._csFgReloadAt = 0; c._ideasSavesInFlight = 0;
      vm.runInContext('ideaStatusFilter = "approved"; activeFilter = "Monday"; activeFormat = "carousel";', c); };
    // cold open with another brand the user can open
    reset(['A', 'Local only']); c.window.location.href = 'https://contentshrimp.com/app.html?open=ideas&b=b2&x=1';
    c.csHandleOpenIdeas(c.window.location.href, true); await tick(); timers.forEach(f => f());
    ok(J(switched) === J(['b2']) && c.currentBrand.id === 'b2' && J(c.state.map(x => x.title).sort()) === J(['B2 one', 'B2 two']), '1 b= names another brand the user can open → switched to it (existing switchBrand)');
    ok(J(views) === J(['ideas']) && c.ideaStatusFilter === 'pending' && c.activeFilter === 'all' && c.activeFormat === 'all' && scrolledTop === 1,
      '1 ...Ideas on the Pending filter, filters cleared, from the top');
    ok(J(hist) === J(['/app.html?x=1']), '1 open= and b= are removed from the address (other params kept): ' + J(hist));
    // the current brand: the batch is merged in, the device's own unsaved idea is kept
    reset(['A', 'Local only']);
    c.csHandleOpenIdeas('https://contentshrimp.com/app.html?open=ideas&b=b1', false); await tick();
    ok(switched.length === 0 && selects() === 1 && J(c.state.map(x => x.title).slice(0, 2)) === J(['A', 'Local only']) && J(c.state.slice(2).map(x => x.title).sort()) === J(['Batch 1', 'Batch 2']) && c.state[0].script === 'local' && c.state[1].script === 'local' && c.state[3].id === 3,
      '1 same brand: one DB read, the morning batch ADDED, nothing on this device replaced or dropped');
    ok(J(views) === J(['ideas']), '1 ...and Ideas opens');
    // a brand this user cannot open → current brand
    reset(['A']); c.csHandleOpenIdeas('https://contentshrimp.com/app.html?open=ideas&b=b9', false); await tick();
    ok(switched.length === 0 && c.currentBrand.id === 'b1' && J(views) === J(['ideas']) && c.state.length === 3, '1 b= not accessible → Ideas on the current brand, no switch');
    // the old link (open=idea&t=) still lands in Ideas
    reset(['A']); c.csHandleOpenIdeas('https://contentshrimp.com/app.html?open=idea&t=Old%20title', false); await tick();
    ok(J(views) === J(['ideas']) && switched.length === 0, '1 the old open=idea&t= link just opens Ideas');
    reset(['A']); c.csHandleOpenIdeas('https://contentshrimp.com/app.html?x=1', false); await tick();
    ok(views.length === 0 && selects() === 0, '1 no open= → nothing happens');
    // a link arriving before the app finished loading is kept and handled when it is ready
    reset(['A']); c.window._csAppReady = false; c.window.location.href = 'https://contentshrimp.com/app.html';
    c.csHandleOpenIdeas('https://contentshrimp.com/app.html?open=ideas&b=b2', false);
    ok(views.length === 0 && c.window._csPendingOpen && c.window._csPendingOpen.brand === 'b2', '1 early: kept until the app is ready');
    c.window._csAppReady = true; c.csHandleOpenIdeas(c.window.location.href, true); await tick();
    ok(J(switched) === J(['b2']) && J(views) === J(['ideas']) && !c.window._csPendingOpen, '1 ...then handled once initApp is done');
    // sw.js: an open window is focused AND handed the URL; the app's listener opens Ideas
    const handlers = {}; const posted = []; let focused = 0; const opened = [];
    const swCtx = { self: { addEventListener: (k, f) => { handlers[k] = f; }, registration: { showNotification() {} }, skipWaiting() {} },
      clients: { matchAll: async () => [{ url: 'https://contentshrimp.com/app.html', focus: async () => { focused++; }, postMessage: m => posted.push(m) }], openWindow: async u => opened.push(u), claim() {} },
      caches: {}, fetch() {}, console: { log() {}, warn() {}, error() {} }, Response: class {}, URL, Promise, setTimeout, clearTimeout };
    vm.createContext(swCtx); vm.runInContext(swSrc, swCtx);
    let waited = null;
    handlers.notificationclick({ notification: { close() {}, data: { url: '/app.html?open=ideas&b=b1' } }, waitUntil: p => { waited = p; } });
    await waited;
    ok(focused === 1 && opened.length === 0 && J(posted) === J([{ type: 'cs-open-url', url: '/app.html?open=ideas&b=b1' }]), 'sw.js: an already-open app is focused and handed the push URL');
    let listener = null, visL = null;
    c.navigator = { serviceWorker: { addEventListener: (k, f) => { if (k === 'message') listener = f; } } };
    c.document.addEventListener = (k, f) => { if (k === 'visibilitychange') visL = f; };
    vm.runInContext(between("try { if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('visibilitychange', csOnVisibility)", '\nfunction dismissCsSplash'), c);
    reset(['A']); listener({ data: posted[0] }); await tick();
    ok(J(views) === J(['ideas']) && c.state.length === 3, '1 the open app hears sw.js: Ideas opens with the batch merged in');
    const initSrc = grab('initApp');
    ok(/csHandleOpenIdeas\(window\.location\.href, true\)/.test(initSrc) && initSrc.indexOf('csHandleOpenIdeas') > initSrc.indexOf('loadIdeasFromDB()'), '1 initApp handles the link after the ideas have loaded');
    // foreground after > 30 min away
    const back = (awayMin) => { c.document.visibilityState = 'hidden'; visL(); c.window._csHiddenAt = Date.now() - awayMin * 60000; c.document.visibilityState = 'visible'; visL(); };
    reset(['A']); back(31); await tick();
    ok(selects() === 1 && c.state.length === 3 && /2 new ideas in Ideas/.test(toasts.join('|')), '1 back after 31 min: the ideas are re-read and the morning batch merged in (toast)');
    db.log.length = 0; back(45); await tick();
    ok(selects() === 0, '1 debounced: a second return within a minute does not read again');
    reset(['A']); back(5); await tick();
    ok(selects() === 0 && c.state.length === 1, '1 back after 5 min: no reload');
    reset(['A']); const realFrom = db.from; db.from = (...a) => { c.currentBrand = { id: 'b2' }; return realFrom(...a); };
    back(40); await tick(); db.from = realFrom;
    ok(c.state.length === 1 && toasts.length === 0, '1 brand-guarded: a brand switch during the read adds nothing');
    // never during an in-flight ideas save (the real saveIdeasToDB counter), retried after
    reset(['A']); c.state[0].status = 'filming'; c.saveIdeasToDB();
    ok(c._ideasSavesInFlight === 1, '1 saveIdeasToDB counts the save on the wire');
    back(40);
    ok(selects() === 0 && timers.length === 1, '1 no reload while the save is on the wire (a retry is scheduled)');
    await tick(30);
    ok(c._ideasSavesInFlight === 0, '1 ...the count drops when the save settles');
    db.log.length = 0; timers.shift()(); await tick();
    ok(selects() === 1 && c.state.length === 3, '1 ...and the retry then merges the batch');
    // a save that STARTS while the merge-reload is reading: its new ids must stay known
    reset([]); const L = await c.loadIdeasFromDB(); c.state = L.map((x, i) => Object.assign({}, x, { id: i }));
    let releaseLoad; const held = new Promise(r => { releaseLoad = r; });
    db.delay = (q, r) => q.order ? held.then(() => r) : r;              // the reload's read is taken now, answered later
    c.state.push({ id: 3, title: 'Local new', status: 'pending', format: 'video', script: 'x' });
    const merging = c.csReloadIdeasMerge(); await tick();
    c.state.find(x => x.title === 'A').status = 'filming';
    await c._saveIdeasToDBNow('b1', c._buildIdeaRows('b1'));            // the save runs to the end meanwhile
    db.delay = null; releaseLoad(); await merging; await tick();
    const b1ids = db.rows.filter(r => r.brand_id === 'b1').map(r => r.id);
    ok(b1ids.every(id => c._ideasKnownIds.b1.has(id)), '1 a save that started during the reload keeps its new ids known (the reload only adds ids)');
    await c._saveIdeasToDBNow('b1', c._buildIdeaRows('b1'));
    const counts = ['A', 'Batch 1', 'Batch 2', 'Local new'].map(t => db.rows.filter(r => r.brand_id === 'b1' && r.title === t).length);
    ok(J(counts) === J([1, 1, 1, 1]), '1 ...so the next save leaves exactly one copy of each post: ' + J(counts));
  }

  // ═════════ 2 — Plan my week = 7 ═════════
  {
    // types (2026-09-29): the count dropdown was replaced by the per-type mix steppers — the mix TOTAL is the
    // count, and the default mix adds up to seven (types-ui.mjs executes the steppers themselves).
    const dm = /^const DEFAULT_TYPE_MIX = (\{[^}]*\});/m.exec(html);
    const dmTot = dm ? Object.values(Function('return ' + dm[1])()).reduce((a, b) => a + b, 0) : -1;
    ok(!/id="generateCount"/.test(html) && dmTot === 7, '2 the default mix (the count) adds up to 7: ' + dmTot);
    ok(/const count = _typeMix \? typesMixTotal\(_typeMix\) : 7;/.test(grab('generateNewIdeas')), '2 the generator uses the mix total and falls back to 7 too');
    ok(/Seven days of posts/.test(html) && /a 7-day plan/.test(html), '2 the card ("Seven days") and the empty state ("7-day plan") now match what is generated');
  }

  // ═════════ 3 — Generate More ═════════
  {
    const dom = makeDom(); const toasts = []; const calls = []; let clip = 0; let route = null; let saves = 0;
    const fetch = async (url, init) => { const body = JSON.parse(init.body); calls.push({ url, body }); const r = await route(url, body); if (r instanceof Error) throw r;
      const t = JSON.stringify(r.body); return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => t, json: async () => JSON.parse(t), clone() { return this; } }; };
    const c = baseCtx(dom, { fetch, showToast: m => toasts.push(String(m)), navigator: { clipboard: { writeText: () => { clip++; return Promise.resolve(); } } },
      flushBrandSave: async () => {}, getBrandContext: () => ({ brandName: 'Salt Co', usps: 'BIG BRAND BRAIN '.repeat(200) }), getRecentTrends: () => [], _humanEditedTitles: () => [],
      getTodayName: () => 'Monday', getDayCommunities: () => ({ Monday: 'Myth Monday' }), saveState() { saves++; }, renderNav() {}, renderStats() {}, renderIdeas() {},
      activeView: 'ideas', ICO: { spark: '*' } });
    vm.createContext(c);
    lift(c, ['brandGate', 'leanBrandFetch', '_leanNetFail', '_leanErrMsg', 'humanErr', 'csAiPausedText', '_tvBcFieldCount', 'rv2TagFlow', '_gmKey', '_gmIsBusy', 'generateMore']);
    vm.runInContext('var _gmBusy = new Set();', c);
    const base = () => [{ id: 0, title: 'Salt is not the enemy', hook: 'Salt is fine', script: 'Most people fear salt.', format: 'micro', day: 'Tuesday', community: 'Myth Tuesday', status: 'pending' }];
    const three = [{ title: 'V1', hook: 'h1', script: 's1', format: 'micro', day: 'Tuesday' }, { title: 'V2', hook: 'h2', script: 's2', format: 'micro' }, { title: 'V3', hook: 'h3', script: 's3', format: 'micro', belief: 'Salt helps' }];
    const btn = () => dom.mk('b', { innerHTML: '* Generate More' });
    c.state = base(); route = () => ({ status: 200, body: { ideas: three } }); let b = btn(); saves = 0;
    await c.generateMore(0, b); await tick();
    const rq = calls[0] && calls[0].body;
    ok(calls.length === 1 && calls[0].url === '/api/generate-ideas' && rq.count === 3 && rq.gaps[0].format === 'micro' && rq.exFormat === 'micro' && rq.brandId === 'b1'
      && !('usps' in (rq.brandContext || {})) && /3 NEW VARIATIONS/.test(rq.learningContext) && /Salt is not the enemy/.test(rq.learningContext), '3 one lean /api/generate-ideas request for 3 variations, same format');
    const added = c.state.slice(1);
    ok(added.length === 3 && added.every((x, n) => x.status === 'pending' && x.id === n + 1 && x.format === 'micro' && x.isGenerated && x.freshAt && x.community) && added[2].genFlow === 'v2-batch',
      '3 the 3 versions are added to Ideas as pending (ids = positions, "Just generated")');
    ok(saves === 1 && J(toasts) === J(['3 new versions added']) && clip === 0 && !b.disabled && /Generate More/.test(b.innerHTML), '3 saved, toast "3 new versions added", no clipboard, button back');
    c.state = base(); calls.length = 0; toasts.length = 0; route = () => ({ status: 200, body: { ideas: [{ title: 'salt is not the enemy' }, three[0], three[1]] } });
    await c.generateMore(0, btn()); await tick();
    ok(c.state.length === 3 && J(toasts) === J(['2 new versions added']), '3 a repeat title is dropped (the save replaces rows by title)');
    c.state = base(); toasts.length = 0; route = () => ({ status: 402, body: { error: 'limit_reached' } }); b = btn();
    await c.generateMore(0, b); await tick();
    ok(c.state.length === 1 && J(toasts) === J(["You've used up this month's posts — upgrade to keep going."]) && !b.disabled, '3 402: nothing added, plain words (the global 402 handler opens the upgrade sheet)');
    c.state = base(); toasts.length = 0; route = () => ({ status: 500, body: { error: 'internal_error' } });
    await c.generateMore(0, btn()); await tick();
    ok(c.state.length === 1 && J(toasts) === J(["Couldn't write new versions just now — try again."]), '3 server error: a person-readable line, never a machine code');
    c.state = base(); toasts.length = 0; route = () => { c.currentBrand = { id: 'b2' }; return { status: 200, body: { ideas: three } }; };
    await c.generateMore(0, btn()); await tick(); c.currentBrand = { id: 'b1' };
    ok(c.state.length === 1 && /switched brand/.test(toasts[0] || ''), '3 a brand switch mid-request adds nothing');
    // in flight: a re-rendered (fresh, enabled) button cannot start a second paid request
    c.state = base(); toasts.length = 0; let release; route = () => new Promise(r => { release = () => r({ status: 200, body: { ideas: three } }); });
    const before = calls.length; const b1 = btn(); const p1 = c.generateMore(0, b1); await tick();
    ok(c._gmIsBusy(c.state[0]) && b1.disabled, '3 while writing, the idea is marked busy');
    const b2 = btn();   // a fresh, ENABLED button (what a re-render used to produce)
    const b3 = dom.put('gmBtn-0', { innerHTML: 'Writing 3 versions…', disabled: true });   // the card as re-rendered now (busy)
    await c.generateMore(0, b2); await tick();
    ok(calls.length === before + 1 && /Already writing/.test(toasts.join('|')), '3 a second tap on the re-rendered button sends NO second request');
    release(); await p1; await tick();
    ok(c.state.length === 4 && !c._gmIsBusy(c.state[0]) && !b3.disabled && /Generate More/.test(b3.innerHTML), '3 when it finishes: 3 added once, the busy mark cleared, the live button restored');
    c.state = []; toasts.length = 0; const nCalls = calls.length; await c.generateMore(5, btn());
    ok(toasts.length === 1 && calls.length === nCalls, '3 a stale id is refused without a request');
  }

  // ═════════ 4 — Mark as filmed? ═════════
  {
    const dom = makeDom(); const toasts = []; let shareMode = 'ok', inert = false, closes = 0, refills = 0;
    const c = baseCtx(dom, { showToast: m => toasts.push(String(m)), saveState() {}, renderPipeline() {}, renderNav() {}, mascotReact() {}, autoRefillCheck() { refills++; },
      tpFormatScript: t => t, tpPrimer: () => '', nl2br: t => t, tpSetSmartSpeed() {}, tpEnsureCamera() {}, TP_VOICE_SUPPORTED: false, tpVoiceEnabled: () => false, tpFontSize: 32,
      closeTeleprompter() { closes++; }, tpReleaseTake() {}, _tpDownloadsInert: () => inert, tvNoIdea() {}, tvActiveIdea: () => ({ title: 'QP', script: 'quick post script', format: 'video' }),
      File: class { constructor(p, n, o) { this.name = n; this.type = o && o.type; } }, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
      navigator: { canShare: () => shareMode !== 'none', share: () => shareMode === 'ok' ? Promise.resolve() : Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' })) } });
    ['tpTitle', 'tpBody', 'teleprompterOverlay', 'tpDoneBtn'].forEach(id => dom.put(id));
    vm.createContext(c);
    lift(c, ['escHtml', 'reindexIdeas', 'moveStage', 'tpSyncDoneBtn', 'openTeleprompter', 'tvOpenTeleprompter', '_tpShareCancelled', 'tpCanDeliver', 'tpShareOrSave',
      'tpDownloadBlob', 'tpRescueTake', 'tpSplitResult', 'tpAskMarkFilmed', 'tpFilmedAnswer']);
    vm.runInContext('var _tpIdeaId = null;', c);
    const blob = { type: 'video/webm', size: 10 };
    const fresh = () => { c.state = [{ id: 0, title: 'Pending one', status: 'pending', format: 'video', day: 'Monday', script: 's' }, { id: 1, title: 'In <b>Pipeline</b>', status: 'filming', format: 'video', day: 'Monday', script: 's' },
      { id: 2, title: 'Already done', status: 'done', format: 'video', script: 's' }]; toasts.length = 0; delete dom.els.tpFilmedAsk; refills = 0; };
    const asked = () => !!(dom.els.tpFilmedAsk && /Mark as filmed\?/.test(dom.els.tpFilmedAsk.innerHTML));
    fresh(); shareMode = 'ok'; c.openTeleprompter(1); c.tpShareOrSave(blob, 't.webm'); await tick();
    ok(asked() && /In &lt;b&gt;Pipeline/.test(dom.els.tpFilmedAsk.innerHTML), '4 shared from the share sheet → "Mark as filmed?" (title escaped)');
    c.tpFilmedAnswer(true);
    ok(c.state[1].status === 'done' && c.state[1].doneAt && toasts.includes('Marked done ✓') && !dom.els.tpFilmedAsk, '4 Yes → Done, exactly like tpMarkDone (moveStage + "Marked done ✓")');
    fresh(); shareMode = 'none'; inert = false; c.openTeleprompter(0); c.tpShareOrSave(blob, 't.webm'); await tick();
    ok(asked(), '4 saved as a download → asked');
    c.tpFilmedAnswer(false);
    ok(c.state[0].status === 'pending' && !dom.els.tpFilmedAsk, '4 Not yet → closes, nothing changes');
    c.tpDownloadBlob(blob, 't.webm');
    ok(!dom.els.tpFilmedAsk, '4 one question per take (a second save of the same take does not ask again)');
    fresh(); shareMode = 'ok'; c.openTeleprompter(1); c.tvOpenTeleprompter(); c.tpShareOrSave(blob, 't.webm'); await tick();
    ok(!dom.els.tpFilmedAsk, '4 an unsaved Quick Post take (classic teleprompter) is never asked');
    fresh(); c.openTeleprompter(2); c.tpShareOrSave(blob, 't.webm'); await tick();
    ok(!dom.els.tpFilmedAsk, '4 a post already Done is never asked');
    // split screen: share, and save to phone
    const bd = () => ({ querySelector: () => dom.mk('sheet'), remove() {} });
    fresh(); shareMode = 'ok'; c.openTeleprompter(1); c.tpSplitResult(bd(), blob, 'mp4', blob, 'raw.webm', ''); await dom.els.tpSplitShare.onclick(); await tick();
    ok(asked(), '4 split screen "Share it →" → asked');
    fresh(); c.openTeleprompter(0); c.tpSplitResult(bd(), blob, 'mp4', blob, 'raw.webm', ''); dom.els.tpSplitDl.onclick(); await tick();
    ok(asked(), '4 split screen "Save to my phone" → asked');
    // rescue sheet: the device cannot share or download → asked only once they say they saved it
    fresh(); shareMode = 'none'; inert = true; c.openTeleprompter(1); dom.created.length = 0; c.tpShareOrSave(blob, 't.webm'); await tick();
    ok(!!dom.els.tpRescue && !dom.els.tpFilmedAsk, '4 rescue sheet shown, not asked yet');
    const savedBtn = dom.els.tpRescue.children.find(x => x.textContent === 'I saved it — close');
    savedBtn.onclick();
    ok(asked(), '4 rescue sheet "I saved it — close" → asked');
    // share cancelled → rescue (not a delivery) → no question until saved
    fresh(); shareMode = 'cancel'; inert = false; c.openTeleprompter(1); c.tpShareOrSave(blob, 't.webm'); await tick();
    ok(!dom.els.tpFilmedAsk && !!dom.els.tpRescue, '4 a cancelled share sheet does not count as shared');
  }

  // ═════════ 5 + 6 — Quick Post: Film it now, hashtags → tags ═════════
  {
    const dom = makeDom(); const toasts = []; const calls = []; let route; const tp = []; let refills = 0, approveSheet = 0, saves = 0;
    async function fetch(url, init) { const body = init && init.body ? JSON.parse(init.body) : null; calls.push({ url, body }); const r = await route(url, body);
      const t = JSON.stringify(r.body || {}); return { ok: r.status >= 200 && r.status < 300, status: r.status, url, text: async () => t, json: async () => JSON.parse(t), clone() { return this; } }; }
    const c = baseCtx(dom, { fetch, currentBrand: { id: 'brand-1' }, showToast: (m) => toasts.push(String(m)), btnWork: () => () => {}, flushBrandSave: async () => {}, getBrandContext: () => ({ brandName: 'X' }),
      _humanEditedTitles: () => [], saveState() { saves++; }, saveGeneratedIdeas() { return Promise.resolve({ ok: true }); }, DELIVERY_FORMATS: new Set(['video', 'micro', 'qna', 'statement']), saveIdeasToDB() {},
      renderNav() {}, switchView() {}, mascotReact() {}, refreshCurrentView() {}, renderRemixResults() {}, openTeleprompter: (id) => tp.push(id), autoRefillCheck() { refills++; }, showApprovePopupFn() { approveSheet++; },
      notebookNotes: [{ id: 'n1', text: 'A note about salt that is long enough.' }], nbDevelop() {}, ideaDevelop() {}, usePAAQuestion() {}, generateTodayTabPost() {}, paaQuestions: [], paaUsed: new Set(),
      savePAAState() {}, renderPAASection() {}, refShotClear() {}, icDraftClear() {}, firstRunBrandGuard: () => false, getTodayName: () => 'Monday', getDayCommunities: () => ({ Monday: 'Myth Monday' }), DAYS: ['Monday'],
      lsSet: () => true, lsGet: () => null, lsDel() {} });
    vm.createContext(c);
    lift(c, ['escapeHtml', 'escHtml', 'humanErr', '_leanNetFail', '_leanErrMsg', 'csAiPausedText', '_tvBcFieldCount', 'brandGate', 'asText', 'reindexIdeas', '_buildIdeaRows']);
    liftEmph(c);
    vm.runInContext(between('/* v693 — REMIX, REBUILT', '\nfunction removeRemix(idx) {').replace(/^(let|const) /gm, 'var '), c);
    const ANG = [{ id: 'a1', belief: 'Salt is not the enemy', why: 'w' }];
    let IDEA = { title: 'Salt is fine', hook: 'Salt is fine.', script: 'Everyone fears salt.\n\nThey should not.', onScreen: [], caption: 'Salt, explained.', shots: 'Talking head', emphasis: [], hashtags: ['#Hydration', 'salt', ' #salt ', '#sports drinks'] };
    route = (u, b) => u === '/api/angles' ? { status: 200, body: { angles: ANG } } : u === '/api/write' ? { status: 200, body: { idea: Object.assign({}, IDEA, { format: b.format }) } } : { status: 200, body: {} };
    const reset = () => { calls.length = 0; toasts.length = 0; tp.length = 0; refills = 0; approveSheet = 0; for (const k of Object.keys(dom.els)) delete dom.els[k];
      vm.runInContext('rv2SetRun("rv2Panel", null); rv2SetRun("rv2Sheet", null); state = []; IDEAS = []; window = {}; currentBrand = { id: "brand-1" };', c); };
    const quick = async (fmt) => { reset(); c.window._tvSelectedFormat = fmt; await c.tvGenerateV2(); await tick(); await c.rv2Pick(0); await tick(); const r = await c.rv2Save(); await tick(); return r; };
    let saved = await quick('video');
    ok(saved && saved.status === 'pending' && dom.els.rv2FilmNow && /Film it now →/.test(dom.els.rv2FilmNow.innerHTML) && /Salt is fine/.test(dom.els.rv2FilmNow.innerHTML), '5 a saved video Quick Post offers "Film it now →"');
    ok(saved.tags === '#hydration #salt #sportsdrinks', '6 the writer\'s hashtags are saved as tags in the app\'s format: ' + J(saved.tags));
    ok(c._buildIdeaRows('brand-1')[0].tags === '#hydration #salt #sportsdrinks' && c._buildIdeaRows('brand-1')[0].caption === 'Salt, explained.', '6 ...and reach the database row (tags + caption)');
    saves = 0; c.rv2FilmNow();
    const st = c.state[0];
    ok(st.status === 'filming' && st.approvedAt && st.dismissReason === null && saves === 1 && J(tp) === J([0]) && !dom.els.rv2FilmNow,
      '5 Film it now: approved (filming, saved) and the teleprompter opens on that post');
    ok(approveSheet === 0 && refills === 0, '5 ...without the approve-reason sheet and without a paid auto-refill');
    for (const f of ['micro', 'qna']) { saved = await quick(f); ok(!!dom.els.rv2FilmNow, '5 filmable ' + f + ' offers it too'); }
    saved = await quick('statement'); ok(saved && !!dom.els.rv2FilmNow, '5 statement (filmable) offers it');
    saved = await quick('carousel'); ok(saved && saved.format === 'carousel' && !dom.els.rv2FilmNow, '5 a carousel is not filmable: no button');
    reset(); await c.nbDevelopV2('n1', dom.mk('nb')); await tick(); await c.rv2Pick(0); await tick(); saved = await c.rv2Save(); await tick();
    ok(saved && !dom.els.rv2FilmNow, '5 only the Quick Post sheet offers it (a Notebook develop does not)');
    saved = await quick('video'); vm.runInContext('currentBrand = { id: "brand-2" };', c); c.rv2FilmNow();
    ok(c.state[0].status === 'pending' && tp.length === 0 && /Switch back/.test(toasts.join('|')), '5 another brand open: nothing approved, no teleprompter');
    IDEA = Object.assign({}, IDEA); delete IDEA.hashtags; saved = await quick('video');
    ok(saved.tags === '', '6 no hashtags from the writer → empty tags (never invented)');
    ok(c.rv2Tags('#One two,three') === '#one #two #three' && c.rv2Tags(null) === '', '6 rv2Tags also reads a plain string');
  }

  // ═════════ 6 — Caption shown for every format ═════════
  {
    const dom = makeDom();
    const c = baseCtx(dom, { ICO: { film: '', sharpen: '', zap: '', redo: '', spark: '' }, STMT_TPL_NAMES: ['a', 'b', 'c'], stmtTpl: 0 });
    vm.createContext(c); lift(c, ['escHtml', 'escJs', 'nl2br', 'asText', 'sectionCopyBtn', 'renderDetailContent']);
    const vid = c.renderDetailContent({ id: 3, title: 't', format: 'video', script: 's', shots: 'x', tags: '#a', caption: 'Price <b>is</b> not quality', status: 'pending' });
    ok(/Caption <button class="section-copy-btn"[^>]*copyText\('Price \\x3Cb>is\\x3C\/b> not quality'/.test(vid) && /detail-text caption">Price &lt;b&gt;is&lt;\/b&gt; not quality/.test(vid),
      '6 a video shows its Caption with a copy button (escaped)');
    const car = c.renderDetailContent({ id: 4, title: 't', format: 'carousel', script: 's', boldText: 'Slide 1: x', shots: 'x', tags: '#a', caption: 'Swipe it', status: 'filming' });
    ok(/detail-label">Caption/.test(car) && /Tags/.test(vid), '6 ...and so does every other format; Tags stays');
    c._gmIsBusy = () => true;
    const busy = c.renderDetailContent({ id: 7, title: 't', format: 'video', script: 's', shots: 'x', tags: '', status: 'pending' });
    c._gmIsBusy = () => false;
    const idle = c.renderDetailContent({ id: 7, title: 't', format: 'video', script: 's', shots: 'x', tags: '', status: 'pending' });
    ok(/id="gmBtn-7" disabled/.test(busy) && !/id="gmBtn-7" disabled/.test(idle) && /Writing 3 versions…/.test(busy) && /Generate More/.test(idle),
      '3 a card re-rendered mid-request keeps Generate More disabled, showing "Writing 3 versions…"');
    const none = c.renderDetailContent({ id: 5, title: 't', format: 'video', script: 's', shots: 'x', tags: '', caption: '', status: 'pending' });
    ok(!/Caption/.test(none), '6 no caption → no empty Caption box');
  }

  // ═════════ 7 — Restore dismissed ideas / Copy All Approved ═════════
  {
    const dom = makeDom(); let asked = null, answer = true, clip = null; const toasts = []; let saves = 0;
    const c = baseCtx(dom, { confirm: (m) => { asked = m; return answer; }, saveState() { saves++; }, renderNav() {}, refreshCurrentView() {}, showToast: m => toasts.push(m),
      settings: { brandName: 'Salt' }, FORMAT_LABELS: { video: 'Video' }, STAGE_LABELS: { filming: 'Film & Post', done: 'Done' }, alert() {},
      navigator: { clipboard: { writeText: (t) => { clip = t; return Promise.resolve(); } } }, copyFallback() {} });
    vm.createContext(c); lift(c, ['resetAll', 'exportApproved']);
    const mk = () => [{ id: 0, title: 'P', status: 'pending' }, { id: 1, title: 'F', status: 'filming' }, { id: 2, title: 'D', status: 'done', doneAt: 5 },
      { id: 3, title: 'X', status: 'dismissed', dismissReason: 'Too salesy' }, { id: 4, title: 'Y', status: 'dismissed', dismissReason: 'Off-brand' }];
    c.state = mk(); c.resetAll();
    ok(J(c.state.map(i => i.status)) === J(['pending', 'filming', 'done', 'pending', 'pending']) && c.state[3].dismissReason === null && c.state[2].doneAt === 5 && saves === 1,
      '7 only dismissed ideas go back to pending (reason cleared); Film & Post and Done untouched');
    ok(/2 dismissed ideas back into Ideas as pending/.test(asked) && /Film & Post and Done are not touched/.test(asked), '7 the confirm says exactly that: ' + asked);
    c.state = mk(); answer = false; saves = 0; c.resetAll();
    ok(c.state[3].status === 'dismissed' && saves === 0, '7 cancel changes nothing');
    ok(/onclick="resetAll\(\)">Restore dismissed ideas<\/button>/.test(html) && !/>Reset All</.test(html), '7 the button is labelled "Restore dismissed ideas"');
    c.state = mk().map(i => Object.assign(i, { day: 'Monday', format: 'video', script: 's', shots: 'x', tags: '#t' })); c.exportApproved(); await tick();
    ok(clip && /\] F \[/.test(clip) && /\] D \[DONE\]/.test(clip) && !/\] P \[/.test(clip), '7 Copy All Approved includes Done posts (the Approved count does)');
  }

  finished = true;
  if (fail) { console.log('\n' + fail + ' check(s) failed'); process.exit(1); }
  console.log('\nFIX7 UI OK');
})().catch(e => { finished = true; console.log('FAIL: crashed:', e && e.stack || e); process.exit(1); });
