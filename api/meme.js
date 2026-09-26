// Meme generator. Per-brand encrypted Gemini key (user-supplied). The LLM writes a
// witty headline + a text-free background prompt in the brand voice; Gemini
// (gemini-2.5-flash-image / "Nano Banana") renders the background. The headline is
// composited over the image CLIENT-SIDE so it stays crisp.
const https = require('https');
const { callLLM, aiUnavailable } = require('./_llm');
const { fullBrandBlock, writingCraft, rulePrecedence, extractJson } = require('./_brain');
const { encrypt, decrypt } = require('./_publish/crypto');
const store = require('./_publish/store');

const ALLOWED = ['https://contentshrimp.com', 'https://bettercontent.app', 'https://boring-engine.vercel.app'];

// v683 — READ THE STATUS. All three key lookups below used to do
//   const enc = ((r.data || [])[0] || {}).gemini_key_enc;
// and treat a missing value as "this brand has no key". store.rest RESOLVES on every HTTP
// status, so a PostgREST 5xx puts an ERROR OBJECT in r.data: [0] is undefined, enc is
// undefined, and the handler asserts the user never saved a key. Measured against a real 503:
// has-key answered 200 {hasKey:false} so the UI re-opened the key-entry form, and both
// generate paths answered "Add your Gemini API key first" to users whose key was stored fine —
// inviting them to re-paste a Google API key to fix a problem that was never theirs. The WRITE
// path 20 lines down already checks its status and its comment calls this "exactly the confusing
// symptom users reported"; only the write side was fixed.
// Returns { enc } on a clean read, or { unknown: true } when we could not read at all.
async function readGeminiKeyEnc(brandId) {
  let r = null;
  try {
    r = await store.rest('GET', `/brands?id=eq.${encodeURIComponent(brandId)}&select=gemini_key_enc`);
  } catch (e) {
    console.error('meme: gemini_key_enc read threw —', (e && e.message) || e);
    return { unknown: true };
  }
  if (!r || r.status < 200 || r.status >= 300 || !Array.isArray(r.data)) {
    console.error('meme: gemini_key_enc read ' + ((r && r.status) || 'no response') + ' — cannot tell whether a key is stored');
    return { unknown: true };
  }
  return { enc: (r.data[0] || {}).gemini_key_enc || null };
}
const KEY_UNREADABLE = 'Could not reach your saved key just now — please try again in a moment.';

/* v692 — ONE CLOCK FOR THE WHOLE REQUEST. generate ran ~7 Supabase reads (up to 8s each), then an
   LLM leg with its own fixed 50s deadline, then a Gemini leg whose `timeout: 50000` is a socket
   IDLE timer — it fires only after 50s of SILENCE, so a reply that keeps trickling bytes never
   trips it and the leg had no total limit at all. Nothing added those waits up: stacked, they ran
   past vercel.json's maxDuration of 120s, Vercel killed the function, the app got Vercel's own
   504 page instead of our JSON, and the credit hold was left to expire by TTL instead of being
   released by our answer. Now a clock starts at handler entry; each leg is given only the time
   that is left, the image leg's limit is TOTAL (not idle), and when too little is left to start
   a leg we answer our own JSON and charge nothing.
   FN_MAX_MS − FN_BUDGET_MS (20s) is kept back for what runs AFTER the work: logUsage's PATCH and
   its fallback INSERT (8s Supabase timeout each) or the hold release, plus writing the answer.
   scripts/verify/meme-clock.mjs runs the real handler against this and checks FN_MAX_MS against
   vercel.json.
   Accepted, not counted: a cold start (module load) happens before the handler runs, so it is
   outside this clock; it is small next to the ~4s of the reserve the post-work writes do not use.
   v692 r2 — the clock is now also read right after checkLimit (before the key read), not only
   before the LLM leg, so a Supabase brownout in the ~8–14 reads up front cannot stack past the
   budget; and the LLM leg keeps imageSlackMs on top of the image floor, so an LLM that finishes
   right at the end of its room still leaves the image enough time — a paid x.ai call is never
   thrown away because the image then could not start.
   RESPONSE CODES (the app reads `code` first; no message below contains "key", "gemini",
   "401" or "unauthor", which app.html's meme handler treats as "your Gemini key is missing"):
     503 OUT_OF_TIME        — too little time left to start a leg          (OUT_OF_TIME)
     504 OUT_OF_TIME        — the image leg hit its total or idle limit    (IMAGE_TOO_SLOW)
     502 IMAGE_FAILED       — the connection failed / broke mid-reply / 5xx (IMAGE_BROKEN)
     502 IMAGE_BUSY         — Google answered 429                          (IMAGE_BUSY)
     502 IMAGE_EMPTY        — a 200 with no image in it                    (IMAGE_EMPTY)
     502 IMAGE_PROVIDER_ERROR — Google answered 400/401/403: Google's own words are passed on on
                              purpose, because a rejected key IS a key problem and the key form
                              is the right answer to it.
   Every one of these is answered before logUsage runs, so the credit hold is released and
   "nothing was charged" is true. */
const FN_MAX_MS = 120000;
const FN_BUDGET_MS = 100000;
// Mutable only so scripts/verify/meme-clock.mjs can run the real handler on a scaled-down clock.
const TIMING = {
  budgetMs: FN_BUDGET_MS,  // entry → end of the image leg
  llmMaxMs: 50000,         // the LLM leg's own ceiling (unchanged from v689)
  llmAttemptMs: 45000,     // one x.ai attempt (unchanged from v689)
  minLlmMs: 10000,         // less than this for the LLM leg → do not start it
  minImageMs: 15000,       // less than this for the image leg → do not start it
  imageSlackMs: 1000,      // r2: extra room the LLM leg leaves on top of minImageMs
};
function startClock() {
  const t0 = Date.now();
  return { left: () => TIMING.budgetMs - (Date.now() - t0) };
}
const OUT_OF_TIME = 'This one ran out of time before it could be finished — nothing was charged. Please try again in a moment.';
const IMAGE_TOO_SLOW = 'The image took too long to generate — nothing was charged. Please try again.';
const IMAGE_BROKEN = "The image didn't come through — nothing was charged. Please try again.";
const IMAGE_BUSY = 'The image service is busy or at its limit right now — nothing was charged. Wait a minute and try again.';
const IMAGE_EMPTY = 'No image came back for this one — nothing was charged. Try again, or try a different topic.';
// v692 r2 — the 502 for a failed image. It used to be 'Image generation failed: ' + whatever the
// socket said, so a transport error could carry words the app reads as "your key is missing".
function imageFailure(img) {
  const st = img.providerStatus;
  if (st === 400 || st === 401 || st === 403) return { error: 'Image generation failed: ' + img.error, code: 'IMAGE_PROVIDER_ERROR' };
  if (st === 429) return { error: IMAGE_BUSY, code: 'IMAGE_BUSY' };
  if (img.empty) return { error: IMAGE_EMPTY, code: 'IMAGE_EMPTY' };
  return { error: IMAGE_BROKEN, code: 'IMAGE_FAILED' };
}

// Accepts either a plain prompt string, or an array of Gemini "parts"
// ([{text}, {inlineData:{mimeType,data}}, ...]) so callers can pass reference
// product photos for the model to match.
function geminiImage(apiKey, promptOrParts, totalMs) {
  return new Promise((resolve_) => {
    // v692 — settle once: the total limit below and the socket events can both fire.
    let settled = false, total = null;
    const resolve = (v) => { if (settled) return; settled = true; if (total) { clearTimeout(total); total = null; } resolve_(v); };
    const parts = Array.isArray(promptOrParts) ? promptOrParts : [{ text: promptOrParts }];
    const body = JSON.stringify({ contents: [{ parts }] });
    const r = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.5-flash-image:generateContent?key=${encodeURIComponent(apiKey)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 50000,
    }, (resp) => {
      let d = '';
      resp.on('data', c => (d += c));
      resp.on('error', e => resolve({ error: (e && e.message) || 'image response failed' }));
      resp.on('end', () => {
        let j = null; try { j = JSON.parse(d); } catch (_) {}
        if (resp.statusCode !== 200) return resolve({ error: (j && j.error && j.error.message) || ('image error ' + resp.statusCode), providerStatus: resp.statusCode });
        const parts = ((((j || {}).candidates || [])[0] || {}).content || {}).parts || [];
        const part = parts.find(p => p.inlineData || p.inline_data);
        const inline = part && (part.inlineData || part.inline_data);
        if (!inline || !inline.data) return resolve({ error: 'No image returned', empty: true });
        resolve({ data: inline.data, mime: inline.mimeType || inline.mime_type || 'image/png' });
      });
    });
    r.on('error', e => resolve({ error: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ error: 'image generation timed out', timedOut: true }); });
    // v692 — the TOTAL limit. `timeout` above is an idle timer: a response that trickles a byte
    // every few seconds never trips it, so this leg could run on until Vercel killed the function.
    if (totalMs > 0) total = setTimeout(() => { total = null; resolve({ error: 'image generation timed out', timedOut: true }); try { r.destroy(); } catch (_) {} }, totalMs);
    r.write(body); r.end();
  });
}

module.exports = async function handler(req, res) {
  const _clock = startClock();   // v692 — the request clock starts before any wait
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', ALLOWED.includes(origin) ? origin : ALLOWED[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!(await require('./_requireUser')(req))) return res.status(401).json({ error: 'Please sign in again.' });

  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;
    const user = await store.getUser(token);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    const { action, brandId } = req.body || {};
    if (!brandId) return res.status(400).json({ error: 'brandId required' });
    /* v679: userCanAccessBrand now THROWS when the check could not be completed (a PostgREST
       5xx or a stalled request), instead of returning a flat false that reads as "denied".
       Still fails closed here — nothing proceeds without a real yes — but the person is told
       the truth rather than being accused of not owning their own brand. */
    let _canUse = false;
    try { _canUse = await store.userCanAccessBrand(user.id, brandId); }
    catch (e) {
      console.error('meme: brand access check could not be completed for user ' + user.id + ': ' + ((e && e.message) || e));
      return res.status(503).json({ error: "Couldn't check your brand access just now — try again in a moment." });
    }
    if (!_canUse) return res.status(403).json({ error: 'No access to this brand' });

    if (action === 'has-key') {
      const k = await readGeminiKeyEnc(brandId);
      // A non-200 here is what memeCheckKey's own else-branch is written for: "Couldn't check
      // your key just now — retry". Answering 200 {hasKey:false} sent it down the wrong branch.
      if (k.unknown) return res.status(503).json({ error: KEY_UNREADABLE });
      return res.status(200).json({ hasKey: !!k.enc });
    }

    if (action === 'save-key') {
      const { geminiKey } = req.body;
      if (!geminiKey || !geminiKey.trim()) return res.status(400).json({ error: 'Enter your Gemini API key.' });
      // OWNERSHIP, not access. The userCanAccessBrand gate above is true for a brand MEMBER
      // too, and the PATCH below goes out on the SERVICE ROLE — which is precisely the case
      // the database trigger exempts. sql/security-fixes-batch2.sql raises "only the brand
      // owner can change this brand's API key" for a non-owner, but skips the check when
      // auth.uid() is null, on the stated reasoning that "no client code ever writes this
      // column — api/meme.js sets it with the service role". This endpoint was the loophole
      // in that reasoning: any team member could overwrite the OWNER's stored Gemini key
      // (the key Google bills) by calling save-key, and the trigger never saw it.
      //
      // Fail closed: if the owner cannot be read, nothing is written. store.rest resolves on
      // EVERY http status (see the note on the PATCH below), so the status must be checked —
      // an unchecked read would make a failed lookup look like "no owner", i.e. deny, which
      // is safe, but a 500 that names itself is far easier to diagnose than a silent 403.
      const ownRes = await store.rest('GET', `/brands?id=eq.${encodeURIComponent(brandId)}&select=user_id`);
      const ownerRow = ((ownRes && ownRes.data) || [])[0];
      if (!ownRes || ownRes.status < 200 || ownRes.status >= 300 || !ownerRow) {
        console.error('meme save-key: could not read brand owner (' + ((ownRes && ownRes.status) || 'no response') +
          ') — refusing to write the key');
        return res.status(500).json({ error: 'Could not save your key — nothing was stored. Try again.' });
      }
      if (ownerRow.user_id !== user.id) {
        console.error('meme save-key: DENIED — user ' + user.id + ' has access to brand ' + brandId +
          ' but does not own it; refusing to overwrite the owner\'s Gemini key');
        return res.status(403).json({ error: 'Only the brand owner can set this brand\'s API key.' });
      }
      const enc = encrypt({ key: geminiKey.trim() });
      const up = await store.rest('PATCH', `/brands?id=eq.${encodeURIComponent(brandId)}`, { body: { gemini_key_enc: enc }, headers: { Prefer: 'return=minimal' } });
      // store.rest RESOLVES on every http status (it only rejects on a socket error), so an
      // unchecked PATCH answered { ok:true } even when the key was never stored — the UI
      // toasted "Gemini key saved ✓" and the very next generate replied "Add your Gemini API
      // key first", which is exactly the confusing symptom users reported. return=minimal
      // means there is no body to inspect — the STATUS is the only evidence.
      if (up.status < 200 || up.status >= 300) {
        console.error('meme save-key FAILED:', up.status, String(up.raw || '').slice(0, 200));
        return res.status(500).json({ error: 'Could not save your key — nothing was stored. Try again.' });
      }
      return res.status(200).json({ ok: true });
    }

    if (action === 'generate') {
      // Billed to the brand OWNER, not to whoever is signed in — an Agency seat's meme comes
      // out of the plan that pays for the brand. billingUserFor re-verifies membership itself
      // (on top of the userCanAccessBrand check above) and falls back to the caller on anything
      // it cannot confirm, so this can never spend a stranger's credits. Own brand → unchanged.
      // Falls back to the caller when the helper is unavailable: metering must never be the
      // reason a generation fails (the rule at the top of _usage.js).
      const _usg = require('./_usage');
      const _billingUser = typeof _usg.billingUserFor === 'function'
        ? await _usg.billingUserFor(user.id, brandId) : user.id;
      const _gate = await require('./_usage').checkLimit(_billingUser, require('./_usage').creditsFor('meme'), 'meme');
      // v678: direct checkLimit caller — attach the release by hand. See _usage.js.
      if (_gate && _gate.ok && _gate.hold) require('./_usage').attachHoldRelease(res, _gate.hold);
      if (!_gate.ok) return require('./_usage').denyResponse(res, _gate);
      // v692 r2 — read the clock right after the reads up front, not only before the LLM leg.
      if (_clock.left() < TIMING.minLlmMs + TIMING.minImageMs + TIMING.imageSlackMs) return res.status(503).json({ error: OUT_OF_TIME, code: 'OUT_OF_TIME' });
      const _k = await readGeminiKeyEnc(brandId);
      // 503, not 400: "try again" is the honest answer to a read we could not make. The credit
      // reserved above is refunded either way — attachHoldRelease releases any hold still
      // pending when the response is written (v683), whatever the status.
      if (_k.unknown) return res.status(503).json({ error: KEY_UNREADABLE });
      const enc = _k.enc;
      if (!enc) return res.status(400).json({ error: 'Add your Gemini API key first (in the Memes tab).' });
      let key;
      try { key = decrypt(enc).key; } catch (e) { return res.status(400).json({ error: 'Stored key is unreadable — re-save it.' }); }

      const bc = req.body.brandContext || {};
      const topic = (req.body.topic || '').toString().slice(0, 400);
      const angle = (req.body.angle || '').toString().slice(0, 60);
      const brandInfo = fullBrandBlock(bc);
      // Anti-repetition for high-volume meme generation: the recent memes the user already made.
      const recentMemes = Array.isArray(req.body.recentMemes) ? req.body.recentMemes.map(m => String(m || '').trim()).filter(Boolean).slice(-12) : [];
      const avoidBlock = recentMemes.length ? `\n\nRECENT MEMES already made for this brand — make THIS one a clearly DIFFERENT joke, angle and topic; never a reworded repeat of any of these:\n${recentMemes.map(m => `- ${m}`).join('\n')}` : '';

      const sys = `You write witty, scroll-stopping memes for a brand. Write ONE short, punchy meme caption in the brand's voice (sarcastic/dry/funny as the voice allows; make it land hard; never use the brand's avoid-words; never invent product facts). Then describe a vivid BACKGROUND IMAGE that fits the joke — photographic or illustrative — that contains NO text, words, letters, logos or captions (the caption is stamped on separately). Leave clean negative space where a caption could sit. Before finalizing, silently check the caption is unmistakably in THIS brand's voice and would actually make its audience laugh — if it reads generic or off-voice, rewrite it.\n\n${writingCraft({ hooks: false, format: 'meme', precedence: false })}`;
      const usr = `BRAND:\n${brandInfo || '(no extra brand context — keep it general and on-voice)'}\n\nTOPIC: ${topic || '(pick something brand-relevant)'}\nANGLE: ${angle || '(pick a funny angle)'}${avoidBlock}\n\nRespond with EXACTLY this JSON and nothing else:\n{"headline":"the meme caption, max 12 words","imagePrompt":"a vivid background scene — NO text/words/letters/logos in the image","caption":"a short social caption for the post"}\n\n${rulePrecedence()}`;

      // v692 — the LLM leg gets min(its own 50s, the time left minus room to start the image).
      const _llmRoom = _clock.left() - TIMING.minImageMs - TIMING.imageSlackMs;
      if (_llmRoom < TIMING.minLlmMs) return res.status(503).json({ error: OUT_OF_TIME, code: 'OUT_OF_TIME' });
      const _llmDeadline = Math.min(TIMING.llmMaxMs, _llmRoom);
      const out = await callLLM({ timeoutMs: Math.min(TIMING.llmAttemptMs, _llmDeadline), deadlineMs: _llmDeadline, messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }], model: 'grok', max_tokens: 600, engine: (bc.engine || 'grok') });   // v689/v692: bounded by the request clock
      const meta = extractJson(out);
      if (!meta) return res.status(502).json({ error: 'Could not write the meme — try again.' });

      const imgPrompt = (meta.imagePrompt || 'a clean, funny background scene') +
        ' . IMPORTANT: no text, no words, no letters, no captions, no logos anywhere in the image. Leave clear negative space for a caption. Square composition.';
      // v692 — the image leg gets exactly the time left, as a TOTAL limit; too little → don't start.
      const _imgMs = _clock.left();
      if (_imgMs < TIMING.minImageMs) return res.status(503).json({ error: OUT_OF_TIME, code: 'OUT_OF_TIME' });
      const img = await geminiImage(key, imgPrompt, _imgMs);
      if (img.timedOut) return res.status(504).json({ error: IMAGE_TOO_SLOW, code: 'OUT_OF_TIME' });
      if (img.error) return res.status(502).json(imageFailure(img));

      await require('./_usage').logUsage({ userId: _billingUser, brandId: brandId, action: 'meme', model: bc.engine || 'grok' });
      return res.status(200).json({
        headline: meta.headline || '',
        caption: meta.caption || '',
        imageBase64: img.data,
        mime: img.mime,
      });
    }

    if (action === 'brandimage') {
      // Render a product/scene image from a ready-made prompt, using the user's own
      // Gemini key (same key as memes). Optional reference product photos are passed
      // through so the model matches the real product.
      // Billed to the brand OWNER, not to whoever is signed in — an Agency seat's meme comes
      // out of the plan that pays for the brand. billingUserFor re-verifies membership itself
      // (on top of the userCanAccessBrand check above) and falls back to the caller on anything
      // it cannot confirm, so this can never spend a stranger's credits. Own brand → unchanged.
      // Falls back to the caller when the helper is unavailable: metering must never be the
      // reason a generation fails (the rule at the top of _usage.js).
      const _usg = require('./_usage');
      const _billingUser = typeof _usg.billingUserFor === 'function'
        ? await _usg.billingUserFor(user.id, brandId) : user.id;
      const _gate = await require('./_usage').checkLimit(_billingUser, require('./_usage').creditsFor('brandimage'), 'brandimage');
      // v678: direct checkLimit caller — attach the release by hand. See _usage.js.
      if (_gate && _gate.ok && _gate.hold) require('./_usage').attachHoldRelease(res, _gate.hold);
      if (!_gate.ok) return require('./_usage').denyResponse(res, _gate);
      // v692 r2 — same early clock read as generate.
      if (_clock.left() < TIMING.minImageMs) return res.status(503).json({ error: OUT_OF_TIME, code: 'OUT_OF_TIME' });
      const _k = await readGeminiKeyEnc(brandId);
      if (_k.unknown) return res.status(503).json({ error: KEY_UNREADABLE });
      const enc = _k.enc;
      if (!enc) return res.status(400).json({ error: 'Add your Gemini API key first.' });
      let key;
      try { key = decrypt(enc).key; } catch (e) { return res.status(400).json({ error: 'Stored key is unreadable — re-save it.' }); }

      const prompt = (req.body.prompt || '').toString().slice(0, 5000);
      if (!prompt.trim()) return res.status(400).json({ error: 'Describe the image first.' });

      const parts = [{ text: prompt }];
      const refs = Array.isArray(req.body.refs) ? req.body.refs.slice(0, 3) : [];
      for (const ref of refs) {
        const m = /^data:([^;]+);base64,(.+)$/.exec(String(ref || ''));
        if (m && m[2].length < 8_000_000) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
      }

      // v692 — same clock for the product image: a total limit of the time left, never idle-only.
      const _imgMs = _clock.left();
      if (_imgMs < TIMING.minImageMs) return res.status(503).json({ error: OUT_OF_TIME, code: 'OUT_OF_TIME' });
      const img = await geminiImage(key, parts, _imgMs);
      if (img.timedOut) return res.status(504).json({ error: IMAGE_TOO_SLOW, code: 'OUT_OF_TIME' });
      if (img.error) return res.status(502).json(imageFailure(img));

      await require('./_usage').logUsage({ userId: _billingUser, brandId: brandId, action: 'brandimage', model: 'gemini-image' });
      return res.status(200).json({ imageBase64: img.data, mime: img.mime });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    // v690 — a refused AI account (out of credits / spending limit) was answered as a generic
    // 500 "Meme failed — try again", which can never work until the account is topped up. Say
    // what it is. The credit reserved above is still pending here (logUsage has not run), so
    // attachHoldRelease gives it back before this answer goes out — the message's "no credits
    // were used" is true (scripts/verify/hold-refund.mjs, AI_UNAVAILABLE arm).
    const ai = aiUnavailable(e);
    if (ai) return res.status(ai.status).json(ai.body);
    console.error('meme error:', e);
    return res.status(500).json({ error: 'Meme failed — try again.' });
  }
};
// v692 — the clock's numbers, exposed for scripts/verify/meme-clock.mjs (see TIMING above).
module.exports._timing = TIMING;
module.exports._FN_MAX_MS = FN_MAX_MS;
