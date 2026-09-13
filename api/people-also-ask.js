const https = require('https');

module.exports = async function handler(req, res) {
  const allowed = ['https://contentshrimp.com','https://bettercontent.app','https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const _g = await require('./_usage').guard(req, 'paa');
  if (!_g.user) return res.status(401).json({ error: 'Please sign in again.' });
  if (_g.over) return res.status(402).json({ error: 'limit_reached', plan: _g.gate.plan, used: _g.gate.used, limit: _g.gate.limit, trialEndsAt: _g.gate.trialEndsAt });

  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Search is temporarily unavailable.' });
  }

  try {
    const { keywords, brandContext } = req.body;
    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
      return res.status(400).json({ error: 'Missing keywords array' });
    }

    // One SerpAPI call per keyword. Each call has its own timeout and never rejects,
    // so one slow/failing keyword can't hang the whole request. Run them in PARALLEL
    // (was sequential — up to 5 round-trips back to back, which routinely blew past
    // the function limit and left the UI stuck on a spinner).
    const fetchKeyword = (keyword) => new Promise((resolve) => {
      const params = new URLSearchParams({ engine: 'google', q: keyword, api_key: apiKey, num: '10' });
      const url = `https://serpapi.com/search.json?${params.toString()}`;
      const req = https.get(url, (resp) => {
        let data = '';
        resp.on('data', chunk => data += chunk);
        resp.on('end', () => {
          try { resolve({ keyword, status: resp.statusCode, body: JSON.parse(data) }); }
          catch (e) { resolve({ keyword, status: resp.statusCode, body: {} }); }
        });
      });
      req.on('error', () => resolve({ keyword, status: 0, body: {} }));
      req.setTimeout(12000, () => { req.destroy(); resolve({ keyword, status: 0, body: {} }); });
    });

    const results = await Promise.all(keywords.slice(0, 5).map(fetchKeyword));

    // SerpAPI shapes drift. An item without a usable `question`/`query` is SKIPPED, not
    // pushed — before, a single missing field threw a TypeError at the .toLowerCase()
    // below and took the whole request to a 500.
    const allQuestions = [];
    const asText = (v) => (typeof v === 'string' ? v.trim() : '');
    for (const response of results) {
      const keyword = response.keyword;
      const body = response.body || {};
      if (response.status === 200 && Array.isArray(body.related_questions)) {
        for (const q of body.related_questions) {
          const question = asText(q && q.question);
          if (!question) continue;
          allQuestions.push({
            question,
            snippet: asText(q && q.snippet),
            source: asText(q && q.source && q.source.name) || 'Google',
            keyword
          });
        }
      }
      if (response.status === 200 && Array.isArray(body.related_searches)) {
        for (const rs of body.related_searches.slice(0, 3)) {
          const question = asText(rs && rs.query);
          if (!question) continue;
          allQuestions.push({ question, snippet: '', source: 'Related', keyword });
        }
      }
    }

    // Deduplicate by question text
    const seen = new Set();
    const unique = allQuestions.filter(q => {
      const key = String(q.question || '').toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Relevance should come from the BRAIN. SerpAPI returns whatever Google's "People Also Ask"
    // surfaces for a keyword, which for a niche brand includes tangential/off-topic questions. When we
    // have the brand brain + an XAI key, let Grok keep ONLY the questions this brand's audience would
    // actually search. Best-effort — any failure falls back to the unfiltered list (no regression).
    let questions = unique;
    try {
      const { brainSummaryFrom } = require('./_trends');
      const brain = brainSummaryFrom(brandContext);
      if (brain && process.env.XAI_API_KEY && unique.length > 3) {
        const { callLLM } = require('./_llm');
        const list = unique.map((q, i) => `${i}. ${q.question}`).join('\n');
        // Bound the filter to 20s (function budget is 45s, SerpAPI ran first) — if Grok is slow the
        // race rejects, the catch below keeps the UNFILTERED list, and PAA never times out / breaks.
        const resp = await Promise.race([
          callLLM({ timeoutMs: 34000,
            messages: [
              { role: 'system', content: 'You filter candidate "People Also Ask" search questions down to only the ones genuinely ON-TOPIC and worth answering in content for a SPECIFIC brand. Drop anything tangential, off-niche, or that the brand\'s audience would not care about. Reply with ONLY a JSON array of the kept item numbers, e.g. [0,2,5]. Keep the clearly-relevant ones; when unsure, drop it.' },
              { role: 'user', content: `THE BRAND:\n${brain}\n\nCANDIDATE QUESTIONS:\n${list}\n\nReturn the numbers of ONLY the on-topic ones as a JSON array.` },
            ],
            temperature: 0.1, max_tokens: 250,
          }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('paa-filter-timeout')), 20000)),
        ]);
        const m = String(resp || '').match(/\[[\d,\s]*\]/);
        if (m) {
          const keep = JSON.parse(m[0]);
          if (Array.isArray(keep) && keep.length) {
            const kept = keep.map(i => unique[i]).filter(Boolean);
            if (kept.length) questions = kept; // only replace if the filter actually kept some
          }
        }
      }
    } catch (_) { questions = unique; }

    await require('./_usage').logUsage({ userId: _g.user.id, action: 'paa' });
    return res.status(200).json({ questions, count: questions.length });

  } catch (err) {
    console.error('PAA error:', err);
    return res.status(500).json({ error: "Couldn't fetch what people search — please try again." });
  }
};
