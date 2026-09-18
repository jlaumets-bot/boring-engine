// v647 — "What they just posted": recent posts from the brand's OWN bookmarked creators, for the
// Remix screen. MANUAL ONLY — this runs when the user taps Refresh, never on a schedule.
//
// WHY MANUAL AND NOT A CRON (the v644 lesson, inverted): the Trends "Worth making yours" strip is
// free because the nightly trends cron was ALREADY pulling those posts for the brand's keywords —
// keeping the engagement fields cost zero extra runs. This is a genuinely NEW query per creator, so
// it is genuinely new Apify spend. A nightly pull for every brand would be ~$90/mo at 30 brands;
// on tap it is a couple of dollars. Remix is also intent-driven — you arrive wanting to make
// something — so there is nothing to pre-pull for.
//
// Ranked by RECENCY, not engagement, so this does NOT depend on the still-unverified engagement
// field names that the v644 strip needs.
const store = require('./_publish/store');

const MAX_CREATORS = 6;      // one run per platform, but keep the result set (and the bill) small
const POSTS_EACH = 3;
const RUN_WAIT_S = 35;       // must leave room under maxDuration 60 for the dataset read
const RUN_TIMEOUT_MS = 40000;
const DATASET_TIMEOUT_MS = 12000;

function apifyReq(method, path, token, body, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const https = require('https');
      const data = body ? JSON.stringify(body) : null;
      const req = https.request({
        hostname: 'api.apify.com', path, method,
        headers: Object.assign(
          { 'Authorization': 'Bearer ' + token },
          data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
        ),
      }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; if (raw.length > 6e6) { res.destroy(); finish(null); } });
        res.on('end', () => {
          // Same reason as _trends.js: a 402/401/429 parses as valid JSON and would otherwise
          // vanish into "no posts came back", which is a completely different problem.
          const code = res.statusCode || 0;
          if (code < 200 || code >= 300) {
            const why = code === 402 ? ' — OUT OF CREDITS / payment required'
                      : code === 401 || code === 403 ? ' — TOKEN REJECTED (check APIFY_API_TOKEN)'
                      : code === 429 ? ' — RATE LIMITED' : '';
            console.log('creator-posts: apify HTTP ' + code + ' on ' + path + why + ' · ' + String(raw).slice(0, 200));
          }
          try { finish(JSON.parse(raw)); } catch (e) { finish(null); }
        });
      });
      req.setTimeout(timeoutMs || RUN_TIMEOUT_MS, () => { try { req.destroy(); } catch (e) {} finish(null); });
      req.on('error', () => finish(null));
      if (data) req.write(data);
      req.end();
    } catch (e) { finish(null); }
  });
}

// Handle out of a profile URL. We only ever send the HANDLE to Apify — the URL itself is never
// fetched server-side, so a hostile bookmark cannot be used to make us request an internal address.
function handleFrom(plat, url) {
  const u = String(url || '').trim();
  let h = '';
  if (plat === 'tt') h = u.replace(/.*tiktok\.com\/@?/i, '');
  else if (plat === 'ig') h = u.replace(/.*instagram\.com\//i, '');
  else if (plat === 'x') h = u.replace(/.*(?:x|twitter)\.com\/@?/i, '');
  h = h.replace(/^@/, '').replace(/[/?#].*/, '').trim();
  return /^[A-Za-z0-9._-]{1,40}$/.test(h) ? h : '';
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0; };

// The actors' CAPTION field is proven (crawl-social.js has consumed it for versions). The post URL,
// timestamp and author fields are NOT — nothing in the app reads them today. So every one is a
// fallback chain, and the diagnostic below reports how many items actually yielded a link.
function postFrom(plat, it) {
  if (!it || typeof it !== 'object') return null;
  const text = String(it.text || it.caption || it.title || it.desc || it.full_text || it.fullText || '').trim();
  const link = String(it.webVideoUrl || it.url || it.postPage || it.twitterUrl || it.tweetUrl || it.link || '').trim();
  const tsRaw = it.createTimeISO || it.timestamp || it.createdAt || it.created_at || it.date || it.uploadedAt;
  const ts = tsRaw ? Date.parse(tsRaw) : 0;
  const handle = String(
    (it.authorMeta && (it.authorMeta.name || it.authorMeta.uniqueId || it.authorMeta.nickName)) ||
    it.ownerUsername || (it.author && (it.author.userName || it.author.screen_name)) || it.username || ''
  ).replace(/^@/, '').trim();
  if (!link || !/^https?:\/\//i.test(link)) return null;   // a post we cannot open is useless here
  if (!text && plat !== 'tt') return null;                 // TikTok captions are often empty; fine
  return {
    plat, handle: handle.slice(0, 40), link: link.slice(0, 400),
    text: text.slice(0, 600), ts: Number.isFinite(ts) && ts > 0 ? ts : 0,
    likes: num(it.diggCount || it.likesCount || it.likeCount),
  };
}

// One Apify run per platform — every one of these actors takes an ARRAY of profiles, so a brand's
// whole bookmark list on a platform costs ONE run, not one per creator.
async function pullPlatform(plat, handles, token) {
  let actorId, input;
  if (plat === 'tt') {
    actorId = 'clockworks~tiktok-scraper';
    input = { profiles: handles, resultsPerPage: POSTS_EACH, shouldDownloadVideos: false, shouldDownloadCovers: false };
  } else if (plat === 'ig') {
    actorId = 'apify~instagram-post-scraper';
    input = { username: handles, resultsLimit: POSTS_EACH };
  } else if (plat === 'x') {
    actorId = 'apidojo~tweet-scraper';
    input = { twitterHandles: handles, maxItems: handles.length * POSTS_EACH, sort: 'Latest' };
  } else return [];

  const run = await apifyReq('POST', `/v2/acts/${encodeURIComponent(actorId)}/runs?waitForFinish=${RUN_WAIT_S}`, token, input, RUN_TIMEOUT_MS);
  const dsId = run && run.data && run.data.defaultDatasetId;
  const status = run && run.data && run.data.status;
  if (!dsId) { console.log('creator-posts: ' + plat + '-lane no dataset (status=' + (status || 'none') + ')'); return []; }
  if (status && status !== 'SUCCEEDED') { console.log('creator-posts: ' + plat + '-lane run not finished (status=' + status + ')'); return []; }

  const items = await apifyReq('GET', `/v2/datasets/${encodeURIComponent(dsId)}/items?limit=60&format=json`, token, null, DATASET_TIMEOUT_MS);
  const arr = Array.isArray(items) ? items : [];
  const out = arr.map(it => postFrom(plat, it)).filter(Boolean);
  // The one line that settles whether the field guesses are right, the same way the v644
  // `x-lane:` diagnostic does. If linked is 0 while raw is not, the URL field name is wrong and
  // the strip stays empty rather than showing posts nobody can open.
  console.log('creator-posts: ' + plat + '-lane ' + arr.length + ' raw, ' + out.length + ' with a usable link' +
    (arr.length && !out.length ? ' — POST URL FIELD NOT FOUND, strip will stay empty for this platform' : ''));
  return out;
}

module.exports = async function handler(req, res) {
  const allowed = ['https://contentshrimp.com', 'https://bettercontent.app', 'https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const _g = await require('./_usage').guard(req, 'creatorposts', res);
  if (!_g.user) return res.status(401).json({ error: 'Please sign in again.' });
  if (_g.over) return require('./_usage').denyResponse(res, _g.gate);

  const token = process.env.APIFY_API_TOKEN;
  if (!token) return res.status(200).json({ posts: [], empty: true, reason: 'Scraping isn\'t set up on this account yet.' });

  try {
    let { brandId, creators } = req.body || {};
    if (!Array.isArray(creators)) creators = [];

    // Group into one bucket per supported platform. yt/li/web have no actor wired — they are
    // reported back as skipped rather than silently dropped, so the UI can say why.
    const byPlat = { tt: [], ig: [], x: [] };
    const skipped = [];
    for (const c of creators.slice(0, MAX_CREATORS)) {
      const plat = String((c && c.plat) || '').trim();
      if (!byPlat[plat]) { skipped.push({ name: String((c && c.name) || '').slice(0, 40), plat }); continue; }
      const h = handleFrom(plat, c && c.url);
      if (!h) { skipped.push({ name: String((c && c.name) || '').slice(0, 40), plat }); continue; }
      if (byPlat[plat].indexOf(h) < 0) byPlat[plat].push(h);
    }
    const lanes = Object.keys(byPlat).filter(p => byPlat[p].length);
    if (!lanes.length) return res.status(200).json({ posts: [], empty: true, skipped, reason: 'No TikTok, Instagram or X profiles saved yet.' });

    // Parallel, and allSettled so one dead platform can never take the others down with it.
    const settled = await Promise.allSettled(lanes.map(p => pullPlatform(p, byPlat[p], token)));
    let posts = [];
    settled.forEach(r => { if (r.status === 'fulfilled' && Array.isArray(r.value)) posts = posts.concat(r.value); });

    // Newest first. Items with no parseable date sort last rather than being dropped — a post we
    // can open is still useful even when the actor's date field is one we did not guess.
    posts.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    posts = posts.slice(0, MAX_CREATORS * POSTS_EACH);

    let logBrandId = null;
    if (brandId) { try { if (await store.userCanAccessBrand(_g.user.id, brandId)) logBrandId = brandId; } catch (e) {} }
    await require('./_usage').logUsage({ userId: _g.billingUserId || _g.user.id, brandId: logBrandId, action: 'creatorposts', model: 'apify:' + lanes.join('+') });

    return res.status(200).json({ posts, skipped, at: Date.now(), empty: !posts.length });
  } catch (e) {
    console.error('creator-posts error:', e);
    return res.status(500).json({ error: 'Could not pull their posts just now — try again.' });
  }
};
