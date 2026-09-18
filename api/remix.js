const https = require('https');
const http = require('http');
const { callLLM } = require('./_llm');
const { fullBrandBlock, writingCraft, rulePrecedence, extractJson } = require('./_brain');


module.exports = async function handler(req, res) {
  const allowed = ['https://contentshrimp.com','https://bettercontent.app','https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const _g = await require('./_usage').guard(req, 'remix', res);
  if (!_g.user) return res.status(401).json({ error: 'Please sign in again.' });
  if (_g.over) return require('./_usage').denyResponse(res, _g.gate);

  try {
    var { postUrl, postDescription, creatorName, platform, remixMode, brandContext, refImage, delivery, brandId, bcFields } = req.body || {};

    // CAP EVERY RELAYED INPUT. postDescription carries a whole transcript/article the
    // client fetched, and it was the ONE major prompt input with no length limit
    // (video-beats is capped at 3000, viral-analyze
    // at 6000). An oversized description means a very slow, very expensive reasoning
    // call that can blow the function budget.
    var MAX_DESC = 12000;
    postDescription = String(postDescription == null ? '' : postDescription);
    if (postDescription.length > MAX_DESC) postDescription = postDescription.slice(0, MAX_DESC) + '\n[...truncated]';
    creatorName = String(creatorName == null ? '' : creatorName).slice(0, 120);
    platform = String(platform == null ? '' : platform).slice(0, 60);
    postUrl = String(postUrl == null ? '' : postUrl).slice(0, 600);

    if (!postDescription && !postUrl) return res.status(400).json({ error: 'Provide a post URL or description' });

    var bc = brandContext || {};

    // ── LEAN REQUEST: hydrate the brand brain from the database ────────────────
    // A request carrying `brandId` is telling us it did NOT upload the ~13KB brand snapshot,
    // because we already hold it. No brandId (every client before this, and the shelved
    // send-daily style internal callers) => the full brandContext arrived in the body and
    // NOTHING here runs, so the old shape keeps working byte-for-byte while the service
    // worker rolls the new app.html out.
    //
    // Format is deliberately '' — remix lets the MODEL choose remixFormat, so the approved
    // winners must be the generic most-recent four, matching getBrandContext() with no
    // argument (what this client always sent). Passing a format here would silently swap the
    // exemplars for a different set.
    //
    // The client's thin brandContext is merged ON TOP: it still owns what only the device
    // knows — recentTrends, which is hand-taught 'brand_trends' merged with auto-trends minus
    // the ones the user dismissed. fullBrandBlock renders it via trendsBlock(), so losing it
    // would quietly stop every remix from riding the trends the user actually taught.
    if (brandId) {
      // humanEditedTitles is localStorage-only knowledge, so the hydration cannot derive it (same
      // reason recentTrends is sent). Without it every hydrated winner is labelled machine-written
      // and _brain's approvedWinnersBlock demotes the user's own rewrites. Form copied from generate-ideas.
      var _hyd = await require('./_brandctx').loadBrandContext(brandId, { userId: _g.user.id, humanEdited: req.body && req.body.humanEditedTitles }, '');
      // Never remix against a half-empty brain in silence. Missing row, failed read, or a row
      // holding materially less than the device says it has (a stale or failed brand save) =>
      // say so and let the client re-send what it has. A remix that LOOKS fine but was written
      // with no brand facts is the exact failure this whole change must not cause.
      var _thin = _hyd.ok && Number.isFinite(bcFields) && bcFields > 2 && _hyd.fields < Math.ceil(bcFields / 2);
      if (!_hyd.ok || _thin) {
        return res.status(424).json({
          error: 'brand_context_unavailable',
          reason: _hyd.ok ? 'stale_brand_row' : _hyd.reason,
        });
      }
      bc = Object.assign({}, _hyd.bc, bc);
    }

    // REMOVED v636 — the Master Prompt doc. This block made a LIVE Google Docs fetch on
    // every remix for a value nothing in this file ever read (it reached the model only via
    // fullBrandBlock, which no longer renders it). Feature retired.
    var brandName = bc.brandName || 'the brand';
    // Brand specifics come ONLY from this brand's own context \u2014 nothing is hardcoded,
    // so each brand gets its own facts/voice with no cross-brand contamination.
    var extraUsps = bc.usps || '';
    var customTagline = bc.tagline || '';
    var customTones = bc.tones && bc.tones.length ? bc.tones.join(', ') : '';
    var coreVoice = customTones || 'match the brand\'s established voice and tone';
    var brandAudience = bc.targetAudience || '';
    var brandBanned = bc.bannedTopics || '';

    var modeInstructions = {
      'remix': 'Keep the same FORMAT and HOOK STRUCTURE but adapt the message to ' + brandName + '. The remix should feel like "what if ' + brandName + ' made this exact type of content?"',
      'simplify': 'Strip this content down to the absolute core message. Remove all fluff, hype, and filler. Rewrite it in the ' + brandName + ' voice (' + coreVoice + '): minimal words. If the original uses 100 words, use 20.',
      'flip': 'Take the OPPOSITE angle. If they hype, we anti-hype. If they pile on benefits, we strip to the essentials. If they use urgency, we use anti-urgency. Create a contrarian ' + brandName + ' take.',
      'format-swap': 'Change the FORMAT entirely while keeping the core message. Choose the format that would perform best for the ' + brandName + ' brand voice.',
      'series': 'Turn this into a 3-5 PART SERIES. Each part standalone but connected. Different angles, formats, or community focus. Include posting schedule.',
      'roast': 'Create a ' + brandName + ' RESPONSE in its own voice (' + coreVoice + '): dry, factual commentary or fact-checking. Brand Twitter energy but smarter. NOT mean \u2014 just honest.'
    };
    var modeTask = modeInstructions[remixMode] || modeInstructions['remix'];

    // Face-on vs faceless steering. Only meaningful when the remix lands on a filmable format
    // (video/micro/qna/statement); for carousel/image it is naturally ignored.
    var deliveryNote = '';
    if (delivery === 'faceless') {
      deliveryNote = '\n\nDELIVERY STYLE — FACELESS: if the remix format is a filmable one (video, micro-lecture, Q&A or statement), the creator is NOT on camera. Write remixScript as a VOICEOVER read over footage (it may be AI-voiced), and make every shot b-roll, stock clips, screen recordings, product or close-up shots, or text-on-screen cards — never "talk to camera" or "look into the lens". For carousel/image, ignore this.';
    } else if (delivery === 'faceon') {
      deliveryNote = '\n\nDELIVERY STYLE — FACE-ON: if the remix format is a filmable one, write it to be performed on camera by the creator, with the shot list assuming they are on screen.';
    }

    var jsonFormat;
    if (remixMode === 'series') {
      jsonFormat = '{"originalSummary":"1-2 sentences","seriesParts":[{"partNumber":1,"remixTitle":"Title","remixHook":"Hook","remixScript":"Full script","remixFormat":"video|carousel|statement|micro","suggestedDay":"Monday"}],"remixCaption":"Caption","remixHashtags":"5 hashtags","whyItWorks":"1 sentence"}';
    } else {
      jsonFormat = '{"originalSummary":"1-2 sentences","remixTitle":"Title","remixHook":"Hook (first 3s)","remixScript":"Full script","remixFormat":"video|carousel|statement|micro","remixCaption":"Caption with CTA","remixHashtags":"5 hashtags","whyItWorks":"1 sentence"}';
    }

    var brandSection = fullBrandBlock(bc);
    if (!brandSection || !brandSection.trim()) brandSection = '(No brand profile provided — do NOT invent specifics, prices, ingredients, or claims. Keep it general and on-voice.)';

    // The em-dash / AI-tell-word / rule-of-three list that used to sit here is ALREADY in
    // writingCraft() below \u2014 it was appearing twice in every remix prompt. Only the hashtag rule
    // (which writingCraft does not cover) is kept.
    var humanRules = 'HASHTAG RULES: hashtags obey the same rules as the copy \u2014 never use the brand avoid-words, and never use hype tags (#viral, #gamechanger, #musthave, #fyp-bait). Plain, specific, on-topic tags only.\n';

    // v655 — THE BRAND BLOCK MOVED TO THE END, the same re-order v640 applied to generate-ideas.
    // It sat at 0.3% of the prompt: the brand's own approved winners landed at 32%, and then 9,771
    // characters of writing rules, source content and task sat between them and the output
    // instruction. Worse in production — `postDescription` carries up to 12,000 characters of
    // transcript in exactly that gap, so the thing being remixed drowned the brand doing the
    // remixing. Measured against generate-ideas (winners at 88.8%, 2,932 chars from the output)
    // and against meme / viral-rewrite / viral-twist / sharpen, which ALREADY land their winners
    // at 78-82% because fullBrandBlock renders the winners last inside the block — those four were
    // measured and deliberately left alone. Now: opener -> craft rules -> SOURCE + task -> BRAND.
    // A pure re-order of existing text, plus ONE new framing line: the brand's own best posts now
    // sit directly above the output instruction, so the model must be told they are proof of how
    // the brand sounds and not the thing to remix.
    var promptBody = 'You are a content strategist for ' + brandName + '.\n\n' + humanRules + '\n' + writingCraft({ spoken: true, precedence: false })
      + '\n\nORIGINAL CONTENT TO REMIX:\nCreator: @' + (creatorName || 'unknown') + ' on ' + (platform || 'social media') + '\n' + (postUrl ? 'Post URL: ' + postUrl + '\n' : '') + (postDescription ? 'Description/concept: ' + postDescription + '\n' : '') + '\nREMIX MODE: ' + (remixMode || 'remix').toUpperCase() + '\nTASK: ' + modeTask + deliveryNote
      + '\n\nSELF-CHECK before finalizing (silently; output only the final JSON): make sure the remix is unmistakably in THIS brand voice, uses the brand real facts and vocabulary (never invented facts), and would make this brand audience stop. Rewrite anything generic or off-voice.'
      + '\n\n' + brandSection
      + '\n\nEVERYTHING ABOVE THIS LINE IS THE BRAND — its voice, its real facts, and its own approved posts. It is the last thing you read before the task because it is what matters most: the general writing rules exist to remove generic slop, not to overwrite a voice this brand has earned. Where they conflict, the brand wins. Those approved posts show how this brand SOUNDS — never remix them. The thing being remixed is the ORIGINAL CONTENT above.'
      + '\n\nRespond in this exact JSON format:\n' + jsonFormat;

    // Optional reference screenshot dropped in by the user — Grok can see it.
    var refImages = [];
    if (refImage) {
      try {
        if (typeof refImage === 'string' && refImage.indexOf('data:') === 0) {
          var mm = refImage.match(/^data:([^;]+);base64,(.+)$/);
          if (mm && mm[2].length < 8000000) refImages.push({ mime: mm[1], data: mm[2] });
        } else if (refImage.data && String(refImage.data).length < 8000000) {
          refImages.push({ mime: refImage.mime || 'image/jpeg', data: String(refImage.data) });
        }
      } catch (e) {}
    }
    var imgNote = refImages.length
      ? '\n\nA REFERENCE SCREENSHOT is attached to this message — the original content or something that inspired it. Study it and use what is relevant (the hook, structure, subject, visual idea) when remixing it into ' + brandName + "'s voice. Never just describe the image; never invent brand facts from it."
      : '';

    // Generate + parse with one retry. Grok occasionally emits malformed JSON (more so under the
    // Try-All 6-parallel burst); if the first parse fails we ask once more for strictly clean JSON.
    var content = '', remix = null;
    for (var _try = 0; _try < 2 && !remix; _try++) {
      content = await callLLM({
        // rulePrecedence() says "read this last", so it is appended HERE, at call time, after
        // imgNote and the retry note. Appending it to the prompt body instead left it buried
        // whenever a reference screenshot was attached or a retry fired — the two paths the old
        // fixture never exercised, so the gate asserting "precedence is genuinely LAST" passed
        // while production sent it mid-prompt.
        messages: [{ role: 'user', content: promptBody + imgNote + (_try ? '\n\nIMPORTANT: reply with ONLY the JSON object described above. No prose, no markdown code fences.' : '') + '\n\n' + rulePrecedence() }],
        model: 'grok',
        max_tokens: 4000,
        engine: (bc.engine || 'grok'),
        images: refImages.length ? refImages : undefined
      });
      if (content) remix = extractJson(content);
    }

    if (!content) return res.status(500).json({ error: 'No content in response' });
    if (!remix) return res.status(500).json({ error: 'Failed to parse remix \u2014 try again', raw: content });

    // v666 — RETURN STRINGS, NOTHING ELSE.
    // `extractJson` only proves the reply PARSED; every field was then passed through raw. The
    // client saves this object to localStorage AND Supabase and then renders it, so one reply with
    // `"remixScript": 12345` or `"remixTitle": {...}` threw inside renderRemixResults BEFORE
    // el.innerHTML was assigned — and because the bad row is persisted and re-read, the Create
    // tab's results list stayed blank through every reload. Measured on the real client functions:
    // 5 of 6 malformed shapes threw, each leaving the list untouched.
    // app.html now coerces as well (escapeHtml / remixHasContent), which repairs rows already
    // saved. This is the root: an endpoint should not hand its own client a shape it cannot render.
    // Arrays are joined rather than dropped — a model that answers a script as a list of lines has
    // still written the script, and losing it would be a worse bug than the crash.
    remix = (function normalize(o, depth) {
      const str = v => {
        if (v == null) return '';
        if (typeof v === 'string') return v;
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        if (Array.isArray(v)) return v.map(x => str(x)).filter(Boolean).join('\n');
        try { return Object.values(v).map(x => str(x)).filter(Boolean).join(' '); } catch (e) { return ''; }
      };
      const out = {};
      for (const k of Object.keys(o || {})) {
        const v = o[k];
        if (k === 'seriesParts' && depth === 0) {
          out[k] = Array.isArray(v) ? v.map(p => normalize(p && typeof p === 'object' ? p : { remixScript: p }, 1)) : [];
        } else if (k === 'partNumber') {
          out[k] = Number(v) || 0;                      // the one field the client renders as a number
        } else {
          out[k] = str(v);
        }
      }
      return out;
    })(remix, 0);
    // `brandContext.brandId` was never a key getBrandContext() produced, so this row was
    // always attributed to a null brand. A lean request finally names the brand — use it.
    // Only attribute the usage row to a brand the caller actually owns — this id comes from the
    // client and went into usage_events unverified. Same pattern as pull-trends.js /
    // creator-posts.js: a check that cannot run leaves the row unattributed, never unlogged.
    let logBrandId = null;
    const _bid = brandId || (brandContext && (brandContext.brandId || brandContext.brand_id)) || null;
    if (_bid) {
      try {
        const store = require('./_publish/store');
        if (await store.userCanAccessBrand(_g.user.id, _bid)) logBrandId = _bid;
      } catch (e) {}
    }
    await require('./_usage').logUsage({ userId: _g.billingUserId || _g.user.id, brandId: logBrandId, action: 'remix', model: bc.engine || 'grok' });
    return res.status(200).json({ remix });

  } catch (err) {
    console.error('Remix error:', err);
    // The raw message used to go to the browser — which on a body-less POST meant the client
    // was shown our own TypeError. Siblings (viral-*, sharpen) all return a written sentence.
    return res.status(500).json({ error: 'Remix failed — try again' });
  }
};
