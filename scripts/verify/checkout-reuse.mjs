#!/usr/bin/env node
// GATE: checkout-reuse (v692) — create-checkout reuses the customer's Stripe customer, never sells a
// second subscription while the first is still alive in Stripe (dunning), fails CLOSED when it
// cannot tell, and the webhook keeps the subscription id on past_due so that refusal can happen.
//
// HOW IT CHECKS: it EXECUTES the real api/create-checkout.js and the real api/stripe-webhook.js on
// top of the REAL api/_usage.js. Only the network and the sign-in are fake: https.request is an
// in-process Stripe (events, subscriptions, checkout sessions) and an in-process PostgREST
// (user_plans), with switchable faults; _requireUser answers a fixed test user. No real key is
// read and any other host throws. Every arm has its opposite.
//
// Run:  node scripts/verify/checkout-reuse.mjs
// EXPECT: CHECKOUT SAFE
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import querystring from 'node:querystring';

const WALL = setTimeout(() => { console.error('checkout-reuse: WALL CLOCK (60 s) — a handler hung'); process.exit(3); }, 60000);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require_ = createRequire(import.meta.url);

process.env.SUPABASE_URL = 'https://checkout-reuse-gate.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'gate-fake-service-role';
process.env.STRIPE_SECRET_KEY = 'sk_test_checkout_reuse_gate';
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
};
function reset() {
  net.plans.clear(); net.events.clear(); net.subs.clear(); net.invoices.clear(); net.fault = {}; net.sessions.length = 0;
  net.subReads = 0; net.subPaths.length = 0; net.open.clear(); net.listCalls = 0; net.expired.length = 0; net.onPatch = null; net.searchCalls = 0;
  net.searchVersions = []; net.versionLeak = null;
  net.searchOverride = null; net.customers.clear(); net.customerCreates.length = 0; net.invoiceCalls = 0;
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
        else if (opts.hostname === 'checkout-reuse-gate.invalid') out = postgrest(opts, payload);
        else throw new Error('checkout-reuse: unexpected outbound host ' + opts.hostname + ' — refusing the network');
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

// C1. a stored customer is reused: `customer`, never `customer_email` (Checkout forbids both)
reset();
setRow({ stripe_customer_id: 'cus_A' });
const c1 = await buy('pro');
const f1 = net.sessions[0] || {};
ck(c1.code === 200 && c1.body.url && net.sessions.length === 1, `C1: checkout for a returning customer answered ${c1.code} with ${net.sessions.length} session(s)`);
ck(f1.customer === 'cus_A' && !('customer_email' in f1), `C1: the session was created with customer=${f1.customer} customer_email=${f1.customer_email} — a new duplicate Stripe customer`);
ck(f1['subscription_data[metadata][user_id]'] === 'user-a' && f1['metadata[user_id]'] === 'user-a' && f1.client_reference_id === 'user-a',
  'C1: the user_id metadata was dropped from the session or its subscription — the webhook could not find the buyer');
ck(f1['line_items[0][price]'] === 'price_cr_pro' && f1.mode === 'subscription', 'C1: the session lost its price or mode');

// C2. (v692 round 3) no stored customer → the customer is created FIRST (idempotent per user), stored
//     on the row, and the session is created for it — never a bare customer_email any more
for (const [label, setup] of [['no customer on the row', () => setRow({ plan: 'trial' })], ['no row at all', () => {}]]) {
  reset();
  setup();
  const c2 = await buy('agency');
  const f2 = net.sessions[0] || {};
  const cc = net.customerCreates[0] || {};
  ck(c2.code === 200 && net.sessions.length === 1 && net.customerCreates.length === 1 && f2.customer === 'cus_new_1' && !('customer_email' in f2),
    `C2: ${label}: answered ${c2.code}, creates=${net.customerCreates.length}, customer=${f2.customer}, customer_email=${f2.customer_email}`);
  ck(cc.key && cc.key.includes('user-a') && cc.form['metadata[user_id]'] === 'user-a' && cc.form.email === USER.email,
    `C2: ${label}: the customer was created without an idempotency key / user_id metadata / email (${JSON.stringify(cc)})`);
  ck(row() && row().stripe_customer_id === 'cus_new_1', `C2: ${label}: the new customer was not stored on the row (${row() && row().stripe_customer_id})`);
  ck(f2['line_items[0][price]'] === 'price_cr_agency', `C2: ${label}: wrong price ${f2['line_items[0][price]']}`);
}
// two tabs of a FIRST purchase: one customer, and the second tab expires the first tab's session
reset();
setRow({ plan: 'trial' });
await buy('pro');
await buy('pro');
ck(new Set(net.sessions.map((f) => f.customer)).size === 1 && net.sessions[0].customer === 'cus_new_1',
  `C2: two first-purchase tabs got customers ${JSON.stringify(net.sessions.map((f) => f.customer))} — two customers, and neither tab can expire the other`);
ck(net.open.get('cs_cr_1').status === 'expired' && net.open.get('cs_cr_2').status === 'open', 'C2: the first tab of a first purchase is still payable after the second');
// racing tabs (both before either stores): the idempotency key gives both the same customer
reset();
setRow({ plan: 'trial' });
{
  // two captures interleave here, so the real console is saved and put back around both
  const saved = [console.error, console.log, console.warn];
  try { await Promise.all([buy('pro'), buy('pro')]); } finally { [console.error, console.log, console.warn] = saved; }
}
ck(net.customerCreates.length === 2 && new Set(net.sessions.map((f) => f.customer)).size === 1 && row().stripe_customer_id === net.sessions[0].customer,
  `C2: racing first-purchase tabs ended on customers ${JSON.stringify(net.sessions.map((f) => f.customer))}, row=${row().stripe_customer_id}`);
// another request stored a customer between our create and our write → its id wins, row and session agree
reset();
setRow({ plan: 'trial' });
net.onPatch = (uid) => { net.plans.get(uid).stripe_customer_id = 'cus_winner'; };
const c2w = await buy('pro');
ck(c2w.code === 200 && row().stripe_customer_id === 'cus_winner' && net.sessions[0] && net.sessions[0].customer === 'cus_winner',
  `C2: a customer stored first by another request was overwritten or not used (row=${row().stripe_customer_id}, session=${net.sessions[0] && net.sessions[0].customer})`);
// the customer create fails → today's behaviour (email), never a blocked purchase
reset();
setRow({ plan: 'trial' });
net.fault.customer = 'http500';
const c2f = await buy('pro');
ck(c2f.code === 200 && net.sessions.length === 1 && net.sessions[0].customer_email === USER.email && !('customer' in net.sessions[0]) && c2f.lines.some((l) => /could not create a Stripe customer/.test(l)),
  `C2: a failed customer create answered ${c2f.code} or did not fall back to the email`);
// storing it fails → still used for this session (logged); the grant stores it later
reset();
setRow({ plan: 'trial' });
net.fault.patch = 'http500';
const c2s = await buy('pro');
ck(c2s.code === 200 && net.sessions[0] && net.sessions[0].customer === 'cus_new_1' && c2s.lines.some((l) => /could not store Stripe customer/.test(l)),
  `C2: a failed customer store answered ${c2s.code}, session customer=${net.sessions[0] && net.sessions[0].customer}`);

// C3. the stored customer no longer exists in Stripe → exactly one retry, with the email, logged
reset();
setRow({ stripe_customer_id: 'cus_gone' });
const c3 = await buy('pro');
ck(c3.code === 200 && net.sessions.length === 2, `C3: a deleted stored customer answered ${c3.code} after ${net.sessions.length} session attempt(s) (want 200 after 2)`);
ck(net.sessions[0] && net.sessions[0].customer === 'cus_gone' && net.sessions[1] && net.sessions[1].customer_email === USER.email && !('customer' in net.sessions[1]),
  'C3: the retry did not switch from the stored customer to the email');
ck(net.sessions[1] && net.sessions[1]['subscription_data[metadata][user_id]'] === 'user-a', 'C3: the retry lost the user_id metadata');
ck(c3.lines.some((l) => l.includes('cus_gone') && !l.includes(USER.email)), 'C3: the fallback to a new customer was not logged by id (or logged the email)');
// opposite: any OTHER Stripe error is not retried and keeps today's 500
for (const mode of ['http500', 'http400', 'net']) {
  reset();
  setRow({ stripe_customer_id: 'cus_A' });
  net.fault.session = mode;
  const c3o = await buy('pro');
  ck(c3o.code === 500 && net.sessions.length === 1, `C3: a "${mode}" session error answered ${c3o.code} after ${net.sessions.length} attempt(s) (want 500 after exactly 1 — no retry)`);
}

// C4. DUNNING: the row is free but still holds a subscription Stripe is retrying → 409 payment_issue, no session
for (const st of ['past_due', 'unpaid', 'incomplete', 'paused']) {
  reset();
  setRow({ stripe_customer_id: 'cus_A', stripe_subscription_id: 'sub_A' });
  net.subs.set('sub_A', SUB({ status: st }));
  const c4 = await buy('pro');
  ck(c4.code === 409 && c4.body.code === 'payment_issue' && net.sessions.length === 0,
    `C4: a "${st}" subscription answered ${c4.code} ${c4.body.code} and created ${net.sessions.length} session(s) — a second subscription while Stripe retries the first card`);
  ck(/Manage plan & billing/.test(c4.body.error || '') && /card/i.test(c4.body.error || ''), `C4: "${st}": the message does not tell the user to update their card in Manage plan & billing`);
}
// C5. the read of that subscription fails → 503, no session (fail CLOSED)
for (const mode of ['http500', 'http429', 'http401', 'net', 'timeout', 'garbage200']) {
  reset();
  setRow({ stripe_customer_id: 'cus_A', stripe_subscription_id: 'sub_A' });
  net.subs.set('sub_A', SUB({ status: 'past_due' }));
  net.fault.sub = mode;
  const c5 = await buy('pro');
  ck(c5.code === 503 && net.sessions.length === 0, `C5: the subscription read failed with "${mode}" and checkout answered ${c5.code} with ${net.sessions.length} session(s) — must fail closed`);
}
// C6. opposite of C4/C5: an ENDED subscription (or one Stripe no longer has) → checkout allowed, same customer
for (const st of ['canceled', 'incomplete_expired', 'absent']) {
  reset();
  setRow({ stripe_customer_id: 'cus_A', stripe_subscription_id: 'sub_A' });
  if (st !== 'absent') net.subs.set('sub_A', SUB({ status: st }));
  const c6 = await buy('pro');
  ck(c6.code === 200 && net.sessions.length === 1 && net.sessions[0].customer === 'cus_A' && net.subReads === 1,
    `C6: an ended ("${st}") subscription answered ${c6.code} with ${net.sessions.length} session(s) — a returning customer could not buy again`);
}
// C7. a paid active row → the existing 409 already_subscribed, no session (opposite: C1)
reset();
setRow({ plan: 'pro', stripe_customer_id: 'cus_A', stripe_subscription_id: 'sub_A' });
net.subs.set('sub_A', SUB());
const c7 = await buy('agency');
ck(c7.code === 409 && c7.body.code === 'already_subscribed' && c7.body.manageBilling === true && net.sessions.length === 0,
  `C7: a paying customer answered ${c7.code} ${c7.body.code} with ${net.sessions.length} session(s)`);
// a free row whose subscription is (again) active in Stripe is also already subscribed
reset();
setRow({ stripe_customer_id: 'cus_A', stripe_subscription_id: 'sub_A' });
net.subs.set('sub_A', SUB());
const c7b = await buy('pro');
ck(c7b.code === 409 && c7b.body.code === 'already_subscribed' && net.sessions.length === 0,
  `C7: a free row with a live active subscription answered ${c7b.code} ${c7b.body.code} with ${net.sessions.length} session(s)`);

// E. END TO END through the real webhook: past_due keeps the id → checkout refuses; the card
//    recovers → re-granted; Stripe finally cancels → id cleared → checkout allowed, same customer
reset();
setRow({ plan: 'pro', stripe_customer_id: 'cus_A', stripe_subscription_id: 'sub_A', current_period_end: new Date(PERIOD * 1000).toISOString() });
net.subs.set('sub_A', SUB({ status: 'past_due' }));
const e1 = await deliver('customer.subscription.updated', SUB({ status: 'past_due' }));
ck(ok2(e1) && row().plan === 'free' && row().stripe_subscription_id === 'sub_A' && row().stripe_customer_id === 'cus_A',
  `E: past_due answered ${e1.code} and left plan=${row().plan} sub=${row().stripe_subscription_id} customer=${row().stripe_customer_id} (want free, sub_A, cus_A)`);
const e2 = await buy('pro');
ck(e2.code === 409 && e2.body.code === 'payment_issue' && net.sessions.length === 0, `E: during dunning checkout answered ${e2.code} ${e2.body.code} — charged twice`);
net.subs.set('sub_A', SUB());
const e3 = await deliver('customer.subscription.updated', SUB());
ck(ok2(e3) && row().plan === 'pro' && row().stripe_subscription_id === 'sub_A', `E: the card recovered and updated(active) left plan=${row().plan}`);
net.subs.set('sub_A', SUB({ status: 'past_due' }));
await deliver('customer.subscription.updated', SUB({ status: 'past_due' }));
net.subs.set('sub_A', SUB({ status: 'canceled' }));
const e4 = await deliver('customer.subscription.deleted', SUB({ status: 'canceled' }));
ck(ok2(e4) && row().plan === 'free' && !row().stripe_subscription_id && row().stripe_customer_id === 'cus_A',
  `E: the final cancellation left plan=${row().plan} sub=${row().stripe_subscription_id} customer=${row().stripe_customer_id} (want free, cleared, cus_A)`);
const e5 = await buy('pro');
ck(e5.code === 200 && net.sessions.length === 1 && net.sessions[0].customer === 'cus_A', `E: after the subscription ended checkout answered ${e5.code} — the customer could not come back`);

// D. documented: a plan row we could not read keeps today's behaviour (no double-subscription check,
//    first purchase with the email) — it must never block sales. Opposite: C1.
reset();
setRow({ stripe_customer_id: 'cus_A', stripe_subscription_id: 'sub_A' });
net.fault.rowread = 'http500';
const d1 = await buy('pro');
ck(d1.code === 200 && net.sessions.length === 1 && net.sessions[0].customer_email === USER.email && net.subReads === 0 && net.customerCreates.length === 0,
  `D: an unreadable plan row answered ${d1.code} (documented: proceed with the email)`);

// ── v692 round 2 ─────────────────────────────────────────────────────────────
// P. an unpaid subscription is not fixed by a new card: the OPEN invoice's payment page comes back as
//    payUrl (never `url`, which app.html would follow as a checkout redirect). Round 3: the invoice is
//    found by subscription + status=open — after a period, an unpaid subscription's LATEST invoice is a
//    draft, and the one to pay is an older open one.
const INV = (id, over) => Object.assign({ id, object: 'invoice', subscription: 'sub_A', status: 'open', created: now() - 40 * 86400,
  hosted_invoice_url: 'https://invoice.stripe.com/i/acct_x/' + id }, over || {});
for (const st of ['past_due', 'unpaid']) {
  reset();
  setRow({ stripe_customer_id: 'cus_A', stripe_subscription_id: 'sub_A' });
  net.subs.set('sub_A', SUB({ status: st, latest_invoice: 'in_draft' }));
  net.invoices.set('in_open', INV('in_open'));
  net.invoices.set('in_draft', INV('in_draft', { status: 'draft', created: now() - 3 * 86400, hosted_invoice_url: null }));
  net.invoices.set('in_other', INV('in_other', { subscription: 'sub_Z', created: now() - 86400 }));
  const p1 = await buy('pro');
  ck(p1.code === 409 && p1.body.code === 'payment_issue' && p1.body.payUrl === 'https://invoice.stripe.com/i/acct_x/in_open' && net.sessions.length === 0,
    `P: "${st}" whose latest invoice is a DRAFT answered ${p1.code} ${p1.body.code} payUrl=${p1.body.payUrl} sessions=${net.sessions.length} (want the older OPEN invoice)`);
  ck(/Pay your open invoice/.test(p1.body.error || '') && !('url' in p1.body) && p1.body.manageBilling === true && p1.body.status === st,
    `P: "${st}": the open-invoice refusal has the wrong text or shape (${JSON.stringify(p1.body)})`);
}
// opposites: only paid invoices, no invoices, a non-https link, or a status where paying is not the fix → no payUrl
for (const [label, st, invs] of [['only paid invoices', 'past_due', [INV('in_A', { status: 'paid' })]],
                                 ['no invoices', 'unpaid', []],
                                 ['a non-https invoice link', 'unpaid', [INV('in_A', { hosted_invoice_url: 'javascript:alert(1)' })]],
                                 ['an incomplete subscription', 'incomplete', [INV('in_A')]]]) {
  reset();
  setRow({ stripe_customer_id: 'cus_A', stripe_subscription_id: 'sub_A' });
  net.subs.set('sub_A', SUB({ status: st }));
  for (const i of invs) net.invoices.set(i.id, i);
  const p2 = await buy('pro');
  ck(p2.code === 409 && p2.body.code === 'payment_issue' && !('payUrl' in p2.body) && /update your card/i.test(p2.body.error || '') && net.sessions.length === 0,
    `P: ${label}: answered ${p2.code} ${JSON.stringify(p2.body)} — want payment_issue with the update-your-card text and no payUrl`);
  if (st === 'incomplete') ck(net.invoiceCalls === 0, 'P: an incomplete subscription looked up invoices');
}
// the invoice lookup failing is a 503, never a refusal without the link and never a checkout
for (const mode of ['http500', 'net', 'garbage200']) {
  reset();
  setRow({ stripe_customer_id: 'cus_A', stripe_subscription_id: 'sub_A' });
  net.subs.set('sub_A', SUB({ status: 'unpaid' }));
  net.invoices.set('in_open', INV('in_open'));
  net.fault.invoices = mode;
  const p3 = await buy('pro');
  ck(p3.code === 503 && net.sessions.length === 0 && !('payUrl' in p3.body), `P: a "${mode}" invoice lookup answered ${p3.code} with ${net.sessions.length} session(s)`);
}

// S. (round 3) a live subscription the row does NOT hold (a second tab's, maybe on a second customer)
//    blocks a new checkout — found by Stripe Search on the user_id metadata
for (const [label, other, want] of [['active', SUB({ id: 'sub_B', customer: 'cus_B' }), 'already_subscribed'],
                                    ['trialing', SUB({ id: 'sub_B', customer: 'cus_B', status: 'trialing' }), 'already_subscribed'],
                                    ['past_due', SUB({ id: 'sub_B', customer: 'cus_B', status: 'past_due' }), 'payment_issue']]) {
  reset();
  setRow({ stripe_customer_id: 'cus_A' });
  net.subs.set('sub_A', SUB({ status: 'canceled' }));
  net.subs.set('sub_B', other);
  if (label === 'past_due') net.invoices.set('in_B', INV('in_B', { subscription: 'sub_B' }));
  const s1 = await buy('pro');
  ck(s1.code === 409 && s1.body.code === want && net.sessions.length === 0,
    `S: an untracked ${label} subscription on another customer answered ${s1.code} ${s1.body.code} with ${net.sessions.length} session(s) — a third subscription was sold`);
  if (label === 'past_due') ck(s1.body.payUrl === 'https://invoice.stripe.com/i/acct_x/in_B', `S: the untracked past_due subscription's open invoice was not offered (${s1.body.payUrl})`);
}
// opposites: another USER's live subscription, and a stale search hit that is canceled when re-read → checkout allowed
reset();
setRow({ stripe_customer_id: 'cus_A' });
net.subs.set('sub_Z', SUB({ id: 'sub_Z', customer: 'cus_Z', metadata: { user_id: 'user-z', plan: 'pro' } }));
const s2 = await buy('pro');
ck(s2.code === 200 && net.sessions.length === 1, `S: another user's subscription blocked this user's checkout (${s2.code})`);
reset();
setRow({ stripe_customer_id: 'cus_A' });
net.subs.set('sub_B', SUB({ id: 'sub_B', customer: 'cus_B', status: 'canceled' }));
net.searchOverride = [SUB({ id: 'sub_B', customer: 'cus_B' })];           // the index still says active
const s3 = await buy('pro');
ck(s3.code === 200 && net.sessions.length === 1, `S: a stale search hit (canceled when re-read) blocked checkout (${s3.code})`);
// the search failing is a 503 — never "nothing found"
for (const mode of ['http500', 'net', 'timeout', 'garbage200']) {
  reset();
  setRow({ stripe_customer_id: 'cus_A' });
  net.fault.search = mode;
  const s4 = await buy('pro');
  ck(s4.code === 503 && net.sessions.length === 0, `S: a "${mode}" search failure answered ${s4.code} with ${net.sessions.length} session(s) — must fail closed`);
}

// X. two tabs: a returning customer's older OPEN checkout sessions are expired before a new one
reset();
setRow({ stripe_customer_id: 'cus_A' });
net.open.set('cs_old_1', { id: 'cs_old_1', status: 'open', mode: 'subscription', customer: 'cus_A' });
net.open.set('cs_other_cus', { id: 'cs_other_cus', status: 'open', mode: 'subscription', customer: 'cus_Z' });
net.open.set('cs_old_done', { id: 'cs_old_done', status: 'complete', mode: 'subscription', customer: 'cus_A' });
const x1 = await buy('pro');
ck(x1.code === 200 && net.sessions.length === 1 && net.expired.length === 1 && net.expired[0] === 'cs_old_1',
  `X: the older open session was not expired (answered ${x1.code}, expired=${JSON.stringify(net.expired)}) — two tabs can still both be paid`);
ck(net.open.get('cs_other_cus').status === 'open' && net.open.get('cs_old_done').status === 'complete', 'X: a session of ANOTHER customer, or one already complete, was touched');
ck(net.open.get('cs_cr_1') && net.open.get('cs_cr_1').status === 'open', 'X: the NEW session was expired');
// a second click expires the first new session and leaves only the newest payable
const x1b = await buy('pro');
ck(x1b.code === 200 && net.open.get('cs_cr_1').status === 'expired' && net.open.get('cs_cr_2').status === 'open', 'X: a second click left the first new session payable');
// a failure to list or to expire never blocks the purchase, and is logged
for (const kind of ['list', 'expire']) {
  for (const mode of ['http500', 'net', 'timeout']) {
    reset();
    setRow({ stripe_customer_id: 'cus_A' });
    net.open.set('cs_old_1', { id: 'cs_old_1', status: 'open', mode: 'subscription', customer: 'cus_A' });
    net.fault[kind] = mode;
    const x2 = await buy('pro');
    ck(x2.code === 200 && net.sessions.length === 1 && x2.lines.some((l) => /could not (list|expire)/.test(l)),
      `X: a "${mode}" failure to ${kind} answered ${x2.code} with ${net.sessions.length} session(s) or left no log line — housekeeping blocked a purchase`);
  }
}
// round 3: a first purchase now has a customer too, so its other open sessions are listed as well;
// opposite: an unreadable row makes no customer and lists nothing (email only, documented)
reset();
setRow({ plan: 'trial' });
const x3 = await buy('pro');
ck(x3.code === 200 && net.listCalls === 1, `X: a first purchase listed sessions ${net.listCalls} time(s) (want 1 — for the customer just made)`);
reset();
setRow({ plan: 'trial' });
net.fault.rowread = 'http500';
const x3o = await buy('pro');
ck(x3o.code === 200 && net.listCalls === 0 && net.customerCreates.length === 0, `X: an unreadable row listed sessions (${net.listCalls}) or made a customer (${net.customerCreates.length})`);

// K. checkout-confirm: the re-check after its write, and the double-subscription rule
const CS = (over) => Object.assign({ id: 'cs_K', object: 'checkout.session', status: 'complete', payment_status: 'paid', mode: 'subscription',
  created: now() - 30, customer: 'cus_A', subscription: 'sub_A', metadata: { user_id: 'user-a', plan: 'pro' } }, over || {});
// K1. a cancellation lands between the live check and the write → the grant is undone
reset();
setRow({ stripe_customer_id: 'cus_A' });
net.subs.set('sub_A', SUB());
net.open.set('cs_K', CS());
net.onPatch = (uid, body) => { if (body.plan === 'pro') net.subs.set('sub_A', SUB({ status: 'canceled' })); };
const k1 = await confirm('cs_K');
ck(k1.code === 403 && row().plan === 'free' && !row().stripe_subscription_id,
  `K1: a confirm that raced a cancellation answered ${k1.code} and left plan=${row().plan} sub=${row().stripe_subscription_id} — paid access on a dead subscription`);
// opposite: no race → granted and kept
reset();
setRow({ stripe_customer_id: 'cus_A' });
net.subs.set('sub_A', SUB());
net.open.set('cs_K', CS());
const k1o = await confirm('cs_K');
ck(k1o.code === 200 && k1o.body.ok === true && row().plan === 'pro' && row().stripe_subscription_id === 'sub_A', `K1: a normal confirm answered ${k1o.code}, plan=${row().plan}`);
// K2. the re-read after the write fails → 503 (the webhook's own grant decides), never "ok"
reset();
setRow({ stripe_customer_id: 'cus_A' });
net.subs.set('sub_A', SUB());
net.open.set('cs_K', CS());
net.onPatch = () => { net.fault.sub = 'http500'; };
const k2 = await confirm('cs_K');
ck(k2.code === 503 && k2.body.ok !== true, `K2: a confirm whose re-read failed answered ${k2.code} ${JSON.stringify(k2.body)}`);
// K3. two live subscriptions: the row keeps the one that is paying; the duplicate is logged, not written
reset();
setRow({ plan: 'pro', stripe_customer_id: 'cus_A', stripe_subscription_id: 'sub_A' });
net.subs.set('sub_A', SUB());
net.subs.set('sub_B', SUB({ id: 'sub_B' }));
net.open.set('cs_K', CS({ subscription: 'sub_B' }));
const k3 = await confirm('cs_K');
ck(k3.code === 409 && k3.body.doubleSubscription === true && row().stripe_subscription_id === 'sub_A' && row().plan === 'pro',
  `K3: a second paid subscription answered ${k3.code} and left sub=${row().stripe_subscription_id} — the paying sub_A is no longer tracked`);
ck(k3.lines.some((l) => /DOUBLE SUBSCRIPTION/.test(l) && l.includes('sub_A') && l.includes('sub_B')), 'K3: the double subscription was not logged with both ids');
// opposite: the row's subscription is failing (past_due) → the new, paying one takes over (and is logged)
reset();
setRow({ plan: 'free', stripe_customer_id: 'cus_A', stripe_subscription_id: 'sub_A' });
net.subs.set('sub_A', SUB({ status: 'past_due' }));
net.subs.set('sub_B', SUB({ id: 'sub_B' }));
net.open.set('cs_K', CS({ subscription: 'sub_B' }));
const k3o = await confirm('cs_K');
ck(k3o.code === 200 && row().plan === 'pro' && row().stripe_subscription_id === 'sub_B' && k3o.lines.some((l) => /DOUBLE SUBSCRIPTION/.test(l)),
  `K3: a new paying subscription over a failing one answered ${k3o.code}, sub=${row().stripe_subscription_id}`);
// opposite: the row's subscription has ended → a normal grant, no DOUBLE line
reset();
setRow({ plan: 'free', stripe_customer_id: 'cus_A', stripe_subscription_id: 'sub_A' });
net.subs.set('sub_A', SUB({ status: 'canceled' }));
net.subs.set('sub_B', SUB({ id: 'sub_B' }));
net.open.set('cs_K', CS({ subscription: 'sub_B' }));
const k3e = await confirm('cs_K');
ck(k3e.code === 200 && row().stripe_subscription_id === 'sub_B' && !k3e.lines.some((l) => /DOUBLE SUBSCRIPTION/.test(l)),
  `K3: a new subscription after the old one ENDED answered ${k3e.code} or was logged as a double`);
// the row's subscription cannot be read → 503, nothing written
reset();
setRow({ plan: 'pro', stripe_customer_id: 'cus_A', stripe_subscription_id: 'sub_A' });
net.subs.set('sub_B', SUB({ id: 'sub_B' }));
net.open.set('cs_K', CS({ subscription: 'sub_B' }));
net.subs.set('sub_A', SUB());
const readsBefore = net.subReads;
net.onPatch = null;
// fail only the read of sub_A (the one on the row): sub_B's pre-check must still succeed
const realStripeSubs = net.subs.get.bind(net.subs);
net.subs.get = (id) => { if (id === 'sub_A') throw new Error('sub_A read fault'); return realStripeSubs(id); };
const k4 = await confirm('cs_K');
net.subs.get = realStripeSubs;
ck(k4.code === 503 && row().stripe_subscription_id === 'sub_A', `K4: the row's subscription could not be read and confirm answered ${k4.code}, sub=${row().stripe_subscription_id} (reads ${net.subReads - readsBefore})`);

// ── v692 round 4 ─────────────────────────────────────────────────────────────
const SEARCH_OFF = [
  ['search not available', { status: 400, body: { error: { type: 'invalid_request_error', message: 'Search is not available for your account.' } } }],
  ['search needs a newer API version', { status: 400, body: { error: { type: 'invalid_request_error', message: 'The Search API requires API version 2020-08-27 or later.' } } }],
  ['search not enabled (403)', { status: 403, body: { error: { type: 'invalid_request_error', message: 'Search is not enabled for this account.' } } }],
];
const SEARCH_BROKEN = [
  ['an unrelated 400', { status: 400, body: { error: { type: 'invalid_request_error', message: 'Invalid query: unknown field.' } } }],
  ['a "search unavailable" 500', { status: 500, body: { error: { type: 'invalid_request_error', message: 'Search is not available right now.' } } }],
  ['a "search unavailable" api_error', { status: 400, body: { error: { type: 'api_error', message: 'Search is not available for your account.' } } }],
  ['a 429', { status: 429, body: { error: { type: 'invalid_request_error', message: 'Search rate limit: not available, slow down.' } } }],
];
// U2. Search missing for this account → checkout proceeds on the row's own checks, logged
for (const [label, fault] of SEARCH_OFF) {
  reset();
  setRow({ stripe_customer_id: 'cus_A' });
  net.subs.set('sub_B', SUB({ id: 'sub_B', customer: 'cus_B' }));
  net.fault.search = fault;
  const u2 = await buy('pro');
  ck(u2.code === 200 && net.sessions.length === 1, `U2: ${label}: checkout answered ${u2.code} — a missing Search feature must not stop sales`);
  ck(u2.lines.filter((l) => /STRIPE SEARCH UNAVAILABLE/.test(l)).length === 1, `U2: ${label}: not logged exactly once as STRIPE SEARCH UNAVAILABLE`);
  // ...and the row's own checks still refuse
  reset();
  setRow({ stripe_customer_id: 'cus_A', stripe_subscription_id: 'sub_A' });
  net.subs.set('sub_A', SUB({ status: 'past_due' }));
  net.fault.search = fault;
  const u2r = await buy('pro');
  ck(u2r.code === 409 && u2r.body.code === 'payment_issue' && net.sessions.length === 0, `U2: ${label}: the row's own dunning check stopped refusing (${u2r.code})`);
}
// opposites: anything else stays a 503
for (const [label, fault] of SEARCH_BROKEN) {
  reset();
  setRow({ stripe_customer_id: 'cus_A' });
  net.fault.search = fault;
  const u2o = await buy('pro');
  ck(u2o.code === 503 && net.sessions.length === 0 && !u2o.lines.some((l) => /STRIPE SEARCH UNAVAILABLE/.test(l)),
    `U2: ${label}: checkout answered ${u2o.code} with ${net.sessions.length} session(s) — only a clear "search unavailable" may skip the check`);
}
// the search call (and only it) pins Stripe-Version 2024-06-20
reset();
setRow({ stripe_customer_id: 'cus_A', stripe_subscription_id: 'sub_A' });
net.subs.set('sub_A', SUB({ status: 'canceled' }));
await buy('pro');
ck(net.searchVersions.length === 1 && net.searchVersions[0] === '2024-06-20', `U2: the search call sent Stripe-Version ${JSON.stringify(net.searchVersions)} (want 2024-06-20)`);
ck(!net.versionLeak, `U2: a non-search call pinned a Stripe-Version (${net.versionLeak})`);

// ── v692 round 5 ─────────────────────────────────────────────────────────────
// N6b. the index hands back ANOTHER user's live subscription → this user's checkout is not refused for it
reset();
setRow({ stripe_customer_id: 'cus_A' });
net.subs.set('sub_Z', SUB({ id: 'sub_Z', customer: 'cus_Z', metadata: { user_id: 'user-z', plan: 'pro' } }));
net.searchOverride = [SUB({ id: 'sub_Z', customer: 'cus_Z', metadata: { user_id: 'user-z', plan: 'pro' } })];
const n6b = await buy('pro');
ck(n6b.code === 200 && net.sessions.length === 1, `N6b: another user's search hit refused this user's checkout (${n6b.code} ${n6b.body.code})`);
// opposite: the same hit for THIS user refuses
reset();
setRow({ stripe_customer_id: 'cus_A' });
net.subs.set('sub_Z', SUB({ id: 'sub_Z', customer: 'cus_Z' }));
net.searchOverride = [SUB({ id: 'sub_Z', customer: 'cus_Z' })];
const n6bo = await buy('pro');
ck(n6bo.code === 409 && net.sessions.length === 0, `N6b: this user's own live hit did not refuse (${n6bo.code})`);

https.request = realRequest;
clearTimeout(WALL);
if (fails.length) {
  console.error('FAIL: checkout-reuse');
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}
console.log('checkout-reuse: every arm and its opposite held');
console.log('CHECKOUT SAFE');
