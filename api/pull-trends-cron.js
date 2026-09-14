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
    // This cron was killed by the 120s platform limit on 7 of 7 days (Vercel runtime errors),
    // so trends never refreshed and every brand kept its stale auto_trends — which is why the
    // v600b "sources" fix never showed up in the UI. maxDuration is now 300; this budget stops
    // us cleanly at 270s so we always heartbeat and report, instead of dying mid-batch.
    const BUDGET_MS = 270000, _cronT0 = Date.now();
    for (let i = 0; i < due.length; i += CONC) {
      if (Date.now() - _cronT0 > BUDGET_MS) { ranOut = true; skipped += (due.length - i); break; }
      const batch = due.slice(i, i + CONC);
      await Promise.all(batch.map(async (b) => {
        try {
          const kws = deriveKeywords(b);
          if (!kws.length) { skipped++; return; }
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
          const items = await pullAllTrends(kws, process.env.APIFY_API_TOKEN, undefined, undefined, b);
          if (!items.length) { skipped++; return; }
          // Velocity: compare against the brand's PREVIOUS pull to flag what's newly
          // rising, and sort hottest-first (scoreTrends uses the items' real recency).
          const prevTexts = ((b.auto_trends && Array.isArray(b.auto_trends.items)) ? b.auto_trends.items : []).map(i => i && i.text).filter(Boolean);
          const scored = scoreTrends(items, prevTexts, prefTexts);
          // v453: persist each item's REAL timestamp (News pubDate / tweet ts) — writing `now` for
          // every item destroyed the recency data the TTL filter + velocity scoring rely on.
          const payload = { at: now, items: scored.map(it => ({ text: it.text, source: it.source || '', link: String(it.link || '').slice(0, 400), ts: it.ts || now, hot: !!it.hot })) };
          // v644 — posts worth repurposing, from the SAME pull the trends came from (no extra cost).
          // Kept separate from `items` on purpose: a trend is a topic that feeds the brain, this is a
          // specific post the user can act on. Empty when the scraper returns no engagement data,
          // which keeps the strip honest rather than showing an unranked list as a "top 5".
          payload.topPosts = (Array.isArray(items.topPosts) ? items.topPosts : []).slice(0, 5).map(p => ({
            text: String(p.text || '').slice(0, 600),
            handle: String(p.handle || '').slice(0, 40),
            link: String(p.link || '').slice(0, 400),
            likes: p.likes || 0, reposts: p.reposts || 0, ts: p.ts || now,
          }));

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
              // Shared helper (v454, _trends.js) — same prompt as before; no timeout here,
              // the cron has the full 120s budget. Resolves '' on any failure.
              const digest = await pullCompetitorPulse(comp);
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
    }

    if (ranOut) console.log('pull-trends-cron: ran out of budget after ' + (Date.now() - _cronT0) + 'ms — updated ' + updated + ', ' + skipped + ' left for the next run');
    if (failed) console.error('pull-trends-cron: ' + failed + ' of ' + due.length + ' brand(s) FAILED this run (see the per-brand errors above)');
    // A run where nothing updated but brands failed is NOT healthy — say so in the heartbeat.
    const _health = (failed && !updated) ? 'error' : 'ok';
    await store.heartbeat('pull-trends-cron', _health, { considered: due.length, updated, skipped, failed, ranOut });
    return res.status(200).json({ ok: true, considered: due.length, updated, skipped, failed, ranOut });
  } catch (e) {
    console.error('pull-trends-cron error:', e);
    return res.status(500).json({ error: 'cron failed' });
  }
};
