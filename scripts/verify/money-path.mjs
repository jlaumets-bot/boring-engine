#!/usr/bin/env node
// GATE: money-path — the four ways a paying customer could be charged and get nothing,
// or spend without ever hitting a limit, stay closed.
//
// Every check below corresponds to a defect that was live in production:
//
//   1. NOTHING BUT THE BROWSER REDIRECT GRANTED A FIRST PURCHASE. stripe-webhook handled only
//      subscription deleted/updated and invoice.payment_failed — none of which can grant — and
//      it resolved the user with userIdByStripe(), which filters on stripe_subscription_id /
//      stripe_customer_id: columns ONLY a successful checkout-confirm writes. Before a successful
//      redirect no row carries them, so the webhook was structurally incapable of rescuing a
//      closed tab. The fix grants on checkout.session.completed / customer.subscription.created
//      and falls back to the metadata create-checkout stamps on every subscription.
//   2. usageThisPeriod WAS ONE UNBOUNDED GET. PostgREST silently truncates at db-max-rows
//      (default 1000), so the largest credit total computable was ~1000 — BELOW the agency limit
//      of 2500, which could therefore never fire. And with no `order=`, the OLDEST rows came
//      back, so past 1000 rows/month the 60-second burst window contained none of them.
//   3. `sharpen` — two sequential LLM calls — was the only guard()ed action in the whole API
//      missing from BOTH weight maps, so it silently defaulted to 1 credit / EUR 0.01.
//   4. THE USAGE WINDOW WAS ALWAYS THE 1st OF THE UTC MONTH. A 7-day trial started on the 28th
//      got a fresh 150 credits on the 1st (up to 300 on a 150-credit trial), and a subscriber
//      billed on the 15th had their allowance reset 14 days early, every month.
//
// HOW IT CHECKS: it EXECUTES the real handlers. api/stripe-webhook.js runs against a fake Stripe
// events API and a stubbed store; api/_usage.js runs against a fake PostgREST that reproduces the
// db-max-rows truncation, the Content-Range count and the gte/offset/limit/order semantics. A grep
// passes on an unwired import; these do not. Nothing here asserts on wording — an assertion coupled
// to copy punishes improving the copy (v619).
//
// Run:  node scripts/verify/money-path.mjs
// EXPECT: money path verification passed

import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = join(ROOT, 'api');
const require_ = createRequire(import.meta.url);

const fail = [];
const ck = (cond, msg) => { if (!cond) fail.push(msg); };
// A "note" is a claim that a block held. Printing one after a failed assertion in the same block
// would be the gate lying about its own result, so every note is gated on the failure count.
let markN = 0;
const mark = () => { markN = fail.length; };
const note = (m) => { if (fail.length === markN) console.log('  ' + m); };

// ── deterministic environment ────────────────────────────────────────────────
// Set BEFORE api/_usage.js is required: it reads the fuse and burst limit at load time, so a
// developer's real env would otherwise decide whether the burst assertions can fire at all.
// The Supabase/Stripe values below are fakes routed to an in-process server; no real credential
// is read, and the network layer throws on any host it does not recognise.
delete process.env.RATE_LIMIT_PER_MIN;
delete process.env.COST_CAP_EUR;
process.env.SUPABASE_URL = 'https://money-path-gate.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'gate-fake-service-role';
process.env.STRIPE_SECRET_KEY = 'sk_test_money_path_gate';
process.env.STRIPE_PRICE_PRO = 'price_gate_pro';
process.env.STRIPE_PRICE_AGENCY = 'price_gate_agency';
delete process.env.STRIPE_PRICE_STARTER;

const realNow = Date.now;
async function withClock(ms, fn) {
  Date.now = () => ms;
  try { return await fn(); } finally { Date.now = realNow; }
}

// ── fake network ─────────────────────────────────────────────────────────────
// Replaces https.request on the shared CJS module object, so api/_usage.js and
// api/stripe-webhook.js (both `require('https')`) go through it without knowing.
const https = require_('node:https');
const realRequest = https.request;

const DB_MAX_ROWS = 1000;              // what PostgREST silently truncates at
const net = {
  plans: new Map(),                    // userId -> user_plans row
  events: new Map(),                   // evt_… -> Stripe event object
  subs: new Map(),                     // sub_… -> the subscription as Stripe holds it NOW (v691)
  usage: new Map(),                    // userId -> [{ action, created_at }] (sorted ASC)
  requests: [],                        // every intercepted request, for anti-vacuous checks
};

function q(path) { return new URL('https://h' + path).searchParams; }
function eqVal(sp, key) {
  const v = sp.get(key);
  return v && v.startsWith('eq.') ? v.slice(3) : null;
}

function postgrest(opts, payload) {
  const sp = q(opts.path);
  const table = opts.path.split('?')[0];
  if (table === '/rest/v1/user_plans') {
    if (opts.method === 'GET') {
      const uid = eqVal(sp, 'user_id');
      if (uid) { const r = net.plans.get(uid); return { status: 200, body: JSON.stringify(r ? [r] : []) }; }
      const bySub = eqVal(sp, 'stripe_subscription_id');
      const byCus = eqVal(sp, 'stripe_customer_id');
      const hit = [...net.plans.values()].filter((r) =>
        (bySub && r.stripe_subscription_id === bySub) || (byCus && r.stripe_customer_id === byCus));
      return { status: 200, body: JSON.stringify(hit) };
    }
    if (opts.method === 'POST') {
      const b = JSON.parse(payload);
      if (!net.plans.has(b.user_id)) net.plans.set(b.user_id, Object.assign({ plan: 'trial' }, b));
      return { status: 201, body: '' };
    }
    if (opts.method === 'PATCH') {
      const uid = eqVal(sp, 'user_id');
      const b = JSON.parse(payload);
      net.plans.set(uid, Object.assign({}, net.plans.get(uid) || { user_id: uid }, b));
      return { status: 204, body: '' };
    }
  }
  if (table === '/rest/v1/usage_events' && opts.method === 'GET') {
    const uid = eqVal(sp, 'user_id');
    const gte = (sp.get('created_at') || '').replace(/^gte\./, '');
    const gteMs = Date.parse(gte);
    let rows = (net.usage.get(uid) || []).filter((r) => !Number.isFinite(gteMs) || Date.parse(r.created_at) >= gteMs);
    const total = rows.length;
    if ((sp.get('order') || '').includes('desc')) rows = rows.slice().reverse();
    const offset = Number(sp.get('offset') || 0);
    const limit = Math.min(Number(sp.get('limit') || DB_MAX_ROWS), DB_MAX_ROWS);   // the truncation
    const page = rows.slice(offset, offset + limit);
    const headers = {};
    if (String((opts.headers || {}).Prefer || '').includes('count=exact')) {
      headers['content-range'] = page.length
        ? `${offset}-${offset + page.length - 1}/${total}`
        : `*/${total}`;
    }
    return { status: 200, headers, body: JSON.stringify(page) };
  }
  return { status: 404, body: '{}' };
}

function stripe(opts) {
  const m = opts.path.match(/^\/v1\/events\/([^?]+)$/);
  if (m) {
    const evt = net.events.get(decodeURIComponent(m[1]));
    if (!evt) return { status: 404, body: JSON.stringify({ error: { message: 'No such event' } }) };
    return { status: 200, body: JSON.stringify(evt) };
  }
  // v691 — the webhook decides from the subscription's CURRENT state (events arrive out of order).
  // Like Stripe, the fake holds that state per subscription id, set explicitly by each test with
  // live(); delivering an event does NOT change it, and a subscription it does not hold is a 404.
  const ms = opts.path.match(/^\/v1\/subscriptions\/([^?]+)$/);
  if (ms) {
    const cur = net.subs.get(decodeURIComponent(ms[1]));
    if (!cur) return { status: 404, body: JSON.stringify({ error: { message: 'No such subscription' } }) };
    return { status: 200, body: JSON.stringify(cur) };
  }
  return { status: 404, body: JSON.stringify({ error: { message: 'unmapped' } }) };
}

function route(opts, payload) {
  net.requests.push({ host: opts.hostname, method: opts.method, path: opts.path, headers: opts.headers });
  if (opts.hostname === 'api.stripe.com') return stripe(opts, payload);
  if (opts.hostname === 'money-path-gate.invalid') return postgrest(opts, payload);
  throw new Error('money-path gate: unexpected outbound host ' + opts.hostname + ' — refusing to hit the network');
}

function installNet() {
  https.request = function (opts, cb) {
    const req = new EventEmitter();
    let payload = '';
    req.write = (c) => { payload += c; return true; };
    req.setTimeout = () => req;
    req.destroy = () => req;
    req.setHeader = () => req;
    req.end = () => {
      setImmediate(() => {
        let out;
        try { out = route(opts, payload); } catch (e) { req.emit('error', e); return; }
        const resp = new EventEmitter();
        resp.statusCode = out.status;
        resp.headers = out.headers || {};
        cb(resp);
        setImmediate(() => { if (out.body) resp.emit('data', out.body); resp.emit('end'); });
      });
      return req;
    };
    return req;
  };
}
function uninstallNet() { https.request = realRequest; }

// Capture stderr for the "was this failure made findable?" checks and to keep the
// deliberately-failing runs quiet.
function withQuietErrors(fn) {
  const real = console.error, lines = [];
  console.error = (...a) => lines.push(a.map(String).join(' '));
  try { return { out: fn(), lines }; } finally { console.error = real; }
}
async function withQuietErrorsAsync(fn) {
  const real = console.error, lines = [];
  console.error = (...a) => lines.push(a.map(String).join(' '));
  try { const out = await fn(); return { out, lines }; } finally { console.error = real; }
}

installNet();

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE PLAN PERIOD (pure, so it is exactly testable)
// ═════════════════════════════════════════════════════════════════════════════
const usage = require_(join(API, '_usage.js'));

for (const fn of ['usageThisPeriod', 'checkLimit', 'getStatus', 'periodStartForRow', 'periodStartISO',
                  'getPlanSnapshot', 'setPlan', 'userIdByStripe', 'creditsFor', 'costFor']) {
  if (typeof usage[fn] !== 'function') fail.push(`_usage.js no longer exports ${fn}() — its callers break`);
}

// NOTE: periodStartForRow takes an explicit clock, but the effectivePlan() call inside it reads
// Date.now() — so a row is only classified as a live trial relative to the WALL clock. Harmless in
// production (the caller always passes Date.now()), but it means these must run under a fake clock.
await withClock(Date.UTC(2026, 2, 2, 12, 0, 0), async () => {
  mark();
  const MONTH_START = Date.UTC(2026, 2, 1);                       // 2026-03-01T00:00Z
  const NOW = Date.UTC(2026, 2, 2, 12, 0, 0);                     // the 2nd, just past the boundary

  // A trial that began on the 28th must keep ONE window across the month boundary.
  const trialRow = {
    plan: 'trial',
    trial_started_at: new Date(Date.UTC(2026, 1, 28, 9, 0, 0)).toISOString(),
    trial_ends_at: new Date(Date.UTC(2026, 2, 7, 9, 0, 0)).toISOString(),
  };
  const trialStart = Date.parse(usage.periodStartForRow(trialRow, NOW));
  ck(trialStart === Date.parse(trialRow.trial_started_at),
    'a 7-day trial started on the 28th resets on the 1st: periodStartForRow returned ' +
    new Date(trialStart).toISOString() + ' instead of the trial start — that is a second free allowance');
  ck(trialStart !== MONTH_START, 'the trial window is still the calendar month');

  // A subscriber billed on the 15th must not have their allowance reset on the 1st.
  const paidRow = { plan: 'pro', current_period_end: new Date(Date.UTC(2026, 2, 15, 8, 30, 0)).toISOString() };
  const paidStart = Date.parse(usage.periodStartForRow(paidRow, Date.UTC(2026, 2, 3, 12, 0, 0)));
  ck(paidStart === Date.UTC(2026, 1, 15, 8, 30, 0),
    'a subscriber billed on the 15th got period start ' + new Date(paidStart).toISOString() +
    ' — expected the previous 15th, not the 1st');

  // A 31st billing anchor must clamp into February rather than skipping the short month.
  const clamp = Date.parse(usage.periodStartForRow(
    { plan: 'pro', current_period_end: new Date(Date.UTC(2026, 0, 31, 10, 0, 0)).toISOString() },
    Date.UTC(2026, 2, 5, 12, 0, 0)));
  ck(clamp === Date.UTC(2026, 1, 28, 10, 0, 0),
    'a 31st billing anchor does not clamp into February: got ' + new Date(clamp).toISOString());

  // Fallback must be unchanged for a row that carries no dates, and must never throw.
  for (const bad of [null, undefined, {}, { plan: 'pro' }, { plan: 'trial' },
                     { plan: 'pro', current_period_end: 'not-a-date' },
                     { plan: 'trial', trial_started_at: 'nonsense' }]) {
    let got = null;
    try { got = usage.periodStartForRow(bad, NOW); } catch (e) { fail.push('periodStartForRow threw on ' + JSON.stringify(bad)); }
    ck(got && Date.parse(got) === MONTH_START,
      'periodStartForRow lost its calendar-month fallback for ' + JSON.stringify(bad) + ' (got ' + got + ')');
  }
  // A trial anchored implausibly far back is not a trial window any more.
  const stale = usage.periodStartForRow(
    { plan: 'trial', trial_started_at: new Date(NOW - 400 * 86400000).toISOString(), trial_ends_at: new Date(NOW + 86400000).toISOString() }, NOW);
  ck(Date.parse(stale) === MONTH_START, 'a 400-day-old "trial" anchor freezes one allowance forever');
  note('period window: trial anchored to its start, paid anchored to the billing anniversary, calendar month as fallback');
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. THE USAGE READ — executed against a PostgREST that truncates like the real one
// ═════════════════════════════════════════════════════════════════════════════
function seedUsage(userId, rows) { net.usage.set(userId, rows); }
function seedPlan(userId, row) { net.plans.set(userId, Object.assign({ user_id: userId }, row)); }
// What the pre-fix code would have read: ONE unbounded page, oldest first, capped by the server.
function naiveRead(userId, sinceMs, nowMs) {
  const all = net.usage.get(userId) || [];
  const page = all.slice(0, DB_MAX_ROWS);
  let credits = 0, recent = 0;
  for (const r of page) {
    credits += usage.creditsFor(r.action);
    if (Date.parse(r.created_at) >= nowMs - 60000) recent++;
  }
  return { credits, recent };
}

const CLOCK = Date.UTC(2026, 8, 15, 12, 0, 0);   // mid-month, so the calendar-month fallback is unambiguous

// 2a. The agency ceiling must be reachable.
await withClock(CLOCK, async () => {
  mark();
  const U = 'user-agency';
  const rows = [];
  for (let i = 2599; i >= 0; i--) rows.push({ action: 'ideas', created_at: new Date(CLOCK - (i + 1) * 1000).toISOString() });
  seedUsage(U, rows);
  seedPlan(U, { plan: 'agency' });

  const u = await usage.usageThisPeriod(U, new Date(CLOCK - 3600 * 1000).toISOString());
  ck(u.rows === 2600, `usageThisPeriod read ${u.rows} of 2600 rows — pagination is not reading past the page cap`);
  ck(u.complete === true, 'usageThisPeriod did not report the read as complete');
  ck(u.total === 2600, `Content-Range total was ${u.total}, expected 2600 — the exact count is not being read`);
  ck(u.credits === 2600, `credit total was ${u.credits}, expected 2600`);

  const naive = naiveRead(U, 0, CLOCK);
  ck(naive.credits === DB_MAX_ROWS, 'the naive counterfactual is not modelling the truncation — check the fake server');
  ck(naive.credits <= usage.PLAN_LIMITS.agency && u.credits > usage.PLAN_LIMITS.agency,
    'this case no longer discriminates: a single unbounded page yields ' + naive.credits +
    ' and the paginated read yields ' + u.credits + ' against an agency limit of ' + usage.PLAN_LIMITS.agency);

  const gate = await usage.checkLimit(U, usage.creditsFor('ideas'), 'ideas');
  ck(gate.ok === false && gate.reason === 'limit',
    `an agency account at ${u.credits} credits was NOT blocked (ok=${gate.ok}, reason=${gate.reason}) — ` +
    'the 2500 limit is unreachable again');
  ck(gate.used === 2600, `checkLimit reported used=${gate.used} — it is not seeing the paginated total`);
  note(`agency limit reachable: 2600 rows -> ${u.credits} credits (a single unbounded page would have read ${naive.credits}, under the ${usage.PLAN_LIMITS.agency} limit)`);
});

// 2b. The 60-second burst window must see the NEWEST rows when the read cannot cover everything.
// 26,000 rows exceeds the 25-page cap, so this ONLY works if the newest rows come back first —
// at any row count the pager can fully cover, order is unobservable and proves nothing.
await withClock(CLOCK, async () => {
  mark();
  const U = 'user-burst';
  const rows = [];
  for (let i = 25930; i >= 1; i--) rows.push({ action: 'stockphoto', created_at: new Date(CLOCK - 3600000 - i * 100).toISOString() });
  for (let i = 70; i >= 1; i--) rows.push({ action: 'stockphoto', created_at: new Date(CLOCK - i * 500).toISOString() });
  seedUsage(U, rows);
  seedPlan(U, { plan: 'agency' });

  const { out: u, lines } = await withQuietErrorsAsync(() =>
    usage.usageThisPeriod(U, new Date(CLOCK - 30 * 86400000).toISOString()));
  ck(u.recent === 70,
    `the burst window saw ${u.recent} of the 70 rows written in the last minute — at ${rows.length} rows the ` +
    'read is truncated, so a window that does not come back newest-first is blind');
  const naive = naiveRead(U, 0, CLOCK);
  ck(naive.recent === 0, 'the counterfactual is not discriminating — check the seed');
  ck(u.complete === false, 'a 26,000-row read reported itself complete — the page cap is not being honoured');
  ck(lines.length > 0, 'a truncated usage read produced no log line — an incomplete total must be findable');

  const { out: gate } = await withQuietErrorsAsync(() => usage.checkLimit(U, usage.creditsFor('stockphoto'), 'stockphoto'));
  ck(gate.ok === false, 'a truncated usage read waved the caller through — an incomplete read must block, not fail open');
  note(`burst window correct at ${rows.length} rows: recent=${u.recent} (oldest-first would have seen ${naive.recent})`);
});

// 2c. End to end: a trial that crosses the 1st keeps one window, and the REAL query says so.
await withClock(Date.UTC(2026, 2, 2, 12, 0, 0), async () => {
  mark();
  const U = 'user-trial-boundary';
  const trialStart = new Date(Date.UTC(2026, 1, 28, 9, 0, 0)).toISOString();
  seedPlan(U, {
    plan: 'trial', trial_started_at: trialStart,
    trial_ends_at: new Date(Date.UTC(2026, 2, 7, 9, 0, 0)).toISOString(),
  });
  seedUsage(U, [
    // Before the 1st but inside the trial — the rows the calendar-month window threw away.
    ...Array.from({ length: 5 }, (_, i) => ({ action: 'ideas', created_at: new Date(Date.UTC(2026, 1, 28, 12, i)).toISOString() })),
    ...Array.from({ length: 5 }, (_, i) => ({ action: 'ideas', created_at: new Date(Date.UTC(2026, 2, 1, 10, i)).toISOString() })),
  ]);

  const before = net.requests.length;
  const s = await usage.getStatus(U);
  ck(!s.unknown, 'getStatus fell into its fail-open catch — the assertions below would be meaningless');
  ck(s.plan === 'trial', `expected a live trial, got ${s.plan}`);
  ck(Date.parse(s.periodStart) === Date.parse(trialStart),
    `getStatus billed the window from ${s.periodStart} instead of the trial start — it is not routing through periodStartForRow`);
  ck(s.used === 10,
    `used=${s.used} across the month boundary — expected all 10 trial rows. 5 means the allowance reset on the 1st ` +
    `and this trial now has ${usage.PLAN_LIMITS.trial * 2} credits instead of ${usage.PLAN_LIMITS.trial}`);
  const evq = net.requests.slice(before).find((r) => r.path.startsWith('/rest/v1/usage_events'));
  ck(evq && decodeURIComponent(evq.path).includes('created_at=gte.' + trialStart),
    'the real usage query did not filter from the trial start — the window fix has not reached the read');
  note('trial crossing the 1st keeps one window: all 10 rows counted, query filtered from the trial start');
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. EVERY GATED ACTION IS PRICED (sharpen was in NEITHER map)
// ═════════════════════════════════════════════════════════════════════════════
{
  mark();
  ck(Number(usage.ACTION_CREDITS.sharpen) > 0, 'sharpen is unregistered in ACTION_CREDITS — two LLM calls priced by a default');
  ck(Number(usage.ACTION_COST.sharpen) > 0, 'sharpen is unregistered in ACTION_COST — the fuse cannot see what it costs');
  ck(Number(usage.ACTION_COST.sharpen) > Number(usage.ACTION_COST.ideas || 0),
    'sharpen costs no more than a single-call action, yet it makes two sequential LLM calls');

  // _usage.js DEFINES guard(); its signature is not a call site (see spend-cap.mjs).
  const files = readdirSync(API).filter((f) => f.endsWith('.js') && f !== '_usage.js');
  const sites = [];
  for (const f of files) {
    const src = readFileSync(join(API, f), 'utf8');
    for (const m of src.matchAll(/\bguard\(\s*req\s*,\s*(['"])([\w.-]+)\1/g)) sites.push({ action: m[2], file: f });
    for (const m of src.matchAll(/\bguard\(\s*req\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
      const lit = src.match(new RegExp('\\b(?:const|let|var)\\s+' + m[1] + '\\s*=\\s*([\'"])([\\w.-]+)\\1'));
      if (lit) sites.push({ action: lit[2], file: f });
      else fail.push(`${f}: guard(req, ${m[1]}) — write the action as a string literal so it can be priced`);
    }
  }
  ck(sites.length >= 15, `only ${sites.length} guard() call sites found — the scanner is broken, not the code`);
  const orphan = [...new Set(sites.map((s) => s.action))]
    .filter((a) => usage.ACTION_CREDITS[a] == null || usage.ACTION_COST[a] == null);
  ck(orphan.length === 0, 'gated action(s) missing from a weight map, so they default to 1 credit / EUR 0.01: ' +
    orphan.map((a) => `${a} (${sites.filter((s) => s.action === a).map((s) => s.file).join(', ')})`).join('; '));
  if (!orphan.length) note(`all ${new Set(sites.map((s) => s.action)).size} gated actions across ${sites.length} call sites are priced (sharpen = ${usage.ACTION_CREDITS.sharpen} credit / EUR ${usage.ACTION_COST.sharpen})`);
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. THE WEBHOOK GRANT — the real handler, against a store that knows nothing
// ═════════════════════════════════════════════════════════════════════════════
// The stub's userIdByStripe only ever answers from rows the webhook itself wrote, so on a first
// purchase it returns null on BOTH keys — exactly the production state. The only way any of the
// grant tests below can pass is if the metadata fallback genuinely resolves the user.
const planOf = (u = 'user-buyer') => (store.plans.get(u) || {}).plan || null;
const snapOf = (u = 'user-buyer') => store.plans.get(u) || null;
const store = {
  plans: new Map(),
  setPlanCalls: [],
  setPlanOk: true,
  reset() { store.plans.clear(); store.setPlanCalls.length = 0; store.setPlanOk = true; net.subs.clear(); },
};
{
  const resolved = require_.resolve(join(API, '_usage.js'));
  require_.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, children: [], paths: [],
    exports: {
      PAID_PLANS: { starter: 1, pro: 1, agency: 1 },
      async userIdByStripe(o) {
        for (const [uid, r] of store.plans) {
          if (o && o.subscriptionId && r.stripeSubscriptionId === o.subscriptionId) return uid;
          if (o && o.customerId && r.stripeCustomerId === o.customerId) return uid;
        }
        return null;
      },
      async getPlanSnapshot(uid, o) {
        const r = store.plans.get(uid) || null;
        return (o && o.strict && !r) ? { missing: true } : r;   // v691 strict mode: "no row" is not null
      },
      async setPlan(uid, plan, extra) {
        store.setPlanCalls.push({ uid, plan, extra: extra || {} });
        if (!store.setPlanOk) return false;
        const prev = store.plans.get(uid) || {};
        store.plans.set(uid, {
          plan, effectivePlan: plan,
          stripeCustomerId: (extra && extra.stripe_customer_id) || prev.stripeCustomerId || null,
          stripeSubscriptionId: (extra && extra.stripe_subscription_id) || prev.stripeSubscriptionId || null,
          currentPeriodEnd: (extra && extra.current_period_end) || prev.currentPeriodEnd || null,
        });
        return true;
      },
    },
  };
}
const webhook = require_(join(API, 'stripe-webhook.js'));

function mkRes() {
  const res = {
    _status: 0, _json: null,
    setHeader() { return res; },
    status(c) { res._status = c; return res; },
    json(o) { res._json = o; return res; },
    end() { return res; },
  };
  return res;
}
let evtN = 0;
function deliver(obj, type) {
  const id = 'evt_gate_' + (++evtN);
  net.events.set(id, { id, type, created: Math.floor(realNow() / 1000) - 5, data: { object: obj } });
  return id;
}
async function send(id) {
  const res = mkRes();
  const { lines } = await withQuietErrorsAsync(() => webhook({ method: 'POST', headers: {}, body: { id } }, res));
  return { res, lines };
}

const SESSION = (over) => Object.assign({
  id: 'cs_gate_1', object: 'checkout.session', mode: 'subscription', payment_status: 'paid',
  customer: 'cus_gate_1', subscription: 'sub_gate_1',
  metadata: { user_id: 'user-buyer', plan: 'pro' },
}, over || {});
const SUB = (over) => Object.assign({
  id: 'sub_gate_1', object: 'subscription', status: 'active', customer: 'cus_gate_1',
  current_period_end: Math.floor(realNow() / 1000) + 30 * 86400,
  items: { data: [{ price: { id: 'price_gate_pro' } }] },
  metadata: { user_id: 'user-buyer', plan: 'pro' },
}, over || {});
// Set the subscription as Stripe holds it NOW (v691: the webhook reads it; events do not set it).
const live = (o) => net.subs.set(o.id, JSON.parse(JSON.stringify(o)));

// 4a. checkout.session.completed for a subscription the database has never heard of.
{
  mark();
  store.reset();
  live(SUB());
  const id = deliver(SESSION(), 'checkout.session.completed');
  const { res } = await send(id);
  const snap = snapOf();
  ck(res._status === 200, `first purchase answered ${res._status}`);
  ck(!!snap && snap.plan === 'pro',
    'checkout.session.completed granted nothing for a subscription unknown to the database — the metadata ' +
    'fallback is not resolving the user, so a closed tab is still charged-and-never-granted');
  ck(snap && snap.stripeSubscriptionId === 'sub_gate_1' && snap.stripeCustomerId === 'cus_gate_1',
    'the grant did not persist the stripe ids, so the NEXT event for this customer still cannot resolve them');
  ck(res._json && res._json.via === 'metadata',
    `the user was resolved via "${res._json && res._json.via}" — this test is only meaningful if it came from metadata`);
  note('first purchase granted from subscription metadata with no matching database row');
}

// 4b. The same event redelivered must not double-apply, and must not downgrade.
{
  const before = store.setPlanCalls.length;
  const { res } = await send(deliver(SESSION(), 'checkout.session.completed'));
  ck(res._status === 200 && store.setPlanCalls.length === before,
    'a redelivered checkout.session.completed wrote the plan again — Stripe redelivers, this must be idempotent');
  ck(res._json && res._json.applied === false, 'the handler did not report the redelivery as already-applied');
  ck(planOf() === 'pro', 'a redelivery changed the plan');
}

// 4c. customer.subscription.created, likewise unknown to the database.
{
  mark();
  store.reset();
  live(SUB());
  const { res } = await send(deliver(SUB(), 'customer.subscription.created'));
  const snap = snapOf();
  ck(res._status === 200, `customer.subscription.created answered ${res._status}`);
  ck(!!snap && snap.plan === 'pro',
    'customer.subscription.created granted nothing for a subscription unknown to the database');
  ck(!!snap && !!snap.currentPeriodEnd, 'the grant did not persist current_period_end, so the billing window has no anchor');
  const before = store.setPlanCalls.length;
  await send(deliver(SUB(), 'customer.subscription.created'));
  ck(store.setPlanCalls.length === before, 'a redelivered customer.subscription.created wrote the plan again');
  await send(deliver(SUB(), 'customer.subscription.updated'));
  ck(planOf() === 'pro' && store.setPlanCalls.length === before,
    'a replayed subscription.updated re-wrote a row that already matched');
  note('subscription.created grants once and stays idempotent across redelivery and a replayed update');
}

// 4d. A failed plan write must be non-2xx on BOTH directions, so Stripe retries (v627).
{
  mark();
  store.reset();
  live(SUB());
  store.setPlanOk = false;
  const grant = await send(deliver(SESSION(), 'checkout.session.completed'));
  ck(grant.res._status >= 500,
    `a failed FIRST-PURCHASE write answered ${grant.res._status} — a 2xx tells Stripe "delivered, do not retry" ` +
    'and the customer stays charged and on free forever');
  ck(grant.lines.length > 0, 'a failed first-purchase write produced no log line');

  const sub = await send(deliver(SUB(), 'customer.subscription.created'));
  ck(sub.res._status >= 500, `a failed upgrade write answered ${sub.res._status} instead of asking Stripe to retry`);

  // Downgrade: give the store a paid row first so the write is genuinely needed.
  store.setPlanOk = true;
  await send(deliver(SESSION(), 'checkout.session.completed'));
  ck(planOf() === 'pro', 'setup for the downgrade case did not grant');
  store.setPlanOk = false;
  live(SUB({ status: 'canceled' }));
  const down = await send(deliver(SUB({ status: 'canceled' }), 'customer.subscription.deleted'));
  ck(down.res._status >= 500,
    `a failed DOWNGRADE answered ${down.res._status} — a cancelled customer keeps paid access forever and Stripe never retries`);
  note('a failed plan write is non-2xx on grant, upgrade and downgrade, so Stripe redelivers');
}

// 4e. A successful downgrade, and its own idempotency.
{
  store.reset();
  live(SUB());
  await send(deliver(SESSION(), 'checkout.session.completed'));
  live(SUB({ status: 'canceled' }));
  await send(deliver(SUB({ status: 'canceled' }), 'customer.subscription.deleted'));
  ck(planOf() === 'free', 'a cancelled subscription did not downgrade the user');
  const before = store.setPlanCalls.length;
  await send(deliver(SUB({ status: 'canceled' }), 'customer.subscription.deleted'));
  ck(store.setPlanCalls.length === before, 'a redelivered cancellation re-wrote a row that already said free');
}

// 4f. Negative controls — the grant must not fire on things that are not a paid purchase.
{
  mark();
  store.reset();
  live(SUB());
  const promo = await send(deliver(SESSION({ payment_status: 'no_payment_required' }), 'checkout.session.completed'));
  ck(promo.res._status === 200 && store.setPlanCalls.length === 0,
    'a 100%-off / unpaid checkout session granted a paid tier');

  const oneOff = await send(deliver(SESSION({ mode: 'payment' }), 'checkout.session.completed'));
  ck(oneOff.res._status === 200 && store.setPlanCalls.length === 0, 'a one-off payment session granted a subscription plan');

  // Unresolvable: no metadata, no matching row. Nothing may be granted, and it must be findable.
  const lost = await send(deliver(SESSION({ metadata: {}, client_reference_id: null }), 'checkout.session.completed'));
  ck(lost.res._status === 200, 'an unresolvable paid session answered non-2xx — Stripe would retry forever on a human problem');
  ck(store.setPlanCalls.length === 0, 'an unresolvable session granted a plan to somebody');
  ck(lost.lines.length > 0 && lost.lines.some((l) => /cs_gate_1|sub_gate_1|cus_gate_1/.test(l)),
    'a PAID BUT UNRESOLVABLE session logged nothing carrying its stripe ids — nobody can grant it by hand');

  // A brand-new subscription still confirming its first payment is not a cancellation.
  store.reset();
  live(SUB({ status: 'incomplete' }));
  const incomplete = await send(deliver(SUB({ status: 'incomplete' }), 'customer.subscription.created'));
  ck(incomplete.res._status === 200 && store.setPlanCalls.length === 0,
    'a subscription in `incomplete` (card in 3DS) was treated as a cancellation and downgraded');

  // A forged event id must resolve to nothing.
  const forged = await send('evt_does_not_exist');
  ck(forged.res._status === 200 && store.setPlanCalls.length === 0, 'an event id Stripe does not know still changed a plan');
  note('negative controls hold: unpaid, one-off, unresolvable, incomplete and forged events grant nothing');
}

// 4h. (v691) Late deliveries decide from Stripe's CURRENT state, not the event's snapshot.
{
  mark();
  store.reset();
  live(SUB());
  const lateUpdate = deliver(SUB(), 'customer.subscription.updated');
  const lateCheckout = deliver(SESSION(), 'checkout.session.completed');
  await send(deliver(SESSION(), 'checkout.session.completed'));
  live(SUB({ status: 'canceled' }));
  await send(deliver(SUB({ status: 'canceled' }), 'customer.subscription.deleted'));
  ck(planOf() === 'free', 'setup for the late-delivery case did not downgrade');
  const writesBefore = store.setPlanCalls.length;
  const u = await send(lateUpdate);
  ck(u.res._status === 200 && planOf() === 'free',
    `a LATE subscription.updated(active) after the cancellation left plan=${planOf()} — a cancelled customer got paid access back`);
  const c = await send(lateCheckout);
  ck(c.res._status === 200 && planOf() === 'free',
    `a LATE checkout.session.completed after the cancellation left plan=${planOf()}`);
  ck(store.setPlanCalls.length === writesBefore,
    `the late deliveries wrote the plan ${store.setPlanCalls.length - writesBefore} time(s) — they were decided from the event snapshot, not Stripe's current state`);
  note('late updated/checkout deliveries after a cancellation grant nothing');
}

// 4g. create-checkout must refuse a second subscription for someone already paying.
{
  const src = readFileSync(join(API, 'create-checkout.js'), 'utf8');
  const iSnap = src.indexOf('getPlanSnapshot');
  const iPost = src.indexOf("stripePost('/v1/checkout/sessions'");
  ck(iSnap !== -1 && iPost !== -1 && iSnap < iPost,
    'create-checkout no longer reads the plan before creating a session — it always creates a NEW subscription ' +
    'with no `customer` param, so an existing subscriber is billed twice');
  ck(/status\(409\)/.test(src), 'create-checkout has no refusal status for an already-subscribed caller');
  ck(!/status\(402\)/.test(src), 'create-checkout refuses with 402, which makes app.html reopen the upgrade modal — the loop the refusal exists to break');
}

uninstallNet();

if (fail.length) {
  console.error('\nFAIL: money-path');
  for (const f of fail) console.error('  - ' + f);
  process.exit(1);
}
console.log('money path verification passed');
