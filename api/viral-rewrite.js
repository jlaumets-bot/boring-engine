// Viral Rewrite — regenerate a FULL post around a chosen viral angle.
// Keeps the same format + brand truth/voice; rewrites hook + body + caption + shots + tags.
const { aiUnavailable } = require('./_llm');
const { writerCallResilient, writerProvider, writerEffort, startBrandAttribution } = require('./_write');   // v693 r3 — provider switch + thinking depth with headroom (see api/_write.js)
const { fullBrandBlock, rulePrecedence, extractJson, coerceShape, VIRAL_REWRITE_SHAPE, spokenV2, storiesBlock } = require('./_brain');
// v693 — content-v2 writing rules (.unlazy/content-v2/PLAN.md change 3): the short style guide
// (whose one hard rule is NO_INVENTION_RULE) replaces writingCraft's rulebook and the "max 8 words,
// fragments beat sentences" hook rule; the brand renders through fullBrandBlock(bc,{v2:true}).
const { styleGuide } = require('./_write');
// Formats whose script is said out loud to camera (same set as sharpen.js / _brain SPOKEN_EX_FORMATS).
const SPOKEN_FORMATS = ['video', 'micro', 'qna'];

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

    // v693 — v2: tones <= 3 (else none), USPs / product / proof as background facts, held beliefs;
    // the story bank follows it so a real story can fill a proof slot.
    const brandInfo = fullBrandBlock(bc, { v2: true });
    const stories = storiesBlock(bc, 2000);

    // NOTE — "screen" (on-screen text) is deliberately absent from every line below and from the
    // JSON schema. generate-ideas dropped it in v609 after checking every use: the split-screen
    // renderer ignores it (video-beats generates its own overlays) and app.html has no display
    // site left for it — only a normaliser and a DB row map. This file kept asking for it, so the
    // model was writing 3-6 overlays per rewrite that nothing could ever show. Do not re-add it
    // without a render site.
    const formatGuide = {
      video: 'Vertical Reel/TikTok, 30-60s. script = spoken words (usually 90-180 words, full sentences of varied length). shots = 4-8 concrete phone shots.',
      micro: '10-15s single-fact video. script = usually 30-70 spoken words, one surprising fact + why it matters. shots = 1-3.',
      qna: 'A real audience question + filmed answer under 30s. title = the raw question. script = the answer (first sentence answers directly, usually 40-80 words). shots = 1-3.',
      statement: 'Bold text-graphic statement. boldText = the full statement (2-5 short sentences, setup + payoff, stands alone). script = 2-3 lines of delivery tips. No design talk.',
      carousel: 'Instagram carousel. boldText = all slide texts numbered ("1: ... 2: ..."), slide 1 forces the swipe. script = design notes only. caption = the post caption.',
      static: 'Single image post. script describes ONE photographable scene. caption = 1-3 sentences in brand voice (this IS the writing).',
      bonus: 'Wildcard. Choose one production shape and obey its rules.',
    };

    const system = `You are a world-class viral content strategist and copywriter. You rewrite an existing post so the WHOLE thing is built around a specific, high-tension angle — not just the hook. You keep the post's FORMAT, the brand's product truth, and the brand voice intact, but you make it PUNCHY and gripping — never flat, never watered-down. A dry brand stays dry, but dry AND compelling.

HOOK: the first line a person would actually say, plain and specific, and it opens the angle. It must pass the thumb-stop test. Never use the brand's avoid-words.

SLOTS: keep every [your story: ...] slot the original has, exactly as written. Where the new angle needs proof you do not have (a number, a customer, a result), write a new [your story: <what to tell>] slot instead of making it up.

${styleGuide()}${SPOKEN_FORMATS.indexOf(fmt) >= 0 ? '\n\n' + spokenV2() : ''}`;

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
${stories ? stories + '\n' : ''}
FORMAT RULES for "${fmt}": ${formatGuide[fmt] || formatGuide.video}

TASK: Rewrite the ENTIRE post so it is built around the chosen viral angle. Keep the same format. Keep it brand-true and on-voice. The hook should be (or closely match) the chosen angle's direction. Make the body deliver on the hook's promise.

Respond with EXACTLY this JSON and nothing else (omit a field with "" if the format doesn't use it):
{
  "title": "short descriptive title",
  "hook": "the new hook: the first line, as a person would say it",
  "script": "full script or design/delivery notes per the format rules",
  "shots": "Shot 1: ...\\nShot 2: ...",
  "boldText": "statement text or numbered carousel slides — only if format uses it, else \\"\\"",
  "caption": "post caption — only for static/carousel, else \\"\\"",
  "tags": "#BrandTag #niche1 #niche2 #broad (max 5)"
}

${rulePrecedence()}`;

    // v693 r3 — START the brand-attribution check now and await it after the AI work, so it never
    // adds Supabase time after the model answers (a killed function delivers nothing).
    const _brandAttr = startBrandAttribution(_g.user.id, bc.brandId || bc.brand_id || null);
    const content = await writerCallResilient({ deadlineMs: 280000, provider: writerProvider(), effort: writerEffort('edit'),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      model: 'grok',
      max_tokens: 4000,
      engine: (bc.engine || 'grok'),
    }, { providerFromEnv: true, label: 'viral-rewrite' });
    if (!content) return res.status(502).json({ error: 'No response from the AI — try again' });

    const _raw = extractJson(content);
    if (!_raw) return res.status(502).json({ error: 'Could not parse the rewrite — try again' });
    // v673: the model's JSON is an untrusted SHAPE. An array or object where a string
    // was asked for used to go straight to the client, and its `.trim()` inside
    // renderIdeas' .map() threw — killing the Ideas tab for the whole session with nothing on screen.
    const rewritten = coerceShape(_raw, VIRAL_REWRITE_SHAPE);

    // Only attribute the usage row to a brand the caller actually owns — this id comes from the
    // client and went into usage_events unverified. Same pattern as pull-trends.js:
    // a check that cannot run leaves the row unattributed, never unlogged.
    const logBrandId = await _brandAttr;   // v693 r3 — the access check was started before the AI work
    await require('./_usage').logUsage({ userId: _g.billingUserId || _g.user.id, brandId: logBrandId, action: 'viral', model: require('./_write').usageModel(bc) });
    return res.status(200).json({ idea: rewritten });
  } catch (err) {
    const ai = aiUnavailable(err); if (ai) return res.status(ai.status).json(ai.body);   // v690 — a refused AI account (no credits / spending limit) is a 503 with the honest message, not "try again"
    console.error('viral-rewrite error:', err);
    return res.status(500).json({ error: 'Viral rewrite failed — try again' });
  }
};
