const { callLLM } = require('./_llm');
const { fullBrandBlock, extractJson } = require('./_brain');

// Generates brand-specific "example chip" suggestions for the Settings fields,
// so a user filling in their profile sees ideas relevant to THEIR vertical/voice
// (not another brand's). Cheap, cached per-brand on the client. Never invents
// facts about the brand — these are neutral starting prompts phrased for the
// brand's niche, meant as tap-to-fill seeds the user then edits.

const FIELDS = {
  usps: 'unique selling points — specific, concrete claims this kind of brand could make',
  targetAudience: 'distinct target-audience segments for this brand',
  competitors: 'real or archetypal competitors / alternatives in this brand\'s space',
  bannedTopics: 'topics this brand would sensibly never post about',
  painPoints: 'customer frustrations this brand solves, in the customer\'s own voice',
  brandVocab: 'signature phrases / vocabulary that would fit this brand',
  productDetails: 'the kinds of products/services/offers this brand likely sells',
  exampleContent: 'content formats/ideas that would work for this brand',
  ctaStyle: 'calls-to-action that match this brand\'s voice',
  originStory: 'origin-story angles that would fit a brand like this',
  socialProof: 'types of social proof / stats this brand could cite',
  visualStyle: 'visual-aesthetic directions that suit this brand',
  paaKeywords: 'search keywords this brand\'s audience would Google (for "People Also Ask")'
};

module.exports = async function handler(req, res) {
  const allowed = ['https://contentshrimp.com','https://bettercontent.app','https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const _g = await require('./_usage').guard(req, 'settingsexamples');
  if (!_g.user) return res.status(401).json({ error: 'Please sign in again.' });
  if (_g.over) return res.status(402).json({ error: 'limit_reached', plan: _g.gate.plan, used: _g.gate.used, limit: _g.gate.limit, trialEndsAt: _g.gate.trialEndsAt });

  try {
    const bc = (req.body && req.body.brandContext) || {};
    const brandInfo = fullBrandBlock(bc);
    // Need at least some signal about the brand to tailor; otherwise the client
    // keeps its neutral fallback and never calls us.
    if (!brandInfo || !brandInfo.trim()) {
      return res.status(400).json({ error: 'not enough brand context' });
    }

    const fieldList = Object.entries(FIELDS)
      .map(([k, desc]) => `- "${k}": ${desc}`)
      .join('\n');

    const systemPrompt = `You help a content creator fill in their brand profile. Given a brand's context, produce short EXAMPLE suggestions for each profile field — tap-to-fill seeds the user will edit. They must fit THIS brand's industry, audience, and voice.

Rules:
- Tailor every suggestion to this specific brand's vertical — never use examples from an unrelated industry.
- Each item is SHORT (2–7 words), concrete, and phrased as a suggestion the user could accept and tweak.
- Do NOT invent hard facts (no fake prices, fake stats, fake press). Phrase product/proof items as neutral templates the user fills in (e.g. "Flagship service — starting price", "Rating or review count").
- Respect the brand voice, tones, and any avoid-words provided: never output an avoided word.
- Return STRICT JSON only, no prose, no code fences.

Brand context:
${brandInfo}`;

    const userPrompt = `Return a JSON object with EXACTLY these keys, each an array of 4–6 short example strings tailored to the brand above:
${fieldList}

JSON only.`;

    const raw = await callLLM({ timeoutMs: 22000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.8,
      max_tokens: 900
    });

    const parsed = extractJson(raw) || {};
    // Keep only known keys, arrays of clean short strings, capped at 6.
    const examples = {};
    for (const key of Object.keys(FIELDS)) {
      const v = parsed[key];
      if (Array.isArray(v)) {
        const clean = v
          .map(x => (typeof x === 'string' ? x.trim() : ''))
          .filter(Boolean)
          .filter(x => x.length <= 80)
          .slice(0, 6);
        if (clean.length) examples[key] = clean;
      }
    }

    if (!Object.keys(examples).length) {
      return res.status(502).json({ error: 'could not generate examples' });
    }

    await require('./_usage').logUsage({ userId: _g.user.id, brandId: bc.brandId || bc.brand_id || null, action: 'settingsexamples', model: 'grok' });
    return res.status(200).json({ examples });

  } catch (err) {
    console.error('settings-examples error:', err);
    return res.status(500).json({ error: "Couldn't build examples just now." });
  }
};
