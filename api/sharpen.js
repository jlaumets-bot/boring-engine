// Sharpen — a two-pass "critique then rewrite" refine for an EXISTING draft.
// Opt-in (user taps a Sharpen button), so spending two Grok calls for max quality is deliberate.
// Pass 1: the brand's honest editor lists concrete weaknesses vs the brand + its APPROVED WINNERS.
// Pass 2: rewrite the draft fixing every point — SAME format, structure, and core idea, just tighter.
// Generic: takes a `content` object of {field: text}, returns the SAME keys sharpened, so it works for
// posts (hook/script/caption/...) without per-format branching.
const { aiUnavailable } = require('./_llm');
const { fullBrandBlock, rulePrecedence, spokenV2 } = require('./_brain');
// v693 — content-v2 writing rules (.unlazy/content-v2/PLAN.md change 3): the short style guide
// (whose one hard rule is NO_INVENTION_RULE) replaces clarityFlow's compression rules, the
// spokenShape override that existed only to counter them, and the rhythm list; the brand renders
// through fullBrandBlock(bc,{v2:true}). A draft's [your story: ...] slots survive the edit untouched.
const { styleGuide, writerCallResilient, writerProvider, writerEffort, startBrandAttribution, guardIdeaNoSell } = require('./_write');   // v693 r3 — provider switch + depth with headroom

// Formats whose `script` is read aloud. Same set as _brain.SPOKEN_EX_FORMATS.
const SPOKEN_FORMATS = ['video', 'micro', 'qna'];

// ── v709 consistency (.unlazy/consistency/CONTRACT.md, audits B F7 / D F7) ─────────────────────────
// * The shared POST RULES, the shared guard (mode 'single') and the brand's delivery, looked up at CALL
//   time from api/_write.js, each with a guarded fallback.
// * NO 2000-CHARACTER CUT. Every field went to the model as slice(0, 2000) and the short version was
//   written back, losing a long caption's last lines and its "Source:" line. Now a caption may be up to
//   2200 characters (MAX_CAPTION) and any other field up to FIELD_MAX; a field over its cap is not sent
//   and comes back untouched. The caption's Source line is held back and put back after the rewrite.
// * Tags are never rewritten (the model writes no hashtags anywhere).
// * An "already sharp" or unchanged answer IS charged (the critique ran); only a failure is not.
// * A repeat of the SAME request while the first is still running on this instance (the button re-enabled
//   at 65 s and was pressed again) waits for the first and returns its answer: one AI run, one charge.
//   Instances do not share memory, so this is best-effort; the app keeps the button disabled too.
const CAPTION_MAX = 2200;
const FIELD_MAX = 8000;
const TAG_KEYS = ['tags', 'hashtags'];
const SOURCE_TAIL_RE = /\n*(Sources?:[ \t]*https?:\/\/\S+(?:[ \t]*·[ \t]*https?:\/\/\S+)*)[ \t]*$/i;
const INFLIGHT = new Map();   // request key -> Promise<{status, body}>
function requestKey(userId, body) {
  try {
    const b = body || {};
    return require('crypto').createHash('sha256').update(JSON.stringify([userId, b.content, b.kind, b.format, b.brandId || null, b.postType || null, b.delivery || null])).digest('hex');
  } catch (e) { return ''; }
}
const _W = () => require('./_write');
function sharedPostRules(o) { const f = _W().postRules; if (typeof f !== 'function') return ''; try { return String(f(o) || ''); } catch (e) { return ''; } }
function normDelivery(v) { const s = String(v == null ? '' : v).trim().toLowerCase(); return s === 'faceless' ? 'faceless' : (s === 'face' || s === 'faceon' || s === 'face-on') ? 'face' : ''; }
// v693 r4 — ONE BUDGET from handler start. The critique thinks at 'medium' (WRITER_EFFORT_EDIT) and,
// if it fails or times out, is retried once a level lower — but only with the rewrite's own share
// (REWRITE_RESERVE_MS) still untouched. The rewrite takes what is left, capped at 140 s. With the
// usage write (2 x 8 s) this fits the 300 s maxDuration.
const FN_BUDGET_MS = 280000;
const REWRITE_RESERVE_MS = 140000;

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
  const _shT0 = Date.now();
  const _shLeft = () => FN_BUDGET_MS - (Date.now() - _shT0);
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

  const _key = requestKey(_g.billingUserId || _g.user.id, req.body);
  const _first = _key && INFLIGHT.get(_key);
  if (_first) {
    // The same request is already running here: its answer, not a second paid run (this request never
    // logs usage, so its own reservation is handed back).
    const r = await _first;
    return res.status(r.status).json(Object.assign({}, r.body, { repeat: true }));
  }
  let _settle = () => {};
  if (_key) INFLIGHT.set(_key, new Promise(r => { _settle = r; }));
  let _code = 200;
  const _status0 = res.status.bind(res), _json0 = res.json.bind(res);
  res.status = (c) => { _code = c; _status0(c); return res; };
  res.json = (b) => { _settle({ status: _code, body: b }); return _json0(b); };

  try {
    const { content, kind, format, brandContext , brandId, bcFields, postType, delivery } = req.body || {};
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
      ? Object.keys(content).filter(k => content[k] != null && String(content[k]).trim() && TAG_KEYS.indexOf(k) < 0 &&
          String(content[k]).length <= (k === 'caption' ? CAPTION_MAX : FIELD_MAX))
      : [];
    if (!keys.length) return res.status(400).json({ error: 'Nothing to sharpen' });

    const kindLabel = (kind || 'post').toString();
    const fmt = (format || '').toString();
    const brandInfo = fullBrandBlock(bc, { v2: true });   // v693 — v2: tones <= 3, USPs as background facts, held beliefs
    // v709 (B F7) — whole fields; the caption's Source line is held back and put back after the rewrite.
    const _tail = {};
    const _sent = {};
    for (const k of keys) {
      let v = String(content[k]);
      if (k === 'caption') { const m = v.match(SOURCE_TAIL_RE); if (m) { _tail[k] = m[1]; v = v.slice(0, m.index).replace(/\s+$/, ''); } }
      _sent[k] = v;
    }
    const serialized = keys.map(k => `${k}: ${_sent[k]}`).join('\n');
    const _pt = ['tip', 'about', 'news', 'qna', 'story', 'bts'].indexOf(postType) >= 0 ? postType : '';
    const _delivery = normDelivery(delivery) || normDelivery(bc.delivery) || 'face';
    const _rules = sharedPostRules({ type: _pt, format: fmt, delivery: _delivery });

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
    const styleNote = STYLE[fmt] || 'Keep the same length, voice and natural spoken flow as the original.';

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
    // v693 r3 — START the brand-attribution check now and await it after the AI work, so it never
    // adds Supabase time after the model answers (a killed function delivers nothing).
    const _brandAttr = startBrandAttribution(_g.user.id, bc.brandId || bc.brand_id || null);
    let critique = '';
    try {
      const cSys = `You are the brand's sharpest, most honest line editor. You DIAGNOSE, you do not rewrite. Judge only what makes content STOP the scroll and land: the hook, the voice, and how vividly it conveys a real, relatable SITUATION the reader feels. A great post usually sells nothing — so NEVER treat "doesn't mention the product / what the brand does / its features" as a weakness; pushing the writer to add that makes it WORSE. Be specific, no praise, no filler.`;
      const cUser = `THE BRAND — its voice, approved winners and rules. Judge the WRITING's VOICE against this. It is NOT a checklist of facts to cram in:
${brandInfo || '(limited brand context — judge for a strong, non-generic, on-voice ${kindLabel})'}

THE DRAFT (${kindLabel}${fmt ? ', format: ' + fmt : ''}) — ${styleNote}
${serialized}

List 2-5 SPECIFIC weaknesses in the WRITING ONLY — a weak or AI-tell hook, voice drift from the approved winners, generic/interchangeable lines, a fuzzy or buried situation. Quote the exact weak phrase. Do NOT suggest: adding product features / USPs / sales angles / "what we do" lines; adding numbers, names, customer cases or results the brand context does not contain; filling a [your story: ...] slot; opening on the product or "someone using our X" (the hook must open on the reader's own situation); or shortening/cutting length — a spoken script SHOULD breathe and tell a story, so its length and natural build-up are FEATURES, not filler. If the draft already lands a relatable situation in the brand's voice, reply with exactly: STRONG`;
      critique = await writerCallResilient({ deadlineMs: Math.max(1000, Math.min(100000, _shLeft() - REWRITE_RESERVE_MS)), timeoutMs: 60000, provider: writerProvider(), effort: writerEffort('edit'),
        messages: [{ role: 'system', content: cSys }, { role: 'user', content: cUser }],
        model: 'grok', max_tokens: 1500, engine: (bc.engine || 'grok'),
      }, { providerFromEnv: true, label: 'sharpen-critique', effortRetry: true, room: () => _shLeft() - REWRITE_RESERVE_MS }) || '';
    } catch (e) {
      if (aiUnavailable(e)) throw e;   // v690 — a refused account is not a critique failure: stop here, do not spend a second refused call
      // Degrading to a single-pass rewrite is the CORRECT fallback — but it used to happen in
      // total silence, so a permanently-failing critique pass would quietly turn Sharpen into a
      // one-pass tool forever and still look fine from the outside. Name it in the logs.
      console.error('sharpen: critique pass failed, falling back to single-pass rewrite —', (e && e.message) || e);
      critique = '';
    }

    // Already great → don't burn the second call or risk making it worse.
    if (/^\s*STRONG\b/i.test(critique)) {
      // "Already sharp" is a real (paid) critique: charged, as at HEAD (v709 review #2).
      const logBrandId = await _brandAttr;   // v693 r3 — the access check was started before the AI work
      await require('./_usage').logUsage({ userId: _g.billingUserId || _g.user.id, brandId: logBrandId, action: 'sharpen', model: require('./_write').usageModel(bc) });
      return res.status(200).json({ sharpened: content, unchanged: true });
    }

    // ── THE SPOKEN RULE (v640's bug, one file over) ──────────────────
    // v693 — clarityFlow's compression rules are gone from this prompt (the short style guide
    // replaced them), so the spokenShape override that existed only to counter them went too. What
    // a spoken draft still needs is the SHAPE of speech: complete sentences, joining words, the point
    // said twice. The same-length rule below bounds word COUNT, not sentence COMPLETENESS: a draft
    // can hold its length and still come back as noun phrases with full stops.
    //
    // Applied ONLY to a spoken script, and scoped so it cannot fight the two deliberate rules this
    // handler already has: the hard same-length cap, and the ban on adding product facts.
    const isSpokenDraft = SPOKEN_FORMATS.indexOf(fmt) >= 0;
    const spokenCounterweight = isSpokenDraft
      ? `\nTHE DRAFT IS A SPOKEN SCRIPT. The rule below governs the SHAPE of its sentences only: it does not license making the script longer or shorter, and it never means adding facts, product lines or new material. The same-length rule still holds.\n\n${spokenV2()}\n`
      : '';

    // ── PASS 2 · rewrite against the critique ─────────────────────────
    const rSys = `You are the brand's line EDITOR. You make the SMALLEST changes that fix the critique — polishing, NOT re-pitching and NOT rewriting from scratch. PRESERVE the original's angle, situation, context, relatability AND LENGTH — keep the wording that already works, only fix the weak parts. CRITICAL: Sharpen does NOT mean shorten — the result must be the SAME length as the original (within ~10%); if you cut it to half or a third you have FAILED. For spoken/video scripts keep the natural, conversational, story-like talk-track and every beat; do NOT compress it into terse statements. The hook/opening must open on the READER's situation, feeling or a moment of tension — ${_pt === 'about' ? 'for this about-us post the product may be named, as a story or a lesson, never as a pitch' : 'it must NOT reference the brand, its product, or "someone using our X"'}. NEVER make it salesy, NEVER add product features / USPs / "what our brand does" lines that were not already there, NEVER turn a relatable moment into a product pitch. Same format and structure. No avoid-words, no AI-tell openers. Keep every [your story: ...] slot exactly as written: never fill one with a story you made up, never remove one. Never introduce AI-tell words (delve, leverage, enhance, foster, showcase, elevate, seamless, robust, synergy, vibrant, tapestry, testament) or em dashes.

${styleGuide({ about: _pt === 'about', noSell: !_rules })}
${spokenCounterweight}${_rules ? '\n' + _rules + '\n' : ''}`;
    const rUser = `VOICE & ACCURACY REFERENCE — use ONLY to match the voice and to avoid false claims. This is background; do NOT pull these facts in to sell or explain the product:
${brandInfo || '(limited context — keep it on-voice, invent nothing)'}

THE DRAFT (${kindLabel}${fmt ? ', format: ' + fmt : ''}) — ${styleNote}
${serialized}

WHAT TO FIX (voice / hook / clarity only):
${critique && critique.trim() ? critique.trim() : '(no explicit critique — make only light touch-ups to the hook and voice; keep the situation, the length and everything that already works)'}

Rewrite with the LIGHTEST touch that fixes those points, keeping the original's situation, angle, relatability AND length fully intact — the result must be the SAME length as the original (within ~10%); do NOT shorten, summarize, or compress it, and keep the spoken/story flow. Do NOT add sales or product lines, and do NOT open on the product. Return ONLY a JSON object with EXACTLY these keys and no others: ${JSON.stringify(keys)}. Keep each field the same kind/shape AND roughly the same length as the input (a hook stays a short hook, a script stays a full spoken script, a numbered carousel stays numbered). No prose, no markdown fences.

${rulePrecedence()}`;

    const out = await writerCallResilient({ deadlineMs: Math.max(1000, Math.min(140000, _shLeft())), timeoutMs: 120000, provider: writerProvider(), effort: writerEffort('edit'),
      messages: [{ role: 'system', content: rSys }, { role: 'user', content: rUser }],
      model: 'grok', max_tokens: 4000, engine: (bc.engine || 'grok'),
    }, { providerFromEnv: true, label: 'sharpen-rewrite' });
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
    // no-sell (.unlazy/no-sell) — every sales sentence in the rewrite is taken out; a field the cut would
    // empty keeps the user's ORIGINAL text and is named in noSellKept (never blanked).
    const _ns = guardIdeaNoSell(Object.assign({ format: fmt }, sharpened));
    const noSellKept = _ns.kept.filter(k => keys.indexOf(k) >= 0);
    if (_ns.hits.length) {
      for (const k of keys) sharpened[k] = noSellKept.indexOf(k) >= 0 ? _sent[k] : String(_ns.idea[k]);
    }
    // v709 — THE SHARED GUARD (mode 'single'): a number, name or claim the rewrite added that is in neither
    // the brand's material nor the person's own draft becomes a [your story: ...] slot; a hook or title
    // that invents falls back to the post's first sentence. Nothing usable left = the draft as it was.
    const _gp = _W().guardPost;
    if (typeof _gp === 'function') {
      const _draft = keys.map(k => _sent[k]).join('\n');
      const g = _gp(Object.assign({ format: fmt }, sharpened), bc, { mode: 'single', allowed: _draft });
      // A request that sends no body field (only a hook, say) has no post text to judge "usable" by: that
      // is not a failure. Any other drop puts the draft back as it was. A field the guard would empty keeps
      // the draft's own words.
      const _bodyless = !keys.some(k => k === 'script' || k === 'boldText' || k === 'caption');
      const _usable = g && g.post && (!g.drop || (_bodyless && (g.reasons || []).every(x => x === 'nothing_usable' || !/^sales_only/.test(x))));
      if (_usable) { for (const k of keys) sharpened[k] = (typeof g.post[k] === 'string' && g.post[k].trim()) ? g.post[k] : _sent[k]; }
      else for (const k of keys) sharpened[k] = _sent[k];
    }
    // The caption's Source line goes back as its last line (B F7); then the change check on the whole field.
    for (const k of Object.keys(_tail)) sharpened[k] = (String(sharpened[k] || '').replace(SOURCE_TAIL_RE, '').replace(/\s+$/, '') + '\n\n' + _tail[k]).replace(/^\n+/, '');
    moved = keys.some(k => String(sharpened[k]) !== String(content[k] == null ? '' : content[k]));
    // Fields that were not sent (tags, an oversize field) come back exactly as they were.
    for (const k of Object.keys(content || {})) if (keys.indexOf(k) < 0 && content[k] != null) sharpened[k] = content[k];

    // v666 — SAY SO WHEN NOTHING CHANGED.
    // Every key falls back to the original when the model drops or blanks it, so this loop can
    // return the input BYTE FOR BYTE — and it did so without the `unchanged` flag the early-exit
    // path at the top of this file sets. The client reads that flag (sharpenNow in app.html) and
    // says "Already sharp — nothing to change". Without it the user is told "Sharpened ✨", a
    // taste signal is recorded for a rewrite that never happened, and a paid model call is
    // presented as work done. The flag is the difference between a light-touch editor that is
    // honest about doing nothing and one that pretends.
    if (!moved) {
      // Nothing changed, but two paid calls ran: charged, as at HEAD (v709 review #2).
      const logBrandId0 = await _brandAttr;
      await require('./_usage').logUsage({ userId: _g.billingUserId || _g.user.id, brandId: logBrandId0, action: 'sharpen', model: require('./_write').usageModel(bc) });
      return res.status(200).json(noSellKept.length ? { sharpened, unchanged: true, noSellKept } : { sharpened, unchanged: true });
    }

    // Only attribute the usage row to a brand the caller actually owns — this id comes from the
    // client and went into usage_events unverified. Same pattern as pull-trends.js:
    // a check that cannot run leaves the row unattributed, never unlogged.
    const logBrandId = await _brandAttr;   // v693 r3 — the access check was started before the AI work
    await require('./_usage').logUsage({ userId: _g.billingUserId || _g.user.id, brandId: logBrandId, action: 'sharpen', model: require('./_write').usageModel(bc) });
    return res.status(200).json(noSellKept.length ? { sharpened, noSellKept } : { sharpened });
  } catch (err) {
    const ai = aiUnavailable(err); if (ai) return res.status(ai.status).json(ai.body);   // v690 — a refused AI account (no credits / spending limit) is a 503 with the honest message, not "try again"
    console.error('sharpen error:', err);
    return res.status(500).json({ error: 'Sharpen failed — try again' });
  } finally {
    if (_key) INFLIGHT.delete(_key);
    _settle({ status: 500, body: { error: 'Sharpen failed — try again' } });
  }
};
