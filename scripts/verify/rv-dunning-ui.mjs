#!/usr/bin/env node
// GATE: rv-dunning-ui (v692) — a customer dropped to free for a FAILED CARD can see and reach
// "Manage plan & billing", and the checkout errors say what actually happened.
//
// WHY THIS EXISTS
//   On past_due / unpaid / incomplete the webhook drops the plan to free but keeps the Stripe ids,
//   and create-checkout refuses a new checkout with 409 payment_issue ("update your card in Manage
//   plan & billing"). The app only drew that button for PAID plans — a dead end. And every 503 from
//   checkout read "Plans are launching soon", including "we couldn't check your subscription".
//   Separately, checkout-confirm could write a paid plan with NO subscription id, which the webhook
//   now reads as hand-granted (never downgraded).
//
// HOW IT CHECKS
//   It EXECUTES the real api/usage.js, api/create-portal-session.js and api/checkout-confirm.js on
//   top of the REAL api/_usage.js / api/_brandlimit.js. Only the network and the sign-in are fake:
//   https.request is an in-process PostgREST (user_plans; other tables answer []) and an in-process
//   Stripe. The app side RUNS the real planBoxHtml / showUpgrade / showManageBilling / startCheckout
//   lifted out of app.html into node:vm with a tiny DOM. Every arm has its opposite.
//
// RUN:    node scripts/verify/rv-dunning-ui.mjs
// EXPECT: prints "DUNNING UI OK" and exits 0.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import fs from 'node:fs'; import vm from 'node:vm';

setTimeout(() => { console.log('FAIL: wall clock (60s) exceeded — a handler hung'); process.exit(3); }, 60000).unref();
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require_ = createRequire(import.meta.url);
let fail = 0; const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('ok:', m); };
const J = v => JSON.stringify(v);

process.env.SUPABASE_URL = 'https://dunning-ui-gate.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'gate-fake-service-role';
process.env.STRIPE_SECRET_KEY = 'sk_test_dunning_ui_gate';

// ── fake network ─────────────────────────────────────────────────────────────────────────────
const https = require_('node:https');
const net = { plans: new Map(), fault: {}, patches: [], sessions: new Map(), subs: new Map(), portal: [] };
const eq = (p, k) => { const v = new URL('https://h' + p).searchParams.get(k); return v && v.startsWith('eq.') ? v.slice(3) : null; };
function postgrest(o, payload) {
  const base = o.path.split('?')[0];
  if (base !== '/rest/v1/user_plans') return { status: 200, body: '[]' };      // usage_events, brands, …
  if (net.fault.plans) return { status: 503, body: JSON.stringify({ message: 'upstream timeout' }) };
  const uid = eq(o.path, 'user_id');
  if (o.method === 'GET') { const r = net.plans.get(uid); return { status: 200, body: JSON.stringify(r ? [Object.assign({ user_id: uid }, r)] : []) }; }
  if (o.method === 'POST') { const b = JSON.parse(payload); if (!net.plans.has(b.user_id)) net.plans.set(b.user_id, Object.assign({ plan: 'trial' }, b)); return { status: 201, body: '' }; }
  if (o.method === 'PATCH') { const b = JSON.parse(payload); net.patches.push(b); net.plans.set(uid, Object.assign({}, net.plans.get(uid), b)); return { status: 204, body: '' }; }
  return { status: 405, body: '{}' };
}
function stripe(o) {
  let m = o.path.match(/^\/v1\/checkout\/sessions\/([^?]+)$/);
  if (m) { const s = net.sessions.get(decodeURIComponent(m[1])); return s ? { status: 200, body: J(s) } : { status: 404, body: J({ error: { message: 'No such session' } }) }; }
  m = o.path.match(/^\/v1\/subscriptions\/([^?]+)$/);
  if (m) { const s = net.subs.get(decodeURIComponent(m[1])); return s ? { status: 200, body: J(s) } : { status: 404, body: J({ error: { message: 'No such subscription' } }) }; }
  if (o.path === '/v1/billing_portal/sessions' && o.method === 'POST') { net.portal.push(1); return { status: 200, body: J({ url: 'https://billing.stripe.com/p/session/gate' }) }; }
  return { status: 404, body: J({ error: { message: 'unmapped' } }) };
}
https.request = function (opts, cb) {
  const req = new EventEmitter(); let payload = '';
  req.write = c => { payload += c; return true; };
  req.setTimeout = (ms, fn) => { if (typeof fn === 'function') req.on('timeout', fn); return req; };
  req.setHeader = () => req; req.destroy = err => { setImmediate(() => req.emit('error', err || new Error('destroyed'))); return req; };
  req.end = () => { setImmediate(() => {
    let out;
    try {
      if (opts.hostname === 'api.stripe.com') out = stripe(opts, payload);
      else if (opts.hostname === 'dunning-ui-gate.invalid') out = postgrest(opts, payload);
      else throw new Error('rv-dunning-ui: unexpected outbound host ' + opts.hostname);
    } catch (e) { req.emit('error', e); return; }
    const resp = new EventEmitter(); resp.statusCode = out.status; resp.headers = {};
    cb(resp); setImmediate(() => { if (out.body) resp.emit('data', out.body); resp.emit('end'); });
  }); return req; };
  return req;
};
let USER = { id: 'user-a', email: 'a@example.test' };
{ const p = require_.resolve(join(ROOT, 'api', '_requireUser.js'));
  require_.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports: async () => USER }; }
const usageMod = require_(join(ROOT, 'api', '_usage.js'));
const usageApi = require_(join(ROOT, 'api', 'usage.js'));
const portalApi = require_(join(ROOT, 'api', 'create-portal-session.js'));
const confirmApi = require_(join(ROOT, 'api', 'checkout-confirm.js'));
async function call(handler, method, body) {
  return await new Promise((resolve, reject) => {
    const res = { code: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); return this; }, end() { resolve({ code: this.code, body: null }); } };
    Promise.resolve(handler({ method, headers: { origin: 'https://contentshrimp.com' }, body: body || {} }, res)).catch(reject);
  });
}
const FUTURE = new Date(Date.now() + 20 * 86400000).toISOString();
const PAST = new Date(Date.now() - 20 * 86400000).toISOString();

(async () => {
  // ── 1. /api/usage tells the app about a payment problem (and nothing else changes) ───────────
  const row = (uid, r) => { net.plans.set(uid, Object.assign({ trial_ends_at: PAST, created_at: PAST }, r)); USER = { id: uid }; };
  row('paid', { plan: 'pro', stripe_customer_id: 'cus_p', stripe_subscription_id: 'sub_p', current_period_end: FUTURE });
  let r = await call(usageApi, 'GET');
  ok(r.code === 200 && r.body.plan === 'pro' && J(r.body.billing) === J({ paymentIssue: false, canManage: true }),
     'a paying customer: plan pro, no payment issue, can manage (' + J(r.body.billing) + ')');

  row('dunning', { plan: 'free', stripe_customer_id: 'cus_d', stripe_subscription_id: 'sub_d' });
  r = await call(usageApi, 'GET');
  ok(r.code === 200 && r.body.plan === 'free' && r.body.billing && r.body.billing.paymentIssue === true && r.body.billing.canManage === true,
     'free + a live subscription id + a customer id (a failed card) -> billing.paymentIssue (' + J(r.body.billing) + ')');
  ok(typeof r.body.used === 'number' && typeof r.body.limit === 'number' && r.body.brands && typeof r.body.brands === 'object',
     'and the existing plan response is intact (used/limit/brands still there)');

  row('plainfree', { plan: 'free' });
  r = await call(usageApi, 'GET');
  ok(r.code === 200 && r.body.billing && r.body.billing.paymentIssue === false && r.body.billing.canManage === false,
     'opposite arm: a free user who never paid has no payment issue and nothing to manage (' + J(r.body.billing) + ')');

  row('churned', { plan: 'free', stripe_customer_id: 'cus_c', stripe_subscription_id: null });
  r = await call(usageApi, 'GET');
  ok(r.body.billing && r.body.billing.paymentIssue === false && r.body.billing.canManage === true,
     'a customer whose subscription ENDED (id cleared by the webhook) is not told a payment failed (' + J(r.body.billing) + ')');

  row('unread', { plan: 'pro' }); net.fault.plans = true;
  r = await call(usageApi, 'GET');
  net.fault.plans = false;
  ok(r.code === 200 && r.body.unknown === true && r.body.plan === 'trial' && r.body.billing && r.body.billing.paymentIssue === false && r.body.billing.unknown === true,
     'an unreadable plan row keeps the existing fail-open answer (unknown:true) and claims no payment issue (' + J(r.body.billing) + ')');

  // the new rider must never break the response it rides on
  const realSnap = usageMod.getPlanSnapshot;
  usageMod.getPlanSnapshot = async () => { throw new Error('boom'); };
  row('dunning2', { plan: 'free', stripe_customer_id: 'cus_d2', stripe_subscription_id: 'sub_d2' });
  r = await call(usageApi, 'GET');
  usageMod.getPlanSnapshot = realSnap;
  ok(r.code === 200 && r.body.plan === 'free' && typeof r.body.used === 'number' && r.body.billing && r.body.billing.unknown === true,
     'if the billing read throws, /api/usage still answers 200 with the plan, and billing says unknown');

  // ── 2. the portal opens for a FREE row that has a customer id ───────────────────────────────
  row('dunning', { plan: 'free', stripe_customer_id: 'cus_d', stripe_subscription_id: 'sub_d' });
  r = await call(portalApi, 'POST');
  ok(r.code === 200 && /billing\.stripe\.com/.test(r.body && r.body.url || ''), 'create-portal-session opens the portal for a free row with a customer id (' + r.code + ')');
  row('plainfree', { plan: 'free' });
  r = await call(portalApi, 'POST');
  ok(r.code === 400 && r.body.error === 'no_subscription', 'opposite arm: no customer id -> 400 no_subscription');

  // ── 3. checkout-confirm never grants a paid plan without a subscription id ──────────────────
  const now = Math.floor(Date.now() / 1000);
  row('buyer', { plan: 'free' }); net.patches.length = 0;
  net.sessions.set('cs_nosub', { id: 'cs_nosub', payment_status: 'paid', created: now, customer: 'cus_b', subscription: null, metadata: { user_id: 'buyer', plan: 'pro' } });
  const logs = []; const oe = console.error; console.error = (...a) => logs.push(a.join(' '));
  r = await call(confirmApi, 'POST', { sessionId: 'cs_nosub' });
  console.error = oe;
  ok(r.code !== 200 && r.code !== 402 && r.body && r.body.ok === false, 'a paid session with NO subscription is refused (' + r.code + ', not 200 and not 402)');
  ok(!net.patches.some(p => p.plan && p.plan !== 'free') && net.plans.get('buyer').plan === 'free', 'and no paid plan was written');
  ok(logs.some(l => /WITHOUT A SUBSCRIPTION/.test(l) && /cs_nosub/.test(l)), 'and it is logged with the session id a human needs');
  net.subs.set('sub_b', { id: 'sub_b', status: 'active' });
  net.sessions.set('cs_ok', { id: 'cs_ok', payment_status: 'paid', created: now, customer: 'cus_b', subscription: 'sub_b', metadata: { user_id: 'buyer', plan: 'pro' } });
  r = await call(confirmApi, 'POST', { sessionId: 'cs_ok' });
  ok(r.code === 200 && r.body.ok === true && net.plans.get('buyer').plan === 'pro' && net.plans.get('buyer').stripe_subscription_id === 'sub_b',
     'opposite arm: a paid session WITH a live subscription is granted, with the subscription id stored');

  // ── 4. the app: Manage button + honest line, and checkout errors that say what happened ─────
  const html = fs.readFileSync(join(ROOT, 'app.html'), 'utf8');
  const grab = n => {
    let i = html.indexOf('\nfunction ' + n + '('); if (i < 0) i = html.indexOf('\nasync function ' + n + '(');
    if (i < 0) throw new Error('no ' + n + ' in app.html');
    return html.slice(i + 1, html.indexOf('\n}', i) + 2);
  };
  const toasts = [], appended = [];
  const byId = new Map();
  const mkEl = () => ({ id: '', className: '', innerHTML: '', onclick: null, remove() { byId.delete(this.id); } });
  const c = {
    console, URL, csUsage: null, csUsageLoadFailed: false,
    showToast: (m) => toasts.push(m),
    window: { location: { href: '' } },
    document: {
      createElement: () => mkEl(),
      getElementById: (id) => byId.get(id) || (id === 'csUpgradeClose' ? mkEl() : null),
      body: { appendChild: (el) => { appended.push(el); if (el.id) byId.set(el.id, el); } },
    },
    fetch: null,
  };
  vm.createContext(c);
  const constLine = (html.match(/^const CS_PAY_ISSUE_LINE = .*$/m) || [''])[0];
  ok(!!constLine, 'the payment-issue line is one named constant in app.html');
  vm.runInContext(constLine.replace(/^const /, 'var '), c);
  for (const n of ['escHtml', 'safeUrl', 'planLabel', 'planBoxHtml', 'csSafeStripePayUrl', 'showManageBilling', 'showUpgrade', 'startCheckout']) vm.runInContext(grab(n), c);
  const LINE = c.CS_PAY_ISSUE_LINE;

  c.csUsage = { plan: 'free', used: 3, limit: 40, billing: { paymentIssue: true, canManage: true } };
  let box = vm.runInContext('planBoxHtml()', c);
  ok(/openBillingPortal\(this\)/.test(box) && /Manage plan &amp; billing/.test(box), 'flagged free user: the Plan box shows "Manage plan & billing"');
  ok(box.includes(LINE) && /payment failed/i.test(LINE), 'and the honest line: ' + J(LINE));
  ok(!/showUpgrade\(csUsage\)/.test(box), 'and no Upgrade button that would start a double-billing checkout');
  c.csUsage = { plan: 'free', used: 3, limit: 40, billing: { paymentIssue: false, canManage: false } };
  box = vm.runInContext('planBoxHtml()', c);
  ok(!/openBillingPortal/.test(box) && !box.includes(LINE) && /showUpgrade\(csUsage\)/.test(box), 'opposite arm: no flag -> Upgrade, no Manage button, no line');
  c.csUsage = { plan: 'free', used: 3, limit: 40 };
  box = vm.runInContext('planBoxHtml()', c);
  ok(!/openBillingPortal/.test(box) && !box.includes(LINE), 'an older /api/usage answer with no billing field renders as before');
  c.csUsage = { plan: 'pro', used: 3, limit: 750, billing: { paymentIssue: false, canManage: true } };
  box = vm.runInContext('planBoxHtml()', c);
  ok(/openBillingPortal/.test(box) && !box.includes(LINE), 'a paying customer still gets Manage, with no payment-failed line');

  // the limit modal: a flagged user is sent to billing, not to a new checkout
  const lastOverlay = () => appended[appended.length - 1] || { innerHTML: '' };
  c.csUsage = { plan: 'free', used: 40, limit: 40, billing: { paymentIssue: true, canManage: true } };
  vm.runInContext("showUpgrade({ plan: 'free', used: 40, limit: 40 })", c);
  ok(/openBillingPortal/.test(lastOverlay().innerHTML) && !/startCheckout/.test(lastOverlay().innerHTML), 'the limit modal for a flagged user points to billing, not checkout');
  c.csUsage = { plan: 'free', used: 40, limit: 40 };
  vm.runInContext("showUpgrade({ plan: 'free', used: 40, limit: 40 })", c);
  ok(/startCheckout\('pro'\)/.test(lastOverlay().innerHTML), 'opposite arm: an ordinary free user still gets the upgrade modal');

  // startCheckout's error handling
  const answer = (status, body, badJson) => { c.fetch = async () => ({ status, ok: status < 300, json: async () => { if (badJson) throw new Error('not json'); return body; } }); };
  const run = async () => { toasts.length = 0; appended.length = 0; byId.clear(); c.window.location.href = ''; await vm.runInContext("startCheckout('pro')", c); };
  const CHECK_FAILED = 'Could not check your current subscription just now — please try again in a minute.';
  answer(503, { error: CHECK_FAILED, code: 'subscription_check_failed' }); await run();
  ok(toasts.includes(CHECK_FAILED) && !toasts.some(t => /launching soon/i.test(t)), '503 with an error -> the server\'s text, not "Plans are launching soon"');
  answer(503, {}); await run();
  ok(toasts.some(t => /launching soon/i.test(t)), '503 with no error text -> the old "launching soon" line');
  answer(503, null, true); await run();
  ok(toasts.some(t => /launching soon/i.test(t)), '503 with a non-JSON body -> the old line, and no crash');
  const PAY = 'Your last payment did not go through, so your plan is paused. Update your card in "Manage plan & billing" to get it back — a new checkout would charge you twice.';
  answer(409, { error: PAY, code: 'payment_issue', manageBilling: true, status: 'past_due' }); await run();
  const ov = lastOverlay().innerHTML;
  ok(ov.includes('Update your card in &quot;Manage plan &amp; billing&quot;'), '409 payment_issue shows the server\'s message (escaped)');
  ok(/openBillingPortal\(this\)/.test(ov) && !/startCheckout/.test(ov) && !/Upgrade to Pro/.test(ov), 'and offers Manage plan & billing — not the upgrade modal');
  ok(c.window.location.href === '', 'and does not navigate anywhere');
  // r3 — Stripe's hosted invoice page: a validated payUrl adds "Pay now"; anything else is ignored
  const INV = 'https://invoice.stripe.com/i/acct_1Gate/test_YWNjdF8x?s=ap';
  answer(409, { error: PAY, code: 'payment_issue', manageBilling: true, status: 'unpaid', payUrl: INV }); await run();
  let o = lastOverlay().innerHTML;
  ok(/>Pay now</.test(o) && o.includes('href="' + INV.replace(/&/g, '&amp;') + '"') && /openBillingPortal\(this\)/.test(o),
     'payment_issue with a Stripe invoice payUrl -> a "Pay now" button to exactly that page, plus Manage');
  ok(o.indexOf('Pay now') < o.indexOf('openBillingPortal') && /rel="noopener noreferrer"/.test(o), 'Pay now comes first (primary) and opens without handing Stripe our window');
  answer(409, { error: PAY, code: 'payment_issue', manageBilling: true, payUrl: 'https://pay.stripe.com/invoice/acct_1/x' }); await run();
  ok(/>Pay now</.test(lastOverlay().innerHTML), 'pay.stripe.com is accepted too');
  answer(409, { error: PAY, code: 'payment_issue', manageBilling: true }); await run();
  ok(!/Pay now/.test(lastOverlay().innerHTML) && /openBillingPortal/.test(lastOverlay().innerHTML), 'opposite arm: no payUrl -> no Pay now, Manage as before');
  for (const bad of ['http://invoice.stripe.com/i/x', 'https://evil.example/i/x', 'https://invoice.stripe.com.evil.example/i/x',
                     'javascript:alert(1)', 'https://user:pw@invoice.stripe.com/i/x', 'https://invoice.stripe.com:8443/i/x', 42, { href: INV }]) {
    answer(409, { error: PAY, code: 'payment_issue', manageBilling: true, payUrl: bad }); await run();
    o = lastOverlay().innerHTML;
    ok(!/Pay now/.test(o) && !/evil|javascript:/.test(o) && /openBillingPortal/.test(o), 'a non-Stripe / non-https payUrl is ignored: ' + J(bad));
  }
  // r4 (N3) — the ACCEPTED value is the parsed URL, re-serialised: a quote or angle bracket in a Stripe
  // URL comes out percent-encoded, so it can never break out of the href attribute on its own.
  const RAW = 'https://invoice.stripe.com/i/acct_1/x"onmouseover=alert(1)<b>';
  const safe = c.csSafeStripePayUrl(RAW);
  ok(safe.includes('%22') && safe.includes('%3C') && !/["<>]/.test(safe), 'a Stripe URL containing " and < comes out percent-encoded (' + J(safe) + ')');
  answer(409, { error: PAY, code: 'payment_issue', manageBilling: true, payUrl: RAW }); await run();
  ok(/>Pay now</.test(lastOverlay().innerHTML) && lastOverlay().innerHTML.includes('%22onmouseover') && lastOverlay().innerHTML.includes('%3Cb%3E'),
     'and that encoded form is what the Pay now link carries');
  answer(409, { error: 'You already have an active subscription.', code: 'already_subscribed', manageBilling: true, payUrl: INV }); await run();
  ok(!/Pay now/.test(lastOverlay().innerHTML), 'a payUrl is only honoured on payment_issue');
  answer(409, { error: 'You already have an active subscription. Use "Manage plan & billing" to switch plans.', code: 'already_subscribed', manageBilling: true }); await run();
  ok(/openBillingPortal/.test(lastOverlay().innerHTML) && /already have an active subscription/.test(lastOverlay().innerHTML), '409 already_subscribed also points to billing');
  answer(200, { url: 'https://checkout.stripe.com/c/pay/cs_x' }); await run();
  ok(c.window.location.href === 'https://checkout.stripe.com/c/pay/cs_x' && appended.length === 0, 'opposite arm: a normal checkout still redirects to Stripe');

  // ── 5. r3 — the meme error handler: a timeout that mentions Gemini is not a missing key ───────
  {
    const els = new Map();
    const el = (id) => { if (!els.has(id)) els.set(id, { id, innerHTML: '', textContent: '', className: '', value: '', style: {} }); return els.get(id); };
    let keyFormOpened = 0, reply = null;
    const m = {
      console, JSON, Error, Number, String,
      window: { _memeHasKey: true },
      document: { getElementById: (id) => el(id) },
      btnWork: () => () => {}, stopThinking: () => {}, brandGate: () => () => true,
      lsGet: () => '[]', lsSet: () => {}, getBrandContext: () => ({}),
      connToken: async () => 'tok', currentBrand: { id: 'brand-1' },
      // the REAL memeApi runs; only fetch is fake, answering with `reply`
      fetch: async () => ({ ok: reply.status < 300, status: reply.status, json: async () => reply.data }),
      Image: function () {},
    };
    vm.createContext(m);
    const kc = (html.match(/^const MEME_KEY_CODES = .*$/m) || [''])[0];
    ok(!!kc, 'the key-problem codes are one named constant in app.html');
    vm.runInContext(kc.replace(/^const /, 'var '), m);
    for (const n of ['memeApi', 'memeShowKeyForm', 'memeErrIsKeyProblem', 'memeShowError', 'memeGenerate']) vm.runInContext(grab(n), m);
    const realForm = m.memeShowKeyForm;
    m.memeShowKeyForm = function () { keyFormOpened++; return realForm.apply(this, arguments); };
    const go = async (status, data) => {
      keyFormOpened = 0; els.clear(); reply = { ok: status < 300, status, data };
      await vm.runInContext('memeGenerate()', m);
      return { st: el('memeStatus'), form: keyFormOpened, row: el('memeKeyRow').innerHTML };
    };
    const TIMEOUT_GEMINI = 'Gemini took too long to draw this one — nothing was charged. Please try again in a moment.';
    let g = await go(503, { error: TIMEOUT_GEMINI, code: 'OUT_OF_TIME' });
    ok(g.form === 0 && !/memeKeyInput/.test(g.row), 'OUT_OF_TIME whose text says "Gemini" does NOT open the key form');
    ok(g.st.textContent === TIMEOUT_GEMINI, "and the server's own message is shown (" + J(g.st.textContent) + ')');
    g = await go(503, { error: 'The AI writer is paused on our side right now (our AI account hit a limit). Nothing is wrong with your account, and no credits were used. Please try again later.', code: 'AI_UNAVAILABLE' });
    ok(g.form === 0 && /paused on our side/.test(g.st.textContent), 'AI_UNAVAILABLE shows its message, no key form');
    g = await go(502, { error: 'The image service is busy or at its limit right now — nothing was charged. Wait a minute and try again.', code: 'IMAGE_BUSY' });
    ok(g.form === 0 && /busy/.test(g.st.textContent), 'any other non-key code shows its message, no key form');
    g = await go(503, { error: 'Could not reach your saved key just now — please try again in a moment.' });
    ok(g.form === 0 && /saved key just now/.test(g.st.textContent), 'a 503 "could not reach your saved key" (database blip, no code) is not a missing key');
    g = await go(200, { error: 'Gemini sent back no image for this one — nothing was charged.', code: 'IMAGE_EMPTY' });
    ok(g.form === 0 && /no image/.test(g.st.textContent), 'the code decides even without a 5xx: a coded answer mentioning Gemini is not a key problem');
    g = await go(500, {});
    ok(g.form === 0 && /Couldn.t make the meme/.test(g.st.textContent), 'no message at all -> the old generic line');
    // opposite arms: genuine key problems still open the form
    g = await go(400, { error: 'Add your Gemini API key first (in the Memes tab).' });
    ok(g.form === 1 && /memeKeyInput/.test(g.row) && /Add your free Google Gemini key/.test(g.st.innerHTML), 'a real "add your key" 400 (no code) opens the key form');
    g = await go(400, { error: 'Stored key is unreadable — re-save it.' });
    ok(g.form === 1, 'an unreadable stored key opens the key form');
    g = await go(502, { error: 'Image generation failed: API key not valid. Please pass a valid API key.', code: 'IMAGE_PROVIDER_ERROR' });
    ok(g.form === 1, 'Google rejecting the key (IMAGE_PROVIDER_ERROR) opens the key form');
    g = await go(502, { error: 'Image generation failed: the prompt was blocked by safety filters.', code: 'IMAGE_PROVIDER_ERROR' });
    ok(g.form === 0 && /safety filters/.test(g.st.textContent), 'a provider refusal that is NOT about the key shows Google\'s words, no key form');
    g = await go(400, { error: 'Enter your key', code: 'KEY_MISSING' });
    ok(g.form === 1, 'an explicit key code (KEY_MISSING) opens the key form');
    // r4 (N4) — Google's other real key rejections must open the form too
    g = await go(502, { error: 'Image generation failed: API key expired. Please renew the API key.', code: 'IMAGE_PROVIDER_ERROR' });
    ok(g.form === 1, 'IMAGE_PROVIDER_ERROR "API key expired" opens the key form');
    g = await go(502, { error: 'Image generation failed: Your API key was reported as leaked. Please use another API key.', code: 'IMAGE_PROVIDER_ERROR' });
    ok(g.form === 1, 'IMAGE_PROVIDER_ERROR "API key was reported as leaked" opens the key form');

    // r4 — the brand/product image (brandimage) uses the same rule and shows the server's words
    vm.runInContext(grab('prodGenerate'), m);
    m.startThinking = () => {}; m.prodBuildPrompt = (d) => d; m.productRefs = [];
    const prod = async (status, data) => {
      keyFormOpened = 0; els.clear(); el('prodDesc').value = 'a bottle on a desk'; reply = { ok: status < 300, status, data };
      await vm.runInContext('prodGenerate()', m);
      return { st: el('prodStatus'), form: keyFormOpened };
    };
    const SLOW = 'The image took too long to generate — nothing was charged. Please try again.';
    let pg = await prod(504, { error: SLOW, code: 'OUT_OF_TIME' });
    ok(pg.st.textContent === SLOW && pg.form === 0, "brandimage OUT_OF_TIME shows the server's message, no key form (" + J(pg.st.textContent) + ')');
    pg = await prod(503, { error: 'Gemini is busy — nothing was charged.', code: 'IMAGE_BUSY' });
    ok(pg.form === 0 && /Gemini is busy/.test(pg.st.textContent), 'a non-key code mentioning Gemini never opens the key form');
    pg = await prod(200, { error: 'Gemini sent back no image for this one — nothing was charged.', code: 'IMAGE_EMPTY' });
    ok(pg.form === 0 && /no image/.test(pg.st.textContent), 'the code decides even without a 5xx: a coded brandimage answer mentioning Gemini is not a key problem');
    pg = await prod(400, { error: 'Add your Gemini API key first.' });
    ok(pg.form === 1 && /Add your Gemini API key first/.test(pg.st.textContent), 'opposite arm: a real missing-key answer shows it and opens the key form');
    pg = await prod(500, {});
    ok(pg.form === 0 && /Couldn.t render the image/.test(pg.st.textContent), 'no message -> the old generic line');
  }

  // ── 6. r4 — the return from Stripe: checkout-confirm's refusals are shown as the server says them ──
  {
    const toasts2 = []; let reply2 = null, successShown = 0;
    const h = {
      console, URLSearchParams, JSON, String,
      location: { search: '?checkout=success&session_id=cs_gate', pathname: '/app.html' },
      history: { replaceState() {} },
      fetch: async () => ({ ok: reply2.status < 300, status: reply2.status, json: async () => reply2.data }),
      refreshUsage() {}, showToast: (msg) => toasts2.push(msg), showCheckoutSuccess() { successShown++; },
    };
    vm.createContext(h);
    vm.runInContext(grab('handleCheckoutReturn'), h);
    const back = async (status, data) => { toasts2.length = 0; successShown = 0; reply2 = { status, data }; await vm.runInContext('handleCheckoutReturn()', h); return toasts2.join(' | '); };
    const GENERIC = /couldn.t switch your plan over/i;
    let t = await back(409, { ok: false, doubleSubscription: true, error: 'You already had an active subscription, so this payment started a second one. Email support@contentshrimp.com and we will refund the duplicate.' });
    ok(/started a second one/.test(t) && /existing plan is still active/i.test(t) && !GENERIC.test(t),
       '409 doubleSubscription: the server\'s words, plus "your existing plan is still active" — not "we couldn\'t switch your plan" (' + J(t) + ')');
    t = await back(403, { error: 'That subscription is no longer active. Start a new plan from Settings.' });
    ok(t === 'That subscription is no longer active. Start a new plan from Settings.', '403 (subscription ended) shows exactly the server\'s message');
    t = await back(503, { error: 'Could not confirm your subscription just now — reload in a minute.' });
    ok(/reload in a minute/.test(t) && !GENERIC.test(t) && !/still active/.test(t), '503 (could not verify) shows "reload in a minute", nothing about losing the plan');
    t = await back(500, {});
    ok(GENERIC.test(t), 'opposite arm: no error text -> the old generic line');
    t = await back(200, { ok: true, plan: 'pro' });
    ok(successShown === 1 && t === '', 'a successful confirm still shows the success card, no toast');
  }

  if (fail) { console.log('\n' + fail + ' check(s) failed'); process.exit(1); }
  console.log('\nDUNNING UI OK');
  process.exit(0);
})().catch(e => { console.log('FAIL: gate crashed: ' + (e && e.stack || e)); process.exit(1); });
