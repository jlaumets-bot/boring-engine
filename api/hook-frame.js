// Hook-Frame Vision (v438) — fetch the COVER/HOOK frame of a TikTok/YouTube video via
// free, keyless sources (TikTok oEmbed / YouTube thumbnail CDN) and have Grok VISION
// describe what is actually IN the frame. The frontend merges the read into the
// Viral Lab / Remix inputs, so both features finally SEE the visual half of the video
// instead of relying only on the transcript + the user's typed description.
//
// BEST-EFFORT BY DESIGN: any failure (no thumb, blocked fetch, vision error) returns
// 200 { read: '' } so the calling flow degrades to exactly the old text-only behavior.
// The credit is only charged AFTER a frame was actually found (no charge for misses).
const https = require('https');
const { callLLM } = require('./_llm');

function fetchUrl(url, opts, hops) {
  opts = opts || {}; hops = hops || 0;
  const maxBytes = opts.maxBytes || 4 * 1024 * 1024;
  const timeout = opts.timeout || 12000;
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch (e) { return reject(new Error('bad url')); }
    if (u.protocol !== 'https:') return reject(new Error('https only'));
    const r = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ContentShrimp/1.0)', 'Accept': '*/*' },
    }, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location && hops < 3) {
        resp.resume();
        let next; try { next = new URL(resp.headers.location, url).href; } catch (e) { return reject(new Error('bad redirect')); }
        return fetchUrl(next, opts, hops + 1).then(resolve, reject);
      }
      if (resp.statusCode !== 200) { resp.resume(); return reject(new Error('status ' + resp.statusCode)); }
      const chunks = []; let size = 0;
      resp.on('data', c => { size += c.length; if (size > maxBytes) { r.destroy(); return reject(new Error('too big')); } chunks.push(c); });
      resp.on('end', () => resolve({ buf: Buffer.concat(chunks), type: resp.headers['content-type'] || '' }));
    });
    r.on('error', reject);
    r.setTimeout(timeout, () => r.destroy(new Error('timed out')));
    r.end();
  });
}

function youtubeId(url) {
  const m = String(url).match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/|live\/))([A-Za-z0-9_-]{6,15})/);
  return m ? m[1] : null;
}

// Resolve the video's cover frame → { buf, type } or null. Free + keyless.
async function resolveThumb(url) {
  if (/youtu\.?be|youtube\.com/i.test(url)) {
    const id = youtubeId(url);
    if (!id) return null;
    for (const q of ['maxresdefault', 'hqdefault']) {
      try {
        const r = await fetchUrl('https://i.ytimg.com/vi/' + id + '/' + q + '.jpg');
        if (r && r.buf && r.buf.length > 2000) return r; // skip tiny gray placeholders
      } catch (e) { /* try next quality */ }
    }
    return null;
  }
  if (/tiktok\.com/i.test(url)) {
    try {
      const o = await fetchUrl('https://www.tiktok.com/oembed?url=' + encodeURIComponent(url));
      const j = JSON.parse(o.buf.toString('utf8'));
      if (j && j.thumbnail_url) {
        const r = await fetchUrl(j.thumbnail_url);
        if (r && r.buf && r.buf.length > 2000) return r;
      }
    } catch (e) { /* fall through */ }
    return null;
  }
  return null; // Instagram/X/etc: no keyless thumbnail — skip gracefully
}

module.exports = async function handler(req, res) {
  const allowed = ['https://contentshrimp.com', 'https://bettercontent.app', 'https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { url } = req.body || {};
    if (!url || !/^https?:\/\//i.test(String(url))) return res.status(200).json({ read: '' });

    // AUTHENTICATE AND GATE BEFORE ANY OUTBOUND REQUEST. resolveThumb() used to run
    // first, so an unauthenticated caller could make us issue up to 4 outbound HTTPS
    // fetches of up to 4MB each. The hosts are fixed (i.ytimg.com / tiktok.com), so it
    // was a bandwidth amplifier rather than a general SSRF — but there is no reason to
    // spend our egress on someone who is not signed in.
    const _g = await require('./_usage').guard(req, 'hookframe');
    if (!_g.user) return res.status(401).json({ error: 'Please sign in again.' });
    if (_g.over) {
      const _r = _g.gate && _g.gate.reason;
      if (_r === 'rate') { res.setHeader('Retry-After', String(_g.gate.retryAfter || 60)); return res.status(429).json({ error: 'rate_limited', retryAfter: _g.gate.retryAfter || 60 }); }
      return res.status(402).json({ error: 'limit_reached', plan: _g.gate.plan, used: _g.gate.used, limit: _g.gate.limit, trialEndsAt: _g.gate.trialEndsAt });
    }

    // Only NOW go and find the frame. The credit is still charged solely on a real read
    // (see the logUsage below) — the gate above checks the allowance, it does not spend it.
    const img = await resolveThumb(String(url).trim());
    if (!img || !img.buf || !img.buf.length) return res.status(200).json({ read: '' });

    const mime = (img.type && img.type.indexOf('image/') === 0) ? img.type.split(';')[0] : 'image/jpeg';
    const read = await callLLM({ timeoutMs: 45000,
      messages: [
        { role: 'system', content: 'You analyze the COVER/HOOK FRAME of a short-form video for a content strategist. Describe ONLY what is visibly in this single frame — never speculate beyond it. Plain tight lines, no markdown headers, no fluff.' },
        { role: 'user', content: 'This is the hook/cover frame of a short-form video. Give a strategist-useful read in 5-9 tight lines:\n- SETTING & SHOT: where it is, how it is framed (selfie / close-up / b-roll / product shot / screen recording)\n- PEOPLE: who is visible, expression, energy, what they are doing\n- ON-SCREEN TEXT: quote it VERBATIM if any (this is often the written hook)\n- VISUAL HOOK: what makes this frame thumb-stopping (face, contrast, odd object, text promise, mid-action moment)\n- STYLE: colors, polish level (raw phone vs produced), any branding visible' }
      ],
      temperature: 0.4,
      max_tokens: 600,
      images: [{ mime, data: img.buf.toString('base64') }]
    }).catch(() => '');

    const out = (read || '').trim();

    // METERING: guard() above only CHECKS the limit — it never writes a usage row, so this
    // action was never recorded and was effectively unlimited on every plan. Logged only when
    // the vision call actually produced a read, which preserves this endpoint's stated rule
    // that the credit is charged for real work, never for a miss (no thumb / vision failure).
    // NO BRAND ATTRIBUTION — and that is now said out loud. This used to read
    // `req.body.brandId` and verify it with store.userCanAccessBrand, which reads like the
    // sibling generators' attribution block but is dead code here: the one and only caller
    // (fetchHookFrame in app.html) posts `{url}` and nothing else, and unlike its siblings this
    // endpoint takes no brandContext to derive an id from. So `_bid` was always null, the
    // access check never ran, and the row was always written with brand_id: null anyway.
    // Rather than keep a lookup that pretends to attribute, write the honestly user-scoped row.
    // If a caller is ever given a brand to name, re-add the sibling block — verified, not trusted.
    if (out) {
      try {
        await require('./_usage').logUsage({ userId: _g.billingUserId || _g.user.id, action: 'hookframe', model: 'grok' });
      } catch (e) { console.log('hook-frame: usage log failed — ' + (e && e.message)); }
    }

    return res.status(200).json({ read: out });
  } catch (e) {
    return res.status(200).json({ read: '' }); // enhancement layer: never break the caller
  }
};
