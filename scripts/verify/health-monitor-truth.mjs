#!/usr/bin/env node
// GATE: the health monitor may not invent green safety facts, and may not time out.
//
// WHY THIS EXISTS
//   /api/health is the ONLY thing watching this app. A daily scheduled task fetches it and
//   reports the verdict. Two ways it was lying:
//
//   1. FIVE INVENTED GREEN SECURITY CLAIMS. store.rest RESOLVES on every HTTP status, so a
//      PostgREST error body — a plain object like {code:'PGRST202', message:'Could not find
//      the function public.security_health'} — satisfied `h && typeof h === 'object'`. None
//      of the audit's arrays were in it, each defaulted to [], and `.length === 0` scored
//      GREEN. Measured against the real handler with the RPC answering 404: "RLS enabled on
//      all tables", "no permissive brand policies", "no permissive write policies", "no
//      unexpected deny-all tables", "brand tables bound to caller" — all five reported as
//      PASSING, from a response that contained none of them. The single red was
//      `membership_function_present`, which reads as "one SQL function is missing" and sends
//      the owner looking in the wrong place entirely. A monitor that manufactures five
//      security facts out of a database error is worse than having no monitor.
//
//   2. IT COULD BE KILLED BEFORE IT ANSWERED. Three store.rest calls ran one after another at
//      REQ_TIMEOUT_MS (8s each), then the 8s route probes. Measured with a stalled Supabase:
//      34 seconds of wall clock against a maxDuration of 20. The platform kills the function
//      and the daily report gets NOTHING — and silence from a monitor reads exactly like a
//      monitor that was never scheduled.
//
// HOW IT CHECKS
//   It RUNS the real api/health.js handler with node:https and fetch stubbed, once per arm,
//   and reads the real response body. Arm 1 proves an error body produces no green isolation
//   check. Arm 2 proves a REAL audit still produces them (not over-corrected to always-red).
//   Arm 3 proves a real finding still goes red. Arm 4 proves a 200 of the wrong shape counts
//   as unverified. Arm 5 measures wall clock against the maxDuration read from vercel.json —
//   not a number typed here, so raising one without the other cannot pass. Arm 6 proves the
//   endpoint answers 200 in every arm, because a monitor that 500s tells you nothing.
//
// RUN:    node scripts/verify/health-monitor-truth.mjs
// EXPECT: prints "PASS" and exits 0.
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HEALTH = path.join(ROOT, 'api', 'health.js');

process.env.SUPABASE_URL = 'https://health-gate.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only-not-a-real-key';
process.env.APP_BASE_URL = 'https://health-gate.invalid';

// v690: a wall clock — a handler that never answers must fail this gate, not hang it.
const _wall = setTimeout(() => { console.error('FAIL: wall clock — health-monitor-truth did not finish in 90s'); process.exit(1); }, 90000);
_wall.unref();
const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1; };
let failed = 0;
// Print the ok lines too. A gate that is silent when it passes hides an arm that never ran —
// which is exactly how the two arms below first shipped asserting nothing at all (they called
// ok(), which in this file is the PAYLOAD BUILDER, not an assertion).
const check = (cond, m) => { if (!cond) { fail(m); failed++; } else console.log('ok: ' + m); };

const https = require_('node:https');
const realRequest = https.request;
const realFetch = globalThis.fetch;
const realSetTimeout = global.setTimeout;

// ── one run of the real handler against a scripted Supabase ───────────────────
// answer(path) -> { status, body } | 'stall'   (stall = accepted then silent)
// routeStatus  -> number | 'stall'
async function run({ answer, routeStatus = 200, scale = 1, query = {} }) {
  const calls = [];
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    req.write = () => {}; req.end = () => {};
    req.destroy = (e) => req.emit('error', e || new Error('destroyed'));
    let timer = null;
    req.setTimeout = (ms, fn) => { timer = realSetTimeout(fn, ms / scale); };
    const go = () => {
      calls.push(opts.method + ' ' + opts.path);
      const a = answer(opts.path, opts.method);
      if (a === 'stall') return;                    // never answers
      if (timer) clearTimeout(timer);
      const resp = new EventEmitter();
      resp.statusCode = a.status;
      cb(resp);
      resp.emit('data', a.body == null ? '' : a.body);
      resp.emit('end');
    };
    req.end = () => realSetTimeout(go, 0);
    return req;
  };
  globalThis.fetch = (u, o) => {
    if (routeStatus === 'stall') {
      return new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted'))));
    }
    return Promise.resolve({ status: routeStatus });
  };
  // Shrink only the long real-world budgets (>= 4s), never short internal timers.
  global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms >= 4000 ? ms / scale : ms, ...a);

  delete require_.cache[require_.resolve(HEALTH)];
  const handler = require_(HEALTH);
  const res = {
    _code: null, _body: null,
    setHeader() {}, status(c) { this._code = c; return this; },
    json(b) { this._body = b; return this; }, end() { return this; },
  };
  const t0 = Date.now();
  // A monitor that THROWS says nothing at all, which is the same outcome as one that was never
  // scheduled. Catch it here so the arms report a real failure instead of an unhandled rejection
  // that scrolls past — a crash must read as "the monitor is broken", loudly.
  let threw = null;
  try { await handler({ method: 'GET', query, headers: { authorization: 'Bearer t' } }, res); }
  catch (e) { threw = (e && e.message) || String(e); }
  const ms = (Date.now() - t0) * scale;
  https.request = realRequest; globalThis.fetch = realFetch; global.setTimeout = realSetTimeout;
  if (threw) { fail('/api/health THREW instead of answering: ' + threw + ' — a monitor that crashes tells you nothing.'); failed++; }
  return { res, ms, calls, threw };
}

const HEALTHY_AUDIT = {
  rls_disabled: [], permissive_policies: [], permissive_write_policies: [],
  unbound_brand_tables: [], zero_policy_tables: ['brand_connections'],
  has_user_brand_ids: true, user_brand_ids_secure: true,
};
const ok = (o) => ({ status: 200, body: JSON.stringify(o) });
const isRpc = (p) => p.indexOf('/rpc/security_health') !== -1;
const ISOLATION = [
  'rls_all_tables_enabled', 'no_permissive_brand_policies', 'no_permissive_write_policies',
  'no_unexpected_denyall_tables', 'brand_tables_bound_to_caller',
  'membership_function_present', 'membership_function_secure',
];
const get = (body, name) => body.checks.find(c => c.name === name);
const greenIsolation = (body) => ISOLATION.filter(n => { const c = get(body, n); return c && c.ok; });

// Every arm gets a working DB + heartbeats so only the audit varies.
const baseAnswer = (rpc) => (p) => {
  if (isRpc(p)) return rpc;
  if (p.indexOf('/brands') !== -1) return ok([{ id: 'b1' }]);
  if (p.indexOf('/job_heartbeats') !== -1) {
    const nowish = new Date().toISOString();
    return ok([{ job: 'send-daily', last_success_at: nowish, last_status: 'ok' },
               { job: 'pull-trends-cron', last_success_at: nowish, last_status: 'ok' }]);
  }
  return ok([]);
};

// ── ARM 1: a PostgREST error body must produce ZERO green isolation checks ────
{
  const pgErr = { status: 404, body: JSON.stringify({ code: 'PGRST202', details: null, hint: null,
    message: 'Could not find the function public.security_health(  ) in the schema cache' }) };
  const { res } = await run({ answer: baseAnswer(pgErr) });
  const b = res._body;
  const green = greenIsolation(b);
  check(green.length === 0,
    'ARM 1: the security_health RPC answered 404 with an error body, yet these isolation checks ' +
    'are reported GREEN: ' + JSON.stringify(green) + ' — invented from a response that contained none of them.');
  const reach = get(b, 'isolation_audit_reachable');
  check(reach && reach.ok === false,
    'ARM 1: with the audit unreachable there must be an explicit RED isolation_audit_reachable; got ' + JSON.stringify(reach));
  check(!b.failing.includes('membership_function_present'),
    'ARM 1: a failed audit must not be reported as a missing SQL function (membership_function_present) — that points the owner at the wrong problem.');
}

// ── ARM 2: a REAL audit must still produce the real checks (not always-red) ───
{
  const { res } = await run({ answer: baseAnswer(ok(HEALTHY_AUDIT)) });
  const b = res._body;
  for (const n of ISOLATION) check(get(b, n) && get(b, n).ok === true, 'ARM 2: a healthy audit must report ' + n + ' as passing; got ' + JSON.stringify(get(b, n)));
  check(get(b, 'isolation_audit_reachable').ok === true, 'ARM 2: a healthy audit must mark isolation_audit_reachable true.');
}

// ── ARM 3: a REAL finding must still go red ──────────────────────────────────
{
  const bad = Object.assign({}, HEALTHY_AUDIT, { rls_disabled: ['takes'], permissive_write_policies: ['ideas_all'] });
  const { res } = await run({ answer: baseAnswer(ok(bad)) });
  const b = res._body;
  check(b.failing.includes('rls_all_tables_enabled'), 'ARM 3: rls_disabled:["takes"] must fail rls_all_tables_enabled.');
  check(b.failing.includes('no_permissive_write_policies'), 'ARM 3: a permissive write policy must fail no_permissive_write_policies.');
  check(get(b, 'isolation_audit_reachable').ok === true, 'ARM 3: the audit DID run — isolation_audit_reachable must stay true so the real findings are trusted.');
}

// ── ARM 4b: a one-row PostgREST array is unwrapped, not rejected ─────────────
// PostgREST answers with a bare object for a scalar-returning function and a ONE-ROW ARRAY for a
// set-returning one. Calling a working audit malformed would be a different kind of lie.
{
  const { res } = await run({ answer: baseAnswer(ok([HEALTHY_AUDIT])) });
  const b = res._body;
  check(get(b, 'isolation_audit_reachable') && get(b, 'isolation_audit_reachable').ok === true,
     'a single-row array wrapping a real audit must be unwrapped and trusted; got meta.isolation=' + JSON.stringify(b.meta.isolation));
  check(greenIsolation(b).length >= 6, 'and its checks must be made (got ' + greenIsolation(b).length + ')');
}
// ── ARM 4c: a STALE function must name the keys it is missing ────────────────
// This is the live production case: the audit answers 200 with a real payload, but the deployed
// SQL predates some keys. Under v682 each missing key defaulted to [] and scored GREEN, so the
// checks it should have made were never made. "unexpected-shape" is true and useless; the owner
// needs to know it is sql/health-check.sql that is behind, and which keys say so.
{
  const stale = Object.assign({}, HEALTHY_AUDIT);
  delete stale.permissive_write_policies; delete stale.unbound_brand_tables;
  const { res } = await run({ answer: baseAnswer(ok(stale)) });
  const b = res._body;
  check(greenIsolation(b).length === 0, 'a stale function must make NO green isolation claims (got ' + JSON.stringify(greenIsolation(b)) + ')');
  const iso = String(b.meta && b.meta.isolation);
  check(/stale-function/.test(iso) && /permissive_write_policies/.test(iso) && /unbound_brand_tables/.test(iso),
     'and meta.isolation must name exactly which keys are missing, so the fix is obvious: ' + JSON.stringify(iso));
}

// ── ARM 4: a 200 of the wrong shape is unverified, not green ─────────────────
for (const [label, payload] of [
  ['an empty object', {}],
  ['an array', []],
  ['arrays missing, boolean present', { has_user_brand_ids: true }],
  ['boolean missing, arrays present', { rls_disabled: [], permissive_policies: [], permissive_write_policies: [], unbound_brand_tables: [], zero_policy_tables: [] }],
]) {
  const { res } = await run({ answer: baseAnswer(ok(payload)) });
  const b = res._body;
  const green = greenIsolation(b);
  check(green.length === 0, 'ARM 4 (' + label + '): scored ' + JSON.stringify(green) + ' green from a body that is not an audit result.');
  check(get(b, 'isolation_audit_reachable') && get(b, 'isolation_audit_reachable').ok === false,
    'ARM 4 (' + label + '): must report isolation_audit_reachable false.');
}

// ── ARM 5: worst case must fit the maxDuration declared in vercel.json ───────
{
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const budget = cfg.functions && cfg.functions['api/health.js'] && cfg.functions['api/health.js'].maxDuration;
  check(typeof budget === 'number', 'ARM 5: api/health.js has no maxDuration in vercel.json — cannot check the budget.');
  const SCALE = 100;
  const { res, ms, calls } = await run({ answer: () => 'stall', routeStatus: 'stall', scale: SCALE });
  check(calls.length >= 3, 'ARM 5: expected all three Supabase reads to be issued; saw ' + calls.length + '.');
  const seconds = Math.round(ms / 1000);
  check(ms < budget * 1000,
    'ARM 5: with Supabase stalled and every route probe timing out, /api/health takes ~' + seconds +
    's against a maxDuration of ' + budget + 's. The platform kills it and the daily monitor gets ' +
    'NOTHING — silence reads the same as a monitor that never ran. Probe the reads concurrently or raise the budget.');
  check(res._body != null, 'ARM 5: the handler must still produce a body when everything it probes is dead.');
}

// ── ARM 6: a monitor must always answer 200 ─────────────────────────────────
for (const [label, a] of [
  ['everything dead', () => 'stall'],
  ['Supabase 500s', () => ({ status: 500, body: JSON.stringify({ message: 'boom' }) })],
  ['Supabase returns garbage', () => ({ status: 200, body: 'not json at all' })],
]) {
  const { res } = await run({ answer: a, routeStatus: 500, scale: 100 });
  check(res._code === 200, 'ARM 6 (' + label + '): /api/health answered ' + res._code + '; a monitor that errors tells you nothing.');
  check(res._body && Array.isArray(res._body.checks), 'ARM 6 (' + label + '): no checks array in the body.');
  const green = greenIsolation(res._body);
  check(green.length === 0, 'ARM 6 (' + label + '): scored ' + JSON.stringify(green) + ' green with no working database.');
}

// ── ARM 7 (v690): the live AI check names a REFUSED account apart from an OUTAGE ──
// ?ping=1 used to swallow callLLM's error in an empty catch, so "xAI refused our account"
// (out of credits / spending limit / revoked key: only the owner can fix it, in the xAI console)
// and "xAI did not answer" (wait and retry) were one indistinguishable {ok:false}. Runs the real
// handler and the real api/_llm.js against a scripted x.ai; guard/logUsage are stubbed (the
// metering of this path is proved elsewhere).
{
  const usageKey = require_.resolve(path.join(ROOT, 'api', '_usage.js'));
  const realUsage = require_.cache[usageKey];
  let logged = 0;
  require_.cache[usageKey] = { id: usageKey, filename: usageKey, loaded: true, exports: {
    COST_CAP_EUR: 25,
    guard: async () => ({ user: { id: 'u1' }, over: false, billingUserId: 'u1' }),
    logUsage: async () => { logged++; },
  } };
  const hadKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'test-only-not-a-real-key';
  const isXai = (p) => p.indexOf('/chat/completions') !== -1;
  const withXai = (x) => (p, m) => (isXai(p) ? x : baseAnswer(ok(HEALTHY_AUDIT))(p, m));
  const grokOf = (b) => (b && b.meta && b.meta.grok) || {};
  try {
    for (const code of [402, 403]) {
      const { res } = await run({ answer: withXai({ status: code, body: JSON.stringify({ error: 'team out of credits (test)' }) }), query: { ping: '1' }, scale: 100 });
      const b = res._body, g = grokOf(b);
      check(res._code === 200, 'ARM 7 (' + code + '): the monitor still answers 200 (got ' + res._code + ')');
      check(g.ok === false && g.state === 'refused' && g.http === code,
        'ARM 7 (' + code + '): a refused account is reported as refused, with its HTTP code — got ' + JSON.stringify(g));
      check(/credits|spending limit/i.test(String(g.reason)) && /not an outage/i.test(String(g.reason)),
        'ARM 7 (' + code + '): the reason says it is billing, not an outage — got ' + JSON.stringify(g.reason));
      check(b.failing.includes('grok_account_accepted') && b.failing.includes('grok_live'),
        'ARM 7 (' + code + '): the failing list itself names the refused account (grok_account_accepted) — got ' + JSON.stringify(b.failing));
    }
    {
      const { res } = await run({ answer: withXai({ status: 401, body: '{}' }), query: { ping: '1' }, scale: 100 });
      const g = grokOf(res._body);
      check(g.state === 'refused' && g.http === 401 && /key/i.test(String(g.reason)), 'ARM 7 (401): a rejected key is named as a key problem — got ' + JSON.stringify(g));
    }
    // the opposite: an outage (x.ai accepts the connection and never answers) is NOT a refusal
    {
      const { res } = await run({ answer: withXai('stall'), query: { ping: '1' }, scale: 100 });
      const b = res._body, g = grokOf(b);
      check(res._code === 200 && g.ok === false && g.state === 'no-answer' && /did not answer/i.test(String(g.reason)),
        'ARM 7 (outage): a provider that never answers is reported as no-answer — got ' + JSON.stringify(g));
      check(b.failing.includes('grok_live') && !b.checks.some(c => c.name === 'grok_account_accepted'),
        'ARM 7 (outage): an outage makes no claim about the account either way — got ' + JSON.stringify(b.failing));
    }
    // and a working provider is green on both
    {
      const { res } = await run({ answer: withXai({ status: 200, body: JSON.stringify({ model: 'grok', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }], usage: {} }) }), query: { ping: '1' }, scale: 100 });
      const b = res._body, g = grokOf(b);
      check(g.ok === true && get(b, 'grok_live') && get(b, 'grok_live').ok === true && get(b, 'grok_account_accepted') && get(b, 'grok_account_accepted').ok === true,
        'ARM 7 (working): a provider that answers is green on grok_live and grok_account_accepted — got ' + JSON.stringify(g) + ' ' + JSON.stringify(b.failing));
    }
    check(logged === 5, 'ARM 7: every attempted ping was metered (' + logged + ' of 5)');
  } finally {
    if (realUsage) require_.cache[usageKey] = realUsage; else delete require_.cache[usageKey];
    if (hadKey === undefined) delete process.env.XAI_API_KEY; else process.env.XAI_API_KEY = hadKey;
  }
}

clearTimeout(_wall);
if (failed === 0) console.log('PASS — health-monitor-truth: ' + ISOLATION.length + ' isolation checks cannot be invented, and the worst case fits the budget.');
else console.error(failed + ' failure(s)');
