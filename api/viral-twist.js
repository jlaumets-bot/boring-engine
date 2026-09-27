// Viral Twist — take an existing idea and return punchier, scroll-stopping angles.
// Uses TIMELESS virality mechanics (no live-trend data). Stays brand-true and on-voice.
const { aiUnavailable } = require('./_llm');
const { writerCallResilient, writerProvider, writerEffort, startBrandAttribution } = require('./_write');   // v693 r3 — provider switch + thinking depth with headroom (see api/_write.js)
const { fullBrandBlock, rulePrecedence, extractJson, coerceShape, VIRAL_TWIST_SHAPE } = require('./_brain');
// v693 — content-v2 writing rules (.unlazy/content-v2/PLAN.md change 3): the short style guide
// (whose one hard rule is NO_INVENTION_RULE) replaces writingCraft's rulebook and the "max 8 words
// per hook, fragments beat full sentences" rule; the brand renders through fullBrandBlock(bc,{v2:true}).
const { styleGuide } = require('./_write');

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

    const brandInfo = fullBrandBlock(bc, { v2: true });   // v693 — v2: tones <= 3, USPs as background facts, held beliefs

    const system = `You are a world-class viral content strategist. You take an existing content idea and give it a VIRAL TWIST — maximizing stop-scroll power and punch WITHOUT changing the brand's product truth or its voice. Punchier, sharper, higher-tension. Never flat or watered-down. A dry brand stays dry — but dry AND gripping, not boring.

You rely on TIMELESS virality mechanics: pattern interrupts, curiosity gaps, open loops, contrarian/controversial angles, sharp specificity (only specifics the brand context or the post actually contains), tribal identity, stakes, before/after, and emotional triggers. If the brand context below lists CURRENT TRENDS the user flagged as working right now, weight those too — translate their MECHANIC into a brand-true twist, never copy the original topic.

HOOKS:
- Each hook is the first line a person would actually say: plain, specific, and it creates tension or curiosity. It must work as on-screen text and pass the "thumb-stop test", in the brand's voice.
- A hook has no room for a [your story: ...] slot, so a hook never carries a number, name or result the brand context does not give you: cut the claim instead.
- Match the brand voice/tones. NEVER use any of the avoid-words.

${styleGuide()}`;

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
    {"angle": "tactic name (e.g. Contrarian, Specificity, Open loop)", "hook": "new hook: the first line, as a person would say it", "why": "one line: why it stops the scroll"}
  ],
  "spicy": {"hook": "the boldest hook", "why": "why it's riskier but higher-reward"},
  "tip": "one practical line on how to deliver/film it for max retention"
}
Exactly 3 items in "angles".

${rulePrecedence()}`;

    // v693 r3 — START the brand-attribution check now and await it after the AI work, so it never
    // adds Supabase time after the model answers (a killed function delivers nothing).
    const _brandAttr = startBrandAttribution(_g.user.id, bc.brandId || bc.brand_id || null);
    const content = await writerCallResilient({ deadlineMs: 280000, provider: writerProvider(), effort: writerEffort('edit'),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      model: 'grok',
      max_tokens: 2500,
      engine: (bc.engine || 'grok'),
    }, { providerFromEnv: true, label: 'viral-twist' });
    if (!content) return res.status(502).json({ error: 'No response from the AI — try again' });

    const _raw = extractJson(content);
    if (!_raw) return res.status(502).json({ error: 'Could not parse the viral twist — try again' });
    // v673: the model's JSON is an untrusted SHAPE. An array or object where a string
    // was asked for used to go straight to the client, and its `.trim()` inside
    // the angles .forEach() threw — killing the twist panel with nothing on screen.
    const twist = coerceShape(_raw, VIRAL_TWIST_SHAPE);

    // Only attribute the usage row to a brand the caller actually owns — this id comes from the
    // client and went into usage_events unverified. Same pattern as pull-trends.js:
    // a check that cannot run leaves the row unattributed, never unlogged.
    const logBrandId = await _brandAttr;   // v693 r3 — the access check was started before the AI work
    await require('./_usage').logUsage({ userId: _g.billingUserId || _g.user.id, brandId: logBrandId, action: 'viral', model: require('./_write').usageModel(bc) });
    return res.status(200).json({ twist });
  } catch (err) {
    const ai = aiUnavailable(err); if (ai) return res.status(ai.status).json(ai.body);   // v690 — a refused AI account (no credits / spending limit) is a 503 with the honest message, not "try again"
    console.error('viral-twist error:', err);
    return res.status(500).json({ error: 'Viral twist failed — try again' });
  }
};
