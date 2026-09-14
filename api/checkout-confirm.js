// After Stripe redirects back with a session_id, verify the session was paid and
// upgrade the user's plan.
//
// THIS IS THE FAST PATH, NOT THE ONLY PATH. It used to be the only thing that granted a first
// purchase, so a closed tab on the way back meant charged-and-never-granted with nothing able
// to retry it. api/stripe-webhook.js now also grants on checkout.session.completed and
// customer.subscription.created, resolving the user from the subscription metadata when no row
// carries the stripe ids yet. Whichever arrives first wins; the other finds the row already
// correct and skips the write (see applyPlan there). Keep both — the redirect is what makes the
// upgrade feel instant, the webhook is what makes it certain.
const https = require('https');
const usage = require('./_usage');

function stripeGet(path, secret) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'api.stripe.com', path, method: 'GET',
      headers: { 'Authorization': 'Bearer ' + secret }
    }, resp => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => {
        let j = null; try { j = JSON.parse(d); } catch (_) {}
        if (resp.statusCode >= 400) return reject(new Error((j && j.error && j.error.message) || ('Stripe ' + resp.statusCode)));
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
      console.error('checkout-confirm: Stripe request timed out after 15000ms — %s', path);
      r.destroy(new Error('Stripe timed out — your card was not charged twice; try again.'));
    });
    r.on('error', reject);
    r.end();
  });
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
    const sessionId = String((req.body && req.body.sessionId) || '').trim();
    if (!sessionId) return res.status(400).json({ error: 'Missing session id.' });

    const session = await stripeGet('/v1/checkout/sessions/' + encodeURIComponent(sessionId), secret);

    // Must belong to THIS user and be genuinely PAID. Require payment_status==='paid'
    // — do NOT accept status==='complete' alone, which a 100%-off promo / no-charge
    // session also satisfies (would grant a paid tier without payment).
    const metaUser = session && session.metadata && session.metadata.user_id;
    const paid = session && session.payment_status === 'paid';
    if (!metaUser || metaUser !== user.id) return res.status(403).json({ error: 'This checkout is not yours.' });
    if (!paid) return res.status(200).json({ ok: false, pending: true });

    // ── REPLAY GUARD (v657) ────────────────────────────────────────────────────
    // This endpoint used to check only: session exists, metadata.user_id is mine,
    // payment_status === 'paid'. All three stay true FOREVER for a completed session —
    // so a user who cancelled could re-POST the sessionId sitting in their browser
    // history (it is in success_url) and get pro/agency back permanently. Nothing
    // revoked it afterwards, because the subscription was gone and Stripe therefore
    // sent no further events. stripe-webhook.js has had MAX_EVENT_AGE_MS since it was
    // written; this file never got the equivalent.
    //
    // Two independent bounds, because neither alone is enough:
    //   1. AGE — a genuine confirm happens seconds after checkout. 72h matches the
    //      webhook's window and still covers a slow redirect, a closed tab reopened
    //      later, or a retry after an outage.
    //   2. STILL LIVE — the decisive one. A subscription that has been cancelled,
    //      or was never created, can no longer grant anything no matter how the
    //      session looks. This is what makes an old URL worthless.
    const MAX_SESSION_AGE_S = 72 * 3600;
    const ageS = session && session.created ? Math.floor(Date.now() / 1000) - Number(session.created) : 0;
    if (ageS > MAX_SESSION_AGE_S) {
      console.warn('checkout-confirm: REPLAY REFUSED (stale session) user=%s session=%s age_hours=%s',
        user.id, sessionId, Math.round(ageS / 3600));
      return res.status(403).json({ error: 'This checkout link has expired. Open Settings to manage your plan.' });
    }

    if (session.subscription) {
      let sub = null;
      try {
        sub = await stripeGet('/v1/subscriptions/' + encodeURIComponent(session.subscription), secret);
      } catch (e) {
        // Cannot verify => do not grant. Failing closed here is correct: the only cost is
        // that a legitimate user retries, and the webhook grants independently anyway.
        console.error('checkout-confirm: could not read subscription %s for user %s — %s',
          session.subscription, user.id, e && e.message);
        return res.status(503).json({ error: 'Could not confirm your subscription just now — reload in a minute.' });
      }
      const live = sub && (sub.status === 'active' || sub.status === 'trialing');
      if (!live) {
        console.warn('checkout-confirm: REPLAY REFUSED (subscription not live) user=%s session=%s sub=%s status=%s',
          user.id, sessionId, session.subscription, sub && sub.status);
        return res.status(403).json({ error: 'That subscription is no longer active. Start a new plan from Settings.' });
      }
    }
    // ───────────────────────────────────────────────────────────────────────────

    const plan = (session.metadata && session.metadata.plan) || 'pro';
    const planSet = await usage.setPlan(user.id, plan, {
      stripe_customer_id: session.customer || null,
      stripe_subscription_id: session.subscription || null
    });

    // THE CARD IS ALREADY CHARGED BY THIS POINT. The return value used to be discarded and
    // we answered ok:true regardless — so a failed plan write showed the user "You're on
    // Pro 🎉" while they were still on free, paid, with nothing in the logs.
    //
    // Nothing self-heals this: the subscription webhook finds a user via stripe_customer_id
    // / stripe_subscription_id, which is precisely what failed to write here. So this needs
    // a human. Log the ids required to fix the row by hand, and tell the user the truth in
    // the calmest form there is — their money is fine, only the switch-over is stuck.
    //
    // 500, deliberately NOT 402: app.html's global fetch wrapper opens the upgrade modal on
    // ANY /api/ 402, and "please upgrade" is the worst possible thing to show someone who
    // just paid. 500 also matches this file's existing catch branch.
    if (!planSet) {
      console.error('checkout-confirm: PAID BUT NOT UPGRADED — user=' + user.id + ' plan=' + plan +
        ' session=' + sessionId + ' customer=' + (session.customer || 'none') +
        ' subscription=' + (session.subscription || 'none') + ' — set this plan by hand.');
      return res.status(500).json({
        ok: false,
        planUpdateFailed: true,
        plan,
        error: 'Payment went through. We could not switch your plan over just yet — refresh in a moment, and if it still looks wrong contact support and we will fix it right away.'
      });
    }

    const status = await usage.getStatus(user.id);
    return res.status(200).json({ ok: true, plan, status });
  } catch (e) {
    console.error('checkout-confirm error:', e);
    return res.status(500).json({ error: 'Could not confirm your upgrade — please refresh.' });
  }
};
