#!/usr/bin/env node
// GATE: rv-money-webhook — the Stripe webhook never answers 2xx for an event it did not apply,
// never answers non-2xx for an event retrying cannot help, and a late or repeated delivery never
// moves a plan the wrong way. (v691 review of the parked wip-stripe-webhook-money branch.)
//
// HOW IT CHECKS: it EXECUTES the real api/stripe-webhook.js on top of the REAL api/_usage.js.
// Only the network is fake: https.request is replaced by an in-process Stripe (events and
// subscriptions) and an in-process PostgREST (user_plans), each with switchable faults — a
// dropped socket, a timeout, an HTTP 4xx/5xx, a garbled 200, and a write that lands but whose
// answer is lost. No real key is read and any other host throws. Every arm has its opposite, so
// a handler that answers the same thing everywhere cannot pass.
//
// There is no Stripe-Signature check to test: this webhook authenticates by re-fetching the
// event by id with our own key (see the header of api/stripe-webhook.js), so the equivalent of a
// "bad signature" is a forged id or a forged body — both are covered in section H.
//
// Run:  node scripts/verify/rv-money-webhook.mjs
// EXPECT: WEBHOOK ACK HONEST
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const WALL = setTimeout(() => { console.error('rv-money-webhook: WALL CLOCK (60 s) — the handler hung'); process.exit(3); }, 60000);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require_ = createRequire(import.meta.url);

process.env.SUPABASE_URL = 'https://rv-money-gate.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'gate-fake-service-role';
const TEST_KEY = 'sk_test_rv_money_gate';
const LIVE_KEY = 'sk_live_rv_money_gate';
process.env.STRIPE_SECRET_KEY = TEST_KEY;
process.env.STRIPE_PRICE_PRO = 'price_rv_pro';
process.env.STRIPE_PRICE_AGENCY = 'price_rv_agency';
delete process.env.STRIPE_PRICE_STARTER;

const fails = [];
const ck = (cond, msg) => { if (!cond) fails.push(msg); };

// ── fake network ─────────────────────────────────────────────────────────────
const https = require_('node:https');
const realRequest = https.request;
const net = {
  plans: new Map(),     // user_id -> user_plans row
  events: new Map(),    // evt_ -> event
  subs: new Map(),      // sub_ -> subscription as Stripe holds it now
  fault: {},            // { event, sub, lookup, rowread, insert, patch } -> mode
  writes: [],           // every POST/PATCH that reached the database
  onPatch: null,        // (uid, body) => void — runs just BEFORE a PATCH lands (simulates a concurrent delivery)
  stripeCalls: 0,
};
function reset() {
  net.plans.clear(); net.events.clear(); net.subs.clear(); net.fault = {}; net.writes.length = 0; net.stripeCalls = 0; net.onPatch = null;
  net.searchVersions = []; net.versionLeak = null;
  net.searchOverride = null;  // v692 round 3: when set, Stripe Search answers this (a lagging index)
  process.env.STRIPE_SECRET_KEY = TEST_KEY;
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
  if (mode === 'shape200') return { status: 200, body: JSON.stringify({ message: 'not rows' }) };
  return null;
}

function postgrest(o, payload) {
  const q = sp(o.path);
  const table = o.path.split('?')[0];
  if (table !== '/rest/v1/user_plans') return { status: 404, body: '{}' };
  if (o.method === 'GET') {
    const uid = eq(q, 'user_id');
    const f = faultReply(net.fault[uid ? 'rowread' : 'lookup']);
    if (f) return f;
    if (uid) { const r = net.plans.get(uid); return { status: 200, body: JSON.stringify(r ? [r] : []) }; }
    const bySub = eq(q, 'stripe_subscription_id'), byCus = eq(q, 'stripe_customer_id');
    const hit = [...net.plans.values()].filter((r) =>
      (bySub && r.stripe_subscription_id === bySub) || (byCus && r.stripe_customer_id === byCus));
    return { status: 200, body: JSON.stringify(hit.map((r) => ({ user_id: r.user_id }))) };
  }
  if (o.method === 'POST') {
    const f = faultReply(net.fault.insert); if (f) return f;
    const b = JSON.parse(payload);
    net.writes.push({ method: 'POST', user: b.user_id, body: b });
    if (!net.plans.has(b.user_id)) net.plans.set(b.user_id, Object.assign({ plan: 'trial' }, b));
    return { status: 201, body: '' };
  }
  if (o.method === 'PATCH') {
    const uid = eq(q, 'user_id');
    const b = JSON.parse(payload);
    const mode = net.fault.patch;
    if (mode && mode !== 'afterwrite-net') { const f = faultReply(mode); if (f) return f; }
    if (net.onPatch) { const h = net.onPatch; net.onPatch = null; h(uid, b); }
    net.writes.push({ method: 'PATCH', user: uid, body: b });
    if (net.plans.has(uid)) net.plans.set(uid, Object.assign({}, net.plans.get(uid), b));
    if (mode === 'afterwrite-net') { net.fault.patch = null; return { error: new Error('ECONNRESET after the write landed (fault)') }; }
    return { status: 204, body: '' };
  }
  return { status: 405, body: '{}' };
}

function stripe(o) {
  net.stripeCalls++;
  if ((o.headers || {})['Stripe-Version'] && !/^\/v1\/subscriptions\/search\?/.test(o.path)) net.versionLeak = o.path;
  let m = o.path.match(/^\/v1\/events\/([^?]+)$/);
  if (m) {
    const f = faultReply(net.fault.event); if (f) return f;
    const e = net.events.get(decodeURIComponent(m[1]));
    return e ? { status: 200, body: JSON.stringify(e) } : { status: 404, body: JSON.stringify({ error: { message: 'No such event' } }) };
  }
  // v692 round 3 — Stripe Search by metadata user_id (the webhook's "another live subscription?")
  const msq = o.path.match(/^\/v1\/subscriptions\/search\?(.*)$/);
  if (msq && o.method === 'GET') {
    { const f = faultReply(net.fault.search); if (f) return f; }
    net.searchVersions.push((o.headers || {})['Stripe-Version'] || null);
    const qq = new URLSearchParams(msq[1]).get('query') || '';
    const mu = /metadata\['user_id'\]:'((?:[^'\\]|\\.)*)'/.exec(qq);
    const uid = mu ? mu[1].replace(/\\(.)/g, '$1') : null;
    // an override is returned AS IS (a lagging or misbehaving index — round 5: even another user's hit)
    const data = net.searchOverride || [...net.subs.values()].filter((x) => x && x.metadata && x.metadata.user_id === uid);
    return { status: 200, body: JSON.stringify({ object: 'search_result', data, has_more: false }) };
  }
  m = o.path.match(/^\/v1\/subscriptions\/([^?]+)$/);
  if (m) {
    const f = faultReply(net.fault.sub); if (f) return f;
    const s = net.subs.get(decodeURIComponent(m[1]));
    return s ? { status: 200, body: JSON.stringify(s) } : { status: 404, body: JSON.stringify({ error: { message: 'No such subscription' } }) };
  }
  return { status: 404, body: JSON.stringify({ error: { message: 'unmapped' } }) };
}

https.request = function (opts, cb) {
  const req = new EventEmitter();
  let payload = '', done = false;
  req.write = (c) => { payload += c; return true; };
  req.setTimeout = () => req;
  req.setHeader = () => req;
  req.destroy = (err) => { if (!done) { done = true; setImmediate(() => req.emit('error', err || new Error('destroyed'))); } return req; };
  req.end = () => {
    setImmediate(() => {
      let out;
      try {
        if (opts.hostname === 'api.stripe.com') out = stripe(opts);
        else if (opts.hostname === 'rv-money-gate.invalid') out = postgrest(opts, payload);
        else throw new Error('rv-money-webhook: unexpected outbound host ' + opts.hostname + ' — refusing the network');
      } catch (e) { done = true; req.emit('error', e); return; }
      if (out.timeout) { req.emit('timeout'); return; }          // stripeGet destroys → 'error'
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

// ── the real handler ─────────────────────────────────────────────────────────
const webhook = require_(join(ROOT, 'api', 'stripe-webhook.js'));
const now = () => Math.floor(Date.now() / 1000);
let n = 0;
function event(type, obj, ageSec) {
  const id = 'evt_rv_' + (++n);
  net.events.set(id, { id, object: 'event', type, livemode: false, created: now() - (ageSec || 5), data: { object: obj } });
  return id;
}
async function send(id, extra) {
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; }, setHeader() { return this; }, end() { return this; } };
  const lines = [];
  const oe = console.error, ol = console.log, ow = console.warn;
  console.error = console.log = console.warn = (...a) => lines.push(a.map(String).join(' '));
  try { await webhook(Object.assign({ method: 'POST', headers: {}, body: Object.assign({ id }, extra || {}) }), res); }
  finally { console.error = oe; console.log = ol; console.warn = ow; }
  return { code: res.code, body: res.body || {}, lines };
}
const ok2 = (r) => r.code >= 200 && r.code < 300;
const plan = (u) => (net.plans.get(u) || {}).plan || null;
const row = (u) => net.plans.get(u) || null;
const PERIOD = now() + 30 * 86400;
const SUB = (over) => Object.assign({ id: 'sub_A', object: 'subscription', status: 'active', customer: 'cus_A',
  current_period_end: PERIOD, items: { data: [{ price: { id: 'price_rv_pro' } }] },
  metadata: { user_id: 'user-a', plan: 'pro' } }, over || {});
const SESSION = (over) => Object.assign({ id: 'cs_A', object: 'checkout.session', mode: 'subscription', payment_status: 'paid',
  customer: 'cus_A', subscription: 'sub_A', metadata: { user_id: 'user-a', plan: 'pro' } }, over || {});
const paidRow = (u, over) => net.plans.set(u, Object.assign({ user_id: u, plan: 'pro', stripe_customer_id: 'cus_A',
  stripe_subscription_id: 'sub_A', current_period_end: new Date(PERIOD * 1000).toISOString() }, over || {}));

// A. an applied event is acknowledged
reset();
net.subs.set('sub_A', SUB());
const A = await send(event('checkout.session.completed', SESSION()));
ck(ok2(A) && plan('user-a') === 'pro', `A: a paid first purchase answered ${A.code} and left plan=${plan('user-a')} (want 2xx + pro)`);
ck(row('user-a') && row('user-a').stripe_subscription_id === 'sub_A', 'A: the grant did not persist the subscription id');

// B. every unknown re-fetch failure is non-2xx and writes nothing (opposite: A)
for (const mode of ['net', 'timeout', 'http429', 'http500', 'http502', 'http503', 'http401', 'garbage200']) {
  reset();
  net.subs.set('sub_A', SUB());
  const id = event('checkout.session.completed', SESSION());
  net.fault.event = mode;
  const r = await send(id);
  ck(r.code >= 500, `B: event re-fetch failed with "${mode}" and the webhook answered ${r.code} — Stripe never retries a 2xx, the payment is lost`);
  ck(net.writes.length === 0, `B: "${mode}": something was written from an event that could not be read`);
  ck(r.lines.length > 0, `B: "${mode}": a failed re-fetch left no log line`);
  net.fault.event = null;
  const again = await send(id);
  ck(ok2(again) && plan('user-a') === 'pro', `B: "${mode}": the redelivery after the fault cleared answered ${again.code}, plan=${plan('user-a')}`);
}

// C. a genuine 404 is acknowledged (documented: retrying cannot help), EXCEPT a live event read
//    with a test key, which is a config error that fixing the key heals.
reset();
const c1 = await send('evt_rv_unknown_1');
ck(ok2(c1) && net.writes.length === 0, `C: an event Stripe does not have answered ${c1.code} (documented outcome: 2xx, nothing written)`);
const c2 = await send('evt_rv_unknown_2', { livemode: true });
ck(c2.code >= 500 && net.writes.length === 0, `C: a LIVE event read with a TEST key (404) answered ${c2.code} — it is lost for good instead of healing once the key is fixed`);
process.env.STRIPE_SECRET_KEY = LIVE_KEY;
const c3 = await send('evt_rv_unknown_3', { livemode: false });
ck(ok2(c3), `C: a TEST event reaching a LIVE key answered ${c3.code} — test noise would retry for three days`);
process.env.STRIPE_SECRET_KEY = TEST_KEY;
const c4 = await send('evt_rv_unknown_4', { livemode: false });
ck(ok2(c4), `C: a test event read with a test key, genuinely absent, answered ${c4.code}`);

// D. a failed user lookup is not "nobody" (opposite: a successful lookup that finds nobody)
reset();
net.subs.set('sub_A', SUB());
net.fault.lookup = 'http500';
const d1 = await send(event('checkout.session.completed', SESSION({ metadata: {}, client_reference_id: null })));
ck(d1.code >= 500 && net.writes.length === 0, `D: a paid checkout whose user lookup FAILED answered ${d1.code} — acknowledged on a database blip`);
net.fault.lookup = 'shape200';
const d1b = await send(event('checkout.session.completed', SESSION({ metadata: {}, client_reference_id: null })));
ck(d1b.code >= 500, `D: a lookup answered 200 with a body that is not rows and the webhook answered ${d1b.code}`);
net.fault.lookup = null;
const d2 = await send(event('checkout.session.completed', SESSION({ metadata: {}, client_reference_id: null })));
ck(ok2(d2) && net.writes.length === 0, `D: a paid checkout that truly matches nobody answered ${d2.code} — retrying cannot find a user who is not there`);
ck(d2.lines.some((l) => /cs_A/.test(l) && /sub_A/.test(l)), 'D: an unresolvable paid checkout logged nothing that a human could grant by hand');
net.fault.lookup = 'net';
const subNoMeta = SUB({ metadata: {} });
net.subs.set('sub_A', subNoMeta);
const d3 = await send(event('customer.subscription.updated', subNoMeta));
ck(d3.code >= 500 && d3.body.error === 'user_lookup_failed', `D: a plan change whose user lookup FAILED answered ${d3.code} ${d3.body.error} (want 503 user_lookup_failed)`);
net.fault.lookup = null;
const d4 = await send(event('customer.subscription.updated', subNoMeta));
ck(d4.code >= 500 && d4.body.error !== 'user_lookup_failed', `D: an unresolvable plan change with a WORKING database was reported as ${d4.body.error}`);
// the lookup failed but metadata still names the user: the grant proceeds
reset();
net.subs.set('sub_A', SUB());
net.fault.lookup = 'http503';
const d5 = await send(event('checkout.session.completed', SESSION()));
ck(ok2(d5) && plan('user-a') === 'pro', `D: a lookup failure with user_id metadata answered ${d5.code}, plan=${plan('user-a')} — metadata must still grant`);

// E. a replay after a partial failure is not applied twice
reset();
net.subs.set('sub_A', SUB());
const eid = event('checkout.session.completed', SESSION());
net.fault.patch = 'afterwrite-net';
const e1 = await send(eid);
ck(!ok2(e1), `E: the plan write's answer was lost and the webhook still answered ${e1.code} (it cannot know it applied)`);
const patchesBefore = net.writes.filter((w) => w.method === 'PATCH').length;
const e2 = await send(eid);
const patchesAfter = net.writes.filter((w) => w.method === 'PATCH').length;
ck(ok2(e2) && e2.body.applied === false && patchesAfter === patchesBefore,
  `E: the redelivery answered ${e2.code} applied=${e2.body.applied} and wrote ${patchesAfter - patchesBefore} more time(s) — must be 2xx, already applied, zero writes`);
ck(plan('user-a') === 'pro', 'E: the plan after the replay is not pro');

// F. out-of-order and late deliveries decide from the subscription as it is NOW
// F1: a late `updated` (active snapshot) after the cancellation must not re-grant
reset();
paidRow('user-a');
net.subs.set('sub_A', SUB({ status: 'canceled' }));
const lateActive = event('customer.subscription.updated', SUB(), 3600);
const f0 = await send(event('customer.subscription.deleted', SUB({ status: 'canceled' })));
ck(ok2(f0) && plan('user-a') === 'free', `F1: setup — the cancellation answered ${f0.code}, plan=${plan('user-a')}`);
const f1 = await send(lateActive);
ck(ok2(f1) && plan('user-a') === 'free', `F1: a LATE subscription.updated(active) after the cancellation left plan=${plan('user-a')} — a cancelled customer got paid access back`);
// opposite: the same event while the subscription really is active grants
net.subs.set('sub_A', SUB());
const f1o = await send(event('customer.subscription.updated', SUB()));
ck(ok2(f1o) && plan('user-a') === 'pro', `F1: a current subscription.updated(active) left plan=${plan('user-a')}`);
// F2: a late checkout after the cancellation must not re-grant or write the dead id back
reset();
net.plans.set('user-a', { user_id: 'user-a', plan: 'free', stripe_customer_id: 'cus_A', stripe_subscription_id: null });
net.subs.set('sub_A', SUB({ status: 'canceled' }));
const f2 = await send(event('checkout.session.completed', SESSION(), 7200));
ck(ok2(f2) && plan('user-a') === 'free' && !row('user-a').stripe_subscription_id,
  `F2: a LATE checkout.session.completed after cancellation answered ${f2.code}, plan=${plan('user-a')}, sub=${row('user-a').stripe_subscription_id}`);
// F3: a late `deleted` for an OLD subscription must not downgrade the customer paying for the new one
reset();
paidRow('user-a', { stripe_subscription_id: 'sub_B' });
net.subs.set('sub_A', SUB({ status: 'canceled', metadata: {} }));
net.subs.set('sub_B', SUB({ id: 'sub_B' }));
const f3 = await send(event('customer.subscription.deleted', SUB({ status: 'canceled', metadata: {} })));
ck(ok2(f3) && plan('user-a') === 'pro' && row('user-a').stripe_subscription_id === 'sub_B',
  `F3: a late deletion of the OLD subscription left plan=${plan('user-a')} sub=${row('user-a').stripe_subscription_id} — the customer paying for sub_B was downgraded`);
// opposite: the deletion of the CURRENT subscription downgrades
net.subs.set('sub_B', SUB({ id: 'sub_B', status: 'canceled' }));
const f3o = await send(event('customer.subscription.deleted', SUB({ id: 'sub_B', status: 'canceled' })));
ck(ok2(f3o) && plan('user-a') === 'free' && !row('user-a').stripe_subscription_id,
  `F3: the deletion of the current subscription left plan=${plan('user-a')} sub=${row('user-a').stripe_subscription_id}`);
// F4: a late past_due after the card recovered must not downgrade
reset();
paidRow('user-a');
net.subs.set('sub_A', SUB());
const f4 = await send(event('customer.subscription.updated', SUB({ status: 'past_due' }), 3600));
ck(ok2(f4) && plan('user-a') === 'pro', `F4: a LATE past_due after recovery left plan=${plan('user-a')} — a paying customer was downgraded`);
// the live read itself failing is non-2xx (opposite: every successful live read above)
for (const mode of ['net', 'http500', 'http429', 'garbage200', 'http400', 'http401', 'http403']) {
  reset();
  paidRow('user-a');
  net.subs.set('sub_A', SUB({ status: 'canceled' }));
  net.fault.sub = mode;
  const g1 = await send(event('customer.subscription.deleted', SUB({ status: 'canceled' })));
  const g2 = await send(event('checkout.session.completed', SESSION()));
  ck(g1.code >= 500 && g2.code >= 500 && plan('user-a') === 'pro',
    `F: the live subscription read failed with "${mode}" and the webhook answered ${g1.code}/${g2.code}`);
}
// a subscription Stripe genuinely does not have is ended: no grant, and a downgrade still applies
reset();
const f5 = await send(event('checkout.session.completed', SESSION()));
ck(ok2(f5) && net.writes.length === 0, `F: a checkout whose subscription Stripe does not have answered ${f5.code} and wrote ${net.writes.length}`);
paidRow('user-a');
const f6 = await send(event('customer.subscription.updated', SUB()));
ck(ok2(f6) && plan('user-a') === 'free', `F: an update for a subscription Stripe does not have left plan=${plan('user-a')}`);

// K6. an account that no longer exists: acknowledge, write nothing (opposite: the row read failing)
reset();
net.subs.set('sub_A', SUB({ status: 'canceled' }));
const k1 = await send(event('customer.subscription.deleted', SUB({ status: 'canceled' })));
ck(ok2(k1) && net.writes.length === 0 && !net.plans.has('user-a'),
  `K6: a cancellation for a DELETED account answered ${k1.code} and wrote ${net.writes.length} row(s) — it recreated the account's plan row or retries for days`);
paidRow('user-a');
net.fault.rowread = 'http500';
const k2 = await send(event('customer.subscription.deleted', SUB({ status: 'canceled' })));
ck(k2.code >= 500 && plan('user-a') === 'pro', `K6: a cancellation whose plan-row read FAILED answered ${k2.code} — "could not read" was taken as "account gone"`);
net.fault.rowread = null;
const k3 = await send(event('customer.subscription.deleted', SUB({ status: 'canceled' })));
ck(ok2(k3) && plan('user-a') === 'free', `K6: the redelivery once the database answered left plan=${plan('user-a')}`);

// G. no key: nothing can be verified, so Stripe must hold the event (opposite: A)
reset();
delete process.env.STRIPE_SECRET_KEY;
net.subs.set('sub_A', SUB());
const gk = await send(event('checkout.session.completed', SESSION()));
ck(gk.code >= 500 && net.writes.length === 0, `G: with STRIPE_SECRET_KEY missing the webhook answered ${gk.code} — every event in that window is lost`);
ck(gk.lines.length > 0, 'G: a missing key left no log line');
process.env.STRIPE_SECRET_KEY = TEST_KEY;

// H. forged input — the body is never trusted
reset();
const h1 = await send('evt_rv_forged', { data: { object: SESSION({ metadata: { user_id: 'attacker', plan: 'agency' } }) }, type: 'checkout.session.completed' });
ck(ok2(h1) && net.writes.length === 0 && net.stripeCalls === 1, `H: a forged event answered ${h1.code} and wrote ${net.writes.length}`);
net.subs.set('sub_A', SUB());
const realId = event('checkout.session.completed', SESSION());
const h2 = await send(realId, { type: 'checkout.session.completed', data: { object: SESSION({ metadata: { user_id: 'attacker', plan: 'agency' } }) } });
ck(ok2(h2) && plan('user-a') === 'pro' && !net.plans.has('attacker'), 'H: a tampered body changed who or what was granted — the body must never be trusted');
const callsBefore = net.stripeCalls;
const h3 = await send('not_an_event');
ck(ok2(h3) && net.stripeCalls === callsBefore, `H: a body with no evt_ id answered ${h3.code} or reached Stripe`);
const h4 = { code: 0, status(c) { this.code = c; return this; }, json() { return this; } };
await webhook({ method: 'GET', headers: {}, body: {} }, h4);
ck(h4.code === 405, `H: GET answered ${h4.code}`);

// J. an unexpected throw is non-2xx (opposite: A)
reset();
net.subs.set('sub_A', SUB({ current_period_end: 1e20 }));
paidRow('user-a');
const j1 = await send(event('customer.subscription.updated', SUB({ current_period_end: 1e20 })));
ck(j1.code >= 500, `J: an unexpected exception answered ${j1.code} — the unapplied event was thrown away`);

// K. a stale event (older than the 72 h replay window) is acknowledged and not applied (documented)
reset();
net.subs.set('sub_A', SUB());
const k4 = await send(event('checkout.session.completed', SESSION(), 8 * 86400));
ck(ok2(k4) && net.writes.length === 0, `K: a stale event answered ${k4.code} and wrote ${net.writes.length}`);
ck(k4.lines.some((l) => /evt_rv_\d+/.test(l) && /stale/i.test(l)), 'K: a stale event was dropped without a log line naming it — a manual re-send vanishes silently');
const k5 = await send(event('checkout.session.completed', SESSION(), 60));
ck(ok2(k5) && !k5.lines.some((l) => /stale/i.test(l)), 'K: a fresh event was logged as stale');
// a Stripe retry or manual re-send four days later (past 72h, inside the window) still applies
reset();
net.subs.set('sub_A', SUB());
const k6 = await send(event('checkout.session.completed', SESSION(), 4 * 86400));
ck(ok2(k6) && plan('user-a') === 'pro', `K: a 4-day-old redelivery answered ${k6.code}, plan=${plan('user-a')} — Stripe's last retries and a manual re-send are dropped`);

// P. the checkout's plan is what the customer is billed for NOW, not what they bought first
reset();
net.subs.set('sub_A', SUB({ items: { data: [{ price: { id: 'price_rv_agency' } }] } }));
const p1 = await send(event('checkout.session.completed', SESSION(), 3600));
ck(ok2(p1) && plan('user-a') === 'agency', `P: a late checkout(pro) after a portal switch to Agency granted ${plan('user-a')} — paying for Agency, given Pro`);
reset();
net.subs.set('sub_A', SUB());
const p2 = await send(event('checkout.session.completed', SESSION({ metadata: { user_id: 'user-a', plan: 'agency' } }), 3600));
ck(ok2(p2) && plan('user-a') === 'pro', `P: a late checkout(agency) after a switch down to Pro granted ${plan('user-a')}`);
reset();
net.subs.set('sub_A', SUB({ items: { data: [{ price: { id: 'price_unconfigured' } }] }, metadata: { user_id: 'user-a', plan: 'starter' } }));
const p3 = await send(event('checkout.session.completed', SESSION()));
ck(ok2(p3) && plan('user-a') === 'starter', `P: with an unconfigured price the subscription's own plan stamp was not used (got ${plan('user-a')})`);
ck(p3.lines.some((l) => /CONFIG ERROR/.test(l) && /price_unconfigured/.test(l)), 'P: the checkout path fell back from an unconfigured price without the CONFIG ERROR line');
const p4 = await send(event('customer.subscription.updated', SUB({ items: { data: [{ price: { id: 'price_unconfigured' } }] }, metadata: { user_id: 'user-a', plan: 'starter' } })));
ck(ok2(p4) && p4.lines.some((l) => /CONFIG ERROR/.test(l) && /price_unconfigured/.test(l)), 'P: the subscription path fell back from an unconfigured price without the CONFIG ERROR line');
reset();
net.subs.set('sub_A', SUB());
const p5 = await send(event('checkout.session.completed', SESSION()));
ck(ok2(p5) && !p5.lines.some((l) => /CONFIG ERROR/.test(l)), 'P: a configured price was reported as a CONFIG ERROR');

// R. a grant that races a cancellation is undone (two deliveries at once)
reset();
paidRow('user-a');
net.subs.set('sub_A', SUB({ items: { data: [{ price: { id: 'price_rv_agency' } }] } }));
net.onPatch = (uid, body) => {
  if (body.plan !== 'agency') return;
  // between the upgrade's read and its write: the customer cancels and `deleted` is applied
  net.subs.set('sub_A', SUB({ status: 'canceled' }));
  net.plans.set('user-a', Object.assign({}, net.plans.get('user-a'), { plan: 'free', stripe_subscription_id: null }));
};
const r1 = await send(event('customer.subscription.updated', SUB({ items: { data: [{ price: { id: 'price_rv_agency' } }] } })));
ck(ok2(r1) && plan('user-a') === 'free' && !row('user-a').stripe_subscription_id,
  `R: an upgrade that raced a cancellation left plan=${plan('user-a')} sub=${row('user-a').stripe_subscription_id} — paid access with a dead subscription id and nothing left to fix it`);
reset();
net.plans.set('user-a', { user_id: 'user-a', plan: 'free', stripe_customer_id: 'cus_A', stripe_subscription_id: null });
net.subs.set('sub_A', SUB());
net.onPatch = (uid, body) => {
  if (body.plan !== 'pro') return;
  net.subs.set('sub_A', SUB({ status: 'canceled' }));
};
const r2 = await send(event('checkout.session.completed', SESSION()));
ck(ok2(r2) && plan('user-a') === 'free' && !row('user-a').stripe_subscription_id,
  `R: a first-purchase grant that raced a cancellation left plan=${plan('user-a')} sub=${row('user-a').stripe_subscription_id}`);
// the re-read failing is non-2xx (Stripe retries and decides from the current state)
reset();
net.plans.set('user-a', { user_id: 'user-a', plan: 'free', stripe_customer_id: 'cus_A', stripe_subscription_id: null });
net.subs.set('sub_A', SUB());
net.onPatch = () => { net.fault.sub = 'http500'; };
const r3 = await send(event('checkout.session.completed', SESSION()));
ck(r3.code >= 500, `R: the confirming re-read failed and the webhook answered ${r3.code}`);
// opposite: no race — the grant stands
reset();
net.subs.set('sub_A', SUB());
const r4 = await send(event('checkout.session.completed', SESSION()));
ck(ok2(r4) && plan('user-a') === 'pro' && row('user-a').stripe_subscription_id === 'sub_A', `R: a grant with no race was undone (plan=${plan('user-a')})`);

// R (round 3). the undo fires for EVERY ended status, not just canceled
for (const st of ['unpaid', 'incomplete_expired', 'past_due', 'absent']) {
  reset();
  net.plans.set('user-a', { user_id: 'user-a', plan: 'free', stripe_customer_id: 'cus_A', stripe_subscription_id: null });
  net.subs.set('sub_A', SUB());
  net.onPatch = (uid, body) => {
    if (body.plan !== 'pro') return;
    if (st === 'absent') net.subs.delete('sub_A'); else net.subs.set('sub_A', SUB({ status: st }));
  };
  const r5 = await send(event('checkout.session.completed', SESSION()));
  // v692 — the undo still drops the plan for every non-live status, but the subscription id is
  // cleared only when the subscription has ENDED. A past_due / unpaid one is still being retried
  // by Stripe; its id must stay so create-checkout refuses a second subscription.
  const wantSub = (st === 'past_due' || st === 'unpaid') ? 'sub_A' : null;
  ck(ok2(r5) && plan('user-a') === 'free' && (row('user-a').stripe_subscription_id || null) === wantSub,
    `R: a grant that raced the subscription becoming "${st}" left plan=${plan('user-a')} sub=${row('user-a').stripe_subscription_id} (want free, sub=${wantSub})`);
}
// R (round 3). an unconfirmed checkout grant (re-read failed / undo write failed) answers 503 AND the
// redelivery repairs it — the checkout path's "not live" branch used to ignore the row
for (const kind of ['rowread', 'patch']) {
  reset();
  net.plans.set('user-a', { user_id: 'user-a', plan: 'free', stripe_customer_id: 'cus_A', stripe_subscription_id: null });
  net.subs.set('sub_A', SUB());
  net.onPatch = (uid, body) => {
    if (body.plan !== 'pro') return;
    net.subs.set('sub_A', SUB({ status: 'canceled' }));
    net.fault[kind] = 'http500';          // hits the confirmation's row read, or the undo write
  };
  const rid = event('checkout.session.completed', SESSION());
  const r6 = await send(rid);
  ck(r6.code >= 500 && r6.body.error === 'grant_unconfirmed',
    `R: the ${kind === 'rowread' ? 'confirming row read' : 'undo write'} failed and the webhook answered ${r6.code} ${r6.body.error} — the dead grant was acknowledged`);
  net.fault = {};
  const r7 = await send(rid);
  ck(ok2(r7) && plan('user-a') === 'free' && !row('user-a').stripe_subscription_id,
    `R: the redelivery after a failed ${kind} left plan=${plan('user-a')} sub=${row('user-a').stripe_subscription_id} — pro with a dead subscription forever`);
}
// opposites: a not-live checkout never touches a row on ANOTHER subscription, or one already clear
reset();
paidRow('user-a', { stripe_subscription_id: 'sub_B' });
net.subs.set('sub_A', SUB({ status: 'canceled' }));
const r8 = await send(event('checkout.session.completed', SESSION(), 3600));
ck(ok2(r8) && net.writes.length === 0 && plan('user-a') === 'pro' && row('user-a').stripe_subscription_id === 'sub_B',
  `R: a late not-live checkout for sub_A touched the row paying for sub_B (writes=${net.writes.length})`);
reset();
net.plans.set('user-a', { user_id: 'user-a', plan: 'free', stripe_customer_id: 'cus_A', stripe_subscription_id: null });
net.subs.set('sub_A', SUB({ status: 'canceled' }));
const r9 = await send(event('checkout.session.completed', SESSION(), 3600));
ck(ok2(r9) && net.writes.length === 0, `R: a late not-live checkout wrote to a row that was already clear (writes=${net.writes.length})`);
reset();
net.subs.set('sub_A', SUB({ status: 'canceled' }));
net.fault.lookup = 'http500';
const r10 = await send(event('checkout.session.completed', SESSION({ metadata: {}, client_reference_id: null }), 3600));
ck(r10.code >= 500, `R: a not-live checkout whose user lookup FAILED answered ${r10.code} — a stuck grant could never be repaired`);

// X1. a late checkout grants nothing for ANY subscription that is not active/trialing now
for (const st of ['past_due', 'unpaid', 'incomplete', 'incomplete_expired', 'paused']) {
  reset();
  net.plans.set('user-a', { user_id: 'user-a', plan: 'free', stripe_customer_id: 'cus_A', stripe_subscription_id: null });
  net.subs.set('sub_A', SUB({ status: st }));
  const x = await send(event('checkout.session.completed', SESSION(), 3600));
  ck(ok2(x) && plan('user-a') === 'free' && net.writes.length === 0, `X1: a late checkout while the subscription is "${st}" granted ${plan('user-a')}`);
}
reset();
net.subs.set('sub_A', SUB({ status: 'trialing' }));
const x1o = await send(event('checkout.session.completed', SESSION()));
ck(ok2(x1o) && plan('user-a') === 'pro', `X1: a checkout while trialing granted ${plan('user-a')}`);

// X2. a late subscription.created after the cancellation must not re-grant
reset();
net.plans.set('user-a', { user_id: 'user-a', plan: 'free', stripe_customer_id: 'cus_A', stripe_subscription_id: null });
net.subs.set('sub_A', SUB({ status: 'canceled' }));
const x2 = await send(event('customer.subscription.created', SUB(), 7200));
ck(ok2(x2) && plan('user-a') === 'free' && !row('user-a').stripe_subscription_id,
  `X2: a LATE subscription.created after cancellation left plan=${plan('user-a')} sub=${row('user-a').stripe_subscription_id}`);
// not even briefly: the grant must never be written (a write-then-undo leaves a window of paid access)
ck(net.writes.length === 0, `X2: a LATE subscription.created after cancellation wrote ${net.writes.length} time(s) — it was decided from the event's snapshot, not Stripe's current state`);

// X3. a late `updated` for an OLD subscription must not downgrade the customer paying for the new one
for (const st of ['past_due', 'canceled', 'unpaid']) {
  reset();
  paidRow('user-a', { stripe_subscription_id: 'sub_B' });
  net.subs.set('sub_A', SUB({ status: st, metadata: {} }));
  net.subs.set('sub_B', SUB({ id: 'sub_B' }));
  const x3 = await send(event('customer.subscription.updated', SUB({ status: st, metadata: {} }), 3600));
  ck(ok2(x3) && plan('user-a') === 'pro' && row('user-a').stripe_subscription_id === 'sub_B',
    `X3: a late ${st} update for the OLD subscription left plan=${plan('user-a')} sub=${row('user-a').stripe_subscription_id}`);
}

// X4. a row read that answers 200 with something that is not rows is "could not read", not "account deleted"
for (const mode of ['shape200', 'garbage200']) {
  reset();
  paidRow('user-a');
  net.subs.set('sub_A', SUB({ status: 'canceled' }));
  net.fault.rowread = mode;
  const x4 = await send(event('customer.subscription.deleted', SUB({ status: 'canceled' })));
  ck(x4.code >= 500, `X4: a "${mode}" row read was taken as a deleted account (answered ${x4.code}) — the cancelled customer keeps paid access`);
}

// X5. restricted keys (rk_) are mode-checked like secret keys
reset();
process.env.STRIPE_SECRET_KEY = 'rk_test_rv_money_gate';
const x5 = await send('evt_rv_unknown_rk', { livemode: true });
ck(x5.code >= 500, `X5: a LIVE event read with a restricted TEST key answered ${x5.code} — lost for good`);
process.env.STRIPE_SECRET_KEY = 'rk_live_rv_money_gate';
const x5o = await send('evt_rv_unknown_rk2', { livemode: false });
ck(ok2(x5o), `X5: a test event at a restricted LIVE key answered ${x5o.code}`);
process.env.STRIPE_SECRET_KEY = TEST_KEY;

// ── v692 ─────────────────────────────────────────────────────────────────────
// V1. DUNNING: a subscription that is still alive in Stripe keeps its id on the row (the plan still
//     drops to free — the owner's access policy), so create-checkout can refuse a second one.
for (const st of ['past_due', 'unpaid', 'incomplete', 'paused']) {
  reset();
  paidRow('user-a');
  net.subs.set('sub_A', SUB({ status: st }));
  const v = await send(event('customer.subscription.updated', SUB({ status: st })));
  ck(ok2(v) && plan('user-a') === 'free', `V1: ${st} answered ${v.code}, plan=${plan('user-a')} (want 2xx + free — the access policy is unchanged)`);
  ck(row('user-a').stripe_subscription_id === 'sub_A' && row('user-a').stripe_customer_id === 'cus_A',
    `V1: ${st} left sub=${row('user-a').stripe_subscription_id} customer=${row('user-a').stripe_customer_id} — the id of a subscription Stripe is still charging was cleared, so a second checkout double-bills`);
  // the card recovers: updated(active) re-grants, as today
  net.subs.set('sub_A', SUB());
  const rec = await send(event('customer.subscription.updated', SUB()));
  ck(ok2(rec) && plan('user-a') === 'pro' && row('user-a').stripe_subscription_id === 'sub_A',
    `V1: after ${st}, the recovery updated(active) left plan=${plan('user-a')} sub=${row('user-a').stripe_subscription_id}`);
}
// opposite: a subscription that has truly ENDED has its id cleared (updated or deleted, and a 404)
for (const [st, type] of [['canceled', 'customer.subscription.updated'], ['incomplete_expired', 'customer.subscription.updated'],
                          ['canceled', 'customer.subscription.deleted'], ['absent', 'customer.subscription.updated']]) {
  reset();
  paidRow('user-a');
  if (st !== 'absent') net.subs.set('sub_A', SUB({ status: st }));
  const v = await send(event(type, SUB({ status: st === 'absent' ? 'active' : st })));
  ck(ok2(v) && plan('user-a') === 'free' && !row('user-a').stripe_subscription_id && row('user-a').stripe_customer_id === 'cus_A',
    `V1: ${type} with the subscription "${st}" left plan=${plan('user-a')} sub=${row('user-a').stripe_subscription_id} customer=${row('user-a').stripe_customer_id} (want free, id cleared, customer kept)`);
}
// the full dunning path: past_due keeps the id, and when Stripe finally cancels it the id is cleared
// — even though the row already says free with the same period end ("already correct" must not hide it)
reset();
paidRow('user-a');
net.subs.set('sub_A', SUB({ status: 'past_due' }));
await send(event('customer.subscription.updated', SUB({ status: 'past_due' })));
ck(plan('user-a') === 'free' && row('user-a').stripe_subscription_id === 'sub_A', 'V1: setup — past_due did not leave free + sub_A');
net.subs.set('sub_A', SUB({ status: 'canceled' }));
const vEnd = await send(event('customer.subscription.deleted', SUB({ status: 'canceled' })));
ck(ok2(vEnd) && plan('user-a') === 'free' && !row('user-a').stripe_subscription_id,
  `V1: the deletion after dunning answered ${vEnd.code} and left sub=${row('user-a').stripe_subscription_id} — a dead id stays on the row`);
const vEndAgain = await send(event('customer.subscription.deleted', SUB({ status: 'canceled' })));
ck(ok2(vEndAgain) && net.writes.filter((w) => w.method === 'PATCH').length === 2,
  `V1: a redelivered deletion after the id was cleared wrote again (PATCHes=${net.writes.filter((w) => w.method === 'PATCH').length}, want 2)`);

// V2. UNMATCHED: no user_id metadata, no row holds either id, and the lookups SUCCEEDED
const OLD = now() - 30 * 86400;
for (const type of ['customer.subscription.updated', 'customer.subscription.deleted']) {
  reset();
  net.plans.set('user-b', { user_id: 'user-b', plan: 'pro', stripe_customer_id: 'cus_B', stripe_subscription_id: 'sub_B' });
  net.subs.set('sub_A', SUB({ status: 'canceled', metadata: {}, created: OLD }));
  const id = event(type, SUB({ status: 'canceled', metadata: {}, created: OLD }));
  const v = await send(id);
  ck(ok2(v) && net.writes.length === 0, `V2: an OLD unmatched ${type} answered ${v.code} (want 2xx, nothing written) — Stripe retries it for three days for nothing`);
  const line = v.lines.find((l) => /WEBHOOK UNMATCHED/.test(l)) || '';
  ck(line.includes(id) && line.includes('sub_A') && line.includes('cus_A'), `V2: the unmatched ${type} did not log a WEBHOOK UNMATCHED line naming the event, subscription and customer`);
  ck(!/@/.test(line), 'V2: the WEBHOOK UNMATCHED line carries an email');
  ck(plan('user-b') === 'pro', 'V2: an unmatched event touched another customer');
}
// opposites: a FRESH unmatched subscription still gets non-2xx (a retry can still match it), and so
// does one whose age Stripe did not give us; a failed lookup is still 503 whatever the age
for (const [label, created] of [['fresh (5 min)', now() - 300], ['unknown age', undefined]]) {
  reset();
  const s = SUB({ status: 'canceled', metadata: {}, created });
  net.subs.set('sub_A', s);
  const v = await send(event('customer.subscription.deleted', s));
  ck(v.code >= 500 && !v.lines.some((l) => /WEBHOOK UNMATCHED/.test(l)), `V2: an unmatched subscription of ${label} answered ${v.code} — a retry that could still match it was given up`);
  // round 2: the retry must be the DELIBERATE one, not a crash that happens to be non-2xx
  ck(v.code === 500 && v.body.error === 'unresolved_user' && !v.lines.some((l) => /UNHANDLED/.test(l)),
    `V2: an unmatched subscription of ${label} answered ${v.code} ${v.body.error} (want 500 unresolved_user, no crash)`);
}
reset();
net.subs.set('sub_A', SUB({ status: 'canceled', metadata: {}, created: OLD }));
net.fault.lookup = 'http500';
const v2f = await send(event('customer.subscription.deleted', SUB({ status: 'canceled', metadata: {}, created: OLD })));
ck(v2f.code === 503 && v2f.body.error === 'user_lookup_failed', `V2: an OLD subscription whose lookup FAILED answered ${v2f.code} ${v2f.body.error} — a database blip is not "unmatched"`);

// V3. HAND-GRANTED: a paid row with NO subscription id is not Stripe-managed; a late event for an
//     old subscription (by customer id, or by metadata) must not downgrade it
for (const [label, meta, type, st, hand] of [['customer id (pro)', {}, 'customer.subscription.deleted', 'canceled', 'pro'],
                                       ['customer id', {}, 'customer.subscription.deleted', 'canceled'],
                                       ['metadata', { user_id: 'user-a' }, 'customer.subscription.deleted', 'canceled'],
                                       ['customer id', {}, 'customer.subscription.updated', 'past_due']]) {
  reset();
  // resolved by metadata only when no row holds the customer id either
  paidRow('user-a', { plan: hand || 'agency', stripe_subscription_id: null, current_period_end: null,
    stripe_customer_id: label === 'metadata' ? null : 'cus_A' });
  net.subs.set('sub_A', SUB({ status: st, metadata: meta }));
  const v = await send(event(type, SUB({ status: st, metadata: meta }), 3600));
  ck(ok2(v) && plan('user-a') === (hand || 'agency') && net.writes.length === 0,
    `V3: a late ${type} (${st}) resolved by ${label} answered ${v.code}, plan=${plan('user-a')}, writes=${net.writes.length} — a hand-granted plan was downgraded`);
  ck(v.lines.some((l) => /HAND-GRANTED PLAN LEFT ALONE/.test(l) && l.includes('sub_A')), `V3: the hand-granted row (${label}) was left alone without a log line`);
}
// opposite: the same row holding the subscription IS downgraded by its deletion
reset();
paidRow('user-a', { plan: 'agency' });
net.subs.set('sub_A', SUB({ status: 'canceled', metadata: {} }));
const v3o = await send(event('customer.subscription.deleted', SUB({ status: 'canceled', metadata: {} })));
ck(ok2(v3o) && plan('user-a') === 'free' && !row('user-a').stripe_subscription_id, `V3: a Stripe-paid row's own deletion left plan=${plan('user-a')}`);

// ── v692 round 2 ─────────────────────────────────────────────────────────────
// V1b (gap M5). The "must be cleared" check reads the SUBSCRIPTION id — a row that has no customer
// id but still holds the dead subscription id must have it cleared, and one whose customer id is
// set but subscription id already clear must not be written again.
reset();
paidRow('user-a', { stripe_customer_id: null });
net.subs.set('sub_A', SUB({ status: 'past_due' }));
await send(event('customer.subscription.updated', SUB({ status: 'past_due' })));
ck(plan('user-a') === 'free' && row('user-a').stripe_subscription_id === 'sub_A', 'V1b: setup — past_due did not leave free + sub_A');
net.subs.set('sub_A', SUB({ status: 'canceled' }));
const v1b = await send(event('customer.subscription.deleted', SUB({ status: 'canceled' })));
ck(ok2(v1b) && !row('user-a').stripe_subscription_id, `V1b: with no customer id on the row, the final deletion left sub=${row('user-a').stripe_subscription_id}`);
reset();
net.plans.set('user-a', { user_id: 'user-a', plan: 'free', stripe_customer_id: 'cus_A', stripe_subscription_id: 'sub_A', current_period_end: new Date(PERIOD * 1000).toISOString() });
net.subs.set('sub_A', SUB({ status: 'canceled' }));
await send(event('customer.subscription.deleted', SUB({ status: 'canceled' })));
const patches1 = net.writes.filter((w) => w.method === 'PATCH').length;
await send(event('customer.subscription.deleted', SUB({ status: 'canceled' })));
ck(!row('user-a').stripe_subscription_id && patches1 === 1 && net.writes.filter((w) => w.method === 'PATCH').length === 1,
  `V1b: clearing a dead id on a free row took ${patches1} write(s) and the redelivery wrote again (want exactly 1 in total)`);

// W1. a paid checkout with NO subscription grants nothing and never clears the row's id
reset();
paidRow('user-a');
net.subs.set('sub_A', SUB());
const w1 = await send(event('checkout.session.completed', SESSION({ subscription: null })));
ck(ok2(w1) && net.writes.length === 0 && plan('user-a') === 'pro' && row('user-a').stripe_subscription_id === 'sub_A',
  `W1: a paid session without a subscription answered ${w1.code}, wrote ${net.writes.length}, left sub=${row('user-a').stripe_subscription_id} — the row lost its subscription id and can never be downgraded`);
ck(w1.lines.some((l) => /PAID SESSION WITHOUT A SUBSCRIPTION/.test(l) && l.includes('cs_A')), 'W1: the anomaly was not logged with the session id');
reset();
const w1b = await send(event('checkout.session.completed', SESSION({ subscription: null })));
ck(ok2(w1b) && net.writes.length === 0 && !net.plans.has('user-a'), `W1: with no row, a session without a subscription still granted (writes=${net.writes.length})`);

// W2. TWO LIVE SUBSCRIPTIONS: the row keeps the one that is paying; the new one is logged, not written
const SUBB = (over) => SUB(Object.assign({ id: 'sub_B' }, over || {}));
for (const [label, send1] of [['checkout', () => send(event('checkout.session.completed', SESSION({ subscription: 'sub_B', id: 'cs_B' })))],
                              ['updated(active)', () => send(event('customer.subscription.updated', SUBB()))]]) {
  reset();
  paidRow('user-a');
  net.subs.set('sub_A', SUB());
  net.subs.set('sub_B', SUBB());
  const w2 = await send1();
  ck(ok2(w2) && net.writes.length === 0 && plan('user-a') === 'pro' && row('user-a').stripe_subscription_id === 'sub_A',
    `W2: ${label} for a second live subscription answered ${w2.code}, wrote ${net.writes.length}, row sub=${row('user-a').stripe_subscription_id} — the paying sub_A is no longer tracked`);
  ck(w2.lines.some((l) => /DOUBLE SUBSCRIPTION/.test(l) && l.includes('sub_A') && l.includes('sub_B') && l.includes('user-a')), `W2: ${label}: no DOUBLE SUBSCRIPTION line with both ids`);
}
// ...and cancelling the duplicate leaves the paying one tracked
net.subs.set('sub_B', SUBB({ status: 'canceled' }));
const w2c = await send(event('customer.subscription.deleted', SUBB({ status: 'canceled' })));
ck(ok2(w2c) && plan('user-a') === 'pro' && row('user-a').stripe_subscription_id === 'sub_A', `W2: cancelling the duplicate left plan=${plan('user-a')} sub=${row('user-a').stripe_subscription_id}`);
// ...and if the OLD one is cancelled instead, the row moves to the surviving one AT ONCE (round 3: it
// used to drop to free until the survivor's next event, up to a month, and checkout could sell a third)
reset();
paidRow('user-a');
net.subs.set('sub_A', SUB());
net.subs.set('sub_B', SUBB());
await send(event('customer.subscription.updated', SUBB()));
net.subs.set('sub_A', SUB({ status: 'canceled' }));
const w2t = await send(event('customer.subscription.deleted', SUB({ status: 'canceled' })));
ck(ok2(w2t) && plan('user-a') === 'pro' && row('user-a').stripe_subscription_id === 'sub_B',
  `W2: cancelling the kept subscription while the other still pays left plan=${plan('user-a')} sub=${row('user-a').stripe_subscription_id}`);
// opposite: the row's subscription is alive but FAILING → the new paying one takes over (and is logged)
reset();
paidRow('user-a', { plan: 'free' });
net.subs.set('sub_A', SUB({ status: 'past_due' }));
net.subs.set('sub_B', SUBB());
const w2f = await send(event('customer.subscription.updated', SUBB()));
ck(ok2(w2f) && plan('user-a') === 'pro' && row('user-a').stripe_subscription_id === 'sub_B' && w2f.lines.some((l) => /DOUBLE SUBSCRIPTION/.test(l)),
  `W2: a paying subscription over a past_due one answered ${w2f.code}, plan=${plan('user-a')}, sub=${row('user-a').stripe_subscription_id}`);
// opposite: the row's subscription has ENDED (or Stripe no longer has it) → a normal grant, no DOUBLE line
for (const st of ['canceled', 'absent']) {
  reset();
  paidRow('user-a', { plan: 'free' });
  if (st !== 'absent') net.subs.set('sub_A', SUB({ status: st }));
  net.subs.set('sub_B', SUBB());
  const w2e = await send(event('customer.subscription.updated', SUBB()));
  ck(ok2(w2e) && plan('user-a') === 'pro' && row('user-a').stripe_subscription_id === 'sub_B' && !w2e.lines.some((l) => /DOUBLE SUBSCRIPTION/.test(l)),
    `W2: a new subscription after the old one was "${st}" answered ${w2e.code}, sub=${row('user-a').stripe_subscription_id}`);
}
// the row's subscription (or the row) cannot be read → 503, nothing written
reset();
paidRow('user-a');
net.subs.set('sub_B', SUBB());
const realSubsGet = net.subs.get.bind(net.subs);
net.subs.get = (id) => { if (id === 'sub_A') throw new Error('sub_A read fault'); return realSubsGet(id); };
const w2r = await send(event('customer.subscription.updated', SUBB()));
net.subs.get = realSubsGet;
ck(w2r.code === 503 && net.writes.length === 0 && row('user-a').stripe_subscription_id === 'sub_A', `W2: the row's subscription could not be read and the webhook answered ${w2r.code}, wrote ${net.writes.length}`);
reset();
net.subs.set('sub_A', SUB());
paidRow('user-a', { plan: 'free', stripe_subscription_id: null });
net.fault.rowread = 'http500';
const w2rr = await send(event('customer.subscription.updated', SUB()));
ck(w2rr.code >= 500 && net.writes.length === 0, `W2: the plan row could not be read before a grant and the webhook answered ${w2rr.code}, wrote ${net.writes.length}`);

// ── v692 round 3 ─────────────────────────────────────────────────────────────
// M1. the row's subscription ends (or fails) while the user still pays through ANOTHER one, on another
//     customer (two first-purchase tabs) → the row moves to it: its plan, its sub id, its customer id
const SUBC = (over) => SUB(Object.assign({ id: 'sub_C', customer: 'cus_C', items: { data: [{ price: { id: 'price_rv_agency' } }] } }, over || {}));
for (const [label, type, st, otherSt] of [['deleted', 'customer.subscription.deleted', 'canceled', 'active'],
                                          ['past_due', 'customer.subscription.updated', 'past_due', 'active'],
                                          ['unpaid', 'customer.subscription.updated', 'unpaid', 'trialing'],
                                          ['absent', 'customer.subscription.updated', 'absent', 'active']]) {
  reset();
  paidRow('user-a');
  if (st !== 'absent') net.subs.set('sub_A', SUB({ status: st }));
  net.subs.set('sub_C', SUBC({ status: otherSt }));
  const m1 = await send(event(type, SUB({ status: st === 'absent' ? 'active' : st })));
  ck(ok2(m1) && plan('user-a') === 'agency' && row('user-a').stripe_subscription_id === 'sub_C' && row('user-a').stripe_customer_id === 'cus_C',
    `M1: ${label} of the row's subscription while sub_C (${otherSt}, cus_C) still pays left plan=${plan('user-a')} sub=${row('user-a').stripe_subscription_id} customer=${row('user-a').stripe_customer_id} — a paying customer was dropped to free`);
  ck(m1.lines.some((l) => /STILL PAYS THROUGH sub_C/.test(l) && l.includes('sub_A')), `M1: ${label}: the move was not logged with both subscriptions`);
}
// opposites: no other subscription, another USER's, one that has ended, or a stale search hit → the downgrade stands
for (const [label, setup] of [
  ['none', () => {}],
  ["another user's", () => net.subs.set('sub_C', SUBC({ metadata: { user_id: 'user-z', plan: 'agency' } }))],
  ['an ended one', () => net.subs.set('sub_C', SUBC({ status: 'canceled' }))],
  ['a failing one', () => net.subs.set('sub_C', SUBC({ status: 'past_due' }))],
  ['a stale search hit (canceled when re-read)', () => { net.subs.set('sub_C', SUBC({ status: 'canceled' })); net.searchOverride = [SUBC()]; }]]) {
  reset();
  paidRow('user-a');
  net.subs.set('sub_A', SUB({ status: 'canceled' }));
  setup();
  const m1o = await send(event('customer.subscription.deleted', SUB({ status: 'canceled' })));
  ck(ok2(m1o) && plan('user-a') === 'free' && !row('user-a').stripe_subscription_id && row('user-a').stripe_customer_id === 'cus_A',
    `M1: with ${label} other subscription the cancellation left plan=${plan('user-a')} sub=${row('user-a').stripe_subscription_id} customer=${row('user-a').stripe_customer_id}`);
}
// the search failing is not "nothing found": 503, nothing written, and the redelivery applies
for (const mode of ['http500', 'net', 'http429', 'garbage200']) {
  reset();
  paidRow('user-a');
  net.subs.set('sub_A', SUB({ status: 'canceled' }));
  net.subs.set('sub_C', SUBC());
  net.fault.search = mode;
  const id = event('customer.subscription.deleted', SUB({ status: 'canceled' }));
  const m1f = await send(id);
  ck(m1f.code === 503 && net.writes.length === 0 && plan('user-a') === 'pro', `M1: a "${mode}" search failure answered ${m1f.code} and wrote ${net.writes.length}`);
  net.fault.search = null;
  const m1r = await send(id);
  ck(ok2(m1r) && row('user-a').stripe_subscription_id === 'sub_C', `M1: the redelivery after a "${mode}" search failure left sub=${row('user-a').stripe_subscription_id}`);
}
// the move's write failing is non-2xx (Stripe retries)
reset();
paidRow('user-a');
net.subs.set('sub_A', SUB({ status: 'canceled' }));
net.subs.set('sub_C', SUBC());
net.fault.patch = 'http500';
const m1w = await send(event('customer.subscription.deleted', SUB({ status: 'canceled' })));
ck(m1w.code >= 500, `M1: a failed move write answered ${m1w.code}`);

// M3. the double-subscription guard KEEPS sub_A, but the row says free (sub_A's recovery event not yet
//     handled) → the row is granted from sub_A, not left on free
reset();
paidRow('user-a', { plan: 'free' });
net.subs.set('sub_A', SUB());
net.subs.set('sub_B', SUBB());
const m3 = await send(event('checkout.session.completed', SESSION({ subscription: 'sub_B', id: 'cs_B' })));
ck(ok2(m3) && plan('user-a') === 'pro' && row('user-a').stripe_subscription_id === 'sub_A' && m3.lines.some((l) => /DOUBLE SUBSCRIPTION/.test(l)),
  `M3: the kept, active sub_A left the row plan=${plan('user-a')} sub=${row('user-a').stripe_subscription_id} — a paying customer stays on free`);
// ...from its LIVE price
reset();
paidRow('user-a', { plan: 'free' });
net.subs.set('sub_A', SUB({ items: { data: [{ price: { id: 'price_rv_agency' } }] } }));
net.subs.set('sub_B', SUBB());
await send(event('customer.subscription.updated', SUBB()));
ck(plan('user-a') === 'agency' && row('user-a').stripe_subscription_id === 'sub_A', `M3: the kept sub_A (agency) was granted ${plan('user-a')}`);
// opposite: the row already matches the kept one → nothing written (W2 above), and a failed sync write is non-2xx
reset();
paidRow('user-a', { plan: 'free' });
net.subs.set('sub_A', SUB());
net.subs.set('sub_B', SUBB());
net.fault.patch = 'http500';
const m3f = await send(event('customer.subscription.updated', SUBB()));
ck(m3f.code >= 500 && plan('user-a') === 'free', `M3: a failed sync to the kept subscription answered ${m3f.code}`);

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
// U1. Search missing for this account (region / API version) → the downgrade proceeds WITHOUT the
//     "another live subscription?" check (pre-round-3 behaviour), logged — never a 503 loop
for (const [label, fault] of SEARCH_OFF) {
  reset();
  paidRow('user-a');
  net.subs.set('sub_A', SUB({ status: 'canceled' }));
  net.subs.set('sub_C', SUBC());
  net.fault.search = fault;
  const u1 = await send(event('customer.subscription.deleted', SUB({ status: 'canceled' })));
  ck(ok2(u1) && plan('user-a') === 'free' && !row('user-a').stripe_subscription_id,
    `U1: ${label}: answered ${u1.code}, plan=${plan('user-a')} — a missing Search feature must not stop the downgrade`);
  ck(u1.lines.filter((l) => /STRIPE SEARCH UNAVAILABLE/.test(l)).length === 1, `U1: ${label}: not logged exactly once as STRIPE SEARCH UNAVAILABLE`);
}
// opposites: anything else stays a 503 with nothing written
for (const [label, fault] of SEARCH_BROKEN) {
  reset();
  paidRow('user-a');
  net.subs.set('sub_A', SUB({ status: 'canceled' }));
  net.fault.search = fault;
  const u1o = await send(event('customer.subscription.deleted', SUB({ status: 'canceled' })));
  ck(u1o.code === 503 && net.writes.length === 0 && !u1o.lines.some((l) => /STRIPE SEARCH UNAVAILABLE/.test(l)),
    `U1: ${label}: answered ${u1o.code}, wrote ${net.writes.length} — only a clear "search unavailable" may skip the check`);
}
// the search call (and only it) pins Stripe-Version 2024-06-20
reset();
paidRow('user-a');
net.subs.set('sub_A', SUB({ status: 'canceled' }));
net.subs.set('sub_C', SUBC());
await send(event('customer.subscription.deleted', SUB({ status: 'canceled' })));
ck(net.searchVersions.length === 1 && net.searchVersions[0] === '2024-06-20', `U1: the search call sent Stripe-Version ${JSON.stringify(net.searchVersions)} (want 2024-06-20)`);
ck(!net.versionLeak, `U1: a non-search call pinned a Stripe-Version (${net.versionLeak})`);

// ── v692 round 5 ─────────────────────────────────────────────────────────────
// N6. the index hands back ANOTHER user's live subscription → the row never moves to it
reset();
paidRow('user-a');
net.subs.set('sub_A', SUB({ status: 'canceled' }));
net.subs.set('sub_C', SUBC({ metadata: { user_id: 'user-z', plan: 'agency' } }));
net.searchOverride = [SUBC({ metadata: { user_id: 'user-z', plan: 'agency' } })];
const n6 = await send(event('customer.subscription.deleted', SUB({ status: 'canceled' })));
ck(ok2(n6) && plan('user-a') === 'free' && !row('user-a').stripe_subscription_id,
  `N6: a search hit belonging to user-z moved user-a's row (plan=${plan('user-a')} sub=${row('user-a').stripe_subscription_id})`);
// opposite: the same hit for THIS user moves it
reset();
paidRow('user-a');
net.subs.set('sub_A', SUB({ status: 'canceled' }));
net.subs.set('sub_C', SUBC());
net.searchOverride = [SUBC()];
const n6o = await send(event('customer.subscription.deleted', SUB({ status: 'canceled' })));
ck(ok2(n6o) && row('user-a').stripe_subscription_id === 'sub_C', `N6: this user's own hit did not move the row (sub=${row('user-a').stripe_subscription_id})`);

https.request = realRequest;
clearTimeout(WALL);
if (fails.length) {
  console.error('FAIL: rv-money-webhook');
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}
console.log('rv-money-webhook: every arm and its opposite held');
console.log('WEBHOOK ACK HONEST');
