// Daily cron: refresh each brand's auto-pulled trend feed from Google News RSS,
// stored server-side in brands.auto_trends so it flows into generation for EVERY
// user with zero interaction. Free (no paid API). Requires a jsonb column:
//   ALTER TABLE public.brands ADD COLUMN IF NOT EXISTS auto_trends jsonb;
const store = require('./_publish/store');
// v454: the competitor pulse moved into _trends.js (pullCompetitorPulse) so the
// on-demand pull-trends.js can refresh a stale pulse too — same prompt, same rules.
const { pullAllTrends, scoreTrends, pullCompetitorPulse } = require('./_trends');
const COMP_STALE_MS = 7 * 24 * 3600 * 1000; // competitor pulse refreshes weekly

const STALE_MS = 20 * 3600 * 1000; // only refresh brands not refreshed in ~a day
const CAP = 30;                    // brands per run (oldest first) — cycles over days
const CONC = 2;                    // parallel brands per batch
// v657 — WAS 4, AND THAT IS WHY THE X LANE RETURNED NOTHING. Each brand launches its own
// Apify tweet-scraper run, and the Apify plan allows 5 CONCURRENT ACTOR RUNS. At CONC=4 the
// batch tripped that ceiling and Apify answered 402 "concurrent-runs-limit-exceeded" — which
// _trends.js logs as "OUT OF CREDITS / payment required", so the real cause was mislabelled in
// the logs for as long as it has been happening. Observed 2026-09-13: five 402s in one run,
// every x-lane result "10 raw, 0 kept". The feature produced nothing and /api/health stayed
// green, because a lane returning zero items is not an error anywhere.
// 2 leaves headroom for the retry the scraper makes on a slow run.

// Best news-search terms come from the brand's niche/communities, not its name.
function deriveKeywords(b) {
  const candidates = [];
  const comm = b.communities;
  if (Array.isArray(comm)) candidates.push(...comm.map(String));
  else if (typeof comm === 'string' && comm.trim()) candidates.push(comm);
  if (b.target_audience) candidates.push(String(b.target_audience));
  // Pain points = what the audience actually searches for → a strong, varied query angle. Grok now
  // relevance-filters the results against the brain, so widening the angles only helps coverage.
  const ve = (b.voice_extra && typeof b.voice_extra === 'object') ? b.voice_extra : {};
  if (ve.painPoints) candidates.push(String(ve.painPoints));
  if (b.usps) candidates.push(String(b.usps));
  if (!candidates.length && b.brand_name) candidates.push(String(b.brand_name));

  const seen = new Set(); const kws = [];
  for (let raw of candidates) {
    raw = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!raw) continue;
    // v453: cut on a natural PHRASE boundary first (comma/semicolon/period/dash/pipe), then cap
    // length — the old blind "first 5 words" turned prose fields into junk queries like
    // "We help small e-commerce brands". Multi-word phrases go double-quoted so the News query
    // searches the PHRASE, not scattered words.
    let phrase = raw.split(/[,;.·|]|\s[—–-]\s/)[0].replace(/\s+/g, ' ').trim();
    const words = phrase.split(' ');
    if (words.length > 6) phrase = words.slice(0, 6).join(' ');
    phrase = phrase.replace(/["“”]/g, '').trim();
    if (!phrase || phrase.length < 3) continue;
    const k = phrase.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    kws.push(phrase.includes(' ') ? `"${phrase}"` : phrase);
    if (kws.length >= 3) break;
  }
  return kws;
}

module.exports = async function handler(req, res) {
  // See send-daily for the reasoning. Here the 4s default cut the per-brand approved-titles read
  // that feeds trend preference scoring; that read is best-effort (try/catch -> []), so the only
  // symptom was trends silently losing their preference weighting — invisible from the outside.
  // This handler already self-limits to BUDGET_MS (270s) so raising the per-call ceiling cannot
  // push the run past its own budget.
  try { require('./_publish/store').setRequestBudget(20000); } catch (_) {}
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || (req.headers.authorization || '') !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    // NOTE: competitors are stored in the `competitors_text` COLUMN (settingsToBrand), NOT in voice_extra —
    // must select it explicitly or the competitor pulse + gap-angle scoping below see nothing.
    const r = await store.rest('GET', `/brands?select=id,brand_name,usps,target_audience,communities,auto_trends,voice_extra,competitors_text`);
    // Same class as the PATCH below: store.rest resolves on EVERY status, so an unchecked
    // read turned a broken/denied query into `brands = []` -> due = [] -> {ok:true,
    // considered:0} with an 'ok' heartbeat. A failed read is not "no brands are due".
    // Deliberately NO heartbeat on this path — job_heartbeats.last_success_at must only
    // ever mean a run actually succeeded, because that staleness is what /api/health reads.
    if (!r || r.status < 200 || r.status >= 300) {
      console.error('pull-trends-cron: brands read FAILED (' + ((r && r.status) || 'no response') + ') — 0 brands processed:', String((r && r.raw) || '').slice(0, 200));
      return res.status(500).json({ error: 'brands read failed' });
    }
    const brands = Array.isArray(r.data) ? r.data : [];
    const now = Date.now();

    const due = brands
      .filter(b => { const at = b.auto_trends && b.auto_trends.at; return !at || (now - at) > STALE_MS; })
      .sort((a, c) => ((a.auto_trends && a.auto_trends.at) || 0) - ((c.auto_trends && c.auto_trends.at) || 0))
      .slice(0, CAP);

    // `failed` is tracked SEPARATELY from `skipped`: a skip is a legitimate no-op (no keywords,
    // no items, out of budget), a failure is a thrown error. Lumping them together meant a
    // systematic breakage reported {ok:true, updated:0, skipped:30} with an 'ok' heartbeat and
    // not one log line — which is exactly how this cron died silently for days at a time.
    let updated = 0, skipped = 0, failed = 0, ranOut = false;
    // v670 — WHY a brand was skipped, and WHICH LANE went quiet.
    // `skipped` lumped three different things together: no keywords (a brand that is not set up),
    // no items (every source returned nothing), and out of budget. Only the middle one can mean
    // the app is broken, and it was invisible — so a run where EVERY source failed for EVERY brand
    // reported {ok:true, updated:0, skipped:30} with an 'ok' heartbeat, which is the exact silent
    // death this file has already been fixed for twice, reached by a third road.
    // `pullAllTrends` has always returned per-lane counts on `items.lanes` (api/_trends.js) and
    // NOTHING read them. They are the difference between "Apify is down" and "Grok is down".
    let skipNoKeywords = 0, skipNoItems = 0;
    const laneTotals = { grok: 0, news: 0, x: 0 };
    // This cron was killed by the 120s platform limit on 7 of 7 days (Vercel runtime errors),
    // so trends never refreshed and every brand kept its stale auto_trends — which is why the
    // v600b "sources" fix never showed up in the UI. maxDuration is now 300; this budget stops
    // us cleanly at 270s so we always heartbeat and report, instead of dying mid-batch.
    /* v662: THE BUDGET WAS CHECKED BETWEEN BATCHES ONLY, SO IT DID NOT BIND.
       Production, 2026-09-16 05:35: `GET /api/pull-trends-cron 504 — Vercel Runtime Timeout Error:
       Task timed out after 300 seconds`. A 504 is the worst possible outcome here, because the
       function dies BEFORE store.heartbeat() — so nothing is recorded, /api/health goes red with
       `never-run`-shaped silence, and the next run learns nothing from this one. The whole reason
       the heartbeat exists is to make a bad run legible, and a timeout skips it.
       The old guard only asked "am I past 270s?" at a batch BOUNDARY. A batch that starts at 260s
       and takes 50s sails straight past 300. Each brand runs several Apify lanes with
       waitForFinish=40 (api/_trends.js), and when Apify queues a run (status=READY, seen in the
       same logs) those 40 seconds are spent waiting and produce nothing — so a slow batch is the
       normal case on a bad day, not the edge.
       TWO GUARDS NOW, because either alone still overruns:
         1. RESERVE — do not START a batch unless enough time remains to finish a worst-case one.
         2. RACE — never let a batch outlive the time actually left, whatever it is doing.
       The race abandons in-flight lane work, which is safe: every brand's work is wrapped in its
       own try/catch and writes only at the end, so an abandoned brand simply is not updated and
       is picked up next run. Losing one brand's refresh beats losing the whole run's record. */
    const BUDGET_MS = 270000, WORST_BATCH_MS = 75000, _cronT0 = Date.now();
    const _left = () => BUDGET_MS - (Date.now() - _cronT0);
    for (let i = 0; i < due.length; i += CONC) {
      if (_left() <= WORST_BATCH_MS) { ranOut = true; skipped += (due.length - i); break; }
      const batch = due.slice(i, i + CONC);
      let _batchT = null;
      const _work = Promise.all(batch.map(async (b) => {
        try {
          const kws = deriveKeywords(b);
          if (!kws.length) { skipped++; skipNoKeywords++; return; }
          // Normalize competitors onto b.competitors so brainSummaryFrom(o.competitors) — used by
          // pullGrokTrends for gap-angle scoping — and the pulse below both see the real value.
          b.competitors = (b.competitors_text || (b.voice_extra && b.voice_extra.competitors) || '').toString().trim();
          // Read this brand's recent APPROVED idea topics (best-effort) → (a) attached to the brain so
          // Grok favors them, (b) passed to scoreTrends so the merged feed ranks by demonstrated
          // preference. Any query failure just skips the boost (never breaks the pull).
          let prefTexts = [];
          try {
            const ir = await store.rest('GET', `/ideas?select=title&brand_id=eq.${b.id}&status=in.(filming,done)&limit=25`);
            prefTexts = ((ir && ir.data) || []).map(r => r && r.title).filter(Boolean);
            if (prefTexts.length) b.learnedSignals = 'Recently APPROVED (favor angles like these): ' + prefTexts.slice(0, 10).join(' · ');
          } catch (_) {}
          // Google News RSS (free) + X/Twitter posts via Apify (paid, only if a token is set),
          // merged + deduped by the shared helper so the cron and the on-demand button match.
          // 5th arg = the brand row itself, so Grok web-search scopes + relevance-filters against the
          // full brain (niche, audience, USPs, pain points, avoid) — not just the thin derived keywords.
          /* v675 — THE GROK LANE WAS UNBOUNDED, AND IT ATE THE WHOLE RUN.
             pullAllTrends' 4th and 6th arguments are the X and Grok lane timeouts; both were
             passed as undefined, so `bound()` applied NO race and the lane ran until
             callGrokSearch's own 90s socket timeout — longer than the WORST_BATCH_MS reserve
             this loop sets aside (75s). Production on 2026-09-18 05:35: every grok call timed
             out or hung up, the run spent all 270000ms, and it finished "updated 0, 8 left"
             with lanes grok=0 news=0 x=0. Twelve brands, nothing written, every night.
             Bound both lanes to the time this run ACTUALLY has left, minus a margin for the
             write that follows. A lane that cannot answer in time yields an empty lane instead
             of taking the other two down with it. */
          const _laneMs = Math.max(8000, Math.min(45000, _left() - 25000));
          const items = await pullAllTrends(kws, process.env.APIFY_API_TOKEN, undefined, _laneMs, b, _laneMs);
          // v670: record the per-lane counts BEFORE the empty check — that is the whole point of
          // them, and the empty case is exactly when they matter.
          try {
            const L = items && items.lanes;
            if (L) { laneTotals.grok += (L.grok || 0); laneTotals.news += (L.news || 0); laneTotals.x += (L.x || 0); }
          } catch (_) {}
          if (!items.length) {
            skipped++; skipNoItems++;
            const L = (items && items.lanes) || {};
            console.error('pull-trends-cron: brand ' + b.id + ' (' + (b.brand_name || 'unnamed') +
              ') got NOTHING from any source — lanes grok=' + (L.grok || 0) + ' news=' + (L.news || 0) +
              ' x=' + (L.x || 0) + ' keywords=' + kws.length);
            return;
          }
          // Velocity: compare against the brand's PREVIOUS pull to flag what's newly
          // rising, and sort hottest-first (scoreTrends uses the items' real recency).
          const prevTexts = ((b.auto_trends && Array.isArray(b.auto_trends.items)) ? b.auto_trends.items : []).map(i => i && i.text).filter(Boolean);
          const scored = scoreTrends(items, prevTexts, prefTexts);
          // v453: persist each item's REAL timestamp (News pubDate / tweet ts) — writing `now` for
          // every item destroyed the recency data the TTL filter + velocity scoring rely on.
          // v683 — auto_trends is ONE json column, and this PATCH replaces the whole of it. Building
          // the payload from scratch silently dropped every key not re-added below. Start from the
          // brand's existing object so a key this cron does not know about survives the night.
          const _prevAuto = (b.auto_trends && typeof b.auto_trends === 'object' && !Array.isArray(b.auto_trends)) ? b.auto_trends : {};
          const payload = Object.assign({}, _prevAuto, { at: now, items: scored.map(it => ({ text: it.text, source: it.source || '', link: String(it.link || '').slice(0, 400), ts: it.ts || now, hot: !!it.hot })) });
          // v644 — posts worth repurposing, from the SAME pull the trends came from (no extra cost).
          // Kept separate from `items` on purpose: a trend is a topic that feeds the brain, this is a
          // specific post the user can act on. Empty when the scraper returns no engagement data,
          // which keeps the strip honest rather than showing an unranked list as a "top 5".
          // v683 — THIS ASSIGNMENT WAS UNCONDITIONAL AND IT WIPED THE STRIP EVERY NIGHT.
          // _trends.js:502 sets topPosts to [] whenever the X/Apify lane comes back as a plain
          // array — no APIFY_API_TOKEN, a stalled actor run, the bound() race timing out, or no
          // post clearing topXPosts' engagement filter. The Grok and News lanes still return
          // trends, so items.length > 0 and the skip above does NOT fire: the brand is "updated"
          // and every post the user was going to repurpose is erased. Measured: a pull with
          // lanes grok=0 news=2 x=0 took auto_trends.topPosts from 2 posts to 0, for every brand,
          // silently, with nowhere else to recover them from. The manual button has had the guard
          // since v644b (pull-trends.js:111) and says why in its own comment; the cron never got it.
          // Absent key => Object.assign above keeps the previous strip.
          const _tp = (Array.isArray(items.topPosts) ? items.topPosts : []).slice(0, 5).map(p => ({
            text: String(p.text || '').slice(0, 600),
            handle: String(p.handle || '').slice(0, 40),
            link: String(p.link || '').slice(0, 400),
            likes: p.likes || 0, reposts: p.reposts || 0, ts: p.ts || now,
          }));
          if (_tp.length) payload.topPosts = _tp;

          // Competitor pulse (light, weekly): once every ~7 days, ask Grok what the
          // brand's listed competitors have DONE lately. Stored alongside the trends
          // (no new column), carried forward on the other days. Needs competitors +
          // an XAI key; skips silently otherwise.
          const comp = (b.competitors || '').toString().trim();
          const prevMoves = (b.auto_trends && b.auto_trends.competitorMoves) || '';
          const compAt = (b.auto_trends && b.auto_trends.compAt) || 0;
          payload.competitorMoves = prevMoves;
          payload.compAt = compAt;
          if (comp && process.env.XAI_API_KEY && (!prevMoves || (now - compAt) > COMP_STALE_MS)) {
            try {
              /* v675 — "no timeout here, the cron has the full 120s budget" was written when
                 this ran alone. It is a SECOND unbounded 90s grok call, after the lane pull, on
                 the same clock — see the note on _laneMs above. pullCompetitorPulse already
                 accepts opts.timeoutMs and resolves '' when it expires; use it. */
              const digest = await pullCompetitorPulse(comp, { timeoutMs: Math.max(5000, Math.min(30000, _left() - 20000)) });
              if (digest) { payload.competitorMoves = digest; payload.compAt = now; }
            } catch (e) { /* keep prevMoves */ }
          }
          const up = await store.rest('PATCH', `/brands?id=eq.${b.id}`, { body: { auto_trends: payload }, headers: { Prefer: 'return=minimal' } });
          // store.rest RESOLVES on every http status (it only rejects on a socket error), so
          // an unchecked PATCH let `updated++` run even when nothing was written: a run where
          // EVERY write failed still reported "updated: N" with an 'ok' heartbeat. Throwing
          // hands it to the per-brand catch below, which counts it as `failed` and names the
          // brand — which is what makes the (failed && !updated) heartbeat status real.
          if (up.status < 200 || up.status >= 300) {
            throw new Error('auto_trends PATCH ' + up.status + ' ' + String(up.raw || '').slice(0, 160));
          }
          updated++;
        } catch (e) {
          failed++;
          console.error('pull-trends-cron: brand ' + (b && b.id) + ' (' + ((b && b.brand_name) || 'unnamed') + ') failed — ' + ((e && e.message) || e));
        }
      }));
      // Guard 2. Whatever the batch is waiting on, it does not get to spend time this function
      // does not have. `_over` is a sentinel rather than a rejection so nothing here can throw.
      const _over = await Promise.race([
        _work.then(() => false),
        new Promise(r => { _batchT = setTimeout(() => r(true), Math.max(1000, _left())); }),
      ]);
      try { if (_batchT) clearTimeout(_batchT); } catch (_) {}
      if (_over) {
        ranOut = true;
        skipped += (due.length - i);
        console.error('pull-trends-cron: batch at index ' + i + ' outlived the run budget — abandoning it so the heartbeat still gets written. ' +
                      'Brands in that batch are unchanged and will be picked up next run.');
        break;
      }
    }

    if (ranOut) console.log('pull-trends-cron: ran out of budget after ' + (Date.now() - _cronT0) + 'ms — updated ' + updated + ', ' + skipped + ' left for the next run');
    if (failed) console.error('pull-trends-cron: ' + failed + ' of ' + due.length + ' brand(s) FAILED this run (see the per-brand errors above)');
    console.log('pull-trends-cron: lanes this run — grok=' + laneTotals.grok + ' news=' + laneTotals.news +
      ' x=' + laneTotals.x + ' | updated=' + updated + ' skipped=' + skipped +
      ' (noKeywords=' + skipNoKeywords + ', noItems=' + skipNoItems + ') failed=' + failed);

    // v670 — EVERY SOURCE SILENT IS A FAILURE, NOT A SKIP.
    // A run where brands were due, none failed outright, and not one of them got a single item
    // from any source is a systematic breakage (a rejected Apify token, a dead RSS host, Grok
    // returning null) — not thirty independent no-ops. It used to heartbeat 'ok', so /api/health
    // stayed green while the trends feed quietly stopped updating for everyone.
    // A brand with no keywords is NOT evidence of that: it simply is not set up yet.
    const _triedBrands = due.length - skipNoKeywords - (ranOut ? Math.max(0, skipped - skipNoKeywords - skipNoItems) : 0);
    const _allSilent = _triedBrands > 0 && updated === 0 && skipNoItems >= _triedBrands;
    if (_allSilent) {
      console.error('pull-trends-cron: EVERY source returned nothing for all ' + _triedBrands +
        ' brand(s) that were actually tried — lanes grok=' + laneTotals.grok + ' news=' + laneTotals.news +
        ' x=' + laneTotals.x + '. That is a systematic failure, not a quiet day.');
    }
    const _health = ((failed && !updated) || _allSilent) ? 'error' : 'ok';
    const _meta = { considered: due.length, updated, skipped, failed, ranOut,
                    skipNoKeywords, skipNoItems, lanes: laneTotals, allSilent: _allSilent };
    await store.heartbeat('pull-trends-cron', _health, _meta);
    return res.status(200).json(Object.assign({ ok: !_allSilent }, _meta));
  } catch (e) {
    console.error('pull-trends-cron error:', e);
    return res.status(500).json({ error: 'cron failed' });
  }
};
