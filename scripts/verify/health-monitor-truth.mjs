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

const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1; };
let failed = 0;
const check = (cond, m) => { if (!cond) { fail(m); failed++; } };

const https = require_('node:https');
const realRequest = https.request;
const realFetch = globalThis.fetch;
const realSetTimeout = global.setTimeout;

// ── one run of the real handler against a scripted Supabase ───────────────────
// answer(path) -> { status, body } | 'stall'   (stall = accepted then silent)
// routeStatus  -> number | 'stall'
async function run({ answer, routeStatus = 200, scale = 1 }) {
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
  await handler({ method: 'GET', query: {}, headers: {} }, res);
  const ms = (Date.now() - t0) * scale;
  https.request = realRequest; globalThis.fetch = realFetch; global.setTimeout = realSetTimeout;
  return { res, ms, calls };
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

if (failed === 0) console.log('PASS — health-monitor-truth: ' + ISOLATION.length + ' isolation checks cannot be invented, and the worst case fits the budget.');
else console.error(failed + ' failure(s)');
