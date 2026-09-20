// Viral Twist — take an existing idea and return punchier, scroll-stopping angles.
// Uses TIMELESS virality mechanics (no live-trend data). Stays brand-true and on-voice.
const { callLLM } = require('./_llm');
const { fullBrandBlock, writingCraft, rulePrecedence, extractJson, coerceShape, VIRAL_TWIST_SHAPE } = require('./_brain');

module.exports = async function handler(req, res) {
  const allowed = ['https://contentshrimp.com','https://bettercontent.app','https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const _g = await require('./_usage').guard(req, 'viral', res);
  if (!_g.user) return res.status(401).json({ error: 'Please sign in again.' });
  if (_g.over) return require('./_usage').denyResponse(res, _g.gate);

  try {
    const { idea, brandContext , brandId, bcFields } = req.body || {};
    if (!idea || !(idea.title || idea.hook || idea.script || idea.boldText)) {
      return res.status(400).json({ error: 'No idea provided' });
    }
    let bc = brandContext || {};
    // v625: HYDRATE THE BRAND BRAIN SERVER-SIDE. app.html now sends a LEAN request here
    // (brandId + only what the database cannot know). Without this branch the handler received
    // `brandContext: {recentTrends}` and fullBrandBlock rendered a BRAND PROFILE containing
    // nothing but a trends line — i.e. this endpoint was generating with NO brand brain at all,
    // silently, producing generic output that still LOOKS fine. Caught before it shipped.
    // Refuse rather than write brand-less content: 424 makes the client re-send what it has.
    if (brandId) {
      // humanEditedTitles is localStorage-only knowledge, so the hydration cannot derive it (same
      // reason recentTrends is sent). Without it every hydrated winner is labelled machine-written
      // and _brain's approvedWinnersBlock demotes the user's own rewrites. Form copied from generate-ideas.
      const _hyd = await require('./_brandctx').loadBrandContext(brandId, { userId: _g.user.id, humanEdited: req.body && req.body.humanEditedTitles }, '');
      const _thin = _hyd.ok && Number.isFinite(bcFields) && bcFields > 2 &&
        _hyd.fields < Math.ceil(bcFields / 2);
      if (!_hyd.ok || _thin) {
        return res.status(424).json({
          error: 'brand_context_unavailable',
          reason: _hyd.ok ? 'stale_brand_row' : _hyd.reason,
        });
      }
      bc = Object.assign({}, _hyd.bc, bc);
    }

    const brandInfo = fullBrandBlock(bc);

    const system = `You are a world-class viral content strategist. You take an existing content idea and give it a VIRAL TWIST — maximizing stop-scroll power and punch WITHOUT changing the brand's product truth or its voice. Punchier, sharper, higher-tension. Never flat or watered-down. A dry brand stays dry — but dry AND gripping, not boring.

You rely on TIMELESS virality mechanics: pattern interrupts, curiosity gaps, open loops, contrarian/controversial angles, sharp specificity, tribal identity, stakes, before/after, and emotional triggers. If the brand context below lists CURRENT TRENDS the user flagged as working right now, weight those too — translate their MECHANIC into a brand-true twist, never copy the original topic.

HOOK RULES:
- Max 8 words per hook. Fragments beat full sentences. The first word must create tension or curiosity.
- Each hook must work as on-screen text and pass the "thumb-stop test" — punchy and impossible to scroll past, in the brand's voice.
- Stay literally true to the brand's product facts above. NEVER invent claims, prices, or ingredients.
- Match the brand voice/tones. NEVER use any of the avoid-words.
- NEVER use AI-tell openers: "Did you know", "In this video", "Here's the thing", "Quick question", "Most people don't realize", "Let me tell you", "Have you ever".

${writingCraft({ spoken: false, precedence: false })}`;

    const user = `EXISTING POST:
Title: ${idea.title || ''}
Format: ${idea.format || ''}
Current hook: ${idea.hook || ''}
Body/script: ${(idea.boldText || idea.script || '').toString().slice(0, 1200)}

BRAND CONTEXT:
${brandInfo || '(no extra brand context — do NOT invent any product specifics; keep it general and on-voice)'}

TASK: Give this post a viral twist. Produce 3 DISTINCT viral angles (different tactics), each with a punchier hook and a one-line reason it stops the scroll. Then one bolder "spicy" version that pushes a contrarian or higher-stakes take (still brand-true). Keep everything in the brand voice.

Respond with EXACTLY this JSON shape and nothing else:
{
  "angles": [
    {"angle": "tactic name (e.g. Contrarian, Specificity, Open loop)", "hook": "new hook, max 8 words", "why": "one line: why it stops the scroll"}
  ],
  "spicy": {"hook": "the boldest hook", "why": "why it's riskier but higher-reward"},
  "tip": "one practical line on how to deliver/film it for max retention"
}
Exactly 3 items in "angles".

${rulePrecedence()}`;

    const content = await callLLM({ deadlineMs: 280000,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      model: 'grok',
      max_tokens: 1200,
      engine: (bc.engine || 'grok'),
    });
    if (!content) return res.status(502).json({ error: 'No response from the AI — try again' });

    const _raw = extractJson(content);
    if (!_raw) return res.status(502).json({ error: 'Could not parse the viral twist — try again' });
    // v673: the model's JSON is an untrusted SHAPE. An array or object where a string
    // was asked for used to go straight to the client, and its `.trim()` inside
    // the angles .forEach() threw — killing the twist panel with nothing on screen.
    const twist = coerceShape(_raw, VIRAL_TWIST_SHAPE);

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
    await require('./_usage').logUsage({ userId: _g.billingUserId || _g.user.id, brandId: logBrandId, action: 'viral', model: bc.engine || 'grok' });
    return res.status(200).json({ twist });
  } catch (err) {
    console.error('viral-twist error:', err);
    return res.status(500).json({ error: 'Viral twist failed — try again' });
  }
};
