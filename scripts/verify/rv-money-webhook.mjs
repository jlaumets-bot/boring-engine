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
  process.env.STRIPE_SECRET_KEY = TEST_KEY;
}
const sp = (p) => new URL('https://h' + p).searchParams;
const eq = (q, k) => { const v = q.get(k); return v && v.startsWith('eq.') ? v.slice(3) : null; };

function faultReply(mode) {
  if (!mode) return null;
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
  let m = o.path.match(/^\/v1\/events\/([^?]+)$/);
  if (m) {
    const f = faultReply(net.fault.event); if (f) return f;
    const e = net.events.get(decodeURIComponent(m[1]));
    return e ? { status: 200, body: JSON.stringify(e) } : { status: 404, body: JSON.stringify({ error: { message: 'No such event' } }) };
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
  ck(ok2(r5) && plan('user-a') === 'free' && !row('user-a').stripe_subscription_id,
    `R: a grant that raced the subscription becoming "${st}" left plan=${plan('user-a')} sub=${row('user-a').stripe_subscription_id}`);
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

https.request = realRequest;
clearTimeout(WALL);
if (fails.length) {
  console.error('FAIL: rv-money-webhook');
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}
console.log('rv-money-webhook: every arm and its opposite held');
console.log('WEBHOOK ACK HONEST');
