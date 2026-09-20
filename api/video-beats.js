// Video beats — turn a talking-head script into a GRAPHICS TRACK for the split-screen renderer.
// The user films the top half; these beats drive the animated bottom half. Output is a small,
// strictly-typed JSON timeline so the same data can feed BOTH the in-app live preview (HTML/CSS)
// and the HyperFrames MP4 render later — one source of truth, no second design.
const { callLLM } = require('./_llm');
const { fullBrandBlock, extractJson } = require('./_brain');

// Kinds the renderer knows how to draw. Anything else is coerced to 'statement'.
const KINDS = ['statement', 'number', 'chips', 'contrast'];

function clean(beats) {
  if (!Array.isArray(beats)) return [];
  return beats.slice(0, 6).map(b => {
    const kind = KINDS.includes(b && b.kind) ? b.kind : 'statement';
    const out = {
      kind,
      eyebrow: String((b && b.eyebrow) || '').slice(0, 28).toUpperCase(),
      headline: String((b && b.headline) || '').slice(0, 90),
      sub: String((b && b.sub) || '').slice(0, 110),
      // highlight = the words the renderer paints lavender inside the headline
      highlight: String((b && b.highlight) || '').slice(0, 40),
      // cue = the exact words in the SCRIPT where this beat should appear. The app
      // matches it against what the speaker actually said, so the graphic lands on
      // the sentence it belongs to instead of on an evenly-divided guess.
      cue: String((b && b.cue) || '').slice(0, 80),
      // imageQuery = a LITERAL 2-4 word stock-photo search for this beat ('' = none)
      imageQuery: String((b && b.imageQuery) || '').slice(0, 40)
    };
    if (kind === 'number') out.value = String((b && b.value) || '').slice(0, 12);
    if (kind === 'chips') {
      out.chips = (Array.isArray(b && b.chips) ? b.chips : []).slice(0, 4)
        .map(c => String(c || '').slice(0, 18)).filter(Boolean);
      if (!out.chips.length) out.kind = 'statement';
    }
    // a highlight that isn't actually in the headline would never render — drop it
    if (out.highlight && !out.headline.toLowerCase().includes(out.highlight.toLowerCase())) out.highlight = '';
    return out;
  }).filter(b => b.headline || b.value || (b.chips && b.chips.length));
}

module.exports = async function handler(req, res) {
  const allowed = ['https://contentshrimp.com','https://bettercontent.app','https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const _g = await require('./_usage').guard(req, 'beats', res);
  if (!_g.user) return res.status(401).json({ error: 'Please sign in again.' });
  if (_g.over) return require('./_usage').denyResponse(res, _g.gate);

  try {
    const { script, hook, title, brandContext, brandId, bcFields } = req.body || {};
    const body = String(script || '').trim();
    if (!body && !hook) return res.status(400).json({ error: 'No script provided' });

    let bc = brandContext || {};

    // ── LEAN REQUEST: hydrate the brand brain from the database ────────────────
    // Both callers (the B-roll preview and the split-screen render) used to upload the whole
    // ~17KB brand snapshot on every tap, to an endpoint that already holds it. A request carrying
    // `brandId` is saying it did NOT upload it. No brandId => the full brandContext arrived in the
    // body and NOTHING here runs, so a device still on the cached app.html keeps working.
    //
    // NOTE `brandId` was ALREADY destructured above, for usage attribution only — but no caller
    // ever sent it, so gating hydration on it cannot change any existing request. Confirmed by
    // reading both call sites, not assumed.
    //
    // Refuse rather than render a brand-less graphics track: fullBrandBlock is what keeps the
    // on-screen text in the brand's voice and off its avoid-words, and a beat track written
    // without it looks completely fine — which is exactly why it has to be a hard 424.
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

    const sys = `You turn a spoken video script into an on-screen GRAPHICS TRACK — the text and visuals that appear beside the speaker in a split-screen video.

${fullBrandBlock(bc)}

RULES — this is on-screen text, not narration:
- 4 beats. Each covers one moment of the script IN ORDER. Never more than 6.
- On-screen text is SHORT. A headline is read in under 2 seconds — aim 3-9 words. Never a full sentence from the script.
- Use the script's OWN specifics: real numbers, real product facts, the actual claim. Never invent a statistic.
- The beats must make sense muted, on their own, as a silent summary of the video.
- No hype words, no emoji, no hashtags. Match the brand voice above.

BEAT KINDS — pick the one that fits what's being said:
- "number": a single hard figure is the star (value = "34g", "1,000mg", "3x"). headline stays empty or very short; sub explains it.
- "chips": 2-4 short parallel items (audiences, ingredients, mistakes).
- "contrast": a before/after or them-vs-us flip. Put the flip in headline using a line break.
- "statement": the default — a short punchy line.

"cue" = the FIRST 4-8 words of the sentence in the script where this beat should
appear on screen. Copy them VERBATIM from the script, exactly as written — the app
matches them against what the speaker actually says so the graphic lands on the
right sentence. Beats must be in script order and their cues must not overlap.

"imageQuery" = a stock-photo search of 2-4 CONCRETE, LITERAL words for what this
beat should show behind the text — real things a camera can photograph ("factory
floor workers", "signing contract", "container ship port"). Never abstract words
("success", "trust", "quality"), and turn a JUDGMENT adjective into the SCENE it
looks like: "unvetted suppliers" -> "factory floor", "premium packaging" ->
"product box closeup". Lead with a photographable NOUN, ALWAYS a 2-3 word PHRASE (never one generic word), and make it depict the SPECIFIC subject of THIS beat's headline — the exact concrete thing that sentence is about, grounded in this brand's real product/industry, not a generic stand-in. MOST beats should carry one — aim for all but
one, and the FIRST beat especially: it is on screen the longest and an empty
first panel reads as broken. A number beat can carry one too (the photo sits
under the figure). Leave "" only when nothing concrete fits.

Return ONLY this JSON:
{"beats":[{"kind":"statement","eyebrow":"THE HOOK","headline":"Short punchy line","highlight":"two words","sub":"","value":"","chips":[],"cue":"first words of that sentence","imageQuery":"factory floor workers"}]}

"eyebrow" = 1-3 word label above the beat (THE HOOK / WHAT'S IN IT / WHO THIS BREAKS / THE FIX).
"highlight" = the 1-3 words inside headline to emphasise — MUST appear verbatim in headline, or leave empty.`;

    const usr = `TITLE: ${title || ''}
HOOK: ${hook || ''}

SCRIPT:
${body.slice(0, 3000)}`;

    // NOTE: callLLM has NO `system` option — the system prompt MUST be the first
    // message, exactly like every other endpoint here. (Passing {system} silently
    // dropped it and Grok returned unusable output.)
    const raw = await callLLM({
      messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
      temperature: 0.5,
      max_tokens: 3000,  // v549: reasoning + full JSON headroom so the graphics track never truncates (only actual tokens are billed)
      timeoutMs: 240000,
    // v689 — 285000 was "nearly the whole 300s budget", but the retry loop could start another
    // attempt at 149,999ms and run the full timeout on top: measured worst case 338s-436s against
    // a 300s budget, so the platform killed it and the app printed Vercel's 504 page as a JSON
    // parse error. deadlineMs bounds the WHOLE call, retries included, and the numbers now leave
    // room for guard() (3 sequential Supabase reads at 8s each) plus loadBrandContext.
    deadlineMs: 250000
    });
    if (!raw) return res.status(502).json({ error: 'No response from the AI — try again' });

    const parsed = extractJson(raw);
    const beats = clean(parsed && (parsed.beats || parsed));
    if (!beats.length) {
      console.error('video-beats: no usable beats from model. raw head:', String(raw).slice(0, 400));
      return res.status(502).json({ error: 'Could not build the graphics track — try again.' });
    }

    // METERING: guard() above only CHECKS the limit — it never writes a usage row. Without
    // this logUsage the 'beats' action (1 credit, and the most expensive call in the app)
    // was never recorded, so it was effectively unlimited on every plan. Logged only after
    // a usable graphics track was actually produced. Same pattern as pull-trends.js: attribute
    // the row to a brand only when the caller demonstrably owns it, and never let a metering
    // failure break the response.
    try {
      let logBrandId = null;
      const _bid = brandId || (brandContext && brandContext.brandId) || null;
      if (_bid) {
        const store = require('./_publish/store');
        if (await store.userCanAccessBrand(_g.user.id, _bid)) logBrandId = _bid;
      }
      await require('./_usage').logUsage({ userId: _g.billingUserId || _g.user.id, brandId: logBrandId, action: 'beats', model: 'grok' });
    } catch (e) { console.log('video-beats: usage log failed — ' + (e && e.message)); }

    // 3.25s per beat matches the prototype pacing; the renderer can override.
    return res.status(200).json({ beats, secondsPerBeat: 3.25, duration: +(beats.length * 3.25).toFixed(2) });
  } catch (e) {
    console.error('video-beats error:', e && e.message);
    return res.status(500).json({ error: 'The AI is having a moment. Try again in a few seconds.' });
  }
};
