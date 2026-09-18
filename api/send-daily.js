const https = require('https');
const webpush = require('web-push');
const store = require('./_publish/store'); // heartbeat (cron liveness) + the brand access check

// Hourly cron: for every subscription whose chosen local hour is NOW,
// pre-generate today's Quick Post idea for their brand and push it.
// "Friend who did the homework" — one ping per day, idea included, zero guilt.
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
const RUN_BUDGET_MS   = 245000; // stop STARTING new subscribers after this (maxDuration 300)
/* v677 — THE RESERVE WAS 30s AGAINST A 125s WORST CASE, SO IT DID NOT BIND.
   One subscriber can spend, all from declared timeouts in this file: the access check
   (userCanAccessBrand makes TWO sequential requests at the 20s budget set below = 40s) +
   getBrandActivity 20s + loadBrandContext 20s + generate 10s (the floor) + push 15s +
   the last_sent_at PATCH 20s = 125s. Starting one with 30s left finishes at ~340s against
   maxDuration 300 — the platform kills the function, store.heartbeat() at the bottom is
   NEVER reached, and every subscriber the loop had not got to MISSES THAT DAY, because the
   due filter matches each of them at exactly one UTC hour. pull-trends-cron hit precisely
   this (a 504 before its heartbeat) and was given TWO guards; this file's comment says
   "same shape as pull-trends-cron" but only ever had the first one. Now it has both. */
const MIN_SLICE_MS    = 125000; // never START a subscriber without room for its worst case
const GEN_TIMEOUT_MS  = 75000;  // hard cap on ONE /api/generate-ideas call
const PUSH_TIMEOUT_MS = 15000;  // hard cap on ONE web-push delivery
const DB_TIMEOUT_MS   = 20000;  // hard cap on ONE Supabase request

module.exports = async function handler(req, res) {
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
      subs = await sbGet(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
        `/rest/v1/push_subscriptions?select=id,user_id,brand_id,subscription,send_hour,tz_offset_min,last_sent_at,motivation_on`);
    } catch (e) {
      console.error('send-daily: subscriber read FAILED — 0 pushes attempted this run:', (e && e.message) || e);
      return res.status(500).json({ error: 'subscriber read failed', detail: String((e && e.message) || e).slice(0, 200) });
    }

    const nowUtc = new Date();
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
      const localHour = ((nowUtc.getUTCHours() - ((Number(s.tz_offset_min) || 0) / 60)) % 24 + 24) % 24;
      if (Math.floor(localHour) !== s.send_hour) return false;
      if (s.last_sent_at &&
          localDayKey(new Date(s.last_sent_at), s.tz_offset_min) === localDayKey(nowUtc, s.tz_offset_min)) return false;
      const ep = (s.subscription && s.subscription.endpoint) || '';
      if (ep) { if (_seenEndpoint.has(ep)) return false; _seenEndpoint.add(ep); }
      return true;
    });

    // `skipped` = due subscribers we never got to because the run ran out of budget.
    // They are NOT retried: the next hourly run only matches their own send_hour, so a
    // skipped subscriber MISSES THAT DAY entirely. That is why it is counted and logged
    // instead of being lost inside a platform timeout.
    let sent = 0, failed = 0, skipped = 0, stampFailed = 0, brandDenied = 0, overLimit = 0, ranOut = false;
    const _t0 = Date.now();
    for (let i = 0; i < due.length; i++) {
      const left = RUN_BUDGET_MS - (Date.now() - _t0);
      if (left < MIN_SLICE_MS) { ranOut = true; skipped = due.length - i; break; }
      const sub = due[i];
      /* v677 guard 2 — the reserve above says whether we may START; this says we never
         OVERRUN, whatever the work is waiting on. Copied from pull-trends-cron's race, which
         exists because the reserve alone still let a run die before its heartbeat. `_over` is
         a sentinel rather than a rejection so nothing here can throw. An abandoned subscriber
         simply is not stamped and is picked up on their next slot — losing one ping beats
         losing the run's record and everyone after them. */
      const _subWork = (async () => {
      try {
        let payload;
        // THE ONE PLACE sub.brand_id becomes a fact. Everything below reads `brandId`;
        // nothing may touch sub.brand_id again, or the check is back to being optional.
        // A brand that does not check out resolves to null, which routes into the exact
        // generic-push path this code already takes for a subscription with no brand — so
        // the subscriber still gets their ping, it just carries nothing out of a brand they
        // are not entitled to.
        const brandId = await authorizedBrandId(sub);
        if (sub.brand_id && !brandId) {
          brandDenied++;
          /* v663: A REMOVED TEAM MEMBER GOT A DAILY PUSH FOREVER, WITH NO WAY TO STOP IT.
             removeMember deletes only the brand_members row. Nothing touches push_subscriptions,
             and the owner could not delete that row anyway — its RLS is auth.uid() = user_id. The
             orphan still matched the due filter (which looks only at the hour and last_sent_at), so
             authorizedBrandId correctly withheld the brand's CONTENT and the generic "Time to make
             something" went out regardless. Worse, the ex-member's app no longer lists that brand,
             so disableDailyPush's brand-scoped delete can never match the row: there is no switch
             anywhere in the product that turns it off.
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
          return;   // v677: inside the per-subscriber async function now — see guard 2
        }
        // Cap this subscriber's generation so it can never overrun the budget: we always
        // keep >= 15s of the slice for the push + the last_sent_at write. Measured AFTER the
        // access check so its round trips come out of THIS slice rather than the run's tail.
        // The 10s floor matters: postJson only arms a timeout when timeoutMs is truthy, so a
        // computed 0 (or negative) would mean NO timeout at all — the unbounded generate this
        // budget exists to prevent.
        const genMs = Math.max(10000, Math.min(GEN_TIMEOUT_MS, RUN_BUDGET_MS - (Date.now() - _t0) - 15000));
        // How long since they last made content? (re-engagement signal)
        const act = brandId
          ? await getBrandActivity(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, brandId)
          : { total: 0, posted: 0, lastCreated: null };
        const daysSince = act.lastCreated ? Math.floor((nowUtc - new Date(act.lastCreated)) / 86400000) : 999;

        if (daysSince >= 2 && sub.motivation_on !== false) {
          // Gone quiet + reminders on → motivational nudge (their real numbers, no idea gen).
          payload = JSON.stringify(motivationalPush(act, daysSince));
        } else {
          // Active → today's Quick Post idea (the existing behaviour).
          let bc = {};
          if (brandId) {
            // A failed brands read now THROWS (counted + logged as this subscriber's
            // failure) instead of silently leaving bc = {} and pushing a generic,
            // brand-less idea under the headline "Today's post is ready".
            // WAS: a hand-rolled `select=brand_name,voice_extra`. That is only the JSONB HALF of
            // the brain — everything stored as a COLUMN was silently missing: usps,
            // target_audience, tones, communities, competitors_text, banned_topics, website,
            // tagline, plus the derived approvedExamples and learnedSignals. So fullBrandBlock
            // rendered a profile with no "Voice / tones (NEVER contradict)", no audience, no key
            // facts and no "Topics to AVOID" — and this is the ONE post the app pushes unprompted
            // every day, which makes it the post most likely to be judged as "the app's output".
            // The shared hydrator reads all 28 fields; `trusted` exists for exactly this caller,
            // which has already verified ownership of brandId via authorizedBrandId() above.
            const _h = await require('./_brandctx').loadBrandContext(brandId, { trusted: true }, '');
            if (_h && _h.ok && _h.bc) bc = _h.bc;
            else throw new Error('brand context unavailable: ' + ((_h && _h.reason) || 'unknown'));
          }
          const host = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://contentshrimp.com';
          // NAME THE ACCOUNT THIS BRIEF IS FOR. generate-ideas used to skip both the usage
          // gate and the usage row for the CRON_SECRET caller, so roughly 30 generated briefs
          // a month went to every subscriber with push on — free, expired-trial or cancelled
          // alike — invisible to the plan limit, the cost fuse and the rate limiter. The secret
          // still identifies the CALLER; these two fields identify the ACCOUNT, and the brand id
          // is the one authorizedBrandId() has already verified against this row's own user_id
          // (never the raw, client-written sub.brand_id).
          // An over-limit account answers 402, which carries no `ideas` — so the code below
          // falls into the existing generic push and no generated content is delivered.
          /* v677 — THE PUSH SAID "TODAY'S POST" AND ASKED FOR NO PARTICULAR DAY.
             generate-ideas only pins a day when `gaps` is supplied, so the model chose freely
             from validDays (which includes 'Bonus'), while the app's Today screen derives the
             day from the browser clock. Tapping the notification could open a different day's
             plan than the one the brief was written for. Name the day, in the SUBSCRIBER's
             local time — this is their morning, not the server's. */
          const _localNow = new Date(nowUtc.getTime() - (Number(sub.tz_offset_min) || 0) * 60000);
          const _dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][_localNow.getUTCDay()];
          const gen = await postJson(`${host}/api/generate-ideas`,
            { count: 1, brandContext: bc, forUserId: sub.user_id, forBrandId: brandId || null,
              gaps: [{ day: _dayName }] },
            { Authorization: `Bearer ${cronSecret}` }, genMs);
          if (gen && gen.error === 'limit_reached') {
            overLimit++;
            console.log('send-daily: subscription ' + sub.id + ' is over its plan limit (' +
              gen.plan + ' ' + gen.used + '/' + gen.limit + ') — sending the generic push, no generated brief');
          }
          const idea = gen && gen.ideas && gen.ideas[0];
          payload = JSON.stringify(idea ? {
            title: `Today's post is ready`,
            body: `${idea.title} — "${(idea.hook || '').slice(0, 90)}"`,
            url: '/app.html'
          } : {
            title: 'Time to make something',
            body: 'One tap, one post — your Quick Post is waiting.',
            url: '/app.html'
          });
        }

        await webpush.sendNotification(sub.subscription, payload, { timeout: PUSH_TIMEOUT_MS });
        // The push DID go out, so this still counts as sent — but a failed last_sent_at
        // write means the 20h dedupe stamp is missing, which is worth knowing about.
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
        if (e.statusCode === 404 || e.statusCode === 410) {
          const del = await sbDelete(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, `/rest/v1/push_subscriptions?id=eq.${sub.id}`).catch(() => null);
          if (!del || del.status < 200 || del.status >= 300) {
            console.error('send-daily: could not delete expired subscription ' + sub.id + ' (' + ((del && del.status) || 'no response') + ')');
          }
        }
      }
      })();
      let _subT = null;
      const _over = await Promise.race([
        _subWork.then(() => false),
        new Promise(r => { _subT = setTimeout(() => r(true), Math.max(1000, RUN_BUDGET_MS - (Date.now() - _t0))); }),
      ]);
      try { if (_subT) clearTimeout(_subT); } catch (_) {}
      if (_over) {
        ranOut = true;
        skipped += (due.length - i);
        console.error('send-daily: subscription ' + (sub && sub.id) + ' outlived the run budget — abandoning it so the ' +
                      'heartbeat still gets written. It and the ' + (due.length - i - 1) + ' after it miss today.');
        break;
      }
    }

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
    await store.heartbeat('send-daily', _health, { checked: subs.length, due: due.length, sent, failed, skipped, stampFailed, brandDenied, overLimit, ranOut });
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
    return null;
  }
  if (!ok) {
    console.error('send-daily: SECURITY — subscription ' + sub.id + ' claims brand ' + sub.brand_id +
      ' but its own user ' + sub.user_id + ' has no access to that brand. Brand IGNORED (generic push sent). ' +
      'push_subscriptions.brand_id is client-written and unconstrained — audit this row.');
    return null;
  }
  return sub.brand_id;
}

// Brand activity: total ideas, how many were taken forward (posted), and the most recent.
// sbGet throws on a failed read, which is deliberate: silently returning zeros here used to
// flip an ACTIVE user into the "you've gone quiet, ${days} days" nudge — a push built from
// numbers we never actually read. A named failure beats a confidently wrong message.
async function getBrandActivity(base, key, brandId) {
  const rows = await sbGet(base, key,
    `/rest/v1/ideas?brand_id=eq.${encodeURIComponent(brandId)}&select=created_at,status&order=created_at.desc&limit=2000`);
  const arr = Array.isArray(rows) ? rows : [];
  const POSTED = ['approved', 'filming', 'editing', 'done', 'posted'];
  const posted = arr.filter(r => POSTED.includes(String(r.status || '').toLowerCase())).length;
  const lastCreated = arr.length ? arr[0].created_at : null;
  return { total: arr.length, posted, lastCreated };
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
// A timeout resolves null rather than throwing, so the caller still sends the generic
// fallback push — a plain ping beats no ping.
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
        resolve(null); // already settled, so the destroy-induced 'error' below is a no-op
      });
    }
    r.on('error', reject);
    r.write(data);
    r.end();
  });
}
