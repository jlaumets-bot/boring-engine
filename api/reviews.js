// Pull real CUSTOMER REVIEWS via Grok live web-search and distil them into the
// brand-brain "Customer reviews" field. Uses the existing XAI key (no Apify actor,
// no review-page URL hunting) so it works for ANY brand — Grok finds whatever reviews
// exist (Trustpilot, Google, Amazon, App Store, G2, reddit) and synthesises them.
// If Grok search is off/unavailable it returns an empty result (graceful, never errors hard).
const { callGrokSearch } = require('./_llm');
const { extractJson } = require('./_brain');

module.exports = async function handler(req, res) {
  const allowed = ['https://contentshrimp.com', 'https://bettercontent.app', 'https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const _g = await require('./_usage').guard(req, 'crawlbrand');
  if (!_g.user) return res.status(401).json({ error: 'Please sign in again.' });
  if (_g.over) return res.status(402).json({ error: 'limit_reached', plan: _g.gate.plan, used: _g.gate.used, limit: _g.gate.limit, trialEndsAt: _g.gate.trialEndsAt });

  try {
    const bn = String((req.body && req.body.brandName) || '').trim();
    const website = String((req.body && req.body.website) || '').trim().slice(0, 120);
    const category = String((req.body && req.body.category) || '').trim().slice(0, 80);
    if (!bn) return res.status(400).json({ error: 'Add your brand name first.' });

    const schema = `{
  "summary": "2-3 sentences on overall customer sentiment, plus the average star rating if you can see one. Empty string if you find no real reviews.",
  "praises": "The 4-6 things customers most PRAISE, one per line, in the customers' own words.",
  "complaints": "The 4-6 things customers most COMPLAIN about, one per line, verbatim where possible.",
  "phrases": "6-10 exact SHORT phrases real customers use (their words, not marketing), one per line.",
  "sources": "The review sources you actually found (e.g. Trustpilot, Google, Amazon, App Store, G2, reddit), comma-separated. Empty string if none."
}`;
    const prompt = `Find and read REAL customer reviews of the brand "${bn}"${website ? ' (' + website + ')' : ''}${category ? ', which is in: ' + category : ''}. Search Trustpilot, Google reviews, Amazon, the App Store / Play Store, G2, reddit and forums. Summarise what ACTUAL customers say. Base EVERY field ONLY on real reviews you find — never invent quotes, numbers or ratings. If you truly find no customer reviews, return empty strings. Return ONLY this JSON, no prose and no code fences:\n${schema}`;

    // v593: cap the search below this function's 60s budget. callGrokSearch's own timeout is 90s, so
    // a slow-but-succeeding search would get the whole request platform-killed (same class of bug as
    // the brand-voice-chat one). Returns null on timeout → handled as "no reviews found".
    const raw = await Promise.race([
      callGrokSearch(prompt, { maxTokens: 1500 }),
      new Promise(r => setTimeout(() => r(null), 45000))
    ]);
    const data = raw ? extractJson(raw) : null;
    if (!data) {
      return res.status(200).json({ reviewInsights: '', empty: true });
    }

    const t = v => (v == null ? '' : String(v).trim());
    const parts = [];
    if (t(data.summary)) parts.push(t(data.summary));
    if (t(data.praises)) parts.push('What they praise:\n' + t(data.praises));
    if (t(data.complaints)) parts.push('What they complain about:\n' + t(data.complaints));
    if (t(data.phrases)) parts.push('Real phrases they use:\n' + t(data.phrases));
    const reviewInsights = parts.join('\n\n').trim();

    await require('./_usage').logUsage({ userId: _g.user.id, action: 'crawlbrand', model: 'grok-search-reviews' });
    return res.status(200).json({ reviewInsights, sources: t(data.sources) });
  } catch (e) {
    console.error('reviews error:', e);
    return res.status(500).json({ error: 'Could not pull reviews — please try again.' });
  }
};
