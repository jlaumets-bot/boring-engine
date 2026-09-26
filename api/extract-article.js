const https = require('https');
const http = require('http');

module.exports = async function handler(req, res) {
  const allowed = ['https://contentshrimp.com','https://bettercontent.app','https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // This endpoint had NO gate and NO usage logging at all: it authenticated and then
  // fetched an arbitrary public URL and returned its body. That is an authenticated
  // general-purpose web proxy running on our IP reputation, callable without bound.
  // Now metered like everything else, so abuse costs the caller their own allowance.
  const _eaGuard = await require('./_usage').guard(req, 'extractarticle', res);
  if (!_eaGuard.user) return res.status(401).json({ error: 'Please sign in again.' });
  if (_eaGuard.over) {
    const _r = _eaGuard.gate && _eaGuard.gate.reason;
    return require('./_usage').denyResponse(res, _eaGuard.gate);
  }

  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Missing article URL' });
    try { await require('./_safeurl').assertPublicHttpUrl(String(url).trim()); }
    catch (e) { return res.status(400).json({ error: require('./_safeurl').urlRefusalMessage(e, 'That URL is not allowed.') }); }

    // Fetch the page HTML
    const pageHtml = await fetchPage(url);

    // Extract article text using simple heuristics
    let text = extractArticleText(pageHtml);

    if (!text || text.length < 50) {
      return res.status(400).json({ error: 'Could not extract meaningful text from this URL. Try a different article.' });
    }

    // Get title
    const titleMatch = pageHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';

    // Meter the fetch. Without a usage row the gate above can never fire, because
    // `used` would stay at 0 forever — the gate and the log only work as a pair.
    try { await require('./_usage').logUsage({ userId: _eaGuard.billingUserId || _eaGuard.user.id, action: 'extractarticle' }); } catch (e) {}

    return res.status(200).json({
      text: text.trim(),
      title,
      wordCount: text.trim().split(/\s+/).length
    });

  } catch (err) {
    console.error('Extract article error:', err);
    return res.status(500).json({ error: err.message });
  }
};

function fetchPage(url, redirectCount = 0) {
  if (redirectCount > 5) return Promise.reject(new Error('Too many redirects'));
  const mod = url.startsWith('https') ? https : http;

  return new Promise((resolve, reject) => {
    const req = mod.get(url, {
      lookup: require('./_safeurl').safeLookup, // v690 — re-check the address actually connected (closes DNS rebinding)
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      timeout: 15000
    }, (resp) => {
      if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location) {
        let newUrl = resp.headers.location;
        if (newUrl.startsWith('/')) {
          const u = new URL(url);
          newUrl = u.origin + newUrl;
        }
        require('./_safeurl').assertPublicHttpUrl(newUrl)
          .then(() => resolve(fetchPage(newUrl, redirectCount + 1)))
          .catch(() => reject(new Error('Blocked redirect')));
        return;
      }
      if (resp.statusCode >= 400) {
        return reject(new Error(`The page could not be loaded (HTTP ${resp.statusCode}). Check the URL and try again.`));
      }
      // Reject binary payloads up front — a video/zip/pdf URL would otherwise be buffered
      // whole into memory just to be thrown away by the HTML parser below.
      const ctype = String(resp.headers['content-type'] || '');
      if (ctype && !/^text\/|html|xml|json/i.test(ctype)) {
        resp.destroy();
        return reject(new Error('That link is not an article page — paste a link to a web page with text.'));
      }
      // Cap the response like every other fetcher in the codebase. destroy() with no error
      // argument emits 'close' (not 'error') and suppresses 'end', so we must settle FIRST
      // with what we have and only then tear the socket down — otherwise the promise never
      // settles and the function hangs until the platform kills it.
      const MAX_CHARS = 2_000_000;
      let data = '';
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      resp.setEncoding('utf8');
      resp.on('data', chunk => {
        data += chunk;
        if (data.length > MAX_CHARS) {
          console.log('extract-article: response hit the 2M-char cap for ' + url + ' — using what was read');
          done(data);
          resp.destroy();
        }
      });
      resp.on('end', () => done(data));
      resp.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    });
    req.on('error', (err) => reject(new Error('Could not connect to the URL. Check the link and try again.')));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out. The site took too long to respond.')); });
  });
}

function extractArticleText(html) {
  // Remove script, style, nav, header, footer, aside tags
  let clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '');

  // Try to find article or main content
  const articleMatch = clean.match(/<article[\s\S]*?>([\s\S]*?)<\/article>/i) ||
    clean.match(/<main[\s\S]*?>([\s\S]*?)<\/main>/i) ||
    clean.match(/<div[^>]*class="[^"]*(?:article|content|post|entry|story)[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  const content = articleMatch ? articleMatch[1] : clean;

  // Extract text from paragraphs
  const paragraphs = [];
  const pMatches = content.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi);
  for (const m of pMatches) {
    const text = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (text.length > 30) paragraphs.push(text);
  }

  if (paragraphs.length > 0) return paragraphs.join('\n\n');

  // Fallback: strip all tags
  const stripped = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return stripped.slice(0, 5000);
}
