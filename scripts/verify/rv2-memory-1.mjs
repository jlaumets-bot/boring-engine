#!/usr/bin/env node
// GATE: brand memory (content-v2 leaf-M) — stories, beliefs and speech samples are stored,
//       capped, scoped to one brand, honest about failures, and reach every writer's context.
//
// WHY THIS EXISTS
//   v693. The writers invented numbers, names and cases because nothing held the founder's real
//   ones. api/brand-memory.js stores them (sql/brand-memory.sql) and api/_brandctx.js loads them
//   into bc.beliefs / bc.stories / bc.speechSamples. Three ways this goes wrong silently:
//     * a failed read answered as "you have no stories" (store.rest RESOLVES on every status);
//     * one brand's item deleted through another brand's id;
//     * a memory outage failing — or stalling — the whole brand load every writer depends on.
//
// HOW IT CHECKS — BY RUNNING THE REAL CODE
//   The REAL api/_publish/store.js, api/_requireUser.js, api/brand-memory.js and api/_brandctx.js
//   run unmodified. Only node's https.request is replaced, by an in-memory fake PostgREST (and
//   /auth/v1/user) that filters, orders, limits, inserts and deletes like the real one, answers an
//   unknown table with PGRST205, enforces the kind check and the one-belief-per-brand index, and
//   can be told to fail, refuse the connection, or go silent. No network is touched. Every arm has
//   its opposite (the working case next to the failing one).
//
// RUN:    node scripts/verify/rv2-memory-1.mjs
// EXPECT: prints "BRAND MEMORY OK" and exits 0.
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripSqlComments } from './_sqlscan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require_ = createRequire(path.join(ROOT, 'x.js'));
const wall = setTimeout(() => { console.error('FAIL: wall clock — rv2-memory-1 did not finish in 60s'); process.exit(1); }, 60000);
wall.unref();

let failed = 0, passed = 0;
const ok = (c, m) => { if (c) { passed++; } else { console.error('FAIL: ' + m); failed++; } };

// Placeholders only — every request is answered by the fake below.
process.env.SUPABASE_URL = 'https://fake-postgrest.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'gate-fake-not-a-key';

// ── the fake PostgREST ─────────────────────────────────────────────────────────────────────────
const U = { owner: 'u0000000-0000-4000-8000-000000000001', member: 'u0000000-0000-4000-8000-000000000002',
            stranger: 'u0000000-0000-4000-8000-000000000003', other: 'u0000000-0000-4000-8000-000000000004' };
const TOK = { owner: 'tok-owner', member: 'tok-member', stranger: 'tok-stranger' };
const USERS = { [TOK.owner]: { id: U.owner }, [TOK.member]: { id: U.member }, [TOK.stranger]: { id: U.stranger } };
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';   // owner's; member belongs to it
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';   // someone else's
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';   // owner's second brand
let DB, FAULT = null, DELAY = null, tick = 0;
const REQS = [];
function resetDb() {
  DB = {
    brands: [
      { id: A, user_id: U.owner, brand_name: 'Acme Shrimp', tagline: 'tag A', tones: ['plain'], voice_extra: {} },
      { id: B, user_id: U.other, brand_name: 'Other Co', voice_extra: {} },
      { id: C, user_id: U.owner, brand_name: 'Second Co', voice_extra: {} },
    ],
    brand_members: [{ brand_id: A, user_id: U.member }],
    brand_memory: [],
    ideas: [], edit_signals: [],
  };
  FAULT = null; DELAY = null; REQS.length = 0;
}
const nextTs = () => new Date(Date.UTC(2026, 8, 1) + (++tick) * 1000).toISOString();

function parseQuery(q) {
  const out = [];
  for (const part of (q || '').split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    out.push([decodeURIComponent(part.slice(0, i)), decodeURIComponent(part.slice(i + 1))]);
  }
  return out;
}
function listVals(s) {  // in.(a,"b,c")
  const inner = s.slice(1, -1), vals = [];
  const re = /"((?:[^"\\]|\\.)*)"|([^,]+)/g; let m;
  while ((m = re.exec(inner))) vals.push(m[1] != null ? m[1].replace(/\\(.)/g, '$1') : m[2]);
  return vals;
}
function matches(row, col, op) {
  const v = row[col];
  if (op.startsWith('eq.')) return v != null && String(v) === op.slice(3);
  if (op.startsWith('neq.')) return v == null || String(v) !== op.slice(4);
  if (op.startsWith('in.')) return listVals(op.slice(3)).includes(String(v));
  if (op === 'is.null') return v == null;
  if (op === 'not.is.null') return v != null;
  throw new Error('fake PostgREST: unsupported filter ' + col + '=' + op);
}
function serve(method, p, headers, body) {
  const table = p.startsWith('/rest/v1/') ? p.slice(9).split('?')[0] : null;
  REQS.push({ method, table, path: p });
  const f = FAULT && FAULT(method, table, p);
  if (f) return f;
  if (p.startsWith('/auth/v1/user')) {
    const u = USERS[String(headers.Authorization || '').replace(/^Bearer /, '')];
    return u ? { status: 200, data: u } : { status: 401, data: { msg: 'invalid JWT' } };
  }
  if (!table) return { status: 404, data: null };
  if (!(table in DB)) return { status: 404, data: { code: 'PGRST205', message: "Could not find the table 'public." + table + "' in the schema cache" } };
  const q = parseQuery(p.split('?')[1]);
  let rows = DB[table];
  let order = null, limit = null, offset = 0, select = null;
  for (const [k, v] of q) {
    if (k === 'order') order = v; else if (k === 'limit') limit = +v; else if (k === 'offset') offset = +v;
    else if (k === 'select') select = v; else rows = rows.filter(r => matches(r, k, v));
  }
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
  if (method === 'POST') {
    const list = [].concat(JSON.parse(body));
    const made = [];
    for (const r of list) {
      const row = Object.assign({ id: randomUUID(), tags: [], meta: {}, created_at: nextTs() }, r);
      if (table === 'brand_memory') {
        if (row.text == null) return { status: 400, data: { code: '23502', message: 'null value in column "text"' } };
        if (!['story', 'belief', 'speech'].includes(row.kind)) return { status: 400, data: { code: '23514', message: 'violates check constraint' } };
        if (row.kind === 'belief' && DB.brand_memory.some(x => x.kind === 'belief' && x.brand_id === row.brand_id &&
            x.text.toLowerCase() === row.text.toLowerCase())) {
          return { status: 409, data: { code: '23505', message: 'duplicate key value violates unique constraint "brand_memory_belief_once_idx"' } };
        }
        // The BEFORE INSERT trigger in sql/brand-memory.sql, as PostgREST reports a RAISE: 400, P0001.
        const cap = { belief: 50, story: 200 }[row.kind];
        if (cap && DB.brand_memory.filter(x => x.brand_id === row.brand_id && x.kind === row.kind).length >= cap) {
          return { status: 400, data: { code: 'P0001', message: 'brand_memory_full', details: String(cap), hint: 'full' } };
        }
      }
      made.push(row);
    }
    DB[table].push(...made);
    return /return=representation/.test(headers.Prefer || '') ? { status: 201, data: JSON.parse(JSON.stringify(made)) } : { status: 201, data: null };
  }
  if (method === 'DELETE') {
    const kill = new Set(rows);
    DB[table] = DB[table].filter(r => !kill.has(r));
    return { status: 204, data: null };
  }
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
    if (out === 'hang' || done) return;                       // silent: only the timeout can end it
    if (tmo) clearTimeout(tmo);
    if (out === 'reject') return req.emit('error', new Error('ECONNRESET (fake)'));
    const resp = new EventEmitter(); resp.statusCode = out.status;
    cb(resp);
    if (out.raw != null) resp.emit('data', out.raw);            // a gateway's own page, not PostgREST JSON
    else if (out.data != null) resp.emit('data', JSON.stringify(out.data));
    resp.emit('end');
  }, DELAY ? DELAY(opts.method, opts.path) || 0 : 0);
  return req;
};

// Credits must never be touched. A trap stands in for api/_usage.js; the endpoint must not load it.
let usageTouched = false;
{
  const k = require_.resolve(path.join(ROOT, 'api/_usage.js'));
  const trap = new Proxy({}, { get(_, prop) { if (prop !== 'then' && typeof prop === 'string') usageTouched = true; return () => { throw new Error('credits touched'); }; } });
  require_.cache[k] = { id: k, filename: k, loaded: true, exports: trap };
  void trap.guard; ok(usageTouched === true, 'self-test: the credits trap records a touch');
  usageTouched = false;
}

const handler = require_(path.join(ROOT, 'api/brand-memory.js'));
const bctx = require_(path.join(ROOT, 'api/_brandctx.js'));

async function call(body, { token = TOK.owner, method = 'POST', origin = 'https://contentshrimp.com' } = {}) {
  const res = { code: 0, body: undefined, headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
  const headers = { origin };
  if (token) headers.authorization = 'Bearer ' + token;
  await handler({ method, headers, body }, res);
  return res;
}
const mem = (brand, kind) => DB.brand_memory.filter(r => r.brand_id === brand && (!kind || r.kind === kind));
const seed = (brand, kind, text, created_at, tags, by) => {
  const r = { id: randomUUID(), brand_id: brand, kind, text, tags: tags || [], meta: {}, created_by: by === undefined ? U.owner : by, created_at };
  DB.brand_memory.push(r); return r;
};

// ═══ 1. method, auth, access ═══════════════════════════════════════════════════════════════════
resetDb();
{
  let r = await call({}, { method: 'OPTIONS' });
  ok(r.code === 200 && /POST/.test(r.headers['Access-Control-Allow-Methods'] || ''), 'OPTIONS preflight answers 200 with POST allowed');
  r = await call({ brandId: A, action: 'list' }, { method: 'GET' });
  ok(r.code === 405, 'GET is refused with 405, got ' + r.code);
  r = await call({ brandId: A, action: 'list' }, { token: null });
  ok(r.code === 401, 'no token -> 401, got ' + r.code);
  r = await call({ brandId: A, action: 'list' }, { token: 'tok-forged' });
  ok(r.code === 401, 'a token the auth server rejects -> 401, got ' + r.code);
  r = await call({ brandId: A, action: 'list' });
  ok(r.code === 200 && Array.isArray(r.body.items), 'the owner can list (200 {items}), got ' + r.code);
  r = await call({ brandId: A, action: 'list' }, { token: TOK.member });
  ok(r.code === 200, 'a brand MEMBER can list too, got ' + r.code);
  r = await call({ brandId: A, action: 'list' }, { token: TOK.stranger });
  ok(r.code === 403 && r.body.code === 'forbidden' && !('items' in r.body), 'a non-member gets 403 and no items, got ' + r.code);
  r = await call({ brandId: A, action: 'add', kind: 'story', text: 'sneaky' }, { token: TOK.stranger });
  ok(r.code === 403 && mem(A).length === 0, 'a non-member cannot add (403, nothing stored)');
  FAULT = (m, t) => (t === 'brands' ? { status: 500, data: { message: 'boom' } } : null);
  r = await call({ brandId: A, action: 'list' });
  ok(r.code === 503 && r.body.code === 'access_check_failed', 'an access check that could not run is 503 access_check_failed, not 403 and not a list — got ' + r.code);
  FAULT = null;
  for (const [b, want] of [[{ brandId: 'not-a-uuid', action: 'list' }, 'bad brandId'], [{ brandId: A, action: 'nuke' }, 'bad action'],
                           [{ brandId: A, action: 'list', kind: 'poem' }, 'bad kind'], [{ brandId: A, action: 'add', text: 'x' }, 'add without kind']]) {
    r = await call(b);
    ok(r.code === 400, want + ' -> 400, got ' + r.code);
  }
}

// ═══ 2. add: trim, caps, empty, tags ═══════════════════════════════════════════════════════════
resetDb();
{
  let r = await call({ brandId: A, action: 'add', kind: 'story', text: '  My first client paid in chickens.\nTrue story.  ', tags: ['origin'] });
  ok(r.code === 200 && r.body.item && r.body.item.id, 'a story is added (200 {item}), got ' + r.code);
  ok(r.body.item && r.body.item.text === 'My first client paid in chickens.\nTrue story.', 'the story is trimmed and keeps its line break: ' + JSON.stringify(r.body.item && r.body.item.text));
  ok(r.body.item && ['id', 'kind', 'text', 'tags', 'created_at'].every(k => k in r.body.item), 'item has {id, kind, text, tags, created_at}');
  ok(mem(A, 'story').length === 1 && mem(A, 'story')[0].created_by === U.owner, 'the story row exists and records who added it');

  r = await call({ brandId: A, action: 'add', kind: 'story', text: 'x'.repeat(600) });
  ok(r.code === 200, 'a 600-char story is accepted, got ' + r.code);
  r = await call({ brandId: A, action: 'add', kind: 'story', text: 'x'.repeat(601) });
  ok(r.code === 400 && r.body.code === 'too_long' && r.body.max === 600 && mem(A, 'story').length === 2, 'a 601-char story is refused (400 too_long, max 600) and not stored');
  r = await call({ brandId: A, action: 'add', kind: 'belief', text: 'b'.repeat(140) });
  ok(r.code === 200, 'a 140-char belief is accepted, got ' + r.code);
  r = await call({ brandId: A, action: 'add', kind: 'belief', text: 'c'.repeat(141) });
  ok(r.code === 400 && r.body.code === 'too_long' && mem(A, 'belief').length === 1, 'a 141-char belief is refused and not stored');
  r = await call({ brandId: A, action: 'add', kind: 'speech', text: 'w'.repeat(800) });
  ok(r.code === 200 && !r.body.clipped && mem(A, 'speech')[0].text.length === 800, 'an 800-char speech sample is stored whole');
  const long = Array.from({ length: 200 }, (_, i) => 'word' + i).join(' ');   // ~1,200 chars
  r = await call({ brandId: A, action: 'add', kind: 'speech', text: long });
  const saved = r.body.item && r.body.item.text;
  ok(r.code === 200 && r.body.clipped === true && saved && saved.length <= 800 && saved.length > 600 && long.startsWith(saved) &&
     long[saved.length] === ' ', 'a long take transcript is clipped to ≤800 at a word boundary and says so (clipped:true): ' + (saved || '').length);

  const before = DB.brand_memory.length;
  for (const t of ['', '   \n  ']) {
    r = await call({ brandId: A, action: 'add', kind: 'story', text: t });
    ok(r.code === 400 && r.body.code === 'empty', 'empty/whitespace text is refused (400 empty) for ' + JSON.stringify(t));
  }
  r = await call({ brandId: A, action: 'add', kind: 'belief', text: 12345 });
  ok(r.code === 400, 'non-string text is refused, got ' + r.code);
  ok(DB.brand_memory.length === before, 'nothing was stored by the refused adds');

  r = await call({ brandId: A, action: 'add', kind: 'story', text: 'tagged', tags: ['  Money ', 'money', '', 'x'.repeat(50), 'a', 'b', 'c', 'd', 7] });
  const tg = r.body.item && r.body.item.tags;
  ok(Array.isArray(tg) && tg.length === 5 && tg[0] === 'Money' && tg[1].length === 30 && !tg.includes('') && tg.filter(t => t.toLowerCase() === 'money').length === 1,
     'tags are trimmed, de-duplicated, ≤30 chars and at most 5: ' + JSON.stringify(tg));
  r = await call({ brandId: A, action: 'add', kind: 'story', text: 'untagged' });
  ok(r.code === 200 && Array.isArray(r.body.item.tags) && r.body.item.tags.length === 0, 'no tags -> []');
  r = await call({ brandId: A, action: 'add', kind: 'story', text: 'bad tags', tags: 'money' });
  ok(r.code === 400 && !mem(A, 'story').some(x => x.text === 'bad tags'), 'tags that are not a list are refused and nothing stored');
}

// ═══ 3. beliefs are one per brand, case- and space-insensitive ═══════════════════════════════════
resetDb();
{
  let r = await call({ brandId: A, action: 'add', kind: 'belief', text: 'Cheap coffee is a tax on your mornings.' });
  const first = r.body.item && r.body.item.id;
  const posts = () => REQS.filter(q => q.method === 'POST' && q.table === 'brand_memory').length;
  const p0 = posts();
  r = await call({ brandId: A, action: 'add', kind: 'belief', text: '  cheap   COFFEE is a tax on your mornings. ' });
  ok(r.code === 200 && r.body.duplicate === true && r.body.item && r.body.item.id === first, 'the same belief in other case/spacing returns the held one (duplicate:true, same id)');
  ok(mem(A, 'belief').length === 1, 'still exactly one belief row, got ' + mem(A, 'belief').length);
  ok(posts() === p0, 'the duplicate was caught BEFORE writing (no insert attempted), not left to the database');
  r = await call({ brandId: A, action: 'add', kind: 'belief', text: 'Good coffee is cheaper than a bad morning.' });
  ok(r.code === 200 && !r.body.duplicate && mem(A, 'belief').length === 2, 'a different belief is a new row');
  r = await call({ brandId: C, action: 'add', kind: 'belief', text: 'Cheap coffee is a tax on your mornings.' });
  ok(r.code === 200 && !r.body.duplicate && mem(C, 'belief').length === 1, 'the same belief in ANOTHER brand is its own row (dedupe is per brand)');

  // The race: the pre-check saw nothing, the unique index refused the insert -> the held row, not an error.
  let n = 0;
  FAULT = (m, t, p) => (m === 'GET' && t === 'brand_memory' && /kind=eq\.belief/.test(p) && n++ === 0 ? { status: 200, data: [] } : null);
  r = await call({ brandId: A, action: 'add', kind: 'belief', text: 'Good coffee is cheaper than a bad morning.' });
  ok(r.code === 200 && r.body.duplicate === true && mem(A, 'belief').length === 2, 'losing the race to an identical belief (23505) answers with the held row');
  FAULT = (m, t) => (m === 'POST' && t === 'brand_memory' ? { status: 409, data: { code: '23503', message: 'fk violation' } } : null);
  r = await call({ brandId: A, action: 'add', kind: 'belief', text: 'A brand new belief.' });
  ok(r.code === 503 && !r.body.item, 'a 409 that is NOT the belief index is an honest 503, got ' + r.code);
  FAULT = null;
}

// ═══ 4. speech keeps the newest 20 per brand ═══════════════════════════════════════════════════
resetDb();
{
  seed(C, 'speech', 'other brand sample 1', '2025-01-01T00:00:00.000Z');
  seed(C, 'speech', 'other brand sample 2', '2025-01-02T00:00:00.000Z');
  seed(A, 'story', 'a story that must survive', '2025-01-03T00:00:00.000Z');
  let all200 = true;
  for (let i = 1; i <= 23; i++) {
    const r = await call({ brandId: A, action: 'add', kind: 'speech', text: 'speech sample ' + i });
    if (r.code !== 200 || r.body.pruneFailed) all200 = false;
  }
  ok(all200, 'every speech add returned 200 without a prune failure');
  const texts = mem(A, 'speech').map(r => r.text);
  ok(texts.length === 20, 'brand A keeps exactly 20 speech samples, has ' + texts.length);
  ok(!texts.includes('speech sample 1') && !texts.includes('speech sample 3') && texts.includes('speech sample 4') && texts.includes('speech sample 23'),
     'the OLDEST three were pruned and the newest kept');
  ok(mem(C, 'speech').length === 2 && mem(A, 'story').length === 1, "pruning never touched another brand's samples or another kind");
  const l = await call({ brandId: A, action: 'list', kind: 'speech' });
  ok(l.code === 200 && l.body.items.length === 20 && l.body.items[0].text === 'speech sample 23', 'listing speech gives the 20, newest first');

  // A prune that fails does not un-save the sample — and says so.
  FAULT = (m, t) => (m === 'DELETE' && t === 'brand_memory' ? { status: 500, data: { message: 'boom' } } : null);
  const r = await call({ brandId: A, action: 'add', kind: 'speech', text: 'speech sample 24' });
  FAULT = null;
  ok(r.code === 200 && r.body.item && r.body.pruneFailed === true && mem(A, 'speech').some(x => x.text === 'speech sample 24'),
     'a failed prune still reports the saved sample, flagged pruneFailed');
}

// ═══ 4b. a story or belief list that is full refuses the add (never drops the founder's words) ═══
resetDb();
{
  const KM = handler.KIND_MAX || {};
  ok(KM.belief === 50 && KM.story === 200, 'caps are beliefs 50, stories 200: ' + JSON.stringify(KM));
  for (let i = 0; i < 49; i++) seed(A, 'belief', 'held belief ' + i, '2025-01-01T00:00:' + String(i).padStart(2, '0') + '.000Z');
  let r = await call({ brandId: A, action: 'add', kind: 'belief', text: 'the fiftieth belief' });
  ok(r.code === 200 && mem(A, 'belief').length === 50, 'belief 50 of 50 is accepted, got ' + r.code);
  const postsNow = () => REQS.filter(q => q.method === 'POST' && q.table === 'brand_memory').length;
  let p0 = postsNow();
  r = await call({ brandId: A, action: 'add', kind: 'belief', text: 'one belief too many' });
  ok(postsNow() === p0, 'a full belief list refuses BEFORE writing (no insert attempted)');
  ok(r.code === 409 && r.body.code === 'memory_full' && r.body.max === 50 && /nothing was saved/.test(r.body.error || '') && mem(A, 'belief').length === 50,
     'belief 51 is refused: 409 memory_full {max:50}, says nothing was saved, nothing stored — got ' + r.code);
  r = await call({ brandId: A, action: 'add', kind: 'belief', text: 'HELD belief 7' });
  ok(r.code === 200 && r.body.duplicate === true, 'a belief already held is still answered (duplicate) when the list is full');
  r = await call({ brandId: C, action: 'add', kind: 'belief', text: 'one belief too many' });
  ok(r.code === 200, "another brand's belief list is its own (not full)");
  for (let i = 0; i < 199; i++) seed(A, 'story', 'held story ' + i, '2025-01-02T00:00:00.000Z');
  r = await call({ brandId: A, action: 'add', kind: 'story', text: 'story 200' });
  ok(r.code === 200 && mem(A, 'story').length === 200, 'story 200 of 200 is accepted, got ' + r.code);
  p0 = postsNow();
  r = await call({ brandId: A, action: 'add', kind: 'story', text: 'story 201' });
  ok(postsNow() === p0, 'a full story bank refuses BEFORE writing (no insert attempted)');
  ok(r.code === 409 && r.body.code === 'memory_full' && r.body.max === 200 && mem(A, 'story').length === 200, 'story 201 is refused (409 memory_full {max:200}) — got ' + r.code);
  r = await call({ brandId: A, action: 'list', kind: 'story' });
  ok(r.code === 200 && r.body.items.length === 200, 'a full story bank lists whole (200), got ' + (r.body.items || []).length);
  FAULT = (m, t, p) => (m === 'GET' && t === 'brand_memory' && /kind=eq\.story&select=id&limit=/.test(p) ? { status: 500, data: null } : null);
  r = await call({ brandId: C, action: 'add', kind: 'story', text: 'count unreadable' });
  FAULT = null;
  ok(r.code === 503 && !mem(C, 'story').length, 'when the story count cannot be read, nothing is stored (503)');
  for (let i = 0; i < 25; i++) {
    r = await call({ brandId: A, action: 'add', kind: 'speech', text: 'take ' + i });
    if (r.code !== 200) break;
  }
  ok(r.code === 200 && mem(A, 'speech').length === 20, 'speech is never "full" — it is pruned to the newest 20');
}

// ═══ 4c. speech is pruned PER PERSON — a member's takes never push out the owner's ═══════════
resetDb();
{
  for (let i = 0; i < 20; i++) seed(A, 'speech', 'owner take ' + i, '2025-01-01T00:00:' + String(i).padStart(2, '0') + '.000Z', [], U.owner);
  let r;
  for (let i = 0; i < 25; i++) {
    r = await call({ brandId: A, action: 'add', kind: 'speech', text: 'member take ' + i }, { token: TOK.member });
    if (r.code !== 200) break;
  }
  const by = who => mem(A, 'speech').filter(x => x.created_by === who).map(x => x.text);
  ok(r.code === 200 && by(U.owner).length === 20 && by(U.owner).includes('owner take 0'), "25 member takes leave all 20 of the owner's samples: owner has " + by(U.owner).length);
  ok(by(U.member).length === 20 && !by(U.member).includes('member take 4') && by(U.member).includes('member take 24'), 'the member keeps their own newest 20');
  r = await call({ brandId: A, action: 'add', kind: 'speech', text: 'owner take new' });
  ok(r.code === 200 && by(U.owner).length === 20 && !by(U.owner).includes('owner take 0') && by(U.owner).includes('owner take new') && by(U.member).length === 20,
     "the owner's own add prunes only the owner's oldest sample, never the member's");
  r = await call({ brandId: A, action: 'list', kind: 'speech' });
  ok(r.code === 200 && r.body.items.length === 40, 'listing speech shows every kept sample (20 per person), got ' + (r.body.items || []).length);
}

// ═══ 4d. the cap holds when two adds race — the DATABASE refuses the late one ═════════════════
// Soundness under simultaneous commits comes from Postgres: the trigger takes a per-brand-per-kind
// transaction lock before it counts (checked in section 8). Here: when the database refuses, the
// endpoint answers 409 memory_full and never reports the refused add as saved.
resetDb();
{
  const iso = n => new Date(Date.UTC(2025, 0, 1) + n * 1000).toISOString();
  const preCheck = (kind, show) => (m, t, p) => {
    // the add's own early count — made to miss a row a simultaneous add has just saved
    if (m === 'GET' && t === 'brand_memory' && p.includes('kind=eq.' + kind) && !/created_by=/.test(p)) {
      return { status: 200, data: JSON.parse(JSON.stringify(mem(A, kind).slice(0, show))) };
    }
    return null;
  };
  for (let i = 0; i < 50; i++) seed(A, 'belief', 'held ' + i, iso(i));
  FAULT = preCheck('belief', 49);
  let r = await call({ brandId: A, action: 'add', kind: 'belief', text: 'raced in last' });
  FAULT = null;
  ok(r.code === 409 && r.body.code === 'memory_full' && r.body.max === 50 && !r.body.item && mem(A, 'belief').length === 50 &&
     !mem(A, 'belief').some(x => x.text === 'raced in last'),
     'a belief the database refuses as over the cap is 409 memory_full {max:50}, not saved, not a 503 — got ' + r.code + ' ' + (r.body && r.body.code));
  resetDb();
  for (let i = 0; i < 200; i++) seed(A, 'story', 'held story ' + i, iso(i));
  FAULT = preCheck('story', 199);
  r = await call({ brandId: A, action: 'add', kind: 'story', text: 'raced story' });
  FAULT = null;
  ok(r.code === 409 && r.body.code === 'memory_full' && r.body.max === 200 && mem(A, 'story').length === 200, 'a story the database refuses as over the cap is 409 — got ' + r.code);
  // Two adds at once, both past the early count: exactly one is saved.
  resetDb();
  for (let i = 0; i < 49; i++) seed(A, 'belief', 'held ' + i, iso(i));
  FAULT = preCheck('belief', 49);
  const [r1, r2] = await Promise.all([
    call({ brandId: A, action: 'add', kind: 'belief', text: 'racer one' }),
    call({ brandId: A, action: 'add', kind: 'belief', text: 'racer two' }),
  ]);
  FAULT = null;
  const codes = [r1.code, r2.code].sort().join(',');
  ok(codes === '200,409' && mem(A, 'belief').length === 50, 'two simultaneous adds for the last place: one 200, one 409, 50 stored — got ' + codes + ', ' + mem(A, 'belief').length);
  // Any other database refusal is not "full".
  FAULT = (m, t) => (m === 'POST' && t === 'brand_memory' ? { status: 400, data: { code: 'P0001', message: 'some other raise' } } : null);
  r = await call({ brandId: C, action: 'add', kind: 'belief', text: 'other refusal' });
  FAULT = null;
  ok(r.code === 503 && r.body.code === 'memory_write_failed', 'a different RAISE is an honest 503, not memory_full — got ' + r.code);
}

// ═══ 4e. the request deadline ══════════════════════════════════════════════════════════════════
{
  const T = handler.TIMING, saved = Object.assign({}, T);
  // Production values fit inside vercel.json's maxDuration for this function.
  const vj = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const maxMs = ((vj.functions && vj.functions['api/brand-memory.js'] || {}).maxDuration || 10) * 1000;
  ok(T.deadlineMs + T.minCallMs <= maxMs && T.minCallMs >= 8000 + 1000 && T.deadlineMs >= 20000,
     'deadline ' + T.deadlineMs + 'ms + one last call ' + T.minCallMs + 'ms fits maxDuration ' + maxMs + 'ms, and a call is never started with less than store.js\'s 8s timeout left');

  resetDb();
  T.deadlineMs = 400; T.minCallMs = 150;
  DELAY = () => 100;                     // every database round trip takes 100ms
  let r = await call({ brandId: A, action: 'add', kind: 'story', text: 'too slow to start' });
  const posted = REQS.some(q => q.method === 'POST');
  ok(r.code === 503 && r.body.code === 'timeout' && /nothing was changed/.test(r.body.error || '') && !posted && !mem(A).length,
     'when too little time is left, no write is STARTED and the answer is 503 timeout, nothing changed — got ' + r.code + ' ' + (r.body && r.body.code));
  DELAY = null; resetDb();
  r = await call({ brandId: A, action: 'add', kind: 'story', text: 'fast enough' });
  ok(r.code === 200 && mem(A, 'story').length === 1, 'the same add with a healthy database is saved (opposite arm)');

  // The insert itself was slow: the sample IS saved, the tidy-up is skipped, and it says so.
  resetDb();
  for (let i = 0; i < 20; i++) seed(A, 'speech', 'old take ' + i, '2025-01-01T00:00:' + String(i).padStart(2, '0') + '.000Z');
  DELAY = (m) => (m === 'POST' ? 300 : 0);
  r = await call({ brandId: A, action: 'add', kind: 'speech', text: 'slow insert' });
  DELAY = null;
  ok(r.code === 200 && r.body.item && r.body.pruneFailed === true && mem(A, 'speech').some(x => x.text === 'slow insert'),
     'a save that finished late is reported as saved (200, pruneFailed) — never as a failure — got ' + r.code);
  Object.assign(T, saved);

  // The insert was sent and the connection died: it may or may not be saved — say exactly that.
  resetDb();
  FAULT = (m, t) => (m === 'POST' && t === 'brand_memory' ? 'reject' : null);
  r = await call({ brandId: A, action: 'add', kind: 'story', text: 'unknown fate' });
  FAULT = null;
  ok(r.code === 503 && r.body.code === 'memory_write_unknown' && !/nothing was/.test(r.body.error || ''),
     'an insert with no answer is 503 memory_write_unknown, never "nothing was saved" — got ' + r.code + ' ' + (r.body && r.body.code));
  const own = seed(A, 'story', 'to delete', '2025-01-01T00:00:00.000Z');
  FAULT = (m, t) => (m === 'DELETE' && t === 'brand_memory' ? 'reject' : null);
  r = await call({ brandId: A, action: 'delete', id: own.id });
  FAULT = null;
  ok(r.code === 503 && r.body.code === 'memory_write_unknown', 'a delete with no answer is 503 memory_write_unknown — got ' + r.code);
}

// ═══ 5. list and delete ═══════════════════════════════════════════════════════════════════════
resetDb();
{
  const s1 = seed(A, 'story', 'older story', '2025-02-01T00:00:00.000Z');
  const s2 = seed(A, 'story', 'newer story', '2025-03-01T00:00:00.000Z');
  seed(A, 'belief', 'a belief', '2025-02-15T00:00:00.000Z');
  const cRow = seed(C, 'story', "brand C's story", '2025-02-01T00:00:00.000Z');
  const bRow = seed(B, 'story', "someone else's story", '2025-02-01T00:00:00.000Z');
  let r = await call({ brandId: A, action: 'list', kind: 'story' });
  ok(r.code === 200 && r.body.items.map(i => i.text).join('|') === 'newer story|older story', 'list by kind is newest first and only that kind');
  r = await call({ brandId: A, action: 'list' });
  ok(r.code === 200 && r.body.items.length === 3 && !r.body.items.some(i => i.text.includes('brand C') || i.text.includes('someone')),
     "list with no kind returns all of THIS brand's items and nothing from another brand");

  r = await call({ brandId: A, action: 'delete', id: cRow.id });
  ok(r.code === 404 && DB.brand_memory.includes(cRow), "deleting brand C's item through brand A is refused (404) and the item survives — even for its owner");
  r = await call({ brandId: A, action: 'delete', id: bRow.id });
  ok(r.code === 404 && DB.brand_memory.includes(bRow), "deleting another account's item through your own brand is refused and it survives");
  r = await call({ brandId: B, action: 'delete', id: bRow.id });
  ok(r.code === 403 && DB.brand_memory.includes(bRow), "deleting in a brand you cannot access is 403");
  r = await call({ brandId: A, action: 'delete', id: 'nope' });
  ok(r.code === 400, 'a malformed id is 400');
  // Owner-only delete (v658 house rule), with the member's own rows as the one exception.
  const mine = seed(A, 'story', 'the member wrote this', '2025-02-02T00:00:00.000Z', [], U.member);
  const theirs = seed(A, 'story', 'the member wrote this too', '2025-02-03T00:00:00.000Z', [], U.member);
  const orphan = seed(A, 'story', 'nobody recorded who wrote this', '2025-02-04T00:00:00.000Z', [], null);
  r = await call({ brandId: A, action: 'delete', id: s1.id }, { token: TOK.member });
  ok(r.code === 403 && r.body.code === 'owner_only' && DB.brand_memory.includes(s1), "a member CANNOT delete the owner's item (403 owner_only) and it survives — got " + r.code + ' ' + (r.body && r.body.code));
  r = await call({ brandId: A, action: 'delete', id: orphan.id }, { token: TOK.member });
  ok(r.code === 403 && r.body.code === 'owner_only' && DB.brand_memory.includes(orphan), 'a member cannot delete an item with no recorded author');
  r = await call({ brandId: A, action: 'delete', id: mine.id }, { token: TOK.member });
  ok(r.code === 200 && r.body.ok === true && !DB.brand_memory.includes(mine) && DB.brand_memory.includes(s1) && DB.brand_memory.includes(theirs),
     'a member deletes an item THEY added; only that item goes');
  r = await call({ brandId: A, action: 'delete', id: theirs.id });
  ok(r.code === 200 && !DB.brand_memory.includes(theirs), "the owner deletes an item a member added");
  r = await call({ brandId: A, action: 'delete', id: s1.id });
  ok(r.code === 200 && !DB.brand_memory.includes(s1) && DB.brand_memory.includes(s2), "the owner deletes their own item; only that item goes");
  r = await call({ brandId: A, action: 'delete', id: s1.id });
  ok(r.code === 404, 'deleting it again is 404 not_found');
  // Could not tell who owns the brand -> nothing deleted, honestly.
  FAULT = (m, t, p) => (m === 'GET' && t === 'brands' && /select=user_id$/.test(p) ? { status: 500, data: { message: 'boom' } } : null);
  r = await call({ brandId: A, action: 'delete', id: orphan.id });
  FAULT = null;
  ok(r.code === 503 && DB.brand_memory.includes(orphan), 'when the owner check cannot read, the delete is 503 and the item survives');
  FAULT = (m, t) => (m === 'DELETE' && t === 'brand_memory' ? { status: 500, data: { code: 'XX000', message: 'boom' } } : null);
  r = await call({ brandId: A, action: 'delete', id: s2.id });
  FAULT = null;
  ok(r.code === 503 && r.body.ok !== true && DB.brand_memory.includes(s2) && /still there/.test(r.body.error || ''), 'a failed delete is 503 and says the item is still there');
}

// ═══ 6. failures are never answers ═════════════════════════════════════════════════════════════
resetDb();
{
  seed(A, 'story', 'exists', '2025-01-01T00:00:00.000Z');
  let r = await call({ brandId: A, action: 'list' });
  ok(r.code === 200 && r.body.items.length === 1, 'baseline: a healthy list returns the item');
  FAULT = (m, t) => (m === 'GET' && t === 'brand_memory' ? { status: 500, data: { code: 'XX000', message: 'internal' } } : null);
  r = await call({ brandId: A, action: 'list' });
  ok(r.code === 503 && r.body.code === 'memory_read_failed' && !('items' in r.body), 'a PostgREST 500 on list is 503 memory_read_failed with NO items (never an empty list)');
  FAULT = (m, t) => (m === 'GET' && t === 'brand_memory' ? 'reject' : null);
  r = await call({ brandId: A, action: 'list' });
  ok(r.code === 503 && !('items' in r.body), 'a refused connection on list is 503, got ' + r.code);
  FAULT = (m, t) => (m === 'GET' && t === 'brand_memory' && true ? { status: 200, data: { unexpected: 'shape' } } : null);
  r = await call({ brandId: A, action: 'list' });
  ok(r.code === 503 && !('items' in r.body), 'a 200 whose body is not a list is not an answer either');
  FAULT = (m, t) => (m === 'GET' && t === 'brand_memory' && true ? { status: 500, data: null } : null);
  r = await call({ brandId: A, action: 'add', kind: 'belief', text: 'fresh belief' });
  ok(r.code === 503 && !mem(A, 'belief').length, 'when the belief check cannot read, nothing is inserted (503)');
  FAULT = (m, t) => (m === 'POST' && t === 'brand_memory' ? { status: 500, data: { code: 'XX000', message: 'insert failed' } } : null);
  r = await call({ brandId: A, action: 'add', kind: 'story', text: 'will not save' });
  ok(r.code === 503 && r.body.code === 'memory_write_failed' && !r.body.item, 'a PostgREST error (JSON with a code) on insert is 503 memory_write_failed with no item');
  // A gateway answer in front of PostgREST says nothing about whether the write committed.
  const GATEWAY = [
    ['502 page', { status: 502, raw: '<html>Bad Gateway</html>' }], ['503 page', { status: 503, raw: '<html>Service Unavailable</html>' }],
    ['504 page', { status: 504, raw: '<html>Gateway Timeout</html>' }], ['503 JSON', { status: 503, data: { code: 'PGRST002', message: 'x' } }],
    ['500 non-JSON', { status: 500, raw: 'Internal Server Error' }], ['500 empty', { status: 500, raw: '' }],
    ['500 JSON without a code', { status: 500, data: { message: 'x' } }],
  ];
  for (const [label, spec] of GATEWAY) {
    FAULT = (m, t) => (m === 'POST' && t === 'brand_memory' ? spec : null);
    r = await call({ brandId: A, action: 'add', kind: 'story', text: 'gateway ' + label });
    FAULT = null;
    ok(r.code === 503 && r.body.code === 'memory_write_unknown' && !/nothing was/.test(r.body.error || ''),
       'insert answered by a ' + label + ' is memory_write_unknown (it may have committed) — got ' + r.code + ' ' + (r.body && r.body.code));
  }
  {
    const target = seed(A, 'story', 'gateway delete target', '2025-01-01T00:00:00.000Z');
    for (const [label, spec] of GATEWAY) {
      FAULT = (m, t) => (m === 'DELETE' && t === 'brand_memory' ? spec : null);
      r = await call({ brandId: A, action: 'delete', id: target.id });
      FAULT = null;
      ok(r.code === 503 && r.body.code === 'memory_write_unknown' && !/still there/.test(r.body.error || ''),
         'delete answered by a ' + label + ' is memory_write_unknown, never "it is still there" — got ' + r.code + ' ' + (r.body && r.body.code));
    }
    // Opposite arms: genuine PostgREST answers keep their meaning.
    FAULT = (m, t) => (m === 'DELETE' && t === 'brand_memory' ? { status: 500, data: { code: 'XX000', message: 'boom' } } : null);
    r = await call({ brandId: A, action: 'delete', id: target.id });
    FAULT = null;
    ok(r.code === 503 && r.body.code === 'memory_write_failed' && /still there/.test(r.body.error || ''), 'a PostgREST JSON error on delete still says it is still there');
  }
  FAULT = (m, t) => (m === 'POST' && t === 'brand_memory' ? { status: 201, data: [] } : null);
  r = await call({ brandId: A, action: 'add', kind: 'story', text: 'phantom' });
  ok(r.code === 503 && !r.body.item, 'an insert that returned no row is not reported as saved');
  FAULT = null;

  delete DB.brand_memory;   // the SQL has not been run
  for (const b of [{ brandId: A, action: 'list' }, { brandId: A, action: 'add', kind: 'story', text: 'x' },
                   { brandId: A, action: 'add', kind: 'belief', text: 'y' }, { brandId: A, action: 'delete', id: randomUUID() }]) {
    r = await call(b);
    ok(r.code === 503 && r.body.code === 'memory_not_ready', 'missing table (PGRST205) on ' + b.action + (b.kind ? ' ' + b.kind : '') + ' -> 503 memory_not_ready, got ' + r.code + ' ' + (r.body && r.body.code));
  }
  DB.brand_memory = [];
  FAULT = (m, t) => (t === 'brand_memory' ? { status: 404, data: { code: '42P01', message: 'relation "brand_memory" does not exist' } } : null);
  r = await call({ brandId: A, action: 'list' });
  ok(r.code === 503 && r.body.code === 'memory_not_ready', '42P01 is also memory_not_ready');
  FAULT = null;
  r = await call({ brandId: A, action: 'list' });
  ok(r.code === 200, 'and once the table exists, list works again');
}
ok(usageTouched === false, 'no credit / usage code was touched by any brand-memory request');

// ═══ 7. loadBrandContext carries memory; memory can never break the load ════════════════════════
resetDb();
{
  const iso = n => new Date(Date.UTC(2025, 0, 1) + n * 60000).toISOString();
  // interleaved kinds, known times; the newest of each kind is the highest n
  for (let i = 0; i < 25; i++) seed(A, 'belief', 'Belief number ' + i, iso(i * 3));
  seed(A, 'belief', '  BELIEF   number 24 ', iso(200));             // newest, a spacing/case duplicate of #24
  for (let i = 0; i < 35; i++) seed(A, 'story', 'Story ' + i + ' ' + 's'.repeat(700), iso(i * 3 + 1), i === 34 ? ['money', 'origin'] : []);
  for (let i = 0; i < 15; i++) seed(A, 'speech', 'Speech ' + i, iso(i * 3 + 2));
  seed(C, 'story', 'NOT brand A', iso(999));
  const stray = { id: randomUUID(), brand_id: A, kind: 'idea', text: 'wrong kind', created_at: iso(500) };

  // Arrival order must not matter: shuffle the table so the fake returns ties/out-of-order rows if unsorted.
  const t0 = Date.now();
  let h = await bctx.loadBrandContext(A, { userId: U.owner }, '');
  const healthyMs = Date.now() - t0;
  ok(h.ok === true, 'loadBrandContext succeeds: ' + JSON.stringify(h.reason));
  const bc = h.bc || {};
  ok(bc.memoryUnavailable === false, 'a healthy read sets memoryUnavailable:false');
  ok(Array.isArray(bc.beliefs) && bc.beliefs.length === 20, 'beliefs capped at 20, got ' + (bc.beliefs || []).length);
  ok(bc.beliefs[0] === 'BELIEF number 24' && bc.beliefs[1] === 'Belief number 23' && bc.beliefs.filter(b => /number 24$/i.test(b)).length === 1,
     'beliefs are newest first and de-duplicated: ' + JSON.stringify((bc.beliefs || []).slice(0, 3)));
  ok(Array.isArray(bc.stories) && bc.stories.length === 30, 'stories capped at 30, got ' + (bc.stories || []).length);
  const s0 = bc.stories[0] || {};
  ok(/^Story 34 /.test(s0.text) && s0.text.length === 600 && s0.id && JSON.stringify(s0.tags) === '["money","origin"]' &&
     Object.keys(s0).sort().join() === 'id,tags,text', 'stories are {id, text≤600, tags}, newest first: ' + JSON.stringify(Object.keys(s0)));
  ok(/^Story 5 /.test(bc.stories[29].text), 'the 30 stories are the newest 30 (oldest kept is Story 5)');
  ok(Array.isArray(bc.speechSamples) && bc.speechSamples.length === 10 && bc.speechSamples[0] === 'Speech 14' && bc.speechSamples[9] === 'Speech 5',
     'speechSamples: newest 10, newest first: ' + JSON.stringify(bc.speechSamples));
  ok(!JSON.stringify(bc).includes('NOT brand A'), "no other brand's item reaches the context");
  ok(bc.brandName === 'Acme Shrimp' && Array.isArray(bc.approvedExamples), 'the rest of the context still loads alongside memory');
  const memReqs = REQS.filter(q => q.table === 'brand_memory');
  const perKind = k => memReqs.filter(q => q.path.includes('kind=eq.' + k) && /order=created_at\.desc/.test(q.path) && /limit=\d+/.test(q.path));
  ok(memReqs.length === 4 && perKind('belief').length === 1 && perKind('story').length === 1 && perKind('speech').length === 2 &&
     perKind('speech').filter(q => q.path.includes('created_by=eq.' + U.owner)).length === 1,
     'memory is four small queries — one per kind plus the OWNER\'s speech — each newest first and limited (' + memReqs.map(q => q.path.split('?')[1]).join(' | ') + ')');
  const lim = k => +((perKind(k)[0] || { path: '' }).path.match(/limit=(\d+)/) || [])[1];
  ok(lim('speech') === 10 && lim('story') === 30 && lim('belief') >= 20 && lim('belief') <= 60,
     'each kind fetches only about what it can use (speech 10, story 30, belief 20–60): ' + [lim('belief'), lim('story'), lim('speech')].join('/'));

  // shuffled arrival
  FAULT = (m, t, p) => {
    if (t !== 'brand_memory') return null;
    // this kind's rows in id order (not time order), plus a stray row of an unknown kind
    const k = (p.match(/kind=eq\.(\w+)/) || [])[1];
    const rows = DB.brand_memory.filter(r => r.brand_id === A && r.kind === k).concat([stray])
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    return { status: 200, data: JSON.parse(JSON.stringify(rows)) };
  };
  h = await bctx.loadBrandContext(A, { userId: U.owner }, '');
  FAULT = null;
  ok(h.ok && h.bc.beliefs[0] === 'BELIEF number 24' && h.bc.speechSamples[0] === 'Speech 14' && /^Story 34 /.test(h.bc.stories[0].text),
     'rows that arrive out of order are still presented newest first');
  ok(h.ok && !JSON.stringify(h.bc).includes('wrong kind') && h.bc.stories.length === 30, 'a row of an unknown kind is ignored, never rendered');
  ok(h.ok && h.bc.beliefs.length === 20 && h.bc.stories.length === 30 && h.bc.speechSamples.length === 10,
     'a server that ignores the query limit still yields at most 20 / 30 / 10: ' + JSON.stringify(h.bc && [h.bc.beliefs.length, h.bc.stories.length, h.bc.speechSamples.length]));

  const direct = bctx.memoryFromRows([
    { id: 'x1', kind: 'idea', text: 'wrong kind', created_at: iso(900) },
    { id: 'x2', kind: 'speech', text: 'right kind', created_at: iso(800) },
  ]);
  ok(direct.speechSamples.join('|') === 'right kind' && !JSON.stringify(direct).includes('wrong kind'), 'memoryFromRows drops a row of an unknown kind');

  // Fairness: a flood of NEWER beliefs must not push stories or speech out of the context.
  for (let i = 0; i < 300; i++) seed(A, 'belief', 'Flood belief ' + i, iso(2000 + i));
  const flood = await bctx.loadBrandContext(A, { userId: U.owner }, '');
  ok(flood.ok && flood.bc.stories.length === 30 && flood.bc.speechSamples.length === 10 && flood.bc.beliefs.length === 20 &&
     flood.bc.beliefs[0] === 'Flood belief 299',
     '300 newer beliefs do not crowd out stories or speech: ' + JSON.stringify(flood.bc && [flood.bc.beliefs.length, flood.bc.stories.length, flood.bc.speechSamples.length]));
  DB.brand_memory = DB.brand_memory.filter(r => !/^Flood belief/.test(r.text));
  // All-or-nothing: one kind unreadable -> memory is unavailable, not half-present.
  FAULT = (m, t, p) => (t === 'brand_memory' && /kind=eq\.story/.test(p) ? { status: 500, data: { message: 'boom' } } : null);
  const half = await bctx.loadBrandContext(A, { userId: U.owner }, '');
  FAULT = null;
  ok(half.ok && half.bc.memoryUnavailable === true && half.bc.beliefs.length === 0 && half.bc.speechSamples.length === 0 && half.bc.brandName === 'Acme Shrimp',
     'one unreadable kind makes memory unavailable (empty + flagged), never half-present; the brand still loads');

  // Memory is not a brand field: the 424 thin-row guard must count the same with or without it.
  const withMem = h.fields;
  FAULT = (m, t) => (t === 'brand_memory' ? { status: 200, data: [] } : null);
  const empty = await bctx.loadBrandContext(A, { userId: U.owner }, '');
  ok(empty.ok && empty.bc.memoryUnavailable === false && empty.bc.beliefs.length === 0, 'a brand with no memory: empty arrays, memoryUnavailable:false (known empty, not unknown)');
  ok(withMem === empty.fields, 'memory does not change the populated-field count the 424 guard compares (' + withMem + ' vs ' + empty.fields + ')');

  for (const [label, fault] of [
    ['a PostgREST 500', { status: 500, data: { code: 'XX000', message: 'boom' } }],
    ['a missing table (PGRST205)', { status: 404, data: { code: 'PGRST205', message: 'not in schema cache' } }],
    ['a 200 whose body is not a list', { status: 200, data: { message: 'odd' } }],
    ['a refused connection', 'reject'],
  ]) {
    FAULT = (m, t) => (t === 'brand_memory' ? fault : null);
    const r = await bctx.loadBrandContext(A, { userId: U.owner }, '');
    FAULT = null;
    ok(r.ok === true && r.bc.memoryUnavailable === true && r.bc.beliefs.length === 0 && r.bc.stories.length === 0 &&
       r.bc.speechSamples.length === 0 && r.bc.brandName === 'Acme Shrimp' && Array.isArray(r.bc.approvedExamples),
       label + ': the load still succeeds, memory is empty AND flagged memoryUnavailable, the brand still loads — got ' + JSON.stringify(r.reason || (r.bc && r.bc.memoryUnavailable)));
  }

  // A silent memory table is bounded by MEMORY_READ_MS, not by store.js's 8s inactivity timeout.
  FAULT = (m, t) => (t === 'brand_memory' ? 'hang' : null);
  // Both the loader's timer and the fake socket's timer are unref'd (as they should be); a real
  // request keeps the event loop alive in production, so this keeps it alive here.
  const keepAlive = setInterval(() => {}, 1000);
  const t1 = Date.now();
  const hung = await bctx.loadBrandContext(A, { userId: U.owner }, '');
  const hungMs = Date.now() - t1;
  clearInterval(keepAlive);
  FAULT = null;
  ok(hung.ok === true && hung.bc.memoryUnavailable === true && hung.bc.brandName === 'Acme Shrimp', 'a silent memory table still yields a loaded brand with memoryUnavailable');
  ok(hungMs < bctx.MEMORY_READ_MS + 1500, 'a silent memory table costs at most ~MEMORY_READ_MS (' + bctx.MEMORY_READ_MS + 'ms), took ' + hungMs + 'ms');
  ok(healthyMs < 1000, 'a healthy load is not slowed by the bound (took ' + healthyMs + 'ms)');

  // And the opposite: a brand the caller cannot access is still refused before memory is read.
  REQS.length = 0;
  // The OWNER's speech comes first, even when members have many newer takes.
  DB.brand_memory = DB.brand_memory.filter(r => r.kind !== 'speech');
  for (let i = 0; i < 12; i++) seed(A, 'speech', 'Owner voice ' + i, iso(300 + i), [], U.owner);
  for (let i = 0; i < 15; i++) seed(A, 'speech', 'Member voice ' + i, iso(400 + i), [], U.member);
  let sp = await bctx.loadBrandContext(A, { userId: U.member }, '');
  ok(sp.ok && sp.bc.speechSamples.length === 10 && sp.bc.speechSamples.every(t => /^Owner voice/.test(t)) && sp.bc.speechSamples[0] === 'Owner voice 11',
     "with 15 newer member takes, the 10 samples are the owner's newest: " + JSON.stringify(sp.bc && sp.bc.speechSamples.slice(0, 3)));
  DB.brand_memory = DB.brand_memory.filter(r => !(r.kind === 'speech' && r.created_by === U.owner && !/ (9|10|11)$/.test(r.text)));
  sp = await bctx.loadBrandContext(A, { trusted: true }, '');
  ok(sp.ok && sp.bc.speechSamples.length === 10 && sp.bc.speechSamples.slice(0, 3).join('|') === 'Owner voice 11|Owner voice 10|Owner voice 9' &&
     sp.bc.speechSamples[3] === 'Member voice 14' && new Set(sp.bc.speechSamples).size === 10,
     "3 owner samples lead, then members' newest fill the rest, no duplicates: " + JSON.stringify(sp.bc && sp.bc.speechSamples));
  DB.brand_memory = DB.brand_memory.filter(r => !(r.kind === 'speech' && r.created_by === U.owner));
  sp = await bctx.loadBrandContext(A, { trusted: true }, '');
  ok(sp.ok && sp.bc.speechSamples.length === 10 && sp.bc.speechSamples[0] === 'Member voice 14', 'an owner with no samples: the newest 10 of everyone else');
  FAULT = (m, t, p) => (t === 'brand_memory' && /created_by=eq\./.test(p) ? { status: 500, data: null } : null);
  sp = await bctx.loadBrandContext(A, { trusted: true }, '');
  FAULT = null;
  ok(sp.ok && sp.bc.memoryUnavailable === true && sp.bc.speechSamples.length === 0, "the owner's speech query failing makes memory unavailable too (all-or-nothing)");

  REQS.length = 0;
  const denied = await bctx.loadBrandContext(A, { userId: U.stranger }, '');
  ok(denied.ok === false && denied.reason === 'forbidden' && !REQS.some(q => q.table === 'brand_memory'), 'a forbidden caller gets no context and memory is never read');
}

// ═══ 8. the SQL ════════════════════════════════════════════════════════════════════════════════
function sqlProblems(raw) {
  const s = stripSqlComments(raw).replace(/\s+/g, ' ');
  const p = [];
  if (!/create table if not exists public\.brand_memory \(/i.test(s)) p.push('table is not "create table if not exists public.brand_memory"');
  if (!/id uuid primary key default gen_random_uuid\(\)/i.test(s)) p.push('id is not uuid pk default gen_random_uuid()');
  if (!/brand_id uuid not null references public\.brands\(id\) on delete cascade/i.test(s)) p.push('brand_id does not reference brands(id) on delete cascade');
  if (!/kind text not null check \( ?kind in \( ?'story' ?, ?'belief' ?, ?'speech' ?\) ?\)/i.test(s)) p.push('kind has no check (story, belief, speech)');
  if (!/tags text\[\] not null default '\{\}'/i.test(s)) p.push("tags is not text[] not null default '{}'");
  if (!/create index if not exists \w+ on public\.brand_memory \( ?brand_id ?, ?kind ?, ?created_at desc ?\)/i.test(s)) p.push('no idempotent (brand_id, kind, created_at desc) index');
  if (/create (unique )?index (?!if not exists)/i.test(s)) p.push('an index is created without "if not exists"');
  if (!/alter table public\.brand_memory enable row level security/i.test(s)) p.push('RLS is not enabled');
  // Service role only: no client policy at all, and every policy an earlier run made is dropped.
  if (/create policy/i.test(s)) p.push('a client policy is created — clients must not read or write brand_memory directly');
  for (const n of ['brand_memory select member', 'brand_memory insert member', 'brand_memory delete member', 'brand_memory delete owner']) {
    if (!s.includes('drop policy if exists "' + n + '" on public.brand_memory')) p.push('the old policy "' + n + '" is not dropped');
  }
  // Length per kind, added only when missing, NOT VALID instead of deleting when old rows break it.
  const lenRe = /check \( ?char_length\(text\) between 1 and case kind when 'belief' then (\d+) when 'story' then (\d+) else (\d+) end ?\)/gi;
  const lens = [...s.matchAll(lenRe)];
  if (lens.length !== 2) p.push('the length check is not added in both branches (valid / not valid): ' + lens.length);
  for (const m of lens) if (+m[1] !== CAPS_JS.belief || +m[2] !== CAPS_JS.story || +m[3] !== CAPS_JS.speech) p.push('length check ' + m.slice(1).join('/') + ' differs from the API caps ' + JSON.stringify(CAPS_JS));
  if (!/if not exists \( ?select 1 from pg_constraint where conname = 'brand_memory_text_len' and conrelid = 'public\.brand_memory'::regclass ?\)/i.test(s)) p.push('the length constraint is not guarded by a pg_constraint check (re-running would error)');
  if (!/end\) not valid;/i.test(s)) p.push('no NOT VALID branch for existing over-length rows');
  if (/\bdelete from\b|\bupdate public\.brand_memory\b|\btruncate\b/i.test(s)) p.push('the file deletes or rewrites rows (no data loss without telling the owner)');
  // The count cap: BEFORE INSERT, lock per brand+kind FIRST, then count, then refuse.
  const fn = (s.match(/create or replace function public\.brand_memory_enforce_cap\(\) returns trigger language plpgsql set search_path = public, pg_temp as \$fn\$(.*?)\$fn\$/i) || [])[1] || '';
  if (!fn) p.push('no public.brand_memory_enforce_cap() trigger function with a pinned search_path');
  if (/security definer/i.test((s.match(/create or replace function public\.brand_memory_enforce_cap\(\)(.*?)\$fn\$/i) || [])[1] || '')) p.push('the cap function must not be SECURITY DEFINER');
  const capM = fn.match(/v_max := case new\.kind when 'belief' then (\d+) when 'story' then (\d+) else null end/i);
  if (!capM || +capM[1] !== KIND_MAX_JS.belief || +capM[2] !== KIND_MAX_JS.story) p.push('trigger caps ' + (capM ? capM.slice(1).join('/') : 'missing') + ' differ from the API caps ' + JSON.stringify(KIND_MAX_JS));
  const lockAt = fn.search(/perform pg_advisory_xact_lock\(/i), countAt = fn.search(/select count\(\*\) into v_count from public\.brand_memory where brand_id = new\.brand_id and kind = new\.kind/i);
  if (lockAt === -1) p.push('the trigger takes no transaction-level advisory lock');
  if (countAt === -1) p.push('the trigger does not count this brand+kind');
  if (lockAt !== -1 && countAt !== -1 && lockAt > countAt) p.push('the trigger counts BEFORE it locks — two simultaneous adds could both pass');
  if (!/if v_count >= v_max then raise exception 'brand_memory_full' using errcode = 'P0001'/i.test(fn)) p.push("the trigger does not raise 'brand_memory_full' (P0001) at the cap");
  if (!/drop trigger if exists brand_memory_enforce_cap_trg on public\.brand_memory; create trigger brand_memory_enforce_cap_trg before insert on public\.brand_memory for each row execute function public\.brand_memory_enforce_cap\(\);/i.test(s)) p.push('the cap trigger is not (re)created BEFORE INSERT, idempotently');
  if (!/notify pgrst, 'reload schema'/i.test(s)) p.push('no notify pgrst reload');
  return p;
}
const CAPS_JS = handler.CAPS, KIND_MAX_JS = handler.KIND_MAX;
{
  const sql = fs.readFileSync(path.join(ROOT, 'sql/brand-memory.sql'), 'utf8');
  const probs = sqlProblems(sql);
  ok(probs.length === 0, 'sql/brand-memory.sql: ' + probs.join('; '));
  // the opposite arm: the checker really rejects each broken variant
  for (const [label, broken] of [
    ['non-idempotent table', sql.replace(/create table if not exists/i, 'create table')],
    ['no RLS', sql.replace(/alter table public\.brand_memory enable row level security;/i, '')],
    ['no kind check', sql.replace(/check \(kind in \('story', 'belief', 'speech'\)\)/i, '')],
    ['a client insert policy', sql + '\ncreate policy "x" on public.brand_memory for insert with check (brand_id in (select user_brand_ids()));\n'],
    ['an old policy left in place', sql.replace(/drop policy if exists "brand_memory insert member" on public\.brand_memory;/i, '')],
    ['an unguarded constraint', sql.replace(/if not exists \(select 1 from pg_constraint/i, 'if true or exists (select 1 from pg_constraint')],
    ['deleting over-length rows', sql.replace(/raise notice 'brand_memory:[^;]*;/i, "delete from public.brand_memory where char_length(text) > 800;")],
    ['a length cap that differs', sql.replace(/when 'belief' then 140\b/gi, "when 'belief' then 1400")],
    ['a count cap that differs', sql.replace(/when 'belief' then 50/i, "when 'belief' then 500")],
    ['count before lock', sql.replace(/(\s*perform pg_advisory_xact_lock\([^;]*;)(\s*select count\(\*\)[^;]*;)/i, '$2$1')],
    ['no lock', sql.replace(/\s*perform pg_advisory_xact_lock\([^;]*;/i, '')],
    ['an AFTER trigger', sql.replace(/before insert on public\.brand_memory/i, 'after insert on public.brand_memory')],
  ]) {
    ok(broken !== sql && sqlProblems(broken).length > 0, 'self-test: the SQL checker rejects ' + label);
  }
}

if (failed) { console.error(`rv2-memory-1: ${failed} failed, ${passed} passed`); process.exit(1); }
console.log(`rv2-memory-1: ${passed} checks passed`);
console.log('BRAND MEMORY OK');
