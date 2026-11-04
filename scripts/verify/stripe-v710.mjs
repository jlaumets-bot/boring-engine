#!/usr/bin/env node
// GATE: stripe-v710 — (1) a €0 checkout (100%-off promotion code, payment_status
// 'no_payment_required') grants the plan through checkout-confirm, but ONLY for a complete
// subscription checkout of this user whose subscription is active/trialing in Stripe right now;
// 'unpaid', open, non-subscription or dead-subscription sessions grant nothing. (2) The billing
// period end is read from the first subscription item when the subscription has no top-level
// current_period_end (newer Stripe API versions), so the row keeps its allowance anchor.
//
// HOW IT CHECKS: it EXECUTES the real api/checkout-confirm.js and api/stripe-webhook.js on top of
// the REAL api/_usage.js. Only the network and the sign-in are fake (the harness is the one in
// checkout-reuse.mjs): https.request is an in-process Stripe + PostgREST, _requireUser answers a
// fixed test user. No real key is read and any other host throws. Every arm has its opposite.
//
// Run:  node scripts/verify/stripe-v710.mjs
// EXPECT: STRIPE V710 OK
// EXPECT: CHECKOUT SAFE
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import querystring from 'node:querystring';

const WALL = setTimeout(() => { console.error('stripe-v710: WALL CLOCK (60 s) — a handler hung'); process.exit(3); }, 60000);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require_ = createRequire(import.meta.url);

process.env.SUPABASE_URL = 'https://stripe-v710-gate.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'gate-fake-service-role';
process.env.STRIPE_SECRET_KEY = 'sk_test_stripe_v710_gate';
process.env.STRIPE_PRICE_PRO = 'price_cr_pro';
process.env.STRIPE_PRICE_AGENCY = 'price_cr_agency';
delete process.env.STRIPE_PRICE_STARTER;

const fails = [];
const ck = (cond, msg) => { if (!cond) fails.push(msg); };

// ── fake network ─────────────────────────────────────────────────────────────
const https = require_('node:https');
const realRequest = https.request;
const net = {
  plans: new Map(), events: new Map(), subs: new Map(), invoices: new Map(),
  fault: {},          // { sub, session, rowread, list, expire } -> mode
  sessions: [],       // every checkout-session POST form that reached Stripe
  subReads: 0, subPaths: [],
  open: new Map(),    // checkout sessions as Stripe holds them (for list / expire / confirm)
  listCalls: 0, expired: [], searchCalls: 0,
  searchOverride: null, // when set, Search answers this (a lagging index) instead of the live state
  customers: new Map(), customerCreates: [], invoiceCalls: 0,
  onPatch: null,      // (uid, body) => void — runs just BEFORE a PATCH lands (a concurrent delivery)
  patchLog: [],
};
function reset() {
  net.plans.clear(); net.events.clear(); net.subs.clear(); net.invoices.clear(); net.fault = {}; net.sessions.length = 0;
  net.subReads = 0; net.subPaths.length = 0; net.open.clear(); net.listCalls = 0; net.expired.length = 0; net.onPatch = null; net.searchCalls = 0;
  net.searchVersions = []; net.versionLeak = null;
  net.searchOverride = null; net.customers.clear(); net.customerCreates.length = 0; net.invoiceCalls = 0;
  net.patchLog = [];
}
const sp = (p) => new URL('https://h' + p).searchParams;
const eq = (q, k) => { const v = q.get(k); return v && v.startsWith('eq.') ? v.slice(3) : null; };
function faultReply(mode) {
  if (!mode) return null;
  // v692 round 4 — an exact Stripe error reply: { status, body }
  if (typeof mode === 'object') return { status: mode.status, body: JSON.stringify(mode.body) };
  const m = /^http(\d{3})$/.exec(mode);
  if (m) return { status: Number(m[1]), body: JSON.stringify({ error: { message: 'fault ' + mode } }) };
  if (mode === 'net') return { error: new Error('socket hang up (fault)') };
  if (mode === 'timeout') return { timeout: true };
  if (mode === 'garbage200') return { status: 200, body: '<html>502 Bad Gateway</html>' };
  return null;
}
function postgrest(o, payload) {
  const q = sp(o.path);
  if (o.path.split('?')[0] !== '/rest/v1/user_plans') return { status: 404, body: '{}' };
  if (o.method === 'GET') {
    const uid = eq(q, 'user_id');
    const f = faultReply(net.fault[uid ? 'rowread' : 'lookup']); if (f) return f;
    if (uid) { const r = net.plans.get(uid); return { status: 200, body: JSON.stringify(r ? [r] : []) }; }
    const bySub = eq(q, 'stripe_subscription_id'), byCus = eq(q, 'stripe_customer_id');
    const hit = [...net.plans.values()].filter((r) => (bySub && r.stripe_subscription_id === bySub) || (byCus && r.stripe_customer_id === byCus));
    return { status: 200, body: JSON.stringify(hit.map((r) => ({ user_id: r.user_id }))) };
  }
  if (o.method === 'POST') {
    const b = JSON.parse(payload);
    if (!net.plans.has(b.user_id)) net.plans.set(b.user_id, Object.assign({ plan: 'trial' }, b));
    return { status: 201, body: '' };
  }
  if (o.method === 'PATCH') {
    const uid = eq(q, 'user_id');
    net.patchLog.push(JSON.parse(payload));   // v710 — every plan write that reached the store
    { const f = faultReply(net.fault.patch); if (f) return f; }
    if (net.onPatch) { const h = net.onPatch; net.onPatch = null; h(uid, JSON.parse(payload)); }
    // like PostgREST: `stripe_customer_id=is.null` only matches a row that has none
    if (q.get('stripe_customer_id') === 'is.null' && net.plans.has(uid) && net.plans.get(uid).stripe_customer_id) return { status: 204, body: '' };
    if (net.plans.has(uid)) net.plans.set(uid, Object.assign({}, net.plans.get(uid), JSON.parse(payload)));
    return { status: 204, body: '' };
  }
  return { status: 405, body: '{}' };
}
function stripe(o, payload) {
  if ((o.headers || {})['Stripe-Version'] && !/^\/v1\/subscriptions\/search\?/.test(o.path)) net.versionLeak = o.path;
  let m = o.path.match(/^\/v1\/events\/([^?]+)$/);
  if (m && o.method === 'GET') {
    const e = net.events.get(decodeURIComponent(m[1]));
    return e ? { status: 200, body: JSON.stringify(e) } : { status: 404, body: JSON.stringify({ error: { message: 'No such event' } }) };
  }
  // v692 round 3 — Stripe Search by metadata user_id (the webhook's "another live subscription?")
  const msq = o.path.match(/^\/v1\/subscriptions\/search\?(.*)$/);
  if (msq && o.method === 'GET') {
    net.searchCalls++; { const f = faultReply(net.fault.search); if (f) return f; }
    net.searchVersions.push((o.headers || {})['Stripe-Version'] || null);
    const qq = new URLSearchParams(msq[1]).get('query') || '';
    const mu = /metadata\['user_id'\]:'((?:[^'\\]|\\.)*)'/.exec(qq);
    const uid = mu ? mu[1].replace(/\\(.)/g, '$1') : null;
    // an override is returned AS IS (a lagging or misbehaving index — round 5: even another user's hit)
    const data = net.searchOverride || [...net.subs.values()].filter((x) => x && x.metadata && x.metadata.user_id === uid);
    return { status: 200, body: JSON.stringify({ object: 'search_result', data, has_more: false }) };
  }
  m = o.path.match(/^\/v1\/subscriptions\/([^?]+)(\?.*)?$/);
  if (m && o.method === 'GET') {
    net.subReads++; net.subPaths.push(o.path);
    const f = faultReply(net.fault.sub); if (f) return f;
    let s = net.subs.get(decodeURIComponent(m[1]));
    if (!s) return { status: 404, body: JSON.stringify({ error: { code: 'resource_missing', param: 'id', message: 'No such subscription' } }) };
    // like Stripe: latest_invoice is an id unless the read asked to expand it
    const expand = new URLSearchParams((m[2] || '').slice(1)).getAll('expand[]').includes('latest_invoice');
    if (expand && typeof s.latest_invoice === 'string') s = Object.assign({}, s, { latest_invoice: net.invoices.get(s.latest_invoice) || null });
    return { status: 200, body: JSON.stringify(s) };
  }
  m = o.path.match(/^\/v1\/checkout\/sessions\?(.*)$/);
  if (m && o.method === 'GET') {
    net.listCalls++;
    const f = faultReply(net.fault.list); if (f) return f;
    const q = new URLSearchParams(m[1]);
    const data = [...net.open.values()].filter((x) => x.customer === q.get('customer') && (!q.get('status') || x.status === q.get('status')));
    return { status: 200, body: JSON.stringify({ object: 'list', data, has_more: false }) };
  }
  m = o.path.match(/^\/v1\/checkout\/sessions\/([^/?]+)\/expire$/);
  if (m && o.method === 'POST') {
    const f = faultReply(net.fault.expire); if (f) return f;
    const x = net.open.get(decodeURIComponent(m[1]));
    if (!x || x.status !== 'open') return { status: 400, body: JSON.stringify({ error: { message: 'Only open sessions can be expired' } }) };
    x.status = 'expired'; net.expired.push(x.id);
    return { status: 200, body: JSON.stringify(x) };
  }
  m = o.path.match(/^\/v1\/checkout\/sessions\/([^/?]+)$/);
  if (m && o.method === 'GET') {
    const x = net.open.get(decodeURIComponent(m[1]));
    return x ? { status: 200, body: JSON.stringify(x) } : { status: 404, body: JSON.stringify({ error: { message: 'No such checkout session' } }) };
  }
  if (o.path === '/v1/customers' && o.method === 'POST') {
    const form = querystring.parse(payload);
    const key = (o.headers || {})['Idempotency-Key'] || null;
    net.customerCreates.push({ key, form });
    const f = faultReply(net.fault.customer); if (f) return f;
    // like Stripe: the same Idempotency-Key returns the same customer
    if (key && net.customers.has(key)) return { status: 200, body: JSON.stringify(net.customers.get(key)) };
    const c = { id: 'cus_new_' + (net.customerCreates.length), object: 'customer', email: form.email || null, metadata: { user_id: form['metadata[user_id]'] } };
    if (key) net.customers.set(key, c);
    return { status: 200, body: JSON.stringify(c) };
  }
  m = o.path.match(/^\/v1\/invoices\?(.*)$/);
  if (m && o.method === 'GET') {
    net.invoiceCalls++;
    const f = faultReply(net.fault.invoices); if (f) return f;
    const q = new URLSearchParams(m[1]);
    const data = [...net.invoices.values()]
      .filter((x) => x.subscription === q.get('subscription') && (!q.get('status') || x.status === q.get('status')))
      .sort((a, b) => b.created - a.created)                       // newest first, like Stripe
      .slice(0, Number(q.get('limit')) || 10);
    return { status: 200, body: JSON.stringify({ object: 'list', data, has_more: false }) };
  }
  if (o.path === '/v1/checkout/sessions' && o.method === 'POST') {
    const form = querystring.parse(payload);
    net.sessions.push(form);
    const f = faultReply(net.fault.session); if (f) return f;
    if (form.customer === 'cus_gone') {
      return { status: 400, body: JSON.stringify({ error: { type: 'invalid_request_error', code: 'resource_missing', param: 'customer', message: "No such customer: 'cus_gone'" } }) };
    }
    if (form.customer && form.customer_email) {
      return { status: 400, body: JSON.stringify({ error: { message: 'You may only specify one of these parameters: customer, customer_email.' } }) };
    }
    const id = 'cs_cr_' + net.sessions.length;
    net.open.set(id, { id, object: 'checkout.session', status: 'open', mode: form.mode, customer: form.customer || null });
    return { status: 200, body: JSON.stringify({ id, url: 'https://checkout.stripe.com/c/pay/' + id }) };
  }
  return { status: 404, body: JSON.stringify({ error: { message: 'unmapped' } }) };
}
https.request = function (opts, cb) {
  const req = new EventEmitter();
  let payload = '', done = false;
  req.write = (c) => { payload += c; return true; };
  req.setTimeout = (ms, fn) => { if (typeof fn === 'function') req.on('timeout', fn); return req; };
  req.setHeader = () => req;
  req.destroy = (err) => { if (!done) { done = true; setImmediate(() => req.emit('error', err || new Error('destroyed'))); } return req; };
  req.end = () => {
    setImmediate(() => {
      let out;
      try {
        if (opts.hostname === 'api.stripe.com') out = stripe(opts, payload);
        else if (opts.hostname === 'stripe-v710-gate.invalid') out = postgrest(opts, payload);
        else throw new Error('stripe-v710: unexpected outbound host ' + opts.hostname + ' — refusing the network');
      } catch (e) { done = true; req.emit('error', e); return; }
      if (out.timeout) { req.emit('timeout'); return; }
      if (out.error) { done = true; req.emit('error', out.error); return; }
      done = true;
      const resp = new EventEmitter();
      resp.statusCode = out.status; resp.headers = {};
      cb(resp);
      setImmediate(() => { if (out.body) resp.emit('data', out.body); resp.emit('end'); });
    });
    return req;
  };
  return req;
};

// ── the real handlers (sign-in is the only stub) ─────────────────────────────
const USER = { id: 'user-a', email: 'buyer@example.test' };
{
  const p = require_.resolve(join(ROOT, 'api', '_requireUser.js'));
  require_.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: async () => USER };
}
const checkout = require_(join(ROOT, 'api', 'create-checkout.js'));
const confirmApi = require_(join(ROOT, 'api', 'checkout-confirm.js'));
const webhook = require_(join(ROOT, 'api', 'stripe-webhook.js'));

async function capture(fn) {
  const lines = [];
  const oe = console.error, ol = console.log, ow = console.warn;
  console.error = console.log = console.warn = (...a) => lines.push(a.map(String).join(' '));
  try { await fn(); } finally { console.error = oe; console.log = ol; console.warn = ow; }
  return lines;
}
const mkRes = () => ({ code: 0, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; }, setHeader() { return this; }, end() { return this; } });
async function buy(plan) {
  const res = mkRes();
  const lines = await capture(() => checkout({ method: 'POST', headers: { origin: 'https://contentshrimp.com' }, body: { plan: plan || 'pro' } }, res));
  return { code: res.code, body: res.body || {}, lines };
}
const now = () => Math.floor(Date.now() / 1000);
let n = 0;
async function deliver(type, obj) {
  const id = 'evt_cr_' + (++n);
  net.events.set(id, { id, object: 'event', type, livemode: false, created: now() - 5, data: { object: obj } });
  const res = mkRes();
  const lines = await capture(() => webhook({ method: 'POST', headers: {}, body: { id } }, res));
  return { code: res.code, body: res.body || {}, lines };
}
async function confirm(sessionId) {
  const res = mkRes();
  const lines = await capture(() => confirmApi({ method: 'POST', headers: { origin: 'https://contentshrimp.com' }, body: { sessionId } }, res));
  return { code: res.code, body: res.body || {}, lines };
}
const ok2 = (r) => r.code >= 200 && r.code < 300;
const row = () => net.plans.get('user-a') || null;
const PERIOD = now() + 30 * 86400;
const SUB = (over) => Object.assign({ id: 'sub_A', object: 'subscription', status: 'active', customer: 'cus_A', created: now() - 40 * 86400,
  current_period_end: PERIOD, items: { data: [{ price: { id: 'price_cr_pro' } }] }, metadata: { user_id: 'user-a', plan: 'pro' } }, over || {});
const setRow = (over) => net.plans.set('user-a', Object.assign({ user_id: 'user-a', plan: 'free', stripe_customer_id: null,
  stripe_subscription_id: null, current_period_end: null }, over || {}));

const iso = (s) => new Date(s * 1000).toISOString();
const proWrites = () => net.patchLog.filter((b) => b && b.plan && b.plan !== 'free').length;
const CS = (over) => Object.assign({ id: 'cs_V', object: 'checkout.session', status: 'complete', payment_status: 'no_payment_required',
  mode: 'subscription', created: now() - 30, customer: 'cus_A', subscription: 'sub_A', metadata: { user_id: 'user-a', plan: 'pro' } }, over || {});
function stage(sessionOver, subOver) {
  reset();
  setRow({ stripe_customer_id: 'cus_A' });
  if (subOver !== null) net.subs.set('sub_A', SUB(subOver));
  net.open.set('cs_V', CS(sessionOver));
}

// V1. €0 promo: complete + subscription + active → granted through the same write a paid session uses
stage({}, {});
const v1 = await confirm('cs_V');
ck(v1.code === 200 && v1.body.ok === true && row().plan === 'pro' && row().stripe_subscription_id === 'sub_A' && row().stripe_customer_id === 'cus_A',
  `V1: a complete €0 promo checkout on an active subscription answered ${v1.code} ${JSON.stringify(v1.body).slice(0, 160)}, plan=${row().plan} sub=${row().stripe_subscription_id}`);
// ...trialing counts as live too
stage({}, { status: 'trialing' });
const v1t = await confirm('cs_V');
ck(v1t.code === 200 && row().plan === 'pro', `V1: a €0 promo on a trialing subscription answered ${v1t.code}, plan=${row().plan}`);
// opposite: the paid path is unchanged
stage({ payment_status: 'paid' }, {});
const v1p = await confirm('cs_V');
ck(v1p.code === 200 && v1p.body.ok === true && row().plan === 'pro' && row().stripe_subscription_id === 'sub_A', `V1: a normal PAID confirm answered ${v1p.code}, plan=${row().plan}`);
// opposite: the paid path still needs a live subscription
stage({ payment_status: 'paid' }, { status: 'canceled' });
const v1pc = await confirm('cs_V');
ck(v1pc.code === 403 && row().plan === 'free' && proWrites() === 0, `V1: a PAID session on a canceled subscription answered ${v1pc.code}, plan=${row().plan}`);

// V2. €0 promo on a subscription that is not live → refused, and no paid plan is ever written
for (const [label, subOver] of [['incomplete', { status: 'incomplete' }], ['canceled', { status: 'canceled' }],
  ['past_due', { status: 'past_due' }], ['incomplete_expired', { status: 'incomplete_expired' }], ['gone from Stripe (404)', null]]) {
  stage({}, subOver);
  const v2 = await confirm('cs_V');
  // 403 (not live) or 503 (Stripe's 404 is a failed read there — fails closed): both refuse
  ck((v2.code === 403 || (subOver === null && v2.code === 503)) && v2.body.ok !== true && row().plan === 'free' && proWrites() === 0,
    `V2: a €0 promo on a ${label} subscription answered ${v2.code}, plan=${row().plan}, paid writes=${proWrites()}`);
}
// the subscription cannot be read → 503, nothing written
stage({}, {});
net.fault.sub = 'http500';
const v2r = await confirm('cs_V');
ck(v2r.code === 503 && proWrites() === 0, `V2: an unreadable subscription on a €0 promo answered ${v2r.code}, paid writes=${proWrites()}`);

// V3. no_payment_required WITHOUT the rest → nothing granted
for (const [label, over] of [['session still open', { status: 'open' }], ['session expired', { status: 'expired' }],
  ['a one-off payment checkout', { mode: 'payment' }], ['a setup checkout', { mode: 'setup' }],
  ['no subscription on the session', { subscription: null }]]) {
  stage(over, {});
  const v3 = await confirm('cs_V');
  ck(v3.body.ok !== true && row().plan === 'free' && proWrites() === 0,
    `V3: no_payment_required with ${label} answered ${v3.code} ${JSON.stringify(v3.body).slice(0, 120)}, plan=${row().plan}`);
}
// another user's €0 session → 403; a stale one → 403
stage({ metadata: { user_id: 'user-z', plan: 'pro' } }, {});
const v3u = await confirm('cs_V');
ck(v3u.code === 403 && proWrites() === 0, `V3: another user's €0 session answered ${v3u.code}`);
stage({ created: now() - 73 * 3600 }, {});
const v3s = await confirm('cs_V');
ck(v3s.code === 403 && proWrites() === 0, `V3: a 73-hour-old €0 session answered ${v3s.code} — the replay guard no longer applies to it`);

// V4. unpaid → refused, even on a complete session with an active subscription
for (const ps of ['unpaid', '', undefined]) {
  stage({ payment_status: ps }, {});
  const v4 = await confirm('cs_V');
  ck(v4.code === 200 && v4.body.ok === false && v4.body.pending === true && row().plan === 'free' && proWrites() === 0,
    `V4: payment_status=${JSON.stringify(ps)} answered ${v4.code} ${JSON.stringify(v4.body).slice(0, 120)}, plan=${row().plan}`);
}

// P1. the helper: top-level first, then the first item, otherwise null
const X = now() + 12 * 86400, Y = now() + 40 * 86400;
const spe = webhook.subPeriodEnd;
ck(typeof spe === 'function', 'P1: stripe-webhook no longer exports subPeriodEnd');
if (typeof spe === 'function') {
  ck(spe({ current_period_end: X, items: { data: [{ current_period_end: Y }] } }) === X, 'P1: the top-level current_period_end did not win');
  ck(spe({ items: { data: [{ current_period_end: Y }] } }) === Y, 'P1: with no top-level field the first item\'s current_period_end was not read');
  ck(spe({ items: { data: [] } }) === null && spe({}) === null && spe(null) === null && spe({ items: { data: [{}] } }) === null,
    'P1: a subscription with no period end anywhere did not give null');
}

// P2. behavioural: an `updated` event for a subscription with the period end only on its item
const NEWAPI = (over) => { const s = SUB(over); delete s.current_period_end; s.items = { data: [{ price: { id: 'price_cr_pro' }, current_period_end: X }] }; return s; };
reset();
setRow({ plan: 'pro', stripe_customer_id: 'cus_A', stripe_subscription_id: 'sub_A', current_period_end: null });
net.subs.set('sub_A', NEWAPI());
const p2 = await deliver('customer.subscription.updated', NEWAPI());
ck(ok2(p2) && row().plan === 'pro' && row().current_period_end === iso(X),
  `P2: an updated event on a new-API subscription answered ${p2.code}, row current_period_end=${row().current_period_end} (want ${iso(X)})`);
// opposite: an old-API subscription still reads the top-level field
reset();
setRow({ plan: 'pro', stripe_customer_id: 'cus_A', stripe_subscription_id: 'sub_A', current_period_end: null });
net.subs.set('sub_A', SUB({ current_period_end: Y }));
const p2o = await deliver('customer.subscription.updated', SUB({ current_period_end: Y }));
ck(ok2(p2o) && row().current_period_end === iso(Y), `P2: an old-API subscription wrote current_period_end=${row().current_period_end} (want ${iso(Y)})`);
// a downgrade on a new-API subscription carries the item's period end too
reset();
setRow({ plan: 'pro', stripe_customer_id: 'cus_A', stripe_subscription_id: 'sub_A', current_period_end: null });
net.subs.set('sub_A', NEWAPI({ status: 'past_due' }));
const p2d = await deliver('customer.subscription.updated', NEWAPI({ status: 'past_due' }));
ck(ok2(p2d) && row().plan === 'free' && row().current_period_end === iso(X), `P2: a past_due downgrade wrote current_period_end=${row().current_period_end} (want ${iso(X)})`);

// P3. the row moves to another live new-API subscription (grantFromLive) with that item's period end
reset();
setRow({ plan: 'pro', stripe_customer_id: 'cus_A', stripe_subscription_id: 'sub_A', current_period_end: null });
net.subs.set('sub_A', NEWAPI({ status: 'canceled' }));
net.subs.set('sub_B', NEWAPI({ id: 'sub_B' }));
const p3 = await deliver('customer.subscription.deleted', NEWAPI({ status: 'canceled' }));
ck(ok2(p3) && row().stripe_subscription_id === 'sub_B' && row().plan === 'pro' && row().current_period_end === iso(X),
  `P3: moving to another live subscription answered ${p3.code}, sub=${row().stripe_subscription_id}, current_period_end=${row().current_period_end} (want ${iso(X)})`);

// the hand-set comp plan (agency, no Stripe subscription) is still left alone by subscription events
reset();
setRow({ plan: 'agency', stripe_customer_id: 'cus_A', stripe_subscription_id: null, current_period_end: null });
net.subs.set('sub_old', NEWAPI({ id: 'sub_old', status: 'canceled', metadata: {} }));
const hc = await deliver('customer.subscription.deleted', NEWAPI({ id: 'sub_old', status: 'canceled', metadata: {} }));
ck(ok2(hc) && row().plan === 'agency' && proWrites() === 0 && net.patchLog.length === 0, `HAND: a late event for an old subscription touched the hand-set agency row (${hc.code}, plan=${row().plan})`);

https.request = realRequest;
clearTimeout(WALL);
if (fails.length) {
  console.error('FAIL: stripe-v710');
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}
console.log('stripe-v710: every arm and its opposite held');
console.log('STRIPE V710 OK');
