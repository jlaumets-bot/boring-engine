const https = require('https');
const { callLLM } = require('./_llm');
const { fullBrandBlock } = require('./_brain');

module.exports = async function handler(req, res) {
  const allowed = ['https://contentshrimp.com','https://bettercontent.app','https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const _g = await require('./_usage').guard(req, 'expand', res);
  if (!_g.user) return res.status(401).json({ error: 'Please sign in again.' });
  if (_g.over) return require('./_usage').denyResponse(res, _g.gate);

  try {
    const { fieldName, brandContext } = req.body || {};
    // Coerce before touching — a non-string currentValue threw on .trim() and became a
    // generic 500. Same String(x || '') pattern the other endpoints use.
    const currentValue = String((req.body && req.body.currentValue) || '');
    const fieldLabel = String((req.body && req.body.fieldLabel) || 'this field').slice(0, 120);

    if (!currentValue.trim()) {
      return res.status(400).json({ error: 'No content to expand' });
    }

    const bc = brandContext || {};
    const brandInfo = fullBrandBlock(bc);

    const fieldInstructions = {
      usps: 'Expand each USP to be specific and concrete. Turn vague claims like "high quality" into measurable facts. Add 2-3 more if possible. One per line.',
      targetAudience: 'Make the audience description specific: demographics, psychographics, pain points, where they hang out online. Be detailed but concise.',
      competitors: 'Add context for each competitor: what they do well, where they fall short, and how this brand differs. One per line.',
      bannedTopics: 'Keep each item but clarify why. Add any obvious related topics that should also be avoided. One per line.',
      painPoints: 'Rewrite in the customer\'s actual voice — raw, emotional language. Add related frustrations they probably also feel. Make these sound like real quotes.',
      brandVocab: 'Keep all existing terms. Add variations, related catchphrases, and natural ways to use them in content. Group by usage context.',
      avoidWords: 'Keep all listed words. Add commonly overused AI/marketing words that sound generic. Explain briefly why each feels off-brand.',
      productDetails: 'Add structure: product name, size/variant, price, key ingredients or features. Make it scannable so the AI can reference specific products.',
      exampleContent: 'Describe what makes each example work — tone, structure, hook style, CTA approach. This helps the AI understand the pattern, not just the example.',
      ctaStyle: 'Expand with 3-5 variations of CTAs that match this brand\'s voice. Include soft CTAs, hard CTAs, and story-based CTAs.',
      originStory: 'Flesh out the narrative arc: the problem noticed, the moment of decision, early struggles, and the mission now. Keep it authentic, not polished.',
      socialProof: 'Add specific numbers, timeframes, and sources where possible. Turn vague claims into verifiable stats. Format for easy copy-paste into content.',
      visualStyle: 'Get specific: color hex codes or names, lighting style, camera angles, backgrounds, props, mood references. Think "brief for a photographer."',
      tones: 'Sharpen each tone word into something a writer can act on. Stay strictly inside the existing tones — never add tones that contradict them, never soften them. If the brand is dry, the description must be dry. Fewer, sharper words beat more words.',
      coachNotes: 'Tighten each rule to its shortest actionable form, one per line. Remove duplicates. Never add new rules the user did not state.'
    };

    // hasOwnProperty, not a bare lookup: fieldName is user-supplied, and 'constructor' /
    // '__proto__' would otherwise resolve to an inherited value and land in the prompt.
    const instruction = (typeof fieldName === 'string' && Object.prototype.hasOwnProperty.call(fieldInstructions, fieldName))
      ? fieldInstructions[fieldName]
      : 'Expand this to be more specific, detailed, and useful for AI content generation. Keep the same intent but make it richer.';

    const systemPrompt = `You are a brand strategist helping a content creator fill in their brand profile. Your job is to take their rough, short input and expand it into something specific, detailed, and immediately useful for AI content generation.

Rules:
- Keep their original voice and intent — don't make it corporate
- Be specific and concrete, not fluffy
- Output ONLY the improved field content, no explanations or labels
- Match the format expected (usually one item per line)
- Don't add generic filler — every word should be useful
- RESPECT THE VOICE: if tones, avoid-words, or Voice Memory are given, they are law. Never use an avoided word. Never shift the voice warmer, softer, or more enthusiastic than the brand is.
- Better usually means SHARPER, not longer. Only add length when it adds concrete information.
${brandInfo ? '\nBrand context:\n' + brandInfo : ''}`;

    const userPrompt = `Field: "${fieldLabel}"
Current value:
${currentValue.trim().slice(0, 6000)}

Instructions: ${instruction}

Return ONLY the improved content for this field.`;

    const expanded = (await callLLM({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      model: 'grok',
      temperature: 0.7,
      max_tokens: 800
    })).trim();
    // Only attribute the usage row to a brand the caller actually owns — this id comes from the
    // client and went into usage_events unverified. Same pattern as pull-trends.js /
    // creator-posts.js: a check that cannot run leaves the row unattributed, never unlogged.
    let logBrandId = null;
    const _bid = bc.brandId || bc.brand_id || null;
    if (_bid) {
      try {
        const store = require('./_publish/store');
        if (await store.userCanAccessBrand(_g.user.id, _bid)) logBrandId = _bid;
      } catch (e) {}
    }
    await require('./_usage').logUsage({ userId: _g.billingUserId || _g.user.id, brandId: logBrandId, action: 'expand', model: bc.engine || 'grok' });
    return res.status(200).json({ expanded });

  } catch (err) {
    console.error('expand-field error:', err);
    return res.status(500).json({ error: "Couldn't expand that field just now — please try again." });
  }
};
