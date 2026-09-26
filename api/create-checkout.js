// Creates a Stripe Checkout Session for a subscription plan and returns its URL.
// Requires env: STRIPE_SECRET_KEY, and a price id per plan:
//   STRIPE_PRICE_STARTER, STRIPE_PRICE_PRO, STRIPE_PRICE_AGENCY
// Uses Stripe's REST API directly (no SDK dependency).
const https = require('https');
const querystring = require('querystring');

const PRICE_ENV = {
  starter: 'STRIPE_PRICE_STARTER',
  pro:     'STRIPE_PRICE_PRO',
  agency:  'STRIPE_PRICE_AGENCY'
};

function stripePost(path, formObj, secret, extraHeaders) {
  return new Promise((resolve, reject) => {
    const body = querystring.stringify(formObj);
    const r = https.request({
      hostname: 'api.stripe.com', path, method: 'POST',
      // v692 round 3 — extraHeaders carries the Idempotency-Key for the customer create.
      headers: Object.assign({
        'Authorization': 'Bearer ' + secret,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }, extraHeaders || {})
    }, resp => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => {
        let j = null; try { j = JSON.parse(d); } catch (_) {}
        if (resp.statusCode >= 400) {
          // v692 — carry Stripe's status, error code and param out. The message alone could not
          // tell "the stored customer no longer exists" (retry with the email) from any other error.
          const err = new Error((j && j.error && j.error.message) || ('Stripe ' + resp.statusCode));
          err.status = resp.statusCode;
          err.code = (j && j.error && j.error.code) || null;
          err.param = (j && j.error && j.error.param) || null;
          return reject(err);
        }
        resolve(j);
      });
    });
    // v640: no socket timeout meant a Stripe stall NEVER settled this promise, and the
    // function was killed by the platform at maxDuration with no body and no log line —
    // on the money path. checkout-confirm is the worst of the three: it runs AFTER the card
    // is charged and is the only caller of setPlan, so a hang left the customer paid and on
    // the free plan with nothing recorded. stripe-webhook.js has had this since it was
    // written; these three never got it.
    r.setTimeout(15000, () => {
      console.error('create-checkout: Stripe request timed out after 15000ms — %s', path);
      r.destroy(new Error('Stripe timed out — your card was not charged twice; try again.'));
    });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}

// v692 — read an existing subscription before selling a new one (see the dunning check below).
// Same shape as stripe-webhook.js's stripeGet: the HTTP status travels on the error, and a stall
// is cut off at 15 s instead of hanging to the platform limit.
function stripeGet(path, secret, extraHeaders) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'api.stripe.com', path, method: 'GET',
      // v692 round 4 — extraHeaders: only the search call pins a Stripe-Version.
      headers: Object.assign({ 'Authorization': 'Bearer ' + secret }, extraHeaders || {})
    }, resp => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => {
        let j = null; try { j = JSON.parse(d); } catch (_) {}
        if (resp.statusCode >= 400) {
          const err = new Error((j && j.error && j.error.message) || ('Stripe ' + resp.statusCode));
          err.status = resp.statusCode;
          err.type = (j && j.error && j.error.type) || null;   // v692 round 4 — see searchUnavailable()
          return reject(err);
        }
        resolve(j);
      });
    });
    r.setTimeout(15000, () => {
      console.error('create-checkout: Stripe request timed out after 15000ms — %s', path);
      r.destroy(new Error('Stripe timed out'));
    });
    r.on('error', reject);
    r.end();
  });
}

/* v692 round 2 — a short, body-less Stripe call for the best-effort housekeeping below (listing and
   expiring open checkout sessions). Its own 5 s cap: that step must never hold up a purchase. */
function stripeCall(method, path, secret, timeoutMs) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'api.stripe.com', path, method,
      headers: { 'Authorization': 'Bearer ' + secret, 'Content-Length': 0 }
    }, resp => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => {
        let j = null; try { j = JSON.parse(d); } catch (_) {}
        if (resp.statusCode >= 400) {
          const err = new Error((j && j.error && j.error.message) || ('Stripe ' + resp.statusCode));
          err.status = resp.statusCode;
          return reject(err);
        }
        resolve(j);
      });
    });
    r.setTimeout(timeoutMs, () => { r.destroy(new Error('Stripe timed out after ' + timeoutMs + 'ms')); });
    r.on('error', reject);
    r.end();
  });
}

/* v692 round 2 — TWO TABS, TWO SUBSCRIPTIONS. Every click made a fresh checkout session and every
   earlier one stayed payable, so two open tabs could be paid one after the other: two live
   subscriptions, charged twice. Before a returning customer gets a new session, their other OPEN
   checkout sessions are expired, so only the newest can be paid. Best effort: a failure to list or
   expire is logged and never blocks the purchase (the webhook's DOUBLE SUBSCRIPTION guard is the
   backstop). A first purchase has no stored customer yet, so it is not covered here. */
async function expireOpenSessions(customerId, userId, secret) {
  let list;
  try {
    list = await stripeCall('GET', '/v1/checkout/sessions?customer=' + encodeURIComponent(customerId) + '&status=open&limit=10', secret, 5000);
  } catch (e) {
    console.error('create-checkout: could not list open checkout sessions for customer=' + customerId + ' user=' + userId +
      ' — ' + ((e && e.message) || e) + ' — continuing; an older open session may still be payable.');
    return;
  }
  const open = (list && Array.isArray(list.data) ? list.data : [])
    .filter((x) => x && typeof x.id === 'string' && x.status === 'open' && x.mode === 'subscription');
  const results = await Promise.allSettled(open.map((x) =>
    stripeCall('POST', '/v1/checkout/sessions/' + encodeURIComponent(x.id) + '/expire', secret, 5000)));
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error('create-checkout: could not expire open checkout session ' + open[i].id + ' for customer=' + customerId +
        ' user=' + userId + ' — ' + ((r.reason && r.reason.message) || r.reason) + ' — continuing.');
    } else {
      console.log('create-checkout: expired older open checkout session ' + open[i].id + ' for customer=' + customerId + ' user=' + userId);
    }
  });
}

// v692 — a subscription is over only when Stripe can never charge it again. Same list as
// stripe-webhook.js (ENDED_STATUSES); 'absent' is a 404 — Stripe no longer has it.
const ENDED_STATUSES = { canceled: 1, incomplete_expired: 1, absent: 1 };

// v692 — "the stored Stripe customer is gone" (deleted in the dashboard, or a test-mode id against
// a live key). Only this error earns the one retry with the email; any other error is real.
function isMissingCustomer(e) {
  const msg = String((e && e.message) || '');
  return (e && e.code === 'resource_missing' && e.param === 'customer') || /no such customer/i.test(msg);
}

const SUB_CHECK_FAILED = { error: 'Could not check your current subscription just now — please try again in a minute.', code: 'subscription_check_failed' };

/* v692 round 3 — THE REFUSAL FOR A SUBSCRIPTION THAT IS STILL ALIVE. One place decides the answer for
   any live subscription of this user (the one on the row, or another one Stripe Search finds):
   active/trialing → 409 already_subscribed; failing → 409 payment_issue, with `payUrl` when there is
   an OPEN invoice to pay. The invoice is looked up by subscription + status=open, not via
   latest_invoice: an `unpaid` subscription keeps generating invoices that stay in DRAFT, so after one
   period latest_invoice was a draft and the link to pay the invoice that matters disappeared.
   Returns { code, body }. A failed invoice read is a 503 (we cannot say what they owe). */
async function refusalFor(sub, userId, secret) {
  const st = sub.status;
  if (st === 'active' || st === 'trialing') {
    return { code: 409, body: {
      error: 'You already have an active subscription. Use "Manage plan & billing" to switch plans.',
      code: 'already_subscribed',
      manageBilling: true,
      message: 'You already have an active subscription. Use "Manage plan & billing" to switch plans — starting a new checkout would charge you twice.'
    } };
  }
  /* v692 round 2 — AN UNPAID SUBSCRIPTION IS NOT FIXED BY A NEW CARD. Once Stripe stops retrying
     (unpaid, or past_due after the last retry — a Stripe dashboard setting), the subscription becomes
     active again only when its invoice is PAID; updating the card does not pay it. So the open
     invoice's Stripe-hosted payment page goes back as `payUrl` (never as `url`: app.html redirects
     on `url`, and this is a refusal). */
  let payUrl = null;
  if (st === 'past_due' || st === 'unpaid') {
    let list;
    try {
      list = await stripeGet('/v1/invoices?subscription=' + encodeURIComponent(sub.id) + '&status=open&limit=1', secret);
    } catch (e) {
      console.error('create-checkout: could not list open invoices of ' + sub.id + ' for user=' + userId + ' — ' + ((e && e.message) || e) + ' — refusing checkout.');
      return { code: 503, body: SUB_CHECK_FAILED };
    }
    if (!list || !Array.isArray(list.data)) {
      console.error('create-checkout: the open-invoice list of ' + sub.id + ' for user=' + userId + ' is not a list — refusing checkout.');
      return { code: 503, body: SUB_CHECK_FAILED };
    }
    const inv = list.data[0];
    if (inv && inv.status === 'open' && typeof inv.hosted_invoice_url === 'string' && /^https:\/\//.test(inv.hosted_invoice_url)) {
      payUrl = inv.hosted_invoice_url;
    }
  }
  // 409, not 402 — see the refusal in the handler. `error` is what app.html shows in the toast.
  return { code: 409, body: Object.assign({
    error: payUrl
      ? 'Your last payment did not go through, so your plan is paused. Pay your open invoice to get your plan back — a new checkout would charge you twice.'
      : 'Your last payment did not go through, so your plan is paused. Update your card in "Manage plan & billing" to get it back — a new checkout would charge you twice.',
    code: 'payment_issue',
    manageBilling: true,
    status: st
  }, payUrl ? { payUrl } : {}) };
}

/* v692 round 4 — STRIPE SEARCH MAY NOT EXIST FOR THIS ACCOUNT. Search is not offered everywhere
   (not to businesses in India) and needs API version 2020-08-27 or later. If Stripe says so, the
   extra "another live subscription?" protection is skipped — logged as STRIPE SEARCH UNAVAILABLE —
   instead of answering 503 forever and taking every checkout / downgrade down with it. Narrow on
   purpose: only a 400/403/404 invalid_request_error whose message is about search or the API
   version. A 429, a 5xx, a network error, a timeout or a garbled answer stays a 503. */
const SEARCH_VERSION = { 'Stripe-Version': '2024-06-20' };
function searchUnavailable(e) {
  const st = Number(e && e.status) || 0;
  if (st !== 400 && st !== 403 && st !== 404) return false;
  if (!e || e.type !== 'invalid_request_error') return false;
  const m = String(e.message || '').toLowerCase();
  return (m.includes('search') || m.includes('api version'))
    && /(not available|unavailable|not supported|unsupported|not enabled|isn't available|version)/.test(m);
}

/* v692 round 3 — A LIVE SUBSCRIPTION THE ROW DOES NOT HOLD. Two checkout tabs could leave a user with
   a second subscription (possibly on a second Stripe customer) that the row does not track; the
   plan test and the row's own subscription then both said "free to buy", and a THIRD could be sold.
   Stripe Search by the user_id we stamp on every subscription finds it wherever it lives. The search
   index lags (not read-after-write), so every hit is re-read by id before it refuses anything.
   Returns { sub } | { none: true } | { unknown: true, why }. */
async function otherLiveSubscription(userId, exceptId, secret) {
  const query = "metadata['user_id']:'" + String(userId).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  let found;
  try {
    found = await stripeGet('/v1/subscriptions/search?query=' + encodeURIComponent(query) + '&limit=100', secret, SEARCH_VERSION);
  } catch (e) {
    if (searchUnavailable(e)) {
      console.error('create-checkout: STRIPE SEARCH UNAVAILABLE — ' + ((e && e.message) || e) + ' (Stripe ' + e.status + ', user=' + userId +
        ') — continuing on the row\'s own checks, WITHOUT the check for another live subscription.');
      return { none: true, unavailable: true };
    }
    return { unknown: true, why: 'subscription search failed — ' + ((e && e.message) || e) };
  }
  if (!found || !Array.isArray(found.data)) return { unknown: true, why: 'subscription search answered with something that is not a list' };
  const cands = found.data
    .filter((x) => x && typeof x.id === 'string' && x.id !== exceptId && typeof x.status === 'string' && !ENDED_STATUSES[x.status]
      && x.metadata && x.metadata.user_id === userId)
    .sort((a, b) => ((a.status === 'active' || a.status === 'trialing') ? 0 : 1) - ((b.status === 'active' || b.status === 'trialing') ? 0 : 1))
    .slice(0, 5);
  for (const c of cands) {
    let live;
    try { live = await stripeGet('/v1/subscriptions/' + encodeURIComponent(c.id), secret); }
    catch (e) {
      if (Number(e && e.status) === 404) continue;
      return { unknown: true, why: 'could not re-read ' + c.id + ' — ' + ((e && e.message) || e) };
    }
    if (!live || typeof live.status !== 'string') return { unknown: true, why: 're-read of ' + c.id + ' is not a subscription' };
    if (!ENDED_STATUSES[live.status]) return { sub: live };
  }
  return { none: true };
}

/* v692 round 3 — ONE CUSTOMER FROM THE FIRST PURCHASE ON. With no stored customer, every checkout
   sent only the email and Stripe made a new customer per session — so two tabs of a FIRST purchase
   were two customers, nothing could expire the other tab, and both could be paid. Now the customer is
   created first and stored on the row, and the session is created for it.
   Racing tabs: the Idempotency-Key (derived from the user id) makes Stripe return the SAME customer to
   both for 24 hours, and the row write only lands when the row has no customer yet — the row is then
   re-read and whichever id it holds wins, so the row and the session never disagree (even past the
   24-hour key window, or when the webhook stored a customer first). Returns the id, or null when the
   customer could not be created (the caller falls back to the email, today's behaviour). */
async function ensureCustomer(user, usage, secret) {
  let created;
  try {
    created = await stripePost('/v1/customers', Object.assign({ 'metadata[user_id]': user.id }, user.email ? { email: user.email } : {}),
      secret, { 'Idempotency-Key': 'contentshrimp-v692-customer-' + user.id });
  } catch (e) {
    console.error('create-checkout: could not create a Stripe customer for user=' + user.id + ' — ' + ((e && e.message) || e) +
      ' — continuing with the email (Stripe makes the customer at checkout).');
    return null;
  }
  if (!created || typeof created.id !== 'string' || !created.id) {
    console.error('create-checkout: Stripe answered the customer create for user=' + user.id + ' without an id — continuing with the email.');
    return null;
  }
  const stored = await usage.setStripeCustomerIfEmpty(user.id, created.id);
  if (!stored) {
    console.error('create-checkout: could not store Stripe customer ' + created.id + ' for user=' + user.id +
      ' — continuing with it; the purchase grant will store it.');
    return created.id;
  }
  const again = await usage.getPlanSnapshot(user.id, { strict: true });
  const winner = (again && !again.unknown && !again.missing && again.stripeCustomerId) || created.id;
  if (winner !== created.id) {
    console.error('create-checkout: user=' + user.id + ' already had Stripe customer ' + winner + ' (stored first by another request) — using it, not ' + created.id + '.');
  }
  return winner;
}

module.exports = async function handler(req, res) {
  const allowed = ['https://contentshrimp.com','https://bettercontent.app','https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await require('./_requireUser')(req);
  if (!user) return res.status(401).json({ error: 'Please sign in again.' });

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) return res.status(503).json({ error: 'Billing is not configured yet.' });

  try {
    const plan = String((req.body && req.body.plan) || 'pro').toLowerCase();
    const priceEnv = PRICE_ENV[plan];
    const priceId = priceEnv && process.env[priceEnv];
    if (!priceId) return res.status(400).json({ error: 'Unknown or unconfigured plan.' });

    // ── DOUBLE-SUBSCRIPTION REFUSAL ───────────────────────────────────────────
    // This endpoint always creates a NEW `mode:'subscription'` session (v692: for the stored
    // Stripe customer when there is one — still a NEW subscription), so a caller who is already
    // paying ends up with a SECOND live subscription and is billed twice. app.html routes paid
    // users to the billing portal instead — but that guard is client-side only, and this endpoint
    // was reachable without it.
    //
    // Positive knowledge only: getPlanSnapshot returns null on ANY read failure, and a null
    // must never block a genuine first purchase (Supabase being down would otherwise stop all
    // sales). Logged when it happens so the gap is visible rather than assumed.
    // v692 round 3 — strict read: "no row yet" (a first purchase: make the customer) is not
    // "could not read" (documented: proceed without the row checks, and with the email).
    const usage = require('./_usage');
    const snapS = await usage.getPlanSnapshot(user.id, { strict: true });
    const rowUnknown = !snapS || !!snapS.unknown;
    const snap = (!rowUnknown && !snapS.missing) ? snapS : null;
    if (rowUnknown) {
      console.error('create-checkout: could not read the plan for user=' + user.id +
        ' — proceeding WITHOUT the double-subscription check.');
    } else if (snap && usage.PAID_PLANS[snap.effectivePlan]) {
      // v657: the `|| snap.stripeSubscriptionId` disjunct was removed. The cancel path never
      // cleared that column, so it stayed set forever and this refusal fired for every churned
      // customer trying to come back — while the body said plan:"free" and "you already have an
      // active subscription" in the same breath. The plan itself is the honest test: if they are
      // on a paid plan they have a live subscription, and if they are not, they may buy one.
      // (stripe-webhook.js now nulls the column on cancellation as well, belt and braces.)
      // 409, not 402: a 402 makes app.html's global fetch wrapper open the upgrade modal, which
      // is exactly the loop this refusal exists to break. `manageBilling` tells the frontend to
      // send them to /api/create-portal-session, where switching plans is a proration, not a
      // second charge.
      return res.status(409).json({
        // app.html:16804 renders `d.error` VERBATIM in a toast, so this string is what the
        // user actually reads. It used to be the literal token "already_subscribed".
        error: 'You already have an active subscription. Use "Manage plan & billing" to switch plans.',
        code: 'already_subscribed',
        manageBilling: true,
        plan: snap.effectivePlan,
        message: 'You already have an active subscription. Use "Manage plan & billing" to switch plans — starting a new checkout would charge you twice.'
      });
    }

    /* v692 — DUNNING DOUBLE-BILLING. When a card fails, the webhook drops the plan to free but the
       subscription is still alive in Stripe, retrying the card for days. The plan test above then
       says "not paying" and a new checkout sold them a SECOND subscription — charged twice once the
       first card recovered. The webhook now keeps stripe_subscription_id until that subscription
       has truly ended, and this asks Stripe what it is now. Fail CLOSED: if we cannot read it we
       do not know whether a new checkout double-bills, so no checkout (503, try again). */
    if (snap && snap.stripeSubscriptionId) {
      let existing = null;
      try {
        existing = await stripeGet('/v1/subscriptions/' + encodeURIComponent(snap.stripeSubscriptionId), secret);
      } catch (e) {
        if (Number(e && e.status) === 404) existing = { status: 'absent' };
        else {
          console.error('create-checkout: could not read existing subscription ' + snap.stripeSubscriptionId + ' for user=' + user.id +
            ' — ' + ((e && e.message) || e) + ' — refusing checkout rather than risk a second subscription.');
          return res.status(503).json(SUB_CHECK_FAILED);
        }
      }
      const st = existing && typeof existing.status === 'string' ? existing.status : '';
      if (!st) {
        console.error('create-checkout: Stripe answered the read of subscription ' + snap.stripeSubscriptionId + ' for user=' + user.id +
          ' with something that is not a subscription — refusing checkout.');
        return res.status(503).json(SUB_CHECK_FAILED);
      }
      if (!ENDED_STATUSES[st]) {
        const r = await refusalFor(existing, user.id, secret);
        return res.status(r.code).json(r.body);
      }
    }

    // v692 round 3 — and no live subscription ANYWHERE for this user (see otherLiveSubscription).
    // Fail closed like the read above: a search we could not make is not "none".
    const other = await otherLiveSubscription(user.id, snap && snap.stripeSubscriptionId, secret);
    if (other.unknown) {
      console.error('create-checkout: could not check for another live subscription of user=' + user.id + ' — ' + other.why + ' — refusing checkout.');
      return res.status(503).json(SUB_CHECK_FAILED);
    }
    if (other.sub) {
      console.error('create-checkout: user=' + user.id + ' still has live subscription ' + other.sub.id + ' (' + other.sub.status +
        ', customer=' + (other.sub.customer || 'none') + ') that their row does not hold — refusing a new checkout.');
      const r = await refusalFor(other.sub, user.id, secret);
      return res.status(r.code).json(r.body);
    }

    // Where to send the user back to.
    const base = (origin && allowed.includes(origin)) ? origin : allowed[0];

    const form = {
      'mode': 'subscription',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'client_reference_id': user.id,
      'metadata[user_id]': user.id,
      'metadata[plan]': plan,
      'subscription_data[metadata][user_id]': user.id,
      'subscription_data[metadata][plan]': plan,
      'success_url': base + '/app.html?checkout=success&session_id={CHECKOUT_SESSION_ID}',
      'cancel_url': base + '/app.html?checkout=cancel',
      'allow_promotion_codes': 'true'
    };
    const withEmail = () => Object.assign({}, form, user.email ? { 'customer_email': user.email } : {});

    /* v692 — ONE STRIPE CUSTOMER PER USER. Every checkout sent only customer_email, so Stripe made a
       NEW customer each time: a returning customer's card, invoices and history were split across
       duplicates, and the Billing Portal only ever saw the latest one. When the row already holds a
       customer, the session is created FOR that customer (Checkout refuses customer together with
       customer_email). If Stripe no longer has that customer, one retry with the email; the grant
       then stores the new customer id. */
    // v692 round 3 — a first purchase gets its customer first (see ensureCustomer); an unreadable
    // row keeps today's behaviour (email only) rather than risk a second customer.
    const storedCustomer = (snap && snap.stripeCustomerId) || (!rowUnknown ? await ensureCustomer(user, usage, secret) : null);
    let session;
    if (storedCustomer) {
      await expireOpenSessions(storedCustomer, user.id, secret);
      try {
        session = await stripePost('/v1/checkout/sessions', Object.assign({}, form, { 'customer': storedCustomer }), secret);
      } catch (e) {
        if (!isMissingCustomer(e)) throw e;
        console.error('create-checkout: stored Stripe customer ' + storedCustomer + ' for user=' + user.id +
          ' no longer exists in Stripe (' + e.message + ') — retrying once with the email; a new customer will be created.');
        session = await stripePost('/v1/checkout/sessions', withEmail(), secret);
      }
    } else {
      session = await stripePost('/v1/checkout/sessions', withEmail(), secret);
    }

    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('create-checkout error:', e);
    return res.status(500).json({ error: 'Could not start checkout — please try again.' });
  }
};
