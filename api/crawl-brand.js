const https = require('https');
const http = require('http');
const { callLLM, callGrokSearch } = require('./_llm');
const { extractJson } = require('./_brain');

module.exports = async function handler(req, res) {
  const allowed = ['https://contentshrimp.com','https://bettercontent.app','https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // This endpoint authenticated but NEVER gated: it logged usage afterwards and checked
  // nothing beforehand, so any signed-in account could run it without bound — <=10 page
  // fetches + a Grok web search + 2 Grok calls, on a 300s budget, per call. Now gated.
  //
  // One mode: the deep scan (`crawlbrand`, 3 credits). The second mode — the master-prompt
  // Google-Doc sync — was retired in v636 along with the whole Master Prompt feature.
  const _cbBody = req.body || {};
  const _cbAction = 'crawlbrand';
  const _cbGuard = await require('./_usage').guard(req, _cbAction);
  const _cbUser = _cbGuard.user;
  if (!_cbUser) return res.status(401).json({ error: 'Please sign in again.' });
  // ONBOARDING MUST NEVER BE BLOCKED. The wizard's very first step calls this to build a
  // brand-new account's brand brain; a 402 there would strand someone mid-setup.
  // A fresh account has zero usage this period, so `used + 3 > limit` is already false
  // (0 + 3 > 150 for trial, > 40 for free) and it cannot trip. This makes that guarantee
  // explicit rather than emergent: an account that has spent NOTHING this period always
  // gets its scan. It grants at most one un-gated crawl per account per month — the first
  // call writes a usage row, so every call after it is gated normally.
  if (_cbGuard.over && (_cbGuard.gate && _cbGuard.gate.used) > 0) {
    const _r = _cbGuard.gate.reason;
    if (_r === 'rate') { res.setHeader('Retry-After', String(_cbGuard.gate.retryAfter || 60)); return res.status(429).json({ error: 'rate_limited', retryAfter: _cbGuard.gate.retryAfter || 60 }); }
    return res.status(402).json({ error: 'limit_reached', plan: _cbGuard.gate.plan, used: _cbGuard.gate.used, limit: _cbGuard.gate.limit, trialEndsAt: _cbGuard.gate.trialEndsAt });
  }

  try {
    const _t0 = Date.now(); // request clock — used to time-box optional web enrichment
    const { url, action } = _cbBody;
    if (!url || !url.trim()) return res.status(400).json({ error: 'Missing URL' });
    // SSRF guard. (The one branch that used to skip it, gdoc mode, is gone.)
    try { await require('./_safeurl').assertPublicHttpUrl(url.trim()); }
    catch (e) { return res.status(400).json({ error: 'That URL is not allowed.' }); }

    // REMOVED v636 — the 'fetch-gdoc' mode for the Master Prompt feature, retired.
    // Removing it also drops the SSRF-guard bypass that existed only for this branch.

    // Normalize URL
    let siteUrl = url.trim();
    if (!siteUrl.startsWith('http')) siteUrl = 'https://' + siteUrl;

    // Try multiple fetch strategies. Keep the RAW homepage too, so we can
    // discover internal links (About / Products / FAQ) and read those pages
    // for far richer base knowledge.
    let textContent = '';
    let homeRaw = '';
    const debugInfo = {};

    // Strategy 1: Jina Reader API (handles JS-rendered sites like Wix, Shopify)
    try {
      const jinaText = await fetchJina(siteUrl);
      debugInfo.jinaLen = jinaText ? jinaText.length : 0;
      if (jinaText && jinaText.length > 200) {
        homeRaw = jinaText;
        textContent = jinaText.substring(0, 16000);
        debugInfo.source = 'jina';
      }
    } catch (e) {
      debugInfo.jinaError = e.message;
    }

    // Strategy 2: Direct fetch + HTML extraction
    if (!textContent) {
      let html = '';
      try {
        html = await fetchPage(siteUrl);
        debugInfo.directLen = html ? html.length : 0;
      } catch (e) {
        debugInfo.directError = e.message;
        try {
          const urlObj = new URL(siteUrl);
          if (!urlObj.hostname.startsWith('www.')) {
            urlObj.hostname = 'www.' + urlObj.hostname;
            html = await fetchPage(urlObj.toString());
            debugInfo.wwwLen = html ? html.length : 0;
          }
        } catch (e2) {
          debugInfo.wwwError = e2.message;
        }
      }
      if (html && html.length > 100) {
        homeRaw = html;
        textContent = extractText(html);
        debugInfo.source = 'direct';
      }
    }

    if (!textContent || textContent.length < 50) {
      return res.status(400).json({
        error: 'Could not read website content. The site may require JavaScript or is blocking automated requests. Try a different URL or skip this step.'
      });
    }

    // Read the most valuable subpages for base knowledge. Prefer the sitemap
    // (reliable + complete), then top up with homepage links. Up to 10 pages (deep
    // scan) so the brain gets founding story, full product detail, FAQ and social
    // proof — not just the homepage. Time-boxed + fail-open: any slow/failed page is
    // skipped and the homepage content still wins.
    let combined = textContent;
    try {
      const origin = new URL(siteUrl).origin;
      let keyLinks = await pickSitemapLinks(origin, 10);
      debugInfo.sitemapLinks = keyLinks.length;
      if (keyLinks.length < 6) {
        const fromHome = pickKeyLinks(homeRaw, origin, 10);
        for (const u of fromHome) { if (!keyLinks.includes(u)) keyLinks.push(u); }
        keyLinks = keyLinks.slice(0, 10);
      }
      debugInfo.subLinks = keyLinks;
      if (keyLinks.length) {
        const subs = await Promise.all(keyLinks.map(l => fetchSubpageText(l)));
        for (const s of subs) { if (s) combined += s; }
      }
    } catch (e) { debugInfo.subError = e.message; }

    const truncated = combined.substring(0, 48000);

    // Rich brand extraction via callLLM (Grok) (Pro plan = 60s timeout)
    const prompt = `Analyze this website content and extract brand information. Return a JSON object with these fields:

{
  "brandName": "ONLY the brand or company's actual short NAME (1-4 words, e.g. 'Notion', 'Ben & Jerry's', 'Mila Sourcing'). NEVER a tagline, slogan, headline, or sentence describing what they do — those belong in tagline/description. If there is no clear proper name, return an empty string.",
  "tagline": "Their main tagline or slogan (if found)",
  "description": "1-2 sentence description of what they do",
  "products": "What they sell or offer",
  "usps": "The brand's REAL, SPECIFIC differentiators as stated on the site — use the concrete facts and numbers the site actually gives (e.g. '20-30% lower than X', '3-stage QC', '48-hour turnaround'), never vague adjectives like 'high quality' or 'best in class'. One per line.",
  "targetAudience": "The SPECIFIC audience the site speaks to — their role/type, their situation, and the problem they have, in the site's own framing. Not a vague 'everyone' or a single generic label.",
  "tones": ["array of 2-4 tone words that match their brand voice, chosen from: sarcastic, witty, educational, provocative, deadpan, inspirational, casual, authoritative, playful, minimalist"],
  "suggestedCommunities": ["array of 5-7 content theme suggestions based on their niche"],
  "bannedTopics": "Topics they should probably avoid based on their industry",
  "painPoints": "3-5 customer frustrations this brand solves, written in the customer's own raw voice, one per line (empty string if not inferable)",
  "brandVocab": "Distinctive words/phrases the brand uses on the site, one per line (empty string if none found)",
  "avoidWords": "Marketing words that would clash with this brand's voice, one per line (empty string if not inferable)",
  "ctaStyle": "How the brand asks for action, 1-2 example CTAs in their voice (empty string if not inferable)",
  "productDetails": "The brand's actual products or services exactly as the site names them — include named packages/tiers, prices, and key specifics verbatim where present (e.g. 'Sourcing Activation EUR 425 — match + 3-5 quotes'). Scannable lines, one per offer. Empty string if none.",
  "originStory": "The real FOUNDING STORY if the site tells one (usually on an About / Our-Story page): who founded it (include founder names if given), the moment or reason it started, the problem they set out to fix, and the mission — in the brand's own narrative voice, 2-4 sentences. Do NOT use legal-entity / registry / 'operated by' / headquarters / footer text or a generic company blurb as the origin story — that is not a story. Empty string only if the site tells no founding story.",
  "socialProof": "Concrete, specific proof the site actually states — real figures, ratings, named testimonials (include the person/company when given), press or partner mentions. Quote the actual numbers verbatim; never round up or invent. Empty string if none.",
  "competitors": "ONLY competitor brands the site EXPLICITLY names (e.g. 'unlike X', 'vs X', 'switch from X', a named comparison). Do NOT infer, guess, or invent — never output a generic category placeholder like 'a typical X company'. Real named brands only, one per line. Empty string if the site names none.",
  "visualStyle": "Visual identity cues you can infer — colours, imagery, photography style, mood, aesthetic (empty string if not inferable)",
  "exampleContent": "1-3 short verbatim snippets of the brand's own copy that best capture its voice, one per line (empty string if none)"
}

The content may include several pages of the same site (marked with '--- PAGE: ... ---'). Read ALL of them and pull every concrete detail into the fields above — an About/Our-Story page usually holds the origin story (use its NARRATIVE — how and why it began, the founders — never the legal-entity/registry footer), product/shop/pricing pages hold productDetails, and review/testimonial pages hold socialProof. Fill as many fields as the site truthfully supports.

PRECISION RULES (apply to every field):
- Prefer the most SPECIFIC, concrete evidence the site offers — real names, exact numbers, prices, and short verbatim quotes — over vague summaries. If the site states a precise figure, use it exactly.
- Pull each field from wherever on the site it actually lives (story from the About page, prices from pricing/services, proof from reviews) — don't settle for a weaker version on the homepage when a richer one exists on a subpage.
- Never invent, embellish, round, or guess: no product, price, number, stat, quote, name, or claim that isn't clearly on the site. When the site doesn't support a field, return an empty string rather than a generic filler.
- Match the brand's own wording and voice; do not genericize.

IMPORTANT: Return ONLY the JSON object. No markdown, no code fences, no explanation.

WEBSITE CONTENT:
${truncated}`;

    // Use shared LLM helper (Grok → Groq fallback). More room to fill every field.
    const content = await callLLM({ timeoutMs: 60000,
      messages: [{ role: 'user', content: prompt }],
      model: 'grok',
      temperature: 0.3,
      max_tokens: 3500
    });
    const brandInfo = extractJson(content);
    if (!brandInfo) return res.status(500).json({ error: 'Failed to parse brand analysis', raw: content });

    // The homepage's most prominent text is usually a VALUE-PROP HEADLINE, not the name, so the LLM often
    // returns a whole sentence as "brandName". That paragraph then poisons the header, the coach greeting,
    // and the competitor-search queries below. Salvage the real short name: strip a "Name — tagline" /
    // "Name | tagline" / "Name: …" suffix, then if it still reads as a description (too long / too many
    // words) drop it to '' — better an empty name the user types than a paragraph in every surface.
    if (brandInfo.brandName != null) {
      let nm = String(brandInfo.brandName).replace(/\s+/g, ' ').trim();
      nm = nm.split(/\s+[—–|]\s+|\s+-\s+|:\s+/)[0].trim(); // "Mila Sourcing — we help…" / "Brand: tagline" → short name
      const words = nm ? nm.split(/\s+/).length : 0;
      brandInfo.brandName = (nm && nm.length <= 48 && words <= 6) ? nm : '';
    }

    // Enrich the brain from the WEB — facts, proof and reach ONLY, never voice.
    // A few PARALLEL searches feed ONE synthesis pass, so cost + wait stay small.
    // Fail-open + TIME-BOXED: the good brandInfo above must ALWAYS be returned, so
    // enrichment is capped to the request's remaining budget and can never push the
    // function past its maxDuration. Kill-switch: env WEB_ENRICH=off skips it.
    const _enrich = (process.env.WEB_ENRICH || 'all').toLowerCase();
    const _enrichBudget = 120000 - (Date.now() - _t0); // ~30s headroom under the 150s cap
    if (_enrich === 'off' || _enrichBudget < 15000) {
      debugInfo.webSkipped = (_enrich === 'off') ? 'disabled' : 'low-time-budget';
    } else {
      await Promise.race([
        new Promise(r => setTimeout(r, _enrichBudget)),
        (async () => {
      const bn = (brandInfo.brandName || '').toString().trim();
      const what = (brandInfo.description || brandInfo.products || '').toString().trim();
      const niche = (Array.isArray(brandInfo.suggestedCommunities) ? brandInfo.suggestedCommunities.slice(0, 3).join(', ') : (brandInfo.targetAudience || '')).toString().trim();
      if (bn) {
        // Short category phrase for competitor discovery. Most sites don't name
        // competitors, so we search the CATEGORY (what the brand does) — that
        // surfaces the real players even when the brand itself is little-known.
        const cat = (niche || what || '').toString().replace(/\s+/g, ' ').trim().slice(0, 60);
        const queries = [
          `${bn} competitors alternatives vs`
        ];
        if (cat) {
          queries.push(`best ${cat} companies brands`);
          queries.push(`top ${cat} alternatives compared`);
        }
        queries.push(`${bn} reviews reddit trustpilot customer`);
        queries.push(`${bn} reddit complaints problems disappointed`);
        queries.push(`${bn} instagram tiktok linkedin youtube official account`);
        queries.push(`${bn} press featured "as seen in" award`);
        if (cat) {
          queries.push(`${cat} biggest problems frustrations "i wish"`);
          queries.push(`why people complain about ${cat} reddit`);
        }
        if (niche) queries.push(`${niche} content trends`);
        // The web-enrichment JSON schema — shared by the Grok-search path AND the Jina
        // fallback so both stay identical. Brand-specific interpolation kept intact.
        const ENRICH_SCHEMA = `{
  "competitors": "3-6 REAL competitor/alternative brands in the same category as ${bn} (search 'best/top ${cat || 'category'} companies/alternatives'). Name actual brands even if they don't mention ${bn}, as long as they clearly compete in the same category. One per line, each with a short note on how ${bn} differs. Never invent a brand or output a generic placeholder — empty string only if none are found.",
  "channels": "The brand's real social/web channels as 'Platform: @handle or URL', one per line (empty string if none found)",
  "primaryChannel": "Full https URL of the single most active/official social profile (empty string if unknown)",
  "socialProofWeb": "Real third-party proof — press features, awards, ratings, review counts — each WITH its source name, one per line (empty string if none)",
  "customerVoice": "3-6 SHORT real phrases customers use about this brand or category, in their own words, one per line (empty string if none)",
  "trendTopics": ["up to 5 timely content-theme ideas for this niche — plain topics only, no marketing voice"],
  "webReputation": "2-4 sentences on what the WIDER WEB says about ${bn} overall — the general sentiment, what's praised, what's criticised, and how known/notable it seems. Empty string if you find nothing specific about ${bn}.",
  "categoryGripes": "3-6 things people complain about across this WHOLE CATEGORY (not just ${bn}) — the shared frustrations, unmet needs and 'I wish it did X' pulled from reviews, reddit and forums. These are content openings the brand can speak to. One per line. Empty string if none."
}`;
        let sj = null, _via = '';
        // PRIMARY: Grok live web-search — one agentic call researches + returns the JSON,
        // cited, on the existing XAI key (no scraping). Disable with WEB_ENRICH_GROK=off.
        if ((process.env.WEB_ENRICH_GROK || 'on').toLowerCase() !== 'off') {
          const gsRaw = await callGrokSearch(
            `Research the brand "${bn}"${what ? ' (which: ' + what.slice(0, 200) + ')' : ''} using LIVE web search — its reviews (Trustpilot, Google, reddit, forums), press/awards, real competitors in the same category, and the WHOLE category's common complaints. Base EVERY field ONLY on what you actually find; empty string (or empty array) if unsupported. Return ONLY this JSON, no prose and no code fences:\n${ENRICH_SCHEMA}`,
            { maxTokens: 1400 }
          );
          if (gsRaw) { sj = extractJson(gsRaw); if (sj) _via = 'grok-search'; }
        }
        // FALLBACK: the proven keyless Jina SERP + synthesis path (2 at a time, staggered).
        if (!sj) {
          const serps = await runSearchesLimited(queries, 2, 15000);
          const web = serps
            .map((s, i) => (s && s.length > 120) ? ('### RESULTS ' + (i + 1) + ' — "' + queries[i] + '"\n' + s.slice(0, 2600)) : '')
            .filter(Boolean).join('\n\n');
          if (web && web.length > 200) {
            const sprompt = `You are enriching a brand profile for "${bn}"${what ? ' (which: ' + what.slice(0, 200) + ')' : ''} using WEB SEARCH RESULTS below.
Use ONLY facts clearly supported by the results — never invent names, numbers, quotes, handles or links. Any field with no clear support must be an empty string (or empty array).

Return ONLY this JSON:
${ENRICH_SCHEMA}

WEB SEARCH RESULTS:
${web.slice(0, 12000)}`;
            const sraw = await callLLM({ timeoutMs: 60000, messages: [{ role: 'user', content: sprompt }], model: 'grok', temperature: 0.2, max_tokens: 1100 });
            sj = extractJson(sraw); if (sj) _via = 'jina';
          }
        }
        if (sj) {
          const t = v => (v == null ? '' : String(v).trim());
          if (t(sj.competitors)) { brandInfo.competitors = t(sj.competitors); debugInfo.webCompetitors = true; }
          if (t(sj.channels)) brandInfo.channels = t(sj.channels);
          if (t(sj.primaryChannel) && /^https?:\/\//i.test(t(sj.primaryChannel))) brandInfo.socialUrl = t(sj.primaryChannel);
          if (t(sj.socialProofWeb)) brandInfo.socialProof = [t(brandInfo.socialProof), t(sj.socialProofWeb)].filter(Boolean).join('\n');
          if (t(sj.customerVoice)) brandInfo.painPoints = [t(brandInfo.painPoints), t(sj.customerVoice)].filter(Boolean).join('\n');
          if (t(sj.webReputation)) { brandInfo.webMentions = t(sj.webReputation); debugInfo.webMentions = true; }
          if (t(sj.categoryGripes)) { brandInfo.categoryGripes = t(sj.categoryGripes); debugInfo.categoryGripes = true; }
          if (Array.isArray(sj.trendTopics) && sj.trendTopics.length) {
            const base = Array.isArray(brandInfo.suggestedCommunities) ? brandInfo.suggestedCommunities : [];
            brandInfo.suggestedCommunities = Array.from(new Set(base.concat(sj.trendTopics.map(String).filter(Boolean)))).slice(0, 12);
          }
          debugInfo.webEnriched = true;
          debugInfo.webVia = _via;
        }
      }
        })().catch(e => { debugInfo.webError = e.message; })
      ]);
    }

    // Record the crawl so it counts against the plan allowance and the cost fuse.
    // (Until this endpoint was gated above, this row was the ONLY trace of the spend and
    // nothing ever read it as a limit, because crawlbrand was registered at 0 credits.)
    try { await require('./_usage').logUsage({ userId: _cbUser.id, action: 'crawlbrand' }); } catch (e) {}

    return res.status(200).json({ brandInfo, url: siteUrl });

  } catch (err) {
    console.error('Crawl error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// Fetch via Jina Reader API (needs different headers than browser fetch)
function fetchJina(targetUrl) {
  const jinaUrl = 'https://r.jina.ai/' + targetUrl;
  return new Promise((resolve, reject) => {
    https.get(jinaUrl, {
      headers: {
        'Accept': 'text/plain',
        'X-Return-Format': 'text',
        'X-No-Cache': 'true',
        'User-Agent': 'Mozilla/5.0 (compatible; ContentEngine/1.0)'
      },
      timeout: 25000
    }, (resp) => {
      if (resp.statusCode !== 200) return reject(new Error('Jina HTTP ' + resp.statusCode));
      let data = '';
      // A bare resp.destroy() emits 'close', NOT 'error', and suppresses 'end' — so the old
      // "destroy at the cap" left this promise UNSETTLED forever (the function then hung until
      // the platform killed it, with no app-level error and no log line). Truncate-and-USE is
      // the intent, so settle FIRST with what we already have, then tear the socket down.
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      resp.setEncoding('utf8');
      resp.on('data', c => {
        data += c;
        if (data.length > 200000) {
          console.log('crawl-brand: fetchJina hit the 200KB cap for ' + targetUrl + ' — using the first 200KB');
          done(data);
          resp.destroy();
        }
      });
      resp.on('end', () => done(data));
      resp.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    }).on('error', reject).on('timeout', () => reject(new Error('Jina timeout')));
  });
}

// Fetch a page with redirect following
function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const follow = (u, depth) => {
      if (depth > 5) return reject(new Error('Too many redirects'));
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'identity',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        },
        timeout: 15000
      }, (resp) => {
        if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location) {
          let next = resp.headers.location;
          if (next.startsWith('/')) {
            const base = new URL(u);
            next = base.origin + next;
          }
          require('./_safeurl').assertPublicHttpUrl(next)
            .then(() => follow(next, depth + 1))
            .catch(() => reject(new Error('Blocked redirect')));
          return;
        }
        if (resp.statusCode !== 200) return reject(new Error(`HTTP ${resp.statusCode}`));
        let data = '';
        // Same never-settling trap as fetchJina above: destroy() with no error argument emits
        // 'close', not 'error', and kills 'end' — so hitting the cap used to hang the promise.
        // Resolve with the truncated page (that was always the intent), then destroy.
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; resolve(v); } };
        resp.setEncoding('utf8');
        resp.on('data', c => {
          data += c;
          if (data.length > 200000) { // Cap at 200KB
            console.log('crawl-brand: fetchPage hit the 200KB cap for ' + u + ' — using the first 200KB');
            done(data);
            resp.destroy();
          }
        });
        resp.on('end', () => done(data));
        resp.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
      }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
    };
    follow(url, 0);
  });
}

// Race any promise against a timeout that resolves to '' (fail-open).
function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise).catch(() => ''),
    new Promise(r => setTimeout(() => r(''), ms))
  ]);
}

// Rank a list of URLs down to the most brain-valuable pages (same-origin only),
// de-duped by CATEGORY so we get breadth (about + product + faq + reviews + ...).
function rankKeyUrls(urls, origin, limit) {
  const KEY = /(about|our-story|story|mission|who-we-are|product|shop|store|collection|catalog|menu|service|pricing|price|faq|help|review|testimonial|customer|blog|journal|news)/i;
  const order = ['about','story','mission','product','shop','collection','service','pricing','faq','review','testimonial','blog'];
  const seen = new Set();
  const cleaned = [];
  for (const raw of urls) {
    try {
      let u = raw;
      if (u.startsWith('//')) u = 'https:' + u;
      const p = new URL(u);
      if (p.origin !== origin) continue;             // same-site only (SSRF-safe)
      const clean = (p.origin + p.pathname).replace(/\/$/, '');
      if (clean === origin || seen.has(clean)) continue;  // skip homepage + dups
      seen.add(clean);
      cleaned.push(clean);
    } catch (e) { /* ignore bad urls */ }
  }
  const cand = cleaned.filter(u => KEY.test(u));
  cand.sort((a, b) => {
    const ra = order.findIndex(k => a.toLowerCase().includes(k));
    const rb = order.findIndex(k => b.toLowerCase().includes(k));
    return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
  });
  const catSeen = new Set();
  const picks = [];
  for (const u of cand) {
    const cat = order.find(k => u.toLowerCase().includes(k)) || u;
    if (catSeen.has(cat)) continue;                  // one page per category
    catSeen.add(cat);
    picks.push(u);
    if (picks.length >= (limit || 3)) break;
  }
  return picks;
}

// From the raw homepage (Jina markdown or HTML), pick same-origin key subpages.
function pickKeyLinks(raw, origin, limit) {
  if (!raw) return [];
  const urls = [];
  const re = /(?:href=["']|\]\()\s*([^"')\s>]+)/gi;
  let m;
  while ((m = re.exec(raw)) !== null) {
    let u = m[1];
    if (!u || u.startsWith('#') || u.startsWith('mailto:') || u.startsWith('tel:')) continue;
    if (u.startsWith('/')) u = origin + u;
    if (!/^https?:\/\//i.test(u) && !u.startsWith('//')) continue;
    urls.push(u);
  }
  return rankKeyUrls(urls, origin, limit || 3);
}

// Enumerate a site's pages from its sitemap (handles a sitemap index that
// points to child sitemaps), then rank to the most valuable ones. Fail-open.
async function pickSitemapLinks(origin, limit) {
  const candidates = [origin + '/sitemap.xml', origin + '/sitemap_index.xml', origin + '/sitemap-index.xml'];
  let xml = '';
  for (const u of candidates) {
    xml = await withTimeout(fetchPage(u), 9000);
    if (xml && /<(urlset|sitemapindex)/i.test(xml)) break;
    xml = '';
  }
  if (!xml) return [];
  const grabLocs = (s) => {
    const out = [];
    const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
    let mm;
    while ((mm = re.exec(s)) !== null) out.push(mm[1].trim());
    return out;
  };
  let locs = grabLocs(xml);
  // Sitemap index → fetch a child sitemap (prefer a "pages"/generic one) and read it.
  // SSRF guard: the child <loc> is site-controlled, so only follow it when it is
  // SAME-ORIGIN as the already-validated public site (skip CDN/cross-origin/internal).
  if (/<sitemapindex/i.test(xml) && locs.length) {
    const child = locs.find(u => /(page|main|content)/i.test(u)) || locs[0];
    let sameOrigin = false;
    try { sameOrigin = new URL(child).origin === origin; } catch (e) { sameOrigin = false; }
    if (sameOrigin) {
      const cx = await withTimeout(fetchPage(child), 9000);
      if (cx) locs = grabLocs(cx);
    }
  }
  return rankKeyUrls(locs, origin, limit || 6);
}

// Run several searches with limited concurrency + a small stagger, so keyless
// Jina search doesn't trip its rate limit. Preserves input order. Never throws.
async function runSearchesLimited(queries, limit, perTimeout) {
  const results = new Array(queries.length).fill('');
  let idx = 0;
  const worker = async () => {
    while (idx < queries.length) {
      const my = idx++;
      results[my] = await withTimeout(jinaSearch(queries[my]), perTimeout);
      await new Promise(r => setTimeout(r, 250)); // gentle spacing
    }
  };
  const n = Math.max(1, Math.min(limit || 2, queries.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

// Web search via Jina (s.jina.ai). Works keyless (rate-limited); uses a free
// JINA_API_KEY when present for reliability. Returns result text or '' on failure.
function jinaSearch(query) {
  const url = 'https://s.jina.ai/' + encodeURIComponent(query);
  return new Promise((resolve) => {
    const headers = {
      'Accept': 'text/plain',
      'X-Return-Format': 'text',
      'User-Agent': 'Mozilla/5.0 (compatible; ContentEngine/1.0)'
    };
    if (process.env.JINA_API_KEY) headers['Authorization'] = 'Bearer ' + process.env.JINA_API_KEY;
    const req = https.get(url, { headers, timeout: 16000 }, (resp) => {
      if (resp.statusCode !== 200) { resp.resume(); return resolve(''); }
      let data = '';
      resp.setEncoding('utf8');
      resp.on('data', c => { data += c; if (data.length > 150000) resp.destroy(); });
      resp.on('end', () => resolve(data));
      resp.on('error', () => resolve(''));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
  });
}

// Fetch one subpage as clean text, labelled. Tight per-attempt timeout; never throws.
async function fetchSubpageText(u) {
  let t = '';
  const j = await withTimeout(fetchJina(u), 11000);
  if (j && j.length > 200) t = j.substring(0, 7000);
  if (!t) {
    const h = await withTimeout(fetchPage(u), 9000);
    if (h && h.length > 100) t = extractText(h).substring(0, 7000);
  }
  return t ? ('\n\n--- PAGE: ' + u + ' ---\n' + t) : '';
}

// Extract Google Doc ID from various URL formats

// Extract meaningful text from HTML
function extractText(html) {
  // Remove script, style, nav, footer
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, ' [HEADER] ')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Extract title
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';

  // Extract meta description
  const metaMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
  const metaDesc = metaMatch ? metaMatch[1].trim() : '';

  // Extract og tags
  const ogTitle = (html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) || [])[1] || '';
  const ogDesc = (html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i) || [])[1] || '';

  // Get heading text
  const headings = [];
  const hRegex = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  let m;
  while ((m = hRegex.exec(html)) !== null) {
    headings.push(m[1].replace(/<[^>]+>/g, '').trim());
  }

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  return `TITLE: ${title}\nMETA: ${metaDesc}\nOG: ${ogTitle} - ${ogDesc}\nHEADINGS: ${headings.slice(0, 20).join(' | ')}\nBODY: ${text}`;
}
