#!/usr/bin/env node
// GATE: a run that FAILS gives the credit back.
//
// WHY THIS EXISTS
//   checkLimit reserves a credit BEFORE the work (a "hold:<action>:<token>" row in
//   usage_events, which counts toward `used` until it is settled or expires). releaseHold()
//   existed and had ZERO handler call sites — so every 4xx/5xx after an admitted gate left
//   the reservation standing for the full 6-minute TTL. Measured: a free user at 38/40 hits
//   two provider errors, receives nothing at all, and reads 40/40 — then the upgrade wall,
//   "Your free posts are used up · Upgrade to Pro · €24/mo". They are pushed toward paying
//   for credits they never spent. Endpoints that fail this way in one click are ordinary:
//   an unreachable URL, an unparseable transcript, a provider 502.
//
//   The release is attached to the RESPONSE rather than threaded through ~25 handlers' error
//   paths, because the one error path that got missed would have been invisible. res.json is
//   patched (not res.on('finish')) because a serverless instance can be frozen the moment the
//   response is sent, so work started in a finish listener may never run — whereas handlers
//   here all `return res.status(x).json(y)` and the platform awaits the handler.
//
// HOW IT CHECKS
//   It RUNS the real api/_usage.js against an in-memory PostgREST: a real guard() places a real
//   reservation, and the test then answers 502 and asserts the row is GONE. It also checks the
//   two ways this could be over-corrected — a successful call must still be charged exactly
//   once, and an error AFTER a successful logUsage must not refund work that really happened.
//   The last arm is the derived rule: every gated endpoint must hand guard() the response, and
//   any endpoint calling checkLimit directly must attach the release itself.
//
// RUN:    node scripts/verify/hold-refund.mjs
// EXPECT: prints "PASS" and exits 0.
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

process.env.SUPABASE_URL = 'https://hold-gate.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only-not-a-real-key';
process.env.COST_CAP_EUR = '25';

// ── a fake PostgREST that stores usage_events and user_plans in memory ────────
const https = require_('node:https');
const rows = [];                 // usage_events
const plans = new Map();
const seen = [];
const sp = (p) => new URL('https://h' + p).searchParams;
const eq = (s, k) => { const v = s.get(k); return v && v.startsWith('eq.') ? v.slice(3) : null; };

function route(opts, payload) {
  seen.push(opts.method + ' ' + opts.path);
  const table = opts.path.split('?')[0], s = sp(opts.path);
  if (table === '/rest/v1/user_plans') {
    if (opts.method === 'GET') { const r = plans.get(eq(s,'user_id')); return { status:200, body: JSON.stringify(r?[r]:[]) }; }
    if (opts.method === 'POST') { const b = JSON.parse(payload); plans.set(b.user_id, Object.assign({plan:'free'}, b)); return { status:201, body:'[]' }; }
    if (opts.method === 'PATCH') return { status:204, body:'' };
  }
  if (table === '/rest/v1/usage_events') {
    if (opts.method === 'GET') {
      const uid = eq(s,'user_id');
      const page = rows.filter(r => r.user_id === uid);
      const h = {};
      if (String((opts.headers||{}).Prefer||'').includes('count=exact'))
        h['content-range'] = page.length ? `0-${page.length-1}/${page.length}` : `*/0`;
      return { status:200, headers:h, body: JSON.stringify(page) };
    }
    if (opts.method === 'POST') {
      const b = JSON.parse(payload);
      rows.push(Object.assign({ created_at: new Date().toISOString() }, b));
      return { status:201, body: JSON.stringify([rows[rows.length-1]]) };
    }
    if (opts.method === 'PATCH') {
      const uid = eq(s,'user_id'), act = eq(s,'action'); const b = JSON.parse(payload);
      const hit = rows.filter(r => r.user_id === uid && r.action === act);
      hit.forEach(r => Object.assign(r, b));
      return { status:200, body: JSON.stringify(hit) };
    }
    if (opts.method === 'DELETE') {
      const uid = eq(s,'user_id'), act = eq(s,'action');
      for (let i = rows.length-1; i >= 0; i--) if (rows[i].user_id === uid && rows[i].action === act) rows.splice(i,1);
      return { status:204, body:'' };
    }
  }
  return { status:404, body:'{}' };
}
https.request = function (opts, cb) {
  const req = new EventEmitter(); let payload = '';
  req.write = c => { payload += c; return true; };
  req.setTimeout = () => req; req.destroy = () => req; req.setHeader = () => req;
  req.end = () => { setImmediate(() => {
    let out; try { out = route(opts, payload); } catch (e) { req.emit('error', e); return; }
    const resp = new EventEmitter(); resp.statusCode = out.status; resp.headers = out.headers || {};
    cb(resp); setImmediate(() => { if (out.body) resp.emit('data', out.body); resp.emit('end'); });
  }); return req; };
  return req;
};

// _requireUser must answer without a network call
require_.cache[require_.resolve(ROOT + '/api/_requireUser.js')] = { exports: async () => ({ id: 'USER-1' }) };
const usage = require_(ROOT + '/api/_usage.js');

let fail = 0; const ok = (c,m)=>{ if(!c){console.log('FAIL:',m);fail++;} else console.log('ok:',m); };
const holds = () => rows.filter(r => String(r.action||'').startsWith('hold:')).length;
const done  = () => rows.filter(r => !String(r.action||'').startsWith('hold:')).length;
const mkRes = () => { const r = { statusCode: 200, sent: null,
  status(c){ r.statusCode = c; return r; }, json(b){ r.sent = b; return b; },
  setHeader(){}, }; return r; };
const req = { method:'POST', headers:{}, body:{} };

// ── 1. a handler that FAILS must give the credit back ────────────────────────
{
  rows.length = 0;
  const res = mkRes();
  const g = await usage.guard(req, 'remix', res);
  ok(g.user && !g.over, 'the gate admitted the call');
  ok(holds() === 1, 'a reservation was written (' + holds() + ')');
  await res.status(502).json({ error: 'No response from the AI — try again' });
  ok(holds() === 0, 'the reservation is RELEASED after a 502 (' + holds() + ' left)');
  ok(done() === 0, 'and no completed event was written');
  ok(res.sent && res.sent.error, 'the error response still reached the caller: ' + JSON.stringify(res.sent));
}
// ── 2. a handler that SUCCEEDS must still be charged, exactly once ────────────
{
  rows.length = 0;
  const res = mkRes();
  const g = await usage.guard(req, 'remix', res);
  await usage.logUsage({ userId: g.billingUserId, brandId: null, action: 'remix', model: 'grok' });
  await res.status(200).json({ ok: true });
  ok(holds() === 0, 'no reservation left after success');
  ok(done() === 1, 'exactly one completed event (' + done() + ')');
  ok(rows[0].action === 'remix', 'and it is the real action, not a hold: ' + rows[0].action);
}
// ── 2b. a 2xx must NEVER refund, even if the handler has not logged yet ──────
// (Without this arm, deleting the `code < 400` test above still passes everything else.)
{
  rows.length = 0;
  const res = mkRes();
  await usage.guard(req, 'remix', res);
  ok(holds() === 1, 'a reservation is outstanding before the 200');
  await res.status(200).json({ ok: true });
  ok(holds() === 1, 'a 200 does NOT release the reservation \u2014 the work succeeded, it is owed ' +
     '(left=' + holds() + '). logUsage settles it; the refund is only ever for an error.');
  await res.status(204).json({});
  ok(holds() === 1, 'a 204 does not release it either');
}

// ── 3. a 4xx after a SUCCESSFUL log must NOT refund (the work happened) ───────
{
  rows.length = 0;
  const res = mkRes();
  const g = await usage.guard(req, 'remix', res);
  await usage.logUsage({ userId: g.billingUserId, action: 'remix' });
  await res.status(500).json({ error: 'something later blew up' });
  ok(done() === 1 && holds() === 0, 'a settled call is not refunded by a later error (done=' + done() + ')');
}
// ── 4. the refund must actually free the allowance ───────────────────────────
{
  rows.length = 0;
  plans.clear();
  // burn to the free limit minus 2
  const lim = usage.PLAN_LIMITS.free;
  for (let i = 0; i < lim - 2; i++) rows.push({ user_id:'USER-1', action:'remix', created_at:new Date().toISOString() });
  plans.set('USER-1', { user_id:'USER-1', plan:'free' });
  for (let i = 0; i < 2; i++) {
    const res = mkRes();
    const g = await usage.guard(req, 'remix', res);
    if (g.over) { ok(false, 'failure ' + i + ' was refused before it even ran'); break; }
    await res.status(502).json({ error: 'provider down' });
  }
  const res = mkRes();
  const g = await usage.guard(req, 'remix', res);
  ok(!g.over, 'after two FAILED runs the next real generation is still allowed ' +
     '(used=' + (g.gate && g.gate.used) + '/' + (g.gate && g.gate.limit) + ') — before v678 this hit the upgrade wall');
}
// ── 5. every gated endpoint hands guard() the response ───────────────────────
{
  const fs = require_('node:fs');
  const bad = [];
  for (const f of fs.readdirSync(ROOT + '/api')) {
    if (!f.endsWith('.js') || f === '_usage.js') continue;
    const t = fs.readFileSync(ROOT + '/api/' + f, 'utf8');
    for (const m of t.matchAll(/\.guard\(\s*req\s*,\s*[^)]*?\)/g))
      if (!/,\s*res\s*\)$/.test(m[0])) bad.push(f + ': ' + m[0]);
    // a direct checkLimit caller must attach the release itself
    if (/\.checkLimit\(/.test(t) && !/attachHoldRelease\(/.test(t)) bad.push(f + ': calls checkLimit but never attaches a release');
  }
  ok(bad.length === 0, 'every gated endpoint wires the refund: ' + (bad.join(' | ') || 'all good'));
}
console.log(fail ? '\nFAIL \u2014 ' + fail + ' check(s) failed' : '\nPASS \u2014 a failed run refunds its credit, a successful one is charged once, and every gated endpoint is wired');
process.exit(fail?1:0);
