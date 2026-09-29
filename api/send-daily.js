const https = require('https');
const webpush = require('web-push');
const store = require('./_publish/store'); // heartbeat (cron liveness) + the brand access check
const { validTypeMix, topUpMix, DEFAULT_TYPE_MIX, POST_TYPES } = require('./_brain');   // types — pure helpers

// Hourly cron: for every subscription whose chosen local hour is NOW, top the brand's Ideas list
// up to DAILY_TARGET waiting ideas (fix7 — the same generator as the app's "Plan my week") and push
// "N new ideas ready — pick today's post". "Friend who did the homework" — one ping per day.
//
// TWO HONESTY RULES, both learned the hard way:
//  1. A FAILED subscriber read is NOT "zero subscribers due". The old sbRequest resolved
//     null for ANY http status, so a broken read became `subs = null` -> `due = []` -> a
//     'ok' heartbeat with checked:0 and a 200. job_heartbeats is the ONLY monitoring signal
//     this cron has (/api/health reads it), so a total daily-push outage reported as a
//     healthy run. Now the read throws on a non-2xx and we write NO heartbeat on failure —
//     `last_success_at` must only ever mean "a run actually succeeded", so letting it go
//     stale is what makes /api/health go red.
//  2. Every subscriber gets a BOUNDED slice of the 300s maxDuration. generate-ideas can
//     legitimately run for minutes and postJson had no timeout, so a handful of slow
//     generations ran this function past the platform limit: killed mid-loop, heartbeat
//     never written, and every subscriber after the cut-off silently missed that day.
//     Now we stop cleanly, COUNT the ones we could not reach, and say so loudly.
//
// AND ONE SECURITY RULE: push_subscriptions.brand_id is a CLIENT CLAIM, not a fact.
// sql/push-subscriptions.sql declares it `brand_id uuid` with no foreign key, no constraint
// and no ownership check — its insert policy validates user_id and nothing else. This cron
// reads brands with the SERVICE ROLE, i.e. past RLS, so an unverified brand_id here means
// any signed-in user could insert a subscription row carrying SOMEONE ELSE'S brand id and
// receive that brand's entire brain (voice_extra: painPoints, brandVocab, productDetails,
// originStory, coachNotes, masterPromptContent) rendered into their own daily push. Brand
// ids are not secret — lookup_invite hands one to anybody holding an invite code — and
// removing the member from the brand would not close it, because nothing here consults
// membership. It is unmetered too: generate-ideas skips its usage gate for the CRON_SECRET
// caller. So every brand_id is re-checked against the row's OWN user_id, every run, below.
/* fix7 r3 — THE TIME MODEL. Subscribers used to run ONE AFTER ANOTHER, and with a daily batch that
   took about a minute only ~2 of 6 people due in the same hour got anything (review, 2026-09-28).
   Now due subscriptions are grouped into UNITS — one per brand (every device and team member on a
   brand shares ONE generation: one charge, one batch, then everyone on it gets the push) — and up
   to CONCURRENCY units run at the same time, each on its own clock.
   All times are measured from the handler's FIRST line (_t0), and every number is a declared cap:
     before any unit    the subscriber read, up to TWO reads (the tz_name fallback) 40s
                        + the batch-timeout memory (this job's own heartbeat row) 20s        = 60s
     one unit, before   the access check (userCanAccessBrand: TWO sequential requests at the
     the generate call  20s request budget, the unit's subscriptions checked in parallel) 40s
                        + getBrandActivity up to TWO reads (the second only on a database
                          without ideas.gen_flow) 40s + loadBrandContext 20s                 = 100s
     one unit, after    the ideas insert INSERT_TIMEOUT_MS 8s + push 15s + the last_sent_at
     the generate call  PATCH 20s (the unit's pushes run in parallel)                         = 43s
   So a unit is only STARTED with MIN_SLICE_MS = 100 + 43 = 143s of RUN_BUDGET_MS left, and its
   generate call gets whatever is left after reserving the 43s (never more than GEN_TIMEOUT_MS). If
   that is under MIN_GEN_MS, the batch is SKIPPED — nothing is charged — rather than started to die.
   The first wave always starts: 60 + 143 = 203s <= 270s.
   GUARD 2 is unchanged in spirit: every unit is RACED against the time left to RUN_BUDGET_MS, so no
   unit can run past it whatever it is waiting on; the heartbeat (20s request budget) follows, and
   the function ends by 270 + 20 = 290s < maxDuration 300. Anyone not reached is COUNTED and logged
   loudly, and the heartbeat says 'partial' — the v677 rules below still hold.
   v677 background — THE RESERVE WAS 30s AGAINST A 125s WORST CASE, SO IT DID NOT BIND. Starting a
   subscriber with 30s left finished at ~340s against maxDuration 300 — the platform killed the
   function, store.heartbeat() was NEVER reached, and every subscriber the loop had not got to
   MISSED THAT DAY, because the due filter matches each of them at exactly one UTC hour.
   pull-trends-cron hit precisely this (a 504 before its heartbeat) and was given TWO guards. */
const RUN_BUDGET_MS   = 270000; // from the handler's first line: every unit is finished or abandoned by now
const MIN_SLICE_MS    = 143000; // never START a unit without room for its worst case (generate excluded)
/* fix7 r3 — 6 AT A TIME. Each unit mostly WAITS (Supabase, web-push, and one /api/generate-ideas call
   that runs in its own function instance), so this function's memory is tiny: per unit at most 2000
   ideas rows (created_at/status/title/format/day/dismiss_reason/gen_flow) and one brand context,
   well under the platform's function memory. The real limits are outside: 6 units = at most 6
   batch calls to the writer model at once, which is what six people pressing "Plan my week"
   together already produce (and _llm.js retries a 429). I can't verify this account's xAI rate
   limit from here, so this stays modest. Capacity per hourly run: a unit needs 143s of the 270s,
   so with ~60s batches three waves start (0s, ~60s, ~120s) = up to 18 brands; with 200s batches one
   wave = 6. Anyone beyond that is counted as skipped and logged. */
const CONCURRENCY     = 6;
/* fix7 r3 — THE GENERATE CAP. api/generate-ideas has its own FN_BUDGET_MS of 280s: a main writer call
   (up to 93.3s), one lower-effort retry of it (up to 93.3s), and the guardrail regeneration only when
   40s+ remain. 200s covers the main call AND its retry, so a slow batch still lands and is saved; a
   first-wave unit gets min(200s, 270 - elapsed - 43) — 200s whenever the reads are healthy.
   If the cap is still hit, generate-ideas keeps running and BILLS its batch, and nothing is saved.
   So the brand is remembered (heartbeat detail genTimeouts) and NOT generated for again for
   GEN_BLOCK_MS — no second charge on the next hourly run for another device on the same brand. */
const GEN_TIMEOUT_MS  = 200000; // hard cap on ONE /api/generate-ideas call
const MIN_GEN_MS      = 45000;  // less than this left for the batch -> do not start (and pay for) it
const GEN_BLOCK_MS    = 20 * 3600 * 1000; // after a timed-out batch, that brand gets no new batch for 20h
const PUSH_TIMEOUT_MS = 15000;  // hard cap on ONE web-push delivery
const DB_TIMEOUT_MS   = 20000;  // hard cap on ONE Supabase request
/* fix7 — THE MORNING BATCH IS SAVED, NOT ONLY PUSHED (owner: "several ideas waiting each morning
   to approve or reject"). The brand's Ideas list is topped up to DAILY_TARGET waiting ('pending')
   ideas: already there -> nothing is generated and nothing is charged; otherwise ONE
   /api/generate-ideas call (one 'ideas' credit — exactly what "Plan my week" costs, see
   _usage.creditsFor) for min(DAILY_BATCH_MAX, DAILY_TARGET - pending) ideas, inserted as pending
   for the brand authorizedBrandId() verified — never the raw client-written sub.brand_id — with the
   SERVICE ROLE. The insert has its own short cap (all attempts together), never throws into the
   subscriber's failure path, and when it fails the push still goes out. A title the brand already
   has (trimmed, case-insensitive — the app loader's rule) is skipped.
   THE MARKER: every row made here carries gen_flow = DAILY_FLOW ('daily'). The app reads it back
   and re-saves it (genFlow), content-metrics counts it as its own flow, and getBrandActivity
   ignores still-pending 'daily' rows when it asks "when did this person last do something" — so
   the cron's own rows can never make an inactive user look active (the review found exactly that:
   a paid batch every day, forever). On a database without the gen_flow column the rows are saved
   without it; the target rule alone still stops the charges (see the note at DAILY_TARGET). */
const INSERT_TIMEOUT_MS = 8000; // hard cap on the ideas insert, retries included (fix7)
const DAILY_TARGET = 7;         // ideas waiting each morning. >= this many pending -> no generation, no charge.
                                // An inactive user's pending pile never shrinks, so after at most one
                                // top-up they are never charged again until they act.
const DAILY_BATCH_MAX = 7;      // most ideas asked for in one morning. = DAILY_TARGET on purpose: a smaller
                                // cap needs a SECOND paid top-up the next morning to reach the target,
                                // which an inactive user on a database without gen_flow would pay for.
                                // 7 is what "Plan my week" asks for.
const DAILY_FLOW = 'daily';     // the marker on every row this cron writes (ideas.gen_flow)

module.exports = async function handler(req, res) {
  const _t0 = Date.now();   // fix7 r3: the whole run's clock starts HERE (see RUN_BUDGET_MS)
  // This cron has maxDuration 300; the shared Supabase timeout defaults to 4s because the
  // tightest callers of that helper are money endpoints on the ~10s platform default. That 4s
  // ceiling fired here twice in production (the job_heartbeats write), which then made /api/health
  // report this cron as unobserved even though it had run — a false alarm in the one monitor that
  // is supposed to tell us a cron died. 20s is still far above a healthy PostgREST round trip
  // (~100-300ms), so a real stall is still caught and still named in the log.
  try { require('./_publish/store').setRequestBudget(20000); } catch (_) {}
  try {
    // Only an authorized caller may trigger this cron. When CRON_SECRET is set,
    // Vercel Cron automatically sends "Authorization: Bearer <CRON_SECRET>".
    // If the secret isn't set yet, we fail closed so the endpoint can't be abused.
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret || (req.headers.authorization || '') !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: 'Push env vars not configured' });
    }
    webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:hello@contentshrimp.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

    // sbGet THROWS on a non-2xx now, so a broken read can never be mistaken for
    // "nobody is due". Handled here (not by the outer catch) so the failure is named
    // in the logs and, critically, so NO heartbeat is written for a run that pushed
    // nothing and does not even know who was due.
    let subs;
    try {
      // user_id is selected because brand_id cannot be trusted without it: the row's owner
      // is the only thing that says whether the brand it names is theirs to read. Without
      // this column no ownership check is even expressible here.
      /* v678: tz_name rides along so the offset can be recomputed for the day we are actually
         sending (see offsetFor below). A database that has not had sql/v678-push-tz-name.sql
         run yet answers 400 for an unknown column — and a 400 here means NOBODY gets a push,
         so fall back to the old column list rather than failing the whole run. The fallback
         behaves exactly as v677 did: a fixed offset that drifts an hour across DST. */
      const _cols = 'id,user_id,brand_id,subscription,send_hour,tz_offset_min,last_sent_at,motivation_on';
      try {
        subs = await sbGet(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
          `/rest/v1/push_subscriptions?select=${_cols},tz_name`);
      } catch (e1) {
        console.error('send-daily: could not read tz_name (run sql/v678-push-tz-name.sql) — ' +
          'falling back to the stored offset, which drifts by an hour across DST: ' + ((e1 && e1.message) || e1));
        subs = await sbGet(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
          `/rest/v1/push_subscriptions?select=${_cols}`);
      }
    } catch (e) {
      console.error('send-daily: subscriber read FAILED — 0 pushes attempted this run:', (e && e.message) || e);
      return res.status(500).json({ error: 'subscriber read failed', detail: String((e && e.message) || e).slice(0, 200) });
    }

    const nowUtc = new Date();
    /* v678 — DST MOVED THE PING BY AN HOUR, TWICE A YEAR, FOR EVERY EU/US/AU USER.
       tz_offset_min is a SNAPSHOT taken the last time the app was open, and it is only
       refreshed inside a successful /api/usage call — so on the changeover Sunday the row
       still carries Saturday's offset, and Sunday morning is exactly when nobody has opened
       the app. Measured against the real Europe/London zone: 2026-10-25 a 09:00 ping lands at
       08:00; 2026-03-29 it lands at 10:00.
       A zone NAME does not go stale. When the row has one, work out the offset for TODAY;
       otherwise fall back to the stored number, which is what every pre-v678 row has. */
    const offsetFor = (sub, when) => {
      const name = sub && sub.tz_name;
      if (name) {
        try {
          // Format the same instant in the zone, read it back as if it were UTC, and the
          // difference IS the offset. getTimezoneOffset()'s sign convention: west is positive.
          const f = new Intl.DateTimeFormat('en-US', { timeZone: name, hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit' });
          const p = {};
          for (const part of f.formatToParts(when)) p[part.type] = part.value;
          const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
          return Math.round((when.getTime() - asUtc) / 60000);
        } catch (e) { /* an unknown zone name falls through to the stored offset */ }
      }
      return Number(sub && sub.tz_offset_min) || 0;
    };
    /* v677 — THE 20-HOUR DEDUPE SWALLOWED A WHOLE DAY AFTER EASTWARD TRAVEL.
       The app corrects tz_offset_min when it is next opened. Moving east makes the next
       scheduled UTC send EARLIER, so the gap from the previous send is (24 - delta) hours —
       and any eastward hop over 4 hours lands inside the 20h window and is suppressed
       outright. New York -> London: no daily idea at all on the first morning in London, and
       no retry, because the next match is 24h later. The question the dedupe actually wants
       to ask is "have we already sent for THIS person's local day", so ask that. It also
       makes the clocks-back Sunday safe, where the same 20h window would have bitten. */
    const localDayKey = (whenUtc, tzOffsetMin) =>
      new Date(whenUtc.getTime() - (Number(tzOffsetMin) || 0) * 60000).toISOString().slice(0, 10);
    /* v677 — ONE PING PER DEVICE, AS THE COPY PROMISES. enableDailyPush writes one row per
       BRAND for the same push endpoint, and the only dedupe was last_sent_at on the row, so a
       user with three brands got three stacked notifications on one phone at the same minute —
       under a toast reading "One notification a day". sw.js now also tags them so any that do
       overlap collapse rather than stack. */
    const _seenEndpoint = new Set();
    const due = (subs || []).filter(s => {
      const off = offsetFor(s, nowUtc);          // v678: today's real offset, not last week's
      const localHour = ((nowUtc.getUTCHours() - (off / 60)) % 24 + 24) % 24;
      if (Math.floor(localHour) !== s.send_hour) return false;
      if (s.last_sent_at &&
          localDayKey(new Date(s.last_sent_at), offsetFor(s, new Date(s.last_sent_at))) === localDayKey(nowUtc, off)) return false;
      const ep = (s.subscription && s.subscription.endpoint) || '';
      if (ep) { if (_seenEndpoint.has(ep)) return false; _seenEndpoint.add(ep); }
      return true;
    });

    // `skipped` = due subscribers we never got to because the run ran out of budget.
    // They are NOT retried: the next hourly run only matches their own send_hour, so a
    // skipped subscriber MISSES THAT DAY entirely. That is why it is counted and logged
    // instead of being lost inside a platform timeout.
    let sent = 0, failed = 0, skipped = 0, stampFailed = 0, brandDenied = 0, overLimit = 0, ranOut = false;
    let ideaSaved = 0, ideaWaiting = 0, ideaSaveFailed = 0;   // fix7 — heartbeat detail only
    let genTimedOut = 0, genBlocked = 0, genNoTime = 0;       // fix7 r3 — heartbeat detail only
    const _left = () => RUN_BUDGET_MS - (Date.now() - _t0);

    // fix7 r3 — brands whose batch timed out recently (see GEN_TIMEOUT_MS). Carried in this job's own
    // heartbeat row: one read per run, before any unit. Unreadable -> {} and said so.
    const _gt = await readGenTimeouts(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const _genTimeouts = _gt.map;
    const _blockedBrand = (b) => { const t = Date.parse(_genTimeouts[b] || ''); return !isNaN(t) && (nowUtc.getTime() - t) < GEN_BLOCK_MS; };

    // fix7 r3 — UNITS: one per CLAIMED brand, so every device/member on it shares one generation;
    // one per brand-less row. The claim only groups — every row is still verified on its own below.
    const _units = [], _byBrand = new Map();
    for (const s of due) {
      if (s && s.brand_id) {
        let u = _byBrand.get(s.brand_id);
        if (!u) { u = []; _byBrand.set(s.brand_id, u); _units.push(u); }
        u.push(s);
      } else _units.push([s]);
    }

    const _ideasUrlFor = (brandId) => brandId ? '/app.html?open=ideas&b=' + encodeURIComponent(brandId) : '/app.html';
    const _waitingPush = (n, brandId) => ({
      title: `You have ${n} idea${n === 1 ? '' : 's'} waiting — pick today's post`,
      body: 'Open Ideas and approve the one you want to film.',
      url: _ideasUrlFor(brandId)
    });
    const _genericPush = { title: 'Time to make something', body: 'One tap, one post — open the app and make today\'s.', url: '/app.html' };

    // One push + its last_sent_at stamp. `done` records that this subscription was reached.
    const _deliver = async (sub, payload, done) => {
      try {
        await webpush.sendNotification(sub.subscription, payload, { timeout: PUSH_TIMEOUT_MS });
        // The push DID go out, so this still counts as sent — but a failed last_sent_at
        // write means the local-day dedupe stamp is missing, which is worth knowing about.
        const stamp = await sbPatch(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
          `/rest/v1/push_subscriptions?id=eq.${sub.id}`, { last_sent_at: nowUtc.toISOString() });
        if (!stamp || stamp.status < 200 || stamp.status >= 300) {
          stampFailed++;
          console.error('send-daily: pushed subscription ' + sub.id + ' but the last_sent_at write FAILED (' +
            ((stamp && stamp.status) || 'no response') + ') — dedupe stamp not written');
        }
        sent++;
      } catch (e) {
        failed++;
        console.error('send-daily: subscription ' + (sub && sub.id) + ' failed — ' + ((e && e.message) || e));
        // Subscription expired/revoked → clean it up
        if (e && (e.statusCode === 404 || e.statusCode === 410)) {
          const del = await sbDelete(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, `/rest/v1/push_subscriptions?id=eq.${sub.id}`).catch(() => null);
          if (!del || del.status < 200 || del.status >= 300) {
            console.error('send-daily: could not delete expired subscription ' + sub.id + ' (' + ((del && del.status) || 'no response') + ')');
          }
        }
      } finally { done.add(sub); }
    };

    // The brand's morning, ONCE for everyone on it: the activity read, and — when anyone on it is
    // not getting the "gone quiet" nudge — the waiting / new-batch decision. Throws on a failed
    // read (every verified subscription in the unit is then counted as failed).
    const _brandPlan = async (brandId, subs) => {
      // How long since they last DID something? (re-engagement signal). fix7: the cron's own
      // still-pending rows do not count — see getBrandActivity.
      const act = await getBrandActivity(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, brandId);
      const daysSince = act.lastCreated ? Math.floor((nowUtc - new Date(act.lastCreated)) / 86400000) : 999;
      const quiet = daysSince >= 2;
      const plan = { act, daysSince, quiet, payload: JSON.stringify(_genericPush) };
      // The subscription the batch is FOR (and billed to): the first one not getting the nudge.
      const sub = subs.find(s => !(quiet && s.motivation_on !== false));
      if (!sub) return plan;                        // everyone gets the nudge — nothing to generate
      const _fallback = () => JSON.stringify(act.pending > 0 ? _waitingPush(act.pending, brandId) : _genericPush);
      if (act.pending >= DAILY_TARGET) {
        // Enough waiting already: no generation, no charge.
        ideaWaiting++;
        plan.payload = JSON.stringify(_waitingPush(act.pending, brandId));
        return plan;
      }
      if (_blockedBrand(brandId)) {
        // Its batch timed out within GEN_BLOCK_MS — that run was very likely billed. Not again today.
        genBlocked++;
        console.log('send-daily: brand ' + brandId + ' had a batch time out at ' + _genTimeouts[brandId] +
          ' — not generating again today (no second charge); sending the plain push');
        plan.payload = _fallback();
        return plan;
      }
      // Top the list up — ONE generate call, the same generator as the app's "Plan my week".
      // A failed brands read THROWS instead of silently writing against an empty brain. The shared
      // hydrator reads all 28 fields; `trusted` exists for exactly this caller, which has already
      // verified ownership of brandId via authorizedBrandId().
      const _h = await require('./_brandctx').loadBrandContext(brandId, { trusted: true }, '');
      if (!(_h && _h.ok && _h.bc)) throw new Error('brand context unavailable: ' + ((_h && _h.reason) || 'unknown'));
      const bc = _h.bc;
      // Cap the generation AFTER the reads above, from what is actually left, keeping room for the
      // insert, the push and the last_sent_at write. Under MIN_GEN_MS the batch is not started at
      // all: a call cut off early is still billed, and nothing would be saved.
      const genMs = Math.min(GEN_TIMEOUT_MS, _left() - (INSERT_TIMEOUT_MS + PUSH_TIMEOUT_MS + DB_TIMEOUT_MS));
      if (genMs < MIN_GEN_MS) {
        genNoTime++;
        console.error('send-daily: only ' + Math.max(0, genMs) + 'ms left for brand ' + brandId + '\'s batch — not starting it (no charge); plain push');
        plan.payload = _fallback();
        return plan;
      }
      const host = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://contentshrimp.com';
      // NAME THE ACCOUNT THIS BATCH IS FOR. The secret identifies the CALLER; forUserId and forBrandId
      // identify the ACCOUNT, so generate-ideas meters it against that plan (one 'ideas' credit per
      // call — what "Plan my week" costs). The brand id is the one authorizedBrandId() verified
      // (never the raw, client-written sub.brand_id). An over-limit account answers 402, which
      // carries no `ideas` — nothing is inserted and the plain push goes out.
      // v677: days are named in the SUBSCRIBER's local time — this is their morning. fix7: one gap
      // per idea, starting today, so the batch covers the coming days like the app's plan.
      const _localNow = new Date(nowUtc.getTime() - offsetFor(sub, nowUtc) * 60000);
      const _wk = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      const _want = Math.max(1, Math.min(DAILY_BATCH_MAX, DAILY_TARGET - act.pending));
      const _days = [];
      for (let k = 0; k < _want; k++) _days.push(_wk[(_localNow.getUTCDay() + k) % 7]);
      const _dr = (bc.dayRotation && typeof bc.dayRotation === 'object') ? bc.dayRotation : {};
      const _dOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'Bonus'];
      // Same day-theme strings the app's generateNewIdeas adds on top of the brand context.
      const _bcOut = Object.assign({}, bc, {
        communities: _dOrder.map(d => `${d}: ${_dr[d] || 'General'}`).join(', '),
        dayMap: _dOrder.map(d => `${d} = ${_dr[d] || 'General'}`).join(', '),
      });
      // types — the brand's saved post-type mix (bc.typeMix; the default when none is saved), fitted to
      // the number of ideas this top-up asks for. A full top-up (>= the mix total) is scaled (7 with the
      // default mix is exactly the default); a smaller one takes its slots from the mix cycle at an
      // offset that rotates with the subscriber's local day, so over a week small top-ups follow the mix
      // too (see _brain.topUpMix). generate-ideas turns a news slot into a tip when no fresh headline exists.
      const _dayIndex = Math.floor(_localNow.getTime() / 86400000);   // days since epoch, local: consecutive days rotate
      const _typeMix = topUpMix(validTypeMix(bc.typeMix) || DEFAULT_TYPE_MIX, _want, _dayIndex);
      const gen = await postJson(`${host}/api/generate-ideas`,
        { count: _want, typeMix: _typeMix, brandContext: _bcOut, forUserId: sub.user_id, forBrandId: brandId,
          gaps: _days.map(d => ({ day: d })), learningContext: act.learningContext || '', delivery: 'faceon' },
        { Authorization: `Bearer ${cronSecret}` }, genMs);
      if (gen && gen.timedOut) {
        genTimedOut++;
        _genTimeouts[brandId] = new Date().toISOString();
        console.error('send-daily: brand ' + brandId + '\'s batch passed its ' + genMs + 'ms cap. generate-ideas finishes (and bills) ' +
          'on its own and NOTHING was saved; this brand gets no new batch for ' + (GEN_BLOCK_MS / 3600000) + 'h');
      }
      if (gen && gen.error === 'limit_reached') {
        overLimit++;
        console.log('send-daily: brand ' + brandId + ' is over its plan limit (' +
          gen.plan + ' ' + gen.used + '/' + gen.limit + ') — nothing generated or saved, sending the plain push');
      }
      const ideas = (gen && Array.isArray(gen.ideas)) ? gen.ideas : [];
      let saved = null;
      if (ideas.length) {
        saved = await saveDailyBatch(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, brandId, ideas,
          { today: _days[0], titles: act.titles, dayRotation: _dr, subId: sub.id });
        if (saved && saved.inserted) ideaSaved += saved.inserted;
        else if (!saved) ideaSaveFailed++;
      }
      const n = saved ? saved.inserted : 0;
      plan.payload = n > 0 ? JSON.stringify({
        title: `${n} new idea${n === 1 ? '' : 's'} ready — pick today's post`,
        body: saved.first ? `"${String(saved.first).slice(0, 90)}"${n > 1 ? ' and ' + (n - 1) + ' more' : ''}` : 'Open Ideas and approve the one you want to film.',
        url: _ideasUrlFor(brandId)
      }) : _fallback();
      return plan;
    };

    // One unit = one claimed brand (or one brand-less row).
    const _runUnit = async (unit, done) => {
      // THE ONE PLACE sub.brand_id becomes a fact — per subscription, in parallel. Everything below
      // reads the verified `brandId`; nothing may use sub.brand_id again, or the check is back to
      // being optional. A brand that does not check out routes into the generic path, so the
      // subscriber still gets their ping, it just carries nothing out of a brand they are not
      // entitled to.
      const checks = await Promise.all(unit.map(async (sub) => ({ sub, access: await authorizedBrandId(sub) })));
      const mine = [], plain = [];
      let unitBrand = null;
      for (const { sub, access: _access } of checks) {
        // v679: three answers — a brand id, a flat null (genuinely denied), or { unknown: true }
        // (the check could not run). Only the middle one may delete.
        const _accessUnknown = !!(_access && _access.unknown);
        const brandId = (_access && typeof _access === 'string') ? _access : null;
        if (sub.brand_id && _accessUnknown) {
          console.error('send-daily: subscription ' + sub.id + ' — brand access could not be verified this run. ' +
            'Sending the generic push and KEEPING the row; it is re-checked next run.');
        }
        if (sub.brand_id && !brandId && !_accessUnknown) {
          brandDenied++;
          /* v663: A REMOVED TEAM MEMBER GOT A DAILY PUSH FOREVER, WITH NO WAY TO STOP IT.
             removeMember deletes only the brand_members row. Nothing touches push_subscriptions,
             and the owner could not delete that row anyway — its RLS is auth.uid() = user_id.
             The subscription was made for a brand this person can no longer reach, so it has no
             remaining purpose. Delete it — service_role can, which is the whole reason this runs
             here rather than in the app. A genuine self-brand row never reaches this branch,
             because authorizedBrandId only returns null when the access check said NO. */
          try {
            const _d = await sbDelete(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
              '/rest/v1/push_subscriptions?id=eq.' + encodeURIComponent(sub.id));
            console.error('send-daily: removed orphan subscription ' + sub.id + ' — user ' + sub.user_id +
              ' no longer has access to brand ' + sub.brand_id + ' (delete status ' + ((_d && _d.status) || '?') + ')');
          } catch (e) {
            console.error('send-daily: could not remove orphan subscription ' + sub.id + ': ' + ((e && e.message) || e));
          }
          skipped++;
          done.add(sub);
          continue;
        }
        if (brandId) { mine.push(sub); unitBrand = brandId; } else plain.push(sub);
      }
      let plan = null;
      if (mine.length) {
        try { plan = await _brandPlan(unitBrand, mine); }
        catch (e) {
          for (const s of mine) { failed++; done.add(s); }
          console.error('send-daily: brand ' + unitBrand + ' failed for ' + mine.length + ' subscription(s) — ' + ((e && e.message) || e));
          mine.length = 0;
        }
      }
      const _payloadFor = (s) => (plan.quiet && s.motivation_on !== false)
        // Gone quiet + reminders on → motivational nudge (their real numbers, no idea gen).
        ? JSON.stringify(motivationalPush(plan.act, plan.daysSince))
        : plan.payload;
      // No VERIFIED brand means nowhere to save a batch — so nothing is generated and nothing is
      // charged (fix7; it used to generate one brand-less idea into the notification).
      const _plainFor = (s) => JSON.stringify(s.motivation_on !== false
        ? motivationalPush({ total: 0, posted: 0, lastCreated: null }, 999) : _genericPush);
      await Promise.all(mine.map(s => _deliver(s, _payloadFor(s), done))
        .concat(plain.map(s => _deliver(s, _plainFor(s), done))));
    };

    // Up to CONCURRENCY units at once. A unit is only STARTED with MIN_SLICE_MS left; each is RACED
    // against the time left (v677 guard 2) — `_over` is a sentinel, not a rejection, so nothing here
    // can throw. An abandoned unit's unreached subscribers are counted: they miss today.
    const _queue = _units.slice();
    const _worker = async () => {
      while (_queue.length) {
        if (_left() < MIN_SLICE_MS) {
          ranOut = true;
          const rest = _queue.splice(0, _queue.length);
          skipped += rest.reduce((n, u) => n + u.length, 0);
          return;
        }
        const unit = _queue.shift();
        const done = new Set();
        const _unitWork = _runUnit(unit, done).catch((e) => {
          console.error('send-daily: a unit failed unexpectedly — ' + ((e && e.message) || e));
        });
        let _uT = null;
        const _over = await Promise.race([
          _unitWork.then(() => false),
          new Promise(r => { _uT = setTimeout(() => r(true), Math.max(1000, _left())); }),
        ]);
        try { if (_uT) clearTimeout(_uT); } catch (_) {}
        if (_over) {
          ranOut = true;
          const missed = unit.filter(s => !done.has(s)).length;
          skipped += missed;
          console.error('send-daily: a unit (' + unit.length + ' subscription(s), brand ' + ((unit[0] && unit[0].brand_id) || 'none') +
            ') outlived the run budget — abandoning it so the heartbeat still gets written. ' + missed + ' of them miss today.');
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, _units.length) }, () => _worker()));

    if (ranOut) {
      console.error('send-daily: ran out of budget after ' + (Date.now() - _t0) + 'ms — pushed ' + sent + ', but ' +
        skipped + ' due subscriber(s) were NOT reached and they MISS today (this hour is their only slot).');
    }
    if (failed) console.error('send-daily: ' + failed + ' of ' + due.length + ' due subscriber(s) failed this run (see the per-subscription errors above)');
    // Counts BOTH causes (access denied, and access unverifiable because the check errored),
    // because both end the same way: the brand was not used. The per-subscription lines above
    // say which — do not read this number as "N attacks".
    if (overLimit) console.log('send-daily: ' + overLimit + ' subscriber(s) were over their plan limit this run and got the generic push instead of a generated brief');
    if (brandDenied) console.error('send-daily: ' + brandDenied + ' subscription(s) named a brand that could not be CONFIRMED as theirs; ' +
      'those pushes were sent WITHOUT brand content. Check the per-subscription lines above: a "SECURITY" line is a real ' +
      'ownership mismatch (audit that push_subscriptions row); an "access check FAILED" line is a database problem, not an attack.');
    // Same shape as pull-trends-cron: a run where everything attempted failed is NOT
    // healthy, and a run that could not finish its queue is not a clean 'ok' either.
    const _health = (failed && !sent) ? 'error' : (ranOut ? 'partial' : 'ok');
    // brandDenied rides in the heartbeat DETAIL only. /api/health reads job/last_success_at/
    // last_status and never touches detail, so this is additive telemetry — and the HTTP
    // response below stays byte-identical in shape.
    if (ideaSaveFailed) console.error('send-daily: ' + ideaSaveFailed + ' generated batch(es) could not be saved to Ideas this run — those pushes went out without new ideas');
    if (genTimedOut) console.error('send-daily: ' + genTimedOut + ' batch(es) passed the generate cap this run — billed by generate-ideas, nothing saved; those brands are paused for ' + (GEN_BLOCK_MS / 3600000) + 'h');
    // fix7 r3 — carry the batch-timeout memory forward (entries younger than GEN_BLOCK_MS only).
    const genTimeouts = {};
    for (const [b, at] of Object.entries(_genTimeouts)) {
      const t = Date.parse(at);
      if (!isNaN(t) && (nowUtc.getTime() - t) < GEN_BLOCK_MS) genTimeouts[b] = at;
    }
    await store.heartbeat('send-daily', _health, { checked: subs.length, due: due.length, units: _units.length, sent, failed, skipped, stampFailed, brandDenied, overLimit, ranOut,
      ideaSaved, ideaWaiting, ideaSaveFailed, genTimedOut, genBlocked, genNoTime, genTimeoutsRead: _gt.ok, genTimeouts });
    return res.status(200).json({ checked: subs.length, due: due.length, sent, failed, skipped, stampFailed, ranOut });
  } catch (e) {
    console.error('send-daily error:', e);
    return res.status(500).json({ error: e.message });
  }
};

// Resolves { status, data, raw } for EVERY http status — it never decides on its own that
// a 4xx/5xx means "no data". The old version resolved null for any status AND for any
// unparseable body, which is exactly why a broken read was indistinguishable from an empty
// one. Rejects only on a socket error or the timeout (it had none, so a hung Supabase call
// could sit here until the platform killed the whole function).
function sbRequest(base, key, method, path, body, timeoutMs) {
  const ms = timeoutMs || DB_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const opts = {
      hostname: u.hostname, path, method,
      headers: {
        'apikey': key, 'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal'
      },
      timeout: ms
    };
    const r = https.request(opts, resp => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => {
        let j = null; try { j = d ? JSON.parse(d) : null; } catch (_) {}
        resolve({ status: resp.statusCode, data: j, raw: d });
      });
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('supabase ' + method + ' timed out after ' + ms + 'ms')); });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
// GET that tells a real FAILURE apart from an EMPTY result: a non-2xx throws instead of
// quietly becoming []. Always returns an array on success.
async function sbGet(b, k, p) {
  const r = await sbRequest(b, k, 'GET', p);
  if (r.status < 200 || r.status >= 300) {
    const err = new Error('supabase GET ' + r.status + ' ' + String(r.raw || '').slice(0, 160));
    err.sbStatus = r.status;
    throw err;
  }
  return Array.isArray(r.data) ? r.data : [];
}
// Writes return the envelope so callers can CHECK them (see the last_sent_at stamp above).
const sbPatch = (b, k, p, body) => sbRequest(b, k, 'PATCH', p, body);
const sbDelete = (b, k, p) => sbRequest(b, k, 'DELETE', p);

// Turn push_subscriptions.brand_id from a CLIENT CLAIM into a fact, or into null.
//
// The column has no foreign key, no constraint, and an RLS insert policy that only checks
// user_id (sql/push-subscriptions.sql) — so the brand id on a row is whatever the client
// wrote there, and this cron reads brands with the SERVICE ROLE, past RLS. Verifying it
// against the row's OWN user_id is the only thing standing between "your daily post" and
// "a daily post generated from a stranger's brand brain".
//
// FAILS CLOSED, in both senses:
//   * not allowed        -> null (generic push)
//   * check errored/stalled -> null (generic push). Unsure is DENIED. store.userCanAccessBrand
//     runs under a 4s-per-request timeout, so a quiet Supabase rejects here rather than
//     hanging; resolving that rejection to "allowed" would reopen the hole on exactly the
//     day the database is unhealthy.
// Neither case is a push FAILURE — the subscriber is still pinged, so this returns null
// rather than throwing, and the caller counts it separately (brandDenied).
async function authorizedBrandId(sub) {
  if (!sub || !sub.brand_id) return null;
  let ok = false;
  try {
    // user_id is `not null` in the schema, but if it were ever absent this returns false
    // (userCanAccessBrand guards `if (!userId || !brandId) return false`) — closed, again.
    ok = await store.userCanAccessBrand(sub.user_id, sub.brand_id);
  } catch (e) {
    console.error('send-daily: brand access check FAILED for subscription ' + (sub && sub.id) +
      ' (user ' + (sub && sub.user_id) + ', brand ' + (sub && sub.brand_id) + ') — treating the brand as absent ' +
      'and sending the generic push: ' + ((e && e.message) || e));
    /* v679: UNKNOWN, not denied. The caller must not delete this row on the strength of a
       check that never ran — see the note in store.js userCanAccessBrand. */
    return { unknown: true };
  }
  if (!ok) {
    console.error('send-daily: SECURITY — subscription ' + sub.id + ' claims brand ' + sub.brand_id +
      ' but its own user ' + sub.user_id + ' has no access to that brand. Brand IGNORED (generic push sent). ' +
      'push_subscriptions.brand_id is client-written and unconstrained — audit this row.');
    return null;
  }
  return sub.brand_id;
}

// fix7 r3 — the batch-timeout memory lives in this job's own heartbeat detail (genTimeouts:
// { brandId: iso }), so no new table is needed. One read per run. A failed read is NOT "no
// timeouts" in silence: it is logged and reported as genTimeoutsRead: false in the heartbeat.
async function readGenTimeouts(base, key) {
  try {
    const rows = await sbGet(base, key, '/rest/v1/job_heartbeats?job=eq.send-daily&select=detail&limit=1');
    const d = rows[0] && rows[0].detail;
    const m = d && d.genTimeouts;
    return { ok: true, map: (m && typeof m === 'object' && !Array.isArray(m)) ? Object.assign({}, m) : {} };
  } catch (e) {
    console.error('send-daily: could not read the batch-timeout memory (' + ((e && e.message) || e) +
      ') — a brand whose batch timed out in the last day could be generated for (and charged) again');
    return { ok: false, map: {} };
  }
}

// Brand activity: total ideas, how many were taken forward (posted), and the most recent.
// sbGet throws on a failed read, which is deliberate: silently returning zeros here used to
// flip an ACTIVE user into the "you've gone quiet, ${days} days" nudge — a push built from
// numbers we never actually read. A named failure beats a confidently wrong message.
// fix7 — the same ONE read also gives: the titles (batch dedupe), the pending count (the daily
// target), and the learning context generateNewIdeas sends (liked / rejected / titles to avoid).
// lastCreated IGNORES this cron's own still-pending rows (gen_flow = DAILY_FLOW): they are not
// something the person did. A 'daily' row they approved or dismissed IS (the app rewrote it).
// A database without ideas.gen_flow answers 400 for the column; the read is repeated without it
// (counted in MIN_SLICE_MS) and then no row can be told apart — the target rule still bounds cost.
const ACT_COLS = 'created_at,status,title,format,day,dismiss_reason';
function _normStatus(st) {
  const s = String(st || '').toLowerCase();
  if (s === 'approved' || s === 'editing') return 'filming';
  if (s === 'posted') return 'done';
  if (s === 'pending' || s === 'dismissed' || s === 'filming' || s === 'done') return s;
  return 'pending';   // the app's normalizeIdeaStatus: anything unknown shows as pending
}
async function getBrandActivity(base, key, brandId) {
  const q = (cols) => `/rest/v1/ideas?brand_id=eq.${encodeURIComponent(brandId)}&select=${cols}&order=created_at.desc&limit=2000`;
  let rows;
  try {
    rows = await sbGet(base, key, q(ACT_COLS + ',gen_flow'));
  } catch (e) {
    if (!/gen_flow/i.test(String((e && e.message) || ''))) throw e;
    console.error('send-daily: ideas.gen_flow is missing (run sql/ideas-gen-flow.sql) — the daily rows cannot be told apart');
    rows = await sbGet(base, key, q(ACT_COLS));
  }
  const arr = Array.isArray(rows) ? rows : [];
  const POSTED = ['approved', 'filming', 'editing', 'done', 'posted'];
  const posted = arr.filter(r => POSTED.includes(String(r.status || '').toLowerCase())).length;
  const own = arr.filter(r => !(r && r.gen_flow === DAILY_FLOW && _normStatus(r.status) === 'pending'));
  const lastCreated = own.length ? own[0].created_at : null;
  const titles = arr.map(r => (r && typeof r.title === 'string') ? r.title : '').filter(Boolean);
  const pending = arr.filter(r => _normStatus(r && r.status) === 'pending').length;
  // The learning context, built as app.html generateNewIdeas builds it.
  const q2 = (t) => '"' + String(t || '').replace(/\s+/g, ' ').slice(0, 120) + '"';
  const liked = arr.filter(r => ['filming', 'done'].includes(_normStatus(r.status))).slice(0, 15).reverse();
  const nope = arr.filter(r => _normStatus(r.status) === 'dismissed').slice(0, 15).reverse();
  let lc = '';
  if (liked.length) lc += '\nIDEAS THE USER LIKED (approved — generate MORE like these):\n' +
    liked.map(i => `${q2(i.title)} (${i.format}, ${i.day})`).join(', ');
  if (nope.length) lc += '\nIDEAS THE USER REJECTED (dismissed — AVOID similar angles):\n' +
    nope.map(i => `${q2(i.title)} (${i.format}, ${i.day})${i.dismiss_reason ? ' — reason: ' + String(i.dismiss_reason).slice(0, 120) : ''}`).join(', ');
  if (titles.length) lc += '\nTITLES ALREADY IN THE LIBRARY — do NOT repeat or lightly reword any of these; produce different angles/hooks:\n' +
    titles.slice(0, 60).reverse().map(q2).join(', ');
  return { total: arr.length, posted, lastCreated, titles, pending, learningContext: lc };
}

// fix7 — save the morning batch into public.ideas, in the SAME row shape the app writes
// (app.html _buildIdeaRows), so the app loads the rows like any other pending ideas.
//   brandId  MUST be the id authorizedBrandId() returned — never sub.brand_id.
//   returns  { inserted: n, first: <title of the first new row> }  |  null (the write failed)
//            NEVER throws. n is 0 when every title was already in the library.
// ONE request for the whole batch; every attempt shares one INSERT_TIMEOUT_MS deadline. A database
// without the newer optional columns (emphasis: sql/ideas-emphasis.sql, gen_flow:
// sql/ideas-gen-flow.sql) answers PGRST204/42703 naming the column; exactly like the app's
// insertIdeas, the rows are written again without it.
// types — a news idea's headline link, appended to the saved caption in the EXACT form app.html reads
// back (typesCaptionWithSource / typesSourceFromCaption: "\n\nSource: <https url>" as the last line),
// so the link shows on any device. There is no column for newsSource. https only, like the app.
function _captionWithSource(caption, idea) {
  const c = String(caption == null ? '' : caption);
  const ns = idea && idea.postType === 'news' && idea.newsSource;
  const u = ns && typeof ns === 'object' ? String(ns.url == null ? '' : ns.url).trim() : '';
  if (!/^https:\/\/[^\s"'<>]+$/i.test(u) || c.indexOf(u) >= 0) return c;
  return (c.trim() ? c.replace(/\s+$/, '') + '\n\n' : '') + 'Source: ' + u;
}
async function saveDailyBatch(base, key, brandId, ideas, opts) {
  const o = opts || {};
  try {
    if (!brandId || !Array.isArray(ideas) || !ideas.length) return null;
    const asText = v => Array.isArray(v) ? v.join(' ') : (v == null ? '' : String(v));
    const seen = new Set((Array.isArray(o.titles) ? o.titles : []).map(t => String(t).toLowerCase().trim()));
    const WEEK = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const dr = o.dayRotation || {};
    const rows = [];
    for (const idea of ideas) {
      if (!idea || typeof idea !== 'object') continue;
      const title = asText(idea.title).trim();
      const k = title.toLowerCase();
      if (!title || title === 'Untitled' || seen.has(k)) continue;   // dedupe: brand + title
      seen.add(k);
      const script = asText(idea.script), hook = asText(idea.hook), caption = asText(idea.caption), bold = asText(idea.boldText);
      const said = (script + '\n' + hook + '\n' + caption + '\n' + bold).toLowerCase();
      const emphasis = (Array.isArray(idea.emphasis) ? idea.emphasis : [])
        .map(x => String(x == null ? '' : x).trim()).filter(x => x && x.length <= 120 && said.indexOf(x.toLowerCase()) >= 0).slice(0, 6);
      const day = WEEK.includes(idea.day) ? idea.day : (o.today || 'Bonus');
      rows.push({
        brand_id: brandId,
        day,
        community: asText(idea.community).trim() || dr[day] || 'All',
        format: idea.format || 'video',
        title,
        hook, script,
        shots: asText(idea.shots),
        screen: asText(idea.screen),
        caption: _captionWithSource(caption, idea),
        reel_title: asText(idea.reelTitle),
        tags: asText(idea.tags),
        bold_text: bold,
        status: 'pending',
        dismiss_reason: null,
        assignee: '',
        is_generated: true,
        is_remix: false,
        original_creator: '',
        emphasis,
        gen_flow: DAILY_FLOW,   // the marker — see the note at DAILY_FLOW
        // types — what the idea is about (sql/idea-post-type.sql); only a known type is ever written.
        ...(POST_TYPES.indexOf(idea.postType) >= 0 ? { post_type: idea.postType } : {}),
      });
    }
    if (!rows.length) return { inserted: 0, first: null };
    const t0 = Date.now();
    const missing = (r, col) => {
      const d = r && r.data;
      const msg = String((r && r.raw) || '') + ' ' + String((d && (d.message || '')) || '');
      if (msg.toLowerCase().indexOf(col) < 0) return false;
      const code = d && d.code;
      return code === 'PGRST204' || code === '42703' || /schema cache|does not exist|could not find/i.test(msg);
    };
    const strip = (col) => rows.forEach(r => { delete r[col]; });
    let last = null;
    for (let attempt = 0; attempt < 4; attempt++) {   // types: up to 3 optional columns can be missing
      const leftMs = INSERT_TIMEOUT_MS - (Date.now() - t0);
      if (leftMs < 500) break;
      last = await sbRequest(base, key, 'POST', '/rest/v1/ideas', rows, leftMs);
      if (last && last.status >= 200 && last.status < 300) return { inserted: rows.length, first: rows[0].title };
      if ('emphasis' in rows[0] && missing(last, 'emphasis')) { strip('emphasis'); continue; }
      if ('gen_flow' in rows[0] && missing(last, 'gen_flow')) { strip('gen_flow'); continue; }
      if (rows.some(r => 'post_type' in r) && missing(last, 'post_type')) { strip('post_type'); continue; }
      break;
    }
    console.error('send-daily: could not save the morning batch for subscription ' + (o.subId || '?') + ' (' +
      ((last && last.status) || 'no response') + ' ' + String((last && last.raw) || '').slice(0, 160) + ') — pushing without new ideas');
    return null;
  } catch (e) {
    console.error('send-daily: could not save the morning batch for subscription ' + (o.subId || '?') + ': ' + ((e && e.message) || e) +
      ' — pushing without new ideas');
    return null;
  }
}

// Motivational re-engagement push — their real numbers + the compounding message.
function motivationalPush(act, days) {
  const n = act.posted || act.total || 0;
  // Lines that use their real numbers (only when they've posted before).
  const withNum = n > 0 ? [
    { title: '📈 It compounds', body: `You've shipped ${n} post${n === 1 ? '' : 's'}. ${days} day${days === 1 ? '' : 's'} quiet — open up and make one. 1% better every time stacks up.` },
    { title: "Don't break the chain", body: `${n} posts in. The ones who win just don't stop. Two minutes — make today's.` },
    { title: 'Treat it like a job', body: `Same effort you'd give a 9-5, into your content. ${n} down — open up and add one.` },
    { title: 'Add to the pile', body: `${n} and counting. There's no such thing as too much content — open up and make another.` },
    { title: 'Volume wins', body: `Even 90 posts a day wouldn't be too many. You're at ${n}. Reps beat perfection — ship one now.` },
  ] : [];
  // Volume / mindset lines that work for anyone.
  const general = [
    { title: 'No such thing as too much', body: 'You literally cannot overpost. Open up and make one — then make another.' },
    { title: "Document, don't create", body: "It doesn't have to be perfect. Capture one thing and post it. Tap to start." },
    { title: 'Reps beat perfection', body: 'Volume and consistency win. Get your reps in — make one now.' },
    { title: 'Your first post is the hardest', body: 'Open up and ship one — momentum starts today. 1% better every time compounds.' },
    { title: 'Start the chain', body: "One post today, another tomorrow — that's how it compounds. Tap to begin." },
    { title: 'More is more', body: "Nobody posted their way to irrelevance. Open up and add to the stack." },
  ];
  const pool = withNum.concat(general);
  const p = pool[Math.floor(Math.random() * pool.length)];
  return { title: p.title, body: p.body, url: '/app.html' };
}

// Fires the internal generate call. BOUNDED: with no timeout, one slow generation could eat
// the entire 300s function budget and every subscriber after it silently missed the day.
// A timeout resolves { timedOut: true } rather than throwing (fix7 r3: named, so the caller can
// record it), so the caller still sends the fallback push — a plain ping beats no ping.
function postJson(url, body, extraHeaders, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const opts = {
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        extraHeaders || {}
      )
    };
    if (timeoutMs) opts.timeout = timeoutMs;
    const r = https.request(opts, resp => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
    });
    if (timeoutMs) {
      r.on('timeout', () => {
        console.error('send-daily: generate-ideas timed out after ' + timeoutMs + 'ms — sending the generic push instead');
        r.destroy();
        resolve({ timedOut: true }); // fix7 r3: named, so the caller can record it. Settled, so the destroy-induced 'error' is a no-op
      });
    }
    r.on('error', reject);
    r.write(data);
    r.end();
  });
}
