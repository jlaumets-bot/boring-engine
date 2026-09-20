// Sharpen — a two-pass "critique then rewrite" refine for an EXISTING draft.
// Opt-in (user taps a Sharpen button), so spending two Grok calls for max quality is deliberate.
// Pass 1: the brand's honest editor lists concrete weaknesses vs the brand + its APPROVED WINNERS.
// Pass 2: rewrite the draft fixing every point — SAME format, structure, and core idea, just tighter.
// Generic: takes a `content` object of {field: text}, returns the SAME keys sharpened, so it works for
// posts (hook/script/caption/...), blog (answer), and memes (statement) without per-format branching.
const { callLLM } = require('./_llm');
const { fullBrandBlock, clarityFlow, antiSlopRhythm, rulePrecedence, spokenShape } = require('./_brain');

// Formats whose `script` is read aloud to camera. Same set as _brain.SPOKEN_EX_FORMATS.
const SPOKEN_FORMATS = ['video', 'micro', 'qna'];

// Tolerant JSON extraction (same idea as _brain.extractJson but object-only for our keyed output).
function parseObj(text) {
  if (!text) return null;
  let s = String(text).replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(s); } catch (e) {}
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) {} }
  return null;
}

module.exports = async function handler(req, res) {
  const allowed = ['https://contentshrimp.com', 'https://bettercontent.app', 'https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const _g = await require('./_usage').guard(req, 'sharpen', res);
  if (!_g.user) return res.status(401).json({ error: 'Please sign in again.' });
  if (_g.over) return require('./_usage').denyResponse(res, _g.gate);

  try {
    const { content, kind, format, brandContext , brandId, bcFields } = req.body || {};
    let bc = brandContext || {};
    // v625: HYDRATE THE BRAND BRAIN SERVER-SIDE. app.html now sends a LEAN request here
    // (brandId + only what the database cannot know). Without this branch the handler received
    // `brandContext: {recentTrends}` and fullBrandBlock rendered a BRAND PROFILE containing
    // nothing but a trends line — i.e. this endpoint was generating with NO brand brain at all,
    // silently, producing generic output that still LOOKS fine. Caught before it shipped.
    // Refuse rather than write brand-less content: 424 makes the client re-send what it has.
    // The format is passed so the approved winners are format-MATCHED, exactly as the client did:
    // sharpenNow() overrides `approvedExamples` with getApprovedExamples(o.format) before sending.
    // With '' here, sharpening a statement would be shown four approved videos as its exemplars —
    // a silent swap of the strongest voice signal in the product, invisible in the output.
    if (brandId) {
      // humanEditedTitles is localStorage-only knowledge, so the hydration cannot derive it (same
      // reason recentTrends is sent). Without it every hydrated winner is labelled machine-written
      // and _brain's approvedWinnersBlock demotes the user's own rewrites. Form copied from generate-ideas.
      const _hyd = await require('./_brandctx').loadBrandContext(brandId, { userId: _g.user.id, humanEdited: req.body && req.body.humanEditedTitles }, String(format || ''));
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

    // Only sharpen the non-empty text fields we were given, and remember their exact keys so pass 2
    // returns the SAME shape (nothing invented, nothing dropped silently).
    const keys = (content && typeof content === 'object')
      ? Object.keys(content).filter(k => content[k] != null && String(content[k]).trim())
      : [];
    if (!keys.length) return res.status(400).json({ error: 'Nothing to sharpen' });

    const kindLabel = (kind || 'post').toString();
    const fmt = (format || '').toString();
    const brandInfo = fullBrandBlock(bc);
    const serialized = keys.map(k => `${k}: ${String(content[k]).slice(0, 2000)}`).join('\n');

    // Sharpen must NOT shorten. Especially for spoken/video scripts, the natural talk-track and story
    // build-up are the whole point — compressing to bullet-y statements ruins it. Tell the model the shape.
    const STYLE = {
      video: 'This is a SPOKEN video script — keep the natural, conversational, story-like talk-track (short spoken sentences, the build-up, the beats). Keep the SAME length.',
      micro: 'This is a short SPOKEN video — keep it spoken and natural, same length.',
      qna: 'This is a SPOKEN answer to a question — keep the conversational answer flow and the same length.',
      statement: 'This is a bold text statement — it can be tight, but keep the same idea, beats and punch; do not gut it.',
      carousel: 'These are carousel slides — keep the same number of slides and their story flow.',
      static: 'This is a caption — keep the same length and conversational voice.',
    };
    const styleNote = (kind === 'blog')
      ? 'This is a blog article — keep the full length and every section; sharpen the writing, do NOT summarize or shorten it.'
      : (STYLE[fmt] || 'Keep the same length, voice and natural spoken flow as the original.');

    // ── TIME BUDGET ───────────────────────────────────────────────────
    // This handler makes TWO SEQUENTIAL LLM calls. `_llm.httpsPost` defaults to 240000ms when no
    // `timeoutMs` is passed, so with both calls unbounded the worst case was 240s + 240s = 480s
    // against a 300s maxDuration (vercel.json) — the platform killed the function mid-pass-2 and
    // the user got a bare 504 with no app-level error and no log line. Our own timeout must fire
    // FIRST so the failure surfaces as the retryable "The AI is having a moment".
    //
    //   pass 1 (critique, max_tokens 700 — small output)   60s
    //   pass 2 (rewrite,  max_tokens 2500 — the real work) 120s
    //   ───────────────────────────────────────────────────────
    //   worst case                                         180s  <  300s maxDuration (120s margin)
    //
    // Margin covers brand hydration (_brandctx), JSON parsing and usage logging.
    // Same convention as api/crawl-brand.js, which sizes its own two sequential calls this way.
    //
    // The two values are written as NUMERIC LITERALS at the call sites on purpose:
    // scripts/verify/timeout-budgets.mjs reads them with /timeoutMs\s*:\s*(\d+)/, so a named
    // constant would be invisible to the ratchet and it would silently fall back to assuming the
    // 240s default — passing this file for the wrong reason. Keep them inline.

    // ── PASS 1 · critique ─────────────────────────────────────────────
    let critique = '';
    try {
      const cSys = `You are the brand's sharpest, most honest line editor. You DIAGNOSE, you do not rewrite. Judge only what makes content STOP the scroll and land: the hook, the voice, and how vividly it conveys a real, relatable SITUATION the reader feels. A great post usually sells nothing — so NEVER treat "doesn't mention the product / what the brand does / its features" as a weakness; pushing the writer to add that makes it WORSE. Be specific, no praise, no filler.`;
      const cUser = `THE BRAND — its voice, approved winners and rules. Judge the WRITING's VOICE against this. It is NOT a checklist of facts to cram in:
${brandInfo || '(limited brand context — judge for a strong, non-generic, on-voice ${kindLabel})'}

THE DRAFT (${kindLabel}${fmt ? ', format: ' + fmt : ''}) — ${styleNote}
${serialized}

List 2-5 SPECIFIC weaknesses in the WRITING ONLY — a weak or AI-tell hook, voice drift from the approved winners, generic/interchangeable lines, a fuzzy or buried situation. Quote the exact weak phrase. Do NOT suggest: adding product features / USPs / sales angles / "what we do" lines; opening on the product or "someone using our X" (the hook must open on the reader's own situation); or shortening/cutting length — a spoken script SHOULD breathe and tell a story, so its length and natural build-up are FEATURES, not filler. If the draft already lands a relatable situation in the brand's voice, reply with exactly: STRONG`;
      critique = await callLLM({ deadlineMs: 140000, timeoutMs: 60000,
        messages: [{ role: 'system', content: cSys }, { role: 'user', content: cUser }],
        model: 'grok', max_tokens: 700, engine: (bc.engine || 'grok'),
      }) || '';
    } catch (e) {
      // Degrading to a single-pass rewrite is the CORRECT fallback — but it used to happen in
      // total silence, so a permanently-failing critique pass would quietly turn Sharpen into a
      // one-pass tool forever and still look fine from the outside. Name it in the logs.
      console.error('sharpen: critique pass failed, falling back to single-pass rewrite —', (e && e.message) || e);
      critique = '';
    }

    // Already great → don't burn the second call or risk making it worse.
    if (/^\s*STRONG\b/i.test(critique)) {
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
      await require('./_usage').logUsage({ userId: _g.billingUserId || _g.user.id, brandId: logBrandId, action: 'sharpen', model: bc.engine || 'grok' });
      return res.status(200).json({ sharpened: content, unchanged: true });
    }

    // ── THE COMPRESSION COUNTERWEIGHT (v640's bug, one file over) ─────
    // rSys below includes clarityFlow(), which carries the compression rules ("One idea per
    // sentence", "Cut every word that isn't working"). spokenShape() exists specifically as their
    // counterweight and says so in its own text — and it was not here. So Sharpen, which edits the
    // video/micro/qna scripts people read to camera, received the cutting half of the pair without
    // the override half, exactly the coverage hole that produced verbless fragment scripts in
    // generate-ideas. The same-length rule below bounds word COUNT, not sentence COMPLETENESS: a
    // draft can hold its length and still come back as noun phrases with full stops.
    //
    // It is applied ONLY to a spoken script, and scoped so it cannot fight the two deliberate rules
    // this handler already has: the hard same-length cap, and the ban on adding product facts.
    // spokenShape's "restore the sentences and connectors you compressed out" is about SHAPE, so it
    // is explicitly told here that it does not license lengthening.
    const isSpokenDraft = kind !== 'blog' && SPOKEN_FORMATS.indexOf(fmt) >= 0;
    const spokenCounterweight = isSpokenDraft
      ? `\nTHE DRAFT IS A SPOKEN SCRIPT — the compression rules directly above must NOT be applied to it. This governs the SHAPE of the sentences only: it does not license making the script longer or shorter, and it never means adding facts, product lines or new material. The same-length rule still holds.\n\n${spokenShape()}\n`
      : '';

    // ── PASS 2 · rewrite against the critique ─────────────────────────
    const rSys = `You are the brand's line EDITOR. You make the SMALLEST changes that fix the critique — polishing, NOT re-pitching and NOT rewriting from scratch. PRESERVE the original's angle, situation, context, relatability AND LENGTH — keep the wording that already works, only fix the weak parts. CRITICAL: Sharpen does NOT mean shorten — the result must be the SAME length as the original (within ~10%); if you cut it to half or a third you have FAILED. For spoken/video scripts keep the natural, conversational, story-like talk-track and every beat; do NOT compress it into terse statements. The hook/opening must open on the READER's situation, feeling or a moment of tension — it must NOT reference the brand, its product, or "someone using our X". NEVER make it salesy, NEVER add product features / USPs / "what our brand does" lines that were not already there, NEVER turn a relatable moment into a product pitch. Same format and structure. No invented facts, no avoid-words, no AI-tell openers. Never introduce AI-tell words (delve, leverage, enhance, foster, showcase, elevate, seamless, robust, synergy, vibrant, tapestry, testament), em dashes, or rule-of-three lists.

${clarityFlow()}
${spokenCounterweight}
${antiSlopRhythm()}`;
    const rUser = `VOICE & ACCURACY REFERENCE — use ONLY to match the voice and to avoid false claims. This is background; do NOT pull these facts in to sell or explain the product:
${brandInfo || '(limited context — keep it on-voice, invent nothing)'}

THE DRAFT (${kindLabel}${fmt ? ', format: ' + fmt : ''}) — ${styleNote}
${serialized}

WHAT TO FIX (voice / hook / clarity only):
${critique && critique.trim() ? critique.trim() : '(no explicit critique — make only light touch-ups to the hook and voice; keep the situation, the length and everything that already works)'}

Rewrite with the LIGHTEST touch that fixes those points, keeping the original's situation, angle, relatability AND length fully intact — the result must be the SAME length as the original (within ~10%); do NOT shorten, summarize, or compress it, and keep the spoken/story flow. Do NOT add sales or product lines, and do NOT open on the product. Return ONLY a JSON object with EXACTLY these keys and no others: ${JSON.stringify(keys)}. Keep each field the same kind/shape AND roughly the same length as the input (a hook stays a short hook, a script stays a full spoken script, tags stay hashtags, a numbered carousel stays numbered). No prose, no markdown fences.

${rulePrecedence()}`;

    const out = await callLLM({ deadlineMs: 140000, timeoutMs: 120000,
      messages: [{ role: 'system', content: rSys }, { role: 'user', content: rUser }],
      model: 'grok', max_tokens: 2500, engine: (bc.engine || 'grok'),
    });
    if (!out) return res.status(502).json({ error: 'No response from the AI — try again' });
    const parsed = parseObj(out);
    if (!parsed || typeof parsed !== 'object') return res.status(502).json({ error: 'Could not parse the rewrite — try again' });

    // Only accept the keys we asked for; fall back to the original for any the model dropped/blanked,
    // so Sharpen can NEVER lose or blank the user's content.
    const sharpened = {};
    let moved = false;
    for (const k of keys) {
      const v = parsed[k];
      // v666: COERCE. `v` was returned raw, so a model that answered a field as a number or a list
      // handed the client a shape it renders with string methods. Same defect class as api/remix.js.
      sharpened[k] = (v != null && String(v).trim()) ? String(v) : content[k];
      if (String(sharpened[k]) !== String(content[k] == null ? '' : content[k])) moved = true;
    }

    // v666 — SAY SO WHEN NOTHING CHANGED.
    // Every key falls back to the original when the model drops or blanks it, so this loop can
    // return the input BYTE FOR BYTE — and it did so without the `unchanged` flag the early-exit
    // path at the top of this file sets. The client reads that flag (sharpenNow in app.html) and
    // says "Already sharp — nothing to change". Without it the user is told "Sharpened ✨", a
    // taste signal is recorded for a rewrite that never happened, and a paid model call is
    // presented as work done. The flag is the difference between a light-touch editor that is
    // honest about doing nothing and one that pretends.
    if (!moved) {
      let logBrandId0 = null;
      const _bid0 = bc.brandId || bc.brand_id || null;
      if (_bid0) {
        try {
          const store = require('./_publish/store');
          if (await store.userCanAccessBrand(_g.user.id, _bid0)) logBrandId0 = _bid0;
        } catch (e) {}
      }
      await require('./_usage').logUsage({ userId: _g.billingUserId || _g.user.id, brandId: logBrandId0, action: 'sharpen', model: bc.engine || 'grok' });
      return res.status(200).json({ sharpened, unchanged: true });
    }

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
    await require('./_usage').logUsage({ userId: _g.billingUserId || _g.user.id, brandId: logBrandId, action: 'sharpen', model: bc.engine || 'grok' });
    return res.status(200).json({ sharpened });
  } catch (err) {
    console.error('sharpen error:', err);
    return res.status(500).json({ error: 'Sharpen failed — try again' });
  }
};
