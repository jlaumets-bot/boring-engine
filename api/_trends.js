// Shared trend fetcher: Google News RSS (free) + X/Twitter (Apify, paid).
// Used by both the on-demand endpoint (pull-trends.js) and the daily cron
// (pull-trends-cron.js). Every source is time-windowed so only FRESH items come
// back — default 48h, adjustable to 24h / 48h / 1 week / 1 month (no further back).
// News URLs are built here from keywords only (never a user URL) → no SSRF surface.
const https = require('https');

// Recency window (hours). The UI exposes exactly these; the API clamps to them.
const DEFAULT_WINDOW_HOURS = 48;
const ALLOWED_WINDOW_HOURS = [24, 48, 168, 720]; // 24h · 48h · 1 week · 1 month
function clampWindow(h) {
  const n = parseInt(h, 10);
  return ALLOWED_WINDOW_HOURS.includes(n) ? n : DEFAULT_WINDOW_HOURS;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(parseInt(n, 10)); } catch (_) { return ''; } })
    .trim();
}

function parseRssItems(xml) {
  const out = [];
  const items = String(xml || '').split(/<item>/i).slice(1);
  for (const chunk of items.slice(0, 12)) {
    const rawTitle = (chunk.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '';
    const rawLink = (chunk.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || '';
    const rawDate = (chunk.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1] || '';
    let title = decodeEntities(rawTitle);
    let source = '';
    const dash = title.lastIndexOf(' - ');
    if (dash > 20) { source = title.slice(dash + 3).trim(); title = title.slice(0, dash).trim(); }
    if (!title || title.length < 8) continue;
    const pubDate = decodeEntities(rawDate);
    const ts = pubDate ? Date.parse(pubDate) : NaN;
    out.push({ text: title.slice(0, 140), source, link: decodeEntities(rawLink), pubDate, ts: isNaN(ts) ? 0 : ts });
  }
  return out;
}

// hours → the Google News `when:` operator (server-side recency filter).
function newsWhen(maxAgeHours) {
  const days = Math.max(1, Math.ceil(clampWindow(maxAgeHours) / 24));
  return `when:${days}d`;
}

function fetchNewsRss(query, maxAgeHours) {
  return new Promise((resolve) => {
    const q = encodeURIComponent(`${String(query).slice(0, 110)} ${newsWhen(maxAgeHours)}`.trim());
    const req = https.request({
      hostname: 'news.google.com',
      path: `/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ContentShrimp/1.0)', 'Accept': 'application/rss+xml, application/xml, text/xml' },
      timeout: 10000,
    }, (resp) => {
      /* v675 — SAY WHY. Three exits in this function resolved an empty list with no log at
         all, so a redirect, a transport error and a timeout were indistinguishable from "the
         news had nothing" — and the cron's own summary then reported news=0 for every brand
         with nothing to explain it. Same rule the grok lane was given in v670. */
      if (resp.statusCode >= 300 && resp.statusCode < 400) {
        console.error('_trends: news RSS redirected (' + resp.statusCode + ' → ' + String(resp.headers && resp.headers.location || '?').slice(0, 120) + ') — lane empty for "' + String(query).slice(0, 60) + '"');
        resp.resume(); return resolve({ items: [] });
      }
      if (resp.statusCode !== 200) {
        console.error('_trends: news RSS http ' + resp.statusCode + ' — lane empty for "' + String(query).slice(0, 60) + '"');
        resp.resume(); return resolve({ items: [] });
      }
      let data = ''; let bytes = 0;
      // req.destroy() with no error argument emits 'close', NOT 'error', and suppresses 'end' —
      // so the old cap branch left this promise UNSETTLED and the whole trends pull hung until
      // the platform killed it. Parse what we already have (truncate-and-use), then destroy.
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      resp.on('data', (c) => {
        bytes += c.length;
        if (bytes > 2_000_000) {
          console.log('_trends: news RSS response hit the 2MB cap — parsing the first 2MB');
          done({ items: parseRssItems(data) });
          req.destroy();
          return;
        }
        data += c;
      });
      resp.on('end', () => done({ items: parseRssItems(data) }));
    });
    req.on('error', (e) => {
      console.error('_trends: news RSS request failed — ' + ((e && e.message) || e) + ' — lane empty for "' + String(query).slice(0, 60) + '"');
      resolve({ items: [] });
    });
    req.on('timeout', () => {
      console.error('_trends: news RSS timed out after 10s — lane empty for "' + String(query).slice(0, 60) + '"');
      req.destroy(); resolve({ items: [] });
    });
    req.end();
  });
}

// Google News, windowed. Runs up to 3 keyword searches in parallel, drops anything
// older than the window (belt-and-braces with the `when:` operator), dedupes, ≤10.
async function pullTrends(keywords, maxAgeHours) {
  const kw = (Array.isArray(keywords) ? keywords : [])
    .map(k => String(k || '').trim()).filter(Boolean).slice(0, 3);
  if (!kw.length) return [];
  const win = clampWindow(maxAgeHours);
  const cutoff = Date.now() - win * 3600 * 1000;
  const results = await Promise.all(kw.map(k => fetchNewsRss(k, win)));
  const seen = new Set(); const items = [];
  for (const r of results) {
    for (const it of (r.items || [])) {
      if (it.ts && it.ts < cutoff) continue; // hard recency guarantee
      const norm = it.text.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      items.push(it);
    }
  }
  return items.slice(0, 10);
}

// ===== X / TWITTER LATEST POSTS (Apify) =====
// Pulls the LATEST real tweets for a keyword via Apify's tweet-scraper
// (searchTerms + sort:Latest), windowed to the requested freshness. Costs Apify
// credits. Never rejects; returns [] with no token / on any error.
// Returned items match pullTrends() shape + a real `ts`: { text, source, link, ts }.
function apifyReq(method, path, token, body) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.apify.com', path, method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 95000,
    }, (resp) => {
      let data = ''; let bytes = 0;
      // Same never-settling trap as fetchNewsRss: a bare req.destroy() emits 'close', not
      // 'error', and suppresses 'end', so hitting the cap used to hang this promise (and with
      // it the X lane and its caller) until the platform killed the function. Settle FIRST.
      // A truncated JSON body cannot be parsed, so this resolves null — the documented
      // "never rejects, returns null on any problem" contract — but it LOGS so it is visible.
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      // v647b: the HTTP status was being THROWN AWAY. An out-of-credits 402, a bad-token 401 or a
      // rate-limit 429 all parse as perfectly good JSON, carry no `data.defaultDatasetId`, and so
      // returned early from the caller with NO log line at all — making "Apify is out of credits"
      // completely indistinguishable from "the search found nothing". Name it instead.
      const finish = () => {
        const code = resp.statusCode || 0;
        if (code < 200 || code >= 300) {
          const why = code === 402 ? ' — OUT OF CREDITS / payment required'
                    : code === 401 || code === 403 ? ' — TOKEN REJECTED (check APIFY_API_TOKEN)'
                    : code === 429 ? ' — RATE LIMITED' : '';
          console.log('_trends: apify HTTP ' + code + ' on ' + path + why + ' · ' + String(data).slice(0, 200));
        }
        try { done(JSON.parse(data)); } catch (_) { done(null); }
      };
      resp.on('data', (c) => {
        bytes += c.length;
        if (bytes > 4_000_000) {
          console.log('_trends: apify response exceeded the 4MB cap (' + path + ') — truncated, giving up on this lane');
          finish();
          req.destroy();
          return;
        }
        data += c;
      });
      resp.on('end', finish);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function tweetText(it) {
  return String(it.text || it.full_text || it.fullText || it.tweet || it.content || '').trim();
}
function tweetTs(it) {
  const raw = it.createdAt || it.created_at || it.date || it.timestamp || it.time || '';
  const t = raw ? Date.parse(raw) : NaN;
  return isNaN(t) ? 0 : t;
}
function tweetHandle(it, url) {
  const a = it.author || it.user || {};
  const h = a.userName || a.username || a.screenName || a.screen_name || it.username || it.authorUsername || '';
  if (h) return String(h).replace(/^@/, '');
  const m = String(url || '').match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,30})/i);
  return m && m[1] && !/^(i|home|search|hashtag|explore|status)$/i.test(m[1]) ? m[1] : '';
}
function tweetUrl(it) {
  return it.url || it.twitterUrl || it.tweetUrl || (it.id ? `https://x.com/i/web/status/${it.id}` : '');
}
// v644 — engagement was being thrown away. The lane already fetches these posts; keeping the
// numbers costs NOTHING extra and is what lets us surface "posts worth repurposing" instead of
// only headline trends. Field names follow the same defensive pattern as tweetText/tweetTs above,
// because the actor's exact output shape has never been verified against a live run.
function num(v) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; }
function tweetEngagement(it) {
  const pm = it.public_metrics || it.publicMetrics || {};
  const likes = num(it.likeCount ?? it.favoriteCount ?? it.favorite_count ?? it.likes ?? pm.like_count ?? pm.likeCount);
  const reposts = num(it.retweetCount ?? it.retweet_count ?? it.repostCount ?? it.retweets ?? pm.retweet_count ?? pm.retweetCount);
  const replies = num(it.replyCount ?? it.reply_count ?? it.replies ?? pm.reply_count ?? pm.replyCount);
  const views = num(it.viewCount ?? it.view_count ?? it.views ?? pm.impression_count ?? pm.impressionCount);
  // Reposts are the strongest "someone thought this was worth passing on" signal, so they weigh
  // most. Views are noisy and follower-driven, so they only break ties.
  const score = likes + reposts * 3 + replies * 2 + views / 1000;
  return { likes, reposts, replies, views, score, hasData: !!(likes || reposts || replies || views) };
}

async function fetchXPosts(keyword, token, maxAgeHours) {
  const win = clampWindow(maxAgeHours);
  const cutoff = Date.now() - win * 3600 * 1000;
  const sinceStr = new Date(cutoff).toISOString().slice(0, 10); // YYYY-MM-DD
  // v453: waitForFinish 90→40 so the lane fits the on-demand endpoint's 60s maxDuration.
  const run = await apifyReq('POST', '/v2/acts/apidojo~tweet-scraper/runs?waitForFinish=40', token, {
    searchTerms: [String(keyword).slice(0, 80)],
    sort: 'Latest',
    maxItems: 25,
    tweetLanguage: 'en',
    start: sinceStr, // actor-side date bound; client-side ts filter is the hard guarantee
  });
  const datasetId = run && run.data && run.data.defaultDatasetId;
  if (!datasetId) return [];
  // v453: only read the dataset of a FINISHED run — a still-RUNNING run's dataset is
  // empty/partial and used to read as "X returned nothing" with zero diagnostics.
  const runStatus = run && run.data && run.data.status;
  if (runStatus && runStatus !== 'SUCCEEDED') { console.log('x-lane: run not finished (status=' + runStatus + ') — skipping dataset read'); return []; }
  const items = await apifyReq('GET', `/v2/datasets/${datasetId}/items?limit=25&format=json`, token);
  const out = [];
  for (const it of (Array.isArray(items) ? items : [])) {
    const text = tweetText(it);
    if (!text || text.length < 12 || /^RT @/i.test(text)) continue; // drop empties + pure retweets
    const ts = tweetTs(it);
    if (ts && ts < cutoff) continue; // hard recency guarantee (only drops items we CAN date)
    const url = tweetUrl(it);
    const handle = tweetHandle(it, url);
    const eng = tweetEngagement(it);
    out.push({
      text: text.replace(/\s+/g, ' ').slice(0, 180),
      source: handle ? '@' + handle + ' · X' : 'X', link: url, ts,
      // v644: kept for the "worth repurposing" strip. `full` is untruncated because a post you
      // intend to REMIX needs its whole text, not the 180-char trend headline.
      full: text.replace(/\s+/g, ' ').slice(0, 600),
      handle, eng,
    });
  }
  // ONE-LINE DIAGNOSTIC, and the whole reason this can ship unverified: the actor's output shape
  // was never confirmed against a live run, so the first cron after deploy says outright whether
  // engagement numbers came back. If withEng is 0, the field names above are wrong (or the actor
  // does not return them) and the top-posts strip correctly shows nothing rather than lying.
  // v647b: the RAW count is the half that was missing. The first live run printed "0 posts" and
  // that was unresolvable — it could equally have meant Apify returned nothing, or returned tweets
  // whose field names we guessed wrong so every one was filtered out. A diagnostic that cannot
  // separate two failure modes has not finished its job.
  const _all = (Array.isArray(items) ? items : []);
  /* v675 — THE ACTOR'S "I FOUND NOTHING" MARKER WAS BEING COUNTED AS TEN TWEETS.
     Production logged "10 raw, 0 kept — TEXT FIELD NOT FOUND" on every run for every brand,
     which sent three rounds of field-name guessing after a bug that was never there: the
     dataset held ten copies of {"noResults":true}, a sentinel this actor emits when a query
     matches nothing. The SHAPE line printed it plainly; the count and the note did not.
     Separate them, so "no tweets matched" stops reading as "our parser is broken". */
  const _isNoResult = (it) => {
    if (!it || typeof it !== 'object') return true;
    const k = Object.keys(it);
    return k.length <= 2 && k.every(n => /^(noResults|no_results|error|errorDescription|message)$/i.test(n));
  };
  const _markers = _all.filter(_isNoResult).length;
  const raw = _all.length - _markers;
  const withEng = out.filter(o => o.eng.hasData).length;
  let note = '';
  if (_markers && !raw) note = ' — the scraper reported NO MATCHING TWEETS for these keywords (' + _markers +
    ' no-result marker' + (_markers === 1 ? '' : 's') + ', not tweets). Nothing is wrong with the parser — the query found nothing.';
  else if (!raw) note = ' — Apify returned NOTHING for this query (no matching tweets, or the search args are wrong)';
  else if (!out.length) note = ' — ' + raw + ' tweets came back but ALL were dropped: TEXT FIELD NOT FOUND, or every one fell outside the freshness window';
  else if (!withEng) note = ' — ENGAGEMENT FIELDS NOT FOUND, top-posts strip will stay empty';
  console.log('x-lane: ' + raw + ' raw, ' + out.length + ' kept, ' + withEng + ' with engagement data' + note);
  // v647c: STOP GUESSING THE FIELD NAMES. Three rounds of "try a few plausible keys" have now cost
  // more than one honest look would have. When tweets came back but every one was dropped, print
  // the first item's KEYS and a short sample so the real shape is visible once and fixed once.
  // Only fires on the broken path, so a healthy lane logs nothing extra.
  if (raw && !out.length) {
    try {
      const first = _all.filter(x => !_isNoResult(x))[0] || _all[0] || {};
      console.log('x-lane SHAPE: keys = ' + Object.keys(first).slice(0, 40).join(','));
      console.log('x-lane SAMPLE: ' + JSON.stringify(first).slice(0, 600));
    } catch (e) { console.log('x-lane SHAPE: could not read the first item'); }
  }
  return out;
}

// v644 — the "worth repurposing" list. Deliberately a SEPARATE shape from trends: a trend is a
// topic that feeds the brain, this is a specific post a user can act on. Takes whatever the lane
// already fetched, so it costs nothing beyond the pull that happens anyway.
// HONEST LIMIT, and the copy in the UI says so: this is the most-engaged of the most RECENT posts
// in the window, not a true viral leaderboard — the query is sort:Latest and a real "top" ranking
// would need a second paid query.
function topXPosts(items, limit) {
  return (Array.isArray(items) ? items : [])
    .filter(p => p && p.eng && p.eng.hasData && p.full && p.full.length >= 40 && p.link)
    .sort((a, b) => b.eng.score - a.eng.score)
    .slice(0, limit || 5)
    .map(p => ({ text: p.full, handle: p.handle || '', link: p.link, ts: p.ts,
                 likes: p.eng.likes, reposts: p.eng.reposts }));
}

async function pullXTrends(keywords, token, maxAgeHours) {
  if (!token) return [];
  const kw = (Array.isArray(keywords) ? keywords : [])
    .map(k => String(k || '').trim()).filter(Boolean).slice(0, 2); // 2 = 2 Apify runs (cost-bounded)
  if (!kw.length) return [];
  let results = [];
  try { results = await Promise.all(kw.map(k => fetchXPosts(k, token, maxAgeHours))); } catch (_) { return []; }
  const seen = new Set(); const items = [];
  for (const r of results) {
    for (const it of (r || [])) {
      const norm = it.text.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      items.push(it);
    }
  }
  // v644: rank the "worth repurposing" list BEFORE the newest-first sort below, off the full
  // deduped pool rather than the 8 that survive the cap. Attached as an array property, the same
  // way v453 carries `lanes` — invisible to anything that just iterates the trends.
  const top = topXPosts(items, 5);
  // Newest first, capped.
  items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const outItems = items.slice(0, 8);
  try { outItems.topPosts = top; } catch (_) {}
  return outItems;
}

// ── Grok web-search trends (niche-relevant) ──
// Google News RSS + X return whatever loosely matches a keyword, which for a niche brand is often
// generic, off-topic filler (a peptide-research brand gets celebrity/wellness headlines). Grok
// web-search UNDERSTANDS the niche and returns only genuinely relevant recent items — so it leads the
// feed whenever an XAI key is present. Never throws; returns [] on no-key / bad output.
// Compact brand-brain summary used to SCOPE + relevance-filter incoming info AT THE SOURCE.
// Relevance should come from the brain — this is how we hand the brain to the search. Tolerant of both
// the cron brand row (target_audience, voice_extra.painPoints) and the frontend getBrandContext() shape.
// v665 — DROP WHOLE PARTS, CHEAPEST FIRST. This ended on `.join(' | ').slice(0, 1200)`, a blind
// cut on a string built in a fixed order — so the LAST parts were always the ones lost, and the
// last two are the two that matter most to this function's actual job. Measured on a brand with
// every field filled at ordinary length (1200 chars of a 2200-char summary):
//     MISSING  Recent behavior — favor the APPROVED topics, steer clear of the DISMISSED
//     MISSING  Avoid / off-topic for it
//     ends with: "...never use the word unlock 5, never use the word unlock 6, ne"
// This string exists to SCOPE a web search and filter what comes back. Losing "avoid / off-topic"
// is losing the filter itself — it is exactly what stops a peptide-research brand being handed
// celebrity and wellness headlines, which is the complaint this summary was written to fix. And
// losing the approved/dismissed behaviour means gathering stops improving with use.
// RENDER ORDER IS UNCHANGED — only the DROP order is ranked, same discipline as fullBrandBlock
// in api/_brain.js. A part is whole or absent; the summary never ends mid-word.
const SUMMARY_CAP = 1600;
function brainSummaryFrom(o) {
  if (!o || typeof o !== 'object') return '';
  const ve = (o.voice_extra && typeof o.voice_extra === 'object') ? o.voice_extra : o;
  const parts = [];
  const push = (label, v, max, keep) => {
    const s = Array.isArray(v) ? v.join(', ') : v;
    if (s && String(s).trim()) parts.push({ keep: keep == null ? 50 : keep,
      text: label + ': ' + String(s).replace(/\s+/g, ' ').trim().slice(0, max || 180) });
  };
  push('Brand', o.brandName || o.brand_name, 180, 100);
  push('Niche/communities', o.communities, 180, 95);          // what the search is even about
  push('Audience', o.targetAudience || o.target_audience, 180, 80);
  push('What it offers', o.usps, 180, 65);
  push('Competitors (look for gap / differentiator angles vs these)', ve.competitors || o.competitors, 180, 50);
  push('Pain points it speaks to', ve.painPoints || o.painPoints, 180, 75);
  // Voice Memory = the LEARNED, ever-evolving rules (distilled from what the brand approves / dismisses /
  // edits). Weighting it here is what makes GATHERING relevance improve over time, not just WRITING.
  push('Learned rules to weight (what this brand keeps vs rejects)', ve.coachNotes || o.coachNotes, 280, 55);
  // Raw ever-evolving behavior: favor topics/angles the brand recently APPROVED, avoid the DISMISSED.
  // This is what makes gathering both LEARN and RANK by demonstrated preference, not just static fields.
  push('Recent behavior — favor the APPROVED topics, steer clear of the DISMISSED', ve.learnedSignals || o.learnedSignals, 340, 70);
  // THE FILTER. Ranked just under the niche itself: without it this summary can only say what to
  // look for, never what to throw away — and it was the first thing the old blind slice deleted.
  push('Avoid / off-topic for it', ve.bannedTopics || o.bannedTopics || ve.avoidWords || o.avoidWords, 180, 92);

  const size = s => s.text.length + 3;   // + the ' | ' that joins it to the next part
  let total = parts.reduce((n, s) => n + size(s), 0);
  if (total > SUMMARY_CAP) {
    // Ties break toward dropping the LATER part, so the result is deterministic.
    const cheapestFirst = parts.map((s, i) => [s, i]).sort((a, b) => (a[0].keep - b[0].keep) || (b[1] - a[1]));
    let alive = parts.length;
    for (const [s] of cheapestFirst) {
      if (total <= SUMMARY_CAP || alive <= 1) break;   // always keep at least one part
      s.dropped = true; alive--; total -= size(s);
    }
  }
  const out = parts.filter(s => !s.dropped).map(s => s.text).join(' | ');
  // Only reachable if ONE part is longer than the whole budget, which the per-part caps above
  // already prevent. Cut on a part boundary rather than mid-word if it ever is.
  if (out.length > SUMMARY_CAP) {
    const b = out.lastIndexOf(' | ', SUMMARY_CAP);
    return out.slice(0, b > 0 ? b : SUMMARY_CAP);
  }
  return out;
}

async function pullGrokTrends(keywords, maxAgeHours, brainObj, grokTimeoutMs) {
  const kw = (Array.isArray(keywords) ? keywords : []).map(k => String(k || '').trim()).filter(Boolean).slice(0, 3);
  // v670: three more exits that used to be silent. The first is a legitimate no-op the caller
  // usually screens out; the other two mean the module is broken, which must never be quiet.
  if (!kw.length) { console.error('trends: grok lane skipped — no usable keywords for this brand'); return []; }
  let callGrokSearch;
  try { ({ callGrokSearch } = require('./_llm')); }
  catch (e) { console.error('trends: grok lane cannot load ./_llm — ' + ((e && e.message) || e)); return []; }
  if (!callGrokSearch) { console.error('trends: grok lane loaded ./_llm but it exports no callGrokSearch'); return []; }
  const days = Math.max(1, Math.ceil(clampWindow(maxAgeHours) / 24));
  const niche = kw.join(', ');
  const brain = brainSummaryFrom(brainObj);
  const prompt = `Use live web search to find the most relevant, genuinely RECENT (past ${days} day${days > 1 ? 's' : ''}) content trends for a brand in this niche: "${niche}".${brain ? `\n\nTHE BRAND — judge EVERY item against this profile and return ONLY trends this specific brand would actually post about (this is what makes results relevant, not just keyword matches):\n${brain}` : ''}
Return 8-12 items that are DIRECTLY relevant to THIS brand — recent news, studies, launches, or discussions its audience actually cares about. Favor angles the brand could own, its pain points, and gap opportunities where competitors are active but this brand could do it sharper. Absolutely NO generic wellness, celebrity, or tangential consumer-health filler that only loosely matches a keyword.
Newest and most on-topic first. EVERY item must be traceable: include the direct URL of the page you actually opened in search. Never invent, guess, shorten or reconstruct a URL — if you do not have the real link for an item, leave it out entirely and return a different one instead.
Return ONLY a JSON array, no prose or markdown fences:
[{"text":"the trend or headline in one clear line, max 18 words","source":"publication or @handle","url":"https://the-exact-page-you-read"}]`;
  // v670 — every exit below used to return [] in silence, so the Grok lane could contribute
  // nothing for weeks and the only symptom was a slightly thinner trends feed. callGrokSearch now
  // logs its own failures; these are the ones that happen AFTER a successful call.
  let raw = null;
  // v684 — pass the lane's own deadline down. bound() races this promise, but the SOCKET used
  // to stay open for the hard-coded 90s after the lane had already given up on it, so a retry
  // could never fit and the connection outlived the run. callGrokSearch now honours timeoutMs.
  try { raw = await callGrokSearch(prompt, { maxTokens: 1200, timeoutMs: grokTimeoutMs || 0 }); }
  catch (e) { console.error('trends: grok lane threw — ' + ((e && e.message) || e)); return []; }
  if (!raw) return [];   // callGrokSearch has already said why
  let arr = null;
  try { const m = String(raw).match(/\[[\s\S]*\]/); arr = JSON.parse(m ? m[0] : raw); } catch (_) { arr = null; }
  if (!Array.isArray(arr)) {
    console.error('trends: grok lane returned text that is not a JSON array — ' + String(raw).replace(/\s+/g, ' ').slice(0, 220));
    return [];
  }
  const out = [];
  for (const it of arr) {
    const text = String((it && it.text) || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length < 8) continue;
    // v600: keep the URL Grok actually read so every chip can show a source. Only accept a
    // well-formed http(s) link — a malformed/invented one degrades to the source NAME, which
    // the UI still shows as plain attribution rather than a dead link.
    let link = String((it && (it.url || it.link)) || '').trim();
    if (!/^https?:\/\/[^\s<>"']+$/i.test(link) || link.length > 400) link = '';
    out.push({ text: text.slice(0, 140), source: String((it && it.source) || '').slice(0, 60), link, ts: Date.now() });
  }
  return out.slice(0, 12);
}

// ── Competitor pulse (v454: shared by the weekly cron AND the on-demand pull) ──
// One Grok web-search digest of what the brand's listed competitors did lately.
// Extracted from pull-trends-cron.js so the manual "Pull trends" button can refresh
// a stale pulse too. Never throws; resolves '' on no key / no competitors / timeout /
// any failure. opts.timeoutMs is BOTH the race cap and callGrokSearch's own socket timeout,
// so the two agree instead of leaving a 90s connection behind a 30s race.
// v684: "the cron passes none" was true until v675 and is not any more — pull-trends-cron.js
// computes a timeoutMs from its remaining budget for this call and for the trends lane.
async function pullCompetitorPulse(competitors, opts = {}) {
  const comp = String(competitors || '').trim();
  if (!comp || !process.env.XAI_API_KEY) return '';
  let callGrokSearch;
  try { ({ callGrokSearch } = require('./_llm')); } catch (_) { return ''; }
  if (!callGrokSearch) return '';
  const prompt = `Using live web search, find what these competitor brands have DONE in roughly the last 30 days that a rival should know — new products/features, pricing changes, campaigns, partnerships, or notable posts/announcements. Competitors:\n${comp.slice(0, 700)}\n\nReturn 3-6 SHORT bullet lines, newest first, each naming the competitor and the move. Only real, recent, verifiable moves — empty string if nothing notable.`;
  let p = callGrokSearch(prompt, { maxTokens: 700, timeoutMs: opts.timeoutMs || 0 });
  if (opts.timeoutMs && opts.timeoutMs > 0) p = Promise.race([p, new Promise(r => setTimeout(() => r(null), opts.timeoutMs))]);
  let digest = null;
  try { digest = await p; } catch (e) { console.error('trends: competitor pulse threw — ' + ((e && e.message) || e)); return ''; }
  if (digest == null) console.error('trends: competitor pulse came back empty (timed out, or grok-search failed — see its own log line)');
  return (digest && String(digest).trim()) ? String(digest).trim() : '';
}

// Grok web-search (niche-relevant, LEADS) + Google News (fresh headlines) + X (latest tweets), merged
// into one FRESH feed, deduped by normalized text. `maxAgeHours` windows every source. BOTH callers
// now pass timeouts — the cron computes them from its remaining run budget (v675; before that it
// passed undefined, which made bound() a no-op and let one lane eat the whole run) and the
// on-demand button passes xTimeoutMs (X/Apify race cap) and
// grokTimeoutMs (v453: Grok gets its OWN, tighter budget — callGrokSearch allows 90s internally, which
// used to blow past the on-demand race) so the whole pull stays under its 60s function limit
// (News alone always returns, so the button never fails). Fail-open: a timed-out lane resolves [].
// The returned array carries `out.lanes = { grok, news, x }` (per-lane raw counts, pre-dedupe) for
// caller visibility — an extra array property, invisible to JSON.stringify of the array itself.
async function pullAllTrends(keywords, apifyToken, maxAgeHours, xTimeoutMs, brainObj, grokTimeoutMs) {
  const win = clampWindow(maxAgeHours);
  const bound = (p, ms) => (ms && ms > 0) ? Promise.race([p, new Promise(r => setTimeout(() => r([]), ms))]) : p;
  const grokPromise = process.env.XAI_API_KEY ? bound(pullGrokTrends(keywords, win, brainObj, grokTimeoutMs || xTimeoutMs).catch(() => []), grokTimeoutMs || xTimeoutMs) : Promise.resolve([]);
  const xPromise = apifyToken ? bound(pullXTrends(keywords, apifyToken, win).catch(() => []), xTimeoutMs) : Promise.resolve([]);
  const [grok, news, x] = await Promise.all([
    grokPromise,
    pullTrends(keywords, win),
    xPromise,
  ]);
  const seen = new Set(); const out = [];
  const add = (arr, cap) => {
    let n = 0;
    for (const it of (arr || [])) {
      if (n >= cap) break;
      const norm = String(it.text || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
      if (!norm || seen.has(norm)) continue;
      seen.add(norm); out.push(it); n++;
    }
  };
  add(grok, 12);   // niche-relevant Grok items lead
  add(news, 8);    // fresh real headlines fill in
  add(x, 6);       // + latest tweets
  out.lanes = { grok: (grok || []).length, news: (news || []).length, x: (x || []).length };
  // v644: carry the repurposable posts through. `bound()` can resolve the X lane to a plain []
  // on timeout, which has no topPosts — hence the guard; an empty list simply hides the strip.
  out.topPosts = (x && x.topPosts) ? x.topPosts : [];
  return out;
}

// ── Trend velocity / heat scoring ──
// `prevTexts` = the normalized topic texts from the brand's PREVIOUS pull, so we can
// flag what's genuinely NEW (first derivative = rising). A secondary within-pull signal
// is cross-source overlap (a topic several items touch = more buzz), plus a recency
// bonus. Returns the items sorted hottest-first, each tagged { hot: bool }.
function _tNorm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim(); }
function _tKeywords(s) { return _tNorm(s).split(' ').filter(w => w.length >= 4); }
function scoreTrends(items, prevTexts, prefTexts) {
  const list = Array.isArray(items) ? items.slice() : [];
  if (!list.length) return list;
  const prev = new Set((Array.isArray(prevTexts) ? prevTexts : []).map(_tNorm).filter(Boolean));
  // prefKw = keywords from what this brand has APPROVED before → items overlapping proven preference
  // get a rank boost, so ranking = relevance × freshness × demonstrated preference (not just freshness).
  const prefKw = new Set();
  (Array.isArray(prefTexts) ? prefTexts : []).forEach(t => _tKeywords(t).forEach(k => prefKw.add(k)));
  const now = Date.now();
  const kwCache = list.map(it => new Set(_tKeywords(it.text)));
  const scored = list.map((it, i) => {
    let overlap = 0;
    for (let j = 0; j < list.length; j++) {
      if (j === i) continue;
      for (const k of kwCache[j]) { if (kwCache[i].has(k)) { overlap++; break; } }
    }
    let pref = 0;
    if (prefKw.size) { for (const k of kwCache[i]) { if (prefKw.has(k)) { pref = 2; break; } } }
    const isNew = prev.size ? !prev.has(_tNorm(it.text)) : false;
    const recency = it.ts ? Math.max(0, 72 - (now - it.ts) / 3600000) / 72 : 0; // 0..1, newer higher
    const score = (isNew ? 3 : 0) + Math.min(overlap, 3) + recency + pref;
    return { it, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const hotN = Math.min(6, Math.max(1, Math.round(scored.length / 3)));
  return scored.map((s, i) => Object.assign({}, s.it, { hot: i < hotN && s.score >= 1.5 }));
}

module.exports = {
  pullTrends, pullXTrends, pullAllTrends, pullGrokTrends, pullCompetitorPulse, brainSummaryFrom, fetchNewsRss, parseRssItems, decodeEntities,
  clampWindow, DEFAULT_WINDOW_HOURS, ALLOWED_WINDOW_HOURS, scoreTrends, topXPosts, tweetEngagement,
};
