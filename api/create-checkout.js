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

function stripePost(path, formObj, secret) {
  return new Promise((resolve, reject) => {
    const body = querystring.stringify(formObj);
    const r = https.request({
      hostname: 'api.stripe.com', path, method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + secret,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
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
      console.error('create-checkout: Stripe request timed out after 15000ms — %s', path);
      r.destroy(new Error('Stripe timed out — your card was not charged twice; try again.'));
    });
    r.on('error', reject);
    r.write(body);
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
    const plan = String((req.body && req.body.plan) || 'pro').toLowerCase();
    const priceEnv = PRICE_ENV[plan];
    const priceId = priceEnv && process.env[priceEnv];
    if (!priceId) return res.status(400).json({ error: 'Unknown or unconfigured plan.' });

    // ── DOUBLE-SUBSCRIPTION REFUSAL ───────────────────────────────────────────
    // This endpoint always creates a NEW `mode:'subscription'` session with no `customer`
    // param, so a caller who is already paying ends up with a SECOND live subscription and is
    // billed twice. app.html routes paid users to the billing portal instead — but that guard
    // is client-side only, and this endpoint was reachable without it.
    //
    // Positive knowledge only: getPlanSnapshot returns null on ANY read failure, and a null
    // must never block a genuine first purchase (Supabase being down would otherwise stop all
    // sales). Logged when it happens so the gap is visible rather than assumed.
    const snap = await require('./_usage').getPlanSnapshot(user.id);
    if (snap == null) {
      console.error('create-checkout: could not read the plan for user=' + user.id +
        ' — proceeding WITHOUT the double-subscription check.');
    } else if (require('./_usage').PAID_PLANS[snap.effectivePlan] || snap.stripeSubscriptionId) {
      // 409, not 402: a 402 makes app.html's global fetch wrapper open the upgrade modal, which
      // is exactly the loop this refusal exists to break. `manageBilling` tells the frontend to
      // send them to /api/create-portal-session, where switching plans is a proration, not a
      // second charge.
      return res.status(409).json({
        error: 'already_subscribed',
        manageBilling: true,
        plan: snap.effectivePlan,
        message: 'You already have an active subscription. Use "Manage plan & billing" to switch plans — starting a new checkout would charge you twice.'
      });
    }

    // Where to send the user back to.
    const base = (origin && allowed.includes(origin)) ? origin : allowed[0];

    const session = await stripePost('/v1/checkout/sessions', {
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
      'allow_promotion_codes': 'true',
      ...(user.email ? { 'customer_email': user.email } : {})
    }, secret);

    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('create-checkout error:', e);
    return res.status(500).json({ error: 'Could not start checkout — please try again.' });
  }
};
