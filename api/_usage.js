// Usage metering, trial state, and plan-limit checks.
// DESIGN RULE: fail-open. If anything here errors (DB down, bad data), we return
// { ok: true } so a metering bug can NEVER block content generation. Billing is
// less important than the app working.
const https = require('https');

// ── Config (tune freely; user-facing unit is "credits" ≈ "posts") ──────────────
const PLAN_LIMITS = {
  trial:   150,   // full-access allowance during the 7-day trial (~Pro rate: 750/mo × 7d ≈ 175, rounded down)
  free:    40,    // post-trial floor — daily habit stays alive (~1-2 posts/day), advanced tools locked
  starter: 200,   // ~7/day
  pro:     750,   // ~25/day
  agency:  2500   // high-volume / teams
};
const TRIAL_DAYS = 7;   // v470: was 21 — Jörgen: "21 days too long, 7 is ok". Trial = Pro-level access; Agency has no trial (copy-level).

// Tools that are PAID-only once the trial ends. The free plan keeps the daily
// creation loop (quick post / ideas / remix / viral / notebook); these are the
// heavy "grow" tools. Trial + starter/pro/agency are never blocked by this.
const FREE_LOCKED_ACTIONS = { blog: 1, meme: 1, brandimage: 1 };

// Weight heavier actions as more "credits" (the user-facing post budget).
//
// NOTHING MAY BE REGISTERED AT 0. A 0-credit action can never increment `used`, so it
// can never trip its own plan limit — it is infinitely callable on every plan, forever.
// Thirteen actions were registered at 0 (the "utility / input-aid" tier), including the
// three most expensive per-call things the app does: OpenAI TTS (`speak`), a 5-search
// SerpAPI pull (`paa`), and paid Apify actor runs (`crawlsocial` / `pulltrends`). One
// free signup could call any of them without bound. Fractional weights preserve the
// original intent — ordinary use of a cheap helper must not burn a user's post budget —
// while keeping every action inside the plan ceiling.
//
// Weights are ROUGHLY PROPORTIONAL TO WHAT THE CALL COSTS US:
//   3     multi-page crawl + web search + 2 LLM calls (the heaviest single call we make)
//   2     a paid third-party run (Apify actor / SerpAPI multi-search) + an LLM pass
//   1     one expensive provider call (OpenAI TTS, up to 4000 chars)
//   0.5   one ordinary LLM/audio call
//   0.25  one small LLM call, or a single plain page fetch with no LLM
//   0.1   a cheap keyless lookup that fires in bulk (~6 stockphoto calls per video render)
const ACTION_CREDITS = {
  ideas: 1, quickpost: 1, meme: 1, remix: 1, viral: 1, expand: 1, beats: 1,
  blog: 3, transcribe: 2, brandimage: 1,
  image: 2, imageedit: 2, transcribeurl: 2,
  // ── formerly 0 (see the note above) ────────────────────────────────────────
  crawlbrand: 3,          // <=10 page fetches + a Grok web search + 2 Grok calls, 300s budget
  crawlsocial: 2,         // paid Apify actor run (up to 40 posts) + an LLM voice extraction
  pulltrends: 2,          // Apify + Grok web search + News RSS
  creatorposts: 2,        // manual-only Apify run per platform over the brand's bookmarked creators
  paa: 2,                 // up to 5 SerpAPI searches (real quota) + an LLM relevance pass
  listen: 2,              // Apify (no live caller today — registered so a revival is not a hole)
  inspiration: 2,         // Exa/Apify (same)
  speak: 1,               // OpenAI TTS, up to 4000 chars — the highest cost-per-call in the app
  transcribevoice: 0.5,   // Groq whisper on a short dictation clip
  voicechat: 0.5,         // one Grok call carrying the whole brand snapshot
  searchimages: 0.5,      // an image search call
  distill: 0.25,          // small Grok call, AUTO-fired by the app — must not eat an allowance
  healthping: 0.25,       // /api/health?ping=1 — one 5-token Grok call behind a Bearer check. It
                          // was in NEITHER map and called guard()/logUsage() not at all, so a
                          // signed-in free account could loop the real model unmetered.
  settingsexamples: 0.25, // one small "make it better" Grok call
  crawlgdoc: 0.25,        // RETIRED v636 (Master Prompt feature removed). Kept registered so a
                          // stray caller is priced, not defaulted to 1 credit as an unknown action.
  extractarticle: 0.25,   // one page fetch + regex extraction, no LLM
  stockphoto: 0.1,        // keyless Pexels lookup; ~6 fire in parallel per video render
  hookframe: 1,           // was unregistered (defaulted to 1) — pinned so it cannot drift to 0
  // TWO sequential LLM calls (critique at 700 tokens, then a rewrite at 2500), so it costs more
  // than any single-call action. It was in NEITHER map — the only guard() action in the whole API
  // that was missing from both — so it silently defaulted to 1 credit / €0.01 and the fuse
  // under-counted it. 2 x "one ordinary LLM call" (0.5) = 1, which is what the default happened
  // to be; the point is that it is now REGISTERED, so re-weighting it is a one-line change and
  // the gate can see it.
  sharpen: 1
};
function creditsFor(action) {
  return ACTION_CREDITS[action] != null ? ACTION_CREDITS[action] : 1;
}

// ── Cost fuse (ARMED by default) ───────────────────────────────────────────────
// A last-resort circuit-breaker on estimated provider spend, for NON-PAYING accounts
// only (trial/free) — a paying customer must never be cut off by a fuse.
//
// It used to default to 0 = permanently off, on the reasoning that image generation had
// moved to each user's own Gemini key so the app had no real spend vector left. That was
// true of IMAGE cost specifically and wrong as a general safety valve: it left the one
// control designed for runaway spend switched off, depending on an env var nobody set.
//
// €25 is deliberately far above anything a legitimate account can reach. The most
// expensive credit in the table is ~€0.05/credit, so a trial (150 credits) tops out
// around €8 and a free account (40) around €2 — a legitimate heavy user can never see
// this. It exists to catch a future action that slips through with a wrong weight.
// Override with COST_CAP_EUR in the env; set it to 0 to disable entirely.
const COST_CAP_EUR = process.env.COST_CAP_EUR != null && process.env.COST_CAP_EUR !== ''
  ? Number(process.env.COST_CAP_EUR) || 0
  : 25;

// ── Burst limit ────────────────────────────────────────────────────────────────
// Nothing in the app rate-limited anything. The credit ceiling above is the real bound
// on total spend; this caps how FAST one account can spend it, so a script cannot empty
// an allowance (or hammer a provider's rate limits) in a few seconds.
// Counted from logged usage rows, so it is a floor not a ceiling — concurrent in-flight
// calls are not yet logged and therefore not yet counted. It still stops sustained abuse.
// 60/min is ~6x the largest legitimate burst in the app (a video render fires 6 parallel
// stockphoto lookups plus a beats call), so a real user cannot trip it.
const RATE_LIMIT_PER_MIN = process.env.RATE_LIMIT_PER_MIN != null && process.env.RATE_LIMIT_PER_MIN !== ''
  ? Number(process.env.RATE_LIMIT_PER_MIN) || 0
  : 60;
const RATE_WINDOW_MS = 60000;

const ACTION_COST = {
  stockphoto: 0.001,
  crawlgdoc: 0.001, extractarticle: 0.001, hookframe: 0.01,
  // cheap text (Grok/Groq)
  ideas: 0.006, quickpost: 0.006, meme: 0.006, remix: 0.008, viral: 0.008, beats: 0.006,
  expand: 0.005, blog: 0.02, distill: 0.006, voicechat: 0.006, searchimages: 0.01, brandimage: 0.003, settingsexamples: 0.004,
  // paid search quota — one PAA call issues up to 5 SerpAPI searches, not one
  paa: 0.05,
  // audio
  transcribe: 0.02, transcribeurl: 0.06, transcribevoice: 0.02, speak: 0.02,
  // images (our OpenAI spend — the real money)
  image: 0.10, imageedit: 0.10,
  // third-party scraping/search compute (Apify / Exa)
  crawlsocial: 0.05, listen: 0.05, inspiration: 0.05, crawlbrand: 0.08,
  // was 0 "free — Google News RSS": the lane also runs a paid Apify search and a Grok
  // web search now, so a 0 here understated it to the fuse.
  pulltrends: 0.05,
  // Higher than pulltrends because bookmarks skew TikTok, and TikTok video scraping runs
  // ~$2-3.10/1k results against ~$0.15-0.40/1k for tweets. Manual-only, so it fires rarely.
  creatorposts: 0.08,
  // Two Grok calls, the second with a 2500-token budget — ~2.5x a single `ideas` call.
  sharpen: 0.015,
  // One 5-token, temperature-0 Grok reply — the smallest real model call in the app.
  healthping: 0.002
};
function costFor(action) {
  return ACTION_COST[action] != null ? ACTION_COST[action] : 0.01;
}

// ── Supabase REST helper (service role — bypasses RLS) ─────────────────────────
// CONVENTION: every value interpolated into a PostgREST path is encodeURIComponent'd.
// Not currently exploitable (PostgREST ANDs repeated params, so an injected filter can
// only narrow a result set, never broaden it, and Node rejects control chars in a path)
// — but ids reach these strings from request bodies, so they get encoded like any other
// untrusted value rather than relying on that reasoning holding forever.
//
// A STALL IS NOT AN ERROR — and every safety net in this file is built on errors.
// The fail-open design at the top of the file only fires when sbRequest REJECTS
// (checkLimit's catch, getStatus's catch, logUsage's swallow, setPlan's console.error).
// With no timeout, a Supabase that accepts the socket and then goes quiet never rejects,
// so guard() — which runs on EVERY authenticated endpoint — simply waits until the
// platform kills the function: no response body, no log line, nothing to diagnose. The
// fail-open net never fires because nothing ever rejects. This timeout turns that silence
// back into an ordinary rejection the existing catches already handle correctly.
//
// WHY 8s, and why the number is COMPUTED rather than chosen: this timeout is shared while the
// budget is per-endpoint, so it is only safe if it fits the tightest endpoint that can reach it.
// scripts/verify/timeout-budgets.mjs derives that floor from vercel.json and fails if the default
// no longer fits — do not raise this by hand and hope. The floor was 10s, held there by five
// endpoints that reached Supabase while ABSENT from the functions map (the same blind spot that
// hid extract-article.js from the v606 audit and cost v627 a second miss). v637 declared them, the
// floor rose to 20s, and this doubled.
//   one stalled call  = 8s of 20s, leaving room to return the fail-open answer
//   worst real chain  = auth healthy but PostgREST stalled → checkLimit times out, then
//                       userCanAccessBrand times out = 16s, still inside 20s
// Node's request.setTimeout is a socket INACTIVITY timer, so a slow-but-streaming response never
// trips it — 8s of total silence against a ~100-300ms healthy PostgREST round trip is only ever a
// stall, never a slow query. Callers with real headroom raise it further via setRequestBudget().
let SB_TIMEOUT_MS = 8000;

// See store.setRequestBudget — same contract, same clamp, same per-function-instance safety.
function setRequestBudget(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return SB_TIMEOUT_MS;
  SB_TIMEOUT_MS = Math.max(4000, Math.min(60000, Math.round(n)));
  return SB_TIMEOUT_MS;
}

// opts.withHeaders — resolve { body, headers, status } instead of the parsed body alone.
// Needed because PostgREST reports the TRUE row count only in the Content-Range response
// header (with `Prefer: count=exact`); without it a truncated page is indistinguishable
// from a complete one. Every existing caller passes no opts and is unaffected.
function sbRequest(method, path, body, extraHeaders, opts) {
  const withHeaders = !!(opts && opts.withHeaders);
  return new Promise((resolve, reject) => {
    const base = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!base || !key) return reject(new Error('Supabase env not configured'));
    const u = new URL(base);
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: u.hostname, path, method,
      headers: Object.assign({
        'apikey': key,
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json'
      }, extraHeaders || {})
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const r = https.request(opts, resp => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => {
        if (resp.statusCode >= 400) return reject(new Error('Supabase ' + resp.statusCode + ': ' + d));
        let parsed = null;
        try { parsed = d ? JSON.parse(d) : null; } catch (_) { parsed = null; }
        if (withHeaders) return resolve({ body: parsed, headers: resp.headers || {}, status: resp.statusCode });
        resolve(parsed);
      });
    });
    r.on('error', reject);
    // Same shape as httpsPost in api/_llm.js — destroy(err) makes the request emit 'error',
    // which the reject above already handles. Logged because a stall is currently invisible:
    // it is the one failure mode that produces no status, no body and no trace anywhere.
    r.setTimeout(SB_TIMEOUT_MS, () => {
      console.error('sbRequest TIMEOUT after ' + SB_TIMEOUT_MS + 'ms — ' + method + ' ' + path +
        ' (Supabase accepted the connection then went quiet; metering fails open)');
      r.destroy(new Error('Supabase request timed out after ' + SB_TIMEOUT_MS + 'ms: ' + method + ' ' + path));
    });
    if (data) r.write(data);
    r.end();
  });
}

// ── The usage window ──────────────────────────────────────────────────────────
// The calendar month is the FALLBACK, not the rule. It was the only period computation
// in the file and it took no account of when the plan actually started, which broke both
// ends of the money path:
//   trial — a 7-day trial started on the 28th got 150 credits for 3 days and a fresh 150
//           on the 1st: up to 300 on a 150-credit trial.
//   paid  — a customer billed on the 15th had their allowance reset on the 1st, 14 days
//           early, every single month.
// Now the window rolls from the plan's real anchor, and falls back to the calendar month
// whenever that anchor is missing or unusable — so a row with no dates behaves exactly as
// it did before this change.
function calendarMonthStartISO(nowMs) {
  const now = new Date(nowMs == null ? Date.now() : nowMs);
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}
// Kept under its original name — it is exported and is the documented fallback.
function periodStartISO() { return calendarMonthStartISO(Date.now()); }

const PAID_PLANS = { starter: 1, pro: 1, agency: 1 };
// A trial window longer than this is not a trial any more (a hand-extended row, a clock
// skew); fall back to the calendar month rather than freezing one allowance forever.
const MAX_TRIAL_WINDOW_MS = 62 * 86400000;

// The most recent occurrence, at or before `nowMs`, of the day-of-month implied by `anchorIso`.
// Works whether the anchor is in the future (a live current_period_end) or the past (a stale
// one), and clamps a 29th/30th/31st anchor into short months.
function anniversaryStartISO(anchorIso, nowMs) {
  const a = new Date(anchorIso);
  const t = a.getTime();
  if (!Number.isFinite(t)) return null;
  const day = a.getUTCDate(), h = a.getUTCHours(), mi = a.getUTCMinutes(), s = a.getUTCSeconds();
  const mk = (y, m) => {
    const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return Date.UTC(y, m, Math.min(day, daysInMonth), h, mi, s);
  };
  const now = new Date(nowMs);
  let y = now.getUTCFullYear(), m = now.getUTCMonth();
  let start = mk(y, m);
  if (start > nowMs) { m -= 1; if (m < 0) { m = 11; y -= 1; } start = mk(y, m); }
  return new Date(start).toISOString();
}

// The period start that applies to a given user_plans row. Pure — takes the row and a clock,
// so it is directly testable. NEVER throws: any bad input degrades to the calendar month.
function periodStartForRow(row, now) {
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  try {
    const plan = effectivePlan(row);
    if (plan === 'trial') {
      let startIso = row && row.trial_started_at;
      if (!startIso && row && row.trial_ends_at) {
        const e = Date.parse(row.trial_ends_at);
        if (!isNaN(e)) startIso = new Date(e - TRIAL_DAYS * 86400000).toISOString();
      }
      const s = startIso ? Date.parse(startIso) : NaN;
      if (!isNaN(s) && s <= nowMs && (nowMs - s) <= MAX_TRIAL_WINDOW_MS) return new Date(s).toISOString();
      return calendarMonthStartISO(nowMs);
    }
    if (PAID_PLANS[plan] && row && row.current_period_end) {
      const iso = anniversaryStartISO(row.current_period_end, nowMs);
      if (iso) return iso;
    }
    // v657 — FREE GETS A ROLLING WINDOW TOO, not the calendar month.
    // Trial and paid plans each had a real window; `free` fell through to the 1st of the
    // month. So the instant a trial expired or a subscription was cancelled, that entire
    // month's trial/Pro spend (150-750 credits) was re-scored against the 40-credit free
    // limit — leaving the account hard-blocked for the rest of the month. A trial started
    // on the 1st meant ~23 consecutive dead days, landing exactly on the upgrade decision,
    // and the UI could not even render it ("Free plan · 150 / 40 posts this month").
    // _usage.js's own design note calls free "the post-trial floor — daily habit stays alive".
    // The window now starts whenever the previous plan ENDED (trial_ends_at, or the paid
    // period end), and rolls monthly from there, so the free allowance is genuinely fresh.
    if (plan === 'free' && row) {
      const ended = Date.parse(row.current_period_end || row.trial_ends_at || '');
      if (!isNaN(ended) && ended <= nowMs) {
        // roll forward in whole months from the end of the last paid/trial period
        let start = ended;
        while (start + 30 * 86400000 <= nowMs) start += 30 * 86400000;
        return new Date(start).toISOString();
      }
    }
    return calendarMonthStartISO(nowMs);
  } catch (e) {
    return calendarMonthStartISO(nowMs);
  }
}

// Fetch the user's plan row, creating a fresh trial row on first ever call.
// SELECT * on purpose: the period computation needs current_period_end and trial_started_at,
// and an explicit column list couples this query to the table's exact schema — one missing
// column makes PostgREST answer 400, which lands in getStatus's catch and silently switches
// metering OFF for everyone (fail-open). `*` is one internal row and cannot 400 that way.
async function getOrInitPlan(userId) {
  const rows = await sbRequest('GET',
    `/rest/v1/user_plans?user_id=eq.${encodeURIComponent(userId)}&select=*`);
  if (Array.isArray(rows) && rows.length) return rows[0];
  // First touch → start their trial. ignore-duplicates guards against a race.
  //
  // v639: trial_ends_at is now written EXPLICITLY from TRIAL_DAYS. It used to be left to the
  // column default, which still read `now() + '21 days'` — so when v470 changed TRIAL_DAYS 21 → 7
  // the constant changed and the actual trial did not. effectivePlan() decides expiry solely from
  // this column, and TRIAL_DAYS was referenced by nothing but a gate asserting it exists, so every
  // signup silently got 21 days while the app, the pricing page and this file all said 7.
  // Writing it here makes the constant authoritative; the column default is now only a fallback.
  const _ends = new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString();
  await sbRequest('POST', `/rest/v1/user_plans?on_conflict=user_id`,
    { user_id: userId, trial_ends_at: _ends },
    { 'Prefer': 'resolution=ignore-duplicates,return=minimal' });
  const again = await sbRequest('GET',
    `/rest/v1/user_plans?user_id=eq.${encodeURIComponent(userId)}&select=*`);
  return (Array.isArray(again) && again[0]) || { plan: 'trial', trial_ends_at: null };
}

// The plan that actually applies right now (an expired trial behaves as 'free').
function effectivePlan(row) {
  const plan = (row && row.plan) || 'trial';
  if (plan === 'trial') {
    const ends = row && row.trial_ends_at ? new Date(row.trial_ends_at) : null;
    if (ends && Date.now() > ends.getTime()) return 'free';
    return 'trial';
  }
  return PLAN_LIMITS[plan] != null ? plan : 'free';
}

function limitFor(plan) {
  return PLAN_LIMITS[plan] != null ? PLAN_LIMITS[plan] : PLAN_LIMITS.free;
}

// Sum BOTH the credit usage (posts) and the estimated € cost for the current
// period in a single query. Cost is derived from each row's action, so no schema
// change is needed.
// CREDITS ARE RECOMPUTED FROM `action`, not read from the stored `credits` column —
// exactly as `cost` already was. Two reasons:
//   1. ACTION_CREDITS becomes the single source of truth, so re-weighting an action
//      takes effect immediately instead of only for rows written after the change.
//   2. It decouples accounting from the column's SQL type. Weights are now fractional,
//      and if that column is an integer, POSTing 0.25 would make Postgres reject the
//      insert — which logUsage swallows silently, so metering would just stop. The
//      column is written rounded (see logUsage) and nothing reads it for billing.
// This is the ONLY reader of usage_events, so nothing else is affected.
//
// THE READ IS PAGINATED AND ORDERED, and both of those are load-bearing.
// This used to be one plain unbounded GET. PostgREST silently truncates every response at
// `db-max-rows` (default 1000) — a server setting no application code can raise — so:
//   * the biggest credit total this function could EVER compute was ~1000 (almost every
//     weight is <= 1), which is BELOW the agency limit of 2500. That limit was unreachable.
//   * with no `order=`, PostgREST returns the OLDEST rows first, so past 1000 rows/month not
//     one returned row was inside the 60-second burst window and the burst limiter stopped
//     firing too.
// Fixed with `order=created_at.desc` (newest first, so the burst window is correct at any row
// count) + `Prefer: count=exact` (the true total arrives in Content-Range) + offset paging.
const USAGE_PAGE_MAX = 1000;   // asks for a full PostgREST page; the server may return fewer
const USAGE_MAX_PAGES = 25;    // 25k rows — far beyond any legitimate month, and bounded

function contentRangeTotal(h) {
  const v = h && (h['content-range'] || h['Content-Range']);
  if (!v) return null;
  const m = String(v).match(/\/(\d+)\s*$/);   // "0-999/5123" → 5123 ("*/…" or "…/*" → null)
  return m ? Number(m[1]) : null;
}

async function usageThisPeriod(userId, periodStart) {
  const startIso = periodStart || periodStartISO();
  const base = `/rest/v1/usage_events?user_id=eq.${encodeURIComponent(userId)}` +
    `&created_at=gte.${encodeURIComponent(startIso)}&select=action,created_at&order=created_at.desc`;
  let credits = 0, cost = 0, recent = 0, seen = 0, total = null, complete = false;
  const since = Date.now() - RATE_WINDOW_MS;
  for (let page = 0; page < USAGE_MAX_PAGES; page++) {
    const r = await sbRequest('GET', `${base}&offset=${seen}&limit=${USAGE_PAGE_MAX}`, null,
      { 'Prefer': 'count=exact' }, { withHeaders: true });
    const rows = r && Array.isArray(r.body) ? r.body : [];
    if (total == null) total = contentRangeTotal(r && r.headers);
    for (const row of rows) {
      credits += creditsFor(row.action);
      cost += costFor(row.action);
      // Burst counter, derived from the rows we already have — costs no extra round trip.
      // Correct at any row count now that the newest rows come back first.
      const t = row.created_at ? Date.parse(row.created_at) : NaN;
      if (!isNaN(t) && t >= since) recent++;
    }
    seen += rows.length;
    // Stop on an empty page (always correct, whatever the server's page size turns out to be)
    // or as soon as the exact count says we have everything (the common case: one request).
    if (!rows.length) { complete = true; break; }
    if (total != null && seen >= total) { complete = true; break; }
  }
  if (!complete) {
    // A truncated read must never look like low usage. The count we DID accumulate is already
    // far above every plan limit, so checkLimit blocks rather than waving the user through —
    // but the reason has to be findable, so say it out loud.
    console.error('usageThisPeriod INCOMPLETE — user=' + userId + ' read ' + seen + ' of ' +
      (total == null ? 'unknown' : total) + ' usage rows since ' + startIso +
      ' (hit the ' + USAGE_MAX_PAGES + '-page cap); the credit total below is a FLOOR, not the truth.');
  }
  return { credits: Math.round(credits * 1000) / 1000, cost, recent, rows: seen, total, complete };
}
async function usedThisPeriod(userId) {
  return (await usageThisPeriod(userId)).credits;
}

// Full snapshot for the frontend / gate. Never throws (fail-open shape).
async function getStatus(userId) {
  try {
    const row = await getOrInitPlan(userId);
    const plan = effectivePlan(row);
    const limit = limitFor(plan);
    // The window the plan is really billed on (trial start / subscription anniversary),
    // falling back to the calendar month. See periodStartForRow.
    const periodStart = periodStartForRow(row, Date.now());
    const u = await usageThisPeriod(userId, periodStart);
    // Weights are fractional now, but `used` is shown to the user as "531/750" and is
    // compared against an integer limit — so round UP to a whole credit. Never rounds
    // down, so we can't under-report spend; costs the user at most one credit a month.
    const used = Math.ceil(u.credits);
    const cost = u.cost;
    const trialEndsAt = row && row.trial_ends_at ? row.trial_ends_at : null;
    let trialDaysLeft = null;
    if (plan === 'trial' && trialEndsAt) {
      trialDaysLeft = Math.max(0, Math.ceil((new Date(trialEndsAt).getTime() - Date.now()) / 86400000));
    }
    return { ok: true, plan, used, limit, remaining: Math.max(0, limit - used), cost, costCap: COST_CAP_EUR,
             recent: u.recent || 0, trialEndsAt, trialDaysLeft, periodStart, partial: !u.complete };
  } catch (e) {
    // Fail-open: unknown status, treat as allowed.
    return { ok: true, unknown: true, plan: 'trial', used: 0, limit: PLAN_LIMITS.trial, remaining: PLAN_LIMITS.trial, cost: 0, costCap: COST_CAP_EUR, recent: 0, trialEndsAt: null, trialDaysLeft: null };
  }
}

// Gate a single action. Returns { ok } — ok:false ONLY when we positively know
// the user is over their limit. Any error path returns ok:true (fail-open).
async function checkLimit(userId, credits, action) {
  try {
    const s = await getStatus(userId);
    if (s.unknown) return { ok: true };
    // Feature gate: paid-only tools on the free plan. Positive knowledge only —
    // any error path above already failed open.
    if (s.plan === 'free' && action && FREE_LOCKED_ACTIONS[action]) {
      return {
        ok: false, reason: 'feature', feature: action,
        plan: s.plan, used: s.used, limit: s.limit, remaining: s.remaining, trialEndsAt: s.trialEndsAt
      };
    }
    const need = Number(credits) || 0;
    const addCost = action ? costFor(action) : 0;
    const overCredits = s.used + need > s.limit;
    // Cost fuse: armed by default (COST_CAP_EUR, €25), disabled only if the env sets it
    // to 0. It guards NON-paying accounts only — paid plans (starter/pro/agency) are
    // never cut off by it, and image gen is on the user's own key (no app cost).
    const capOn = (Number(COST_CAP_EUR) || 0) > 0;
    const capApplies = capOn && (s.plan === 'trial' || s.plan === 'free');
    const overCost = capApplies && ((Number(s.cost) || 0) + addCost > COST_CAP_EUR);
    // Burst limit: applies to every plan. It does not reduce anyone's allowance, only
    // how fast it can be spent, so a paying customer is not "cut off" by it — they
    // retry a second later. Positive knowledge only (0 rows read → 0 recent → never fires).
    const overRate = RATE_LIMIT_PER_MIN > 0 && (Number(s.recent) || 0) >= RATE_LIMIT_PER_MIN;
    if (overCredits || overCost || overRate) {
      // CONTRACT: `ok:false` + this shape is what every handler turns into its 402.
      // `reason` gains a 'rate' value; handlers that don't know it fall through to
      // their existing limit_reached 402, which still correctly blocks the request.
      return {
        ok: false,
        reason: overCredits ? 'limit' : (overCost ? 'cost_cap' : 'rate'),
        retryAfter: overRate && !overCredits && !overCost ? Math.ceil(RATE_WINDOW_MS / 1000) : undefined,
        plan: s.plan, used: s.used, limit: s.limit, remaining: s.remaining, trialEndsAt: s.trialEndsAt
      };
    }
    return { ok: true, plan: s.plan, used: s.used, limit: s.limit, remaining: s.remaining };
  } catch (e) {
    return { ok: true };
  }
}

// Record a billable action. Fire-and-forget; never throws.
async function logUsage(evt) {
  try {
    await sbRequest('POST', `/rest/v1/usage_events`, {
      user_id: evt.userId,
      brand_id: evt.brandId || null,
      action: evt.action || 'generate',
      // Rounded to an integer on purpose: weights are fractional now and this column's
      // SQL type is not guaranteed to be numeric — a rejected insert would be swallowed
      // by the catch below and metering would silently stop. Billing reads `action`, not
      // this column (see usageThisPeriod), so this is a historical record only.
      credits: Math.round(creditsFor(evt.action)),
      input_tokens: evt.inputTokens != null ? evt.inputTokens : null,
      output_tokens: evt.outputTokens != null ? evt.outputTokens : null,
      model: evt.model || null
    }, { 'Prefer': 'return=minimal' });
  } catch (e) {
    // SWALLOWED, BUT NOT SILENT. Generation must never break because a usage row failed to
    // write — but this used to be a bare `/* swallow */` with no log, so a schema mismatch on
    // usage_events would stop ALL metering permanently with zero signal: `used` reads 0 forever
    // and no limit can fire. setPlan got a log line for exactly this reason (v627); this one
    // was missed. Only ever runs on the failure path, so the happy path stays quiet.
    console.error('logUsage FAILED — action=' + (evt && evt.action) + ' user=' + (evt && evt.userId) +
      ' was NOT metered:', (e && e.message) || e);
  }
}

// Set a user's plan (called after a successful Stripe checkout, and by the Stripe
// subscription webhook). Ensures the row exists first. Returns true on success.
//
// THIS IS THE MONEY PATH AND IT MUST NEVER FAIL SILENTLY. `sbRequest` REJECTS on any
// status >= 400, so a rejected plan write lands in the catch below. It used to return
// false with no log at all, and every caller discarded the boolean — which meant a
// failure was invisible in BOTH directions: a paying customer left on `free` (charged,
// nothing granted) or a cancelled customer left on `pro` (paid access forever).
// The boolean return is deliberately KEPT rather than throwing — callers branch on it,
// and throwing would change control flow in a webhook and a checkout handler. This
// change only makes the failure visible, and lets callers stop claiming success.
async function setPlan(userId, plan, extra) {
  try {
    await getOrInitPlan(userId);
    const body = Object.assign({ plan: plan, updated_at: new Date().toISOString() }, extra || {});
    await sbRequest('PATCH', `/rest/v1/user_plans?user_id=eq.${encodeURIComponent(userId)}`, body, { 'Prefer': 'return=minimal' });
    return true;
  } catch (e) {
    console.error('setPlan FAILED — user=' + userId + ' was NOT set to plan "' + plan + '":', (e && e.message) || e);
    return false;
  }
}

// Reverse lookup: find the user behind a Stripe subscription/customer (for webhooks).
async function userIdByStripe(opts) {
  try {
    let filter = null;
    if (opts && opts.subscriptionId) filter = 'stripe_subscription_id=eq.' + encodeURIComponent(opts.subscriptionId);
    else if (opts && opts.customerId) filter = 'stripe_customer_id=eq.' + encodeURIComponent(opts.customerId);
    else return null;
    const rows = await sbRequest('GET', `/rest/v1/user_plans?${filter}&select=user_id`);
    return (Array.isArray(rows) && rows[0]) ? rows[0].user_id : null;
  } catch (e) { return null; }
}

// The billing-relevant state of a user_plans row, for callers that must decide whether a
// write is even needed (the webhook's idempotency check) or whether a user already has a
// live subscription (create-checkout's double-subscribe refusal).
// Returns null on ANY failure — callers must treat null as "don't know", never as "no plan".
async function getPlanSnapshot(userId) {
  try {
    const rows = await sbRequest('GET', `/rest/v1/user_plans?user_id=eq.${encodeURIComponent(userId)}&select=*`);
    const row = (Array.isArray(rows) && rows[0]) || null;
    if (!row) return null;
    return {
      plan: row.plan || null,
      effectivePlan: effectivePlan(row),
      stripeCustomerId: row.stripe_customer_id || null,
      stripeSubscriptionId: row.stripe_subscription_id || null,
      currentPeriodEnd: row.current_period_end || null
    };
  } catch (e) {
    console.error('getPlanSnapshot FAILED — user=' + userId + ':', (e && e.message) || e);
    return null;
  }
}

// Look up a user's Stripe customer id (for opening the billing portal).
async function stripeCustomerId(userId) {
  try {
    const rows = await sbRequest('GET', `/rest/v1/user_plans?user_id=eq.${encodeURIComponent(userId)}&select=stripe_customer_id`);
    return (Array.isArray(rows) && rows[0]) ? (rows[0].stripe_customer_id || null) : null;
  } catch (e) { return null; }
}

// ── WHOSE PLAN PAYS FOR THIS? ─────────────────────────────────────────────────
// Metering used to be "the caller's own user_plans row", always. Agency is sold at $79 as
// "multiple brands & seats"; every seat the owner invited was metered on ITS OWN row — 150
// trial credits, then 40/month forever — so a seat was effectively a free account a week
// after being invited, and the owner's 2,500 was only ever spent by the owner. Work done
// INSIDE a brand is the brand OWNER's work; it belongs on the owner's plan and ceiling.
//
// THE HAZARD THIS MUST NOT OPEN: spending someone else's credits. brandId reaches us as a
// CLIENT CLAIM on the request body, so it is never trusted. This only ever moves the meter
// when store.userCanAccessBrand — the same membership check the rest of api/ already uses —
// says the caller is genuinely the owner or a member. Every other outcome (own brand, no
// brand, unknown brand, non-member, or ANY error) returns the caller unchanged, so the worst
// a forged brandId can do is meter the forger against their own plan, exactly as today.
//
// COST: one extra PostgREST read, and ONLY when the request actually names a brand — a
// request with no brandId does no extra work at all.
async function billingUserFor(userId, brandId) {
  if (!userId || !brandId) return userId;
  try {
    const rows = await sbRequest('GET',
      `/rest/v1/brands?id=eq.${encodeURIComponent(brandId)}&select=user_id`);
    const owner = (Array.isArray(rows) && rows[0] && rows[0].user_id) || null;
    // Their OWN brand (by far the common case) and an unknown brand both mean "unchanged".
    if (!owner || owner === userId) return userId;
    const member = await require('./_publish/store').userCanAccessBrand(userId, brandId);
    return member ? owner : userId;
  } catch (e) {
    // Fail to the CALLER, never to the owner: an unreadable membership check must not be a
    // way to spend a stranger's allowance. Logged because it silently changes who is billed.
    console.error('billingUserFor FAILED — user=' + userId + ' brand=' + brandId +
      ' — metering against the caller instead of the brand owner:', (e && e.message) || e);
    return userId;
  }
}

// The brand a request is about, as the CLIENT claims it. Purely a lookup key for
// billingUserFor, which verifies it — nothing here is trusted. Mirrors the `_bid` shape every
// handler already builds for its usage row (body.brandId, or brandContext.brandId on a
// pre-lean client), so the gate and that row agree on which brand the work belongs to.
function claimedBrandId(req) {
  try {
    const b = req && req.body;
    if (!b || typeof b !== 'object') return null;
    const bc = b.brandContext;
    const id = b.brandId || b.brand_id ||
      (bc && typeof bc === 'object' && (bc.brandId || bc.brand_id)) || null;
    return typeof id === 'string' && id ? id : null;
  } catch (e) { return null; }
}

// Convenience for handlers: authenticate + gate in one call.
// Returns { user, over, gate, billingUserId }. user=null → not signed in (handler returns 401).
// over=true → positively over limit (handler returns 402). Fail-open: on error over=false.
//
// billingUserId is WHOSE PLAN THIS CALL WAS GATED AGAINST (see billingUserFor) — the caller
// themselves unless they are working inside a brand somebody else owns. Handlers MUST log
// their usage row against it too, or the gate and the meter would disagree: the owner's
// ceiling would be checked while the seat's row grew, and nothing would ever reach a limit.
// Note that `gate` therefore describes the OWNER's plan/used/limit when a seat is over — a
// teammate seeing "the brand's plan is out of posts" is the intended message.
async function guard(req, action) {
  const user = await require('./_requireUser')(req);
  if (!user) return { user: null, over: false };
  const billingUserId = await billingUserFor(user.id, claimedBrandId(req));
  const gate = await checkLimit(billingUserId, creditsFor(action), action);
  return { user, over: !gate.ok, gate, billingUserId };
}

module.exports = {
  PLAN_LIMITS, ACTION_CREDITS, ACTION_COST, COST_CAP_EUR, RATE_LIMIT_PER_MIN, TRIAL_DAYS,
  creditsFor, costFor, getOrInitPlan, effectivePlan, limitFor,
  usedThisPeriod, usageThisPeriod, getStatus, checkLimit, logUsage, guard, setPlan, userIdByStripe, stripeCustomerId,
  billingUserFor, claimedBrandId,
  setRequestBudget,
  // Period window (pure, testable) + the billing snapshot the money path branches on.
  periodStartISO, periodStartForRow, getPlanSnapshot, PAID_PLANS
};
