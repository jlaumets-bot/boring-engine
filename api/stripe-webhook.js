// Stripe subscription lifecycle webhook.
//
// It GRANTS a first purchase (checkout.session.completed / customer.subscription.created),
// keeps the plan in sync with the active price on updates, and downgrades a user to the free
// plan when their subscription is cancelled, lapses, or fails payment.
//
// WHY THE GRANT PATH EXISTS AT ALL: until now the ONLY thing that granted a first purchase was
// the browser redirect (app.html → /api/checkout-confirm). Close the tab on the way back and the
// customer was charged, on `free`, with nothing anywhere able to retry it. This webhook could not
// have rescued it either, because it resolved the user with userIdByStripe() — which filters on
// stripe_subscription_id / stripe_customer_id, columns that ONLY checkout-confirm writes. Before a
// successful confirm no row carries them, so the lookup returned null and the handler answered
// 200 having done nothing. The rescue data was already there and unread: create-checkout puts
// `subscription_data[metadata][user_id]` on every subscription, so the metadata resolves the user
// when the database cannot. Every grant now also persists the stripe ids, so the SECOND event for
// that customer resolves normally through the fast path.
//
// SECURITY: we do NOT trust the POST body. We take only the event id from it and
// RE-FETCH the event from Stripe by id (with our secret key). A forged/garbage id
// simply isn't found and is ignored; a real id returns the real event. This gives
// us authenticity without the fragile raw-body signature dance on Vercel. The metadata we
// fall back to therefore comes from Stripe's own copy of the object, not from the request.
//
// Stripe dashboard → Developers → Webhooks → add endpoint /api/stripe-webhook and
// subscribe to: checkout.session.completed, customer.subscription.created,
// customer.subscription.updated, customer.subscription.deleted, invoice.payment_failed.
// (No STRIPE_WEBHOOK_SECRET needed with this approach.)
const https = require('https');
const usage = require('./_usage');

const VALID_PLANS = { starter: 1, pro: 1, agency: 1 };

// Map a Stripe price id onto a plan key. Returns null when the id matches no configured env var.
function planForPrice(priceId) {
  if (!priceId) return null;
  if (process.env.STRIPE_PRICE_AGENCY && priceId === process.env.STRIPE_PRICE_AGENCY) return 'agency';
  if (process.env.STRIPE_PRICE_PRO && priceId === process.env.STRIPE_PRICE_PRO) return 'pro';
  if (process.env.STRIPE_PRICE_STARTER && priceId === process.env.STRIPE_PRICE_STARTER) return 'starter';
  return null;
}
function validPlan(p) {
  return (typeof p === 'string' && VALID_PLANS[p.toLowerCase()]) ? p.toLowerCase() : null;
}
function sameInstant(a, b) {
  if (!a || !b) return false;
  const x = Date.parse(a), y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
}

// Find the user this event belongs to. The database lookup is tried on BOTH keys before we
// fall back to the object's metadata — which is the only thing that works for a first purchase.
/* v691 — `lookupFailed` is now distinct from `unresolved`. userIdByStripe answers {unknown:true}
   when it could not read at all, and a database we could not reach is not a customer we do not
   have. The metadata fallback still runs (a checkout carries user_id, so most first purchases
   survive a blip), but if nothing resolves AND a lookup failed, the caller answers 5xx so Stripe
   redelivers instead of 200, which would have discarded a paid event for good. */
async function resolveUserId({ subscriptionId, customerId, metaUserId }) {
  let lookupFailed = false;
  const tryLookup = async (arg) => {
    const r = await usage.userIdByStripe(arg);
    if (r && typeof r === 'object' && r.unknown) { lookupFailed = true; return null; }
    return r || null;
  };
  let id = subscriptionId ? await tryLookup({ subscriptionId }) : null;
  if (id) return { userId: id, via: 'subscription_id', lookupFailed };
  id = customerId ? await tryLookup({ customerId }) : null;
  if (id) return { userId: id, via: 'customer_id', lookupFailed };
  if (metaUserId && typeof metaUserId === 'string' && metaUserId.trim()) {
    return { userId: metaUserId.trim(), via: 'metadata', lookupFailed };
  }
  return { userId: null, via: lookupFailed ? 'lookup_failed' : 'unresolved', lookupFailed };
}

// Write the plan ONLY if the row does not already say exactly this. Stripe redelivers, and the
// redirect confirm can land on the same state a second earlier — neither may double-apply, and a
// replayed `updated` must not undo a row that already matches. `applied:false` means "already
// correct", which is a success, not a no-op failure.
async function applyPlan(userId, plan, extra, snapIn) {
  // v691 — the downgrade path reads the row strictly first (it must know "no row" from "could
  // not read"), and hands that snapshot in here instead of paying for a second read.
  const snap = snapIn !== undefined ? snapIn : await usage.getPlanSnapshot(userId);
  if (snap && snap.plan === plan
      && (!extra.stripe_subscription_id || snap.stripeSubscriptionId === extra.stripe_subscription_id)
      && (!extra.stripe_customer_id || snap.stripeCustomerId === extra.stripe_customer_id)
      && (!extra.current_period_end || sameInstant(snap.currentPeriodEnd, extra.current_period_end))) {
    return { ok: true, applied: false };
  }
  const ok = await usage.setPlan(userId, plan, extra);
  return { ok, applied: ok };
}

function stripeGet(path, secret) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'api.stripe.com', path, method: 'GET',
      headers: { 'Authorization': 'Bearer ' + secret },
      timeout: 15000
    }, resp => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => {
        let j = null; try { j = JSON.parse(d); } catch (_) {}
        if (resp.statusCode >= 400) {
          // v691: carry the status out. Without it every failure looked identical to the caller,
          // so "this event does not exist" and "Stripe was unreachable" got the same answer.
          const err = new Error((j && j.error && j.error.message) || ('Stripe ' + resp.statusCode));
          err.status = resp.statusCode;
          return reject(err);
        }
        resolve(j);
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(new Error('Stripe timeout')); });
    r.end();
  });
}

/* v691 — AN EVENT IS A PHOTOGRAPH, NOT THE PRESENT. Every event carries the subscription as it
   was when the event was CREATED, and Stripe does not deliver events in order. Since v691 every
   unknown failure answers 503, so Stripe redelivers events hours or days late — and a late
   `updated` (status active) that lands after the `deleted` re-granted a cancelled customer paid
   access; a late `checkout.session.completed` did the same and wrote the dead subscription id
   back onto the row (which then made create-checkout refuse them a new subscription). The plan
   is therefore decided from the subscription as Stripe holds it NOW.
   Returns { sub } | { absent: true } (Stripe answered 404: no such subscription, so nobody is
   paying through it) | { unknown: true, why } (could not read — the caller answers 503). */
async function liveSubscription(subId, secret) {
  try {
    const s = await stripeGet('/v1/subscriptions/' + encodeURIComponent(subId), secret);
    if (!s || typeof s !== 'object' || typeof s.status !== 'string' || !s.status) {
      return { unknown: true, why: 'Stripe answered with a body that is not a subscription' };
    }
    return { sub: s };
  } catch (e) {
    const st = Number(e && e.status) || 0;
    if (st === 404) return { absent: true };
    return { unknown: true, why: (st ? ('Stripe ' + st) : 'transport/timeout') + ': ' + ((e && e.message) || e) };
  }
}

/* v691 — A GRANT MUST NOT OUTLIVE A CANCELLATION IT RACED. Two deliveries can run at once: the
   grant reads the subscription "active", the `deleted` for it reads "canceled" and writes free,
   and then the grant's write lands — pro, with the dead subscription id, and no later event
   exists to repair it (create-checkout then refuses them a new subscription). So after a grant
   that actually WROTE, the subscription is read once more. Still active: done. Ended: the row is
   put back to free — but only while it still holds THIS subscription (a newer one is not ours to
   touch). A read we cannot make answers { retry: true } and the caller returns 503; the
   redelivery then decides from the current state.
   Returns { ok: true, undone?: true } | { retry: true, why }. */
async function confirmGrant(userId, subId, secret) {
  if (!subId) return { ok: true };
  const live = await liveSubscription(subId, secret);
  if (live.unknown) return { retry: true, why: 'subscription re-read failed — ' + live.why };
  const st = live.absent ? 'absent' : live.sub.status;
  if (st === 'active' || st === 'trialing') return { ok: true };
  return undoEndedGrant(userId, subId, st);
}

/* The undo itself, shared by confirmGrant and by the checkout path's "subscription not live"
   branch (v691 round 3: a 503 grant_unconfirmed must be healable by the redelivery — see there).
   Resets the row to free and clears the id ONLY while the row still holds THIS subscription. */
async function undoEndedGrant(userId, subId, st) {
  const snap = await usage.getPlanSnapshot(userId, { strict: true });
  if (!snap || snap.unknown) return { retry: true, why: 'plan row re-read failed' };
  if (snap.missing || snap.stripeSubscriptionId !== subId) return { ok: true };
  const r = await applyPlan(userId, 'free', { stripe_subscription_id: null }, snap);
  if (!r.ok) return { retry: true, why: 'the undo write failed' };
  console.error('stripe-webhook: GRANT RACED A CANCELLATION — user=' + userId + ' sub=' + subId + ' is now "' + st +
    '"; the grant was undone (plan free, subscription id cleared).');
  return { ok: true, undone: true };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const secret = process.env.STRIPE_SECRET_KEY;
  /* v691 — A MISSING KEY ACKNOWLEDGED EVERY PAYMENT EVENT AND LOGGED NOTHING. Stripe only sends
     this endpoint events once billing is live, so arriving here without STRIPE_SECRET_KEY means
     production lost its key (a renamed variable, a botched rotation). Answering 200 told Stripe
     that every purchase and cancellation in that window was delivered — each one was thrown away
     for good. 503 makes Stripe hold and redeliver them, and they apply once the key is back. */
  if (!secret) {
    console.error('stripe-webhook: STRIPE_SECRET_KEY IS NOT SET — no event can be verified or applied. ' +
      'Returning 503 so Stripe redelivers once the key is restored.');
    return res.status(503).json({ ok: false, error: 'billing_not_configured' });
  }

  try {
    const evtId = req.body && req.body.id;
    if (!evtId || typeof evtId !== 'string' || !evtId.startsWith('evt_')) {
      return res.status(200).json({ ok: true, ignored: 'no event id' });
    }

    // Re-fetch the real event from Stripe (authenticity check).
    let evt = null;
    try { evt = await stripeGet('/v1/events/' + encodeURIComponent(evtId), secret); }
    catch (e) {
      /* v691 — A PAYMENT COULD BE DROPPED BY A NETWORK BLIP. Every failure of this re-fetch
         answered 200 "event not found", with NO LOG AT ALL. 200 tells Stripe the webhook was
         delivered, so it never retries — and this re-fetch is the FIRST thing the handler does,
         before any plan is granted. A timeout, a socket error, a 429 or a Stripe 5xx therefore
         meant: the customer paid, the plan was never granted, and nothing anywhere recorded it.
         Only a DEFINITE answer may be acknowledged. A 404 or 400 means the event genuinely is
         not there (a bogus id, or a test-mode id against a live key) and retrying cannot help.
         Anything else is unknown, and Stripe redelivers for 3 days. (v691: the replay window
         below was 72h — the SAME length, not "comfortably inside" it. It is now 7 days, and a
         drop past it is logged.) */
      const st = Number(e && e.status) || 0;
      /* v691 — A 404 IS ALSO WHAT A WRONG-MODE KEY GETS. Stripe answers 404 for a LIVE event read
         with a TEST key, so a production key swapped to test (to debug, say) turned every live
         purchase and cancellation into "genuinely absent" and acknowledged it — lost for good,
         though fixing the key would have healed every one on redelivery. The delivery says which
         mode it is from (`livemode`) and the key's prefix says which mode it reads, so that one
         case is now a 503. A TEST event reaching a LIVE key stays acknowledged: it is test noise,
         there is nothing to apply. `livemode` comes from the request body, so a forger can only
         choose to receive a 503 instead of a 200 — nothing is applied either way. */
      const keyLive = /^(sk|rk)_live_/.test(secret) ? true : (/^(sk|rk)_test_/.test(secret) ? false : null);
      const evtLive = (req.body && typeof req.body.livemode === 'boolean') ? req.body.livemode : null;
      const liveEventTestKey = evtLive === true && keyLive === false;
      const definite = (st === 404 || st === 400) && !liveEventTestKey;
      console.error('stripe-webhook: could not re-fetch event ' + evtId + ' — ' +
        (st ? ('Stripe ' + st) : 'transport/timeout') + ': ' + ((e && e.message) || e) +
        (liveEventTestKey ? ' — a LIVE event but STRIPE_SECRET_KEY is a TEST key: CONFIG ERROR, returning 503 so it applies once the key is fixed'
          : definite ? ' — treating as genuinely absent' : ' — returning 503 so Stripe retries'));
      if (definite) return res.status(200).json({ ok: true, ignored: 'event not found' });
      return res.status(503).json({ ok: false, error: 'event_refetch_failed' });
    }
    /* v691 — A FAILED READ IS NOT AN ANSWER. A 2xx whose body did not parse (a truncated or
       proxied response) came back as null and was acknowledged as "no event" — a real purchase
       dropped by a garbled read. Every event Stripe holds has a type; anything else is a read we
       could not make sense of, and a redelivery reads it again. */
    if (!evt || typeof evt !== 'object' || typeof evt.type !== 'string' || !evt.type) {
      console.error('stripe-webhook: Stripe answered the re-fetch of ' + evtId + ' with a body that is not an event' +
        ' — returning 503 so Stripe retries.');
      return res.status(503).json({ ok: false, error: 'event_unreadable' });
    }

    // REPLAY GUARD. The re-fetch above proves the event is AUTHENTIC but says nothing
    // about it being CURRENT. Without this, anyone holding a historic evt_ id (for an
    // active pro subscription, say) could POST it again and re-trigger the state change
    // it originally caused. Speculative — event ids are not normally exposed — but the
    // fix is one timestamp check. Stripe retries a webhook for up to 3 days, so anything
    // older than that is never a legitimate delivery.
    // v691 — WIDENED FROM 72h TO 7 DAYS. 72h is exactly Stripe's "up to 3 days" retry window,
    // so the last retries — and any manual re-send after fixing a config error — were dropped.
    // Since v691 every plan decision is taken from the subscription as Stripe holds it NOW (and
    // the checkout plan from its current price), so replaying an old event can only re-apply the
    // present state; the guard stays as defence in depth, with room for a human to re-send.
    const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    const createdMs = Number(evt.created) * 1000;
    if (!Number.isFinite(createdMs) || createdMs <= 0 || (Date.now() - createdMs) > MAX_EVENT_AGE_MS) {
      // v691 — this drop was silent. It is also where a MANUAL re-send lands (the CONFIG ERROR
      // line below tells a human to "re-send this event"), and where Stripe's last retry lands
      // when it is later than the window — both acknowledged with nothing applied and no trace.
      console.error('stripe-webhook: STALE EVENT NOT APPLIED — ' + evtId + ' type=' + evt.type + ' created ' +
        (Number.isFinite(createdMs) ? new Date(createdMs).toISOString() : 'never') + ' is older than the 7-day replay window.' +
        ' If this was a deliberate re-send, apply the change by hand.');
      return res.status(200).json({ ok: true, ignored: 'stale event' });
    }

    const type = evt.type;
    const sub = (evt.data && evt.data.object) || {};

    // ── FIRST PURCHASE ────────────────────────────────────────────────────────
    // The event that fires the moment the card clears, whether or not the browser ever
    // makes it back to /api/checkout-confirm. `metadata.plan` here is OUR value (written by
    // create-checkout), so it does not depend on the price-id env vars being right.
    if (type === 'checkout.session.completed') {
      const s = sub;
      if (s.mode !== 'subscription') return res.status(200).json({ ok: true, ignored: 'not a subscription checkout' });
      // Same rule as checkout-confirm: `status:'complete'` alone is also satisfied by a
      // 100%-off promo session, which must not grant a paid tier.
      if (s.payment_status !== 'paid') return res.status(200).json({ ok: true, ignored: 'not paid yet' });

      const customerId = s.customer || null;
      const subId = s.subscription || null;
      // v691 — see liveSubscription(): a retried or out-of-order checkout event must not revive a
      // subscription that has since ended. A first purchase that is not active yet is granted by
      // the `customer.subscription.updated` that fires when it becomes active.
      let liveSub = null;
      if (subId) {
        const live = await liveSubscription(subId, secret);
        if (live.unknown) {
          console.error('stripe-webhook: PAID, BUT COULD NOT READ SUBSCRIPTION ' + subId + ' — ' + live.why +
            ' — checkout session=' + (s.id || 'none') + ' evt=' + evtId + ' — returning 503 so Stripe retries.');
          return res.status(503).json({ ok: false, error: 'subscription_refetch_failed' });
        }
        const liveStatus = live.absent ? 'absent' : live.sub.status;
        if (liveStatus !== 'active' && liveStatus !== 'trialing') {
          console.error('stripe-webhook: checkout session=' + (s.id || 'none') + ' is paid but subscription ' + subId +
            ' is now "' + liveStatus + '" — NOT granting from this (late or out-of-order) event; the subscription ' +
            'events decide. evt=' + evtId);
          /* v691 round 3 — THE REDELIVERY MUST BE ABLE TO REPAIR. If an earlier delivery wrote the
             grant and then could not confirm it (re-read or undo write failed → 503
             grant_unconfirmed), this redelivery is the ONLY thing that can still fix the row: it
             used to answer 200 here without looking, leaving pro + the dead subscription id
             forever. So: find the user, and if their row still holds THIS subscription, put it
             back to free. A row on another subscription, or already clear, is not touched. */
          const rr = await resolveUserId({
            subscriptionId: subId, customerId,
            metaUserId: (s.metadata && s.metadata.user_id) || s.client_reference_id
          });
          if (!rr.userId && rr.lookupFailed) {
            console.error('stripe-webhook: could not check for an unconfirmed grant on ' + subId + ' — user lookup failed' +
              ' evt=' + evtId + ' — returning 503 so Stripe retries.');
            return res.status(503).json({ ok: false, error: 'user_lookup_failed' });
          }
          if (rr.userId) {
            const u = await undoEndedGrant(rr.userId, subId, liveStatus);
            if (u.retry) {
              console.error('stripe-webhook: could not undo a grant on ended subscription ' + subId + ' — user=' + rr.userId +
                ' — ' + u.why + ' evt=' + evtId + ' — returning 503 so Stripe retries.');
              return res.status(503).json({ ok: false, error: 'grant_unconfirmed' });
            }
            if (u.undone) return res.status(200).json({ ok: true, ignored: 'subscription not live', repaired: true, status: liveStatus });
          }
          return res.status(200).json({ ok: true, ignored: 'subscription not live', status: liveStatus });
        }
        liveSub = live.sub;
      }
      const meta = s.metadata || {};
      /* v691 — THE PLAN COMES FROM WHAT THEY ARE BILLED FOR NOW. The checkout's metadata.plan is
         the plan at purchase time, and the Billing Portal never rewrites it — so a late or
         redelivered checkout after a portal switch put the customer back on the ORIGINAL plan
         (paying for Agency, given Pro; or switched down to Pro, still given Agency). Same order as
         the subscription events: the live price first, then the plan we stamped on the
         subscription, then the checkout's own metadata (only reached on a price-id config error). */
      const livePriceId = liveSub && liveSub.items && liveSub.items.data && liveSub.items.data[0] &&
        liveSub.items.data[0].price && liveSub.items.data[0].price.id;
      const plan = planForPrice(livePriceId)
        || validPlan(liveSub && liveSub.metadata && liveSub.metadata.plan)
        || validPlan(meta.plan) || 'pro';
      if (livePriceId && !planForPrice(livePriceId)) {
        // v691 round 3 — the same loud line the subscription path writes; this fallback was silent.
        console.error('stripe-webhook: CONFIG ERROR — price id "' + livePriceId +
          '" matches no STRIPE_PRICE_PRO / STRIPE_PRICE_AGENCY / STRIPE_PRICE_STARTER. sub=' + subId + ' evt=' + evtId +
          ' — checkout granted "' + plan + '" from metadata instead; fix the env var.');
      }
      const { userId, via, lookupFailed } = await resolveUserId({
        subscriptionId: subId, customerId,
        metaUserId: meta.user_id || s.client_reference_id
      });
      if (!userId && lookupFailed) {
        // v691: "we could not look them up" is not "they do not exist". A paid checkout must not
        // be acknowledged on a database blip — 503 makes Stripe redeliver, and the next attempt
        // resolves normally once the database answers.
        console.error('stripe-webhook: PAID, AND THE USER LOOKUP FAILED — checkout session=' + (s.id || 'none') +
          ' customer=' + customerId + ' sub=' + subId + ' evt=' + evtId + ' — returning 503 so Stripe retries.');
        return res.status(503).json({ ok: false, error: 'user_lookup_failed' });
      }
      if (!userId) {
        console.error('stripe-webhook: PAID BUT UNRESOLVABLE — checkout session=' + (s.id || 'none') +
          ' customer=' + customerId + ' sub=' + subId + ' evt=' + evtId +
          ' carries no user_id metadata and matches no user_plans row. Grant this plan by hand.');
        return res.status(200).json({ ok: true, ignored: 'no user' });
      }
      const r = await applyPlan(userId, plan, {
        stripe_customer_id: customerId, stripe_subscription_id: subId
      });
      if (!r.ok) {
        console.error('stripe-webhook: FIRST PURCHASE NOT APPLIED — user=' + userId + ' plan=' + plan +
          ' sub=' + subId + ' customer=' + customerId + ' evt=' + evtId + ' — returning 500 so Stripe retries.');
        return res.status(500).json({ ok: false, error: 'plan_write_failed' });
      }
      if (r.applied) {
        const c = await confirmGrant(userId, subId, secret);
        if (c.retry) {
          console.error('stripe-webhook: FIRST PURCHASE WRITTEN BUT NOT CONFIRMED — user=' + userId + ' sub=' + subId +
            ' evt=' + evtId + ' — ' + c.why + ' — returning 503 so Stripe retries.');
          return res.status(503).json({ ok: false, error: 'grant_unconfirmed' });
        }
        if (c.undone) return res.status(200).json({ ok: true, ignored: 'subscription ended during grant' });
      }
      console.log('stripe-webhook: first purchase ' + (r.applied ? 'granted' : 'already applied') +
        ' — user=' + userId + ' plan=' + plan + ' resolved via ' + via);
      return res.status(200).json({ ok: true, plan, applied: r.applied, via });
    }

    if (type === 'customer.subscription.created'
        || type === 'customer.subscription.deleted'
        || type === 'customer.subscription.updated') {
      const customerId = sub.customer || null;
      const subId = sub.id || null;
      // v691 — see liveSubscription(): decide from the subscription as it is NOW, not from the
      // event's snapshot, so a late redelivery cannot re-grant a cancelled customer or downgrade
      // a customer whose card has since recovered. `cur` is that current state; a subscription
      // Stripe no longer has is treated as ended (nobody pays through it).
      let cur = sub;
      if (subId) {
        const live = await liveSubscription(subId, secret);
        if (live.unknown) {
          console.error('stripe-webhook: COULD NOT READ SUBSCRIPTION ' + subId + ' — ' + live.why + ' — type=' + type +
            ' customer=' + customerId + ' evt=' + evtId + ' — returning 503 so Stripe retries.');
          return res.status(503).json({ ok: false, error: 'subscription_refetch_failed' });
        }
        cur = live.absent ? Object.assign({}, sub, { status: 'canceled' }) : live.sub;
      }
      const periodEnd = cur.current_period_end ? new Date(cur.current_period_end * 1000).toISOString() : null;
      // Metadata fallback: on a first purchase no row carries the stripe ids yet, so the
      // database lookup CANNOT resolve the user. create-checkout stamps user_id on the
      // subscription for exactly this moment.
      const _r = await resolveUserId({
        subscriptionId: subId, customerId,
        metaUserId: (cur.metadata && cur.metadata.user_id) || null
      });
      const userId = _r.userId;
      if (!userId) {
        if (type === 'customer.subscription.created') {
          console.error('stripe-webhook: NEW SUBSCRIPTION UNRESOLVABLE — sub=' + subId +
            ' customer=' + customerId + ' evt=' + evtId + ' has no user_id metadata and matches no ' +
            'user_plans row. This customer is paying and has NOT been granted anything.');
        }
        // AN UNRESOLVABLE EVENT THAT WOULD HAVE MOVED A PLAN MUST NOT BE ACKNOWLEDGED. This used
        // to fall through to the 200 at the bottom: Stripe reads that as "delivered" and never
        // retries, so a CANCELLED customer whose row carries neither stripe id and whose
        // subscription carries no user_id metadata kept paid access forever, with nothing in the
        // logs. Non-2xx makes Stripe redeliver — and a redelivery resolves normally the moment
        // the grant path (or checkout-confirm) persists the stripe ids. Same 7-day window (v691) as
        // the failed-write 500s below.
        // The ONE exception is a brand-new subscription that is not active yet (`incomplete`
        // while the first payment confirms): the resolved path below deliberately does nothing
        // for it, so an unresolvable one is genuinely ignorable.
        const wouldChangePlan = type !== 'customer.subscription.created'
          || cur.status === 'active' || cur.status === 'trialing';
        if (!wouldChangePlan) return res.status(200).json({ ok: true, ignored: 'no user' });
        if (_r.lookupFailed) {
          // v691 — this used to log "matches no user_plans row" when the database simply did not
          // answer, sending whoever reads the log hunting for a row that is probably there.
          console.error('stripe-webhook: PLAN CHANGE NOT APPLIED, THE USER LOOKUP FAILED — type=' + type + ' sub=' + subId +
            ' customer=' + customerId + ' status=' + (cur.status || 'none') + ' evt=' + evtId +
            ' — the database did not answer; returning 503 so Stripe retries.');
          return res.status(503).json({ ok: false, error: 'user_lookup_failed' });
        }
        console.error('stripe-webhook: PLAN CHANGE UNRESOLVABLE — type=' + type + ' sub=' + subId +
          ' customer=' + customerId + ' status=' + (cur.status || 'none') + ' evt=' + evtId +
          ' matches no user_plans row and carries no user_id metadata — returning 500 so Stripe retries.');
        return res.status(500).json({ ok: false, error: 'unresolved_user' });
      }
      if (userId) {
        const isActive = type !== 'customer.subscription.deleted'
          && (cur.status === 'active' || cur.status === 'trialing');
        // BOTH setPlan RESULTS ARE NOW CHECKED. They used to be discarded while we answered
        // 200 — which tells Stripe "delivered, do not retry". A failed downgrade therefore
        // left a CANCELLED customer with paid access forever, and a failed upgrade left a
        // PAYING customer on free; either way there was nothing in the logs.
        //
        // A non-2xx makes Stripe redeliver, and that retry is what actually heals it. The
        // stale-event guard above allows 7 days (v691), and Stripe's retry window is ~3 days, so a
        // redelivery (same `created` timestamp) stays inside the window.
        if (isActive) {
          // Keep the plan in sync with the active price.
          const priceId = cur.items && cur.items.data && cur.items.data[0] && cur.items.data[0].price && cur.items.data[0].price.id;
          // Price id first (it is the authority on what they are actually being billed for),
          // then the plan WE stamped on the subscription at checkout. The fallback is what
          // keeps a rotated/typo'd STRIPE_PRICE_* from silently granting nothing.
          const byPrice = planForPrice(priceId);
          const byMeta = validPlan(cur.metadata && cur.metadata.plan);
          const plan = byPrice || byMeta;
          if (!byPrice) {
            // LOUD AND GREPPABLE, because this is a CONFIGURATION error and no amount of
            // retrying can heal it — the env var is wrong, not the delivery. That is also why
            // it does not return non-2xx: Stripe would retry for three days and then disable
            // the endpoint, taking the working downgrade path down with it.
            console.error('stripe-webhook: CONFIG ERROR — price id "' + (priceId || 'none') +
              '" matches no STRIPE_PRICE_PRO / STRIPE_PRICE_AGENCY / STRIPE_PRICE_STARTER. ' +
              'user=' + userId + ' sub=' + subId + ' evt=' + evtId + ' — ' +
              (byMeta ? 'granted "' + byMeta + '" from checkout metadata instead; fix the env var.'
                      : 'NOTHING GRANTED. Fix the env var and re-send this event.'));
          }
          if (plan) {
            const r = await applyPlan(userId, plan, { stripe_customer_id: customerId, stripe_subscription_id: subId, current_period_end: periodEnd });
            if (!r.ok) {
              console.error('stripe-webhook: UPGRADE NOT APPLIED — user=' + userId + ' plan=' + plan +
                ' sub=' + subId + ' customer=' + customerId + ' evt=' + evtId + ' — returning 500 so Stripe retries.');
              return res.status(500).json({ ok: false, error: 'plan_write_failed' });
            }
            if (r.applied) {
              const c = await confirmGrant(userId, subId, secret);
              if (c.retry) {
                console.error('stripe-webhook: UPGRADE WRITTEN BUT NOT CONFIRMED — user=' + userId + ' sub=' + subId +
                  ' evt=' + evtId + ' — ' + c.why + ' — returning 503 so Stripe retries.');
                return res.status(503).json({ ok: false, error: 'grant_unconfirmed' });
              }
            }
          }
        } else if (type === 'customer.subscription.created') {
          // A brand-new subscription that is not active yet (`incomplete` while the first
          // payment is confirming) is NOT a cancellation — leave the plan alone and wait for
          // the updated/checkout event. Downgrading here would be wrong for a card in 3DS.
        } else {
          // cancelled / past_due / unpaid / incomplete_expired → back to free.
          // Through applyPlan for the same reason as the grant: a redelivered `deleted` must
          // not re-write a row that already says exactly this.
          // v657: CLEAR THE DEAD SUBSCRIPTION ID. It used to be left on the row forever, and
          // create-checkout refuses on `snap.stripeSubscriptionId` — so every cancelled customer
          // was permanently barred from resubscribing and routed to the Billing Portal, which
          // cannot start a new subscription for someone who no longer has one. Every win-back
          // was blocked. The CUSTOMER id stays: that Stripe customer is still valid and reusing
          // it keeps their card and invoice history on the next purchase.
          /* v691 — TWO DOWNGRADES THAT MUST NOT HAPPEN, and one that must not loop.
             (1) THE ACCOUNT IS GONE. delete-account cancels the subscription and deletes the
                 user_plans row, and the `deleted` event that follows still resolves the user from
                 the subscription's metadata. setPlan then went through getOrInitPlan, which
                 INSERTS a fresh row for a deleted account (or fails on it and 500s for three days
                 of retries). No row means nobody holds paid access: acknowledge, write nothing.
             (2) THE ROW BELONGS TO A NEWER SUBSCRIPTION. A cancelled customer who resubscribes
                 keeps the same Stripe customer, so a late `deleted` for the OLD subscription
                 resolves by customer id and downgraded the customer who is paying for the NEW one.
             (3) "Could not read the row" is neither of those: 503, and a redelivery decides. */
          const snap = await usage.getPlanSnapshot(userId, { strict: true });
          if (!snap || snap.unknown) {
            console.error('stripe-webhook: DOWNGRADE NOT APPLIED, THE PLAN ROW COULD NOT BE READ — user=' + userId +
              ' sub=' + subId + ' evt=' + evtId + ' — returning 503 so Stripe retries.');
            return res.status(503).json({ ok: false, error: 'plan_read_failed' });
          }
          if (snap.missing) {
            console.log('stripe-webhook: ' + type + ' for user=' + userId + ' who has no user_plans row (account deleted)' +
              ' — nothing holds paid access, nothing written. sub=' + subId + ' evt=' + evtId);
            return res.status(200).json({ ok: true, ignored: 'no plan row' });
          }
          if (subId && snap.stripeSubscriptionId && snap.stripeSubscriptionId !== subId) {
            console.log('stripe-webhook: ' + type + ' for subscription ' + subId + ' but user=' + userId +
              ' is now on subscription ' + snap.stripeSubscriptionId + ' — an older subscription ended; plan left alone. evt=' + evtId);
            return res.status(200).json({ ok: true, ignored: 'superseded subscription' });
          }
          const { ok } = await applyPlan(userId, 'free', { current_period_end: periodEnd, stripe_subscription_id: null }, snap);
          if (!ok) {
            console.error('stripe-webhook: DOWNGRADE NOT APPLIED — user=' + userId + ' still has paid access.' +
              ' sub=' + subId + ' customer=' + customerId + ' status=' + (cur.status || type) + ' evt=' + evtId +
              ' — returning 500 so Stripe retries.');
            return res.status(500).json({ ok: false, error: 'plan_write_failed' });
          }
        }
      }
    } else if (type === 'invoice.payment_failed') {
      // A failed payment will be followed by a subscription.updated (past_due) event,
      // which handles the downgrade above. Nothing to do here beyond acknowledging.
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    /* v691 — "never make Stripe retry on our bug" IS BACKWARDS. Our bug is exactly the case
       where a retry helps: the payment already happened, and every path that reaches here has
       NOT applied it. Answering 200 threw the event away permanently. Stripe retries for 3 days
       and then surfaces the failure in the dashboard, which is a far better outcome than a
       silently lost payment — and every deterministic-failure path above already answers 200
       on purpose, so only genuine surprises land here. */
    console.error('stripe-webhook: UNHANDLED — the event was NOT applied. Returning 503 so Stripe retries. ' +
      ((e && e.stack) || (e && e.message) || e));
    return res.status(503).json({ ok: false, error: 'unhandled' });
  }
};
