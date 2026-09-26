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

// v692 round 5 — Stripe as delete-account now uses it: a Search by user_id (SEARCH), a re-read by id
// (LIVE), and the cancel. Defaults: nothing else found.
let SEARCH = [], LIVE = new Map();
function baseRoute(host, method, p) {
  if (host === 'api.stripe.com' && method === 'GET' && p.startsWith('/v1/subscriptions/search?')) {
    return { status: 200, body: JSON.stringify({ object: 'search_result', data: SEARCH, has_more: false }) };
  }
  if (host === 'api.stripe.com' && method === 'GET' && p.startsWith('/v1/subscriptions/')) {
    const s = LIVE.get(decodeURIComponent(p.slice('/v1/subscriptions/'.length).split('?')[0]));
    return s ? { status: 200, body: JSON.stringify(s) } : { status: 404, body: JSON.stringify({ error: { message: 'No such subscription' } }) };
  }
  if (host === 'api.stripe.com' && method === 'DELETE') {
    const id = decodeURIComponent(p.slice('/v1/subscriptions/'.length));
    return { status: 200, body: JSON.stringify({ id, status: 'canceled' }) };
  }
  if (host === 'api.stripe.com') return { status: 500, body: JSON.stringify({ error: { message: 'unrouted stripe ' + method + ' ' + p } }) };
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
  const r = await run((host, m) => (host === 'api.stripe.com' && m === 'DELETE') ? outcome : null);
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
  // v692 round 5: a free user is now SEARCHED (they may hold a subscription the row never got), but
  // with nothing found nothing is cancelled
  check('free user: cancelled something anyway', !r.seen.some(c => c.host === 'api.stripe.com' && c.method === 'DELETE'));
  check('free user: called Stripe for anything but the search', r.seen.filter(c => c.host === 'api.stripe.com').every(c => c.path.startsWith('/v1/subscriptions/search?')));
  check('free user: spurious billing warning', !(r.body && r.body.billingWarning));
}

// 5. (v692 round 5) EVERY live subscription of this user is cancelled — not only the row's — and never
//    another user's. Before the user_plans delete, like the row's.
const S = (id, over) => Object.assign({ id, object: 'subscription', status: 'active', customer: 'cus_1', metadata: { user_id: 'user-1' } }, over || {});
const quiet = async (fn) => { const oe = console.error, ol = console.log; console.error = console.log = () => {}; try { return await fn(); } finally { console.error = oe; console.log = ol; } };
const cancels = (r) => r.seen.filter(c => c.host === 'api.stripe.com' && c.method === 'DELETE').map(c => decodeURIComponent(c.path.split('/').pop()));
{
  SEARCH = [S(SUB), S('sub_B', { customer: 'cus_2' }), S('sub_C', { status: 'past_due' }), S('sub_X', { metadata: { user_id: 'user-2' } }),
            S('sub_D', { status: 'canceled' }), S('sub_M'), S('sub_S')];
  LIVE = new Map([[SUB, S(SUB)], ['sub_B', S('sub_B', { customer: 'cus_2' })], ['sub_C', S('sub_C', { status: 'past_due' })],
                  ['sub_X', S('sub_X', { metadata: { user_id: 'user-2' } })], ['sub_D', S('sub_D', { status: 'canceled' })],
                  ['sub_M', S('sub_M', { metadata: { user_id: 'user-2' } })],     // the index says user-1, the object says user-2
                  ['sub_S', S('sub_S', { status: 'canceled' })]]);                 // the index says active, the object is canceled
  const r = await quiet(() => run(() => null));
  const c = cancels(r).sort();
  check('multi: not every live subscription of this user was cancelled', JSON.stringify(c) === JSON.stringify([SUB, 'sub_B', 'sub_C'].sort()),
    'cancelled ' + JSON.stringify(c) + ' — want the row\'s, sub_B (another customer) and sub_C (past_due) only');
  check('multi: cancelled ANOTHER user\'s subscription', !c.includes('sub_X') && !c.includes('sub_M'), JSON.stringify(c));
  check('multi: cancelled an ended subscription', !c.includes('sub_D') && !c.includes('sub_S'), JSON.stringify(c));
  const lastCancel = Math.max(...r.seen.map((x, i) => (x.host === 'api.stripe.com' && x.method === 'DELETE') ? i : -1));
  const planDel = idx(r.seen, x => x.method === 'DELETE' && x.path.startsWith('/rest/v1/user_plans'));
  check('multi: a cancel ran after the user_plans delete', lastCancel >= 0 && planDel > lastCancel, 'the mapping must go last');
  check('multi: deletion did not succeed cleanly', r.status === 200 && r.body.ok === true && !r.body.billingWarning, JSON.stringify(r.body));
}
// a free row (the webhook never granted) with a live subscription found by search → cancelled
{
  SEARCH = [S('sub_B')]; LIVE = new Map([['sub_B', S('sub_B')]]);
  const r = await quiet(() => run((host, m, p) => (m === 'GET' && p.startsWith('/rest/v1/user_plans?')) ? { status: 200, body: '[]' } : null));
  check('ungranted: a paid-but-not-yet-granted subscription was left charging', JSON.stringify(cancels(r)) === '["sub_B"]', JSON.stringify(cancels(r)));
}
// an extra subscription that cannot be cancelled → same rule as the row's: erasure continues, the user is warned
{
  SEARCH = [S('sub_B')]; LIVE = new Map([['sub_B', S('sub_B')]]);
  const r = await quiet(() => run((host, m, p) => (host === 'api.stripe.com' && m === 'DELETE' && p.includes('sub_B')) ? { status: 500, body: '{}' } : null));
  check('extra-fail: deletion stopped', r.status === 200 && r.body.ok === true, 'status=' + r.status);
  check('extra-fail: SILENT — no billingWarning', typeof r.body.billingWarning === 'string', JSON.stringify(r.body));
  check('extra-fail: the row\'s subscription was not still cancelled', cancels(r).includes(SUB));
}
// Search missing for this account → the row's subscription only, as before, logged, no false alarm
{
  SEARCH = []; LIVE = new Map();
  const lines = [];
  const oe = console.error, ol = console.log; console.error = console.log = (...a) => lines.push(a.join(' '));
  let r;
  try {
    r = await run((host, m, p) => (host === 'api.stripe.com' && p.startsWith('/v1/subscriptions/search?'))
      ? { status: 400, body: JSON.stringify({ error: { type: 'invalid_request_error', message: 'Search is not available for your account.' } }) } : null);
  } finally { console.error = oe; console.log = ol; }
  check('search-off: the row\'s subscription was not cancelled', JSON.stringify(cancels(r)) === JSON.stringify([SUB]));
  check('search-off: not logged as STRIPE SEARCH UNAVAILABLE', lines.some(l => /STRIPE SEARCH UNAVAILABLE/.test(l)));
  check('search-off: false billing alarm', r.status === 200 && r.body.ok === true && !r.body.billingWarning, JSON.stringify(r.body));
}
// the search (or a re-read) failing → erasure continues; warned only if they could have been billed
for (const [label, fail] of [['search 500', (host, m, p) => (host === 'api.stripe.com' && p.startsWith('/v1/subscriptions/search?')) ? { status: 500, body: '{}' } : null],
                             ['search socket death', (host, m, p) => (host === 'api.stripe.com' && p.startsWith('/v1/subscriptions/search?')) ? { socketError: true } : null],
                             ['re-read 500', (host, m, p) => (host === 'api.stripe.com' && m === 'GET' && p === '/v1/subscriptions/sub_B') ? { status: 500, body: '{}' } : null]]) {
  SEARCH = [S('sub_B')]; LIVE = new Map([['sub_B', S('sub_B')]]);
  const r = await quiet(() => run(fail));
  check(`${label}: deletion stopped`, r.status === 200 && r.body.ok === true, 'status=' + r.status);
  check(`${label}: SILENT for a user with a subscription on the row`, typeof r.body.billingWarning === 'string', JSON.stringify(r.body));
  const rf = await quiet(() => run((host, m, p) => (m === 'GET' && p.startsWith('/rest/v1/user_plans?')) ? { status: 200, body: '[]' } : fail(host, m, p)));
  if (label === 're-read 500') {
    // Search DID list a live subscription for this user — that alone earns the warning
    check(`${label}: SILENT although search listed a live subscription`, rf.status === 200 && rf.body.ok === true && typeof rf.body.billingWarning === 'string', JSON.stringify(rf.body));
  } else {
    check(`${label}: false billing alarm for a user who never had billing`, rf.status === 200 && rf.body.ok === true && !rf.body.billingWarning, JSON.stringify(rf.body));
  }
}
SEARCH = []; LIVE = new Map();

if (fails.length) {
  console.error('FAIL — /api/delete-account mishandles the subscription:');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('PASS: stripe-cancel-on-delete — cancels before erasing the mapping, and never hides a failure to cancel');
