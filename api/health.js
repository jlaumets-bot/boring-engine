// GET /api/health — public, sanitized daily health check.
//
// Runs the LIVE isolation + config checks server-side (service role) and returns
// ONLY pass/fail booleans per check plus an overall verdict — never table names,
// env values, or other sensitive detail. The daily Cowork scheduled task fetches
// this and reports the result in chat; on any fail the owner investigates via
// sql/health-check.sql. Safe to be public because it leaks nothing actionable.

const store = require('./_publish/store');
const { callLLM } = require('./_llm');

// The RESOLVED cost-fuse value, read from the one place that defines it. Never
// re-derive it here: _usage.js applies the default (25) and treats an empty or
// non-numeric COST_CAP_EUR as 0 = disabled, so reading process.env directly would
// report a fuse that is not the one actually enforced. If the require fails we
// leave it null so the check FAILS — we cannot confirm the fuse is armed.
let COST_CAP_EUR = null;
try { ({ COST_CAP_EUR } = require('./_usage')); } catch (_) {}

// RLS-on-but-zero-policies is deny-all (safe). These tables are intentionally
// backend-only via the service role, so they're expected to have no client policies.
// brand_connections stays listed while the (now unused) table still exists in the DB —
// in-app publishing was removed, but the table was not dropped, and a live table with RLS on
// and zero policies would otherwise be flagged here.
const ZERO_POLICY_ALLOWED = ['brand_connections', 'job_heartbeats'];

// The arrays security_health() always returns. Their PRESENCE is what proves the audit
// actually ran: a PostgREST error body is also a plain object, and treating one as an
// audit result turned a database error into five green security claims. See isolationOf().
const AUDIT_ARRAY_KEYS = [
  'rls_disabled', 'permissive_policies', 'permissive_write_policies',
  'unbound_brand_tables', 'zero_policy_tables',
];

// Cron liveness thresholds. A heartbeat is "fresh" if the job's last success is
// within maxAgeMin. A MISSING row is treated as not-yet-observed (fresh deploy
// that hasn't run the cron), NOT a failure — we only fail on a job seen before
// that has since gone stale. Schedules: send-daily hourly (0 * * * *);
// pull-trends-cron daily (0 5 * * *).
// ONLY list a job here on the day it is actually scheduled: a missing heartbeat row scores
// as "not yet observed" = pass, so an unscheduled job listed here is a check that is
// permanently green and can never fail — the same class as the old `!!(env || true)`
// cost-cap probe. (The auto-publish cron used to sit here; it and its endpoint are gone.)
const CRON_JOBS = [
  { job: 'send-daily',       maxAgeMin: 180 },   // hourly → stale after 3h
  { job: 'pull-trends-cron', maxAgeMin: 1560 },  // daily  → stale after 26h
];

// Live route reachability. Probed with an UNAUTHENTICATED GET against the public
// site (APP_BASE_URL, default prod). We can't run a real signup/generation from a
// public endpoint without seeding prod data, so this proves the critical routes
// are DEPLOYED and FAIL CLOSED — not that a full flow succeeds.
//   mode 'ok'       → must return 200 (the app shell must actually serve)
//   mode 'deployed' → must return a real response that ISN'T 404 or 5xx
//                     (200/400/401/405 all mean "route is live & guarded";
//                      404 = route missing/renamed, 5xx = handler crashes on load)
const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://contentshrimp.com').replace(/\/$/, '');
// "Open app" path: the shell + the endpoints app.html calls on load.
const OPEN_APP_ROUTES = [
  { path: '/app.html',       mode: 'ok' },
  { path: '/api/usage',      mode: 'deployed' },
  { path: '/api/push-key',   mode: 'deployed' },
];
// New-user onboarding path: the endpoints the signup wizard depends on.
const ONBOARDING_ROUTES = [
  { path: '/api/crawl-brand',      mode: 'deployed' },
  { path: '/api/distill-voice',    mode: 'deployed' },
  { path: '/api/generate-ideas',   mode: 'deployed' },
  { path: '/api/brand-voice-chat', mode: 'deployed' },
  { path: '/api/people-also-ask',  mode: 'deployed' },
];

// Probe one route; returns { status } (HTTP code) or { status: null } if it
// couldn't be reached at all (timeout/DNS) — ambiguous, so callers don't fail on it.
async function probe(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(APP_BASE_URL + path, { method: 'GET', redirect: 'manual', signal: ctrl.signal });
    return { status: r.status };
  } catch (_) {
    return { status: null };
  } finally {
    clearTimeout(timer);
  }
}

// A route "passes" if we got a definite good signal. Null (unreachable) does NOT
// fail — same philosophy as cron liveness: only fail on a real bad response.
function routeOk(mode, status) {
  if (status == null) return true;                     // couldn't probe → don't fail
  if (mode === 'ok') return status === 200;            // shell must serve
  return status !== 404 && status < 500;               // deployed & fail-closed
}

// Probe both route groups in parallel and roll each up into one boolean.
// Returns { results:[{key,ok}], meta:{path:status} }; never throws, so it is safe
// to sit inside the same Promise.allSettled as the database reads.
async function probeRouteGroups() {
  const meta = {};
  const groups = [
    { key: 'open_app_routes_ok',   routes: OPEN_APP_ROUTES },
    { key: 'onboarding_routes_ok', routes: ONBOARDING_ROUTES },
  ];
  const results = await Promise.all(groups.map(async g => {
    const statuses = await Promise.all(g.routes.map(async rt => {
      const { status } = await probe(rt.path);
      meta[rt.path] = status;
      return routeOk(rt.mode, status);
    }));
    return { key: g.key, ok: statuses.every(Boolean) };
  }));
  return { results, meta };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const checks = [];
  const add = (name, ok) => checks.push({ name, ok: !!ok });

  // ── Config presence (booleans only — never the values) ──────────────────────
  add('config_supabase', !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY));
  add('config_llm_key', !!process.env.XAI_API_KEY); // Grok only: GROQ is Whisper dictation, it cannot write text
  // Granular key presence (booleans only). XAI = all text (Grok); GROQ = Whisper
  // dictation; OPENAI = TTS speak-back. Gemini image keys are per-brand, not env.
  add('config_xai_key', !!process.env.XAI_API_KEY);
  add('config_groq_key', !!process.env.GROQ_API_KEY);
  add('config_openai_key', !!process.env.OPENAI_API_KEY);
  add('config_cron_secret', !!process.env.CRON_SECRET);
  // Was `!!(process.env.COST_CAP_EUR || true)` — always true, so it could never fail
  // and its "defaults to 10" comment was stale. Now it reports the real state: the
  // fuse is armed only when the effective cap (default 25 in _usage.js) is > 0, so
  // setting COST_CAP_EUR=0 to disable it makes this check go red, as it should.
  add('config_cost_cap', (Number(COST_CAP_EUR) || 0) > 0);

  // Keys whose absence is SILENT in the product — the feature just quietly returns nothing, so
  // without a check here nobody ever finds out. (stock-photo answers 200 {empty:true} on every
  // failure; the X trends lane returns [] with no token; Stripe checkout needs live price IDs.)
  add('config_pexels_key', !!process.env.PEXELS_API_KEY);        // no key ⇒ split-screen beats render text-only
  // v668: SerpAPI had NO check here at all, despite being exactly the kind this block is for.
  // Without a key /api/people-also-ask answers 500 on every call and "Real questions people ask"
  // is dead — a whole panel, with nothing anywhere saying why.
  add('config_serpapi_key', !!process.env.SERPAPI_KEY);          // no key ⇒ "Real questions people ask" is dead
  add('config_apify_token', !!process.env.APIFY_API_TOKEN);      // no token ⇒ X/Twitter trends lane silently empty
  add('config_stripe_prices', !!(process.env.STRIPE_PRICE_PRO && process.env.STRIPE_PRICE_AGENCY));

  // ── Live posture + DB + crons + routes: probed CONCURRENTLY ─────────────────
  // These four blocks used to run one after another. Three sequential store.rest calls
  // at REQ_TIMEOUT_MS (8s each) plus the 8s route probes is 32s of worst case against a
  // maxDuration of 20 — measured at 34s with a stalled Supabase. The platform kills the
  // function and the daily monitor gets NOTHING back, which is the one failure mode a
  // monitor must not have: silence reads the same as "never ran". Probed together, the
  // worst case is a single 8s window.
  const [isoR, dbR, hbR, routeR] = await Promise.allSettled([
    store.rest('POST', '/rpc/security_health', { body: {} }),
    store.rest('GET', '/brands?select=id&limit=1'),
    store.rest('GET', '/job_heartbeats?select=job,last_success_at,last_status'),
    probeRouteGroups(),
  ]);
  const settled = (r) => (r.status === 'fulfilled' ? r.value : null);

  // ── Live account-isolation posture (via security_health() RPC) ──────────────
  // store.rest RESOLVES on every HTTP status, so a PostgREST ERROR BODY — a plain
  // object like {code:'PGRST202', message:'Could not find the function ...'} — used to
  // satisfy `h && typeof h === 'object'`. None of the audit's arrays were present, each
  // defaulted to [], and .length === 0 scored GREEN. Measured: with the RPC answering
  // 404, five live security claims — RLS enabled everywhere, no permissive policies, no
  // permissive writes, no unexpected deny-all tables, every brand table bound to its
  // caller — were all reported as passing, from a response that contained none of them.
  // A monitor that invents five green safety facts out of a database error is worse than
  // no monitor. The audit must now PROVE it answered: HTTP 200, the membership boolean,
  // and all five arrays actually present as arrays. Anything else is 'unverified', which
  // is the truthful word, and the checks it would have made are not added at all.
  const isolationOf = (r) => {
    if (!r) return { state: 'unreachable', h: null };
    if (r.status !== 200) return { state: 'http-' + r.status, h: null };
    // PostgREST returns a bare object for a scalar-returning function and a ONE-ROW ARRAY for a
    // set-returning one. Unwrap the single-row case rather than calling a working audit malformed.
    let h = r.data;
    if (Array.isArray(h) && h.length === 1 && h[0] && typeof h[0] === 'object') h = h[0];
    if (!h || typeof h !== 'object' || Array.isArray(h)) return { state: 'not-an-object', h: null };
    if (typeof h.has_user_brand_ids !== 'boolean') return { state: 'not-an-audit', h: null };
    /* v684b — NAME THE MISSING KEYS. The live answer was 'unexpected-shape', which is true and
       useless: it does not distinguish "the database is broken" from "the deployed function is
       older than sql/health-check.sql". Every array in that file is
       coalesce(jsonb_agg(...), '[]'::jsonb), so a CURRENT function can never omit one — a missing
       key means the deployed function predates the key. Under v682 each missing key silently
       defaulted to [] and scored GREEN, so the checks it should have made were never made at all.
       Key names are not sensitive: they are in this repo and in sql/health-check.sql. */
    const missing = AUDIT_ARRAY_KEYS.filter(k => !Array.isArray(h[k]));
    if (missing.length) return { state: 'stale-function, missing: ' + missing.join(','), h: null };
    return { state: 'ok', h };
  };
  let iso = { state: 'unreachable', h: null };
  try { iso = isolationOf(settled(isoR)); } catch (e) { iso = { state: 'unreadable', h: null }; }
  // Belt and braces behind the shape check above: a monitor that throws is a monitor that says
  // NOTHING, and silence from a monitor reads exactly like a monitor that was never scheduled.
  // Proved necessary — loosening the shape check made this block throw a TypeError and 500 the
  // whole endpoint on a payload that merely lacked a key.
  try {
  if (iso.h) {
    const h = iso.h;
    const zeroPol = h.zero_policy_tables.filter(t => !ZERO_POLICY_ALLOWED.includes(t));
    add('rls_all_tables_enabled', h.rls_disabled.length === 0);
    add('no_permissive_brand_policies', h.permissive_policies.length === 0);
    add('no_permissive_write_policies', h.permissive_write_policies.length === 0);
    add('no_unexpected_denyall_tables', zeroPol.length === 0);
    add('brand_tables_bound_to_caller', h.unbound_brand_tables.length === 0);
    add('membership_function_present', h.has_user_brand_ids === true);
    // user_brand_ids_secure only present in v2 SQL; if absent (older SQL), don't fail.
    if (h.user_brand_ids_secure !== undefined) add('membership_function_secure', h.user_brand_ids_secure === true);
    add('isolation_audit_reachable', true);
  } else {
    add('isolation_audit_reachable', false);
    // Say WHY. "Unverified" without a reason is only half an improvement over the old lie:
    // 'http-404' (the function is not in this database), 'http-401'/'http-403' (the grant is
    // wrong), 'unexpected-shape' (it answered, but not with an audit) and 'unreachable' (the
    // call never completed) each send you somewhere different. The state is a fixed string,
    // never a response body, so it leaks nothing — the same class as the route statuses below.
    console.error('health: isolation audit did not run — ' + iso.state);
  }
  } catch (e) {
    console.error('health: isolation block threw — ' + ((e && e.message) || e));
    if (!checks.some(c => c.name === 'isolation_audit_reachable')) add('isolation_audit_reachable', false);
    iso = { state: 'threw' };
  }

  // ── DB reachable (simple read) ──────────────────────────────────────────────
  const dbRow = settled(dbR);
  add('db_reachable', !!dbRow && dbRow.status < 400);

  // ── Cron liveness (via job_heartbeats) ──────────────────────────────────────
  // Fails only when a job HAS a heartbeat that is now stale (ran before, then
  // died). A missing heartbeat = not-yet-observed and does not fail. meta.crons
  // exposes ages (minutes, or null if never seen) — timestamps only, nothing
  // sensitive — so the daily report can note "never observed" jobs.
  const cronMeta = {};
  const hb = settled(hbR);
  // Heartbeats table unreachable — an INFRA error, not a dead cron. Kept as a pass so a
  // Supabase blip cannot masquerade as "your crons are down", but meta now says which of the
  // two happened: 'never-run' (the job) vs 'unreadable' (the table). Previously both were
  // null and indistinguishable, so a broken monitor looked exactly like a broken cron.
  if (!hb || hb.status >= 400 || !Array.isArray(hb.data)) {
    console.error('health: job_heartbeats unreadable');
    for (const { job } of CRON_JOBS) { cronMeta[job] = 'unreadable'; add('cron_' + job + '_fresh', true); }
  } else {
    const byJob = Object.create(null);
    for (const row of hb.data) byJob[row.job] = row;
    const now = Date.now();
    for (const { job, maxAgeMin } of CRON_JOBS) {
      const row = byJob[job];
      if (!row || !row.last_success_at) {
        // WAS A PASS. "Never observed" was treated as a fresh deploy that hasn't run yet — but a
        // heartbeat row SURVIVES deploys, so it is only ever absent if the job has never once
        // completed. For a cron that has been scheduled for months that is not benign, it is the
        // loudest signal there is, and scoring it green is exactly how a cron died daily for
        // seven days here without anyone noticing. A newly-added cron is red until its first
        // successful run, which is honest: it is genuinely unverified until then.
        cronMeta[job] = 'never-run';
        add('cron_' + job + '_fresh', false);
        continue;
      }
      const ageMin = Math.round((now - new Date(row.last_success_at).getTime()) / 60000);
      // A cron that RAN but did its work badly used to be invisible here: we only ever checked
      // how OLD the heartbeat was, never what it SAID. So a run that reported 'error' (every
      // write failed) or 'partial' (ran out of budget, some users missed) scored green purely
      // for being recent. Status is now part of the verdict.
      const status = row.last_status || 'ok';
      cronMeta[job] = { ageMin, status };
      add('cron_' + job + '_fresh', ageMin <= maxAgeMin && status === 'ok');
    }
  }

  // ── Live route reachability: open-app + onboarding paths ────────────────────
  // Rolled up into two booleans (so the report stays readable); meta.routes maps
  // each probed path to its HTTP status (or null) so a failure shows exactly which
  // route and code broke.
  const routes = settled(routeR);
  const routeMeta = (routes && routes.meta) || {};
  if (routes) for (const r of routes.results) add(r.key, r.ok);

  // ── Live Grok reachability (opt-in, spends ONE tiny Grok token) ─────────────
  // GET /api/health?ping=1 with a signed-in user's Bearer token actually calls Grok
  // and reports ok + round-trip ms. Gated on a real user so the public poll can't
  // burn tokens. Powers the Settings "Check AI status" button.
  let grok = null; // null = not tested this request
  if (req.query && (req.query.ping === '1' || req.query.ping === 'true')) {
    try {
      // METERED like every other call site that spends on a real model. It used to sit behind
      // the Bearer check ALONE — no guard(), no logUsage(), and no weight in either map — so a
      // signed-in free account could loop it: `used` never moved, the cost fuse never saw the
      // spend, and the burst limiter (which counts logged rows) could never fire.
      // guard() is used instead of a bare getUser so the plan limit and the fuse both apply;
      // it is scoped to THIS branch only, so the plain GET the crons and the app poll stays
      // public, unauthenticated and free, and /api/health still always answers 200.
      const _g = await require('./_usage').guard(req, 'healthping', res);
      if (!_g.user) {
        grok = { ok: null, reason: 'sign in to run the live check' };
      } else if (_g.over) {
        grok = { ok: null, reason: 'the live check is metered — you are out of credits this period' };
      } else {
        const t0 = Date.now();
        let text = null;
        try { text = await callLLM({ deadlineMs: 25000, timeoutMs: 12000, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: 5, temperature: 0 }); } catch (e) {}
        grok = { ok: !!(text && String(text).trim()), ms: Date.now() - t0 };
        // Logged on the ATTEMPT, not on success: the token is spent either way, and a provider
        // that fails fast is exactly the case an attacker would loop.
        await require('./_usage').logUsage({ userId: _g.billingUserId || _g.user.id, action: 'healthping', model: 'grok' });
        add('grok_live', grok.ok);
      }
    } catch (e) {
      grok = { ok: false, reason: 'ping failed' };
      add('grok_live', false);
    }
  }

  const failing = checks.filter(c => !c.ok).map(c => c.name);
  const ok = failing.length === 0;
  return res.status(200).json({
    build: (function(){ try { return require('./_build'); } catch(_) { return 'unstamped'; } })(),
    ok,
    checkedAt: new Date().toISOString(),
    passed: checks.length - failing.length,
    total: checks.length,
    failing,           // check NAMES only — no sensitive detail
    checks,
    meta: { crons: cronMeta, routes: routeMeta, grok, isolation: iso.state } // ages (min) + route statuses + live Grok ping + why the audit did or did not run
  });
};
