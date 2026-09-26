const https = require('https');
const { callLLM, aiUnavailable } = require('./_llm');
const { fullBrandBlock, approvedWinnersBlock, extractJson, outputViolations, clarityFlow, spokenShape, spokenExample, antiSlopRhythm, rulePrecedence } = require('./_brain');

// Quick Post's anti-repetition avoid-list used to be ~50 idea titles (~1.6KB) rendered into
// learningContext on the CLIENT and re-uploaded on every generate — even though ~40 of them
// are `ideas.title` rows we already hold. A lean client now emits this marker at the exact
// position the block belongs (before the "they just rejected this post" block, which must
// stay last and prominent) and sends only its localStorage-only `tv_recent` titles.
const AVOID_MARK = '<<CS_AVOID_LIST>>';

// ── TIME BUDGET ──────────────────────────────────────────────────────────────
// `_llm.httpsPost` defaults to 240000ms when no `timeoutMs` is passed. The ideas lane makes TWO
// SEQUENTIAL calls — the main generation, then the output-guardrail REGENERATION (which fires
// whenever a brand has avoid-words or banned-topics). Unbounded that was 240s + 240s = 480s
// against a 300s maxDuration (vercel.json), so the platform killed the function mid-regeneration
// and the user got a bare 504: no app-level error, no log line, nothing to diagnose. This is the
// busiest path in the app (Quick Post, Ideas, Idea Catcher, Notebook-develop, PAA, auto-refill).
//
//   main generation (max_tokens 16000)   90s
//   guardrail regeneration (same size)   90s
//   ──────────────────────────────────────────
//   worst case                          180s  <  300s maxDuration (120s margin)
//
// Margin covers brand hydration (_brandctx: 5 parallel queries), JSON parsing and usage logging.
// WHY 90s AND NOT MORE: scripts/verify/timeout-budgets.mjs models a file's worst case as
// max(timeoutMs) × (number of callLLM call sites). This file has THREE call sites — the two
// above plus handleScenes, which is a mutually exclusive early-return path and can never run
// alongside them — so the verifier's ceiling is 300/3 = 100s. 90s keeps 30s of margin there and
// 120s of real margin under maxDuration. handleScenes is deliberately left on the 240s default:
// as a single call it already fits its 300s budget, so it is not part of this bug.
// If XAI_REASONING_EFFORT is ever raised from its "low" default, re-check these numbers.
//
// Both values are written as NUMERIC LITERALS (`timeoutMs: 90000`) at the call sites on purpose:
// the verifier reads them with /timeoutMs\s*:\s*(\d+)/, so a named constant would be invisible to
// it and it would silently fall back to assuming the 240s default — passing this file for the
// wrong reason, and staying green through a future regression. Keep them inline.

// ── INPUT CAPS ───────────────────────────────────────────────────────────────
// Client-supplied free text that lands in the prompt must be BOUNDED — every other such string
// in this codebase is (_brain.js FIELD_CAP 4000 / TOTAL_CAP 30000, remix.js MAX_DESC 12000,
// viral-analyze.js slice(0,6000)). These were not. And because this action is billed at a FLAT
// per-action cost, the €25 cost fuse computes the same tiny number no matter how large the
// prompt actually was — it can never see an oversized payload.
//
// Sizing, measured against what app.html's buildLearningContext() actually emits:
//   last 10 approved titles   ~200 chars each                        = 2,000
//   last 10 dismissed titles  ~200 chars each                        = 2,000
//   last 8 edit signals (before/after already client-capped at 120)  = 2,320
//   caller-appended blocks (PAA seed question, "they just rejected this") ≈ 1,000
//   ────────────────────────────────────────────────────────────────────────────
//   realistic worst case                                             ≈ 7,300 chars
// 20,000 is ~2.7x that, so it cannot truncate a legitimate user — it only bounds abuse.
// This must stay far above the real ceiling rather than become a routine trimmer: callers APPEND
// instructions AFTER buildLearningContext() (the PAA lane appends its seed question), so the tail
// of this string carries meaning.
const LEARNING_CTX_CAP = 20000;
// One avoid-list entry. The final list is already count-capped (slice(-50) below); this bounds
// each ENTRY's length, and AVOID_INPUT_CAP bounds how many we walk while deduping. The client
// sends ~12 `tv_recent` titles, and titles are a "Short descriptive title" per our own schema.
const AVOID_TITLE_CAP = 200;
const AVOID_INPUT_CAP = 200;
// Idea Catcher free text. seedTranscript is already capped at 4000 further down; match it —
// 4,000 chars is ~800 words for one "raw, half-baked idea", so no real user hits it.
const SEED_TEXT_CAP = 4000;

// Rebuild the block at the marker: device-only recent Quick Posts first, then the library
// titles from the database, deduped, tail-capped at 50 — the same order and cap the client
// used when it composed the whole thing itself.
function _composeAvoidList(lc, avoidExtra, dbTitles) {
  const s = typeof lc === 'string' ? lc : '';
  if (s.indexOf(AVOID_MARK) === -1) return s;
  const seen = new Set();
  const list = [];
  // .slice(-AVOID_INPUT_CAP) bounds the walk without changing behaviour for any real payload
  // (client ~12 + database ~40 = ~52 entries); the tail-priority order is preserved either way.
  for (const t of [].concat(avoidExtra || [], dbTitles || []).slice(-AVOID_INPUT_CAP)) {
    const v = String(t == null ? '' : t).trim().slice(0, AVOID_TITLE_CAP);
    if (!v || seen.has(v)) continue;
    seen.add(v); list.push(v);
  }
  const tail = list.slice(-50);
  const block = tail.length
    ? "TOPICS & ANGLES ALREADY USED — do NOT repeat any of these. Pick a clearly DIFFERENT sub-topic or angle within today's theme; rotate through the brand's OTHER facts, pain points and use-cases, never just the single most obvious feature:\n"
      + tail.map(t => '• ' + t).join('\n')
    : '';
  return s.split(AVOID_MARK).join(block);
}

module.exports = async function handler(req, res) {
  const allowed = ['https://contentshrimp.com','https://bettercontent.app','https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Allow the internal daily-push cron (send-daily) to call this with the shared
  // CRON_SECRET; otherwise require a signed-in user.
  const _authz = req.headers.authorization || '';
  const _isInternal = !!process.env.CRON_SECRET && _authz === `Bearer ${process.env.CRON_SECRET}`;
  const _user = _isInternal ? null : await require('./_requireUser')(req);
  if (!_isInternal && !_user) return res.status(401).json({ error: 'Please sign in again.' });
  const _usage = require('./_usage');

  // WHO IS THIS GENERATION FOR? The internal caller is a cron, not a person, so there is no
  // session to read the account off — it names the account explicitly with `forUserId` (and the
  // brand it already verified as `forBrandId`). Only a holder of CRON_SECRET can set these, so
  // they are as trusted as the secret itself; a normal request cannot reach this branch at all
  // and its `forUserId` is ignored. The CRON_SECRET path therefore stays distinct — it skips
  // the session, not the meter.
  //
  // It used to skip the meter too, and that was the hole: send-daily generates one brief per
  // subscriber per day, ~30 a month, for accounts that may be free, expired or cancelled —
  // unseen by the limit, the cost fuse and the rate limiter alike.
  const _forUserId = _isInternal && req.body && typeof req.body.forUserId === 'string' ? req.body.forUserId : null;
  const _forBrandId = _isInternal && req.body && typeof req.body.forBrandId === 'string' ? req.body.forBrandId : null;
  if (_isInternal && !_forUserId) {
    // Fail OPEN but LOUD, deliberately: an internal caller that has not been taught to name its
    // account (an older send-daily during a rolling deploy) must not stop every daily push, but
    // its generations are unmetered and that has to be findable.
    console.error('generate-ideas: internal CRON_SECRET call arrived with no forUserId — this ' +
      'generation is NOT metered against any account. Update the caller to send forUserId.');
  }

  try {
    const { brandContext, gaps, count: _rawCount = 5, mode, seedIdea, seedNotes, seedTranscript, forceFormat, refImage, delivery, brandId, bcFields, avoidExtra, exFormat } = req.body || {};
    // v657 — CLAMP `count` AT THE SOURCE. It came straight from the body and was
    // interpolated into the prompt ("a JSON array of exactly ${count} ideas"), while metering
    // charges ONE credit per CALL. The UI offers 10 and a direct POST could ask for 50, so a
    // free user on "10" got 400 briefs a month against a 40-credit plan that _usage.js sizes
    // as "credits ≈ posts" — and the cost fuse under-counted by the same factor.
    // Clamped here, where it is destructured, so all five downstream uses (the Q&A gap maths,
    // the two prompt strings and the schema line) get the bounded number automatically —
    // a separate clamped variable would have left the raw one in the prompt.
    const MAX_IDEAS = 10;
    const count = Math.max(1, Math.min(MAX_IDEAS, Math.floor(Number(_rawCount) || 5)));
    if (Number(_rawCount) > MAX_IDEAS) {
      console.warn('generate-ideas: count %s clamped to %s', _rawCount, MAX_IDEAS);
    }
    let bc = brandContext || {};
    let learningContext = req.body && req.body.learningContext;
    // Bound the one client string that reached the prompt unchecked. Logged so an oversized
    // payload names itself instead of silently inflating every generation (see LEARNING_CTX_CAP).
    if (typeof learningContext === 'string' && learningContext.length > LEARNING_CTX_CAP) {
      console.log('generate-ideas: learningContext was ' + learningContext.length + ' chars — capped to ' + LEARNING_CTX_CAP);
      learningContext = learningContext.slice(0, LEARNING_CTX_CAP);
    }

    // WHOSE PLAN PAYS. Not "the caller's" any more:
    //   * a signed-in user working inside a brand somebody else owns (an Agency seat) is
    //     metered against the OWNER's plan — see _usage.billingUserFor, which only moves the
    //     meter when store.userCanAccessBrand confirms real membership;
    //   * the internal cron is metered against the account it is generating FOR.
    // `brandId` is the client's claim; billingUserFor verifies it and falls back to the caller
    // on anything it cannot confirm. Resolved ONCE here so the gate below and the usage row at
    // the end of the handler can never disagree about who is being charged.
    const _meterUser = _isInternal ? _forUserId : (_user && _user.id);
    const _meterBrand = _isInternal ? _forBrandId : (brandId || (bc && (bc.brandId || bc.brand_id)) || null);
    // Resolved through the helper when it is there, and falling back to the caller when it is
    // not. That fallback is not defensive noise: this file's metering rule is "billing must never
    // be the reason a generation fails" (see the header of _usage.js), and this is the one
    // metering call that sits directly in the generation path.
    let _billingUser = _meterUser || null;
    if (_meterUser && typeof _usage.billingUserFor === 'function') {
      _billingUser = await _usage.billingUserFor(_meterUser, _meterBrand);
    }

    // Usage gate — fail-open. It now covers the internal cron too, so an over-limit account
    // does not receive generated content: send-daily reads the 402 as "no idea" and falls back
    // to its generic push, which carries nothing we had to generate.
    if (_billingUser) {
      const _gate = await _usage.checkLimit(_billingUser, _usage.creditsFor('ideas'), 'ideas');
      // v678: this path calls checkLimit directly, so guard() cannot attach the release — do it
      // here, or a failed generation keeps the credit for the full hold TTL. See _usage.js.
      if (_gate && _gate.ok && _gate.hold) _usage.attachHoldRelease(res, _gate.hold);
      if (!_gate.ok) return _usage.denyResponse(res, _gate);
    }

    // ── LEAN REQUEST: hydrate the brand brain from the database ────────────────
    // A request that carries `brandId` is telling us it did NOT upload the ~13KB brand
    // snapshot, because the snapshot is already ours. No brandId (every client before this,
    // and the internal send-daily cron) => the full brandContext arrived in the body and
    // NOTHING below runs, so the old shape keeps working byte-for-byte during the service
    // worker's update window.
    //
    // The client's partial brandContext is merged ON TOP: it still owns the values only the
    // device knows (hand-taught trends, dismissed auto-trends, the day-theme strings).
    //
    // WHICH FORMAT THE APPROVED WINNERS ARE MATCHED AGAINST — and why it is NOT `forceFormat`.
    // getBrandContext(fmt) on the client leads with same-format winners; to stay byte-identical the
    // server must be told the same fmt. `forceFormat` cannot carry it: it ALSO injects a "FORMAT
    // REQUIREMENT: every idea MUST use ..." line into the prompt below, so reusing it for the
    // several lean callers that merely know their target format (auto-refill, PAA-to-post, idea
    // redo) would change what reaches the model — the one thing this whole change must not do.
    // `exFormat` is exemplar-selection ONLY and never reaches the prompt. forceFormat still wins
    // where it is set (Quick Post), so that caller is untouched.
    if (brandId) {
      const _hyd = await require('./_brandctx').loadBrandContext(
        brandId,
        // humanEditedTitles is localStorage-only knowledge, so the hydration cannot derive it —
        // it is sent for the same reason recentTrends is (see leanBrandFetch).
        { userId: _user ? _user.id : null, humanEdited: req.body && req.body.humanEditedTitles },
        forceFormat || exFormat || ''
      );
      // Never write against a half-empty brain in silence. If the row is missing, the read
      // failed, or the database holds materially less than the device says it has (a stale
      // or failed brand save), say so and let the client re-send what it has. A generic,
      // brand-less post that LOOKS fine is the failure mode this whole change must avoid.
      const _thin = _hyd.ok && Number.isFinite(bcFields) && bcFields > 2 && _hyd.fields < Math.ceil(bcFields / 2);
      if (!_hyd.ok || _thin) {
        return res.status(424).json({
          error: 'brand_context_unavailable',
          reason: _hyd.ok ? 'stale_brand_row' : _hyd.reason,
        });
      }
      bc = Object.assign({}, _hyd.bc, bc);
      learningContext = _composeAvoidList(learningContext, avoidExtra, _hyd.avoidTitles);
    }
    // A marker left behind (old server shape, or hydration skipped) must never reach the model.
    if (typeof learningContext === 'string' && learningContext.indexOf(AVOID_MARK) !== -1) {
      learningContext = learningContext.split(AVOID_MARK).join('');
    }

    // ── MODE: SCENES ──────────────────────────────────────────
    if (mode === 'scenes') {
      return await handleScenes(req, res, bc, _billingUser);
    }

    // ── MODE: IDEAS (default) ─────────────────────────────────
    // The brand profile, rendered by the ONE shared renderer (see _brain.fullBrandBlock).
    // This file used to build its own older copy (buildMasterPrompt) which silently dropped the
    // brand's approved winners, learned taste signals, competitors, channels and visual style —
    // on the endpoint that powers Ideas, Quick Post, Idea Catcher, Notebook-develop, PAA and
    // auto-refill, i.e. nearly everything the user sees.
    // examples:false → the approved winners are appended at the END of the prompt instead (recency
    // beats primacy in a ~20k-character prompt; up top they sat 16k characters from the task).
    const brandProfile = fullBrandBlock(bc, { examples: false });
    const winners = approvedWinnersBlock(bc);

    // ── Idea Catcher: user dropped ONE specific idea to develop ──
    // Capped for the same reason as learningContext — both are interpolated straight into the
    // prompt below, and seedTranscript (already capped at 4000) was the only one that was bounded.
    const seedIdea_ = (seedIdea || '').toString().trim().slice(0, SEED_TEXT_CAP);
    const seedNotes_ = (seedNotes || '').toString().trim().slice(0, SEED_TEXT_CAP);
    const seedTranscript_ = (seedTranscript || '').toString();
    const isSeed = !!(seedIdea_ || seedNotes_ || seedTranscript_);

    let gapInstruction = '';
    if (!isSeed && gaps && gaps.length > 0) {
      /* v677: send-daily names a DAY and nothing else, so render only the parts a caller
         actually supplied — the old template printed "- Monday / undefined (currently
         undefined ideas)" into the prompt for any gap that was not a full triple. */
      gapInstruction = `\nPRIORITY GAPS TO FILL (generate ideas for these first):\n${gaps.map(g => {
        const bits = [g && g.day, g && g.format].filter(Boolean).join(' / ');
        const n = (g && g.count != null) ? ` (currently ${g.count} ideas)` : '';
        return '- ' + (bits || 'any day') + n;
      }).join('\n')}`;
    }

    // Explicit format lock — only when the caller asks for it (Quick Post). Other
    // callers (e.g. Notebook "develop") pass a placeholder format but want the model
    // to pick the most fitting one, so they must NOT set forceFormat.
    let forceFormatInstruction = '';
    if (!isSeed && forceFormat) {
      forceFormatInstruction = `\nFORMAT REQUIREMENT: every idea you return MUST use the "${forceFormat}" format. Do not use any other format.`;
    }

    // Face-on vs faceless steering (only meaningful for the filmable formats: video, micro, qna, statement).
    let deliveryInstruction = '';
    if (delivery === 'faceless') {
      deliveryInstruction = `\nDELIVERY STYLE — FACELESS (applies to any VIDEO, MICRO-LECTURE, Q&A or STATEMENT idea; ignore for CAROUSEL/IMAGE, which are visual by nature): the creator is NOT on camera. Write the script as a VOICEOVER read over footage (it may be AI-voiced): natural spoken rhythm, but never a piece to camera. The shot list MUST be b-roll, stock clips, screen recordings, product or close-up shots, or text-on-screen cards — never "you on camera", "talk to camera", "look into the lens", or "hold the product to your face". Lean on on-screen text overlays to carry the key beats.`;
    } else if (delivery === 'faceon') {
      deliveryInstruction = `\nDELIVERY STYLE — FACE-ON (applies to any VIDEO, MICRO-LECTURE, Q&A or STATEMENT idea): the creator films themselves talking to camera. Write the script to be performed on camera and let the shot list assume the creator is on screen.`;
    }

    // Q&A quota is a BULK feature only — never force a single/small request into Q&A.
    // (For count=1 the old formula produced "at least 2 of the 1 ideas must be qna",
    // which overrode the format the user actually picked in Quick Post.)
    let qnaInstruction = '';
    // v640: the quota is now derived from the gaps the CLIENT actually asked for, instead of being
    // a flat 30% of every batch. Before this, `count >= 3` was the only condition — nothing about
    // the brand and nothing about Content Mix. A user who set qna to 0 in Settings still got 2 of
    // 5 ideas forced into Q&A, and renderIdeas then hid them (it drops any format whose mix weight
    // is 0). Those ideas were generated, billed and thrown away without ever being seen.
    // `gaps` is already mix-filtered client-side (generateNewIdeas builds it from _genFormats, the
    // formats with a weight above zero), so it is the honest signal for whether Q&A is wanted —
    // and it needs no new payload field. No qna gap => no Q&A instruction at all.
    const qnaGaps = (!isSeed && Array.isArray(gaps)) ? gaps.filter(g => g && g.format === 'qna').length : 0;
    if (qnaGaps > 0 && count >= 3) {
      // Ask for at most what was actually requested, and never more than a third of the batch.
      const qnaMin = Math.max(1, Math.min(qnaGaps, Math.floor(count / 3)));
      qnaInstruction = `\nAt least ${qnaMin} of the ${count} ideas should use the "qna" format — the brand's content mix asks for it. Each Q&A must use a different question angle from the list above.`;
    }

    // NO DEFAULT. This used to fall back to 'witty, educational' and present it under a "TONE
    // OPTIONS" heading as though the brand had chosen it — inventing a voice for a brand that
    // hadn't set one, and pushing every silent brand toward the same generic register.
    //
    // AND IT MUST NOT READ AS A MENU. There were three tone statements in one prompt and they
    // disagreed: this heading said "TONE OPTIONS", _brain.fullBrandBlock says the tones are the
    // brand's voice and "not a style to rotate through", and the JSON schema field below said
    // "one of the tone options" — which sits at ~94% of the assembled prompt, the last
    // content-bearing instruction before the output line, so it won on position. Across a 5-idea
    // batch that invited idea 1 deadpan, idea 2 blunt, idea 3 technical: exactly what the brand
    // rule forbids. The heading and the schema now agree with the brand rule.
    const brandTones = (bc.tones && bc.tones.length)
      ? bc.tones.map(t => String(t == null ? '' : t).trim()).filter(Boolean)
      : [];
    const tones = brandTones.join(', ');
    const primaryTone = brandTones[0] || '';
    const toneBlock = tones
      ? `BRAND VOICE — TONE: ${tones}\nThis is the brand's ONE voice and it is held in every idea. It is not a menu to pick from per idea: do NOT give different ideas different tones.\n\n`
      : '';
    // The schema value is what the model copies. Showing the literal primary tone makes the field
    // a LABEL of the one voice rather than a per-item choice — and it is the value Settings tallies
    // (app.html getToneCounts() matches idea.tone against a TONE_OPTIONS id), so the counter is
    // finally counting something real. With no tones set there is nothing honest to label it with,
    // so it stays empty rather than inventing a register the brand never chose.
    const toneField = primaryTone
      ? `${primaryTone}  (the SAME value on every idea — this is the brand's voice, not a per-idea choice)`
      : '  (this brand has not set any tones — leave this an empty string, do not invent one)';
    // Server-side clamp for the same reason. `tone` is READ by the app (Settings > Voice & Tone
    // shows "N ideas" per tone), so a value outside the brand's own set is a wrong number on
    // screen. Anything unrecognised falls back to the brand's PRIMARY tone — never to an invented
    // one, and never to anything for a brand that set none.
    const normTone = (v) => {
      if (!brandTones.length) return '';
      const s = String(v == null ? '' : v).trim().toLowerCase();
      return brandTones.find(t => t.toLowerCase() === s) || primaryTone;
    };

    // For a dropped idea, DEVELOP it faithfully — don't treat it as vague taste feedback.
    let learningBlock;
    if (isSeed) {
      learningBlock = `\n═══ DEVELOP THE USER'S DROPPED IDEA — THIS IS THE WHOLE JOB ═══\nThe user dropped ONE raw, half-baked idea below. Turn it into the single ready-to-film brief you return. It is the STAR: build the brief AROUND it, keep its actual angle, sharpen it, give it a killer hook, and make it punchy and scroll-stopping in the brand's voice. Do NOT swap it for a safer or more generic idea, and do NOT water it down. Pick the ONE format that best fits THIS idea — do not default to Q&A.\n\nTHE IDEA:\n"${seedIdea_}"${seedNotes_ ? `\n\nUser's notes about a reference video:\n"${seedNotes_}"` : ''}${seedTranscript_ ? `\n\nTranscript of a reference video (inspiration only — adapt to the brand, never copy):\n"${seedTranscript_.slice(0, 4000)}"` : ''}\n`;
    } else {
      learningBlock = learningContext ? `\n${learningContext}\n\nUse this feedback to shape your ideas. Lean into angles, formats, and tones the user approved. Avoid patterns they rejected.\n` : '';
    }

    const opener = isSeed
      ? `You are an elite short-form content strategist. Develop the user's dropped idea (below) into ONE genuinely great, ready-to-film brief — punchy, specific, scroll-stopping, and unmistakably in the brand's voice. The user's idea is the star: amplify it and stay faithful to its angle, never replace it with something safer.`
      : `You are an elite short-form content strategist who creates scroll-stopping content. Every hook must hit in the first 2 seconds — pattern interrupts, curiosity gaps, bold specific claims, contrarian angles. Punchy and sharp, never flat or generic — but always in the brand's voice (a dry brand stays dry, just dry AND punchy). Generate ${count} content ideas.`;

    // v640 — THE BRAND BLOCK MOVED TO THE END. It used to sit here, at ~2% of the prompt, and
    // from there to the winners at ~86% there was not one brand-specific character: 13,465 chars,
    // 56% of everything the model reads, all universal writing rules. The final quarter — the
    // recency zone a model weights hardest — was 79.5% house rules. `rulePrecedence()` is the
    // acknowledged patch for that and it is one 667-char sentence asking the model to re-rank
    // something it read 20,000 characters earlier; positional mass beats it.
    // Now: opener + task params -> craft rules -> BRAND (profile, learning, winners) -> schema.
    // The brand is the last thing read before the task, which is where it belongs.
    // Pure re-order: not one character of content changed.
    const prompt = `${opener}
${gapInstruction}
${forceFormatInstruction}
${deliveryInstruction}
${qnaInstruction}
CONTENT FORMATS:
- video: 30-60 second vertical video (Reel/TikTok). Structure: hook in the first 2 seconds, ONE core idea developed fast, payoff in the last 5 seconds. Script is written to be spoken — full sentences of varied length joined by natural connectors, 90-150 words (that is a FLOOR, not a target to undercut), no headings. Shot list: 4-8 concrete shots a solo creator can film on a phone, no crew. On-screen text: 3-6 short overlays that punctuate key moments, never a transcript.
- carousel: 5-8 slide Instagram carousel. Slide 1 = a hook that forces the swipe (a claim, question, or number — never a title). Slides 2-7 = ONE idea per slide, max 20 words each, building a single argument. Last slide = a takeaway worth saving or sharing. boldText = all slide texts, numbered ("1: ... 2: ..."). script = design instructions only: layout, contrast, type treatment. Every slide must earn the next swipe.
- statement: A bold standalone claim for a text graphic, written in THIS brand's voice. NEVER a single line: minimum 2 sentences, because one line says nothing on its own. It must land for a stranger with ZERO context — the claim first, then whatever makes it hit: the reframe, the cost, the number, the uncomfortable contrast. Setup-then-payoff is one way and often a good one, but it is not the only shape; a dry technical brand may simply state the fact and then the consequence. Do NOT reach for a motivational-speaker cadence unless that is genuinely this brand's voice. Range: 2-5 short sentences, 15-40 words total. Every line must hit — no explanations, no benefits list, no lecture, no CTA. The full statement must stand alone and be understood by someone who has never heard of the brand. BANNED: building the statement around an invented nickname or cryptic metaphor ("hangover candy", "dessert in a costume") that the reader must decode. Clever phrasing is welcome ONLY after the literal claim is already on the page in plain words — concrete nouns and real mechanisms beat wordplay. If a metaphor appears, the very next line must say the same thing literally. boldText = the full statement text. script = 2-3 sentences of practical shooting tips for the "film it instead" option (delivery, tone, framing — e.g. "Deadpan, straight into camera. One take, no music. Hold the last line two beats."). NO design instructions — no background/typography/layout talk, the graphic is auto-generated.
- micro: 10-15 second single-fact video. ONE surprising fact about how something in the WORLD works — never a walkthrough of how the brand's own product works, which is a feature tour, not a fact. The viewer learns exactly one thing they will repeat to someone else. Script 30-60 words, spoken style — still full sentences someone can say out loud, never clipped fragments. Structure: the fact stated bluntly, then one line of why it matters. No intro, no "did you know", no outro. 1-3 shots max.

LENGTH DISCIPLINE (mandatory): match output length to format. statement/static = glance formats, seconds of attention, minimal text. micro/qna = under 30 seconds spoken. video is the ONLY format that gets a full script. Never pad a short format into a lecture.
- static: Single image post (shown to users as "Image"). The image carries the idea on its own — describe ONE concrete, photographable scene or product shot (no collages, no vague lifestyle vibes). Caption: 1-3 sentences in brand voice adding context the image cannot — this is the one format where the caption IS the writing. End with a question or quiet prompt only when natural, never a hard CTA.
- qna: Q&A — a real audience question + short filmed answer (under 30 seconds). The creator films a quick, punchy answer on camera.
  CRITICAL RULES FOR Q&A:
  1. Every question MUST come from the BRAND CONTEXT above — use the customer pain points, product details, communities, target audience fears and goals. Never invent generic, off-brand questions unrelated to what this brand actually does.
  2. Questions should sound like REAL DMs or comments from followers — casual, specific, blunt. Use the audience's actual language from the brand profile.
  3. Each Q&A MUST use a DIFFERENT question angle. Rotate through these and NEVER repeat:
     * Myth-busting: "Is it true that [specific claim from the niche]?"
     * Product/offer-specific: "What's actually [in / behind] [brand's product or service]?" / "Why does [brand] [do a specific thing in how it works]?"
     * Versus/comparison: "[Brand product] vs [competitor category] — what's the difference?"
     * Skeptic/objection: "[Paraphrase a real customer pain point as a doubt]"
     * Timing/usage: "When should I actually use [product/service]?" / "Can I use [offer] for [a relevant situation from the community]?"
     * Beginner: "I just started [a situation/activity from the brand's communities] — do I need [what the brand offers]?"
     * Deep-cut: A nerdy specific question only someone in the target audience would ask
     * Contrarian: Challenge a common belief in the brand's niche
     * "Is X bad": "Is [a common practice or belief in the niche] actually a problem?"
  4. Answers must reference SPECIFIC product or service facts, specifics, or data from the brand profile. No vague "it depends" answers.
  5. TITLE = the raw question itself, as if someone typed it in a comment. HOOK = a DIFFERENT scroll-stopping opening line for the filmed answer (the blunt first line of your answer, or a tension-creating tease) — it must NEVER just repeat the question. Title and hook must never be identical.
  6. ANSWER LENGTH: under 30 seconds spoken, MAX 60 words. The FIRST sentence answers the question directly — no wind-up, no "great question". Then one supporting fact or example. End, don't trail off.
- bonus: Wildcard — content that breaks the weekly rotation on purpose. One of: a reactive take on something current in the niche, a seasonal angle, a behind-the-scenes/founder moment, or a contrarian opinion. It must still CHOOSE one production shape (video, statement, or image) and obey that format's rules. Bonus content should feel like the brand going off-script, never filler.

${toneBlock}ANGLE VARIETY (mandatory): within any single day, no two ideas may share the same angle, and not all ideas should be on the same topic. Rotate angles across: myth-bust, how-to / routine, customer story, surprising stat or mechanism, hot take / contrarian, comparison vs alternative, founder / behind-the-scenes, common mistake, before/after. Two ideas may share a topic ONLY if their angle AND format differ sharply. The goal is a feed that never feels like the same post twice.

Each idea MUST be a complete, ready-to-use content brief. Scripts must be FULL — no placeholders, no "[insert X]".

CLARITY RULE (all formats): never make the audience decode an in-joke. Titles, hooks and statements must carry the literal point in plain words. Invented nicknames for things ("hangover candy") are allowed only AFTER the plain-language claim has been made.

HOOK RULES (the hook determines if anyone sees the rest — it is MORE important than the script):
- Max 8 words. Shorter = better. Fragment sentences beat full sentences.
- The first word must create tension, curiosity, or a pattern interrupt.
- The hook must work as ON-SCREEN TEXT — it's what they read before audio kicks in.
- Use DIFFERENT patterns across ideas — never repeat the same formula:
  * Contrarian: "Everything you know about X is wrong." / "X is a scam."
  * Before/After: "I stopped X. Here's what happened." / "What used to require X now takes Y."
  * Specificity: "3 parts. One price. Zero fluff." / "From 6 steps to 2." (use numbers/specifics that fit THIS brand — never borrow another industry's)
  * Challenge: "Your doctor won't tell you this." / "Stop buying X."
  * Tribal split: "This separates serious X from everyone else."
  * Confession: "I was wrong about X for 5 years."
  * Prediction + stakes: "X is the 2026 Y that actually matters."
  * Result-based: "I tried X for 30 days. Never going back."
  * Problem callout: "If your X has more Y than Z, we need to talk."
- BLACKLIST — NEVER use these (they are AI tells that kill credibility):
  "Did you know", "In this video", "Hey guys", "Today we're going to",
  "Let me tell you", "Have you ever wondered", "Welcome back",
  "Here's the thing", "Here's the wild part", "Let's dive in",
  "I'm excited to share", "This is a game-changer", "Revolutionary",
  "Quick question", "Most people don't realize"
- STRONG hooks sound like a person at a bar telling a friend something urgent — not a presenter opening a webinar.
- Test: would someone STOP SCROLLING for this? If not, rewrite it.

${creativeGuidelines(bc.brandName)}

${clarityFlow()}

${spokenShape()}

${(() => { const _ex = spokenExample(bc); return _ex ? _ex + '\n\n' : ''; })()}${antiSlopRhythm()}

SELF-CHECK before finalizing (do this silently, output only the final JSON): every idea must be unmistakably in THIS brand's voice, lean on the brand's REAL specifics — its pain points, USPs, facts, vocabulary — instead of generic filler, and genuinely make this brand's audience stop scrolling. Rewrite anything that reads generic, off-voice, or interchangeable with a random competitor.
STAY IN THE AUDIENCE'S WORLD, NOT THE PRODUCT'S (this outranks the line above where they pull apart): the brand's specifics are RAW MATERIAL for talking about the reader's situation — they are not the subject. Ask of every script: is this about something the listener is living through, or is it a walkthrough of how our thing works? A chain of "you do this, then it does that, then you get those" is a feature tour, not content, no matter how well the sentences are built. Stay in their world — the annoying, expensive or confusing thing they are dealing with — and let the mechanism appear only as the resolution, in as few words as it takes. If a script could be read aloud by a competitor with their name swapped in, it was about the product.
THAT IS A RULE ABOUT SUBJECT, NOT ABOUT SHAPE — do NOT turn it into one opening formula. Being about the audience's world says nothing about how a script must START, and there are many ways in: a blunt claim, a hard number, a belief worth correcting, a question someone actually asked, a thing you noticed this week, a comparison, a small story, the punchline first. Rotate them. If several scripts in this batch open the same way, or every script you write begins by describing the reader's frustration, you have turned a subject rule into a template and the whole feed will read as one voice — rewrite them so the ways in genuinely differ.

${rulePrecedence()}

${brandProfile}
${learningBlock}${winners ? winners + '\n\n' : ''}EVERYTHING ABOVE THIS LINE IS THE BRAND. It is the last thing you read before the task because it is what matters most: the general writing rules exist to remove generic slop, not to overwrite a voice this brand has earned. Where they conflict, the brand wins.

HOW TO FILL "emphasis": 2-5 SHORT phrases copied VERBATIM from the script — the words the speaker should lean on when saying it out loud: the hard number, the flip word (not/never/instead), the payoff. These are stress marks for the teleprompter, so pick words that change the meaning if spoken flat. Never mark a whole sentence. Empty array for non-spoken formats.

Respond with a JSON array of exactly ${count} ideas. Every key below is read by the app — return all of them, and add no others. Each idea:
{
  "day": "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Bonus",
  "community": "the specific topic/theme this idea is about — usually that day's lead theme, but for the ~40% variety picks use an adjacent theme or evergreen brand angle",
  "format": "video|carousel|static|statement|micro|bonus|qna",
  "tone": "${toneField}",
  "title": "Short descriptive title",
  "hook": "Opening hook line (first 3 seconds)",
  "script": "Full script or body text",
  "emphasis": ["exact phrase", "another"],
  "shots": "Shot 1: ...\\nShot 2: ...\\nShot 3: ...",
  "caption": "Post caption text — ONLY for static and carousel formats (it IS the post there). Empty string for all video formats: captions are auto-generated on-platform.",
  "reelTitle": "Short reel title",
  "tags": "#BrandTag #niche1 #niche2 #broad1 (ALWAYS start with the brand hashtag, then 2-3 niche + 1 broad = max 5 total)",
  "boldText": "MANDATORY for statement and carousel, never omit it. For statement: the FULL statement text (this is the content people see). For carousel: all slide texts numbered. For statements, hook must be sentence 1 of boldText, and design notes in script may only reference lines that actually appear in boldText."
}

IMPORTANT: Return ONLY the JSON array, no markdown, no code fences, no explanation.`;

    // Optional reference screenshot the user dropped in — Grok can see it.
    const refImages = [];
    if (refImage) {
      try {
        if (typeof refImage === 'string' && refImage.startsWith('data:')) {
          const mm = refImage.match(/^data:([^;]+);base64,(.+)$/);
          if (mm && mm[2].length < 8000000) refImages.push({ mime: mm[1], data: mm[2] });
        } else if (refImage.data && String(refImage.data).length < 8000000) {
          refImages.push({ mime: refImage.mime || 'image/jpeg', data: String(refImage.data) });
        }
      } catch (e) {}
    }
    const imgNote = refImages.length
      ? '\n\nA REFERENCE SCREENSHOT is attached to this message. Study it and use what is relevant — the subject, the layout, the vibe, the wording — as inspiration for the idea. Translate it into a brand-true idea in the brand voice; never just describe the image, and never invent brand facts from it.'
      : '';

    const content = await callLLM({ deadlineMs: 93333, timeoutMs: 90000,
      messages: [{ role: 'user', content: prompt + imgNote }],
      model: 'grok',
      max_tokens: 16000,
      engine: (bc.engine || 'grok'),
      images: refImages.length ? refImages : undefined
    });

    // Robust parse — handles fences AND prose-wrapped JSON (esp. Claude).
    let ideas = extractJson(content);
    // v666 — UNWRAP BEFORE WRAPPING.
    // A model that answers `{"ideas":[...]}` instead of a bare array used to fall into the line
    // below, which wrapped the WRAPPER: `[{ideas:[...]}]`. cleanIdeas then read `.title`, `.hook`
    // and `.script` off an object that has none of them and produced ONE card titled "Untitled"
    // with every field blank — returned as 200, metered, and shown to the person as their ideas.
    // A wrapper is the single most common way a model drifts from "return a JSON array", so this
    // is the difference between recovering the batch and charging for a blank card.
    if (ideas && !Array.isArray(ideas)) {
      for (const k of ['ideas', 'results', 'items', 'posts', 'data']) {
        if (Array.isArray(ideas[k])) { ideas = ideas[k]; break; }
      }
    }
    // A single idea object (or a salvaged object-in-brackets) is valid — wrap it.
    if (ideas && !Array.isArray(ideas)) ideas = [ideas];
    if (!ideas) {
      return res.status(500).json({ error: 'Failed to parse AI response', raw: content });
    }

    if (!Array.isArray(ideas)) {
      return res.status(500).json({ error: 'AI response was not an array', raw: content });
    }

    // Validate and clean each idea
    const validFormats = ['video', 'carousel', 'static', 'statement', 'micro', 'bonus', 'qna'];
    const validDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'Bonus'];

    // EMPHASIS IS NOT DECORATION — IT IS CONSUMED. app.html passes idea.emphasis into
    // tpFormatScript -> tpEmphasise, whose PREFERRED branch is `if (marks.length)`: the generator's
    // own stress marks for the teleprompter. This map used to drop the key, and cleanIdeas() is the
    // only object the client ever sees — so that branch was dead on arrival and every filmed script
    // silently fell back to the number/flip-word heuristic its own comment calls the fallback, while
    // the prompt kept paying tokens for a ~250-char instruction explaining a field we deleted.
    // Clamped like its neighbours: it is model output that ends up in the DOM.
    const cleanEmphasis = (v) => (Array.isArray(v) ? v : [])
      .map(s => String(s == null ? '' : s).trim().slice(0, 120))
      .filter(Boolean)
      .slice(0, 6);

    // v666 — COERCE, AND THROW NOTHING AWAY.
    // These fields were passed through raw, so a model that answered a script as a list of lines or
    // a title as a number handed the client a shape it renders with string methods. Joining a list
    // rather than dropping it matters: the model DID write the script, and losing it would be a
    // worse bug than the crash. A bare string in the array becomes the script for the same reason.
    const txt = v => {
      if (v == null) return '';
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      if (Array.isArray(v)) return v.map(txt).filter(Boolean).join('\n');
      try { return Object.values(v).map(txt).filter(Boolean).join(' '); } catch (e) { return ''; }
    };
    const cleanIdeas = (arr) => arr.map(raw => {
      const idea = (raw && typeof raw === 'object') ? raw : { script: txt(raw) };
      return {
      day: validDays.includes(idea.day) ? idea.day : 'Bonus',
      community: txt(idea.community),
      format: validFormats.includes(idea.format) ? idea.format : 'video',
      // Was `idea.tone || 'witty'` — three lines under a comment explaining that exact fallback had
      // been removed for inventing a voice. Settings tallies this field ("N ideas" per tone), so a
      // deadpan brand's whole library was being counted as witty. normTone keeps it inside the
      // brand's OWN tones, or empty when the brand set none.
      tone: normTone(idea.tone),
      title: txt(idea.title) || 'Untitled',
      hook: txt(idea.hook),
      script: txt(idea.script),
      emphasis: cleanEmphasis(idea.emphasis),
      shots: txt(idea.shots),
      caption: txt(idea.caption),
      reelTitle: txt(idea.reelTitle),
      tags: txt(idea.tags),
      ...(txt(idea.boldText) ? { boldText: txt(idea.boldText) } : {})
      };
    });
    ideas = cleanIdeas(ideas);

    // v666 — NEVER RETURN A BLANK CARD AS A SUCCESS.
    // Every field above falls back to '' and the title to 'Untitled', so a reply the parser could
    // not make sense of came back as 200 with cards that have a placeholder title and nothing in
    // them. The person saw empty ideas, the call was metered, and nothing anywhere said the model
    // had failed. An idea with no hook, script, caption or statement is not an idea.
    const _usable = i => !!(i && (i.hook || i.script || i.caption || i.boldText || i.reelTitle ||
                                 (i.title && i.title !== 'Untitled')));
    const _kept = ideas.filter(_usable);
    if (!_kept.length) {
      console.error('generate-ideas: model reply parsed but held no usable idea; returning an error rather than blank cards');
      return res.status(502).json({ error: "That came back empty — try again", raw: String(content || '').slice(0, 400) });
    }
    ideas = _kept;

    // ── Output guardrail: if the model slipped a hard brand-rule violation (an avoid-word or a banned
    // topic) into the batch, regenerate ONCE with the offenders named. Bounded to one retry, fully
    // guarded, and only keeps the retry if it's actually cleaner — so it can never break or worsen the batch.
    try {
      const _viol = outputViolations(JSON.stringify(ideas), bc);
      if (_viol.length) {
        const _bad = Array.from(new Set(_viol.map(v => v.hit))).slice(0, 12).join(', ');
        const _fix = prompt + imgNote + `\n\nCRITICAL FIX: your previous draft used these FORBIDDEN words/topics: ${_bad}. Regenerate ALL ideas with the SAME quality, formats and structure, but with NONE of those words or topics anywhere (not in titles, hooks, scripts, captions or tags). Return the same JSON array.`;
        const _c2 = await callLLM({ deadlineMs: 93333, timeoutMs: 90000, messages: [{ role: 'user', content: _fix }], model: 'grok', max_tokens: 16000, engine: (bc.engine || 'grok'), images: refImages.length ? refImages : undefined });
        let _i2 = extractJson(_c2);
        if (_i2 && !Array.isArray(_i2)) _i2 = [_i2];
        if (Array.isArray(_i2) && _i2.length) {
          const _clean2 = cleanIdeas(_i2);
          if (outputViolations(JSON.stringify(_clean2), bc).length < _viol.length) ideas = _clean2;
        }
      }
    } catch (e) { /* keep the original batch — guardrail is best-effort */ }

    // Metered against whoever the gate was checked against (the brand owner for a seat, the
    // cron's account for the daily push) — the two MUST match, or a ceiling would be checked
    // that nothing ever increments.
    if (_billingUser) await _usage.logUsage({ userId: _billingUser, brandId: _meterBrand || brandId || bc.brandId || bc.brand_id || null, action: 'ideas', model: bc.engine || 'grok' });
    return res.status(200).json({ ideas });

  } catch (err) {
    const ai = aiUnavailable(err); if (ai) return res.status(ai.status).json(ai.body);   // v690 — a refused AI account (no credits / spending limit) is a 503 with the honest message, not "try again"
    console.error('Generate ideas error:', err);
    return res.status(500).json({ error: err.message });
  }
};

/**
 * Generate quick scene presets for the Prompt Generator.
 * Routed through callLLM (Grok); scenes are cached so this stays cheap.
 */
async function handleScenes(req, res, bc, userId) {
  const brandName = bc.brandName;
  if (!brandName) return res.status(400).json({ error: 'Brand name required' });

  // Build day rotation context
  const dayRotation = bc.dayRotation || {};
  const days = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
  const dayLines = days.map(d => `- ${d}: ${dayRotation[d] || 'General'}`).join('\n');

  const prompt = `You are a creative director generating image prompt scenes for a brand's content creation tool.

BRAND PROFILE (everything the user set — honor all of it, and keep scenes true to the brand's visual style and voice):
${fullBrandBlock(bc)}

This brand follows a 7-day content rotation where each day focuses on a different community/theme:
${dayLines}

Generate scene presets organized BY DAY. For each day, create 3-4 scenes that match that day's community/theme. Each scene should be a realistic, photogenic situation where this brand's product naturally appears in the context of that day's theme.

CRITICAL RULES:
- Scenes must be specific to THIS brand AND the day's community theme
- Each scene description should be a detailed image prompt (person, setting, action, lighting, mood)
- Include the brand name naturally in each description
- Labels should be 1-3 words max
- Match each day's scenes to THAT day's own community theme (shown above) — e.g. if a day's theme is "meal prep" show a meal-prep context, if it's "sourcing suppliers" show a supplier/warehouse context. Never assume a fitness, health, or supplement context unless the day's theme is actually about that.
- Think about WHERE and WHEN someone in that community would use this product

Return ONLY valid JSON object, no other text:
{"Monday": [{"label": "short", "desc": "detailed scene"}], "Tuesday": [...], ...}

Include all 7 days. 3-4 scenes per day.`;

  const content = await callLLM({ deadlineMs: 93333,
    messages: [{ role: 'user', content: prompt }],
    model: 'grok',
    temperature: 0.8,
    max_tokens: 4000
  });

  if (!content) return res.status(500).json({ error: 'No content from AI' });
  const parsed = extractJson(content);
  if (!parsed) return res.status(500).json({ error: 'Failed to parse scenes', raw: content });

  // Charge only AFTER a successful parse (never on a failure above).
  // `_usage` is a const declared INSIDE the exported handler, so this top-level function could
  // never see it: every scenes call reached here, threw ReferenceError, and was swallowed by the
  // handler's catch into a bare 500 — AFTER the Grok call had already been paid for and parsed.
  // So the feature burned a generation every time and reported "Failed to generate scenes" every
  // time. Pre-existing (reproduced against the unmodified file); required locally, like the other
  // inline `require('./_usage')` call sites in this codebase.
  if (userId) await require('./_usage').logUsage({ userId, brandId: bc.brandId || bc.brand_id || null, action: 'ideas', model: bc.engine || 'grok' });
  // Support both new {day: scenes[]} and legacy scenes[] format
  if (Array.isArray(parsed)) {
    return res.status(200).json({ scenes: parsed });
  }
  return res.status(200).json({ dayScenes: parsed });
}

/**
 * GENERIC craft rules only — no brand fields.
 *
 * This is what is left of the old `buildMasterPrompt`. That function rendered the brand profile AND
 * these universal rules together, which put generic voice prescriptions inside the brand section
 * (see _brain.fullBrandBlock for why that is harmful). The brand half now lives in the single
 * shared renderer; the rules half lives here, in the prompt body where it belongs.
 *
 * generate-ideas deliberately does NOT call writingCraft() — it keeps its own tuned hook rules —
 * so it needs its own copy of the anti-AI word list.
 */
function creativeGuidelines(rawBrandName) {
  const brandName = String(rawBrandName || '').trim() || 'My Brand';
  const sections = [];

  sections.push(`CREATIVE GUIDELINES:
- Every hook must pass the "thumb-stop test" — would someone actually stop scrolling for this? Make it punchy, specific, and impossible to ignore, in the brand's voice.
- Scripts should sound natural when read aloud, not written
- Use specific numbers, names, and details — never generic claims
- Each post should teach, challenge, or entertain — ideally two of three
- ALWAYS include the brand hashtag (#${brandName.replace(/\s+/g, '')}) as the FIRST tag
- Max 5 hashtags total: brand tag + 2-3 niche community tags + 1 broad reach tag. Fewer is better for the algorithm.
- Hashtags obey the same rules as the copy: never use the brand's avoid-words, and never use hype tags like #viral, #gamechanger, #musthave, #fyp-bait. Plain, specific, on-topic tags only.
- Captions should add value beyond the visual — not just describe it

ANTI-AI WRITING RULES (mandatory):
- NEVER use em dashes. Use commas, periods, or parentheses instead.
- NEVER use "not just X, it's Y" or "not only X, but Y" constructions.
- NEVER use rule-of-three lists to sound comprehensive. Two items or four, never three.
- NEVER tack -ing phrases onto sentences for fake depth (highlighting, showcasing, ensuring, fostering, reflecting, underscoring, emphasizing).
- NEVER use these AI-tell words: delve, enhance, foster, garner, showcase, vibrant, tapestry, testament, pivotal, crucial, landscape (abstract), interplay, intricate, leverage, elevate, cornerstone, multifaceted, nuanced, paradigm, robust, seamless, synergy, holistic.
- NEVER use "serves as" / "stands as" / "represents". Just say "is".
- NEVER use false ranges ("from X to Y, from A to B").
- NEVER start with "In today's..." or "In the world of...".
- NEVER use filler: "It's important to note", "At the end of the day", "When it comes to".
- NEVER use generic closers: "The future looks bright", "Exciting times ahead".
- NEVER use the word "viral", "going viral", or "viral trend" in the actual content/script — virality is a behind-the-scenes strategy, never something the brand says out loud.
- Vary sentence length. Mix short punchy lines with longer ones.
- Use straight quotes, not curly quotes.
- Write like a person talking, not a press release.`);

  return sections.join('\n');
}
