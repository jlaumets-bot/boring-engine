#!/usr/bin/env node
// Verifies the data-integrity fixes in app.html.
//
// The interesting ones (FIX 1 and FIX 3) are BEHAVIOURAL: the real function bodies are
// extracted out of app.html and executed against a fake supabase client, next to the code
// exactly as it was before the fix. Every behavioural test is written so it FAILS against
// the old code — that is the only way to know the assertion has teeth.
//
// Run: node scripts/verify/data-integrity.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP = path.join(ROOT, 'app.html');
const html = fs.readFileSync(APP, 'utf8');

let failures = [];
let checks = 0;
function ok(name, cond, detail) {
  checks++;
  if (cond) { console.log(`  ok   ${name}`); return; }
  console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  failures.push(name);
}
function section(t) { console.log('\n' + t); }

// ── source extraction ──────────────────────────────────────────────────────────
function extractFn(name, src = html) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`extractFn: ${name} not found in app.html`);
  const asyncPrefix = src.slice(Math.max(0, start - 6), start) === 'async ';
  const from = asyncPrefix ? start - 6 : start;
  // v638: braces inside STRINGS, TEMPLATES and COMMENTS must not be counted. A naive counter
  // broke the moment a function contained `charAt(0) === '{'` — it reported "unbalanced braces"
  // for perfectly valid code and took the whole gate down with it. Skipping quoted spans and
  // comments keeps this helper honest for every function it is pointed at, rather than forcing
  // app code to avoid a legal character.
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      for (i++; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }          // escaped char — skip the pair
        if (src[i] === quote) break;                      // closing quote
        if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
          // template interpolation: real code, so count its braces normally
          let d2 = 0; i++;
          for (; i < src.length; i++) {
            if (src[i] === '{') d2++;
            else if (src[i] === '}') { d2--; if (d2 === 0) break; }
          }
        }
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(from, i + 1); }
  }
  throw new Error(`extractFn: unbalanced braces for ${name}`);
}
// Build a callable from extracted source. Free variables are supplied as parameters.
function compile(fnSrc, name, deps) {
  const keys = Object.keys(deps);
  const factory = new Function(...keys, `${fnSrc}\nreturn ${name};`);
  return factory(...keys.map(k => deps[k]));
}

// ── fake supabase ──────────────────────────────────────────────────────────────
function makeDb(rows, opts = {}) {
  const db = {
    rows: rows.map(r => ({ ...r })),
    nextId: Math.max(0, ...rows.map(r => Number(r.id) || 0)) + 1,
    opts,
    log: [],
  };
  class Q {
    constructor(op, payload) { this.op = op; this.payload = payload; this.filters = {}; }
    eq(c, v) { this.filters[c] = v; return this; }
    in(c, vals) { this.inCol = c; this.inVals = vals; return this; }
    // v638: a DELETE can now carry .select('id'), because that is the only way to detect a
    // PostgREST/RLS refusal — it resolves with ZERO ROWS and NO error, so `error` alone is blind.
    select(cols) { this.returning = cols || '*'; return this; }
    then(res, rej) { return Promise.resolve().then(() => run(this)).then(res, rej); }
  }
  function matches(row, q) {
    for (const [c, v] of Object.entries(q.filters)) if (row[c] !== v) return false;
    if (q.inCol && !q.inVals.includes(row[q.inCol])) return false;
    return true;
  }
  function run(q) {
    db.log.push(q.op);
    if (q.op === 'select') {
      if (db.opts.failSelect) return { data: null, error: { message: 'select boom' } };
      return { data: db.rows.filter(r => matches(r, q)).map(r => ({ id: r.id, title: r.title })), error: null };
    }
    if (q.op === 'delete') {
      if (db.opts.failDelete) return { data: null, error: { message: 'delete boom' } };
      // THE FAILURE MODE THAT MATTERS: an RLS refusal deletes nothing and reports no error.
      // Modelled explicitly so the gate can prove the new .select('id') row-count check sees it —
      // before v638 this was indistinguishable from success and silently duplicated the library.
      if (db.opts.silentRefuseDelete) return { data: [], error: null };
      const hit = db.rows.filter(r => matches(r, q));
      db.rows = db.rows.filter(r => !matches(r, q));
      return { data: hit.map(r => ({ id: r.id })), error: null };
    }
    if (q.op === 'insert') {
      const batch = Array.isArray(q.payload) ? q.payload : [q.payload];
      const bad = batch.find(r => db.opts.failInsertTitles && db.opts.failInsertTitles.includes(r.title));
      if (db.opts.failInsert || bad) return { error: { message: 'insert boom' } };
      batch.forEach(r => db.rows.push({ ...r, id: db.nextId++ }));
      return { error: null };
    }
    throw new Error('unknown op ' + q.op);
  }
  db.sb = { from: () => ({
    select: () => new Q('select'),
    insert: p => new Q('insert', p),
    delete: () => new Q('delete'),
  }) };
  return db;
}

const SEED = [
  { id: 1, brand_id: 'b1', title: 'Sweeteners are not electrolytes', script: 'OLD script one' },
  { id: 2, brand_id: 'b1', title: 'Between rounds dilution', script: 'OLD script two' },
  { id: 3, brand_id: 'b1', title: 'Why first factory orders fail', script: 'OLD script three' },
];
const STATE = SEED.map(r => ({ title: r.title, script: 'NEW ' + r.title, format: 'video', status: 'pending' }));

// The save exactly as it was before the fix: every DELETE completes before the first INSERT.
const OLD_SAVE = `
async function _saveIdeasToDBNow_OLD() {
  if (!currentBrand) return;
  const asText = v => Array.isArray(v) ? v.join(' ') : (v == null ? '' : String(v));
  const rows = state.map(idea => ({ brand_id: currentBrand.id, title: asText(idea.title), script: asText(idea.script), format: idea.format || 'video', status: idea.status || 'pending' }));
  const titles = rows.map(r => r.title).filter(Boolean);
  for (let i = 0; i < titles.length; i += 50) {
    await sb.from('ideas').delete().eq('brand_id', currentBrand.id).in('title', titles.slice(i, i + 50));
  }
  if (rows.length) {
    for (let i = 0; i < rows.length; i += 50) {
      const batch = rows.slice(i, i + 50);
      const { error } = await sb.from('ideas').insert(batch);
      if (error) { for (const row of batch) { const r2 = await sb.from('ideas').insert(row); if (r2.error) {} } }
    }
  }
}`;

async function runSave(fnSrc, name, db, state) {
  const deps = {
    sb: db.sb,
    currentBrand: { id: 'b1' },
    state,
    lsSet: () => {},
    console: { error() {}, warn() {}, log() {} },
  };
  // The fixed save takes (brandId, rows) — both captured SYNCHRONOUSLY at queue time so a
  // brand switch mid-flight can't redirect the write (see the P6 section below). Build the
  // rows with the app's own _buildIdeaRows so this exercises the real payload builder too.
  if (name === '_saveIdeasToDBNow') {
    const build = compile(extractFn('_buildIdeaRows'), '_buildIdeaRows', deps);
    const fn = compile(fnSrc, name, deps);
    try { await fn('b1', build('b1')); return { threw: false }; }
    catch (e) { return { threw: true, error: e }; }
  }
  const fn = compile(fnSrc, name, deps);
  try { await fn(); return { threw: false }; }
  catch (e) { return { threw: true, error: e }; }
}

// ── FIX 1 ─────────────────────────────────────────────────────────────────────
section('FIX 1 — save must never leave the library absent from the database');
{
  const NEW_SAVE = extractFn('_saveIdeasToDBNow');
  ok('new save no longer deletes by title before inserting',
    !/delete\(\)[\s\S]{0,120}\.in\('title'/.test(NEW_SAVE));
  ok('new save reads the ids it is replacing before writing',
    /select\('id,title'\)/.test(NEW_SAVE));

  // Old code, connection dies at insert time (deletes already went through).
  const dbOld = makeDb(SEED, { failInsert: true });
  await runSave(OLD_SAVE, '_saveIdeasToDBNow_OLD', dbOld, STATE);
  ok('[control] OLD code destroys the whole library when the insert fails',
    dbOld.rows.length === 0, `expected 0 surviving rows, got ${dbOld.rows.length}`);

  // New code, identical failure.
  const dbNew = makeDb(SEED, { failInsert: true });
  const r = await runSave(NEW_SAVE, '_saveIdeasToDBNow', dbNew, STATE);
  ok('NEW code loses nothing when the insert fails',
    dbNew.rows.length === 3 && dbNew.rows.every(x => x.script.startsWith('OLD')),
    `surviving rows: ${JSON.stringify(dbNew.rows.map(x => x.title))}`);
  ok('NEW code reports the failure to its caller (throws)', r.threw === true);

  // Happy path: content replaced exactly once, no leftover duplicates.
  const dbOk = makeDb(SEED, {});
  const r2 = await runSave(NEW_SAVE, '_saveIdeasToDBNow', dbOk, STATE);
  ok('happy path replaces content and leaves no duplicates',
    !r2.threw && dbOk.rows.length === 3 && dbOk.rows.every(x => x.script.startsWith('NEW')),
    `${dbOk.rows.length} rows: ${JSON.stringify(dbOk.rows.map(x => x.script))}`);

  // Partial failure: the row that could not be re-written keeps its old copy.
  const dbPart = makeDb(SEED, { failInsertTitles: ['Between rounds dilution'] });
  const r3 = await runSave(NEW_SAVE, '_saveIdeasToDBNow', dbPart, STATE);
  const kept = dbPart.rows.find(x => x.title === 'Between rounds dilution');
  ok('a row that fails to save keeps its previous copy',
    !!kept && kept.script === 'OLD script two', `got ${kept && kept.script}`);
  ok('the other rows still got their new content',
    dbPart.rows.filter(x => x.script.startsWith('NEW')).length === 2);
  ok('partial failure is reported to the caller', r3.threw === true);

  // Cleanup outage must not fail the save nor lose data.
  const dbDel = makeDb(SEED, { failDelete: true });
  const r4 = await runSave(NEW_SAVE, '_saveIdeasToDBNow', dbDel, STATE);
  ok('a failed cleanup does not fail the save and keeps every new row',
    !r4.threw && dbDel.rows.filter(x => x.script.startsWith('NEW')).length === 3);
}

// ── FIX 2 ─────────────────────────────────────────────────────────────────────
section('FIX 2 — save failures are surfaced, success is not claimed before the write');
{
  const wrapper = extractFn('saveIdeasToDB');
  ok('saveIdeasToDB routes failures to notifyIdeasSaveFailed', /notifyIdeasSaveFailed/.test(wrapper));
  ok('saveIdeasToDB resolves to a result object instead of rejecting', /\{\s*ok:\s*true\s*\}/.test(wrapper));
  ok('the serialized chain survives a failed save', /_ideasSaveChain\s*=\s*run\.then\(/.test(wrapper));

  const notify = extractFn('notifyIdeasSaveFailed');
  ok('the user is told their work is only on this device', /only on this device/i.test(notify));
  ok('the failure notice is not console-only', /showToast/.test(notify));

  const tv = extractFn('tvApprove');
  ok('tvApprove waits for the write before claiming "Added to Pipeline"',
    /Promise\.resolve\(_saved\)\.then/.test(tv) && /r\.ok === false/.test(tv));
  ok('tvApprove no longer fires the success toast synchronously',
    !/^\s*if \(typeof showToast === 'function'\) showToast\(_edits/m.test(tv));

  const jump = extractFn('apJumpToast');
  ok('apJumpToast waits on the pending save', /_lastIdeasSave/.test(jump));
  ok('apJumpToast stays silent about success when the save failed', /r\.ok === false/.test(jump));

  ok('saveState hands the save result back to callers', /return saveIdeasToDB\(\);/.test(extractFn('saveState')));
  ok('saveGeneratedIdeas hands the save result back to callers', /return saveIdeasToDB\(\);/.test(extractFn('saveGeneratedIdeas')));
}

// ── FIX 3 ─────────────────────────────────────────────────────────────────────
section('FIX 3 — a DB error at boot must not look like a brand-new user');
{
  const NEW_LOAD = extractFn('loadBrandFromDB');
  const SENTINEL = { __brandLoadFailed: true };
  const OLD_LOAD = `
async function loadBrandFromDB_OLD() {
  if (!sb || !currentUser) { return null; }
  try {
    const { data, error } = await sb.from('brands').select('*');
    if (error) { debugLog('Brand load error'); }
    if (data) { return data; }
    const { data: memberships, error: memErr } = await sb.from('brand_members').select('brand_id');
    if (memErr) { return null; }
    return null;
  } catch(e) { return null; }
}`;

  function brandSb(mode) {
    const q = {
      select() { return this; }, eq() { return this; }, limit() { return this; },
      maybeSingle() {
        if (mode === 'error') return Promise.resolve({ data: null, error: { message: 'network down' } });
        return Promise.resolve({ data: null, error: null });
      },
      then(res, rej) {
        const v = mode === 'error' ? { data: null, error: { message: 'network down' } } : { data: [], error: null };
        return Promise.resolve(v).then(res, rej);
      },
    };
    return { from: () => q };
  }
  const deps = mode => ({
    sb: brandSb(mode), currentUser: { id: 'u1' }, debugLog: () => {},
    localStorage: { getItem: () => null }, BRAND_LOAD_FAILED: SENTINEL,
  });

  const oldOnErr = await compile(OLD_LOAD, 'loadBrandFromDB_OLD', deps('error'))();
  ok('[control] OLD loader returns null (= "no brand") on a DB error', oldOnErr === null);

  const newOnErr = await compile(NEW_LOAD, 'loadBrandFromDB', deps('error'))();
  ok('NEW loader returns the failure sentinel on a DB error', newOnErr === SENTINEL);

  const newOnEmpty = await compile(NEW_LOAD, 'loadBrandFromDB', deps('empty'))();
  ok('NEW loader still returns null for a genuine no-rows result', newOnEmpty === null);
  ok('failure and "no brand" are distinguishable', newOnErr !== newOnEmpty);

  // What initApp does with each answer.
  const init = extractFn('initApp');
  ok('initApp bails out on the sentinel before touching settings/state',
    /_brandRes === BRAND_LOAD_FAILED/.test(init) && /showBrandLoadError\(\)/.test(init));
  const bail = init.indexOf('BRAND_LOAD_FAILED');
  const wizard = init.indexOf('obShowWizard');
  ok('the sentinel branch returns before the onboarding wizard',
    bail > -1 && wizard > bail && /showBrandLoadError\(\);\s*\n\s*return;/.test(init));
  ok('there is a working retry', /initApp\(\)/.test(extractFn('showBrandLoadError')));

  // The duplicate-brand insert is blocked.
  const saveSrc = extractFn('saveBrandToDB');
  function runSaveBrand(brandLoadFailed) {
    const inserts = [];
    const sbStub = {
      auth: { getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
      from: () => ({
        insert(p) { inserts.push(p); return { select: () => ({ single: async () => ({ data: { id: 'new' }, error: null }) }) }; },
        update() { return { eq: async () => ({ error: null }) }; },
      }),
    };
    const fn = compile(saveSrc, 'saveBrandToDB', {
      sb: sbStub, currentUser: { id: 'u1' }, currentBrand: null,
      _brandLoadFailed: brandLoadFailed, settingsToBrand: () => ({ brand_name: 'X' }),
      debugLog: () => {}, alert: () => {}, showToast: () => {},
    });
    return fn().then(() => inserts);
  }
  ok('saveBrandToDB refuses to INSERT while the brand load is unresolved',
    (await runSaveBrand(true)).length === 0);
  ok('[control] saveBrandToDB still inserts for a genuinely new user',
    (await runSaveBrand(false)).length === 1);
}

// ── FIX 4 ─────────────────────────────────────────────────────────────────────
section('FIX 4 — a failed ideas load must not read as an empty library');
{
  const NEW_LOAD_IDEAS = extractFn('loadIdeasFromDB');
  ok('loadIdeasFromDB throws instead of returning [] on error',
    /__ideasLoadFailed/.test(NEW_LOAD_IDEAS) && !/console\.error\('Ideas load error:', error\); return \[\];/.test(NEW_LOAD_IDEAS));

  async function callLoad(error) {
    const sbStub = { from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: error ? null : [], error: error ? { message: 'boom' } : null }) }) }) };
    const fn = compile(NEW_LOAD_IDEAS, 'loadIdeasFromDB', {
      sb: sbStub, currentBrand: { id: 'b1' }, lsGet: () => '{}',
      normalizeIdeaStatus: s => s || 'pending', _ideaRowRecency: () => 0,
      console: { error() {} },
    });
    try { return { value: await fn(), threw: false }; } catch (e) { return { threw: true }; }
  }
  ok('a load error throws', (await callLoad(true)).threw === true);
  const okLoad = await callLoad(false);
  ok('a genuinely empty library still returns []', !okLoad.threw && Array.isArray(okLoad.value) && okLoad.value.length === 0);

  const init = extractFn('initApp');
  ok('initApp flags the failure instead of silently emptying state',
    /_ideasLoadFailed = true/.test(init) && /notifyIdeasLoadFailed\(\)/.test(init));
  const notify = extractFn('notifyIdeasLoadFailed');
  ok('the user is told nothing was deleted', /nothing was deleted/i.test(notify) && /showToast/.test(notify));
  ok('switchBrand reports the same failure',
    /window\._ideasLoadFailed = true; notifyIdeasLoadFailed\(\);/.test(html));
}

// ── FIX 5 ─────────────────────────────────────────────────────────────────────
section('FIX 5 — approved examples must carry the real approved text');
{
  const SRC = extractFn('getApprovedExamples');
  const CODE = SRC.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');   // ignore comments
  ok('the phantom `i.statement` key is gone from the code', !/i\.statement/.test(CODE));

  const winners = [{
    status: 'filming', format: 'video', title: 'Between rounds dilution',
    hook: 'You are drinking it wrong.',
    script: 'Between rounds you keep topping up with water. ' + 'x'.repeat(120),
    caption: 'cap', boldText: '',
  }];
  const fn = compile(SRC, 'getApprovedExamples', { state: winners, console: { error() {} } });
  const out = fn('video');
  ok('an example is produced', Array.isArray(out) && out.length === 1);
  ok('the example text carries the approved SCRIPT, not just the hook',
    out[0] && out[0].text.includes('you keep topping up with water'),
    JSON.stringify(out[0]));
  // v618: assert the OUTCOME (the hook's words reach the model), not the MECHANISM. This used to
  // also require a separate `hook` field, but api/_brain.js renders ONLY text/format/title — that
  // field was uploaded on every generate and discarded, ~2.2KB of dead weight that on a slow link
  // outlasted the client's own timeout. It is gone; the hook still travels inside `text`.
  ok('the hook\'s words still reach the model (folded into text)',
    out[0] && out[0].text.includes('You are drinking it wrong.'));
  ok('no field is uploaded that the server never reads',
    out[0] && !('hook' in out[0]) && !('body' in out[0]), JSON.stringify(Object.keys(out[0] || {})));
  ok('the text is not merely the 8-word hook',
    out[0] && out[0].text.length > 60, `len=${out[0] && out[0].text.length}`);

  // [control] the pre-fix precedence would have produced only the hook.
  const oldBody = winners[0].boldText || winners[0].statement || winners[0].hook || winners[0].script;
  ok('[control] the old precedence picked the hook', oldBody === 'You are drinking it wrong.');

  const statementWinner = [{ status: 'done', format: 'statement', title: 'T', hook: '', boldText: 'Sweeteners are not electrolytes.', script: '' }];
  const so = compile(SRC, 'getApprovedExamples', { state: statementWinner, console: { error() {} } })('statement');
  ok('a statement winner still yields its statement text',
    so.length === 1 && so[0].text === 'Sweeteners are not electrolytes.', JSON.stringify(so));

  ok('getBrandContext accepts and forwards the target format',
    /function getBrandContext\(fmt\)/.test(html) && /approvedExamples: getApprovedExamples\(fmt\)/.test(html));
  ok('format-aware callers pass their format',
    /getBrandContext\(format\)/.test(html) && /getBrandContext\(chosenFormat\)/.test(html) && /getBrandContext\(idea\.format\|\|'video'\)/.test(html));
}

// ── P1..P8: data-loss + chain-robustness fixes ────────────────────────────────
{
  const { runP1P8 } = await import('./data-integrity-p1p8.mjs');
  await runP1P8({ html, ok, section, extractFn, compile, ROOT });
}

// ── inline scripts still parse ────────────────────────────────────────────────
section('app.html inline scripts');
{
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m, n = 0, bad = 0;
  const os = await import('node:os');
  const cp = await import('node:child_process');
  while ((m = re.exec(html)) !== null) {
    const tag = m[0].slice(0, m[0].indexOf('>') + 1);
    if (/type\s*=\s*["'](?!text\/javascript|application\/javascript|module)/i.test(tag)) continue;
    n++;
    const f = path.join(os.tmpdir(), `di_inline_${n}.js`);
    fs.writeFileSync(f, m[1]);
    try { cp.execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
    catch (e) { bad++; console.log(`  FAIL inline script ${n}: ${String(e.stderr || e)}`); }
    finally { try { fs.unlinkSync(f); } catch (_) {} }
  }
  ok(`all ${n} inline scripts parse`, n === 5 && bad === 0, `found ${n} blocks, ${bad} failed`);
}

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length) {
  console.error('FAILED: ' + failures.join(' | '));
  process.exit(1);
}
console.log('data integrity verification passed');
