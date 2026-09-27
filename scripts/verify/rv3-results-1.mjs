#!/usr/bin/env node
// GATE rv3-results-1 — content-v3 F2: "how did it do?" is stored honestly, reaches the writers as a
//                      pattern, and never becomes a fact the writers may state.
//
// WHY THIS EXISTS
//   api/idea-result.js records flop / ok / great (+ post link, + which of the three hooks was posted)
//   with the service role, so its own access check is the only thing between a caller and another
//   brand's ideas. api/_brandctx.js reads the latest results back and api/_brain.js renders
//   "WHAT WORKED FOR THIS BRAND" into the v2 writer and generate-ideas. The results are text THIS APP
//   wrote, so they must never widen the fact guard's allowed material. Failure modes checked:
//     * a stranger, a bad value or a non-https link written anyway; a missing column answered as ok;
//     * a slow database outliving maxDuration (no answer at all);
//     * a results outage failing, or stalling, the brand load every writer depends on;
//     * a past hook's number laundered into a new script as a "fact".
//
// HOW — THE REAL CODE RUNS: api/idea-result.js, api/_publish/store.js, api/_requireUser.js,
//   api/_brandctx.js, api/_brain.js, api/_write.js, api/generate-ideas.js, api/content-metrics.js.
//   Only node's https.request is replaced by an in-memory fake PostgREST (+ /auth/v1/user), callLLM by
//   a per-scenario plan, and api/_usage.js by a recorder. No network. Every arm has its opposite.
//
// RUN:    node scripts/verify/rv3-results-1.mjs
// EXPECT: prints "RESULTS OK" and exits 0.
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = path.join(ROOT, 'api');
const require_ = createRequire(path.join(ROOT, 'x.js'));
const Module = require_('module');
const wall = setTimeout(() => { console.error('FAIL: wall clock — rv3-results-1 did not finish in 60s'); process.exit(1); }, 60000);
wall.unref();

let failed = 0, passed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.error('FAIL: ' + m); } };

process.env.SUPABASE_URL = 'https://fake-postgrest.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'gate-fake-not-a-key';
process.env.CRON_SECRET = '';

// ── the fake PostgREST ─────────────────────────────────────────────────────────────────────────
const U = { owner: 'u0000000-0000-4000-8000-000000000001', member: 'u0000000-0000-4000-8000-000000000002',
            stranger: 'u0000000-0000-4000-8000-000000000003', other: 'u0000000-0000-4000-8000-000000000004' };
const TOK = { owner: 'tok-owner', member: 'tok-member', stranger: 'tok-stranger' };
const USERS = { [TOK.owner]: { id: U.owner }, [TOK.member]: { id: U.member }, [TOK.stranger]: { id: U.stranger } };
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';   // owner's; member belongs to it
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';   // someone else's
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';   // owner's second brand, no results
const NEW_COLS = ['result', 'result_at', 'post_url', 'hook_alts', 'hook_used'];
let DB, FAULT = null, DELAY = null, COLS_MISSING = false, tick = 0;
const REQS = [];
const ts = (n) => new Date(Date.UTC(2026, 8, 1) + n * 60000).toISOString();
function idea(o) { return Object.assign({ id: randomUUID(), brand_id: A, title: 'Idea ' + (++tick), format: 'video', hook: 'A hook.', script: 's', status: 'done', is_generated: true, gen_flow: 'v2', created_at: ts(tick), hook_alts: null, hook_used: null, result: null, result_at: null, post_url: null }, o); }
function resetDb() {
  DB = {
    brands: [
      { id: A, user_id: U.owner, brand_name: 'Acme Shrimp', tagline: 'tag A', usps: 'We sell plain electrolyte powder', tones: ['plain'], voice_extra: {} },
      { id: B, user_id: U.other, brand_name: 'Other Co', voice_extra: {} },
      { id: C, user_id: U.owner, brand_name: 'Second Co', usps: 'We sell socks', voice_extra: {} },
    ],
    brand_members: [{ brand_id: A, user_id: U.member }],
    brand_memory: [], edit_signals: [],
    ideas: [],
  };
  FAULT = null; DELAY = null; COLS_MISSING = false; REQS.length = 0;
}
function parseQuery(q) {
  const out = [];
  for (const part of (q || '').split('&')) { if (!part) continue; const i = part.indexOf('='); out.push([decodeURIComponent(part.slice(0, i)), decodeURIComponent(part.slice(i + 1))]); }
  return out;
}
function listVals(s) { const inner = s.slice(1, -1), vals = []; const re = /"((?:[^"\\]|\\.)*)"|([^,]+)/g; let m; while ((m = re.exec(inner))) vals.push(m[1] != null ? m[1].replace(/\\(.)/g, '$1') : m[2]); return vals; }
function matches(row, col, op) {
  const v = row[col];
  if (op.startsWith('eq.')) return v != null && String(v) === op.slice(3);
  if (op.startsWith('neq.')) return v == null || String(v) !== op.slice(4);
  if (op.startsWith('gte.')) return v != null && String(v) >= op.slice(4);
  if (op.startsWith('in.')) return listVals(op.slice(3)).includes(String(v));
  if (op === 'is.null') return v == null;
  if (op === 'not.is.null') return v != null;
  if (op === 'is.true') return v === true;
  throw new Error('fake PostgREST: unsupported filter ' + col + '=' + op);
}
const missingCol = (c) => ({ status: 400, data: { code: '42703', message: 'column ideas.' + c + ' does not exist' } });
function serve(method, p, headers, body) {
  const table = p.startsWith('/rest/v1/') ? p.slice(9).split('?')[0] : null;
  REQS.push({ method, table, path: p, body });
  const f = FAULT && FAULT(method, table, p);
  if (f) return f;
  if (p.startsWith('/auth/v1/user')) {
    const u = USERS[String(headers.Authorization || '').replace(/^Bearer /, '')];
    return u ? { status: 200, data: u } : { status: 401, data: { msg: 'invalid JWT' } };
  }
  if (table === 'rpc/content_metrics') {
    const a = JSON.parse(body || '{}'), g = {};
    for (const r of DB.ideas.filter(r => r.brand_id === a.p_brand_id && r.is_generated === true && (!a.p_since || r.created_at >= a.p_since))) {
      const fl = r.gen_flow || 'v1'; const x = g[fl] || (g[fl] = { flow: fl, generated: 0, filmed: 0 });
      x.generated++; if (r.status === 'filming' || r.status === 'done') x.filmed++;
    }
    return { status: 200, data: Object.values(g) };
  }
  if (!table) return { status: 404, data: null };
  if (!(table in DB)) return { status: 404, data: { code: 'PGRST205', message: "Could not find the table 'public." + table + "'" } };
  const q = parseQuery(p.split('?')[1]);
  let rows = DB[table];
  let order = null, limit = null, offset = 0, select = null;
  for (const [k, v] of q) {
    if (table === 'ideas' && COLS_MISSING && NEW_COLS.includes(k)) return missingCol(k);
    if (k === 'order') order = v; else if (k === 'limit') limit = +v; else if (k === 'offset') offset = +v;
    else if (k === 'select') select = v; else rows = rows.filter(r => matches(r, k, v));
  }
  if (table === 'ideas' && COLS_MISSING && select) { const c = select.split(',').find(x => NEW_COLS.includes(x)); if (c) return missingCol(c); }
  if (method === 'GET') {
    rows = rows.slice();
    if (order) {
      const keys = order.split(',').map(s => s.split('.'));
      rows.sort((a, b) => { for (const [c, d] of keys) { const x = String(a[c]), y = String(b[c]); if (x !== y) return (x < y ? -1 : 1) * (d === 'desc' ? -1 : 1); } return 0; });
    }
    rows = rows.slice(offset, limit == null ? undefined : offset + limit);
    if (select && select !== '*') { const cols = select.split(','); rows = rows.map(r => Object.fromEntries(cols.filter(c => c in r).map(c => [c, r[c]]))); }
    return { status: 200, data: JSON.parse(JSON.stringify(rows)) };
  }
  if (method === 'PATCH') {
    const patch = JSON.parse(body);
    if (table === 'ideas' && COLS_MISSING) { const c = Object.keys(patch).find(x => NEW_COLS.includes(x)); if (c) return { status: 400, data: { code: 'PGRST204', message: "Could not find the '" + c + "' column of 'ideas' in the schema cache" } }; }
    if (patch.result != null && !['flop', 'ok', 'great'].includes(patch.result)) return { status: 400, data: { code: '23514', message: 'violates check constraint "ideas_result_check"' } };
    for (const r of rows) Object.assign(r, patch);
    return { status: 200, data: JSON.parse(JSON.stringify(rows)) };
  }
  if (method === 'POST') { const made = [].concat(JSON.parse(body)).map(r => Object.assign({ id: randomUUID() }, r)); DB[table].push(...made); return { status: 201, data: made }; }
  return { status: 405, data: { message: 'fake: method not supported' } };
}
const https = require_('https');
https.request = (opts, cb) => {
  const req = new EventEmitter();
  let body = '', tmo = null, done = false;
  req.write = c => { body += c; };
  req.setTimeout = (ms, fn) => { tmo = setTimeout(fn, ms); tmo.unref(); };
  req.destroy = err => { done = true; if (tmo) clearTimeout(tmo); setImmediate(() => req.emit('error', err || new Error('destroyed'))); };
  req.end = () => setTimeout(() => {
    let out;
    try { out = serve(opts.method, opts.path, opts.headers || {}, body); }
    catch (e) { out = { status: 500, data: { message: String(e && e.message) } }; }
    if (out === 'hang' || done) return;
    if (tmo) clearTimeout(tmo);
    if (out === 'reject') return req.emit('error', new Error('ECONNRESET (fake)'));
    const resp = new EventEmitter(); resp.statusCode = out.status;
    cb(resp);
    if (out.raw != null) resp.emit('data', out.raw); else if (out.data != null) resp.emit('data', JSON.stringify(out.data));
    resp.emit('end');
  }, DELAY ? DELAY(opts.method, opts.path) || 0 : 0);
  return req;
};

function stub(rel, exports) {
  const file = require_.resolve(path.join(API, rel));
  const m = new Module(file); m.filename = file; m.loaded = true; m.exports = exports; require_.cache[file] = m;
}
let calls = [], plan = () => '';
stub('_llm.js', {
  callLLM: async (opts) => { const i = calls.length; calls.push({ opts, prompt: (opts.messages || []).map(m => m.content).join('\n') }); return plan(i, opts); },
  aiUnavailable: () => null, callGrokSearch: async () => null,
});
let usageTouches = 0;
stub('_usage.js', {
  billingUserFor: async (u) => { usageTouches++; return u; }, creditsFor: () => { usageTouches++; return 1; },
  checkLimit: async () => { usageTouches++; return { ok: true, hold: null }; }, attachHoldRelease: () => { usageTouches++; },
  logUsage: async () => { usageTouches++; }, guard: async () => { usageTouches++; return { user: { id: U.owner }, over: false }; },
});

const handler = require_(path.join(API, 'idea-result.js'));
const bctx = require_(path.join(API, '_brandctx.js'));
const brain = require_(path.join(API, '_brain.js'));
const W = require_(path.join(API, '_write.js'));
const ideasH = require_(path.join(API, 'generate-ideas.js'));
const metricsH = require_(path.join(API, 'content-metrics.js'));
const PROD_TIMING = Object.assign({}, handler.TIMING);

const fakeRes = () => ({ code: 0, body: undefined, headers: {}, setHeader(k, v) { this.headers[k] = v; },
  status(c) { this.code = c; this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } });
async function hit(h, body, { token = TOK.owner, method = 'POST' } = {}) {
  const res = fakeRes(); const headers = { origin: 'https://contentshrimp.com' };
  if (token) headers.authorization = 'Bearer ' + token;
  await h({ method, headers, body }, res); return res;
}
const call = (body, o) => hit(handler, body, o);
const patches = () => REQS.filter(r => r.method === 'PATCH');

// ═══ 0. sql/idea-results.sql: idempotent, no policy, no function ═════════════════════════════════
{
  const { stripSqlComments } = await import('./_sqlscan.mjs');
  const fs = await import('node:fs');
  const sql = stripSqlComments(fs.readFileSync(path.join(ROOT, 'sql', 'idea-results.sql'), 'utf8')).toLowerCase().replace(/\s+/g, ' ');
  for (const c of NEW_COLS) ok(new RegExp('alter table public\\.ideas add column if not exists ' + c + ' ').test(sql), 'sql: ideas.' + c + ' is added with "if not exists"');
  ok((sql.match(/add column /g) || []).length === (sql.match(/add column if not exists /g) || []).length, 'sql: every add column is idempotent');
  const cons = sql.match(/add constraint (\w+)/g) || [];
  ok(cons.length === 4 && cons.every(x => { const n = x.split(' ')[2]; return sql.includes("conname = '" + n + "'"); }), 'sql: each of the 4 CHECKs is added only when a constraint of that name is missing');
  ok(/result in \('flop', 'ok', 'great'\)/.test(sql) && /char_length\(post_url\) <= 500/.test(sql) && /\^https:\/\//.test(sql) && /jsonb_array_length\(hook_alts\) <= 3/.test(sql) && /hook_used between 0 and 2/.test(sql), 'sql: the checks say what PLAN.md F2 says');
  ok(!/create (or replace )?(policy|function)|drop policy|alter policy|security definer/.test(sql), 'sql: no policy and no function is created or changed');
  ok(/notify pgrst, 'reload schema'/.test(sql), 'sql: PostgREST is told to reload its schema');
}

// ═══ 1. idea-result: method, auth, input ═══════════════════════════════════════════════════════
resetDb();
{
  const I = idea({ hook_alts: ['Bold.', 'Why?', 'I once.'] }); DB.ideas.push(I);
  let r = await call({}, { method: 'OPTIONS' });
  ok(r.code === 200 && /POST/.test(r.headers['Access-Control-Allow-Methods'] || ''), 'OPTIONS answers 200 with POST allowed');
  r = await call({ ideaId: I.id, result: 'great' }, { method: 'GET' });
  ok(r.code === 405, 'GET -> 405, got ' + r.code);
  r = await call({ ideaId: I.id, result: 'great' }, { token: null });
  ok(r.code === 401 && patches().length === 0, 'no token -> 401, nothing written');
  r = await call({ ideaId: I.id, result: 'great' }, { token: 'tok-forged' });
  ok(r.code === 401, 'a token the auth server rejects -> 401, got ' + r.code);
  for (const [b, why] of [
    [{ ideaId: I.id, result: 'amazing' }, 'unknown result'], [{ ideaId: I.id }, 'missing result'],
    [{ ideaId: I.id, result: 'great', postUrl: 'http://tiktok.com/v/1' }, 'http (not https) link'],
    [{ ideaId: I.id, result: 'great', postUrl: 'https://x.com/' + 'a'.repeat(500) }, 'link over 500 chars'],
    [{ ideaId: I.id, result: 'great', postUrl: 'not a link' }, 'not a link'],
    [{ ideaId: I.id, result: 'great', postUrl: 'javascript:alert(1)' }, 'javascript: link'],
    [{ ideaId: I.id, result: 'great', postUrl: 42 }, 'a number as link'],
    [{ ideaId: I.id, result: 'great', hookUsed: 3 }, 'hookUsed 3'], [{ ideaId: I.id, result: 'great', hookUsed: 1.5 }, 'hookUsed 1.5'],
    [{ ideaId: I.id, result: 'great', hookUsed: '1' }, 'hookUsed as string'],
    [{ ideaId: 'nope; drop', result: 'great' }, 'malformed ideaId'], [{ result: 'great' }, 'no id and no brand+title'],
    [{ brandId: A, result: 'great' }, 'brand without title'],
  ]) {
    r = await call(b);
    ok(r.code === 400 && r.body.code === 'bad_input', why + ' -> 400 bad_input, got ' + r.code);
  }
  ok(patches().length === 0 && I.result == null, 'no bad input ever reached a write');
  // exactly-at-the-limit link is fine (opposite of "over 500")
  const u500 = 'https://x.com/' + 'a'.repeat(500 - 14);
  r = await call({ ideaId: I.id, result: 'ok', postUrl: u500 });
  ok(r.code === 200 && I.post_url === u500, 'a 500-char https link is accepted and stored, got ' + r.code);
}

// ═══ 2. idea-result: access, 404, happy paths ═══════════════════════════════════════════════════
resetDb();
{
  const I = idea({ hook_alts: ['Bold claim here.', 'Is this a question?', 'I remember the day.'] });
  const Ib = idea({ brand_id: B, title: 'Theirs' });
  DB.ideas.push(I, Ib);
  let r = await call({ ideaId: Ib.id, result: 'flop' });
  ok(r.code === 403 && r.body.code === 'forbidden' && Ib.result == null && patches().length === 0, 'another brand\'s idea -> 403, nothing written');
  r = await call({ ideaId: I.id, result: 'flop' }, { token: TOK.stranger });
  ok(r.code === 403 && I.result == null, 'a stranger -> 403 on the owner\'s idea, nothing written');
  r = await call({ brandId: B, title: 'Theirs', result: 'flop' });
  ok(r.code === 403 && Ib.result == null, 'brand + title of a brand you cannot access -> 403');
  r = await call({ ideaId: randomUUID(), result: 'great' });
  ok(r.code === 404 && r.body.code === 'not_found', 'unknown id -> 404, got ' + r.code);
  r = await call({ brandId: A, title: 'No such title', result: 'great' });
  ok(r.code === 404, 'unknown brand + title -> 404, got ' + r.code);

  REQS.length = 0;
  r = await call({ ideaId: I.id, result: 'great', postUrl: ' https://www.tiktok.com/@acme/video/1 ', hookUsed: 2 });
  ok(r.code === 200 && r.body.ok === true && r.body.result === 'great' && typeof r.body.resultAt === 'string', 'owner marks great -> 200 {ok, result, resultAt}');
  ok(I.result === 'great' && I.post_url === 'https://www.tiktok.com/@acme/video/1' && I.hook_used === 2 && I.result_at === r.body.resultAt, 'the row holds result, trimmed link, hook_used and result_at');
  const pw = patches()[0];
  ok(pw && pw.path.includes('brand_id=eq.' + A) && pw.path.includes('id=eq.' + I.id), 'the write is scoped to the idea AND the brand the access check approved');
  ok(!('brand_id' in JSON.parse(pw.body)) && Object.keys(JSON.parse(pw.body)).every(k => ['result', 'result_at', 'post_url', 'hook_used'].includes(k)), 'the write touches only the result columns');
  // omitted = unchanged; null = cleared
  r = await call({ ideaId: I.id, result: 'ok' }, { token: TOK.member });
  ok(r.code === 200 && I.result === 'ok' && I.post_url === 'https://www.tiktok.com/@acme/video/1' && I.hook_used === 2, 'a brand member can mark it; omitted link and hookUsed stay unchanged');
  r = await call({ ideaId: I.id, result: 'ok', postUrl: null, hookUsed: null });
  ok(r.code === 200 && I.post_url === null && I.hook_used === null, 'postUrl null and hookUsed null clear them');
  // hookUsed must point inside hook_alts when the idea has them
  const I2 = idea({ hook_alts: ['One.', 'Two?'] }); DB.ideas.push(I2);
  r = await call({ ideaId: I2.id, result: 'great', hookUsed: 2 });
  ok(r.code === 400 && I2.result == null, 'hookUsed past the idea\'s two hooks -> 400, nothing written');
  r = await call({ ideaId: I2.id, result: 'great', hookUsed: 1 });
  ok(r.code === 200 && I2.hook_used === 1, 'opposite: hookUsed inside hook_alts is stored');
  // brand + title (the app re-saves an idea under a new id; title is how it finds a row)
  const I3 = idea({ title: 'Salt is not the enemy' }); DB.ideas.push(I3);
  r = await call({ brandId: A, title: '  Salt is not   the enemy ', result: 'flop' });
  ok(r.code === 200 && I3.result === 'flop' && r.body.updated === 1, 'brand + title locates the idea (whitespace normalised) and marks it');
  ok(usageTouches === 0, 'no credits were touched by any idea-result call');
}

// ═══ 3. idea-result: honest failures ════════════════════════════════════════════════════════════
resetDb();
{
  const I = idea({}); DB.ideas.push(I);
  COLS_MISSING = true;
  let r = await call({ ideaId: I.id, result: 'great' });
  ok(r.code === 503 && r.body.code === 'results_not_ready' && I.result == null, 'columns missing (SQL not run) -> 503 results_not_ready, got ' + r.code + ' ' + (r.body && r.body.code));
  COLS_MISSING = false;
  // the read passes but the write hits the missing column (PGRST204)
  FAULT = (m, t) => (m === 'PATCH' && t === 'ideas' ? { status: 400, data: { code: 'PGRST204', message: "Could not find the 'hook_used' column" } } : null);
  r = await call({ ideaId: I.id, result: 'great', hookUsed: 0 });
  ok(r.code === 503 && r.body.code === 'results_not_ready', 'PGRST204 on the write -> 503 results_not_ready');
  FAULT = (m, t) => (t === 'brands' ? { status: 500, data: { message: 'boom' } } : null);
  r = await call({ ideaId: I.id, result: 'great' });
  ok(r.code === 503 && r.body.code === 'access_check_failed' && patches().filter(p => p.path.includes(I.id)).length === 1, 'an access check that could not run -> 503 access_check_failed, no new write');
  FAULT = (m, t) => (m === 'GET' && t === 'ideas' ? { status: 500, data: { message: 'db down' } } : null);
  r = await call({ ideaId: I.id, result: 'great' });
  ok(r.code === 503 && r.body.code === 'result_read_failed', 'a failed idea read -> 503 result_read_failed, never 404');
  FAULT = (m, t) => (m === 'PATCH' ? { status: 500, data: { code: 'XX000', message: 'db error' } } : null);
  r = await call({ ideaId: I.id, result: 'great' });
  ok(r.code === 503 && r.body.code === 'result_write_failed', 'a refused write -> 503 result_write_failed');
  FAULT = (m) => (m === 'PATCH' ? { status: 502, raw: '<html>Bad gateway</html>' } : null);
  r = await call({ ideaId: I.id, result: 'great' });
  ok(r.code === 503 && r.body.code === 'result_write_unknown', 'a gateway page on the write -> 503 result_write_unknown (it may have committed)');
  FAULT = (m) => (m === 'PATCH' ? 'reject' : null);
  r = await call({ ideaId: I.id, result: 'great' });
  ok(r.code === 503 && r.body.code === 'result_write_unknown', 'a dropped connection on the write -> 503 result_write_unknown');
  FAULT = (m, t) => (m === 'PATCH' ? (DB.ideas = DB.ideas.filter(x => x.id !== I.id), null) : null);
  r = await call({ ideaId: I.id, result: 'great' });
  ok(r.code === 404, 'the idea deleted between read and write -> 404, got ' + r.code);
  FAULT = null;
}

// ═══ 4. idea-result: the request deadline ═══════════════════════════════════════════════════════
{
  ok(PROD_TIMING.deadlineMs === 25000 && PROD_TIMING.minCallMs >= 9000 && PROD_TIMING.deadlineMs + 2000 < 30000,
    'production deadline: 25 s of work, no call starts with < 9 s left, answered inside maxDuration 30 s');
  resetDb();
  const I = idea({}); DB.ideas.push(I);
  Object.assign(handler.TIMING, { deadlineMs: 400, minCallMs: 150 });
  DELAY = () => 120;
  let t0 = Date.now();
  let r = await call({ ideaId: I.id, result: 'great' });
  let dt = Date.now() - t0;
  ok(r.code === 503 && r.body.code === 'timeout' && patches().length === 0 && I.result == null, 'a slow database: 503 timeout and the write is never started, got ' + r.code + ' ' + (r.body && r.body.code));
  ok(dt < 400 + 150, 'the slow request answered inside its deadline (' + dt + ' ms)');
  DELAY = null;
  Object.assign(handler.TIMING, { deadlineMs: 600, minCallMs: 100 });
  FAULT = (m) => (m === 'PATCH' ? 'hang' : null);
  t0 = Date.now();
  const keep = setInterval(() => {}, 100);
  r = await call({ ideaId: I.id, result: 'great' });
  clearInterval(keep);
  dt = Date.now() - t0;
  ok(r.code === 503 && r.body.code === 'result_write_unknown' && dt < 600 + 150, 'a write that goes silent is abandoned at the deadline as write_unknown (' + dt + ' ms)');
  FAULT = null;
  Object.assign(handler.TIMING, { deadlineMs: 5000, minCallMs: 100 });
  r = await call({ ideaId: I.id, result: 'great' });
  ok(r.code === 200 && I.result === 'great', 'opposite: a healthy database inside the deadline -> 200');
  Object.assign(handler.TIMING, PROD_TIMING);
}

// ═══ 5. _brandctx: the results block's data ═════════════════════════════════════════════════════
const HOOKS3 = ['Salt is not your enemy.', 'Why do you still cramp at mile ten?', 'I once cramped on a hot run.'];
function seedResults() {
  DB.ideas.push(
    idea({ title: 'ZRES_GREAT_TITLE salt first', hook: 'Salt is not your enemy.', hook_alts: HOOKS3, hook_used: 2, result: 'great', result_at: ts(900) }),
    idea({ title: 'ZRES_GREAT_TITLE salt first', hook: 'old copy', result: 'ok', result_at: ts(800) }),          // same title, older copy
    idea({ title: 'ZRES_FLOP_TITLE sugar rant', hook: 'ZRES_FLOP_HOOK I sold 4,000 bottles in May.', result: 'flop', result_at: ts(850) }),
    idea({ title: 'ZRES_OK_TITLE water myths', hook: 'Water alone is not enough.', result: 'ok', result_at: ts(700) }),
    idea({ title: 'Never marked', hook: 'x', result: null }),
  );
}
resetDb(); seedResults();
{
  REQS.length = 0;
  const L = await bctx.loadBrandContext(A, { userId: U.owner }, '');
  ok(L.ok === true && Array.isArray(L.bc.results), 'the brand load carries bc.results');
  const R = L.bc.results;
  ok(R.length === 3 && R[0].title.startsWith('ZRES_GREAT_TITLE') && R[0].result === 'great' && R[1].result === 'flop' && R[2].result === 'ok', 'newest first, one per title, unmarked ideas left out (' + R.map(x => x.result).join(',') + ')');
  ok(R[0].hookUsed === 2 && JSON.stringify(R[0].hookAlts) === JSON.stringify(HOOKS3) && L.bc.resultsUnavailable === false, 'hookAlts / hookUsed carried; resultsUnavailable false');
  const q = REQS.find(x => x.table === 'ideas' && /result=not\.is\.null/.test(x.path));
  ok(q && /limit=\d+/.test(q.path) && +q.path.match(/limit=(\d+)/)[1] <= 60 && !/select=\*/.test(q.path) && q.path.includes('brand_id=eq.' + A), 'the results read is one bounded, brand-scoped query with named columns');
  const L0 = await bctx.loadBrandContext(C, { userId: U.owner }, '');
  ok(L0.ok && L0.bc.results.length === 0 && L0.bc.resultsUnavailable === false, 'opposite: a brand with no results -> [] and not "unavailable"');
  const bare = Object.assign({}, L.bc); delete bare.results; delete bare.resultsUnavailable;
  const f1 = bctx.populatedFieldCount(L.bc), f0 = bctx.populatedFieldCount(bare);
  ok(f1 === f0, 'results never count as brand fields (the 424 stale-row check is unchanged)');
  const L2 = await bctx.loadBrandContext(A, { userId: U.stranger }, '');
  ok(L2.ok === false && L2.reason === 'forbidden', 'a stranger still gets no brand (and no results)');
  // results outage: missing column, error, silence -> the brand still loads, block absent
  COLS_MISSING = true;
  const L3 = await bctx.loadBrandContext(A, { userId: U.owner }, '');
  ok(L3.ok === true && L3.bc.results.length === 0 && L3.bc.resultsUnavailable === true && L3.bc.brandName === 'Acme Shrimp', 'columns missing -> brand loads, results [] + unavailable');
  COLS_MISSING = false;
  FAULT = (m, t, p) => (/result=not\.is\.null/.test(p) ? 'reject' : null);
  const L4 = await bctx.loadBrandContext(A, { userId: U.owner }, '');
  ok(L4.ok === true && L4.bc.resultsUnavailable === true, 'a dropped results read -> brand loads, results unavailable');
  FAULT = (m, t, p) => (/result=not\.is\.null/.test(p) ? 'hang' : null);
  const t0 = Date.now();
  const keep = setInterval(() => {}, 250);   // the fake's silent socket and the race timer are unref'd
  const L5 = await bctx.loadBrandContext(A, { userId: U.owner }, '');
  clearInterval(keep);
  const dt = Date.now() - t0;
  ok(L5.ok === true && L5.bc.resultsUnavailable === true && dt < bctx.RESULTS_READ_MS + 1500, 'a silent results read costs at most ~RESULTS_READ_MS (' + dt + ' ms), never the request');
  FAULT = null;
  ok(brain.resultsBlock(L3.bc) === '', 'no results -> no block at all');
}

// ═══ 6. _brain: the block ═══════════════════════════════════════════════════════════════════════
resetDb(); seedResults();
const HYD = (await bctx.loadBrandContext(A, { userId: U.owner }, '')).bc;
{
  const b = brain.resultsBlock(HYD);
  ok(b.startsWith('WHAT WORKED FOR THIS BRAND') && /never facts/.test(b), 'block heading says these are patterns, never facts');
  ok(/GREAT: "ZRES_GREAT_TITLE[^\n]*I once cramped on a hot run\.[^\n]*personal-moment/.test(b), 'a great result names the POSTED hook (hook_alts[hook_used]) and its style');
  ok(/do NOT repeat/.test(b) && /FLOP: "ZRES_FLOP_TITLE[^\n]*ZRES_FLOP_HOOK/.test(b), 'a flop is listed under "do NOT repeat" with its hook');
  ok(b.indexOf('ZRES_GREAT_TITLE') < b.indexOf('ZRES_OK_TITLE') && b.indexOf('ZRES_OK_TITLE') < b.indexOf('ZRES_FLOP_TITLE'), 'order: great, ok, then flops');
  const many = { results: Array.from({ length: 30 }, (_, i) => ({ title: 'T' + i + ' ' + 'w'.repeat(80), hook: 'h'.repeat(150), hookAlts: [], hookUsed: null, result: i % 2 ? 'great' : 'flop' })) };
  const bm = brain.resultsBlock(many);
  ok(bm.length <= brain.RESULTS_BLOCK_CAP + 400 && /FLOP/.test(bm) && /GREAT/.test(bm), 'bounded (' + bm.length + ' chars) and a run of wins never pushes every flop out');
  ok(brain.hookStyleOf('Why?') === 'a question / tension opener' && brain.hookStyleOf('I quit sugar.') === 'a personal-moment opener' && brain.hookStyleOf('Salt wins.') === 'a bold-claim opener', 'hook styles are named from the line itself');
  ok(!/winning hook/.test(brain.resultsBlock({ results: [{ title: 't', hook: 'Salt wins.', hookAlts: [], hookUsed: null, result: 'great' }] })), 'opposite: with no known posted hook, no winning style is claimed');
}

// ═══ 7. the writers get the block; it never becomes allowed material ═════════════════════════════
{
  const SRC = { kind: 'note', text: 'People think electrolytes are only for athletes.' };
  const ANG = { belief: 'Most people drink electrolytes at the wrong time', why: 'Ads show them after workouts' };
  const CLEAN = 'You drink it after the run. That is the wrong time. Take it before, when your body is about to lose salt.';
  const SHAPE = JSON.stringify({ title: 'Before, not after', hooks: ['Timing beats the powder.', 'Why after the run?', 'I used to drink it after.'], caption: 'Timing matters.' });
  calls = []; plan = (i) => [CLEAN, CLEAN, SHAPE][i];
  await W.runWrite({ bc: HYD, source: SRC, angle: ANG, deadlineMs: 200000 });
  ok(calls[0] && calls[0].prompt.includes('WHAT WORKED FOR THIS BRAND') && calls[0].prompt.includes('ZRES_GREAT_TITLE'), 'the v2 draft prompt carries WHAT WORKED FOR THIS BRAND');
  ok(calls.length === 3, 'no extra AI call for results (draft, spoken, shape = ' + calls.length + ')');
  calls = []; plan = () => JSON.stringify({ angles: [{ belief: 'Timing matters more than the brand', why: 'x' }, { belief: 'Salt is not the enemy', why: 'y' }, { belief: 'Water alone is not enough', why: 'z' }] });
  await W.runAngles({ bc: HYD, source: SRC });
  ok(calls[0] && calls[0].prompt.includes('WHAT WORKED FOR THIS BRAND'), 'the angles prompt carries the block too');
  calls = []; plan = (i) => [CLEAN, CLEAN, SHAPE][i];
  await W.runWrite({ bc: Object.assign({}, HYD, { results: [] }), source: SRC, angle: ANG, deadlineMs: 200000 });
  ok(calls[0] && !calls[0].prompt.includes('WHAT WORKED FOR THIS BRAND'), 'opposite: no results -> no block in the draft prompt');

  // never allowed material
  const I = W._internals;
  const allowed = I.allowedMaterial(HYD, I.normSource(SRC), I.normAngle(ANG), I.normStories(HYD.stories));
  ok(!/ZRES_|4,000|I once cramped/.test(allowed) && !/ZRES_/.test(I.userFacts(HYD)), 'results text is in neither userFacts nor allowedMaterial');
  ok(I.inventedFacts('I sold 4,000 bottles in May.', allowed).length > 0, 'a number that exists only in a past result is still "invented"');
  const withFact = Object.assign({}, HYD, { usps: HYD.usps + '. We sold 4,000 bottles in May.' });
  ok(I.inventedFacts('I sold 4,000 bottles in May.', I.allowedMaterial(withFact, I.normSource(SRC), I.normAngle(ANG), [])).length === 0, 'opposite: the same number in a field the user wrote is allowed');
  // behaviour: a draft that launders the past hook's number is slotted, not shipped
  const LAUNDER = 'I sold 4,000 bottles in May. You drink it after the run. That is the wrong time. Take it before.';
  calls = []; plan = (i) => [LAUNDER, LAUNDER, CLEAN, SHAPE][i];
  const out = await W.runWrite({ bc: HYD, source: SRC, angle: ANG, deadlineMs: 200000 });
  // (a story slot may QUOTE the sentence as a question to the creator; slots are never said as fact)
  const said = out.idea.script.replace(/\[\s*your\s+story\s*:[^\]]*\]/gi, ' ');
  ok(!/4,000/.test(said) && /\[your story:/.test(out.idea.script) && !out.idea.hooks.some(h => /4,000/.test(h)), 'a script copying a result\'s number never ships it as said text: it becomes a story slot (got: ' + out.idea.script.slice(0, 80) + ')');

  // generate-ideas, hydrated from the database (real _brandctx through the fake PostgREST)
  const GI = JSON.stringify([{ belief: 'Timing matters more than the brand', format: 'video', title: 'Before not after', hook: 'Timing beats the powder.',
    hooks: ['Timing beats the powder.', 'I sold 4,000 bottles in May.', 'Why after the run?'], script: CLEAN, emphasis: [], shots: '', caption: '', reelTitle: '', tags: '' }]);
  calls = []; plan = () => GI; const u0 = usageTouches;
  let r = await hit(ideasH, { brandId: A, brandContext: {}, count: 1, learningContext: '' });
  ok(r.code === 200 && calls[0] && calls[0].prompt.includes('WHAT WORKED FOR THIS BRAND') && calls[0].prompt.includes('ZRES_FLOP_TITLE'), 'generate-ideas (hydrated) carries the block, got ' + r.code);
  const gi = r.body && r.body.ideas && r.body.ideas[0];
  ok(gi && !gi.hooks.some(h => /4,000/.test(h)) && gi.hooks.length === 2, 'generate-ideas: a hook copying a result\'s number is dropped (' + JSON.stringify(gi && gi.hooks) + ')');
  ok(usageTouches > u0, 'self-check: generate-ideas does meter (the recorder sees it)');
  calls = []; plan = () => GI;
  r = await hit(ideasH, { brandId: C, brandContext: {}, count: 1, learningContext: '' });
  ok(r.code === 200 && calls[0] && !calls[0].prompt.includes('WHAT WORKED FOR THIS BRAND'), 'opposite: a brand with no results -> no block in generate-ideas');
}

// ═══ 8. content-metrics: result counts per flow ═══════════════════════════════════════════════
resetDb();
{
  DB.ideas.push(
    idea({ gen_flow: 'v2', result: 'great' }), idea({ gen_flow: 'v2', result: 'great' }), idea({ gen_flow: 'v2', result: 'flop' }),
    idea({ gen_flow: null, result: 'ok' }), idea({ gen_flow: null, status: 'pending' }), idea({ gen_flow: 'v2', result: 'ok', is_generated: false }),
  );
  // created_at in the fake is 2026-09-01+; the window is "last N days" from now, so ask for 365
  const since = (d) => ({ brandId: A, days: 365 });
  let r = await hit(metricsH, since());
  const v1 = r.body && r.body.flows && r.body.flows.find(f => f.flow === 'v1'), v2 = r.body && r.body.flows && r.body.flows.find(f => f.flow === 'v2');
  ok(r.code === 200 && r.body.resultsColumn === true && v2 && JSON.stringify(v2.results) === '{"great":2,"ok":0,"flop":1}' && v1 && JSON.stringify(v1.results) === '{"great":0,"ok":1,"flop":0}',
    'content-metrics: results per flow (v2 2 great / 1 flop, v1 1 ok; non-AI ideas left out) — got ' + JSON.stringify(r.body && r.body.flows));
  ok(v2 && v2.generated === 3 && v2.filmed === 3, 'content-metrics: the existing counts are unchanged');
  COLS_MISSING = true;
  r = await hit(metricsH, since());
  ok(r.code === 200 && r.body.resultsColumn === false && r.body.flows.every(f => !('results' in f)), 'content-metrics: result column missing -> 200, resultsColumn:false, no made-up zeros');
  COLS_MISSING = false;
  FAULT = (m, t, p) => (/result=not\.is\.null/.test(p) ? { status: 500, data: { message: 'boom' } } : null);
  r = await hit(metricsH, since());
  ok(r.code === 200 && r.body.resultsUnavailable === true && r.body.flows.length >= 1 && r.body.flows.every(f => !('results' in f)), 'content-metrics: a failed results read never costs the rest of the answer');
  FAULT = null;
  r = await hit(metricsH, since(), { token: TOK.stranger });
  ok(r.code === 403, 'content-metrics: a stranger still gets 403');
}

clearTimeout(wall);
if (failed) { console.error('rv3-results-1: ' + passed + ' passed, ' + failed + ' failed'); process.exit(1); }
console.log('RESULTS OK — ' + passed + ' checks: idea-result arms, deadline, brandctx load, block, prompts, allowed material, metrics');
