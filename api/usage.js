// Returns the signed-in user's plan, trial state, current-period usage — and whether they are
// allowed another brand.
const usage = require('./_usage');

module.exports = async function handler(req, res) {
  const allowed = ['https://contentshrimp.com','https://bettercontent.app','https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await require('./_requireUser')(req);
  if (!user) return res.status(401).json({ error: 'Please sign in again.' });

  const status = await usage.getStatus(user.id);

  // THE BRAND LIMIT, ANSWERED BY THE SERVER. "Free = one brand" was enforced by one client-side
  // `if` in app.html that reads csIsFree() — false during the trial, and false whenever this very
  // call failed — and brands are inserted straight from the browser, so nothing anywhere
  // actually held the line. See api/_brandlimit.js for what this can and cannot fix.
  // It rides on THIS response because the app already fetches it on every load: a client can then
  // ask `csUsage.brands.canCreate` instead of guessing from the plan name. Additive — every
  // existing field is untouched — and never allowed to break the plan response it travels with,
  // which is what the whole app gates on.
  // The plan just read is handed over so this costs ONE extra read, not three.
  try {
    const b = await require('./_brandlimit').canCreateBrand(user.id, status.unknown ? null : status.plan);
    status.brands = { canCreate: b.allowed, count: b.brands, limit: b.limit, reason: b.reason, unknown: !!b.unknown };
  } catch (e) {
    console.error('usage: brand-limit check failed for ' + user.id + ':', (e && e.message) || e);
    status.brands = { canCreate: true, count: null, limit: null, reason: 'unknown', unknown: true };
  }
  return res.status(200).json(status);
};
