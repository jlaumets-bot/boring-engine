// Viral Rewrite — regenerate a FULL post around a chosen viral angle.
// Keeps the same format + brand truth/voice; rewrites hook + body + caption + shots + tags.
const { callLLM } = require('./_llm');
const { fullBrandBlock, writingCraft, rulePrecedence, extractJson, coerceShape, VIRAL_REWRITE_SHAPE } = require('./_brain');

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
  if (_g.over) return require('./_usage').denyResponse(res, _g.gate);

  try {
    const { idea, angle, brandContext , brandId, bcFields } = req.body || {};
    if (!idea || !(idea.title || idea.hook || idea.script || idea.boldText)) {
      return res.status(400).json({ error: 'No idea provided' });
    }
    if (!angle || !(angle.hook || angle.angle)) {
      return res.status(400).json({ error: 'No angle provided' });
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

    const fmt = (idea.format || 'video').toString();

    const brandInfo = fullBrandBlock(bc);

    // NOTE — "screen" (on-screen text) is deliberately absent from every line below and from the
    // JSON schema. generate-ideas dropped it in v609 after checking every use: the split-screen
    // renderer ignores it (video-beats generates its own overlays) and app.html has no display
    // site left for it — only a normaliser and a DB row map. This file kept asking for it, so the
    // model was writing 3-6 overlays per rewrite that nothing could ever show. Do not re-add it
    // without a render site.
    const formatGuide = {
      video: 'Vertical Reel/TikTok, 30-60s. script = spoken words (90-150 words, full sentences of varied length). shots = 4-8 concrete phone shots.',
      micro: '10-15s single-fact video. script = 30-60 spoken words, one surprising fact + why it matters. shots = 1-3.',
      qna: 'A real audience question + filmed answer under 30s. title = the raw question. script = the answer (first sentence answers directly, MAX 60 words). shots = 1-3.',
      statement: 'Bold text-graphic statement. boldText = the full statement (2-5 short sentences, setup + payoff, stands alone). script = 2-3 lines of delivery tips. No design talk.',
      carousel: 'Instagram carousel. boldText = all slide texts numbered ("1: ... 2: ..."), slide 1 forces the swipe. script = design notes only. caption = the post caption.',
      static: 'Single image post. script describes ONE photographable scene. caption = 1-3 sentences in brand voice (this IS the writing).',
      bonus: 'Wildcard. Choose one production shape and obey its rules.',
    };

    const system = `You are a world-class viral content strategist and copywriter. You rewrite an existing post so the WHOLE thing is built around a specific, high-tension angle — not just the hook. You keep the post's FORMAT, the brand's product truth, and the brand voice intact, but you make it PUNCHY and gripping — never flat, never watered-down. A dry brand stays dry, but dry AND compelling.

HOOK RULES: max 8 words, fragments beat sentences, first word creates tension, must pass the thumb-stop test, never use AI-tell openers ("Did you know", "Here's the thing", etc.). Never invent product facts, prices, or ingredients. Never use the brand's avoid-words.

${writingCraft({ spoken: true, precedence: false })}`;

    const user = `ORIGINAL POST:
Title: ${idea.title || ''}
Format: ${fmt}
Hook: ${idea.hook || ''}
Body/script: ${(idea.script || '').toString().slice(0, 1500)}
Bold/preview text: ${(idea.boldText || '').toString().slice(0, 800)}
Caption: ${(idea.caption || '').toString().slice(0, 400)}

CHOSEN VIRAL ANGLE: ${angle.angle || ''} — new hook direction: "${angle.hook || ''}"

BRAND CONTEXT:
${brandInfo || '(no extra brand context — do NOT invent any product specifics; keep it general and on-voice)'}

FORMAT RULES for "${fmt}": ${formatGuide[fmt] || formatGuide.video}

TASK: Rewrite the ENTIRE post so it is built around the chosen viral angle. Keep the same format. Keep it brand-true and on-voice. The hook should be (or closely match) the chosen angle's direction. Make the body deliver on the hook's promise.

Respond with EXACTLY this JSON and nothing else (omit a field with "" if the format doesn't use it):
{
  "title": "short descriptive title",
  "hook": "the viral hook (max 8 words)",
  "script": "full script or design/delivery notes per the format rules",
  "shots": "Shot 1: ...\\nShot 2: ...",
  "boldText": "statement text or numbered carousel slides — only if format uses it, else \\"\\"",
  "caption": "post caption — only for static/carousel, else \\"\\"",
  "tags": "#BrandTag #niche1 #niche2 #broad (max 5)"
}

${rulePrecedence()}`;

    const content = await callLLM({
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      model: 'grok',
      max_tokens: 2500,
      engine: (bc.engine || 'grok'),
    });
    if (!content) return res.status(502).json({ error: 'No response from the AI — try again' });

    const _raw = extractJson(content);
    if (!_raw) return res.status(502).json({ error: 'Could not parse the rewrite — try again' });
    // v673: the model's JSON is an untrusted SHAPE. An array or object where a string
    // was asked for used to go straight to the client, and its `.trim()` inside
    // renderIdeas' .map() threw — killing the Ideas tab for the whole session with nothing on screen.
    const rewritten = coerceShape(_raw, VIRAL_REWRITE_SHAPE);

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
    return res.status(200).json({ idea: rewritten });
  } catch (err) {
    console.error('viral-rewrite error:', err);
    return res.status(500).json({ error: 'Viral rewrite failed — try again' });
  }
};
