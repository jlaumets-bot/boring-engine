// On-demand: pull fresh, timely topic ideas for a brand from Google News RSS.
// Free (no paid API) — metered at 0 credits / 0 €. Returns clean topic strings the
// frontend merges into the brand's trend store, which flows into Ideas / Blog / Quick Post.
const { pullAllTrends, pullCompetitorPulse, scoreTrends } = require('./_trends');
const store = require('./_publish/store');
const COMP_STALE_MS = 7 * 24 * 3600 * 1000; // same weekly staleness rule as the cron

module.exports = async function handler(req, res) {
  const _t0 = Date.now(); // v454: time budget — everything below must fit the 60s maxDuration
  const allowed = ['https://contentshrimp.com', 'https://bettercontent.app', 'https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const _g = await require('./_usage').guard(req, 'pulltrends', res);
  if (!_g.user) return res.status(401).json({ error: 'Please sign in again.' });
  if (_g.over) return require('./_usage').denyResponse(res, _g.gate);

  try {
    let { keywords, brandId, windowHours, brandContext } = req.body || {};
    if (!Array.isArray(keywords)) keywords = [];
    keywords = keywords.map(k => String(k || '').trim()).filter(Boolean).slice(0, 3);
    if (!keywords.length) return res.status(400).json({ error: 'Add a topic or niche to track first.' });

    // Google News RSS (free) + X/Twitter via Apify (paid, only when APIFY_API_TOKEN is set).
    // Same merged feed the daily cron produces, so the button delivers what the UI promises.
    // windowHours = freshness cap (24 / 48 / 168 / 720); pullAllTrends clamps it.
    // The user is fine waiting a bit for X, so give it room to actually finish — but keep the whole
    // pull under this function's 60s maxDuration (News runs in parallel, ~10s). X is best-effort: if
    // Apify still isn't done by ~50s we return News + whatever X came back, never a timeout 500.
    // 5th arg = the brand brain (sent from the frontend) so Grok scopes + relevance-filters against it.
    // 6th arg (v453) = the Grok lane's OWN budget: callGrokSearch allows 90s internally, so without
    // its own 35s race cap the Grok lane regularly lost the shared 50s race and returned nothing.
    const items = await pullAllTrends(keywords, process.env.APIFY_API_TOKEN, windowHours, 50000, brandContext, 35000);

    // Only attribute the usage row to a brand the caller actually owns.
    let logBrandId = null;
    if (brandId) {
      try { if (await store.userCanAccessBrand(_g.user.id, brandId)) logBrandId = brandId; } catch (e) {}
    }
    await require('./_usage').logUsage({ userId: _g.billingUserId || _g.user.id, brandId: logBrandId, action: 'pulltrends', model: process.env.APIFY_API_TOKEN ? 'news+x-apify' : 'google-news-rss' });

    // v454: refresh the WEEKLY competitor pulse from the manual pull too. It was cron-only
    // (v383), so the "Competitor moves" panel stayed stale no matter how often the user hit
    // Pull trends. Strictly best-effort + time-budgeted: only runs when the trends part
    // finished fast enough to leave ≥15s of the 60s maxDuration, capped at 20s, fail-open —
    // the trends response above can never be delayed past the function limit or broken by it.
    let competitorMoves = null, compAt = null;
    if (logBrandId && process.env.XAI_API_KEY) {
      try {
        const left = 55000 - (Date.now() - _t0);
        if (left >= 15000) {
          const br = (((await store.rest('GET', `/brands?id=eq.${encodeURIComponent(logBrandId)}&select=auto_trends,competitors_text,voice_extra`)) || {}).data || [])[0];
          const comp = String((br && (br.competitors_text || (br.voice_extra && br.voice_extra.competitors))) || '').trim();
          const at = (br && br.auto_trends && typeof br.auto_trends === 'object') ? br.auto_trends : {};
          const stale = !at.competitorMoves || (Date.now() - (at.compAt || 0)) > COMP_STALE_MS;
          if (br && comp && stale) {
            const digest = await pullCompetitorPulse(comp, { timeoutMs: Math.min(20000, left - 2000) });
            if (digest) {
              // Merge into the existing auto_trends payload — items/at stay untouched.
              const merged = Object.assign({}, at, { competitorMoves: digest, compAt: Date.now() });
              // v683 — the SECOND write in this handler got the status check in v682; this one was
              // missed. store.rest resolves on every status, and `Prefer: return=minimal` means the
              // status is the only evidence a write happened at all. The two lines below repainted
              // the "Competitor moves" panel with a fresh pulse that was never saved: the next
              // reload showed the stale one again, and compAt never advanced server-side so the
              // weekly refresh did not retry either. Only claim it when the row actually changed.
              const _cup = await store.rest('PATCH', `/brands?id=eq.${encodeURIComponent(logBrandId)}`, { body: { auto_trends: merged }, headers: { Prefer: 'return=minimal' } });
              if (_cup && _cup.status >= 200 && _cup.status < 300) {
                competitorMoves = digest; compAt = merged.compAt;
              } else {
                console.error('pull-trends: competitor pulse PATCH ' + ((_cup && _cup.status) || 'no response') +
                              ' — not saved, keeping the previous pulse on screen');
              }
            }
          }
        }
      } catch (e) { /* fail-open — never touches the trends result */ }
    }

    // v453: per-lane raw counts (pre-dedupe) so the frontend + logs can tell "sources empty"
    // apart from "endpoint broken". pullAllTrends attaches them to the returned array.
    // Persist the pulled items to the brand's auto_trends so the "Auto-pulled" panel refreshes
    // straight from this button — no waiting for the nightly cron.
    let savedItems = 0, savedAuto = null;
    if (logBrandId && Array.isArray(items) && items.length) {
      try {
        const _now = Date.now();
        /* v682 — AN UNCHECKED READ TURNED THIS MERGE INTO A DELETE. store.rest RESOLVES on
           every HTTP status (it only rejects on a socket error), so a 5xx or a stall left
           `_br` undefined and `_at` as {} — and Object.assign onto {} drops every key this
           pull does not set: competitorMoves, compAt and topPosts, all written by the nightly
           cron. One failed read on a manual "Pull trends" tap wiped the weekly competitor
           pulse. A merge onto an unknown base is not a merge; refuse it. */
        const _brRes = await store.rest('GET', `/brands?id=eq.${encodeURIComponent(logBrandId)}&select=auto_trends`);
        if (!_brRes || _brRes.status < 200 || _brRes.status >= 300) {
          throw new Error('could not read the current auto_trends (' + ((_brRes && _brRes.status) || 'no response') +
                          ') — refusing to merge onto an unknown base and lose the cron\'s competitor pulse');
        }
        const _br = ((_brRes.data) || [])[0];
        const _at = (_br && _br.auto_trends && typeof _br.auto_trends === 'object') ? _br.auto_trends : {};
        const _prev = (Array.isArray(_at.items) ? _at.items : []).map(i => i && i.text).filter(Boolean);
        const _scored = scoreTrends(items, _prev, []);
        const _merged = Object.assign({}, _at, {
          at: _now,
          items: _scored.map(it => ({ text: it.text, source: it.source || '', link: String(it.link || '').slice(0, 400), ts: it.ts || _now, hot: !!it.hot }))
        });
        // v644b: the "Worth making yours" posts come out of THIS pull too, so the button fills the
        // strip instead of leaving it to the nightly cron. Same clamping as pull-trends-cron.
        // Written ONLY when this pull actually produced posts — assigning an empty array would
        // wipe a good set from the cron whenever the X lane comes back empty (no Apify token, a
        // stalled run, a keyword with no recent posts). Absent key => Object.assign keeps the old one.
        const _tp = (Array.isArray(items.topPosts) ? items.topPosts : []).slice(0, 5).map(p => ({
          text: String(p.text || '').slice(0, 600),
          handle: String(p.handle || '').slice(0, 40),
          link: String(p.link || '').slice(0, 400),
          likes: p.likes || 0, reposts: p.reposts || 0, ts: p.ts || _now,
        }));
        if (_tp.length) _merged.topPosts = _tp;
        // v682: store.rest resolves on every status, so an unchecked PATCH let the log below
        // report "saved N items" for a write that never happened.
        const _up = await store.rest('PATCH', `/brands?id=eq.${encodeURIComponent(logBrandId)}`, { body: { auto_trends: _merged }, headers: { Prefer: 'return=minimal' } });
        if (!_up || _up.status < 200 || _up.status >= 300) {
          throw new Error('auto_trends PATCH ' + ((_up && _up.status) || 'no response') + ' — nothing was saved');
        }
        savedItems = _merged.items.length; savedAuto = _merged;
        console.log('pull-trends: saved ' + savedItems + ' items to auto_trends for brand ' + logBrandId +
                    ' (' + _merged.items.filter(i => i.link).length + ' with source links)');
      } catch (e) { console.log('pull-trends: could not save auto_trends — ' + e.message); }
    }

    // v454: competitorMoves/compAt ride along ONLY when the pulse actually refreshed, so the
    // frontend can update the panel without a reload.
    return res.status(200).json(Object.assign(
      { items, lanes: items.lanes || { grok: 0, news: 0, x: 0 }, savedItems, autoTrends: savedAuto },
      competitorMoves ? { competitorMoves, compAt } : {}
    ));
  } catch (e) {
    console.error('pull-trends error:', e);
    return res.status(500).json({ error: 'Could not pull trends just now — try again.' });
  }
};
