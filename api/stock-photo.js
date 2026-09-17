// Stock photo for the split-screen graphics half — searches Pexels for the beat's
// imageQuery and streams the picked photo's BYTES back same-origin. Streaming the
// bytes (instead of returning a pexels.com URL) is the whole point: a cross-origin
// image would TAINT the canvas and silently kill captureStream → the render would
// die. Same-origin bytes keep the canvas clean.
//
// Needs PEXELS_API_KEY in the env (free key, pexels.com/api — 200 req/h, 20k/mo).
// Without it, returns 200 {empty:true} so the renderer just skips photos.
const { guard, logUsage } = require('./_usage');

const PICK_SIZE = 'large2x'; // ~1880px wide — the render is 1080p now (v533); falls back to large

// v564: relevance scoring — how well a photo's OWN description (Pexels `alt`) matches
// the beat's words. Lets us pick the on-topic photo instead of blindly the first result.
const STOP = new Set('the a an and or of to in on for with your you our it its this that these those is are was be as at by from into over under about how why what when who not no more most best just only really very can will'.split(' '));
function tokns(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(w => w.length >= 3 && !STOP.has(w)); }

module.exports = async function handler(req, res) {
  const allowed = ['https://contentshrimp.com','https://bettercontent.app','https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Auth — this proxy spends OUR Pexels quota, so it is not open.
  const _g = await guard(req, 'stockphoto');
  if (!_g.user) return res.status(401).json({ error: 'Please sign in again.' });

  // ENFORCE THE GATE WE ALREADY PAID FOR. guard() only CHECKS the allowance; its `over`
  // result was computed here and then thrown away, and no usage row was ever written — so
  // `used` stayed 0 forever and the gate could not have fired even if it had been read.
  // Any signed-in account could drain the Pexels quota without bound. This branch plus the
  // logUsage further down are the two halves of the fix; either alone does nothing.
  // Shape copied from hook-frame.js.
  if (_g.over) {
    const _r = _g.gate && _g.gate.reason;
    // 429 rather than 402 on a BURST trip: this endpoint fires ~6 at a time per video
    // render, making it the most burst-prone call in the app, and app.html's global fetch
    // wrapper opens the upgrade modal on any /api/ 402 — so a rate trip must not tell a
    // user with plenty of allowance left that they are out of posts.
    if (_r === 'rate') { res.setHeader('Retry-After', String(_g.gate.retryAfter || 60)); return res.status(429).json({ error: 'rate_limited', retryAfter: _g.gate.retryAfter || 60 }); }
    return res.status(402).json({ error: 'limit_reached', plan: _g.gate.plan, used: _g.gate.used, limit: _g.gate.limit, trialEndsAt: _g.gate.trialEndsAt });
  }

  // one Pexels search → best usable photo, or null. Kept small so we can try
  // several query variants (broaden-and-retry) without blowing the time budget.
  // v668 — the last transport failure this request saw, so the caller can tell a search that
  // FAILED from a search that legitimately found nothing. Both used to answer {empty:true}.
  let _pexelsFail = null;
  async function pexelsPick(key, query, intent){
    try {
      const sr = await fetch('https://api.pexels.com/v1/search?per_page=15&orientation=landscape&query=' + encodeURIComponent(query), {
        headers: { Authorization: key },
        signal: AbortSignal.timeout(8000)
      });
      if (!sr.ok) {
        // v668 — SAY SOMETHING. This was a bare `return null`, so a revoked key (401) or an
        // exhausted quota (the free tier is 200 requests an HOUR, and one split-screen render can
        // ask for several photos) was indistinguishable from "no good photo for this beat" — with
        // nothing in the runtime logs and nothing in /api/health, which only checks that a key
        // EXISTS. The beat rendered text-only forever and nobody ever found out why.
        _pexelsFail = 'http_' + sr.status;
        console.error('stock-photo: pexels ' + sr.status + ' for ' + JSON.stringify(query) +
          (sr.status === 401 ? ' — the key is rejected' : sr.status === 429 ? ' — rate limited (free tier is 200/hour)' : ''));
        return null;
      }
      const data = await sr.json();
      const photos = (data && Array.isArray(data.photos)) ? data.photos : [];
      // pick the candidate whose OWN description best matches the beat's words;
      // Pexels' own ranking (index i) is only the tiebreak. intent=[] -> first result.
      let best = null, bestScore = -1e9;
      photos.forEach((photo, i) => {
        const src = photo && photo.src && (photo.src[PICK_SIZE] || photo.src.large || photo.src.medium || photo.src.original);
        if (!src || !/^https:\/\/images\.pexels\.com\//.test(src)) return;
        const alt = new Set(tokns(photo.alt));
        let overlap = 0; for (const w of intent) if (alt.has(w)) overlap++;
        const score = overlap * 10 - i;                 // description match dominates; rank breaks ties
        if (score > bestScore) { bestScore = score; best = { src, by: (photo && photo.photographer) || 'Pexels' }; }
      });
      return best;
    } catch(e) {
      _pexelsFail = (e && e.name === 'TimeoutError') ? 'timeout' : 'network';
      console.error('stock-photo: pexels search failed for ' + JSON.stringify(query) + ' — ' + (e && (e.name + ': ' + e.message)));
      return null;
    }
  }

  try {
    const key = process.env.PEXELS_API_KEY;
    const q = String((req.query && req.query.q) || '').slice(0, 60).trim();
    const t = String((req.query && req.query.t) || '').slice(0, 120);   // v564: the beat's headline, for relevance scoring
    const intent = Array.from(new Set(tokns(q).concat(tokns(t))));
    if (!key || !q) return res.status(200).json({ empty: true });

    // broaden-and-retry: exact phrase → first 2 words → first word. A compound or
    // adjective-heavy query ("unvetted suppliers") often returns 0; a broader
    // term ("suppliers") still lands an on-topic photo instead of a blank panel.
    const words = q.split(/\s+/).filter(Boolean);
    const variants = [q];
    if (words.length > 3) variants.push(words.slice(0, 3).join(' '));
    if (words.length > 2) variants.push(words.slice(0, 2).join(' '));
    // v564: NEVER collapse to a single keyword — a 1-word search returns generic
    // stock that isn't on-point. Floor at a 2-word phrase; if even that finds
    // nothing, return empty (text-only beat) rather than a generic photo.
    const seen = new Set();
    let hit = null;
    for (const vq of variants) {
      if (!vq || seen.has(vq)) continue; seen.add(vq);
      hit = await pexelsPick(key, vq, intent);
      if (hit) break;
    }
    // Still 200 + empty so the beat renders text-only rather than breaking the render — but the
    // REASON travels, so a caller (and a human reading the logs) can tell a working search that
    // found nothing from a search that never happened.
    if (!hit) return res.status(200).json({ empty: true, reason: _pexelsFail || 'no_match' });

    // stream the bytes through (size-capped)
    const ir = await fetch(hit.src, { signal: AbortSignal.timeout(14000) });
    if (!ir.ok) {
      console.error('stock-photo: pexels image fetch ' + ir.status + ' for ' + hit.src);
      return res.status(200).json({ empty: true, reason: 'image_http_' + ir.status });
    }
    const buf = Buffer.from(await ir.arrayBuffer());
    if (!buf.length || buf.length > 4 * 1024 * 1024) {
      console.error('stock-photo: pexels image unusable (' + buf.length + ' bytes) for ' + hit.src);
      return res.status(200).json({ empty: true, reason: 'image_size' });
    }

    // METER IT — the other half of the gate above. Without this, `used` never moves and the
    // limit can never be reached. Logged only once we hold a real photo, so a miss
    // ({empty:true}) is free — same "charge for real work, never for a miss" rule as
    // hook-frame.js. Placed BEFORE any header or body write so it can never interleave with
    // the byte stream, and awaited rather than fire-and-forget because work started after the
    // response can be frozen by the platform and simply lost. logUsage already swallows its
    // own errors; the try/catch is belt-and-braces so a metering hiccup can never cost the
    // user their photo. (No brandId: the caller sends only ?q= and ?t=, so there is none to
    // verify — same as transcribe-voice.js.)
    try {
      await logUsage({ userId: _g.billingUserId || _g.user.id, action: 'stockphoto', model: 'pexels' });
    } catch (e) { console.error('stock-photo: usage log failed — ' + (e && e.message)); }

    res.setHeader('Content-Type', ir.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');   // same query → same photo for a day
    res.setHeader('X-Photo-By', encodeURIComponent(String(hit.by || 'Pexels')));
    return res.status(200).send(buf);
  } catch (e) {
    // best-effort by design: a photo hiccup must never break a render
    return res.status(200).json({ empty: true });
  }
};
