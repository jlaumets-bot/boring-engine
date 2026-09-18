// Opens the Stripe Billing Portal so a paying customer can update their card,
// view invoices, or cancel — self-serve. Requires env STRIPE_SECRET_KEY.
// NOTE: the Customer Portal must be activated once in the Stripe Dashboard
// (Settings → Billing → Customer portal → Activate), per mode (test + live).
const https = require('https');
const querystring = require('querystring');
const usage = require('./_usage');

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
      console.error('create-portal-session: Stripe request timed out after 15000ms — %s', path);
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
    const customerId = await usage.stripeCustomerId(user.id);
    // v683 — "we could not read your account" is not "you have no subscription". The lookup used
    // to answer null for both, so a Supabase blip locked a paying customer out of the only place
    // they can cancel or replace a failing card, and told them they had nothing to cancel. A 503
    // is honest and, unlike a 400, reads as "try again" to both the user and the client.
    if (customerId && customerId.unknown) {
      return res.status(503).json({ error: 'Could not reach your billing record just now — please try again in a moment.' });
    }
    if (!customerId) return res.status(400).json({ error: 'no_subscription' });

    const base = (origin && allowed.includes(origin)) ? origin : allowed[0];
    const session = await stripePost('/v1/billing_portal/sessions', {
      'customer': customerId,
      'return_url': base + '/app.html'
    }, secret);

    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('create-portal-session error:', e.message);
    // Most common cause: portal not activated in the Stripe Dashboard for this mode.
    return res.status(500).json({ error: 'Could not open billing — please try again.' });
  }
};
