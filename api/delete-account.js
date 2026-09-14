// Permanently delete the signed-in user's account and all their data.
// Verifies the caller via their access token, then wipes brand-scoped rows,
// user-scoped rows, the brands themselves, and finally the auth user.
//
// HONESTY CONTRACT (v613 — this endpoint used to lie):
//   Every request's HTTP STATUS is checked. `{ok:true}` is returned ONLY when the
//   auth user is actually gone. Previously `sb()` resolved on any status (it only
//   rejected on socket errors), so `.catch(()=>{})` never fired, and the handler
//   returned `{ok:true}` unconditionally — a 409 foreign-key violation on the
//   auth.users delete (see sql/security-fixes-batch2.sql) left the account alive
//   while the UI told the user it was gone. For a UK controller that is a direct
//   Article 17 problem, so the endpoint now reports exactly what happened.
//
// RESPONSE CONTRACT (app.html deleteAccount() depends on this):
//   success → 200 { ok:true, ... }        → UI wipes localStorage, signs out, "Account deleted."
//   failure → non-2xx { ok:false, error } → UI shows "Could not delete: <error>" and
//                                            leaves the session intact. `error` is rendered
//                                            VERBATIM to the user, so it must be a readable,
//                                            actionable sentence.
//   Failures also carry `stage` + `partial` + `failures[]` so a caller can act on them.
//
// NO RETRIES: the dominant failure (an FK reference from another user's brand) is
// permanent, so retrying only burns the function budget. The whole operation is
// idempotent — pressing Delete again re-runs it safely.
const https = require('https');

const SUPPORT_EMAIL = 'support@contentshrimp.com';
const REQ_TIMEOUT_MS = 10000;
// vercel.json gives this route maxDuration 30. Stop cleanly under that so a slow
// Supabase can never get us platform-killed (which returns NO body at all — the
// same silent failure we are removing).
const BUDGET_MS = 24000;

// Brand-scoped tables WITHOUT an `on delete cascade` from brands(id) — these must be
// deleted explicitly. (brand_connections / brand_autopublish / publish_jobs /
// brand_members / brand_invites all declare `references brands(id) on delete cascade`,
// so the brands delete removes them — including the encrypted publishing credentials.)
const BRAND_SCOPED = ['ideas','remixes','product_refs','competitors','prompt_history','notebook_notes','edit_signals','push_subscriptions'];

// User-scoped tables holding personal data that does NOT hang off brands. These were
// never deleted before; they only disappeared if their schema cascades from
// auth.users — and since the auth delete could silently fail, the safe reading is
// that they persisted. dfy_requests stores an email, user_plans stores Stripe ids.
const USER_SCOPED = ['dfy_requests','usage_events','user_plans'];

module.exports = async function handler(req, res) {
  // CORS + method guards (account deletion must be a deliberate same-origin POST)
  const allowed = ['https://contentshrimp.com','https://bettercontent.app','https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const t0 = Date.now();
  const timeLeft = () => BUDGET_MS - (Date.now() - t0);

  // Everything we could not complete, so the response can be specific instead of a shrug.
  const failures = [];   // { step, status }  — status 0 means the request never completed
  const skipped = [];    // tables that do not exist in this install (404) — not a failure
  let billingLive = '';  // a Stripe subscription id we could NOT cancel — must reach the user
  // Counts DELETEs that SUCCEEDED (PostgREST answers 204 whether or not rows matched,
  // so this means "a destructive step ran", not "N rows died"). >0 ⇒ a later failure
  // leaves the account in a PARTIAL state, and the copy below is worded to be true
  // either way rather than claiming content was removed that may not have existed.
  let deletedRows = 0;
  // Hoisted out of the try: every failure path below (and the catch) needs them to put the
  // plan tombstone back — see restorePlanTombstone at the bottom of this handler.
  let userId = null;
  let planRowDeleted = false;

  try {
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ ok: false, partial: false, stage: 'config', error: 'account deletion is not configured on the server. Please email ' + SUPPORT_EMAIL + '.' });
    }
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ ok: false, error: 'Not authenticated' });

    // Verify the token -> get the user id (so a user can only delete THEMSELVES)
    const userResp = await sb(SUPABASE_URL, '/auth/v1/user', 'GET', SUPABASE_SERVICE_ROLE_KEY, null, token);
    const body = userResp.data;
    const user = body && body.id ? body : (body && body.user) || null;
    userId = user && user.id;
    if (!userResp.ok || !userId) return res.status(401).json({ ok: false, error: 'Invalid session' });

    // Find this user's brand ids. If this READ fails we do not know what to delete,
    // so we must stop — deleting blind would be worse than failing.
    const brandsResp = await sb(SUPABASE_URL, `/rest/v1/brands?user_id=eq.${userId}&select=id`, 'GET', SUPABASE_SERVICE_ROLE_KEY);
    if (!brandsResp.ok || !Array.isArray(brandsResp.data)) {
      logFail('list_brands', brandsResp);
      return res.status(502).json({
        ok: false, partial: false, stage: 'list_brands',
        error: "we couldn't reach your data, so nothing was deleted. Please try again in a minute.",
        failures: [{ step: 'list_brands', status: brandsResp.status }]
      });
    }
    const brandIds = brandsResp.data.map(b => b.id);

    // ── 1. Brand-scoped rows ────────────────────────────────────────────────────
    // Parallel per brand (bounded: 8 requests) so a user with several brands still
    // finishes inside the function budget.
    for (const id of brandIds) {
      if (timeLeft() <= 0) break;
      const results = await Promise.all(BRAND_SCOPED.map(t =>
        sb(SUPABASE_URL, `/rest/v1/${t}?brand_id=eq.${id}`, 'DELETE', SUPABASE_SERVICE_ROLE_KEY)
      ));
      results.forEach((r, i) => record(BRAND_SCOPED[i], r));
    }

    // Anything keyed by user_id rather than brand_id.
    if (timeLeft() > 0) {
      record('push_subscriptions', await sb(SUPABASE_URL, `/rest/v1/push_subscriptions?user_id=eq.${userId}`, 'DELETE', SUPABASE_SERVICE_ROLE_KEY));
    }

    // ── 2. User-scoped personal data ────────────────────────────────────────────
    // CANCEL THE SUBSCRIPTION FIRST. Deleting user_plans erases the Stripe mapping,
    // so if we drop the row without cancelling, the person keeps being charged for an
    // account they deleted AND we have thrown away the id needed to find it. Charging
    // someone after they closed their account is the worst outcome here, so this runs
    // before the row goes and its failure is reported to the user rather than swallowed.
    // Erasure still proceeds on failure — refusing to delete their data would trade one
    // duty for another — but we say so plainly and log the id so it can be finished by hand.
    if (timeLeft() > 0) {
      const plan = await sb(SUPABASE_URL, `/rest/v1/user_plans?user_id=eq.${userId}&select=stripe_subscription_id`, 'GET', SUPABASE_SERVICE_ROLE_KEY);
      const subId = plan.ok && Array.isArray(plan.data) && plan.data[0] && plan.data[0].stripe_subscription_id;
      if (subId) {
        const cancelled = await stripeCancel(subId);
        if (cancelled.ok) {
          console.log('delete-account: cancelled Stripe subscription', subId);
        } else {
          // Loud, and carried into the response. Only the Stripe object id is logged — never the email.
          console.error('delete-account: COULD NOT CANCEL Stripe subscription — CANCEL IT MANUALLY:', subId, cancelled.reason);
          failures.push({ step: 'stripe_cancel', status: cancelled.status || 0 });
          billingLive = subId;
        }
      }
    }
    for (const t of USER_SCOPED) {
      if (timeLeft() <= 0) break;
      const _r = await sb(SUPABASE_URL, `/rest/v1/${t}?user_id=eq.${userId}`, 'DELETE', SUPABASE_SERVICE_ROLE_KEY);
      // The plan row is the one deletion that changes what the app does to a STILL-SIGNED-IN
      // user, so it is tracked separately (restorePlanTombstone).
      if (t === 'user_plans' && _r.ok) planRowDeleted = true;
      record(t, _r);
    }

    // ── 3. The brands themselves (cascades brand_connections, publish_jobs, …) ───
    if (timeLeft() <= 0) { await restorePlanTombstone(); return outOfTime(res, failures, skipped, deletedRows, 'brands'); }
    const brandsDel = await sb(SUPABASE_URL, `/rest/v1/brands?user_id=eq.${userId}`, 'DELETE', SUPABASE_SERVICE_ROLE_KEY);
    if (brandsDel.ok) { deletedRows++; }
    else {
      logFail('brands', brandsDel);
      failures.push({ step: 'brands', status: brandsDel.status });
      // Do NOT attempt the auth-user delete: its data is still here, and removing the
      // login would strand that data with no owner.
      await restorePlanTombstone();
      return res.status(502).json({
        ok: false, partial: deletedRows > 0, stage: 'brands',
        error: deletedRows > 0
          ? "the deletion only partly completed — your account still exists and some of your data may already have been removed. Please email " + SUPPORT_EMAIL + " and we'll finish it."
          : "your brands could not be deleted, so nothing was removed. Please try again, or email " + SUPPORT_EMAIL + " if it keeps failing.",
        failures, skipped
      });
    }

    // ── 4. The auth user (frees the email) ──────────────────────────────────────
    if (timeLeft() <= 0) { await restorePlanTombstone(); return outOfTime(res, failures, skipped, deletedRows, 'auth_user'); }
    const authDel = await sb(SUPABASE_URL, `/auth/v1/admin/users/${userId}`, 'DELETE', SUPABASE_SERVICE_ROLE_KEY);
    // 404 = already gone (a previous attempt got this far). Idempotent ⇒ success.
    const accountGone = authDel.ok || authDel.status === 404;
    if (!accountGone) {
      logFail('auth_user', authDel);
      failures.push({ step: 'auth_user', status: authDel.status });
      // THE dangerous case: the data is gone but the login is not. Say so plainly —
      // a user told deletion failed can escalate; one falsely told it succeeded cannot.
      // It is also the case that used to hand out a brand-new trial, so put the plan row back.
      await restorePlanTombstone();
      return res.status(409).json({
        ok: false, partial: true, stage: 'auth_user',
        error: "your data was deleted, but your sign-in could not be removed — the account and its email are still active. Please email " + SUPPORT_EMAIL + " and we'll finish removing it.",
        failures, skipped
      });
    }

    // Data gone AND account gone. Any non-fatal per-table failures are still reported
    // so this is never silently "clean" when it wasn't.
    // `ok:true` is correct — the deletion DID happen, and the UI must sign them out.
    // But if we could not cancel their subscription they are still being CHARGED for an
    // account that no longer exists, and being told only "Account deleted." would be the
    // same silent lie this endpoint was rewritten to remove. So it rides along on success.
    return res.status(200).json({
      ok: true,
      brands: brandIds.length,
      skipped,
      incomplete: failures.length ? failures : undefined,
      billingWarning: billingLive
        ? "Your account is deleted, but we could not automatically cancel your subscription — you may still be billed. Please email " + SUPPORT_EMAIL + " right away and we'll cancel it and refund anything charged."
        : undefined
    });
  } catch (e) {
    console.error('delete-account: unexpected failure', e && e.message);
    // Same reasoning as the failure returns above: the account is still alive, so it must not
    // be able to come back as a fresh trial. Never let this throw out of the catch.
    try { await restorePlanTombstone(); } catch (_) {}
    return res.status(500).json({
      ok: false, partial: deletedRows > 0, stage: 'unexpected',
      error: deletedRows > 0
        ? "something went wrong part-way through, so your account may still exist. Please email " + SUPPORT_EMAIL + " before signing up again."
        : "something went wrong and nothing was deleted. Please try again, or email " + SUPPORT_EMAIL + " if it keeps failing.",
      failures
    });
  }

  // ── helpers that close over the per-request tallies ──────────────────────────
  // A 404 on an optional table means the table does not exist in this install
  // (PostgREST reports an unknown relation as 404) — recorded, not failed.
  function record(table, r) {
    if (r.ok) { deletedRows++; return; }
    if (r.status === 404) { if (!skipped.includes(table)) skipped.push(table); return; }
    logFail(table, r);
    failures.push({ step: table, status: r.status });
  }
  // ── The failed-deletion tombstone ────────────────────────────────────────────
  // A deletion that does not complete leaves the person SIGNED IN with no user_plans row,
  // and _usage.getOrInitPlan reads a missing row as a brand-new signup: it writes a fresh
  // 7-day, 150-credit TRIAL. So the endpoint's own dominant failure mode (the auth-user
  // delete, see the header) handed a new trial to an account whose subscription had just
  // been cancelled three steps earlier.
  //
  // WHY A RESTORE ON THE FAILURE PATH, and not "delete user_plans last": the ON DELETE rule
  // between user_plans and auth.users is unknown in this repo — sql/security-fixes-batch2.sql
  // says so in as many words — and any row that does NOT cascade is a row that can BLOCK the
  // auth.users delete. Moving the plan delete after the auth delete could therefore turn a
  // deletion that works today into one that fails. This runs only when the account is KNOWN to
  // still exist, so the row it writes can never block anything.
  //
  // The tombstone carries no personal data: no Stripe ids, no email, no period dates — just the
  // user id, the free plan, and a trial end in the past, which is exactly what effectivePlan()
  // reads. Erasure is therefore still honoured; what comes back is a marker, not their data.
  async function restorePlanTombstone() {
    if (!planRowDeleted || !userId) return;
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
    const r = await sb(SUPABASE_URL, '/rest/v1/user_plans', 'POST', SUPABASE_SERVICE_ROLE_KEY, {
      user_id: userId,
      plan: 'free',
      trial_ends_at: new Date(Date.now() - 1000).toISOString()
    });
    if (r.ok) {
      planRowDeleted = false;
      console.log('delete-account: deletion did not complete for ' + userId +
        ' — wrote a free-plan tombstone so the still-live account cannot be re-initialised as a new trial');
    } else {
      // Loud: if this write fails we are back to the original bug for this one account.
      console.error('delete-account: could NOT restore the plan tombstone for ' + userId +
        ' (' + r.status + ') — this account will be handed a fresh 7-day trial on its next request',
        (r.raw || '').slice(0, 200));
    }
  }
  function logFail(step, r) {
    console.error('delete-account: ' + step + ' failed', { status: r.status, error: r.error, body: (r.raw || '').slice(0, 300) });
  }
};

// Budget exhausted before we finished. Report it as a real failure rather than
// letting the platform kill the function and return nothing at all.
function outOfTime(res, failures, skipped, deletedRows, stage) {
  console.error('delete-account: ran out of time at stage', stage);
  failures.push({ step: stage, status: 0 });
  return res.status(504).json({
    ok: false, partial: deletedRows > 0, stage,
    error: deletedRows > 0
      ? "this timed out part-way through, so your account still exists. Please email " + SUPPORT_EMAIL + " and we'll finish it."
      : "this timed out and nothing was deleted. Please try again in a minute.",
    failures, skipped
  });
}

// Resolves { status, ok, data, raw, error }. NEVER rejects — callers decide what a
// given status means. A socket error or timeout resolves with status 0 so it is
// distinguishable from a real HTTP response.
// Cancel a Stripe subscription immediately. `DELETE /v1/subscriptions/:id` is the
// immediate-cancel call — correct here, since the person is closing the account rather
// than letting it lapse. Never throws: returns {ok:false, reason} so the caller decides.
// A missing key is a FAILURE, not a silent skip — if billing is configured in production
// and the key is absent, the subscription is very much still live.
function stripeCancel(subId) {
  return new Promise(resolve => {
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) return resolve({ ok: false, status: 0, reason: 'STRIPE_SECRET_KEY is not set' });
    if (!/^sub_[A-Za-z0-9_]+$/.test(String(subId))) {
      return resolve({ ok: false, status: 0, reason: 'stored subscription id is not a valid sub_ id' });
    }
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const r = https.request({
      hostname: 'api.stripe.com', path: '/v1/subscriptions/' + encodeURIComponent(subId),
      method: 'DELETE', headers: { 'Authorization': 'Bearer ' + secret }
    }, resp => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => {
        let j = null; try { j = JSON.parse(d); } catch (_) {}
        // Already cancelled, or already gone from Stripe → nothing left to bill. Treat as done.
        if (resp.statusCode === 404) return finish({ ok: true, status: 404 });
        if (resp.statusCode >= 400) {
          return finish({ ok: false, status: resp.statusCode, reason: (j && j.error && j.error.message) || ('Stripe ' + resp.statusCode) });
        }
        if (j && j.status && j.status !== 'canceled') {
          return finish({ ok: false, status: resp.statusCode, reason: 'Stripe reported status "' + j.status + '" after cancel' });
        }
        finish({ ok: true, status: resp.statusCode });
      });
    });
    r.setTimeout(REQ_TIMEOUT_MS, () => { r.destroy(); finish({ ok: false, status: 0, reason: 'timed out' }); });
    r.on('error', e => finish({ ok: false, status: 0, reason: String(e && e.message) }));
    r.end();
  });
}

function sb(base, path, method, serviceKey, body, userToken) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    let u;
    try { u = new URL(base); } catch (e) { return finish({ status: 0, ok: false, data: null, raw: '', error: 'bad SUPABASE_URL' }); }
    const headers = {
      'apikey': serviceKey,
      'Authorization': 'Bearer ' + (userToken || serviceKey),
      'Content-Type': 'application/json',
    };
    if (method === 'DELETE') headers['Prefer'] = 'return=minimal';
    const r = https.request({ hostname: u.hostname, path, method, headers }, resp => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => {
        const status = resp.statusCode || 0;
        let data = null;
        try { data = d ? JSON.parse(d) : null; } catch (_) { data = null; }
        finish({ status, ok: status >= 200 && status < 300, data, raw: d, error: null });
      });
    });
    r.setTimeout(REQ_TIMEOUT_MS, () => r.destroy(new Error('timeout')));
    r.on('error', e => finish({ status: 0, ok: false, data: null, raw: '', error: (e && e.message) || 'network error' }));
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
