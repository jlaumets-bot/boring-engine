#!/usr/bin/env node
/**
 * data-integrity-p1p8.mjs — verification for the P1..P8 data-loss / chain-robustness fixes.
 *
 * Imported and executed by data-integrity.mjs so both suites report as one.
 *
 * BEHAVIOURAL checks extract the REAL function bodies out of app.html and execute them
 * against stubs. Every behavioural check is paired with a CONTROL that runs the pre-fix code
 * through the identical stub and must FAIL — that is the only way to know the assertion
 * discriminates rather than passing vacuously.
 *
 * STRUCTURAL checks assert on the source text. They are labelled as such.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

export async function runP1P8({ html, ok, section, extractFn, compile, ROOT }) {

/* ═══════════════════════════════════════════════════════════════════════════════
   Shared helpers
   ═══════════════════════════════════════════════════════════════════════════ */

/** A stub supabase whose builder is a THENABLE with NO .catch — exactly like the real one. */
function makeSb(tables, opts = {}) {
  const state = { rows: {}, log: [], nextId: 1 };
  for (const [t, rows] of Object.entries(tables)) {
    state.rows[t] = rows.map(r => ({ ...r }));
    state.nextId = Math.max(state.nextId, ...rows.map(r => (Number(r.id) || 0) + 1));
  }
  class Q {
    constructor(table, op, payload) { this.table = table; this.op = op; this.payload = payload; this.f = {}; this.inCol = null; this.inVals = null; }
    eq(c, v) { this.f[c] = v; return this; }
    in(c, v) { this.inCol = c; this.inVals = v; return this; }
    order() { return this; }
    limit() { return this; }
    select() { if (this.op !== 'select') this.wantSelect = true; return this; }
    single() { this.wantSingle = true; return this; }
    // then() ONLY. No catch, no finally — the real PostgrestBuilder has neither.
    then(res, rej) { return Promise.resolve().then(() => exec(this)).then(res, rej); }
  }
  const match = (r, q) => {
    for (const [c, v] of Object.entries(q.f)) if (r[c] !== v) return false;
    if (q.inCol && !q.inVals.includes(r[q.inCol])) return false;
    return true;
  };
  function exec(q) {
    state.log.push(`${q.op}:${q.table}`);
    const fail = opts.fail && opts.fail[`${q.op}:${q.table}`];
    if (fail) return q.op === 'select' ? { data: null, error: { message: fail } } : { error: { message: fail } };
    const rows = state.rows[q.table] || (state.rows[q.table] = []);
    if (q.op === 'select') return { data: rows.filter(r => match(r, q)).map(r => ({ ...r })), error: null };
    if (q.op === 'delete') { state.rows[q.table] = rows.filter(r => !match(r, q)); return { error: null }; }
    if (q.op === 'insert') {
      const batch = Array.isArray(q.payload) ? q.payload : [q.payload];
      batch.forEach(r => rows.push({ ...r, id: state.nextId++ }));
      return { error: null, data: batch };
    }
    throw new Error('unknown op ' + q.op);
  }
  state.sb = { from: t => ({ select: () => new Q(t, 'select'), insert: p => new Q(t, 'insert', p), delete: () => new Q(t, 'delete') }) };
  return state;
}

/** A localStorage stub that records every key it holds. */
function makeLs(seed = {}) {
  const store = { ...seed };
  return {
    store,
    api: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
      get length() { return Object.keys(store).length; },
      key: i => Object.keys(store)[i],
    },
  };
}
// Object.keys(localStorage) in the app enumerates OWN ENUMERABLE keys, so the stub must be a
// plain object carrying the keys as properties plus the methods.
function lsProxy(ls) {
  const o = Object.create(null);
  for (const k of Object.keys(ls.store)) o[k] = ls.store[k];
  o.getItem = ls.api.getItem; o.setItem = ls.api.setItem;
  o.removeItem = k => { delete ls.store[k]; delete o[k]; };
  return o;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   P1 — "Start over" destroyed every brand's data and never re-ran onboarding
   ═══════════════════════════════════════════════════════════════════════════ */
section('P1 — "Start over" must delete THIS brand from the account and only THIS brand locally');
{
  // ---- (a) the root cause, proven against the REAL vendored library -----------
  // BEHAVIOURAL: load supabase.min.js and inspect an actual delete builder.
  let hasThen = null, hasCatch = null, throwsOnCatch = null;
  try {
    const sbSrc = fs.readFileSync(path.join(ROOT, 'supabase.min.js'), 'utf8');
    const sandbox = {
      console: { log() {}, warn() {}, error() {} }, fetch: async () => ({ ok: true, status: 200, text: async () => '[]', headers: { get: () => null } }),
      setTimeout, clearTimeout, setInterval, clearInterval, navigator: { userAgent: 'node' },
      location: { href: 'http://x' }, document: { createElement: () => ({}), addEventListener() {} },
      WebSocket: function () {}, AbortController, URL, URLSearchParams, TextEncoder, TextDecoder, crypto,
      Headers, Request, Response, Blob, FormData, structuredClone,
    };
    sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(sbSrc, sandbox, { filename: 'supabase.min.js' });
    const probe = vm.runInContext(`
      const c = supabase.createClient('https://example.supabase.co','anon');
      const b = c.from('ideas').delete().eq('brand_id','x');
      let threw = false;
      try { b.catch(function(){}); } catch (e) { threw = true; }
      ({ hasThen: typeof b.then === 'function', hasCatch: typeof b.catch === 'function', threw });
    `, sandbox);
    hasThen = probe.hasThen; hasCatch = probe.hasCatch; throwsOnCatch = probe.threw;
  } catch (e) { /* leave nulls → the checks below fail loudly */ }

  ok('[root cause] the real supabase builder IS a thenable', hasThen === true);
  ok('[root cause] the real supabase builder has NO .catch', hasCatch === false);
  ok('[control] calling .catch() on it genuinely throws', throwsOnCatch === true);

  // ---- (b) the fixed reset actually deletes the brand row ---------------------
  // BEHAVIOURAL: run the real obResetForTesting against the stub builder.
  async function runReset(src, name, { seedLs, brandId = 'B1' }) {
    const db = makeSb({
      ideas: [{ id: 1, brand_id: 'B1' }], remixes: [], product_refs: [], competitors: [],
      prompt_history: [], notebook_notes: [], edit_signals: [],
      // The brand rows carry user_id because the hardened delete filters on it — the
      // authoritative column, so the statement can only ever match a row the DATABASE agrees
      // is ours. A fixture without it makes a correct delete match zero rows.
      brands: [{ id: 'B1', user_id: 'U1' }, { id: 'B2', user_id: 'U1' }],
    });
    const ls = makeLs(seedLs);
    let reloaded = false;
    // Object.keys(localStorage) must see the KEYS, so the stub is a plain object that also
    // carries getItem/setItem/removeItem — exactly what the browser exposes.
    const proxy = lsProxy(ls);
    // obResetForTesting now delegates its child-table deletes to _verifiedBrandWipe (which
    // .select('id')s and re-reads to tell a genuine empty table apart from a silent RLS
    // refusal). Compile the REAL helper against the same stub db so this gate exercises the
    // actual verified-delete logic rather than a stand-in — a stub here would let the very
    // regression this gate exists to catch slip through.
    const _verifiedBrandWipe = compile(extractFn('_verifiedBrandWipe'), '_verifiedBrandWipe', { sb: db.sb });
    const fn = compile(src, name, {
      currentBrand: { id: brandId }, currentUser: { id: 'U1' }, sb: db.sb, _verifiedBrandWipe,
      confirm: () => true, localStorage: proxy,
      SETTINGS_KEY: 'boring_content_engine_settings', STORAGE_KEY: 'boring_content_engine_v5',
      location: { reload() { reloaded = true; } },
      console: { warn() {}, error() {}, log() {} },
    });
    await fn();
    const left = Object.keys(proxy).filter(k => typeof proxy[k] !== 'function');
    return { db, left, reloaded };
  }

  const SEED = {
    // this brand
    'boring_blog_posts::B1': '["mine"]', 'paa_questions::B1': '["mine"]', 'brand_trends::B1': '["mine"]',
    'edit_signals::B1': '[]', 'notebook_B1': '[]', 'boring_content_engine_v5::B1': '[]',
    // A DIFFERENT brand — must survive
    'boring_blog_posts::B2': '["OTHER BRAND BLOG"]', 'paa_questions::B2': '["OTHER BRAND Qs"]',
    'brand_trends::B2': '["OTHER BRAND TRENDS"]', 'edit_signals::B2': '[]', 'notebook_B2': '[]',
    'boring_content_engine_v5::B2': '[]',
    // globals
    'sp-tab': 'voice', '_ls_ns_migrated': '1',
  };

  const NEW = extractFn('obResetForTesting');
  const OLD = `
async function obResetForTesting_OLD() {
  if (!confirm('x')) return;
  try {
    if (currentBrand && sb) {
      const bid = currentBrand.id;
      for (const t of ['ideas','remixes','product_refs','competitors','prompt_history','notebook_notes','edit_signals']) {
        await sb.from(t).delete().eq('brand_id', bid).catch(()=>{});
      }
      await sb.from('brands').delete().eq('id', bid).catch(()=>{});
    }
  } catch(e) {}
  try {
    Object.keys(localStorage).forEach(k => {
      if (/^notebook_|^edit_signals|^brain_|^paa_|sp-tab|^boring_content_engine|^boring_blog_posts|^brand_trends|^_ls_ns_migrated/.test(k)) localStorage.removeItem(k);
    });
    localStorage.removeItem(SETTINGS_KEY);
    localStorage.removeItem(STORAGE_KEY);
  } catch(e) {}
  location.reload();
}`;

  const oldRun = await runReset(OLD, 'obResetForTesting_OLD', { seedLs: SEED });
  const newRun = await runReset(NEW, 'obResetForTesting', { seedLs: SEED });

  ok('[control] OLD reset leaves the brand row in the account (so onboarding never re-ran)',
    oldRun.db.rows.brands.some(b => b.id === 'B1'),
    'old code should have failed to delete B1');
  ok('NEW reset actually deletes this brand from the account',
    !newRun.db.rows.brands.some(b => b.id === 'B1'));
  ok('NEW reset leaves every OTHER brand row alone',
    newRun.db.rows.brands.some(b => b.id === 'B2'));
  ok('NEW reset clears this brand\'s child rows',
    (newRun.db.rows.ideas || []).length === 0);

  ok('[control] OLD reset destroyed the OTHER brand\'s blog posts / questions / trends',
    !oldRun.left.includes('boring_blog_posts::B2') &&
    !oldRun.left.includes('paa_questions::B2') &&
    !oldRun.left.includes('brand_trends::B2'),
    'old code should have wiped B2 keys');
  ok('NEW reset keeps the OTHER brand\'s blog posts',   newRun.left.includes('boring_blog_posts::B2'));
  ok('NEW reset keeps the OTHER brand\'s saved questions', newRun.left.includes('paa_questions::B2'));
  ok('NEW reset keeps the OTHER brand\'s taught trends',   newRun.left.includes('brand_trends::B2'));
  ok('NEW reset keeps the OTHER brand\'s notebook + status snapshot',
    newRun.left.includes('notebook_B2') && newRun.left.includes('boring_content_engine_v5::B2'));
  ok('NEW reset still clears THIS brand\'s local caches',
    !newRun.left.includes('boring_blog_posts::B1') &&
    !newRun.left.includes('paa_questions::B1') &&
    !newRun.left.includes('brand_trends::B1') &&
    !newRun.left.includes('notebook_B1'));
  ok('NEW reset still clears the device-global keys', !newRun.left.includes('sp-tab') && !newRun.left.includes('_ls_ns_migrated'));
  ok('NEW reset still reloads', newRun.reloaded === true);
  // Only a supabase BUILDER chain — `sb.from(x).<op>()...catch(` — is a defect here.
  // (A real promise like reg.update().catch() is fine and must not trip this.)
  ok('[structural] no .catch() is called on a supabase builder anywhere in app.html',
    !/\bsb\s*\.from\([^)]*\)(\s*\.\w+\([^)]*\))*\s*\.catch\(/.test(html));
}

/* ═══════════════════════════════════════════════════════════════════════════════
   P2 — a 504 must not surface as "Unexpected token '<'"
   ═══════════════════════════════════════════════════════════════════════════ */
section('P2 — a gateway error must read as a timeout, not as a JSON parser crash');
{
  // BEHAVIOURAL: run the real readJsonOrThrow against a 504 that returns an HTML body,
  // next to the old `await resp.json(); if (!resp.ok)` shape.
  const HTML_504 = '<html><head><title>504 Gateway Time-out</title></head><body>...</body></html>';
  const resp504 = () => ({ ok: false, status: 504, text: async () => HTML_504, json: async () => JSON.parse(HTML_504) });
  const resp200 = () => ({ ok: true, status: 200, text: async () => '{"ideas":[{"title":"t"}]}', json: async () => ({ ideas: [{ title: 't' }] }) });
  const resp402 = () => ({ ok: false, status: 402, text: async () => '{"error":"Out of credits"}', json: async () => ({ error: 'Out of credits' }) });

  const READ = compile(extractFn('readJsonOrThrow'), 'readJsonOrThrow', {});

  async function grab(fn) { try { return { msg: (await fn()) && '(no throw)' , threw: false }; } catch (e) { return { msg: e.message, threw: true, name: e.name }; } }

  // control: the OLD shape
  const oldOn504 = await grab(async () => { const r = resp504(); const d = await r.json(); if (!r.ok) throw new Error(d.error || 'API error ' + r.status); return d; });
  ok('[control] OLD shape surfaces a raw JSON parser error on a 504',
    oldOn504.threw && /unexpected token|not valid json|json/i.test(oldOn504.msg) && oldOn504.name === 'SyntaxError',
    `got: ${oldOn504.name}: ${oldOn504.msg}`);

  const newOn504 = await grab(() => READ(resp504(), 'Writing your post'));
  ok('NEW reader throws a human timeout message on a 504',
    newOn504.threw && /timed out/i.test(newOn504.msg) && !/unexpected token/i.test(newOn504.msg),
    `got: ${newOn504.msg}`);
  ok('NEW reader names WHICH request timed out', /Writing your post/.test(newOn504.msg));

  const newOn402 = await grab(() => READ(resp402(), 'Writing your post'));
  ok('NEW reader still surfaces a real API error message verbatim', newOn402.threw && newOn402.msg === 'Out of credits');

  const newOn200 = await READ(resp200(), 'Writing your post');
  ok('NEW reader passes a good response straight through', newOn200 && newOn200.ideas && newOn200.ideas[0].title === 't');

  const newOn502 = await grab(() => READ({ ok: false, status: 502, text: async () => '<html>bad gateway</html>' }, 'Generating ideas'));
  ok('NEW reader handles a 502 without a parser error', newOn502.threw && /reach the AI service/i.test(newOn502.msg));

  // STRUCTURAL: the three named handlers actually use it.
  const qp = extractFn('generateTodayTabPost');
  const gi = extractFn('generateNewIdeas');
  const ar = extractFn('autoRefillCheck');
  ok('[structural] Quick Post generate checks status before parsing', /readJsonOrThrow\(resp/.test(qp) && !/const data = await resp\.json\(\);/.test(qp));
  ok('[structural] Ideas generate checks status before parsing',      /readJsonOrThrow\(resp/.test(gi) && !/const data = await resp\.json\(\);/.test(gi));
  ok('[structural] auto-refill checks status before parsing',         /if \(!resp\.ok\)/.test(ar) && !/const data = await resp\.json\(\);/.test(ar));
}

/* ═══════════════════════════════════════════════════════════════════════════════
   P3 — generation must abort at the deadline and SAY so
   ═══════════════════════════════════════════════════════════════════════════ */
section('P3 — the 90s deadline must abort the request and report it, not silently revert');
{
  const qp = extractFn('generateTodayTabPost');
  const gi = extractFn('generateNewIdeas');

  ok('[structural] Quick Post creates an AbortController', /new AbortController\(\)/.test(qp));
  ok('[structural] Quick Post passes the signal to fetch',  /signal: _genCtrl\.signal/.test(qp));
  ok('[structural] Quick Post\'s safety timer aborts instead of only reverting',
    /setTimeout\(function\(\)\{[^}]*_genCtrl\.abort\(\)/.test(qp.replace(/\s+/g, ' ').replace(/ \{/g, '{')) ||
    /_tvGenTimedOut = true;[\s\S]{0,80}_genCtrl\.abort\(\)/.test(qp));
  // v618: assert the PROPERTY (a timeout reaches the user), not the exact sentence. Pinning this to
  // the literal words "took too long" made it fail the moment the copy was corrected — the message
  // used to blame "the AI is slow", which was false: the server had returned 200 and the phone had
  // given up on a slow link. An assertion coupled to wording punishes fixing the wording.
  // The surfacing must be TIED to the timeout, not merely present somewhere in the function —
  // a loose /showToast/ passed even with the timeout's own toast deleted (this function calls
  // showToast elsewhere), i.e. it was an assertion incapable of failing. Scope it to the window
  // after _timedOut is computed. Property, not wording: the copy must stay free to improve.
  // Scoped to the CATCH BLOCK, not to a character distance. A fixed window had to be widened twice
  // as the timeout branch grew (phase-aware message, then network-drop handling) — an assertion that
  // needs re-tuning every time the code it guards improves is a bad assertion. A whole-function
  // /showToast/ was the opposite failure: it matched an unrelated call and could not fail at all.
  // Slicing the catch keeps it strict (a deleted toast is still caught) and stops it being brittle.
  const _qpCatch = (() => {
    const c = qp.indexOf('catch (err)');
    return c < 0 ? '' : qp.slice(c);
  })();
  ok('[structural] Quick Post reports the timeout to the user',
    /_timedOut/.test(_qpCatch) && /showToast/.test(_qpCatch) && /textContent\s*=/.test(_qpCatch),
    _qpCatch ? '' : 'could not locate the catch block — this gate is blind');
  ok('[structural] Ideas generate creates an AbortController', /new AbortController\(\)/.test(gi));
  ok('[structural] Ideas generate passes the signal to fetch',  /signal: _genCtrl\.signal/.test(gi));
  ok('[structural] Ideas generate wires the abort to btnWork\'s onTimeout', /onTimeout:[\s\S]{0,90}_genCtrl\.abort\(\)/.test(gi));
  ok('[structural] Ideas generate reports the timeout to the user',
    /_timedOut[\s\S]{0,600}?showToast/.test(gi) && /_timedOut[\s\S]{0,600}?textContent\s*=/.test(gi));

  // BEHAVIOURAL: an aborted fetch must produce a human message, not a bare "AbortError".
  // Extract the classification line the catch uses and run it on a real AbortError.
  const classify = new Function('err', 'timedOutFlag', `
    const _timedOut = timedOutFlag || (err && (err.name === 'AbortError' || /abort/i.test(err.message || '')));
    return _timedOut ? 'That took too long, so we stopped it' : (err.message || 'x');`);
  const abortErr = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
  ok('an AbortError is classified as a timeout, not shown raw',
    /took too long/.test(classify(abortErr, false)));
  ok('[control] the same classifier does NOT swallow a genuine API error',
    classify(new Error('Out of credits'), false) === 'Out of credits');
  ok('the flag alone also classifies as a timeout (abort races the flag)',
    /took too long/.test(classify(new Error('boom'), true)));
}

/* ═══════════════════════════════════════════════════════════════════════════════
   P4 — silent brand-save loss must be surfaced
   ═══════════════════════════════════════════════════════════════════════════ */
section('P4 — a brand save that gives up must tell the user');
{
  const src = extractFn('saveBrandToDB');
  ok('[structural] the no-user path no longer ends at a debug log', !/if \(!sb \|\| !currentUser\) \{ debugLog/.test(src));
  ok('[structural] the no-user path notifies the user', /if \(!sb \|\| !currentUser\) \{ notifyBrandSaveBlocked/.test(src));
  ok('[structural] the failed-session-refresh path notifies the user', /notifyBrandSaveBlocked\('session refresh failed/.test(src));

  // BEHAVIOURAL: run the real function on both give-up paths and assert the user is told.
  async function runSave(deps) {
    const toasts = [];
    const fn = compile(src, 'saveBrandToDB', {
      ...deps,
      debugLog: () => {},
      notifyBrandSaveBlocked: compile(extractFn('notifyBrandSaveBlocked'), 'notifyBrandSaveBlocked', {
        debugLog: () => {}, _brandSaveWarnedAt: 0, Date,
        showToast: (m, d, cb) => toasts.push(m), location: { reload() {} },
      }),
      settingsToBrand: () => ({}), alert: () => {},
    });
    await fn();
    return toasts;
  }
  const noUser = await runSave({ sb: {}, currentUser: null, currentBrand: null, _brandLoadFailed: false });
  ok('a signed-out save tells the user their changes are not being saved',
    noUser.length === 1 && /not being saved/i.test(noUser[0]), JSON.stringify(noUser));

  const deadSession = await runSave({
    sb: { auth: { getSession: async () => ({ data: { session: null } }), refreshSession: async () => ({ data: { session: null }, error: { message: 'expired' } }) } },
    currentUser: { id: 'u1' }, currentBrand: { id: 'b1' }, _brandLoadFailed: false,
  });
  ok('an expired session tells the user instead of only debug-logging',
    deadSession.length === 1 && /not being saved/i.test(deadSession[0]), JSON.stringify(deadSession));

  // control: the pre-fix bodies of both branches were silent.
  const OLD_A = `function old_a(){ if (!sb || !currentUser) { debugLog('skip'); return; } }`;
  const oldToasts = [];
  compile(OLD_A, 'old_a', { sb: null, currentUser: null, debugLog: () => {}, showToast: m => oldToasts.push(m) })();
  ok('[control] the OLD give-up path said nothing to the user', oldToasts.length === 0);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   P5 — un-debounced, unserialized keystroke saves can roll back typing
   ═══════════════════════════════════════════════════════════════════════════ */
section('P5 — keystroke saves must be debounced and serialized so a slow write cannot win');
{
  // BEHAVIOURAL: type "hello world" one character at a time into a network whose FIRST
  // request is slow and whose later ones are fast — the classic out-of-order overwrite.
  // The DB keeps whatever the last-LANDING request carried.
  async function typeInto({ debounce, serialize }) {
    let dbValue = null;
    let inFlight = 0, maxInFlight = 0;
    let chain = Promise.resolve();
    let timer = null;
    let settings = { brandName: '' };
    const latencyFor = n => (n === 1 ? 120 : 5);   // the first write is slow
    let writeNo = 0;
    const doWrite = () => {
      const body = settings.brandName;            // whole-row PATCH, body captured at send
      const n = ++writeNo;
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise(res => setTimeout(() => { dbValue = body; inFlight--; res(); }, latencyFor(n)));
    };
    const queue = () => (serialize ? (chain = chain.then(doWrite)) : doWrite());
    const save = () => {
      if (!debounce) { queue(); return; }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; queue(); }, 20);
    };
    const word = 'hello world';
    for (let i = 1; i <= word.length; i++) { settings.brandName = word.slice(0, i); save(); await new Promise(r => setTimeout(r, 8)); }
    // flush + drain
    if (timer) { clearTimeout(timer); queue(); }
    await new Promise(r => setTimeout(r, 400));
    await chain;
    return { dbValue, maxInFlight };
  }

  const oldWay = await typeInto({ debounce: false, serialize: false });
  ok('[control] OLD un-debounced, unserialized saves overlap',
    oldWay.maxInFlight > 1, `maxInFlight=${oldWay.maxInFlight}`);
  ok('[control] OLD un-debounced, unserialized saves let a slow write overwrite a newer one',
    oldWay.dbValue !== 'hello world', `db kept "${oldWay.dbValue}"`);

  const newWay = await typeInto({ debounce: true, serialize: true });
  ok('NEW debounced+serialized saves never overlap', newWay.maxInFlight === 1, `maxInFlight=${newWay.maxInFlight}`);
  ok('NEW debounced+serialized saves leave the newest text in the database',
    newWay.dbValue === 'hello world', `db kept "${newWay.dbValue}"`);

  // BEHAVIOURAL: the real updateSetting must route to the debounced path.
  let immediate = 0, debounced = 0;
  const upd = compile(extractFn('updateSetting'), 'updateSetting', {
    settings: {}, saveSettings: () => immediate++, saveSettingsDebounced: () => debounced++, spUpdateQuality: () => {},
  });
  upd('brandName', 'x'); upd('brandName', 'xy');
  ok('the real updateSetting uses the DEBOUNCED save', debounced === 2 && immediate === 0);

  // BEHAVIOURAL: the real serializer must run its writes strictly one after another.
  let live = 0, peak = 0, order = [];
  const chainRun = async () => {
    let c = Promise.resolve();
    const write = i => new Promise(res => { live++; peak = Math.max(peak, live); setTimeout(() => { order.push(i); live--; res(); }, 30 - i * 5); });
    for (let i = 0; i < 4; i++) c = c.then(() => write(i), () => write(i));
    await c;
  };
  await chainRun();
  ok('a promise chain of the shape used by _queueBrandSave keeps exactly one write in flight', peak === 1, `peak=${peak}`);
  ok('and preserves submission order despite decreasing latency', order.join(',') === '0,1,2,3', order.join(','));

  // STRUCTURAL: the pieces are wired.
  ok('[structural] saveSettingsDebounced exists and debounces', /function saveSettingsDebounced\(\)/.test(html) && /BRAND_SAVE_DEBOUNCE_MS/.test(html));
  ok('[structural] brand writes go through one serialized chain', /_brandSaveChain = _brandSaveChain\.then\(/.test(html));
  ok('[structural] a pending keystroke save is flushed when the tab goes away', /function flushBrandSave\(\)/.test(html) && /pagehide/.test(html));
  ok('[structural] discrete actions still save immediately', /function saveSettings\(\) \{[\s\S]{0,400}_queueBrandSave\(\)/.test(html));
}

/* ═══════════════════════════════════════════════════════════════════════════════
   P6 — a queued save must not write one brand's library into another
   ═══════════════════════════════════════════════════════════════════════════ */
section('P6 — a save queued for brand A must never land in brand B');
{
  // BEHAVIOURAL. Reproduce the exact window: switchBrand assigns currentBrand = B and only
  // replaces `state` after an awaited load. Fire a queued save inside that window.
  async function raceSave({ fixed }) {
    const db = makeSb({ ideas: [] });
    const globals = { currentBrand: { id: 'A' }, state: [{ title: 'A-idea', script: 'a', status: 'pending' }] };

    // OLD: the chained callback reads the globals when it RUNS.
    const oldBody = async () => {
      if (!globals.currentBrand) return;
      const rows = globals.state.map(i => ({ brand_id: globals.currentBrand.id, title: i.title, script: i.script }));
      await db.sb.from('ideas').insert(rows);
    };
    // NEW: brand + rows captured SYNCHRONOUSLY at queue time.
    const capturedId = globals.currentBrand.id;
    const capturedRows = globals.state.map(i => ({ brand_id: capturedId, title: i.title, script: i.script }));
    const newBody = async () => { await db.sb.from('ideas').insert(capturedRows); };

    // the switch: currentBrand flips first, state follows after an awaited round trip
    const doSwitch = (async () => {
      globals.currentBrand = { id: 'B' };
      await new Promise(r => setTimeout(r, 25));          // ← the window
      globals.state = [{ title: 'B-idea', script: 'b', status: 'pending' }];
    })();

    await new Promise(r => setTimeout(r, 5));             // land inside the window
    await (fixed ? newBody() : oldBody());
    await doSwitch;
    return db.rows.ideas;
  }

  const oldRows = await raceSave({ fixed: false });
  ok('[control] the OLD save files brand A\'s ideas under brand B',
    oldRows.length === 1 && oldRows[0].title === 'A-idea' && oldRows[0].brand_id === 'B',
    JSON.stringify(oldRows));

  const newRows = await raceSave({ fixed: true });
  ok('the NEW save files brand A\'s ideas under brand A',
    newRows.length === 1 && newRows[0].title === 'A-idea' && newRows[0].brand_id === 'A',
    JSON.stringify(newRows));

  // BEHAVIOURAL: the real saveIdeasToDB must capture the brand id synchronously.
  const q = extractFn('saveIdeasToDB');
  ok('[structural] saveIdeasToDB captures the brand id at QUEUE time', /const _brandId = \(currentBrand && currentBrand\.id\) \|\| null;/.test(q));
  ok('[structural] saveIdeasToDB captures the ROWS at QUEUE time',    /const _rows = _buildIdeaRows\(_brandId\);/.test(q));
  ok('[structural] the chained callback uses the captured values, not the globals',
    /_ideasSaveChain\.then\(\(\) => _saveIdeasToDBNow\(_brandId, _rows\)\)/.test(q));
  const now = extractFn('_saveIdeasToDBNow');
  ok('[structural] _saveIdeasToDBNow no longer reads currentBrand', !/currentBrand/.test(now));
  ok('[structural] _saveIdeasToDBNow no longer reads state',        !/\bstate\b/.test(now));

  // BEHAVIOURAL: brandGate must detect both a brand change and a superseded switch.
  const gateSrc = extractFn('brandGate');
  const mk = init => {
    const box = { currentBrand: init.brand, _switchSeq: init.seq };
    const f = new Function('box', `let currentBrand = box.currentBrand, _switchSeq = box._switchSeq;
      ${gateSrc}
      const g = brandGate();
      return function(next){ currentBrand = next.brand; _switchSeq = next.seq; return g(); };`);
    return f(box);
  };
  const g1 = mk({ brand: { id: 'A' }, seq: 3 });
  ok('brandGate: same brand + same seq → still same brand', g1({ brand: { id: 'A' }, seq: 3 }) === true);
  const g2 = mk({ brand: { id: 'A' }, seq: 3 });
  ok('brandGate: brand changed → NOT the same brand', g2({ brand: { id: 'B' }, seq: 4 }) === false);
  const g3 = mk({ brand: { id: 'A' }, seq: 3 });
  ok('brandGate: switch seq moved even if it landed back on A → NOT safe',
    g3({ brand: { id: 'A' }, seq: 4 }) === false);

  // STRUCTURAL: every generator that pushes after an await is gated.
  for (const fn of ['autoRefillCheck', 'generateNewIdeas', 'usePAAQuestion', 'nbDevelop', 'sparkDevelop', 'ideaDevelop']) {
    const src = extractFn(fn);
    ok(`[structural] ${fn} takes a brandGate before its fetch`, /brandGate\(\)/.test(src), fn);
  }
  for (const fn of ['autoRefillCheck', 'generateNewIdeas', 'usePAAQuestion', 'nbDevelop', 'sparkDevelop']) {
    const src = extractFn(fn);
    ok(`[structural] ${fn} re-checks the brand before pushing into state`,
      /_sameBrand\(\)|_stillSameBrand\(\)/.test(src), fn);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════
   P7 — the four remaining delete-then-insert tables
   ═══════════════════════════════════════════════════════════════════════════ */
section('P7 — remixes / product refs / bookmarks / prompt history must write before deleting');
{
  const REPLACE = extractFn('_replaceBrandRows');

  async function run(table, seed, rows, opts, fail) {
    const db = makeSb({ [table]: seed }, { fail: fail || {} });
    const fn = compile(REPLACE, '_replaceBrandRows', { sb: db.sb, console: { warn() {}, error() {}, log() {} } });
    const res = await fn(table, 'b1', rows, opts);
    return { db, res };
  }
  const SEED = [{ id: 1, brand_id: 'b1', remixed_text: 'OLD one' }, { id: 2, brand_id: 'b1', remixed_text: 'OLD two' }];
  const NEW = [{ brand_id: 'b1', remixed_text: 'NEW one' }, { brand_id: 'b1', remixed_text: 'NEW two' }, { brand_id: 'b1', remixed_text: 'NEW three' }];

  // control: the old shape, delete-then-insert with an insert that fails
  {
    const db = makeSb({ remixes: SEED.map(r => ({ ...r })) }, { fail: { 'insert:remixes': 'offline' } });
    await db.sb.from('remixes').delete().eq('brand_id', 'b1');
    const { error } = await db.sb.from('remixes').insert(NEW);
    ok('[control] OLD delete-then-insert loses the whole list when the insert fails',
      !!error && db.rows.remixes.length === 0, JSON.stringify(db.rows.remixes));
  }
  {
    const { db, res } = await run('remixes', SEED.map(r => ({ ...r })), NEW, null, { 'insert:remixes': 'offline' });
    ok('NEW replace keeps the previous list when the insert fails',
      res.ok === false && db.rows.remixes.length === 2 && db.rows.remixes.every(r => /^OLD/.test(r.remixed_text)),
      JSON.stringify(db.rows.remixes));
    ok('NEW replace reports the failure to its caller', res.ok === false && !!res.error);
    ok('NEW replace issued NO delete at all on a failed insert', !db.log.includes('delete:remixes'), db.log.join(','));
  }
  {
    const { db, res } = await run('remixes', SEED.map(r => ({ ...r })), NEW, null, null);
    ok('happy path replaces the list exactly once', res.ok === true && db.rows.remixes.length === 3);
    ok('happy path leaves only the new content', db.rows.remixes.every(r => /^NEW/.test(r.remixed_text)), JSON.stringify(db.rows.remixes));
    ok('happy path inserts BEFORE it deletes',
      db.log.indexOf('insert:remixes') < db.log.indexOf('delete:remixes'), db.log.join(','));
  }
  {
    // a failed cleanup is not a failed save
    const { db, res } = await run('remixes', SEED.map(r => ({ ...r })), NEW, null, { 'delete:remixes': 'boom' });
    ok('a failed cleanup still reports success and keeps every NEW row',
      res.ok === true && db.rows.remixes.filter(r => /^NEW/.test(r.remixed_text)).length === 3);
  }
  {
    // could not read the old ids → write anyway, never blind-delete
    const { db, res } = await run('remixes', SEED.map(r => ({ ...r })), NEW, null, { 'select:remixes': 'boom' });
    ok('an unreadable id list skips cleanup rather than risking a delete',
      res.ok === true && !db.log.includes('delete:remixes'), db.log.join(','));
    ok('...and the new rows are still written', db.rows.remixes.filter(r => /^NEW/.test(r.remixed_text)).length === 3);
  }
  {
    // empty list + unreadable ids → refuse
    const { db, res } = await run('remixes', SEED.map(r => ({ ...r })), [], null, { 'select:remixes': 'boom' });
    ok('an empty list with unreadable ids refuses to blind-delete',
      res.ok === false && db.rows.remixes.length === 2, JSON.stringify(db.rows.remixes));
  }
  {
    // bookmarks live as ONE __bookmarks__ row inside `competitors`, alongside legacy rows
    const seed = [
      { id: 1, brand_id: 'b1', name: '__bookmarks__', notes: '["OLD"]' },
      { id: 2, brand_id: 'b1', name: 'A legacy competitor', url: 'https://x' },
    ];
    const { db, res } = await run('competitors', seed, [{ brand_id: 'b1', name: '__bookmarks__', notes: '["NEW"]' }], { match: { name: '__bookmarks__' } }, null);
    ok('bookmarks save replaces only the __bookmarks__ row', res.ok === true &&
      db.rows.competitors.filter(r => r.name === '__bookmarks__').length === 1 &&
      db.rows.competitors.find(r => r.name === '__bookmarks__').notes === '["NEW"]');
    ok('bookmarks save no longer wipes legacy competitor rows',
      db.rows.competitors.some(r => r.name === 'A legacy competitor'), JSON.stringify(db.rows.competitors));
  }

  // STRUCTURAL: no raw delete-then-insert left in the four savers.
  for (const fn of ['saveRemixesToDB', 'saveProductRefsToDB', 'saveBookmarksToDB', 'savePromptHistoryToDB']) {
    const src = extractFn(fn);
    ok(`[structural] ${fn} uses write-before-delete`, /_replaceBrandRows\(/.test(src) && !/\.delete\(\)/.test(src), fn);
    ok(`[structural] ${fn} refuses to save a list that never loaded`, /_listLoaded\(/.test(src), fn);
  }
  // a load error must no longer read as an empty list
  for (const fn of ['loadRemixesFromDB', 'loadProductRefsFromDB', 'loadBookmarksFromDB', 'loadPromptHistoryFromDB']) {
    const src = extractFn(fn);
    ok(`[structural] ${fn} throws on a read error instead of returning []`,
      /if \(error\) \{[^}]*throw new Error/.test(src), fn);
  }

  // BEHAVIOURAL: the "one transient read failure then one new item" wipe is closed.
  {
    const db = makeSb({ remixes: [{ id: 1, brand_id: 'b1', remixed_text: 'REAL' }] });
    const loadSrc = extractFn('loadRemixesFromDB');
    const failing = makeSb({ remixes: [] }, { fail: { 'select:remixes': 'network' } });
    const load = compile(loadSrc, 'loadRemixesFromDB', { currentBrand: { id: 'b1' }, sb: failing.sb, console: { error() {} } });
    let threw = false;
    try { await load(); } catch (e) { threw = true; }
    ok('a transient read failure THROWS rather than yielding an empty list', threw);

    // and the save then refuses, so the REAL row survives
    const saveSrc = extractFn('saveRemixesToDB');
    let warned = 0;
    const save = compile(saveSrc, 'saveRemixesToDB', {
      currentBrand: { id: 'b1' }, sb: db.sb, remixes: [],
      _listLoaded: () => false, _warnListNotSaved: () => warned++,
      _replaceBrandRows: async () => { throw new Error('must not be called'); },
      console: { warn() {}, error() {} },
    });
    const r = await save();
    ok('a save on a never-loaded list is refused', r && r.ok === false);
    ok('...the user is told', warned === 1);
    ok('...and the real row is untouched', db.rows.remixes.length === 1 && db.rows.remixes[0].remixed_text === 'REAL');
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════
   P8 — the mechanical set
   ═══════════════════════════════════════════════════════════════════════════ */
section('P8 — photo size cap, stale stage tab, doneAt, state[id] guards, saveEditSignals');
{
  // ── saveEditSignals: BEHAVIOURAL, with a control ──────────────────────────────
  const sigSrc = extractFn('saveEditSignals');
  // v665: the stub is now KEY-AWARE. It used to record whatever the last lsSet wrote, whatever key
  // it was for — so the moment saveEditSignals started keeping a second value (the lifetime edit
  // tally brainCountNewSignals needs) these assertions read that instead of the signal list and
  // failed for a reason that had nothing to do with what they test.
  const runSig = (src, name, stored) => {
    const wrote = {};
    const fn = compile(src, name, {
      lsGet: k => (k === 'edit_signals' ? stored : (k in wrote ? wrote[k] : null)),
      lsSet: (k, v) => { wrote[k] = String(v); },
      currentBrand: null, sb: null, Date, console: { error() {} },
    });
    const out = { wrote, get saved() { return wrote.edit_signals == null ? null : wrote.edit_signals; } };
    try { fn([{ field: 'hook', before: 'a', after: 'b' }]); out.threw = false; }
    catch (e) { out.threw = true; out.error = e; }
    return out;
  };
  const OLD_SIG = `function saveEditSignals_OLD(newOnes) {
    let arr = [];
    try { arr = JSON.parse(lsGet('edit_signals') || '[]'); } catch(e) {}
    arr = arr.concat(newOnes).slice(-60);
    try { lsSet('edit_signals',JSON.stringify(arr)); } catch(e) {}
  }`;
  const oldCorrupt = runSig(OLD_SIG, 'saveEditSignals_OLD', '{"not":"an array"}');
  ok('[control] OLD saveEditSignals THROWS on a corrupted stored value',
    oldCorrupt.threw && /concat is not a function/.test(oldCorrupt.error.message), String(oldCorrupt.error));
  const newCorrupt = runSig(sigSrc, 'saveEditSignals', '{"not":"an array"}');
  ok('NEW saveEditSignals survives a corrupted stored value', !newCorrupt.threw);
  ok('...and still records the new signal', !!newCorrupt.saved && JSON.parse(newCorrupt.saved).length === 1);
  const newNumber = runSig(sigSrc, 'saveEditSignals', '5');
  ok('NEW saveEditSignals survives a stored number', !newNumber.threw);
  const newNormal = runSig(sigSrc, 'saveEditSignals', '[{"field":"old"}]');
  ok('NEW saveEditSignals still appends to a healthy list',
    !newNormal.threw && JSON.parse(newNormal.saved).length === 2);
  // v665 — THE LIFETIME TALLY. `edit_signals` is capped at the newest 60, and brainCountNewSignals
  // used its length as "how much has this brain been taught". So at 60 lifetime edits the count
  // stopped rising, `since` could never reach the auto-distill threshold again, and the brand brain
  // stopped learning FOREVER on the accounts using the app most. saveEditSignals must keep a tally
  // that only grows. (The behaviour is proved end to end in brain-learning-loop.mjs; this is the
  // writer's own half.)
  ok('saveEditSignals keeps a lifetime edit tally that outlives the 60-signal cap',
    newNormal.wrote.brain_edit_total === '1', JSON.stringify(newNormal.wrote.brain_edit_total));

  // the approval path must not be abortable by it
  ok('[structural] tvCaptureEdits cannot abort an approval on a signal failure',
    /try \{ saveEditSignals\(signals\); \} catch/.test(extractFn('tvCaptureEdits')));

  // ── the stale Pipeline stage tab: BEHAVIOURAL, with a control ─────────────────
  {
    const sim = (fixed, lastViewed, approvedStatus) => {
      let activePipelineStage = lastViewed;
      const state = { 7: { status: approvedStatus } };
      const jid = 7;
      if (fixed) { const it = state[jid]; activePipelineStage = (it && it.status) ? it.status : 'filming'; }
      const visible = Object.values(state).filter(i => i.status === activePipelineStage);
      return { activePipelineStage, visibleCount: visible.length };
    };
    const oldJump = sim(false, 'done', 'filming');
    ok('[control] OLD approve-jump lands on the stale tab and shows nothing',
      oldJump.activePipelineStage === 'done' && oldJump.visibleCount === 0);
    const newJump = sim(true, 'done', 'filming');
    ok('NEW approve-jump lands on the stage the post is actually in',
      newJump.activePipelineStage === 'filming' && newJump.visibleCount === 1);
    ok('[structural] the approve-jump toast sets the stage before switching view',
      /activePipelineStage = \(it && it\.status\) \? it\.status : 'filming'/.test(extractFn('apJumpToast')));
    ok('[structural] the batch-approve toast resets the stage too',
      /activePipelineStage='filming'/.test(extractFn('batchApprove')));
  }

  // ── doneAt on a second device: BEHAVIOURAL, with a control ────────────────────
  {
    const CUTOFF = Date.now() - 30 * 24 * 3600 * 1000;
    const oldish = Date.now() - 90 * 24 * 3600 * 1000;
    const prune = items => items.filter(i => !i.doneAt || i.doneAt > CUTOFF);
    const oldDevice2 = prune([{ title: 'x', status: 'done' }]);                 // no doneAt at all
    ok('[control] OLD second device never prunes a 90-day-old Done post', oldDevice2.length === 1);
    const derived = { title: 'x', status: 'done', doneAt: oldish };             // derived from row recency
    ok('NEW second device prunes it once doneAt is derived', prune([derived]).length === 0);
    const recent = { title: 'y', status: 'done', doneAt: Date.now() - 3 * 24 * 3600 * 1000 };
    ok('...and still keeps a recent Done post', prune([recent]).length === 1);
    const load = extractFn('loadIdeasFromDB');
    ok('[structural] loadIdeasFromDB derives doneAt for done rows',
      /_dbDoneAt/.test(load) && /_ideaRowRecency\(row\)/.test(load));
    ok('[structural] a real LOCAL doneAt still overrides the derived proxy',
      /if \(sv\.doneAt\) it\.doneAt = sv\.doneAt;/.test(extractFn('reconcileLocalStatus')));
    ok('[structural] the derived key is not written to the database',
      !/_dbDoneAt/.test(extractFn('_buildIdeaRows')));
  }

  // ── state[id] guards: BEHAVIOURAL, with a control ─────────────────────────────
  {
    const guarded = ['copyIdea', 'generateMore', 'dismissWithReason', 'assignIdea', 'addAndAssign'];
    for (const fn of guarded) {
      const src = extractFn(fn);
      ok(`[structural] ${fn} guards a missing state[id]`,
        /if \(!(state\[id\]|i)\)|if\(!state\[id\]\)/.test(src), fn);
    }
    // control: the pre-fix copyIdea crashed on a stale id
    const OLD_COPY = `function copyIdea_OLD(id){ const i=state[id]; return i.day; }`;
    let oldThrew = false;
    try { compile(OLD_COPY, 'copyIdea_OLD', { state: {} })(99); } catch (e) { oldThrew = true; }
    ok('[control] the OLD unguarded deref throws on a stale id', oldThrew);
    let newThrew = false, toasted = 0;
    try {
      compile(extractFn('copyIdea'), 'copyIdea', {
        state: {}, showToast: () => toasted++, FORMAT_LABELS: {}, navigator: { clipboard: { writeText: () => Promise.resolve() } },
        copyFallback: () => {}, ICO: {}, setTimeout,
      })(99, { innerHTML: '' });
    } catch (e) { newThrew = true; }
    ok('the NEW guarded copyIdea returns quietly on a stale id', !newThrew && toasted === 1);
  }

  // ── base64 photo caps ────────────────────────────────────────────────────────
  {
    ok('[structural] a shared downscaler exists', /function _shrinkImageDataUrl\(/.test(html));
    ok('[structural] the logo goes through it', /_shrinkImageDataUrl\(ev\.target\.result, PHOTO_MAX_PX, PHOTO_MAX_BYTES/.test(extractFn('handleLogoUpload')));
    ok('[structural] the founder photo goes through it too', /_shrinkImageDataUrl\(/.test(extractFn('handleFounderPhoto')));
    ok('[structural] the founder photo now has a size cap at all', /file\.size > \d+/.test(extractFn('handleFounderPhoto')));
    ok('[structural] the cap is well under the ~5MB origin quota', /PHOTO_MAX_BYTES = (\d+)/.test(html) && Number(RegExp.$1) <= 600000);

    // BEHAVIOURAL (modelled): a canvas can't run here, so the quality-reduction loop is
    // replayed with toDataURL modelled as "size falls with quality". What matters is that it
    // TERMINATES and that an image it can't get under the cap is REJECTED rather than stored.
    const shrink = new Function('maxBytes', 'startBytes', `
      let q = 0.86, iters = 0;
      const render = qq => Math.round(startBytes * qq);
      let size = render(q);
      while (size > maxBytes && q > 0.4) { q -= 0.12; size = render(q); iters++; if (iters > 50) break; }
      return { size, q, iters, underCap: size <= maxBytes };`);
    const easy = shrink(400000, 900000);      // a 900KB source: a couple of steps get under 400KB
    ok('the quality-reduction loop terminates in a bounded number of steps', easy.iters <= 4, `iters=${easy.iters}`);
    ok('...and lands under the cap for a reasonable image', easy.underCap === true, `size=${easy.size}`);
    const huge = shrink(400000, 20000000);    // pathological: cannot be squeezed under the cap
    ok('a pathological image still terminates instead of looping forever', huge.iters <= 4, `iters=${huge.iters}`);
    ok('[structural] an image that stays over the cap is REJECTED, not stored',
      /if \(out\.length > maxBytes\) \{ cb\(null, 'too-large'\); return; \}/.test(html));
    ok('[control] an UNCAPPED 2MB file would have stored ~2.7MB of base64',
      Math.round(2000000 * 4 / 3) > 2600000);

    // localStorage quota must report itself
    ok('[structural] localStorage writes are guarded and report a full quota', /function _lsWriteGuarded\(/.test(html) && /QuotaExceededError/.test(html));
    let warned = 0;
    const guard = compile(extractFn('_lsWriteGuarded'), '_lsWriteGuarded', {
      localStorage: { setItem() { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } },
      console: { error() {} }, showToast: () => warned++, Date, _lsQuotaWarnedAt: 0,
    });
    const res = guard('k', 'v');
    ok('a full quota returns false instead of pretending to have saved', res === false);
    ok('...and tells the user', warned === 1);
    const okGuard = compile(extractFn('_lsWriteGuarded'), '_lsWriteGuarded', {
      localStorage: { setItem() {} }, console: { error() {} }, showToast: () => {}, Date, _lsQuotaWarnedAt: 0,
    });
    ok('a healthy write still returns true', okGuard('k', 'v') === true);
    ok('[structural] the approval-recovery snapshot uses the guarded writer',
      /_lsWriteGuarded\(bkey\(STORAGE_KEY\)/.test(extractFn('saveState')));
  }
}
}

// Running this file directly does nothing useful — it is a module consumed by
// data-integrity.mjs so both suites report one combined pass/fail line.
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('This module is run by scripts/verify/data-integrity.mjs — run that instead.');
}
