// Meme generator. Per-brand encrypted Gemini key (user-supplied). The LLM writes a
// witty headline + a text-free background prompt in the brand voice; Gemini
// (gemini-2.5-flash-image / "Nano Banana") renders the background. The headline is
// composited over the image CLIENT-SIDE so it stays crisp.
const https = require('https');
const { callLLM } = require('./_llm');
const { fullBrandBlock, writingCraft, rulePrecedence, extractJson } = require('./_brain');
const { encrypt, decrypt } = require('./_publish/crypto');
const store = require('./_publish/store');

const ALLOWED = ['https://contentshrimp.com', 'https://bettercontent.app', 'https://boring-engine.vercel.app'];

// Accepts either a plain prompt string, or an array of Gemini "parts"
// ([{text}, {inlineData:{mimeType,data}}, ...]) so callers can pass reference
// product photos for the model to match.
function geminiImage(apiKey, promptOrParts) {
  return new Promise((resolve) => {
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
      resp.on('end', () => {
        let j = null; try { j = JSON.parse(d); } catch (_) {}
        if (resp.statusCode !== 200) return resolve({ error: (j && j.error && j.error.message) || ('image error ' + resp.statusCode) });
        const parts = ((((j || {}).candidates || [])[0] || {}).content || {}).parts || [];
        const part = parts.find(p => p.inlineData || p.inline_data);
        const inline = part && (part.inlineData || part.inline_data);
        if (!inline || !inline.data) return resolve({ error: 'No image returned' });
        resolve({ data: inline.data, mime: inline.mimeType || inline.mime_type || 'image/png' });
      });
    });
    r.on('error', e => resolve({ error: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ error: 'image generation timed out' }); });
    r.write(body); r.end();
  });
}

module.exports = async function handler(req, res) {
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
    if (!(await store.userCanAccessBrand(user.id, brandId))) return res.status(403).json({ error: 'No access to this brand' });

    if (action === 'has-key') {
      const r = await store.rest('GET', `/brands?id=eq.${encodeURIComponent(brandId)}&select=gemini_key_enc`);
      return res.status(200).json({ hasKey: !!(((r.data || [])[0] || {}).gemini_key_enc) });
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
      if (!_gate.ok) return res.status(402).json({ error: _gate.reason === 'feature' ? 'feature_locked' : 'limit_reached', feature: _gate.feature || undefined, plan: _gate.plan, used: _gate.used, limit: _gate.limit, trialEndsAt: _gate.trialEndsAt });
      const r = await store.rest('GET', `/brands?id=eq.${encodeURIComponent(brandId)}&select=gemini_key_enc`);
      const enc = ((r.data || [])[0] || {}).gemini_key_enc;
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

      const out = await callLLM({ timeoutMs: 45000, messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }], model: 'grok', max_tokens: 600, engine: (bc.engine || 'grok') });
      const meta = extractJson(out);
      if (!meta) return res.status(502).json({ error: 'Could not write the meme — try again.' });

      const imgPrompt = (meta.imagePrompt || 'a clean, funny background scene') +
        ' . IMPORTANT: no text, no words, no letters, no captions, no logos anywhere in the image. Leave clear negative space for a caption. Square composition.';
      const img = await geminiImage(key, imgPrompt);
      if (img.error) return res.status(502).json({ error: 'Image generation failed: ' + img.error });

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
      if (!_gate.ok) return res.status(402).json({ error: _gate.reason === 'feature' ? 'feature_locked' : 'limit_reached', feature: _gate.feature || undefined, plan: _gate.plan, used: _gate.used, limit: _gate.limit, trialEndsAt: _gate.trialEndsAt });
      const r = await store.rest('GET', `/brands?id=eq.${encodeURIComponent(brandId)}&select=gemini_key_enc`);
      const enc = ((r.data || [])[0] || {}).gemini_key_enc;
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

      const img = await geminiImage(key, parts);
      if (img.error) return res.status(502).json({ error: 'Image generation failed: ' + img.error });

      await require('./_usage').logUsage({ userId: _billingUser, brandId: brandId, action: 'brandimage', model: 'gemini-image' });
      return res.status(200).json({ imageBase64: img.data, mime: img.mime });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('meme error:', e);
    return res.status(500).json({ error: 'Meme failed — try again.' });
  }
};
