#!/usr/bin/env node
// GATE: content-v3 F1 — the daily question (api/_questions.js, api/daily-question.js, api/send-daily.js).
//
// WHY THIS EXISTS
//   The app interviews the founder with one short question a day, and the morning push carries the
//   same question. Ways this goes wrong silently:
//     * the pick is not stable within a day, repeats an answered question, or never rotates;
//     * the card and the push disagree about "today's question";
//     * a failed read reads as "nothing answered", or a write whose outcome is unknown reads as "not saved";
//     * the question read breaks, stalls or starves the idea push — the one push the product sends.
//
// HOW IT CHECKS — BY RUNNING THE REAL CODE
//   api/_questions.js, api/daily-question.js, api/send-daily.js, api/_publish/store.js and
//   api/_requireUser.js run unmodified. node's https.request is replaced by an in-memory fake
//   PostgREST (+ /auth/v1/user + the internal /api/generate-ideas call) that filters (including
//   meta->>source), orders, limits, enforces the story length CHECK and the story cap trigger (P0001),
//   and can be told to fail, reject, or go silent. web-push and _brandctx are stubbed. No network.
//
// RUN:    node scripts/verify/rv3-question-1.mjs
// EXPECT: prints "QUESTION OK" and exits 0.
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require_ = createRequire(path.join(ROOT, 'x.js'));
const wall = setTimeout(() => { console.error('FAIL: wall clock — rv3-question-1 did not finish in 90s'); process.exit(1); }, 90000);
wall.unref();

let failed = 0, passed = 0;
const ok = (c, m) => { if (c) passed++; else { console.error('FAIL: ' + m); failed++; } };

process.env.SUPABASE_URL = 'https://fake-postgrest.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'gate-fake-not-a-key';
process.env.CRON_SECRET = 'gate-cron-secret';
process.env.VAPID_PUBLIC_KEY = 'gate-vapid-pub';
process.env.VAPID_PRIVATE_KEY = 'gate-vapid-priv';
delete process.env.VERCEL_URL;

// ── fake backend ───────────────────────────────────────────────────────────────────────────────
const U = { owner: 'u0000000-0000-4000-8000-000000000001', member: 'u0000000-0000-4000-8000-000000000002',
            stranger: 'u0000000-0000-4000-8000-000000000003', other: 'u0000000-0000-4000-8000-000000000004' };
const TOK = { owner: 'tok-owner', member: 'tok-member', stranger: 'tok-stranger' };
const USERS = { [TOK.owner]: { id: U.owner }, [TOK.member]: { id: U.member }, [TOK.stranger]: { id: U.stranger } };
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';   // owner's brand; member belongs to it
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';   // someone else's brand
let DB, FAULT, DELAY, GEN, tick = 0;
const REQS = [];
function resetDb() {
  DB = {
    brands: [{ id: A, user_id: U.owner }, { id: B, user_id: U.other }],
    brand_members: [{ brand_id: A, user_id: U.member }],
    brand_memory: [], ideas: [], push_subscriptions: [], job_heartbeats: [],
  };
  FAULT = null; DELAY = null; GEN = null; REQS.length = 0;
}
const nextTs = () => new Date(Date.UTC(2026, 8, 1) + (++tick) * 1000).toISOString();
function parseQuery(q) {
  return (q || '').split('&').filter(Boolean).map(part => { const i = part.indexOf('=');
    return [decodeURIComponent(part.slice(0, i)), decodeURIComponent(part.slice(i + 1))]; });
}
function colOf(row, k) {
  if (k.includes('->>')) { const [c, f] = k.split('->>'); const o = row[c]; return o && typeof o === 'object' ? o[f] : undefined; }
  return row[k];
}
function matches(row, k, op) {
  const v = colOf(row, k);
  if (op.startsWith('eq.')) return v != null && String(v) === op.slice(3);
  if (op.startsWith('in.')) return op.slice(4, -1).split(',').includes(String(v));
  throw new Error('fake PostgREST: unsupported filter ' + k + '=' + op);
}
function servePg(method, p, headers, body) {
  const table = p.startsWith('/rest/v1/') ? p.slice(9).split('?')[0] : null;
  REQS.push({ method, table, path: decodeURIComponent(p) });
  const f = FAULT && FAULT(method, table, p);
  if (f) return f;
  if (p.startsWith('/auth/v1/user')) {
    const u = USERS[String(headers.Authorization || '').replace(/^Bearer /, '')];
    return u ? { status: 200, data: u } : { status: 401, data: { msg: 'invalid JWT' } };
  }
  if (!table || !(table in DB)) return { status: 404, data: { code: 'PGRST205', message: "Could not find the table 'public." + table + "'" } };
  let rows = DB[table], order = null, limit = null, select = null;
  for (const [k, v] of parseQuery(p.split('?')[1])) {
    if (k === 'order') order = v; else if (k === 'limit') limit = +v; else if (k === 'select') select = v;
    else if (k === 'on_conflict') continue; else rows = rows.filter(r => matches(r, k, v));
  }
  if (method === 'GET') {
    rows = rows.slice();
    if (order) {
      const keys = order.split(',').map(s => s.split('.'));
      rows.sort((a, b) => { for (const [c, d] of keys) { const x = String(a[c]), y = String(b[c]); if (x !== y) return (x < y ? -1 : 1) * (d === 'desc' ? -1 : 1); } return 0; });
    }
    if (limit != null) rows = rows.slice(0, limit);
    if (select && select !== '*') { const cols = select.split(','); rows = rows.map(r => Object.fromEntries(cols.filter(c => c in r).map(c => [c, r[c]]))); }
    return { status: 200, data: JSON.parse(JSON.stringify(rows)) };
  }
  if (method === 'POST') {
    const made = [];
    for (const r of [].concat(JSON.parse(body))) {
      const row = Object.assign({ id: randomUUID(), tags: [], meta: {}, created_at: nextTs() }, r);
      if (table === 'brand_memory') {
        const n = Array.from(String(row.text || '')).length;   // char_length
        if (row.kind === 'story' && (n < 1 || n > 600)) return { status: 400, data: { code: '23514', message: 'new row violates check constraint "brand_memory_text_len"' } };
        if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(String(row.text))) return { status: 400, data: { code: '22P05', message: 'lone surrogate' } };
        if (row.kind === 'story' && DB.brand_memory.filter(x => x.brand_id === row.brand_id && x.kind === 'story').length >= 200) {
          return { status: 400, data: { code: 'P0001', message: 'brand_memory_full', details: '200' } };
        }
      }
      made.push(row);
    }
    DB[table].push(...made);
    return /return=representation/.test(headers.Prefer || '') ? { status: 201, data: JSON.parse(JSON.stringify(made)) } : { status: 201, data: null };
  }
  if (method === 'PATCH') { const patch = JSON.parse(body); rows.forEach(r => Object.assign(r, patch)); return { status: 204, data: null }; }
  if (method === 'DELETE') { const kill = new Set(rows); DB[table] = DB[table].filter(r => !kill.has(r)); return { status: 204, data: null }; }
  return { status: 405, data: null };
}
const https = require_('https');
https.request = (opts, cb) => {
  const req = new EventEmitter();
  let body = '', tmo = null, done = false;
  const arm = (ms, fn) => { if (tmo) clearTimeout(tmo); tmo = setTimeout(fn, ms); };
  if (opts.timeout) arm(opts.timeout, () => req.emit('timeout'));
  req.write = c => { body += c; };
  req.setTimeout = (ms, fn) => arm(ms, fn);
  req.destroy = err => { if (done) return; done = true; if (tmo) clearTimeout(tmo); setImmediate(() => req.emit('error', err || new Error('destroyed'))); };
  req.end = () => setTimeout(() => {
    let out;
    try {
      if (opts.hostname === 'fake-postgrest.invalid') out = servePg(opts.method, opts.path, opts.headers || {}, body);
      else if (opts.path === '/api/generate-ideas') { REQS.push({ method: 'POST', table: 'GEN', path: opts.path }); out = { status: 200, data: GEN ? GEN(JSON.parse(body)) : { ideas: [] } }; }
      else out = { status: 404, data: null };
    } catch (e) { out = { status: 500, data: { message: String(e && e.message) } }; }
    if (out === 'hang' || done) return;
    done = true; if (tmo) clearTimeout(tmo);
    if (out === 'reject') return req.emit('error', new Error('ECONNRESET (fake)'));
    const resp = new EventEmitter(); resp.statusCode = out.status;
    cb(resp);
    if (out.raw != null) resp.emit('data', out.raw);
    else if (out.data != null) resp.emit('data', JSON.stringify(out.data));
    resp.emit('end');
  }, DELAY ? DELAY(opts.method, opts.path) || 0 : 0);
  return req;
};

// Credits must never be touched.
let usageTouched = false;
{
  const k = require_.resolve(path.join(ROOT, 'api/_usage.js'));
  const trap = new Proxy({}, { get(_, prop) { if (prop !== 'then' && typeof prop === 'string') usageTouched = true; return () => { throw new Error('credits touched'); }; } });
  require_.cache[k] = { id: k, filename: k, loaded: true, exports: trap };
}
// web-push and the brand hydrator are stubbed for send-daily.
const PUSHES = [];
{
  const k = require_.resolve('web-push');
  require_.cache[k] = { id: k, filename: k, loaded: true, exports: {
    setVapidDetails() {}, async sendNotification(sub, payload) { PUSHES.push({ endpoint: sub && sub.endpoint, payload: JSON.parse(payload) }); } } };
  const b = require_.resolve(path.join(ROOT, 'api/_brandctx.js'));
  require_.cache[b] = { id: b, filename: b, loaded: true, exports: { loadBrandContext: async () => ({ ok: true, bc: { brand_name: 'Acme' } }) } };
}

const Q = require_(path.join(ROOT, 'api/_questions.js'));
const handler = require_(path.join(ROOT, 'api/daily-question.js'));
const sendDaily = require_(path.join(ROOT, 'api/send-daily.js'));
const TODAY = new Date().toISOString().slice(0, 10);
const dayBefore = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

async function call(body, { token = TOK.owner, method = 'POST', origin = 'https://contentshrimp.com' } = {}) {
  const res = { code: 0, body: undefined, headers: {}, setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
  const headers = { origin };
  if (token) headers.authorization = 'Bearer ' + token;
  await handler({ method, headers, body }, res);
  return res;
}
const seedAnswer = (qid, date, created_at, text) => {
  const r = { id: randomUUID(), brand_id: A, kind: 'story', text: text || 'answer to ' + qid, tags: ['daily-question'],
    meta: { source: 'daily_question', questionId: qid, date }, created_by: U.owner, created_at };
  DB.brand_memory.push(r); return r;
};
const stories = () => DB.brand_memory.filter(r => r.brand_id === A && r.kind === 'story');

// ═══ 1. the bank ═══════════════════════════════════════════════════════════════════════════════
{
  const B_ = Q.QUESTIONS;
  ok(B_.length >= 40, 'the bank holds at least 40 questions (' + B_.length + ')');
  ok(new Set(B_.map(q => q.id)).size === B_.length, 'question ids are unique');
  ok(new Set(B_.map(q => q.text.toLowerCase())).size === B_.length, 'question texts are unique');
  ok(B_.every(q => /^[a-z0-9-]+$/.test(q.id)), 'ids are plain kebab-case (they are stored in meta)');
  ok(B_.every(q => q.text.length >= 15 && q.text.length <= 90 && q.text.endsWith('?')), 'every question is 15..90 chars and ends with "?" (longest ' + Math.max(...B_.map(q => q.text.length)) + ')');
  ok(B_.every(q => Q.KINDS.includes(q.kind)) && Q.KINDS.every(k => B_.some(q => q.kind === k)), 'every kind is valid and every kind is used');
  ok(B_.every(q => !/\b(doctor|diagnos|medical|medicine|health|illness|disease|lawyer|lawsuit|legal|sue|court|therapy|drug)/i.test(q.text)), 'no medical or legal topics');
  ok(B_.every(q => !/\b(don't you|wouldn't you|isn't it|aren't you)\b/i.test(q.text)), 'no leading questions');
  ok(B_.every(q => !/\[|\{|<|  /.test(q.text)), 'no template brackets or double spaces');
  ok(Object.isFrozen(B_) && Object.isFrozen(B_[0]), 'the bank is frozen');
}

// ═══ 2. pickQuestion ═══════════════════════════════════════════════════════════════════════════
{
  const p1 = Q.pickQuestion(A, '2026-09-27', []), p2 = Q.pickQuestion(A, '2026-09-27', []);
  ok(p1 && p1.id === p2.id, 'the pick is deterministic for a brand and a day');
  const days = Array.from({ length: 14 }, (_, i) => new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10));
  const ids = days.map(d => Q.pickQuestion(A, d, []).id);
  ok(new Set(ids).size >= 7, 'the pick changes across days (' + new Set(ids).size + ' different in 14 days)');
  ok(new Set(days.map(d => Q.pickQuestion(A, d, []).id + Q.pickQuestion(B, d, []).id)).size > 1 &&
     days.some(d => Q.pickQuestion(A, d, []).id !== Q.pickQuestion(B, d, []).id), 'two brands do not get the same sequence');
  const answered = ids.slice(0, 5);
  let skips = true;
  for (const d of days) if (answered.includes(Q.pickQuestion(A, d, answered).id)) skips = false;
  ok(skips, 'answered questions are skipped while any is unanswered');
  const allButOne = Q.QUESTIONS.slice(1).map(q => q.id);
  ok(days.every(d => Q.pickQuestion(A, d, allButOne).id === Q.QUESTIONS[0].id), 'with one left unanswered, that one always comes back');
  // all answered: newest first; the LAST distinct id is the least recently answered
  const all = [Q.QUESTIONS[0].id].concat(Q.QUESTIONS.slice(1).map(q => q.id));   // newest: Q0, oldest: last
  ok(Q.pickQuestion(A, '2026-09-27', all).id === Q.QUESTIONS[Q.QUESTIONS.length - 1].id, 'all answered -> the least recently answered comes back');
  const repeat = [Q.QUESTIONS[5].id].concat(all);                  // Q5 answered again most recently
  ok(Q.pickQuestion(A, '2026-09-28', repeat).id === Q.QUESTIONS[Q.QUESTIONS.length - 1].id && Q.QUESTIONS.length - 1 !== 5,
     'a repeat answer counts by its NEWEST answer');
  const allRev = all.slice().reverse();                            // now Q0 is the oldest
  ok(Q.pickQuestion(A, '2026-09-27', allRev).id === Q.QUESTIONS[0].id, 'and the fallback follows the order (reverse -> the other end)');
  ok(Q.pickQuestion(A, '2026-09-27', ['not-a-question']).id === Q.pickQuestion(A, '2026-09-27', []).id, 'unknown ids do not shift the pick');
}

// ═══ 3. endpoint: method, CORS, auth, access, input ════════════════════════════════════════════
resetDb();
{
  let r = await call({}, { method: 'OPTIONS' });
  ok(r.code === 200 && /POST/.test(r.headers['Access-Control-Allow-Methods'] || ''), 'OPTIONS preflight 200');
  ok(r.headers['Access-Control-Allow-Origin'] === 'https://contentshrimp.com', 'an allowed origin is echoed');
  r = await call({}, { method: 'OPTIONS', origin: 'https://evil.example' });
  ok(r.headers['Access-Control-Allow-Origin'] === 'https://contentshrimp.com', 'a foreign origin is not echoed');
  r = await call({ brandId: A, action: 'get' }, { method: 'GET' });
  ok(r.code === 405, 'GET -> 405');
  r = await call({ brandId: A, action: 'get' }, { token: null });
  ok(r.code === 401, 'no token -> 401, got ' + r.code);
  r = await call({ brandId: A, action: 'get' }, { token: 'tok-forged' });
  ok(r.code === 401, 'a rejected token -> 401');
  r = await call({ brandId: A, action: 'get' }, { token: TOK.stranger });
  ok(r.code === 403 && r.body.code === 'forbidden' && !('question' in r.body), 'no access -> 403 and no question, got ' + r.code);
  r = await call({ brandId: A, action: 'answer', questionId: Q.QUESTIONS[0].id, text: 'sneaky' }, { token: TOK.stranger });
  ok(r.code === 403 && stories().length === 0, 'no access -> cannot answer (403, nothing stored)');
  r = await call({ brandId: A, action: 'get' }, { token: TOK.member });
  ok(r.code === 200 && r.body.question, 'a brand member gets the question');
  FAULT = (m, t) => (t === 'brands' ? { status: 500, data: { message: 'boom' } } : null);
  r = await call({ brandId: A, action: 'get' });
  ok(r.code === 503 && r.body.code === 'access_check_failed', 'an access check that could not run is 503 access_check_failed');
  FAULT = null;
  for (const [b, want, code] of [[{ brandId: 'nope', action: 'get' }, 'bad brandId', 'bad_input'], [{ brandId: A, action: 'nuke' }, 'bad action', 'bad_input'],
      [{ brandId: A, action: 'answer', questionId: 'made-up', text: 'x' }, 'unknown questionId', 'bad_input'],
      [{ brandId: A, action: 'answer', questionId: Q.QUESTIONS[0].id, text: 42 }, 'non-string text', 'bad_input'],
      [{ brandId: A, action: 'answer', questionId: Q.QUESTIONS[0].id, text: '' }, 'empty text', 'empty'],
      [{ brandId: A, action: 'answer', questionId: Q.QUESTIONS[0].id, text: '  \n ' }, 'whitespace text', 'empty']]) {
    r = await call(b);
    ok(r.code === 400 && r.body.code === code, want + ' -> 400 ' + code + ', got ' + r.code + ' ' + (r.body && r.body.code));
  }
  ok(stories().length === 0, 'no bad input stored anything');
}

// ═══ 4. get + answer ═══════════════════════════════════════════════════════════════════════════
resetDb();
{
  let r = await call({ brandId: A, action: 'get' });
  const want = Q.pickQuestion(A, TODAY, []);
  ok(r.code === 200 && r.body.question && r.body.question.id === want.id && r.body.question.text === want.text && r.body.question.kind === want.kind,
     'get -> 200 {question:{id,text,kind}} = pickQuestion(brand, today, [])');
  ok(r.body.date === TODAY && r.body.answeredToday === false, 'get carries date (UTC today) and answeredToday:false');
  ok(Object.keys(r.body).sort().join() === 'answeredToday,date,question' && Object.keys(r.body.question).sort().join() === 'id,kind,text', 'get shape is exact');
  const read = REQS.find(x => x.table === 'brand_memory' && x.method === 'GET');
  ok(read && /kind=eq\.story/.test(read.path) && /meta->>source=eq\.daily_question/.test(read.path) && /brand_id=eq\./.test(read.path) && /limit=200/.test(read.path),
     'the answered list is read by brand, kind story, meta->>source daily_question, newest 200');
  const r2 = await call({ brandId: A, action: 'get' });
  ok(r2.body.question.id === want.id, 'a second get the same day gives the same question');

  const before = REQS.length;
  r = await call({ brandId: A, action: 'answer', questionId: want.id, text: '  A customer asked if we ship to Mars.\nWe do not.  ' });
  ok(r.code === 200 && r.body.ok === true && typeof r.body.storyId === 'string' && r.body.date === TODAY && !r.body.clipped, 'answer -> 200 {ok, storyId, date}');
  const row = stories()[0];
  ok(row && row.id === r.body.storyId, 'the storyId is the saved row');
  ok(row && row.brand_id === A && row.kind === 'story' && row.text === 'A customer asked if we ship to Mars.\nWe do not.' &&
     JSON.stringify(row.tags) === '["daily-question"]' && row.created_by === U.owner,
     'row shape: brand_id, kind story, trimmed text, tags [daily-question], created_by = caller');
  ok(row && row.meta && row.meta.source === 'daily_question' && row.meta.questionId === want.id && row.meta.date === TODAY && Object.keys(row.meta).length === 3,
     'row meta = {source:daily_question, questionId, date}');
  ok(!REQS.slice(before).some(x => x.table === 'GEN'), 'no AI call was made');

  r = await call({ brandId: A, action: 'get' });
  ok(r.body.answeredToday === true && r.body.question.id === want.id, 'after answering, get says answeredToday and still shows the answered question');
  r = await call({ brandId: A, action: 'answer', questionId: want.id, text: 'A customer asked if we ship to Mars.\nWe do not.' });
  ok(r.code === 200 && r.body.duplicate === true && r.body.storyId === row.id && stories().length === 1, 'retrying the same answer the same day does not store a second copy');
  r = await call({ brandId: A, action: 'answer', questionId: want.id, text: 'And one more thing.' }, { token: TOK.member });
  ok(r.code === 200 && !r.body.duplicate && stories().length === 2 && stories()[1].created_by === U.member, 'a different answer is a new story (created_by = the member)');

  // tomorrow the answered question is skipped
  resetDb();
  seedAnswer(want.id, dayBefore(1), nextTs());
  r = await call({ brandId: A, action: 'get' });
  ok(r.body.answeredToday === false && r.body.question.id !== want.id && r.body.question.id === Q.pickQuestion(A, TODAY, [want.id]).id,
     "yesterday's answer does not count as today, and that question is skipped");
  // only one unanswered left
  resetDb();
  Q.QUESTIONS.slice(1).forEach(q => seedAnswer(q.id, dayBefore(2), nextTs()));
  r = await call({ brandId: A, action: 'get' });
  ok(r.body.question.id === Q.QUESTIONS[0].id, 'the one unanswered question is the one asked');
  // everything answered -> least recently answered
  resetDb();
  Q.QUESTIONS.forEach(q => seedAnswer(q.id, dayBefore(3), nextTs()));   // QUESTIONS[0] is the OLDEST
  r = await call({ brandId: A, action: 'get' });
  ok(r.body.question.id === Q.QUESTIONS[0].id && r.body.answeredToday === false, 'all answered -> the least recently answered comes back');
  ok(usageTouched === false, 'credits were never touched');
}

// ═══ 5. clip, DB check, cap, unknown outcome, not ready, read failure ═══════════════════════════
resetDb();
{
  const qid = Q.QUESTIONS[3].id;
  const long = Array.from({ length: 150 }, (_, i) => 'word' + i).join(' ');   // ~1,000 chars
  let r = await call({ brandId: A, action: 'answer', questionId: qid, text: long });
  const s = stories()[0];
  ok(r.code === 200 && r.body.clipped === true && s && Array.from(s.text).length <= 600 && s.text.length > 400 && long.startsWith(s.text) && long[s.text.length] === ' ',
     'a long answer is clipped to <=600 at a word boundary and says so');
  resetDb();
  const emoji = '\u{1F990}'.repeat(601);
  r = await call({ brandId: A, action: 'answer', questionId: qid, text: emoji });
  ok(r.code === 200 && r.body.clipped === true && Array.from(stories()[0].text).length === 600, '601 emoji are clipped to 600 characters, never half an emoji');
  r = await call({ brandId: A, action: 'answer', questionId: qid, text: 'x'.repeat(600) });
  ok(r.code === 200 && !r.body.clipped, 'exactly 600 characters is stored whole');

  resetDb();
  for (let i = 0; i < 200; i++) DB.brand_memory.push({ id: randomUUID(), brand_id: A, kind: 'story', text: 's' + i, tags: [], meta: {}, created_by: U.owner, created_at: nextTs() });
  r = await call({ brandId: A, action: 'answer', questionId: qid, text: 'full bank' });
  ok(r.code === 409 && r.body.code === 'memory_full' && r.body.max === 200 && stories().length === 200, 'story bank full (P0001 brand_memory_full) -> 409 memory_full, nothing saved');

  resetDb();
  FAULT = (m, t) => (m === 'POST' && t === 'brand_memory' ? { status: 502, raw: '<html>Bad gateway</html>' } : null);
  r = await call({ brandId: A, action: 'answer', questionId: qid, text: 'maybe saved' });
  ok(r.code === 503 && r.body.code === 'memory_write_unknown', 'a gateway 502 on the insert -> 503 memory_write_unknown, got ' + r.code + ' ' + (r.body && r.body.code));
  FAULT = (m, t) => (m === 'POST' && t === 'brand_memory' ? 'reject' : null);
  r = await call({ brandId: A, action: 'answer', questionId: qid, text: 'maybe saved' });
  ok(r.code === 503 && r.body.code === 'memory_write_unknown', 'a dropped connection on the insert -> 503 memory_write_unknown');
  FAULT = (m, t) => (m === 'POST' && t === 'brand_memory' ? { status: 400, data: { code: '22P02', message: 'bad' } } : null);
  r = await call({ brandId: A, action: 'answer', questionId: qid, text: 'refused' });
  ok(r.code === 503 && r.body.code === 'memory_write_failed', 'a real PostgREST refusal -> 503 memory_write_failed (known: not saved)');
  FAULT = (m, t) => (m === 'POST' && t === 'brand_memory' ? { status: 400, data: { code: '23514', message: 'check' } } : null);
  r = await call({ brandId: A, action: 'answer', questionId: qid, text: 'too long per DB' });
  ok(r.code === 400 && r.body.code === 'too_long', 'the DB length CHECK (23514) -> 400 too_long');
  FAULT = null;

  resetDb();
  delete DB.brand_memory;
  r = await call({ brandId: A, action: 'get' });
  ok(r.code === 503 && r.body.code === 'memory_not_ready' && !('question' in r.body), 'no brand_memory table -> get 503 memory_not_ready');
  r = await call({ brandId: A, action: 'answer', questionId: qid, text: 'x' });
  ok(r.code === 503 && r.body.code === 'memory_not_ready', 'no brand_memory table -> answer 503 memory_not_ready');
  resetDb();
  FAULT = (m, t) => (m === 'GET' && t === 'brand_memory' ? { status: 500, data: { message: 'boom' } } : null);
  r = await call({ brandId: A, action: 'get' });
  ok(r.code === 503 && r.body.code === 'memory_read_failed' && !('question' in r.body), 'a failed answered-list read is 503, never a question picked from "nothing answered"');
  r = await call({ brandId: A, action: 'answer', questionId: qid, text: 'x' });
  ok(r.code === 503 && r.body.code === 'memory_read_failed' && stories().length === 0, 'answer with an unreadable list -> 503, nothing saved');
  FAULT = null;
}

// ═══ 6. deadline ═══════════════════════════════════════════════════════════════════════════════
resetDb();
{
  const T = handler.TIMING, save = { ...T };
  const st = fs.readFileSync(path.join(ROOT, 'api/_publish/store.js'), 'utf8');
  const reqMs = Number((st.match(/let REQ_TIMEOUT_MS = (\d+);/) || [])[1]);
  const MAXD = 30000;
  ok(reqMs > 0 && T.minCallMs >= reqMs + 1000, 'minCallMs (' + T.minCallMs + ') leaves store.js\'s ' + reqMs + 'ms timeout + 1s');
  ok((T.deadlineMs - 2 * T.minCallMs) + 2 * reqMs <= MAXD, 'the access check (two calls) always ends inside maxDuration 30s');
  ok((T.deadlineMs - T.minCallMs) + reqMs <= MAXD, 'the last single call always ends inside maxDuration 30s');
  const src = fs.readFileSync(path.join(ROOT, 'api/daily-question.js'), 'utf8');
  ok(/if \(tooLate\(2\)\) return timedOut/.test(src), 'the access check requires room for two calls');

  Object.assign(T, { deadlineMs: 400, minCallMs: 150 });
  DELAY = (m, p) => (p.startsWith('/auth/v1/user') ? 200 : 0);
  let r = await call({ brandId: A, action: 'answer', questionId: Q.QUESTIONS[0].id, text: 'late' });
  ok(r.code === 503 && r.body.code === 'timeout' && !REQS.some(x => x.table === 'brands') && stories().length === 0,
     'too little time left for the access check -> 503 timeout, the check is not even started');
  REQS.length = 0;
  DELAY = (m, p) => (p.startsWith('/rest/v1/brands') ? 300 : 0);
  r = await call({ brandId: A, action: 'answer', questionId: Q.QUESTIONS[0].id, text: 'late' });
  ok(r.code === 503 && r.body.code === 'timeout' && !REQS.some(x => x.method === 'POST') && stories().length === 0,
     'a slow access check leaves no room for the insert -> 503 timeout, nothing sent');
  REQS.length = 0;
  DELAY = null;
  Object.assign(T, save);
  r = await call({ brandId: A, action: 'get' });
  ok(r.code === 200, 'with production timing and a healthy DB the request completes');
}

// ═══ 7. send-daily carries the question ════════════════════════════════════════════════════════
async function runDaily() {
  const res = { code: 0, body: undefined, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
  PUSHES.length = 0;
  await sendDaily({ method: 'GET', headers: { authorization: 'Bearer ' + process.env.CRON_SECRET } }, res);
  return res;
}
function seedSub(brandId, opts = {}) {
  const hour = new Date().getUTCHours();
  DB.push_subscriptions.push({ id: 'sub-' + DB.push_subscriptions.length, user_id: opts.user || U.owner, brand_id: brandId,
    subscription: { endpoint: 'https://push.example/' + DB.push_subscriptions.length }, send_hour: hour, tz_offset_min: 0,
    last_sent_at: null, motivation_on: true, tz_name: null });
}
const activeIdeas = () => { DB.ideas.push({ brand_id: A, created_at: new Date().toISOString(), status: 'done' }); };
const IDEA = { title: 'Why we never discount', hook: 'Discounts train people to wait.' };
const ideaBody = (i) => `${i.title} — "${(i.hook || '').slice(0, 90)}"`;
{
  resetDb(); seedSub(A); activeIdeas(); GEN = () => ({ ideas: [IDEA] });
  const want = Q.questionFor(A, TODAY, []).question;
  let r = await runDaily();
  const p = PUSHES[0] && PUSHES[0].payload;
  ok(r.code === 200 && r.body.sent === 1 && PUSHES.length === 1, 'the idea push is sent (sent 1)');
  ok(p && p.title === "Today's post is ready" && p.body === ideaBody(IDEA) + "\nToday's question: " + want.text,
     'the push body = the idea line + "Today\'s question: <text>": ' + JSON.stringify(p && p.body));
  ok(p && p.question && p.question.id === want.id && p.question.text === want.text && Object.keys(p.question).length === 2, 'the payload carries question {id, text}');
  ok(p && p.url === '/app.html?q=1', 'the click URL adds q=1: ' + (p && p.url));
  const ep = await call({ brandId: A, action: 'get' });
  ok(ep.body.question.id === p.question.id, 'the push question is the same question the app card shows today');
  ok(JSON.stringify(p).length < 3000, 'the payload stays far under the ~4KB web-push limit');

  // a very long idea is cut FIRST; the question line survives whole
  resetDb(); seedSub(A); activeIdeas();
  const LONG = { title: 'T'.repeat(200), hook: 'H'.repeat(120) };
  GEN = () => ({ ideas: [LONG] });
  await runDaily();
  const lp = PUSHES[0] && PUSHES[0].payload;
  ok(lp && lp.body.length <= 240 && lp.body.endsWith("\nToday's question: " + want.text) && lp.body.split('\n')[0].endsWith('…'),
     'a long idea is shortened first (body ' + (lp && lp.body.length) + ' <= 240) and the question line is whole');

  // the question read fails in three ways -> the idea push still goes out, unchanged
  for (const [label, fault] of [['a 500', { status: 500, data: { message: 'boom' } }], ['a dropped connection', 'reject'], ['a missing table', { status: 404, data: { code: 'PGRST205' } }]]) {
    resetDb(); seedSub(A); activeIdeas(); GEN = () => ({ ideas: [IDEA] });
    FAULT = (m, t) => (t === 'brand_memory' ? fault : null);
    r = await runDaily();
    const fp = PUSHES[0] && PUSHES[0].payload;
    ok(r.body.sent === 1 && r.body.failed === 0 && fp && fp.body === ideaBody(IDEA) && fp.url === '/app.html' && !('question' in fp),
       label + ' on the question read -> the idea push is sent exactly as before, without the question');
    ok(DB.job_heartbeats.length === 1 && DB.job_heartbeats[0].last_status === 'ok', label + ' -> the run heartbeat is still ok');
    FAULT = null;
  }
  // the question read stalls -> capped, then the push goes out
  resetDb(); seedSub(A); activeIdeas(); GEN = () => ({ ideas: [IDEA] });
  FAULT = (m, t) => (t === 'brand_memory' ? 'hang' : null);
  const t0 = Date.now();
  r = await runDaily();
  const took = Date.now() - t0;
  ok(r.body.sent === 1 && PUSHES[0] && !('question' in PUSHES[0].payload) && took < 8000,
     'a stalled question read is cut off (' + took + 'ms) and the idea push still goes out');
  FAULT = null;

  // answered today -> no question
  resetDb(); seedSub(A); activeIdeas(); GEN = () => ({ ideas: [IDEA] });
  seedAnswer(want.id, TODAY, nextTs());
  await runDaily();
  ok(PUSHES[0] && !('question' in PUSHES[0].payload) && PUSHES[0].payload.url === '/app.html', 'already answered today -> the push carries no question');

  // the quiet-founder nudge carries the question too
  resetDb(); seedSub(A); DB.ideas.push({ brand_id: A, created_at: new Date(Date.now() - 10 * 86400000).toISOString(), status: 'done' });
  await runDaily();
  const mp = PUSHES[0] && PUSHES[0].payload;
  ok(mp && mp.question && mp.question.id === want.id && mp.body.endsWith("\nToday's question: " + want.text) && mp.url === '/app.html?q=1' &&
     !REQS.some(x => x.table === 'GEN'), 'the motivational push carries the question too (no generation)');

  // a brand that is not theirs -> no question read at all
  resetDb(); seedSub(B, { user: U.owner }); GEN = () => ({ ideas: [IDEA] });
  await runDaily();
  ok(!REQS.some(x => x.table === 'brand_memory') && !(PUSHES[0] && PUSHES[0].payload.question), "a subscription naming someone else's brand never reads that brand's answers");
  // no brand -> no question
  resetDb(); seedSub(null); GEN = () => ({ ideas: [IDEA] });
  await runDaily();
  ok(PUSHES.length === 1 && !('question' in PUSHES[0].payload) && !REQS.some(x => x.table === 'brand_memory'), 'a subscription with no brand gets its push without a question');
}

// ═══ 8. send-daily budget math still holds ═════════════════════════════════════════════════════
{
  const sd = fs.readFileSync(path.join(ROOT, 'api/send-daily.js'), 'utf8');
  const num = (n) => Number(((sd.match(new RegExp('const ' + n + '\\s*=\\s*(\\d+)')) || [])[1]));
  const RUN = num('RUN_BUDGET_MS'), MIN = num('MIN_SLICE_MS'), DB_ = num('DB_TIMEOUT_MS'), PUSH = num('PUSH_TIMEOUT_MS'), QT = num('QUESTION_TIMEOUT_MS');
  const budget = Number((sd.match(/setRequestBudget\((\d+)\)/) || [])[1]);
  const worst = budget * 2 + DB_ + QT + DB_ + 10000 + PUSH + DB_;
  ok(QT > 0 && QT <= 10000, 'the question read has its own small cap (' + QT + 'ms)');
  ok(MIN >= worst, 'MIN_SLICE_MS (' + MIN + ') covers the worst case including the question read (' + worst + 'ms)');
  ok(RUN <= 300000 && RUN - MIN > 0, 'RUN_BUDGET_MS stays inside maxDuration 300s with room to start subscribers');
  const m = sd.match(/worst case is now ([\d +]+)= (\d+)s/);
  const terms = m ? m[1].split('+').map(s => Number(s.trim())) : [];
  ok(m && terms.reduce((a, b) => a + b, 0) === Number(m[2]) && Number(m[2]) * 1000 === worst && Number(m[2]) * 1000 <= MIN,
     'the comment\'s worst-case sum is arithmetically true and matches the constants (' + (m ? m[0] : 'missing') + ')');
  const qAt = sd.indexOf('await todaysQuestion('), genAt = sd.indexOf('const genMs = ');
  ok(qAt > 0 && qAt < genAt, 'the question is read BEFORE genMs is measured, so its time comes out of this slice');
  ok(/todaysQuestion\(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, brandId, nowUtc\)/.test(sd) && /const question = brandId\s*\n?\s*\?/.test(sd),
     'the question uses the VERIFIED brandId, never sub.brand_id');
}

console.log(passed + ' checks passed, ' + failed + ' failed');
if (failed) { console.error('rv3-question-1: FAILED'); process.exit(1); }
console.log('QUESTION OK');
process.exit(0);
