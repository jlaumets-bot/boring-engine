// The server's answer to "may this user create another brand?".
//
// WHY THIS FILE EXISTS. Free is sold as one brand and Agency as "multiple brands & seats"
// (index.html pricing), but the ONLY thing enforcing that anywhere in the product was one line
// of client JavaScript in app.html:
//
//     if (csIsFree() && (allBrands||[]).length >= 1) { showFeatureLock('multibrand'); return; }
//
// It does not hold even in the browser: csIsFree() reads the cached /api/usage response, so it is
// false during the trial and false whenever that call failed — the two states a new account spends
// most of its first week in. And brands are INSERTed straight from the browser through PostgREST;
// there is no brand-creation endpoint in api/ at all (checked: nothing in this directory ever
// POSTs /brands), so anyone with the page open can create as many as they like whatever the
// client thinks.
//
// WHAT THIS CAN AND CANNOT DO. It cannot close the hole on its own — a browser INSERT never
// passes through this code, and the only thing that can actually REFUSE that insert is a database
// policy in sql/ (out of scope here) or the client asking first. What it can do is be the one
// authoritative, callable answer, so that:
//   * app.html can be pointed at it later (it rides on /api/usage, which the app already calls on
//     every load: `csUsage.brands.canCreate`), replacing a check that reads the wrong thing; and
//   * any future server-side brand creation has a limit to consult on line one.
//
// FAILING: this is a limit, but it must never be the reason a new account cannot start. So the
// FIRST brand is always allowed, whatever the plan and whatever we could or could not read, and
// an unreadable plan or count answers `allowed:true` WITH `unknown:true` — fail-open, like the
// rest of the metering, but saying so rather than pretending to know.
const store = require('./_publish/store');

// Brands a plan may OWN. From the pricing page, which is what the company actually sells:
// Free is "40 posts a month, one brand", Pro is a bigger allowance with no multi-brand claim,
// and "Multiple brands & seats for your team" is listed only under Agency. The trial is "Try Pro
// free for 7 days", so it inherits Pro's.
//
// THIS TABLE IS THE POLICY. It is deliberately the only place a brand count is decided — change
// it here and every caller changes with it. NOTE that today's client rule is looser than this
// (it only ever locks `free`), so pointing app.html at this WILL tighten trial/starter/pro from
// unlimited to one: that is a product decision, and it is this line, not a rewrite.
const BRAND_LIMITS = { trial: 1, free: 1, starter: 1, pro: 1, agency: Infinity };
// Unknown plan names fall back to the free allowance, matching _usage.limitFor.
function brandLimitFor(plan) {
  return BRAND_LIMITS[plan] != null ? BRAND_LIMITS[plan] : BRAND_LIMITS.free;
}

// Brands this user OWNS. Membership of somebody else's brand is not ownership and does not
// count against a seat's own allowance — the owner is already paying for that brand.
// Capped rather than counted with Content-Range: the number is single digits in practice, and
// anything at the cap is far past every finite limit anyway.
const COUNT_CAP = 51;
async function ownedBrandCount(userId) {
  const r = await store.rest('GET',
    `/brands?user_id=eq.${encodeURIComponent(userId)}&select=id&limit=${COUNT_CAP}`);
  if (!r || r.status < 200 || r.status >= 300 || !Array.isArray(r.data)) {
    throw new Error('brand count read failed (' + ((r && r.status) || 'no response') + ')');
  }
  return r.data.length;
}

// May this user create another brand?
//   { ok, allowed, plan, brands, limit, reason, unknown? }
//   reason: 'first_brand' | 'within_limit' | 'plan_limit' | 'unknown'
// `plan` may be passed in by a caller that already has it (api/usage.js has just read it) to
// save a round trip; omit it and it is read here.
async function canCreateBrand(userId, plan) {
  if (!userId) return { ok: false, allowed: false, plan: null, brands: null, limit: null, reason: 'no_user' };
  let brands = null;
  try {
    brands = await ownedBrandCount(userId);
  } catch (e) {
    console.error('canCreateBrand: could not count brands for ' + userId +
      ' — answering "allowed, but unknown":', (e && e.message) || e);
    return { ok: false, unknown: true, allowed: true, plan: plan || null, brands: null, limit: null, reason: 'unknown' };
  }
  // ONBOARDING IS NEVER BLOCKED. A user with no brands gets their first one even if the plan
  // read below would have failed, and even if a future limit table said 0.
  if (brands === 0) {
    return { ok: true, allowed: true, plan: plan || null, brands: 0, limit: brandLimitFor(plan), reason: 'first_brand' };
  }
  let p = plan;
  if (!p) {
    try {
      const st = await require('./_usage').getStatus(userId);
      // getStatus fails OPEN with unknown:true; an unknown plan must not become a refusal.
      if (st && st.unknown) return { ok: false, unknown: true, allowed: true, plan: null, brands, limit: null, reason: 'unknown' };
      p = st && st.plan;
    } catch (e) {
      return { ok: false, unknown: true, allowed: true, plan: null, brands, limit: null, reason: 'unknown' };
    }
  }
  const limit = brandLimitFor(p);
  const allowed = brands < limit;
  return {
    ok: true, allowed, plan: p, brands,
    // Infinity does not survive JSON.stringify (it becomes null), so the wire value for
    // "no limit" is null and `allowed` is the field a caller should branch on.
    limit: Number.isFinite(limit) ? limit : null,
    reason: allowed ? 'within_limit' : 'plan_limit'
  };
}

module.exports = { BRAND_LIMITS, brandLimitFor, ownedBrandCount, canCreateBrand };
