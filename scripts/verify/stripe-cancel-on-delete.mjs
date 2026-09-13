#!/usr/bin/env node
// GATE: deleting an account cancels the Stripe subscription — and if it can't, says so.
//
// WHY THIS EXISTS
//   delete-account removes the user_plans row, which holds stripe_subscription_id. Without
//   cancelling first, the person keeps being CHARGED for an account that no longer exists AND
//   we have thrown away the only id that could find it. Charging someone after they closed
//   their account is the worst outcome this endpoint can produce, so it is gated.
//
// HOW IT CHECKS
//   Behaviourally. It stubs Node's https layer, drives the REAL exported handler, and asserts
//   on the calls actually issued and the body the frontend would receive. Ordering matters and
//   is asserted explicitly: the cancel MUST precede the user_plans delete.
//
// RUN:    node scripts/verify/stripe-cancel-on-delete.mjs
// EXPECT: prints "PASS: stripe-cancel-on-delete" and exits 0.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HANDLER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../api/delete-account.js');

process.env.SUPABASE_URL = 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-key';
process.env.STRIPE_SECRET_KEY = 'sk_test_stub';

const SUB = 'sub_1LiveSubscription';
const https = require('node:https');

let route = null, seen = [];
https.request = function stub(options, cb) {
  const host = options.hostname, method = options.method, p = options.path;
  seen.push({ host, method, path: p });
  const outcome = route(host, method, p);
  const h = {};
  const req = {
    setTimeout: () => req,
    on: (ev, fn) => { h[ev] = fn; return req; },
    write: () => true,
    end: () => setImmediate(() => {
      if (outcome && outcome.socketError) { if (h.error) h.error(new Error('socket hang up')); return; }
      const rh = {};
      const resp = { statusCode: outcome.status, on: (ev, fn) => { rh[ev] = fn; return resp; } };
      cb(resp);
      if (outcome.body && rh.data) rh.data(outcome.body);
      if (rh.end) rh.end();
    }),
  };
  return req;
};

function baseRoute(host, method, p) {
  if (host === 'api.stripe.com') return { status: 200, body: JSON.stringify({ id: SUB, status: 'canceled' }) };
  if (p === '/auth/v1/user') return { status: 200, body: JSON.stringify({ id: 'user-1', email: 'x@y.z' }) };
  if (method === 'GET' && p.startsWith('/rest/v1/brands?')) return { status: 200, body: JSON.stringify([{ id: 'brand-1' }]) };
  if (method === 'GET' && p.startsWith('/rest/v1/user_plans?')) return { status: 200, body: JSON.stringify([{ stripe_subscription_id: SUB }]) };
  if (method === 'DELETE' && p.startsWith('/rest/v1/')) return { status: 204, body: '' };
  if (method === 'DELETE' && p.startsWith('/auth/v1/admin/users/')) return { status: 200, body: '{}' };
  return { status: 500, body: JSON.stringify({ msg: 'unrouted ' + method + ' ' + p }) };
}

function makeRes() {
  const out = { status: null, body: null };
  const res = { setHeader: () => res, status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; }, end() { return res; } };
  return { res, out };
}

async function run(override) {
  delete require.cache[require.resolve(HANDLER)];
  const handler = require(HANDLER);
  route = (host, m, p) => override(host, m, p) ?? baseRoute(host, m, p);
  seen = [];
  const { res, out } = makeRes();
  await handler({ method: 'POST', headers: { authorization: 'Bearer tok', origin: 'https://contentshrimp.com' } }, res);
  return { ...out, seen };
}

const fails = [];
const check = (n, c, d) => { if (!c) fails.push(n + (d ? ' — ' + d : '')); };
const idx = (s, pred) => s.findIndex(pred);

// 1. HAPPY PATH: the subscription is cancelled, before the mapping is destroyed.
{
  const r = await run(() => null);
  const cancel = idx(r.seen, c => c.host === 'api.stripe.com' && c.method === 'DELETE' && c.path.includes(SUB));
  const planDel = idx(r.seen, c => c.method === 'DELETE' && c.path.startsWith('/rest/v1/user_plans'));
  check('happy: no Stripe cancel was issued at all', cancel >= 0,
    'the user keeps being billed for a deleted account; calls seen: ' + r.seen.map(c => c.method + ' ' + c.host).join(', '));
  check('happy: cancel did not run BEFORE the user_plans delete', cancel >= 0 && planDel >= 0 && cancel < planDel,
    'deleting the row first destroys stripe_subscription_id, so the subscription becomes unfindable');
  check('happy: deletion did not report success', r.status === 200 && r.body && r.body.ok === true, 'status=' + r.status);
  check('happy: warned about billing when nothing was wrong', !(r.body && r.body.billingWarning), 'a false alarm trains users to ignore it');
}

// 2. CANCEL FAILS: the account is still deleted, but the user MUST be told they may be billed.
for (const [label, outcome] of [
  ['stripe 500', { status: 500, body: JSON.stringify({ error: { message: 'boom' } }) }],
  ['stripe socket death', { socketError: true }],
  ['stripe says still active', { status: 200, body: JSON.stringify({ id: SUB, status: 'active' }) }],
]) {
  const r = await run(host => host === 'api.stripe.com' ? outcome : null);
  check(`${label}: deletion should still succeed`, r.status === 200 && r.body && r.body.ok === true,
    'refusing to erase their data would trade one duty for another; status=' + r.status);
  const w = r.body && r.body.billingWarning;
  check(`${label}: SILENT — no billingWarning`, typeof w === 'string' && w.length > 20,
    'the user is told only "Account deleted." while still being charged — the exact lie this endpoint was rewritten to remove');
}

// 3. A MISSING KEY IS A FAILURE, NOT A SKIP. If billing is configured and the key is absent,
//    the subscription is very much still live.
{
  const saved = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  const r = await run(() => null);
  check('no-key: treated as if cancelled', r.body && typeof r.body.billingWarning === 'string',
    'with no key nothing was cancelled, so silence here is a silent lie');
  process.env.STRIPE_SECRET_KEY = saved;
}

// 4. NO SUBSCRIPTION: do not call Stripe at all.
{
  const r = await run((host, m, p) => (m === 'GET' && p.startsWith('/rest/v1/user_plans?')) ? { status: 200, body: '[]' } : null);
  check('free user: called Stripe anyway', !r.seen.some(c => c.host === 'api.stripe.com'));
  check('free user: spurious billing warning', !(r.body && r.body.billingWarning));
}

if (fails.length) {
  console.error('FAIL — /api/delete-account mishandles the subscription:');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('PASS: stripe-cancel-on-delete — cancels before erasing the mapping, and never hides a failure to cancel');
