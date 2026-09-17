const https = require('https');
const { callLLM } = require('./_llm');
const { extractJson } = require('./_brain');

// ── time budget ────────────────────────────────────────────────────────────────
// vercel.json gives this route maxDuration 120. Every leg must fit INSIDE that with
// headroom, so a slow provider fails with our own retryable message instead of being
// killed by the platform (a platform kill returns a bare 504 with no app-level error
// and nothing in the logs — the undiagnosable class). Before this, the legs summed to
// ~210s worst case (Apify wait + dataset read + a 100s LLM call) and none of the Apify
// calls had a socket timeout at all, so a hung Apify hung the whole function.
//   run wait 56s + dataset 12s + LLM (<=28s in the worst case) = 96s < 120s.
const FN_BUDGET_MS = 96000;
const RUN_WAIT_S = 50;          // Apify caps waitForFinish at 60 anyway
const RUN_TIMEOUT_MS = 56000;   // socket timeout covering that wait
const DATASET_TIMEOUT_MS = 12000;
const LLM_MAX_MS = 60000;       // when Apify was fast, give the model real room
const LLM_MIN_MS = 12000;

// Crawl a user's OWN public social profile (Instagram/TikTok) and extract
// brand voice from their actual captions. Public data only — no login.
module.exports = async function handler(req, res) {
  const allowed = ['https://contentshrimp.com', 'https://bettercontent.app', 'https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const _g = await require('./_usage').guard(req, 'crawlsocial');
  if (!_g.user) return res.status(401).json({ error: 'Please sign in again.' });
  if (_g.over) return res.status(402).json({ error: 'limit_reached', plan: _g.gate.plan, used: _g.gate.used, limit: _g.gate.limit, trialEndsAt: _g.gate.trialEndsAt });

  const _t0 = Date.now();
  try {
    const { url } = req.body || {};
    if (!url || !url.trim()) return res.status(400).json({ error: 'Missing profile URL' });
    try { await require('./_safeurl').assertPublicHttpUrl(url.trim()); }
    catch (e) { return res.status(400).json({ error: 'That URL is not allowed.' }); }

    const apiToken = process.env.APIFY_API_TOKEN;
    if (!apiToken) return res.status(500).json({ error: 'Reading your posts is temporarily unavailable.' });

    // Detect platform + username
    const u = url.trim();
    let actorId, input, platform;
    // X/Twitter is detected on an explicit domain (a bare @handle stays TikTok, as before).
    const isX = /(?:\/\/|^|\.)x\.com\//i.test(u) || /twitter\.com/i.test(u);
    if (/instagram\.com/i.test(u) || (!/tiktok/i.test(u) && !isX && u.startsWith('@') === false && !u.includes('/'))) {
      platform = 'instagram';
      actorId = 'apify~instagram-post-scraper';
      const username = u.replace(/.*instagram\.com\//i, '').replace(/^@/, '').replace(/[/?#].*/, '');
      if (!username) return res.status(400).json({ error: 'Could not read an Instagram username from that URL' });
      input = { username: [username], resultsLimit: 15 };
    } else if (isX) {
      platform = 'x';
      actorId = 'apidojo~tweet-scraper';
      const handle = u.replace(/.*(?:x|twitter)\.com\/@?/i, '').replace(/^@/, '').replace(/[/?#].*/, '');
      if (!handle) return res.status(400).json({ error: 'Could not read an X username from that URL' });
      input = { twitterHandles: [handle], maxItems: 20, sort: 'Latest' };
    } else if (/tiktok\.com/i.test(u) || u.startsWith('@')) {
      platform = 'tiktok';
      actorId = 'clockworks~tiktok-scraper';
      const username = u.replace(/.*tiktok\.com\/@?/i, '').replace(/^@/, '').replace(/[/?#].*/, '');
      if (!username) return res.status(400).json({ error: 'Could not read a TikTok username from that URL' });
      input = { profiles: [username], resultsPerPage: 15, shouldDownloadVideos: false, shouldDownloadCovers: false };
    } else {
      return res.status(400).json({ error: 'Paste an Instagram, X, or TikTok profile URL' });
    }

    // Run the scraper and wait
    let runResult = await apifyRequest('POST', `/v2/acts/${encodeURIComponent(actorId)}/runs?waitForFinish=${RUN_WAIT_S}`, apiToken, input, RUN_TIMEOUT_MS);

    // v670 — READ THE RUN'S STATUS. `waitForFinish` is a CEILING, not a promise: Apify answers
    // after at most RUN_WAIT_S seconds whether or not the scrape finished, and the run object
    // carries `defaultDatasetId` from the moment it is CREATED. So on a slow actor this code took
    // the id of a run still in progress, read a dataset that was empty or half-written, found
    // fewer than three captions, and answered:
    //     "Found fewer than 3 readable posts on that profile — is it public and active?"
    // That is a false statement about the PERSON'S OWN ACCOUNT. They go and check their privacy
    // settings, find nothing wrong, and conclude the feature is broken — while the real cause was
    // a scrape that simply had not finished.
    const runId = runResult && runResult.data && runResult.data.id;
    let runStatus = (runResult && runResult.data && runResult.data.status) || 'UNKNOWN';

    // One more short wait if it is still going and the budget genuinely allows it. After the first
    // wait we are ~RUN_WAIT_S in; the dataset read and the model still need DATASET_TIMEOUT_MS +
    // LLM_MIN_MS, so only spend what is left beyond that.
    if ((runStatus === 'RUNNING' || runStatus === 'READY') && runId) {
      const spare = FN_BUDGET_MS - (Date.now() - _t0) - DATASET_TIMEOUT_MS - LLM_MIN_MS;
      if (spare > 8000) {
        const extraS = Math.min(20, Math.floor(spare / 1000) - 3);
        console.log('crawl-social: run ' + runId + ' still ' + runStatus + ' after ' + RUN_WAIT_S + 's — waiting ' + extraS + 's more');
        try {
          const again = await apifyRequest('GET', `/v2/actor-runs/${encodeURIComponent(runId)}?waitForFinish=${extraS}`,
            apiToken, null, (extraS + 4) * 1000);
          if (again && again.data && again.data.status) { runResult = again; runStatus = again.data.status; }
        } catch (e) { /* keep what we have; the status check below decides */ }
      }
    }

    const datasetId = runResult && runResult.data && runResult.data.defaultDatasetId;
    if (!datasetId) {
      // apifyRequest has already logged the real status + body head, so a renamed
      // actor id / bad token / rate limit is diagnosable from the function logs.
      console.error('crawl-social: no defaultDatasetId from actor ' + actorId + ' (platform=' + platform + ')');
      return res.status(502).json({ error: 'Could not read that profile right now — try again in a minute' });
    }

    // 5th arg, not the 4th: apifyRequest is (method, path, token, body, timeoutMs). Passed in the
    // body slot, DATASET_TIMEOUT_MS was written out as the request body of a GET and the read ran
    // on the 30000 fallback instead — which blew the budget below and starved the LLM leg.
    const items = await apifyRequest('GET', `/v2/datasets/${encodeURIComponent(datasetId)}/items?limit=40&format=json`, apiToken, null, DATASET_TIMEOUT_MS);
    const captions = (Array.isArray(items) ? items : [])
      .map(it => {
        if (platform === 'instagram') return it.caption || '';
        if (platform === 'x') return it.text || it.full_text || it.fullText || it.tweet || '';
        return it.text || '';
      })
      .map(c => String(c).trim())
      .filter(c => c.length > 10 && !/^RT @/i.test(c)) // drop pure retweets — not the brand's own voice
      .slice(0, 40);

    if (captions.length < 3) {
      // v670 — ONLY BLAME THE PROFILE WHEN THE SCRAPE ACTUALLY FINISHED.
      // A run that is still going, or that failed on Apify's side, tells us nothing about whether
      // the profile is public. Saying "is it public and active?" in those cases sends the person
      // to check settings that were never the problem.
      if (runStatus === 'RUNNING' || runStatus === 'READY') {
        console.error('crawl-social: run ' + runId + ' still ' + runStatus + ' at read time — ' +
          captions.length + ' captions so far (platform=' + platform + ')');
        return res.status(503).json({ error: "That profile is taking longer than usual to read — give it a minute and try again.", runStatus });
      }
      if (runStatus !== 'SUCCEEDED') {
        console.error('crawl-social: run ' + runId + ' ended ' + runStatus + ' with ' + captions.length +
          ' captions (platform=' + platform + ')');
        return res.status(502).json({ error: "Couldn't read that profile right now — try again in a minute.", runStatus });
      }
      console.log('crawl-social: run ' + runId + ' SUCCEEDED but only ' + captions.length +
        ' usable captions (platform=' + platform + ') — reporting it as a profile problem');
      return res.status(404).json({ error: 'Found fewer than 3 readable posts on that profile — is it public and active?' });
    }

    // Voice extraction
    const platformLabel = platform === 'x' ? 'X (Twitter)' : platform;
    const prompt = `Below are ${captions.length} real ${platform === 'x' ? 'posts' : 'captions'} from a brand's own ${platformLabel} profile. Extract their ACTUAL brand voice — how they really write, not how brands typically write.

CAPTIONS:
${captions.map((c, i) => `${i + 1}. ${c.slice(0, 500)}`).join('\n\n')}

Return ONLY a JSON object, no markdown fences:
{
  "tones": ["2-4 tone words that match how they actually write, chosen from: sarcastic, witty, educational, provocative, deadpan, inspirational, casual, authoritative, playful, minimalist"],
  "brandVocab": "Distinctive words, phrases, and recurring expressions from these captions, one per line (the things fans would recognize)",
  "ctaStyle": "How this brand actually asks for action — quote 1-3 real CTA patterns from the captions",
  "exampleContent": "The 2-3 strongest captions copied VERBATIM, each followed by one line on why it works (hook style, structure, tone)"
}
Rules: extract, don't invent. If a field has no evidence in the captions, return an empty string for it. Never prettify their voice — if they write blunt, the extraction is blunt.`;

    // Spend whatever is LEFT of the function budget on the model, bounded both ways —
    // fast Apify run → a generous window; slow one → we still return our own error
    // before the platform kills us.
    const llmMs = Math.max(LLM_MIN_MS, Math.min(LLM_MAX_MS, FN_BUDGET_MS - (Date.now() - _t0)));
    const content = await callLLM({ timeoutMs: llmMs,
      messages: [{ role: 'user', content: prompt }],
      model: 'grok',
      max_tokens: 3200
    });

    const voice = extractJson(content);
    if (!voice) return res.status(502).json({ error: "Couldn't read your posts clearly — please try again." });

    await require('./_usage').logUsage({ userId: _g.billingUserId || _g.user.id, action: 'crawlsocial' });
    return res.status(200).json({ voice, postsAnalyzed: captions.length, platform });
  } catch (e) {
    console.error('crawl-social error:', e);
    return res.status(500).json({ error: 'Social crawl failed: ' + e.message });
  }
};

function apifyRequest(method, path, token, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.apify.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      // Without this a hung Apify hangs the whole function until the platform kills it.
      timeout: timeoutMs || 30000
    };
    const req = https.request(options, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        let parsed = null, isJson = true;
        try { parsed = JSON.parse(data); } catch (e) { isJson = false; }
        // An Apify ERROR body (renamed/removed actor id, bad token, rate limit) used to
        // resolve as a raw string; the caller then saw `undefined` for the dataset id and
        // returned a generic 502 with NOTHING logged, so the real cause was invisible.
        if (!isJson || resp.statusCode >= 400 || (parsed && parsed.error)) {
          console.error('crawl-social: apify ' + method + ' ' + path + ' -> ' + resp.statusCode +
            ' ' + String(data).slice(0, 500));
        }
        resolve(isJson ? parsed : data);
      });
    });
    req.on('error', (e) => {
      console.error('crawl-social: apify ' + method + ' ' + path + ' request error: ' + (e && e.message));
      reject(e);
    });
    req.on('timeout', () => { req.destroy(new Error('Apify request timed out after ' + (timeoutMs || 30000) + 'ms')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
