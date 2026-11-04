#!/usr/bin/env node
// GATE v710 — /api/health must see the AI writer's REAL state, and may not score unknown as green.
//
// WHY: live 2026-11-03 the xAI key was DISABLED (403 "key is disabled"): every writer was down while
// /api/health was green, because it only checked that XAI_API_KEY exists (deep-audit G #1). And when
// job_heartbeats could not be read, every cron check passed (G #11).
// NOW:
//   • api/_llm.js upserts job_heartbeats 'ai-writer:<provider>' — 'error' + a SAFE detail on an account
//     error (401/402/403, or 429 about credits/quota/billing), never touching last_success_at; 'ok' +
//     last_success_at on success, throttled to once per 30 min per instance. Fire-and-forget: a slow or
//     broken database can never slow or break the call.
//   • api/health.js: check ai_writer_ok FAILS when a provider's newest row is an error newer than its last
//     success (missing row = not observed = pass); every cron check FAILS on last_status 'error'; an
//     unreadable job_heartbeats FAILS every cron check (and ai_writer_ok) instead of passing.
// HOW: runs the REAL handler and the REAL api/_llm.js; Supabase (store), metering and route probes are
// stubbed, the providers are a scripted node:https. No network, no AI calls.
// RUN: node scripts/verify/health-v710.mjs   EXPECT: "PASS" and exit 0.
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require_ = createRequire(import.meta.url);
const Module = require_('module');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = path.join(ROOT, 'api');
const WALL = setTimeout(() => { console.log('FAIL: health-v710 wall clock (60s) — something hung'); process.exit(1); }, 60000);
let failed = 0, passed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('ok: ' + m); } else { failed++; console.log('FAIL: ' + m); } };
const quiet = async (fn) => { const q = console.error, w = console.warn, l = console.log; console.error = console.warn = console.log = () => {}; try { return await fn(); } finally { console.error = q; console.warn = w; console.log = l; } };

const FAKE_XAI = 'xai-GATEONLYnotarealkey0123456789abcdefBW3B';
const FAKE_ANT = 'sk-ant-GATEONLYnotarealkey0123456789abcdef';
process.env.SUPABASE_URL = 'https://health-v710.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only-not-a-real-key';
process.env.APP_BASE_URL = 'https://health-v710.invalid';
process.env.XAI_API_KEY = FAKE_XAI;
process.env.ANTHROPIC_API_KEY = FAKE_ANT;
// Presence-only config checks (fake values, so the baseline is all green and only what we vary fails).
for (const k of ['GROQ_API_KEY', 'OPENAI_API_KEY', 'CRON_SECRET', 'PEXELS_API_KEY', 'SERPAPI_KEY', 'APIFY_API_TOKEN', 'STRIPE_PRICE_PRO', 'STRIPE_PRICE_AGENCY']) process.env[k] = 'gate-only';
function stub(rel, exports) {
  const file = require_.resolve(path.join(API, rel));
  const m = new Module(file); m.filename = file; m.loaded = true; m.exports = exports; require_.cache[file] = m;
}

// ── fake Supabase: health reads + the writer's upserts ──
const AUDIT = { rls_disabled: [], permissive_policies: [], permissive_write_policies: [], unbound_brand_tables: [],
  zero_policy_tables: [], has_user_brand_ids: true, user_brand_ids_secure: true };
const sb = { hb: { status: 200, data: [] }, posts: [], mode: 'ok' };
function rest(method, p, o) {
  if (p.startsWith('/job_heartbeats') && method === 'POST') {
    if (sb.mode === 'hang') return new Promise(() => {});
    if (sb.mode === 'throw') throw new Error('store exploded');
    if (sb.mode === 'reject') return Promise.reject(new Error('store rejected'));
    sb.posts.push({ path: p, body: JSON.parse(JSON.stringify((o || {}).body)), prefer: ((o || {}).headers || {}).Prefer });
    return Promise.resolve({ status: 201, data: null });
  }
  if (p.startsWith('/job_heartbeats')) return Promise.resolve(sb.hb);
  if (p.startsWith('/rpc/security_health')) return Promise.resolve({ status: 200, data: AUDIT });
  if (p.startsWith('/brands')) return Promise.resolve({ status: 200, data: [{ id: 'b1' }] });
  return Promise.resolve({ status: 200, data: [] });
}
stub('_publish/store.js', { rest, heartbeat: async () => null, setRequestBudget() {}, getUser: async () => null, userCanAccessBrand: async () => false });
stub('_usage.js', { COST_CAP_EUR: 25, guard: async () => ({ user: { id: 'u1' }, over: false, billingUserId: 'u1' }), logUsage: async () => {} });
globalThis.fetch = async () => ({ status: 200 });

// ── scripted providers (node:https) ──
const https = require_('node:https');
let provider = () => ({ status: 500, body: '{}' });
const sentHeaders = [];
https.request = (opts, cb) => {
  const req = new EventEmitter();
  req.write = () => {}; req.setTimeout = () => {}; req.destroy = () => {};
  req.end = () => setImmediate(() => {
    sentHeaders.push(opts.headers || {});
    const a = provider(opts.hostname, opts.path);
    const resp = new EventEmitter();
    resp.statusCode = a.status; resp.headers = a.headers || { 'content-type': 'application/json' }; resp.complete = true;
    cb(resp);
    resp.emit('data', Buffer.from(a.body || ''));
    resp.emit('end'); resp.emit('close');
  });
  return req;
};

const L = require_(path.join(API, '_llm.js'));
const HEALTH = require_(path.join(API, 'health.js'));
const flush = () => new Promise(r => setImmediate(r));
async function health(rows, opts) {
  sb.hb = (opts && 'hb' in opts) ? opts.hb : { status: 200, data: rows };
  const res = { _code: 0, _body: null, setHeader() {}, status(c) { this._code = c; return this; }, json(b) { this._body = b; return this; }, end() { return this; } };
  await quiet(() => HEALTH({ method: 'GET', query: {}, headers: {} }, res));
  return res;
}
const chk = (b, n) => b.checks.find(c => c.name === n);
const nowIso = (dMs) => new Date(Date.now() + (dMs || 0)).toISOString();
const CRONS = ['send-daily', 'pull-trends-cron', 'fact-pack-cron'];
const freshCrons = () => CRONS.map(job => ({ job, last_success_at: nowIso(-60000), last_status: 'ok', detail: {} }));
const OLD_NAMES = ['config_supabase', 'config_llm_key', 'config_xai_key', 'config_groq_key', 'config_openai_key', 'config_cron_secret', 'config_cost_cap',
  'config_pexels_key', 'config_serpapi_key', 'config_apify_token', 'config_stripe_prices', 'rls_all_tables_enabled', 'isolation_audit_reachable', 'db_reachable',
  'cron_send-daily_fresh', 'cron_pull-trends-cron_fresh', 'cron_fact-pack-cron_fresh', 'open_app_routes_ok', 'onboarding_routes_ok'];
const chatOk = { status: 200, body: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: {} }) };
const DISABLED = { code: 'permission-denied', error: 'The API key ' + FAKE_XAI.slice(0, 4) + '...bw3B is disabled. Ask the owner at https://console.x.ai/team/0f8e2a1c-1234-4abc-9def-1234567890ab/api-keys for a new one ' + FAKE_XAI };
const llm = (extra) => quiet(() => L.callLLM(Object.assign({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 5, deadlineMs: 1500, timeoutMs: 1000 }, extra || {})).then(t => ({ t }), e => ({ e })));

// ═════ A. _llm.js writes the writer's state ═════
L._resetWriterHealth(); sb.posts = []; sb.mode = 'ok';
provider = () => ({ status: 403, body: JSON.stringify(DISABLED) });
let out = await llm(); await flush();
ok(out.e && out.e.code === 'AI_UNAVAILABLE', 'A1: a disabled key still surfaces as AI_UNAVAILABLE to the caller');
let p = sb.posts.filter(x => x.body.job === 'ai-writer:grok');
ok(p.length === 1 && p[0].body.last_status === 'error' && p[0].path === '/job_heartbeats' && /merge-duplicates/.test(String(p[0].prefer)), 'A2: one job_heartbeats upsert ai-writer:grok, last_status error');
const errRow = p[0] && p[0].body;
ok(errRow && !('last_success_at' in errRow), 'A3: the error upsert does NOT send last_success_at (keeps the last real success)');
const d = (errRow && errRow.detail) || {};
ok(d.provider === 'grok' && d.http === 403 && typeof d.errorAt === 'string', 'A4: detail names provider, HTTP status and when (' + JSON.stringify({ provider: d.provider, http: d.http }) + ')');
const dumped = JSON.stringify(errRow || {});
ok(typeof d.message === 'string' && d.message.length > 0 && d.message.length <= 120 && /disabled/i.test(d.message), 'A5: detail.message is the provider\'s words, at most 120 chars: ' + JSON.stringify(d.message));
ok(dumped.indexOf(FAKE_XAI) === -1 && !/xai-/i.test(dumped) && !/bw3B/i.test(dumped) && !/https?:/i.test(dumped) && !/0f8e2a1c/.test(dumped) && !/Bearer|Authorization/i.test(dumped),
  'A6: no key, key suffix, link, team id or header in what is stored: ' + dumped);
// recovery shows at once, then success is throttled
provider = () => chatOk;
out = await llm(); await flush();
p = sb.posts.filter(x => x.body.job === 'ai-writer:grok');
ok(out.t === 'ok' && p.length === 2 && p[1].body.last_status === 'ok' && typeof p[1].body.last_success_at === 'string', 'A7: the first success after an error writes ok + last_success_at at once');
out = await llm(); await flush();
ok(sb.posts.filter(x => x.body.job === 'ai-writer:grok').length === 2, 'A8: another success right away writes nothing (throttled)');
const realNow = Date.now;
Date.now = () => realNow() + L.WRITER_OK_EVERY_MS + 1000;
try { out = await llm(); await flush(); } finally { Date.now = realNow; }
ok(sb.posts.filter(x => x.body.job === 'ai-writer:grok').length === 3, 'A9: a success 30+ min later writes ok again');
ok(L.WRITER_OK_EVERY_MS === 30 * 60 * 1000, 'A9b: the ok throttle is 30 minutes');
// 429: credits → error; a plain rate limit → nothing
L._resetWriterHealth(); sb.posts = [];
provider = () => ({ status: 429, body: JSON.stringify({ error: 'Too many requests, slow down.' }) });
await llm(); await flush();
ok(sb.posts.length === 0, 'A10: a plain 429 rate limit is not an account error (nothing written)');
provider = () => ({ status: 429, body: JSON.stringify({ error: 'Your team has used all available credits or reached its monthly spending limit.' }) });
await llm(); await flush();
ok(sb.posts.length === 1 && sb.posts[0].body.last_status === 'error' && sb.posts[0].body.detail.http === 429, 'A11: a 429 about credits/spending limit IS an account error');
// a transient 500 is not an account error
L._resetWriterHealth(); sb.posts = [];
provider = () => ({ status: 503, body: '{"error":"overloaded"}' });
await llm(); await flush();
ok(sb.posts.length === 0, 'A12: a 5xx outage is not recorded as an account error');
// Claude
L._resetWriterHealth(); sb.posts = [];
provider = (host) => (host === 'api.anthropic.com' ? { status: 401, body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key ' + FAKE_ANT } }) } : chatOk);
out = await llm({ provider: 'claude' }); await flush();
ok(out.e && sb.posts.length === 1 && sb.posts[0].body.job === 'ai-writer:claude' && sb.posts[0].body.detail.http === 401 && JSON.stringify(sb.posts[0].body).indexOf(FAKE_ANT) === -1 && !/sk-ant/.test(JSON.stringify(sb.posts[0].body)),
  'A13: a refused Claude key writes ai-writer:claude error, key redacted');
// Grok web search (the cron lane) uses the same key
L._resetWriterHealth(); sb.posts = [];
provider = () => ({ status: 403, body: JSON.stringify(DISABLED) });
const s = await quiet(() => L.callGrokSearch('find facts', { timeoutMs: 6000 }));
await flush();
ok(s === null && sb.posts.length === 1 && sb.posts[0].body.job === 'ai-writer:grok' && sb.posts[0].body.last_status === 'error', 'A14: a refused web search writes ai-writer:grok error');
// fire-and-forget: a hanging / throwing / rejecting store never delays or breaks the call
for (const mode of ['hang', 'throw', 'reject']) {
  L._resetWriterHealth(); sb.mode = mode;
  provider = () => chatOk;
  const t0 = Date.now();
  out = await llm(); await flush();
  ok(out.t === 'ok' && Date.now() - t0 < 1000, 'A15 (' + mode + '): the call still returns its text at once (' + (Date.now() - t0) + 'ms)');
  provider = () => ({ status: 403, body: JSON.stringify(DISABLED) });
  out = await llm(); await flush();
  ok(out.e && out.e.code === 'AI_UNAVAILABLE', 'A16 (' + mode + '): a refused call still throws AI_UNAVAILABLE, not the store\'s error');
}
sb.mode = 'ok';
// no Supabase configured → no write, no crash
L._resetWriterHealth(); sb.posts = [];
const hadUrl = process.env.SUPABASE_URL; delete process.env.SUPABASE_URL;
provider = () => ({ status: 403, body: JSON.stringify(DISABLED) });
out = await llm(); await flush();
process.env.SUPABASE_URL = hadUrl;
ok(out.e && sb.posts.length === 0, 'A17: without Supabase env nothing is written and nothing breaks');
ok(sentHeaders.every(h => h && (h.Authorization === 'Bearer ' + FAKE_XAI || h['x-api-key'] === FAKE_ANT)), 'A18: every request the gate saw went to a provider (the heartbeat goes through store.rest only)');

// ═════ B. health reads it ═════
let res = await health(freshCrons());
ok(res._code === 200 && res._body.ok === true && chk(res._body, 'ai_writer_ok') && chk(res._body, 'ai_writer_ok').ok === true, 'B1: no ai-writer row yet = not observed = pass, everything green (' + JSON.stringify(res._body.failing) + ')');
const names = res._body.checks.map(c => c.name);
ok(OLD_NAMES.every(n => names.includes(n)), 'B2: every existing check name is still there');
ok(['build', 'ok', 'checkedAt', 'passed', 'total', 'failing', 'checks', 'meta'].every(k => k in res._body) && ['crons', 'routes', 'grok', 'isolation'].every(k => k in res._body.meta),
  'B3: output shape unchanged (new key meta.aiWriter only added)');
// the row A2 produced, as the database would store it (first insert: last_success_at = column default now())
res = await health(freshCrons().concat([{ job: errRow.job, last_success_at: nowIso(-1500), last_status: errRow.last_status, detail: errRow.detail }]));
ok(chk(res._body, 'ai_writer_ok').ok === false && res._body.failing.includes('ai_writer_ok') && res._body.ok === false, 'B4: the disabled-key row turns health red (ai_writer_ok fails)');
ok(res._body.meta.aiWriter && res._body.meta.aiWriter.grok && res._body.meta.aiWriter.grok.state === 'error' && res._body.meta.aiWriter.grok.http === 403, 'B5: meta names the provider and the HTTP status: ' + JSON.stringify(res._body.meta.aiWriter));
ok(JSON.stringify(res._body).indexOf(String(errRow.detail.message)) === -1, 'B6: the public page never shows the provider\'s message');
// an error newer than a success two days ago is red; an ok row is green; an error OLDER than the last success is green
res = await health(freshCrons().concat([{ job: 'ai-writer:grok', last_success_at: nowIso(-2 * 86400000), last_status: 'error', detail: { provider: 'grok', http: 402, errorAt: nowIso(-60000) } }]));
ok(chk(res._body, 'ai_writer_ok').ok === false, 'B7: error newer than the last success → red');
res = await health(freshCrons().concat([{ job: 'ai-writer:grok', last_success_at: nowIso(-60000), last_status: 'ok', detail: { provider: 'grok', okAt: nowIso(-60000) } }]));
ok(chk(res._body, 'ai_writer_ok').ok === true && res._body.meta.aiWriter.grok.state === 'ok', 'B8: an ok row → green');
res = await health(freshCrons().concat([{ job: 'ai-writer:grok', last_success_at: nowIso(-60000), last_status: 'error', detail: { provider: 'grok', http: 403, errorAt: nowIso(-3 * 3600000) } }]));
ok(chk(res._body, 'ai_writer_ok').ok === true, 'B9: an error OLDER than the last success is not current → green');
// (r2) only the ACTIVE writer is judged; other providers are info. WRITER_PROVIDER is resolved like _write.js.
const grokOk = { job: 'ai-writer:grok', last_success_at: nowIso(-60000), last_status: 'ok', detail: {} };
const grokErr = { job: 'ai-writer:grok', last_success_at: nowIso(-2 * 86400000), last_status: 'error', detail: { provider: 'grok', http: 403, errorAt: nowIso(-60000) } };
const claudeErr = { job: 'ai-writer:claude', last_success_at: nowIso(-5000), last_status: 'error', detail: { provider: 'claude', http: 401, errorAt: nowIso(-5000) } };
const hadWP = process.env.WRITER_PROVIDER, hadAnt = process.env.ANTHROPIC_API_KEY;
try {
  delete process.env.WRITER_PROVIDER;
  res = await health(freshCrons().concat([grokOk, claudeErr]));
  ok(chk(res._body, 'ai_writer_ok').ok === true && res._body.meta.aiWriter.claude.state === 'error' && res._body.meta.aiWriter.claude.active === false && res._body.meta.aiWriter.grok.active === true,
    'B10: default writer is Grok — a refused opt-in Claude arm is shown as info, health stays green');
  process.env.WRITER_PROVIDER = ' Claude ';
  res = await health(freshCrons().concat([grokOk, claudeErr]));
  ok(chk(res._body, 'ai_writer_ok').ok === false && res._body.meta.aiWriter.claude.active === true, 'B10b: WRITER_PROVIDER=claude (with a key) → Claude is active and its error fails health');
  res = await health(freshCrons().concat([grokErr]));
  ok(chk(res._body, 'ai_writer_ok').ok === true && res._body.meta.aiWriter.grok.active === false, 'B10c: with Claude active a Grok error is info only');
  delete process.env.ANTHROPIC_API_KEY;
  res = await health(freshCrons().concat([grokErr]));
  ok(chk(res._body, 'ai_writer_ok').ok === false, 'B10d: WRITER_PROVIDER=claude but no Claude key → the writers use Grok, so Grok is judged');
} finally {
  if (hadWP === undefined) delete process.env.WRITER_PROVIDER; else process.env.WRITER_PROVIDER = hadWP;
  if (hadAnt === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = hadAnt;
}
// (r2) an error older than 24 h with nothing newer is stale, not failing
res = await health(freshCrons().concat([{ job: 'ai-writer:grok', last_success_at: nowIso(-30 * 3600000), last_status: 'error', detail: { provider: 'grok', http: 403, errorAt: nowIso(-25 * 3600000) } }]));
ok(chk(res._body, 'ai_writer_ok').ok === true && res._body.meta.aiWriter.grok.state === 'stale-error', 'B10e: a 25 h old error with no newer activity is "stale-error", not failing');
res = await health(freshCrons().concat([{ job: 'ai-writer:grok', last_success_at: nowIso(-30 * 3600000), last_status: 'error', detail: { provider: 'grok', http: 403, errorAt: nowIso(-23 * 3600000) } }]));
ok(chk(res._body, 'ai_writer_ok').ok === false, 'B10f: a 23 h old error still fails');
// crons: last_status 'error' fails every one of them, fresh or not
for (const job of CRONS) {
  const rows = freshCrons().map(r => (r.job === job ? Object.assign({}, r, { last_status: 'error' }) : r));
  res = await health(rows);
  ok(chk(res._body, 'cron_' + job + '_fresh').ok === false && CRONS.filter(j => j !== job).every(j => chk(res._body, 'cron_' + j + '_fresh').ok === true), 'B11: ' + job + ' with last_status error fails (others stay green)');
}
// an error row with a running first-run grace is still red
res = await health(freshCrons().filter(r => r.job !== 'fact-pack-cron').concat([{ job: 'fact-pack-cron', last_success_at: null, last_status: 'error', detail: { notSetUp: true } },
  { job: 'first-missing:fact-pack-cron', last_success_at: nowIso(-3600000), last_status: 'marker' }]));
ok(chk(res._body, 'cron_fact-pack-cron_fresh').ok === false, 'B12: a fact-pack-cron row that says error is red even inside the first-run grace');
// the grace itself still works
res = await health(freshCrons().filter(r => r.job !== 'fact-pack-cron').concat([{ job: 'first-missing:fact-pack-cron', last_success_at: nowIso(-3600000), last_status: 'marker' }]));
ok(chk(res._body, 'cron_fact-pack-cron_fresh').ok === true && res._body.meta.crons['fact-pack-cron'] === 'awaiting-first-run', 'B13: first-run grace unchanged (no row + fresh marker = awaiting-first-run, green)');
// job_heartbeats unreadable → every cron check (and the writer check) fails, labelled unreadable
for (const [label, hb] of [['HTTP 500', { status: 500, data: { message: 'boom' } }], ['not a list', { status: 200, data: { message: 'odd' } }], ['no answer', null]]) {
  res = await health(null, { hb });
  const b = res._body;
  ok(res._code === 200 && CRONS.every(j => chk(b, 'cron_' + j + '_fresh') && chk(b, 'cron_' + j + '_fresh').ok === false) && CRONS.every(j => b.meta.crons[j] === 'unreadable'),
    'B14 (' + label + '): unreadable job_heartbeats fails every cron check, marked unreadable');
  ok(chk(b, 'ai_writer_ok') && chk(b, 'ai_writer_ok').ok === false && b.meta.aiWriter.state === 'unreadable', 'B15 (' + label + '): and the writer check is unknown → failing');
}

clearTimeout(WALL);
if (failed) { console.log('health-v710: ' + failed + ' failed, ' + passed + ' passed'); process.exit(1); }
console.log('PASS — health-v710: ' + passed + ' checks');
