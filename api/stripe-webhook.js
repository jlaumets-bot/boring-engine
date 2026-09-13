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
async function resolveUserId({ subscriptionId, customerId, metaUserId }) {
  let id = subscriptionId ? await usage.userIdByStripe({ subscriptionId }) : null;
  if (id) return { userId: id, via: 'subscription_id' };
  id = customerId ? await usage.userIdByStripe({ customerId }) : null;
  if (id) return { userId: id, via: 'customer_id' };
  if (metaUserId && typeof metaUserId === 'string' && metaUserId.trim()) {
    return { userId: metaUserId.trim(), via: 'metadata' };
  }
  return { userId: null, via: 'unresolved' };
}

// Write the plan ONLY if the row does not already say exactly this. Stripe redelivers, and the
// redirect confirm can land on the same state a second earlier — neither may double-apply, and a
// replayed `updated` must not undo a row that already matches. `applied:false` means "already
// correct", which is a success, not a no-op failure.
async function applyPlan(userId, plan, extra) {
  const snap = await usage.getPlanSnapshot(userId);
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
        if (resp.statusCode >= 400) return reject(new Error((j && j.error && j.error.message) || ('Stripe ' + resp.statusCode)));
        resolve(j);
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(new Error('Stripe timeout')); });
    r.end();
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const secret = process.env.STRIPE_SECRET_KEY;
  // Always 200 so Stripe doesn't retry-storm when billing isn't configured or we hit a bug.
  if (!secret) return res.status(200).json({ ok: true, skipped: 'billing not configured' });

  try {
    const evtId = req.body && req.body.id;
    if (!evtId || typeof evtId !== 'string' || !evtId.startsWith('evt_')) {
      return res.status(200).json({ ok: true, ignored: 'no event id' });
    }

    // Re-fetch the real event from Stripe (authenticity check).
    let evt = null;
    try { evt = await stripeGet('/v1/events/' + encodeURIComponent(evtId), secret); }
    catch (e) { return res.status(200).json({ ok: true, ignored: 'event not found' }); }
    if (!evt || !evt.type) return res.status(200).json({ ok: true, ignored: 'no event' });

    // REPLAY GUARD. The re-fetch above proves the event is AUTHENTIC but says nothing
    // about it being CURRENT. Without this, anyone holding a historic evt_ id (for an
    // active pro subscription, say) could POST it again and re-trigger the state change
    // it originally caused. Speculative — event ids are not normally exposed — but the
    // fix is one timestamp check. Stripe retries a webhook for up to 3 days, so anything
    // older than that is never a legitimate delivery.
    const MAX_EVENT_AGE_MS = 72 * 60 * 60 * 1000;
    const createdMs = Number(evt.created) * 1000;
    if (!Number.isFinite(createdMs) || createdMs <= 0 || (Date.now() - createdMs) > MAX_EVENT_AGE_MS) {
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
      const meta = s.metadata || {};
      const plan = validPlan(meta.plan) || 'pro';
      const { userId, via } = await resolveUserId({
        subscriptionId: subId, customerId,
        metaUserId: meta.user_id || s.client_reference_id
      });
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
      console.log('stripe-webhook: first purchase ' + (r.applied ? 'granted' : 'already applied') +
        ' — user=' + userId + ' plan=' + plan + ' resolved via ' + via);
      return res.status(200).json({ ok: true, plan, applied: r.applied, via });
    }

    if (type === 'customer.subscription.created'
        || type === 'customer.subscription.deleted'
        || type === 'customer.subscription.updated') {
      const customerId = sub.customer || null;
      const subId = sub.id || null;
      const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
      // Metadata fallback: on a first purchase no row carries the stripe ids yet, so the
      // database lookup CANNOT resolve the user. create-checkout stamps user_id on the
      // subscription for exactly this moment.
      const _r = await resolveUserId({
        subscriptionId: subId, customerId,
        metaUserId: (sub.metadata && sub.metadata.user_id) || null
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
        // the grant path (or checkout-confirm) persists the stripe ids. Same 72h/3-day window as
        // the failed-write 500s below.
        // The ONE exception is a brand-new subscription that is not active yet (`incomplete`
        // while the first payment confirms): the resolved path below deliberately does nothing
        // for it, so an unresolvable one is genuinely ignorable.
        const wouldChangePlan = type !== 'customer.subscription.created'
          || sub.status === 'active' || sub.status === 'trialing';
        if (!wouldChangePlan) return res.status(200).json({ ok: true, ignored: 'no user' });
        console.error('stripe-webhook: PLAN CHANGE UNRESOLVABLE — type=' + type + ' sub=' + subId +
          ' customer=' + customerId + ' status=' + (sub.status || 'none') + ' evt=' + evtId +
          ' matches no user_plans row and carries no user_id metadata — returning 500 so Stripe retries.');
        return res.status(500).json({ ok: false, error: 'unresolved_user' });
      }
      if (userId) {
        const isActive = type !== 'customer.subscription.deleted'
          && (sub.status === 'active' || sub.status === 'trialing');
        // BOTH setPlan RESULTS ARE NOW CHECKED. They used to be discarded while we answered
        // 200 — which tells Stripe "delivered, do not retry". A failed downgrade therefore
        // left a CANCELLED customer with paid access forever, and a failed upgrade left a
        // PAYING customer on free; either way there was nothing in the logs.
        //
        // A non-2xx makes Stripe redeliver, and that retry is what actually heals it. The
        // stale-event guard above allows 72h, and Stripe's retry window is ~3 days, so a
        // redelivery (same `created` timestamp) stays inside the window.
        if (isActive) {
          // Keep the plan in sync with the active price.
          const priceId = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price && sub.items.data[0].price.id;
          // Price id first (it is the authority on what they are actually being billed for),
          // then the plan WE stamped on the subscription at checkout. The fallback is what
          // keeps a rotated/typo'd STRIPE_PRICE_* from silently granting nothing.
          const byPrice = planForPrice(priceId);
          const byMeta = validPlan(sub.metadata && sub.metadata.plan);
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
          }
        } else if (type === 'customer.subscription.created') {
          // A brand-new subscription that is not active yet (`incomplete` while the first
          // payment is confirming) is NOT a cancellation — leave the plan alone and wait for
          // the updated/checkout event. Downgrading here would be wrong for a card in 3DS.
        } else {
          // cancelled / past_due / unpaid / incomplete_expired → back to free.
          // Through applyPlan for the same reason as the grant: a redelivered `deleted` must
          // not re-write a row that already says exactly this.
          const { ok } = await applyPlan(userId, 'free', { current_period_end: periodEnd });
          if (!ok) {
            console.error('stripe-webhook: DOWNGRADE NOT APPLIED — user=' + userId + ' still has paid access.' +
              ' sub=' + subId + ' customer=' + customerId + ' status=' + (sub.status || type) + ' evt=' + evtId +
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
    console.error('stripe-webhook error:', e.message);
    return res.status(200).json({ ok: true }); // never make Stripe retry on our bug
  }
};
