#!/usr/bin/env node
// GATE (v720): saves send only what changed. Before v720 every save replaced whole lists (write the local copy,
// delete the old rows) and whole brand rows, so a device with a stale copy undid another device's work
// (audit H-1/H-2, G-6/G-7). BEHAVIOURAL, node-only (no browser, no network, no AI): the REAL save/load
// functions lifted from app.html run in two separate "devices" (vm contexts) against ONE in-memory
// PostgREST-like database that validates columns, enforces UNIQUE (brand_id, client_key), fills the
// v720 column defaults and refuses a team member's deletes (as RLS does).
//   1  ideas, two devices: A approves X while B (stale) edits Y, and B edits X's script — every change survives;
//      B sends only the changed columns; no duplicate rows; a team member's save adds no copies.
//   2  B saving a stale list never deletes A's new idea / note / bookmark.
//   3  an explicit delete removes only that item (idea tombstone, nbDelete, a bookmark entry); a stale device
//      does not bring it back.
//   4  notebook and bookmarks: the same two-device cases (incl. B saving twice).
//   5  brand: A changes the tagline, B the audience — both survive; voice_extra is merged key by key.
//   6  fallback: without the v720 columns the old save still saves correctly and never names client_key;
//      a backend that accepts any column (a stub) is not trusted.
//   7  first_created_at is never sent and never overwritten; the morning batch's key-less insert is handled.
//   8  the merge-reload takes the server's columns but keeps this device's own unsaved edits.
//   9  sql/saves-v720.sql is idempotent and safe (lint): if not exists everywhere, drop-before-create policies,
//      backfill only where null, no delete/drop/truncate, no new function.
//  10  the Ideas list groups by first_created_at when present (awWhen).
// RUN: node scripts/verify/saves-v720.mjs      EXPECT: prints "SAVES V720 OK", exit 0.
import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
let finished = false; process.on('exit', (code) => { if (!finished && code === 0) { console.log('FAIL: the gate ended before all checks ran'); process.exitCode = 1; } });
let fail = 0; const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('ok:', m); };

const grab = n => {
  let i = html.indexOf('\nfunction ' + n + '('); if (i < 0) i = html.indexOf('\nasync function ' + n + '(');
  if (i < 0) throw new Error('no ' + n + ' in app.html');
  const eol = html.indexOf('\n', i + 1), first = html.slice(i + 1, eol);
  let d = 0, seen = false; for (const ch of first) { if (ch === '{') { d++; seen = true; } else if (ch === '}') d--; }
  if (seen && d === 0) return first;
  return html.slice(i + 1, html.indexOf('\n}', i) + 2);
};
const BLOCK = (() => {
  const a = html.indexOf('/* ═════════════════════ v720 — SAVES SEND ONLY WHAT CHANGED');
  const b = html.indexOf('/* ═══════════════════ end v720 ═══════════════════ */');
  if (a < 0 || b < a) throw new Error('the v720 block markers are missing from app.html');
  return html.slice(a, b);
})();
const LIFT = ['_replaceBrandRows', '_buildIdeaRows', '_saveIdeasToDBNow', 'saveIdeasToDB', 'normalizeIdeaStatus', '_ideaRowRecency',
  'loadIdeasFromDB', 'reindexIdeas', 'csReloadIdeasMerge', 'saveNotebookToDB', 'loadNotebookFromDB', 'nbDelete', 'saveBookmarksToDB',
  'loadBookmarksFromDB', 'bmId', 'settingsToBrand', 'mergeVoiceExtra', '_veNorm', 'notifyBrandSaveBlocked', '_saveBrandToDBInner',
  'saveBrandToDB', 'awWhen'];
const tick = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

/* ───────── the fake database ───────── */
const BASE_COLS = {
  ideas: 'id brand_id day community format title hook script shots screen caption reel_title tags bold_text status dismiss_reason assignee is_generated is_remix original_creator emphasis gen_flow post_type created_at updated_at',
  notebook_notes: 'id brand_id text created_at',
  remixes: 'id brand_id source_type source_url source_text remixed_text created_at',
  product_refs: 'id brand_id name data_url created_at',
  prompt_history: 'id brand_id prompt created_at',
  competitors: 'id brand_id name platform url notes created_at',
  brands: 'id user_id brand_name website tagline usps tones platforms format_mix show_extra target_audience competitors_text banned_topics communities day_rotation team_members onboarding_complete quick_scenes voice_extra updated_at created_at',
};
function makeDB(opt = {}) {
  const v720 = opt.v720 !== false, permissive = !!opt.permissive;
  const COLS = {}; for (const t in BASE_COLS) COLS[t] = new Set(BASE_COLS[t].split(' '));
  if (v720) { for (const t of ['ideas', 'notebook_notes', 'remixes', 'product_refs', 'prompt_history']) COLS[t].add('client_key'); COLS.ideas.add('first_created_at'); }
  const db = { T: {}, log: [], seq: 0, clock: Date.UTC(2026, 9, 1), v720, COLS };
  for (const t in COLS) db.T[t] = [];
  const nowIso = () => new Date(db.clock += 1000).toISOString();
  const keyed = t => !!COLS[t] && COLS[t].has('client_key');
  // what sql/saves-v720.sql does to an existing database: the columns, the backfill, the defaults, the trigger
  db.applySql = () => {
    for (const t of ['ideas', 'notebook_notes', 'remixes', 'product_refs', 'prompt_history']) COLS[t].add('client_key');
    COLS.ideas.add('first_created_at'); db.v720 = true;
    for (const t of ['ideas', 'notebook_notes', 'remixes', 'product_refs', 'prompt_history'])
      db.T[t].forEach(r => { if (r.client_key == null) r.client_key = String(r.id); });
    db.T.ideas.forEach(r => { if (r.first_created_at == null) r.first_created_at = r.created_at; });
  };
  const withDefaults = (t, r) => {
    const o = Object.assign({}, r);
    if (o.id == null) o.id = t.slice(0, 2) + '-' + (++db.seq);
    if (o.created_at == null) o.created_at = nowIso();
    if (keyed(t) && (o.client_key == null)) o.client_key = 'gen-' + (++db.seq);
    if (t === 'ideas' && COLS.ideas.has('first_created_at') && o.first_created_at == null) o.first_created_at = nowIso();
    return o;
  };
  db.seed = (t, r) => { const o = withDefaults(t, r); db.T[t].push(o); return o; };
  db.client = (dev, role) => ({
    auth: { getSession: async () => ({ data: { session: { user: { id: role === 'member' ? 'u-member' : 'u-owner' } } } }),
            refreshSession: async () => ({ data: { session: { user: { id: 'u-owner' } } } }) },
    from: (t) => query(dev, role, t),
  });
  const colErr = (t, c, sel) => sel ? { code: '42703', message: 'column ' + t + '.' + c + ' does not exist' }
                                    : { code: 'PGRST204', message: "Could not find the '" + c + "' column of '" + t + "' in the schema cache" };
  const badCols = (t, cols) => permissive ? null : cols.find(c => !COLS[t] || !COLS[t].has(c));
  function query(dev, role, t) {
    const q = { op: 'select', f: [], payload: null, opts: null, cols: '*', ret: null, lim: null, ord: null, rng: null, one: 0 };
    const api = {
      select(c) { if (q.op === 'select') q.cols = c || '*'; else q.ret = c || '*'; return api; },
      eq(k, v) { q.f.push(r => r[k] === v); return api; },
      in(k, a) { q.f.push(r => a.indexOf(r[k]) >= 0); return api; },
      order(k, o) { q.ord = { k, asc: !(o && o.ascending === false) }; return api; },
      range(a, b) { q.rng = [a, b]; return api; }, limit(n) { q.lim = n; return api; },
      maybeSingle() { q.one = 1; return api; }, single() { q.one = 2; return api; },
      insert(p) { q.op = 'insert'; q.payload = p; return api; },
      upsert(p, o) { q.op = 'upsert'; q.payload = p; q.opts = o || {}; return api; },
      update(p) { q.op = 'update'; q.payload = p; return api; },
      delete() { q.op = 'delete'; return api; },
      then(ok, bad) { let r; try { r = run(); } catch (e) { r = { data: null, error: { message: e.message } }; } return Promise.resolve(r).then(ok, bad); },
    };
    const project = (rows, cols) => {
      if (!cols || cols === '*') return rows.map(r => JSON.parse(JSON.stringify(r)));
      const cs = cols.split(',').map(s => s.trim());
      return rows.map(r => { const o = {}; cs.forEach(c => { if (c in r || COLS[t].has(c)) o[c] = r[c] === undefined ? null : r[c]; }); return JSON.parse(JSON.stringify(o)); });
    };
    function run() {
      const rows = db.T[t] || (db.T[t] = []);
      const match = r => q.f.every(fn => fn(r));
      db.log.push({ dev, t, op: q.op, payload: q.payload ? JSON.parse(JSON.stringify(q.payload)) : null, opts: q.opts });
      if (q.op === 'select') {
        if (q.cols !== '*') { const b = badCols(t, q.cols.split(',').map(s => s.trim())); if (b) return { data: null, error: colErr(t, b, true) }; }
        let res = rows.filter(match);
        if (q.ord) res = res.slice().sort((a, b) => (a[q.ord.k] < b[q.ord.k] ? -1 : a[q.ord.k] > b[q.ord.k] ? 1 : 0) * (q.ord.asc ? 1 : -1));
        if (q.rng) res = res.slice(q.rng[0], q.rng[1] + 1);
        if (q.lim != null) res = res.slice(0, q.lim);
        res = project(res, q.cols);
        return q.one ? { data: res[0] || null, error: null } : { data: res, error: null };
      }
      if (q.op === 'insert' || q.op === 'upsert') {
        const arr = Array.isArray(q.payload) ? q.payload : [q.payload];
        for (const p of arr) { const b = badCols(t, Object.keys(p)); if (b) return { data: null, error: colErr(t, b, false) }; }
        const out = [];
        for (const p of arr) {
          const conflictOn = q.op === 'upsert' && q.opts && q.opts.onConflict;
          if (conflictOn && !permissive) {
            if (conflictOn !== 'brand_id,client_key' || !keyed(t)) return { data: null, error: { code: '42P10', message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification' } };
            const ex = rows.find(r => r.brand_id === p.brand_id && r.client_key === p.client_key);
            if (ex) { Object.assign(ex, p); out.push(ex); continue; }
          } else if (keyed(t) && !permissive && p.client_key != null && rows.some(r => r.brand_id === p.brand_id && r.client_key === p.client_key)) {
            return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
          }
          const o = withDefaults(t, p); rows.push(o); out.push(o);
        }
        const res = project(out, q.ret || '*');
        return { data: q.one ? res[0] : res, error: null };
      }
      if (q.op === 'update') {
        const b = badCols(t, Object.keys(q.payload || {})); if (b) return { data: null, error: colErr(t, b, false) };
        const hit = rows.filter(match);
        hit.forEach(r => {
          const strip = o => { const x = Object.assign({}, o); delete x.created_at; delete x.first_created_at; return JSON.stringify(x); };
          const before = strip(r), fca = r.first_created_at;
          Object.assign(r, q.payload);
          // the ideas_v720_touch trigger: the database stamps created_at on a changed row, first_created_at is kept
          if (t === 'ideas' && COLS.ideas.has('first_created_at')) {
            if (fca != null) r.first_created_at = fca;
            if (strip(r) !== before) r.created_at = nowIso();
          }
        });
        return { data: project(hit, q.ret || '*'), error: null };
      }
      if (q.op === 'delete') {
        if (role === 'member') return { data: [], error: null };      // RLS: delete is owner-only (v658)
        const gone = rows.filter(match); db.T[t] = rows.filter(r => !match(r));
        return { data: project(gone, q.ret || '*'), error: null };
      }
      return { data: null, error: { message: 'bad op' } };
    }
    return api;
  }
  return db;
}

/* ───────── a device = the real app functions in their own context ───────── */
const BID = 'b-1';
function device(db, name, role = 'owner') {
  const toasts = [];
  const c = vm.createContext({ console: { log() {}, warn() {}, error() {}, info() {} }, Date, Math, JSON, Promise, Set, Map, Object, Array, String, Number, Boolean, Error, isNaN, setTimeout, clearTimeout });
  Object.assign(c, {
    window: c, sb: db.client(name, role), currentBrand: { id: BID, voice_extra: { painPoints: 'P0', brandVocab: 'V0' } }, currentUser: { id: 'u-owner' },
    state: [], IDEAS: [], notebookNotes: [], bookmarkCategories: [], settings: {}, _brandLoadFailed: false, activeView: 'pipeline',
    bvState: { messages: [] }, localStorage: { setItem() {}, getItem() { return null; } },
    lsGet: () => null, lsSet: () => {}, showToast: (m) => toasts.push(String(m)), debugLog: () => {}, alert: (m) => toasts.push('ALERT ' + m),
    tpCleanEmphasis: (e) => Array.isArray(e) ? e : [], _listLoaded: () => true, _warnListNotSaved: () => {}, renderNotebook: () => {},
    renderNav: () => {}, brandGate: () => () => true, __banner: 0, _showUpdateBanner: () => { c.__banner++; }, notifyIdeasSaveFailed: (e) => { toasts.push('SAVEFAIL ' + (e && e.message)); },
  });
  vm.runInContext('globalThis.globalThis = globalThis; let _ideasSaveChain = Promise.resolve(); let _lastIdeasSave = Promise.resolve({ ok: true });', c);
  vm.runInContext(BLOCK, c);
  for (const n of LIFT) vm.runInContext(grab(n), c);
  const run = (src) => vm.runInContext(src, c);
  return {
    c, name, toasts, run,
    async load() {
      await run(`(async () => {
        const rows = await loadIdeasFromDB();
        IDEAS = []; const seen = new Set();
        rows.forEach(i => { const k = String(i.title || '').toLowerCase().trim(); if (!seen.has(k)) { seen.add(k); IDEAS.push(i); } });
        state = IDEAS.map((idea, i) => ({ ...idea, id: i }));
        notebookNotes = await loadNotebookFromDB();
        bookmarkCategories = await loadBookmarksFromDB();
        settings = { brandName: 'Acme', tagline: 'T0', targetAudience: 'A0', painPoints: 'P0', brandVocab: 'V0', tones: ['Warm'] };
        if (typeof csBrandBaseSet === 'function') csBrandBaseSet(currentBrand.id, settingsToBrand());
      })()`);
    },
    idea: (title) => c.state.find(x => x.title === title),
    saveIdeas: () => run('saveIdeasToDB()'),
  };
}
const dbIdeas = db => db.T.ideas.filter(r => r.brand_id === BID);
const byTitle = (db, t) => dbIdeas(db).filter(r => r.title === t);
const writesBy = (db, dev, t) => db.log.filter(l => l.dev === dev && l.t === t && l.op !== 'select');
function seedAll(db) {
  db.seed('brands', { id: BID, user_id: 'u-owner', brand_name: 'Acme', tagline: 'T0', target_audience: 'A0', tones: ['Warm'], voice_extra: { painPoints: 'P0', brandVocab: 'V0' } });
  for (const [t, st] of [['X idea', 'pending'], ['Y idea', 'pending'], ['Z idea', 'pending']]) {
    const r = db.seed('ideas', { brand_id: BID, title: t, status: st, script: 'script of ' + t, hook: 'hook of ' + t, format: 'video', day: 'Monday' });
    if (db.v720) { r.client_key = r.id; r.first_created_at = '2026-09-01T10:00:00.000Z'; }
  }
  for (const t of ['note one', 'note two']) { const r = db.seed('notebook_notes', { brand_id: BID, text: t }); if (db.v720) r.client_key = r.id; }
  db.seed('competitors', { brand_id: BID, name: '__bookmarks__', platform: '', url: '', notes: JSON.stringify([
    { id: 'cat1', name: 'Creators', entries: [{ id: 'e1', name: 'Ann', links: { tt: 'https://tiktok.com/@ann' } }, { id: 'e2', name: 'Bob', links: {} }] }]) });
}

/* ═══ 1-4, 7, 8: keyed saves with the v720 columns present ═══ */
{
  const db = makeDB(); seedAll(db);
  const A = device(db, 'A'), B = device(db, 'B');
  await A.load(); await B.load();
  ok(A.idea('X idea') && A.idea('X idea').ck === byTitle(db, 'X idea')[0].client_key, '0 the loader keeps each idea\'s client_key (ck) and first_created_at (firstAt)' );
  ok(A.idea('X idea').firstAt === Date.parse('2026-09-01T10:00:00.000Z'), '0 firstAt comes from first_created_at');

  // 1 — A approves X; B (stale) edits Y's script and X's script
  A.idea('X idea').status = 'filming';
  const ra = await A.saveIdeas();
  B.idea('Y idea').script = 'B rewrote Y';
  B.idea('X idea').script = 'B rewrote X';
  db.log.length = 0;
  const rb = await B.saveIdeas();
  const X = byTitle(db, 'X idea'), Y = byTitle(db, 'Y idea');
  ok(ra && ra.ok && rb && rb.ok, '1 both ideas saves report ok');
  ok(X.length === 1 && X[0].status === 'filming', '1 A\'s approval of X survives B\'s stale save (status ' + (X[0] && X[0].status) + ')');
  ok(X[0] && X[0].script === 'B rewrote X', '1 B\'s edit to X\'s script lands next to A\'s approval (column-level)');
  ok(Y.length === 1 && Y[0].script === 'B rewrote Y', '1 B\'s edit of Y survives');
  ok(dbIdeas(db).length === 3, '1 no duplicate rows (' + dbIdeas(db).length + ' ideas)');
  const bw = writesBy(db, 'B', 'ideas');
  const sentCols = new Set(); bw.forEach(w => [].concat(w.payload || []).forEach(p => Object.keys(p).forEach(k => sentCols.add(k))));
  ok(bw.length >= 1 && bw.every(w => w.op === 'update') && !sentCols.has('status') && sentCols.has('script'),
    '1 B sent only what it changed (updates of [' + [...sentCols].join(',') + '], no status, no insert/delete)');
  ok(!bw.some(w => w.op === 'delete' || w.op === 'insert'), '1 B deleted and re-inserted nothing');

  // 2 — A adds a new idea W; B (stale, never saw W) dismisses Z
  await A.run(`state.push({ id: state.length, title: 'W new idea', status: 'pending', script: 'w', format: 'video', day: 'Tuesday' }); saveIdeasToDB()`);
  B.idea('Z idea').status = 'dismissed';
  await B.saveIdeas();
  ok(byTitle(db, 'W new idea').length === 1, '2 B saving a stale list never deletes A\'s new idea W');
  ok(byTitle(db, 'Z idea')[0].status === 'dismissed', '2 B\'s dismissal of Z landed');
  const W = byTitle(db, 'W new idea')[0];
  ok(W && W.first_created_at && W.client_key === A.idea('W new idea').ck, '7 a new idea gets the database\'s first_created_at and keeps the device\'s key');

  // 7 — first_created_at never sent, never overwritten
  const fcaX = byTitle(db, 'X idea')[0].first_created_at, fcaW = W.first_created_at, caX = byTitle(db, 'X idea')[0].created_at;
  A.idea('W new idea').script = 'w edited'; A.idea('X idea').hook = 'A new hook'; A.idea('X idea').script = 'A also edited the script';
  await A.saveIdeas();
  ok(byTitle(db, 'X idea')[0].first_created_at === fcaX && byTitle(db, 'W new idea')[0].first_created_at === fcaW,
    '7 first_created_at is unchanged after more saves');
  ok(!db.log.some(l => l.t === 'ideas' && l.payload && JSON.stringify(l.payload).includes('first_created_at')), '7 no save ever sends first_created_at');
  ok(byTitle(db, 'X idea')[0].created_at > caX, '7 created_at still moves on a save, stamped by the database (send-daily/fact-pack read it as "last saved")');
  ok(!db.log.some(l => l.t === 'ideas' && l.op === 'update' && l.payload && 'created_at' in l.payload), '7 no ideas save sends created_at (no device clock)');

  // 8 — merge-reload: A's new hook on X comes into B; B's own unsaved edit to X's script stays
  B.idea('X idea').script = 'B second edit, unsaved';
  await B.run('csReloadIdeasMerge()');
  ok(B.idea('X idea').hook === 'A new hook', '8 the merge-reload takes the column another device changed (hook)');
  ok(B.idea('X idea').script === 'B second edit, unsaved' && B.idea('X idea').status === 'filming', '8 …keeps this device\'s own unsaved edit of a column the server also changed, and takes the newer status');
  ok(B.idea('W new idea') && B.idea('W new idea').ck === A.idea('W new idea').ck, '8 the merge-reload adds A\'s new idea with its key');
  await B.saveIdeas();
  ok(byTitle(db, 'X idea')[0].hook === 'A new hook' && byTitle(db, 'X idea')[0].script === 'B second edit, unsaved', '8 B\'s next save keeps both');

  // 7 — the morning batch (api/send-daily.js) inserts without client_key: the default gives one, and it is updated in place
  db.seed('ideas', { brand_id: BID, title: 'Morning idea', status: 'pending', gen_flow: 'daily', script: 'm' });
  await A.run('csReloadIdeasMerge()');
  A.idea('Morning idea').status = 'filming';
  await A.saveIdeas();
  ok(byTitle(db, 'Morning idea').length === 1 && byTitle(db, 'Morning idea')[0].status === 'filming', '7 a morning-batch idea (key from the column default) is approved in place, no copy');

  // a rewrite that builds a NEW object (as Redo did) keeps the idea's row: the key is taken back by title
  await A.run(`(() => { const i = state.findIndex(x => x.title === 'Z idea'); const o = Object.assign({}, state[i]); delete o.ck; o.hook = 'rebuilt'; state[i] = o; })(); saveIdeasToDB()`);
  ok(byTitle(db, 'Z idea').length === 1 && byTitle(db, 'Z idea')[0].hook === 'rebuilt', '1 an idea rebuilt as a new object takes back its key (no duplicate row)');

  // 3 — explicit delete of one idea on A
  const nBefore = dbIdeas(db).length;
  await A.run(`(() => { const i = state.findIndex(x => x.title === 'Y idea'); csIdeaTombstone(currentBrand.id, state[i].ck); state.splice(i, 1); reindexIdeas(); })(); saveIdeasToDB()`);
  ok(byTitle(db, 'Y idea').length === 0 && dbIdeas(db).length === nBefore - 1, '3 an explicit idea delete on A removes only that idea');
  B.idea('Z idea').script = 'B touches Z';
  await B.saveIdeas();
  ok(byTitle(db, 'Y idea').length === 0, '3 B (still holding Y, unchanged) does not bring it back');

  // 4 — notebook, two devices
  await A.run(`notebookNotes.unshift({ id: 'nbA', text: 'note from A', createdAt: Date.now() }); notebookNotes.find(n => n.text === 'note two').text = 'note two, edited on A'; saveNotebookToDB()`);
  await B.run(`notebookNotes.unshift({ id: 'nbB', text: 'note from B', createdAt: Date.now() }); saveNotebookToDB()`);
  const notes = () => db.T.notebook_notes.map(r => r.text).sort();
  ok(notes().includes('note from A') && notes().includes('note from B'), '2/4 B saving its stale notebook does not delete A\'s new note');
  ok(notes().includes('note two, edited on A') && !notes().includes('note two'), '4 A\'s edit of a note survives B\'s stale save');
  ok(db.T.notebook_notes.length === 4, '4 no duplicate notes (' + db.T.notebook_notes.length + ')');
  await A.run(`nbDelete(notebookNotes.find(n => n.text === 'note one').id)`); await tick();
  ok(!notes().includes('note one') && notes().length === 3, '3 nbDelete on A removes only that note');
  await B.run(`notebookNotes.find(n => n.text === 'note from B').text = 'note from B, edited'; saveNotebookToDB()`);
  ok(!notes().includes('note one') && notes().includes('note from B, edited'), '3 B (still holding it) does not bring the deleted note back');

  // 4 — bookmarks, two devices (one JSON row, merged by id)
  await A.run(`bookmarkCategories[0].entries.push({ id: 'e3', name: 'Cara', links: {} }); bookmarkCategories[0].entries = bookmarkCategories[0].entries.filter(e => e.id !== 'e2'); saveBookmarksToDB()`);
  await B.run(`bookmarkCategories[0].entries[0].note = 'note from B'; bookmarkCategories.push({ id: 'cat2', name: 'Rivals', entries: [] }); saveBookmarksToDB()`);
  const bm = () => { const r = db.T.competitors.filter(x => x.name === '__bookmarks__'); return { n: r.length, doc: JSON.parse(r[0].notes) }; };
  let d = bm();
  const ids = d.doc.flatMap(cat => [cat.id].concat((cat.entries || []).map(e => e.id)));
  ok(ids.includes('e3'), '2/4 B\'s stale bookmarks save keeps A\'s new entry');
  ok(!ids.includes('e2'), '3 A\'s removed bookmark stays removed after B\'s stale save');
  ok(ids.includes('cat2') && d.doc[0].entries.find(e => e.id === 'e1').note === 'note from B', '4 B\'s own bookmark changes land');
  await B.run(`bookmarkCategories[1].name = 'Rivals 2'; saveBookmarksToDB()`);
  d = bm();
  ok(d.doc[0].entries.some(e => e.id === 'e3') && d.n === 1, '4 B saving a SECOND time still keeps A\'s entry (one bookmarks row)');

  // 5 — brand: A changes the tagline, B the audience
  await A.run(`settings.tagline = 'Tagline from A'; settings.painPoints = 'P from A'; saveBrandToDB()`);
  await B.run(`settings.targetAudience = 'Audience from B'; settings.brandVocab = 'V from B'; saveBrandToDB()`);
  const br = db.T.brands[0];
  ok(br.tagline === 'Tagline from A' && br.target_audience === 'Audience from B', '5 brand: A\'s tagline and B\'s audience both survive');
  ok(br.voice_extra && br.voice_extra.painPoints === 'P from A' && br.voice_extra.brandVocab === 'V from B', '5 voice_extra keeps both devices\' fields');
  const bBrand = writesBy(db, 'B', 'brands').pop();
  ok(bBrand && !('tagline' in bBrand.payload) && 'target_audience' in bBrand.payload, '5 B\'s brand save sends only the columns it changed');
  await B.run(`settings.tones = ['Bold']; saveBrandToDB()`);
  ok(db.T.brands[0].voice_extra.painPoints === 'P from A', '5 B saving again does not revert A\'s voice_extra field');
  db.T.brands.length = 0;
  const gone = await B.run(`settings.tagline = 'x'; saveBrandToDB()`);
  ok(gone && gone.ok === false && B.c._brandSaveOk === false, '5 the zero-row refusal check still reports not-saved');

  // a team member's saves add no copies (G-7)
  const M = device(db, 'M', 'member'); await M.load();
  const n0 = dbIdeas(db).length;
  M.idea('X idea').status = 'done'; await M.saveIdeas(); M.idea('Z idea').status = 'filming'; await M.saveIdeas();
  ok(dbIdeas(db).length === n0 && byTitle(db, 'X idea')[0].status === 'done', '1 a team member\'s saves change the row in place and add no copies');
}

/* ═══ 6: fallback — the database has no v720 columns yet ═══ */
{
  const db = makeDB({ v720: false }); seedAll(db);
  const A = device(db, 'A'); await A.load();
  ok(!A.c.csKeyedNow('ideas', BID) && !A.c.csKeyedNow('notebook_notes', BID), '6 without the columns the loaders record the old save');
  A.idea('X idea').status = 'filming';
  const r = await A.saveIdeas();
  ok(r && r.ok && byTitle(db, 'X idea').length === 1 && byTitle(db, 'X idea')[0].status === 'filming' && dbIdeas(db).length === 3,
    '6 the old ideas save still saves correctly (' + dbIdeas(db).map(x => x.title + ':' + x.status).join(', ') + ')');
  await A.run(`notebookNotes.unshift({ id: 'nb1', text: 'fallback note', createdAt: Date.now() }); saveNotebookToDB()`);
  ok(db.T.notebook_notes.length === 3 && db.T.notebook_notes.some(n => n.text === 'fallback note'), '6 the old notebook save still saves correctly');
  ok(!db.log.some(l => l.payload && JSON.stringify(l.payload).includes('client_key')), '6 the old save never names client_key');
  ok(!db.log.some(l => l.op === 'upsert'), '6 nothing is upserted before the SQL has run');
  // a backend that accepts ANY column (a test stub) cannot prove the columns exist: the empty list keeps the old save
  const sdb = makeDB({ v720: false, permissive: true });
  sdb.seed('brands', { id: BID, user_id: 'u-owner' });
  const S = device(sdb, 'S'); await S.load();
  await S.run(`notebookNotes.unshift({ id: 'nb1', text: 'stub note', createdAt: Date.now() }); saveNotebookToDB()`);
  ok(sdb.T.notebook_notes.length === 1 && !sdb.log.some(l => l.op === 'upsert'), '6 a permissive stub is not trusted: the empty list uses the old save');
  // a database without the columns and an EMPTY library/notebook: the probe answers "no" and the old save strips the keys
  const ndb = makeDB({ v720: false }); ndb.seed('brands', { id: BID, user_id: 'u-owner' });
  const N = device(ndb, 'N'); await N.load();
  const rn = await N.run(`state.push({ id: 0, title: 'first idea', status: 'pending', script: 's', format: 'video', day: 'Monday' }); saveIdeasToDB()`);
  await N.run(`notebookNotes.unshift({ id: 'nb1', text: 'first note', createdAt: Date.now() }); saveNotebookToDB()`);
  ok(rn && rn.ok && ndb.T.ideas.length === 1 && ndb.T.notebook_notes.length === 1, '6 an empty library on a database without the columns saves through the old path');
  ok(!ndb.log.some(l => l.op !== 'select' && l.payload && JSON.stringify(l.payload).includes('client_key')), '6 …and never sends client_key');
  // and a real database WITH the columns and an empty list: the probe switches it to keyed saves
  const edb = makeDB(); edb.seed('brands', { id: BID, user_id: 'u-owner' });
  const E = device(edb, 'E'); await E.load();
  await E.run(`notebookNotes.unshift({ id: 'nb1', text: 'first note', createdAt: Date.now() }); saveNotebookToDB()`);
  ok(edb.T.notebook_notes.length === 1 && edb.log.some(l => l.op === 'upsert' && l.t === 'notebook_notes'), '6 an empty list on a database with the columns uses the keyed save');
  // two quick saves of a new idea (and a new note) before the empty-library column check has answered: one row each
  await E.run(`delete _csKeyed.probe.ideas; delete _csKeyed.probe.notebook_notes; state.push({ id: 0, title: 'Quick idea', status: 'pending', script: 'q', format: 'video', day: 'Monday' }); saveIdeasToDB(); state[0].status = 'filming'; saveIdeasToDB()`);
  await E.run(`notebookNotes.unshift({ id: 'nbq', text: 'quick note', createdAt: Date.now() }); saveNotebookToDB(); notebookNotes[0].text = 'quick note, edited'; saveNotebookToDB()`);
  await tick(60); await E.run('_ideasSaveChain');
  ok(edb.T.ideas.length === 1 && edb.T.ideas[0].status === 'filming' && E.c.state[0].ck === edb.T.ideas[0].client_key,
    '6 two quick saves of a new idea before the check answers make ONE row, and the idea keeps that key (' + edb.T.ideas.length + ')');
  ok(edb.T.notebook_notes.filter(n => /quick note/.test(n.text)).length === 1 && edb.T.notebook_notes.some(n => n.text === 'quick note, edited'), '6 …and the same for a new note');
}

/* ═══ 11: rollout — a tab that loaded BEFORE the SQL ran, next to tabs that load after ═══ */
{
  // ideas: B (old save) re-inserts the library under new keys; A (keyed) then approves X — no blind insert
  const db = makeDB({ v720: false }); seedAll(db);
  const B = device(db, 'B'); await B.load();
  db.applySql();
  const A = device(db, 'A'); await A.load();
  ok(A.c.csKeyedNow('ideas', BID) && !B.c.csKeyedNow('ideas', BID), '11 A loaded after the SQL (keyed); B loaded before it (old save)');
  B.idea('Y idea').script = 'B (old tab) rewrote Y';
  await B.saveIdeas();
  ok(dbIdeas(db).length === 3 && dbIdeas(db).every(r => r.client_key), '11 B\'s old save re-inserted the library; the column default gave every row a key');
  A.idea('X idea').status = 'filming';
  const ra = await A.saveIdeas();
  ok(ra && ra.ok && byTitle(db, 'X idea').length === 1, '11 A\'s update finds the re-keyed row by title: no duplicate X (' + byTitle(db, 'X idea').length + ')');
  ok(byTitle(db, 'X idea')[0].status === 'filming' && byTitle(db, 'Y idea')[0].script === 'B (old tab) rewrote Y' && dbIdeas(db).length === 3,
    '11 A\'s approval and B\'s edit both survive, 3 rows');
  ok(A.idea('X idea').ck === byTitle(db, 'X idea')[0].client_key, '11 A took over the re-keyed row\'s key');
  A.idea('X idea').hook = 'A again'; await A.saveIdeas();
  ok(byTitle(db, 'X idea').length === 1 && byTitle(db, 'X idea')[0].hook === 'A again', '11 A\'s next save updates that row in place');
  // B stays on the old save for the rest of its session, and is offered the reload
  B.idea('Z idea').status = 'dismissed'; await B.saveIdeas();
  ok(!db.log.some(l => l.dev === 'B' && l.op === 'upsert') && byTitle(db, 'Z idea').length === 1, '11 B stays on the old save until it reloads (never switches mid-session)');
  await B.run('_csSwitchAt = 0; csKeyedSwitchCheck()'); await tick();
  ok(B.c.__banner === 1, '11 B, which loaded before the switch, is shown the app\'s update banner once the columns exist');
  await A.run('csKeyedSwitchCheck()'); await tick();
  ok(A.c.__banner === 0, '11 A (already keyed) is not');

  // notebook: B (old save) adds a note and re-keys every note; A (keyed) edits one and deletes another
  await B.run(`notebookNotes.unshift({ id: 'nbB', text: 'note from old tab B', createdAt: Date.now() }); saveNotebookToDB()`);
  const texts = () => db.T.notebook_notes.map(r => r.text).sort();
  ok(db.T.notebook_notes.length === 3, '11 B\'s old notebook save re-inserted the notes (3)');
  await A.run(`notebookNotes.find(n => n.text === 'note two').text = 'note two, edited on A'; nbDelete(notebookNotes.find(n => n.text === 'note one').id)`); await tick();
  ok(texts().join('|') === ['note from old tab B', 'note two, edited on A'].sort().join('|'),
    '11 A\'s edit lands on the re-keyed note and its delete removes it; B\'s new note stays; no duplicate (' + texts().join(' | ') + ')');
}
// a foreground refresh on B between the old tab's save and B's edit: the refresh binds B's ideas to the re-keyed rows
{
  const db = makeDB({ v720: false }); seedAll(db);
  const O = device(db, 'O'); await O.load();
  db.applySql();
  const A = device(db, 'A'), B = device(db, 'B'); await A.load(); await B.load();
  O.idea('Y idea').script = 'O (old tab) rewrote Y'; await O.saveIdeas();
  await B.run('csReloadIdeasMerge()');
  ok(B.idea('X idea').ck === byTitle(db, 'X idea')[0].client_key, '12 the refresh binds B\'s X to the old tab\'s re-keyed row (same title, same last-saved script)');
  A.idea('X idea').status = 'filming'; await A.saveIdeas();
  B.idea('X idea').script = 'B edits X after the refresh'; const rb = await B.saveIdeas();
  const X = byTitle(db, 'X idea');
  ok(rb && rb.ok && X.length === 1 && X[0].status === 'filming' && X[0].script === 'B edits X after the refresh', '12 no duplicate X; A\'s approval and B\'s edit both kept');
  ok(byTitle(db, 'Y idea')[0].script === 'O (old tab) rewrote Y' && dbIdeas(db).length === 3, '12 the old tab\'s edit is kept too; 3 rows');
}
// a team member's old tab leaves copies (its delete is refused); B's refresh merges the copies into its baseline
// unbound; the original row is then cleaned up — B's edit must still find the copy (key map, not the baseline)
{
  const db = makeDB({ v720: false }); seedAll(db);
  const O = device(db, 'O', 'member'); await O.load();
  db.applySql();
  const B = device(db, 'B'); await B.load();
  O.idea('Y idea').script = 'O (member, old tab) rewrote Y'; await O.saveIdeas();
  ok(byTitle(db, 'X idea').length === 2, '14 the member\'s old save left a second copy of X (its delete was refused)');
  await B.run('csReloadIdeasMerge()');
  const orig = byTitle(db, 'X idea').find(r => r.client_key === B.idea('X idea').ck);
  db.T.ideas = db.T.ideas.filter(r => r !== orig);     // the owner's duplicate cleanup keeps the newest copy
  B.idea('X idea').script = 'B edit after the cleanup'; await B.saveIdeas(); await tick();
  ok(byTitle(db, 'X idea').length === 1 && byTitle(db, 'X idea')[0].script === 'B edit after the cleanup', '14 B\'s edit lands on the surviving copy (a refresh-merged, unbound row is still a candidate)');
}
// X deleted on A, then an unrelated idea with the same title arrives (morning batch): B's stale edit must not land on it
{
  const db = makeDB(); seedAll(db);
  const A = device(db, 'A'), B = device(db, 'B'); await A.load(); await B.load();
  await A.run(`(() => { const i = state.findIndex(x => x.title === 'X idea'); csIdeaTombstone(currentBrand.id, state[i].ck); state.splice(i, 1); reindexIdeas(); })(); saveIdeasToDB()`);
  db.seed('ideas', { brand_id: BID, title: 'X idea', status: 'pending', gen_flow: 'daily', hook: 'a different hook', script: 'a different script' });
  B.idea('X idea').script = 'B stale edit of the deleted X';
  await B.saveIdeas(); await tick();
  const X = byTitle(db, 'X idea');
  ok(X.length === 1 && X[0].script === 'a different script' && X[0].hook === 'a different hook' && dbIdeas(db).length === 3,
    '13 a deleted idea\'s stale edit neither overwrites the unrelated same-title idea nor comes back as a copy');
  ok(B.toasts.some(t => /changed on another device/.test(t)), '13 B is told "That idea changed on another device — refreshed."');
  await B.run(`state.push({ id: state.length, title: 'Brand new on B', status: 'pending', script: 'n', format: 'video', day: 'Friday' }); saveIdeasToDB()`);
  ok(byTitle(db, 'Brand new on B').length === 1, '13 a never-saved new idea still inserts');
}
// late switch-on: a list that started on the old save (empty, before the SQL) stays on it after the SQL runs
{
  const db = makeDB({ v720: false }); db.seed('brands', { id: BID, user_id: 'u-owner' });
  const D = device(db, 'D'); await D.load(); await tick();
  await D.run(`notebookNotes.unshift({ id: 'nb1', text: 'before the SQL', createdAt: Date.now() }); saveNotebookToDB()`);
  db.applySql();
  await D.run('delete _csKeyed.probe.notebook_notes');   // as if the 10-minute probe cache had run out
  await D.run(`notebookNotes.unshift({ id: 'nb2', text: 'after the SQL', createdAt: Date.now() }); saveNotebookToDB()`);
  ok(db.T.notebook_notes.length === 2 && !db.log.some(l => l.op === 'upsert'), '11 late switch-on: the list stays on the old save until reload, no duplicate (' + db.T.notebook_notes.length + ')');
  ok(!D.c.notebookNotes.some(n => n.ck), '11 no local keys are given before keyed saves are confirmed');
  const D2 = device(db, 'D2'); await D2.load();
  await D2.run(`notebookNotes.find(n => n.text === 'after the SQL').text = 'edited after reload'; saveNotebookToDB()`);
  ok(db.T.notebook_notes.length === 2 && db.log.some(l => l.dev === 'D2' && l.op === 'upsert'), '11 after a reload the same list is on keyed saves');
}

/* ═══ 9: the SQL file ═══ */
{
  const raw = fs.readFileSync(path.join(ROOT, 'sql', 'saves-v720.sql'), 'utf8');
  const sql = raw.replace(/--[^\n]*/g, '');
  const adds = [...sql.matchAll(/add\s+column\s+(if\s+not\s+exists\s+)?/gi)];
  ok(adds.length >= 3 && adds.every(m => m[1]), '9 every ADD COLUMN says IF NOT EXISTS (' + adds.length + ')');
  const idx = [...sql.matchAll(/create\s+(unique\s+)?index\s+(if\s+not\s+exists\s+)?/gi)];
  ok(idx.length >= 2 && idx.every(m => m[2] && m[1]), '9 every index is CREATE UNIQUE INDEX IF NOT EXISTS');
  ok(/create\s+unique\s+index\s+if\s+not\s+exists\s+\w+\s+on\s+public\.ideas\s*\(\s*brand_id\s*,\s*client_key\s*\)/i.test(sql), '9 ideas gets UNIQUE (brand_id, client_key) — the app\'s onConflict target');
  const pols = [...sql.matchAll(/create\s+policy\s+"([^"]+)"/gi)].map(m => m[1]);
  ok(pols.length >= 1 && pols.every(n => new RegExp('drop\\s+policy\\s+if\\s+exists\\s+"' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"', 'i').test(sql)), '9 every CREATE POLICY is preceded by DROP POLICY IF EXISTS');
  const ups = [...sql.matchAll(/update\s+public\.[%\w]+\s+set\s+[^;']*?where\s+([^;']+)/gi)];
  ok(ups.length >= 3 && ups.every(m => /is\s+null\s*$/i.test(m[1].trim())), '9 every backfill only fills NULLs (safe to run twice)');
  ok(!/\bdelete\s+from\b|\bdrop\s+(table|column|index)\b|\btruncate\b/i.test(sql), '9 no DELETE / DROP TABLE|COLUMN|INDEX / TRUNCATE');
  const fns = [...sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?(\w+)/gi)].map(m => m[1]);
  ok(fns.length === 1 && fns[0] === 'ideas_v720_touch', '9 adds exactly one function, the ideas_v720_touch trigger (' + fns.join(',') + ')');
  ok(/returns\s+trigger/i.test(sql) && !/security\s+definer/i.test(sql) && /set\s+search_path\s*=\s*public\s*,\s*pg_temp/i.test(sql), '9 …a trigger function, not SECURITY DEFINER, search_path pinned');
  ok(/revoke\s+all\s+on\s+function\s+public\.ideas_v720_touch\(\)\s+from\s+public/i.test(sql) &&
     /'ideas_v720_touch'/.test(fs.readFileSync(path.join(ROOT, 'sql', 'v658-revoke-security-health.sql'), 'utf8')), '9 …EXECUTE revoked from PUBLIC, and named in v658-revoke-security-health.sql');
  ok(/drop\s+trigger\s+if\s+exists\s+ideas_v720_touch_trg/i.test(sql) && /new\.first_created_at\s*:=\s*old\.first_created_at/i.test(sql) && /new\.created_at\s*:=\s*now\(\)/i.test(sql),
    '9 …re-runnable, keeps first_created_at, stamps created_at with the database clock');
  ok(/set\s+default\s+gen_random_uuid\(\)::text/i.test(sql) && /first_created_at\s+set\s+default\s+now\(\)/i.test(sql), '9 new rows (the morning batch) get a key and first_created_at by default');
  ok(/for\s+update\s+using\s*\(\s*brand_id\s+in\s*\(\s*select\s+user_brand_ids\(\)\s*\)\s*\)\s*with\s+check/i.test(sql), '9 notebook_notes gets a member UPDATE policy with a WITH CHECK');
}

/* ═══ 10: grouping ═══ */
{
  const c = vm.createContext({}); vm.runInContext(grab('awWhen'), c);
  ok(c.awWhen({ firstAt: 1000, freshAt: 5000, statusAt: 7000 }) === 1000 && c.awWhen({ freshAt: 5000 }) === 5000, '10 the Ideas list groups by first_created_at when present');
}

finished = true;
if (fail) { console.log('\n' + fail + ' check(s) FAILED'); process.exit(1); }
console.log('\nSAVES V720 OK');
