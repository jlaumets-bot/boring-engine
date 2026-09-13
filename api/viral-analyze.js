// Viral Analyze — reverse-engineer WHY a currently-viral video works, then adapt it
// to the brand. The human supplies the live trend (transcript/description); the AI
// extracts the durable mechanics and produces brand-true ideas + a trend takeaway.
const { callLLM } = require('./_llm');
const { fullBrandBlock, extractJson } = require('./_brain');

module.exports = async function handler(req, res) {
  const allowed = ['https://contentshrimp.com','https://bettercontent.app','https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const _g = await require('./_usage').guard(req, 'viral');
  if (!_g.user) return res.status(401).json({ error: 'Please sign in again.' });
  if (_g.over) return res.status(402).json({ error: 'limit_reached', plan: _g.gate.plan, used: _g.gate.used, limit: _g.gate.limit, trialEndsAt: _g.gate.trialEndsAt });

  try {
    const { content, visualNotes, sourceUrl, platform, brandContext, brandId } = req.body || {};
    if ((!content || !content.toString().trim()) && (!visualNotes || !visualNotes.toString().trim())) {
      return res.status(400).json({ error: 'Paste the transcript, or describe what you see and hear in the video.' });
    }
    const visuals = (visualNotes || '').toString().trim();
    let bc = brandContext || {};

    // ── LEAN REQUEST: hydrate the brand brain from the database ────────────────
    // This request already carries a whole transcript the user pasted; it was ALSO re-uploading the
    // ~17KB brand snapshot the database already holds. A request carrying `brandId` did not upload
    // it. No brandId => the old full-context shape arrived and nothing here runs.
    //
    // The brand half is not decoration on this endpoint: the prompt asks the model to translate the
    // viral MECHANIC into this brand's world without copying the topic, in this brand's voice and
    // off its avoid-words. With an empty brain it still returns a confident, plausible breakdown —
    // just a generic one. So refuse instead, and let the client re-send what it has.
    if (brandId) {
      const _hyd = await require('./_brandctx').loadBrandContext(brandId, { userId: _g.user.id }, '');
      const _thin = _hyd.ok && Number.isFinite(bc.bcFields) && bc.bcFields > 2 &&
        _hyd.fields < Math.ceil(bc.bcFields / 2);
      if (!_hyd.ok || _thin) {
        return res.status(424).json({
          error: 'brand_context_unavailable',
          reason: _hyd.ok ? 'stale_brand_row' : _hyd.reason,
        });
      }
      bc = Object.assign({}, _hyd.bc, bc);
    }

    const brandInfo = fullBrandBlock(bc);

    const system = `You are a world-class short-form video strategist who reverse-engineers why a video worked. Any branded ideas you suggest must be punchy and gripping AND land in the brand's own voice (a dry brand stays dry, but dry and compelling — never flat). You do NOT have the video file — you are given (a) the spoken transcript and (b) human-written notes on the VISUALS and SOUND (on-screen text, how it's shot, editing/pacing, music). Use BOTH signals together. (Some visual notes may be an AUTO HOOK-FRAME READ — an automated vision read of the video's actual cover frame; treat it as ground truth for what the hook frame shows.) Virality is the combination of words + visuals + sound, so weight the visual/sound notes heavily when present.

Be concrete and honest. Identify the real reason it spread across all available signals: the hook (verbal AND visual), the structure/pacing, the pattern interrupt, the on-screen text, the sound/music role, the emotional or social trigger, the retention device. If a signal is missing (e.g. no visual notes given), say what you'd need to be sure rather than guessing. Do NOT invent metrics. Adapt to the brand WITHOUT copying the original's topic — translate the MECHANIC to the brand's world. Never invent brand product facts, prices, or ingredients. Never use the brand's avoid-words. Stay in the brand voice.`;

    const user = `VIRAL VIDEO (${platform || 'unknown platform'}${sourceUrl ? ', ' + sourceUrl : ''}):

SPOKEN TRANSCRIPT:
"""
${(content || '(none provided)').toString().slice(0, 6000)}
"""

WHAT THE USER SEES & HEARS (visuals, on-screen text, shooting style, music/sound):
"""
${visuals ? visuals.slice(0, 2000) : '(none provided — analyze from the transcript only, and note that visual/sound signals are missing)'}
"""

BRAND CONTEXT:
${brandInfo || '(no extra brand context — do NOT invent product specifics; keep adapted ideas general and on-voice)'}

TASK:
1) Explain why this video works (the transferable mechanics).
2) Adapt those mechanics into 3 brand-true content ideas (translate the mechanic, NOT the topic).
3) Give ONE short "trend takeaway" — a single transferable rule the brand should remember and reuse (max 18 words).

Respond with EXACTLY this JSON and nothing else:
{
  "whyItWorks": ["bullet 1", "bullet 2", "bullet 3"],
  "hook": "what the opening hook does in one line",
  "structure": "the structure/pacing in one line",
  "trigger": "the core emotional/social trigger in one line",
  "ideas": [
    {"format": "video|statement|carousel|micro|static", "title": "short title", "hook": "hook, max 8 words", "angle": "one line on the angle", "script": "2-4 line starter script or slide list"}
  ],
  "takeaway": "one transferable rule, max 18 words"
}
Exactly 3 items in "ideas".`;

    const result = await callLLM({
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      model: 'grok',
      max_tokens: 2200,
      engine: (bc.engine || 'grok'),
    });
    if (!result) return res.status(502).json({ error: 'No response from the AI — try again' });

    const analysis = extractJson(result);
    if (!analysis) return res.status(502).json({ error: 'Could not parse the analysis — try again' });

    await require('./_usage').logUsage({ userId: _g.user.id, brandId: bc.brandId || bc.brand_id || null, action: 'viral', model: bc.engine || 'grok' });
    return res.status(200).json({ analysis });
  } catch (err) {
    console.error('viral-analyze error:', err);
    return res.status(500).json({ error: 'Viral analysis failed — try again' });
  }
};
