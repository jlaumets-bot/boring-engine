const https = require('https');
const { Buffer } = require('buffer');

// ── multipart header hygiene ───────────────────────────────────────────────────
// `filename` and `mimeType` arrive as JSON body strings and land inside multipart
// part HEADERS. A JSON string can contain \r\n, which would close the current part
// and let the caller append extra form fields to the Whisper request (e.g. override
// `model`). Nothing cross-user leaks — it is our own key and our own request — but
// this is unvalidated input crossing a protocol boundary, so it gets filtered at the
// boundary. Same approach as transcribe-url.js, which hardcodes both values.
const ALLOWED_MIME = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac',
  'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/ogg', 'audio/flac', 'audio/opus',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/mpeg', 'application/octet-stream'
]);

// Extension reduced to [a-z0-9] — a \r, \n, " or ; simply cannot survive.
function safeExt(filename) {
  const raw = String(filename == null ? '' : filename);
  const dot = raw.lastIndexOf('.');
  const tail = dot >= 0 ? raw.slice(dot + 1) : raw;
  // Take only the leading run of [a-z0-9] — stop at the first character that has no
  // business in an extension (which is every character an injection would need).
  const m = tail.toLowerCase().match(/^[a-z0-9]{1,8}/);
  return (m && m[0]) || 'mp4';
}

// Content-Type must be on the whitelist; anything else falls back to a derived
// audio/<ext> when that is itself allowed, else application/octet-stream.
function safeMime(mimeType, ext) {
  const m = String(mimeType == null ? '' : mimeType).trim().toLowerCase();
  if (ALLOWED_MIME.has(m)) return m;
  const derived = 'audio/' + safeExt(ext);
  return ALLOWED_MIME.has(derived) ? derived : 'application/octet-stream';
}

// Extracted so the header construction can be tested directly with hostile input.
function buildWhisperMultipart(boundary, model, fname, mime, audioBuffer) {
  const parts = [];
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\ntext\r\n`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fname}"\r\nContent-Type: ${mime}\r\n\r\n`);
  parts.push(audioBuffer);
  parts.push('\r\n');
  parts.push(`--${boundary}--\r\n`);
  return Buffer.concat(parts.map(pp => typeof pp === 'string' ? Buffer.from(pp) : pp));
}

const handler = async function (req, res) {
  const allowed = ['https://contentshrimp.com','https://bettercontent.app','https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const _g = await require('./_usage').guard(req, 'transcribe');
  if (!_g.user) return res.status(401).json({ error: 'Please sign in again.' });
  if (_g.over) return res.status(402).json({ error: 'limit_reached', plan: _g.gate.plan, used: _g.gate.used, limit: _g.gate.limit, trialEndsAt: _g.gate.trialEndsAt });

  try {
    const { audio, filename, mimeType, url, mode } = req.body;

    // --- YouTube caption extraction mode ---
    if (mode === 'youtube' || (url && !audio)) {
      if (!url) return res.status(400).json({ error: 'Missing YouTube URL' });
      const idMatch = url.match(/(?:v=|youtu\.be\/|\/embed\/|\/v\/|\/shorts\/)([a-zA-Z0-9_-]{11})/);
      if (!idMatch) return res.status(400).json({ error: 'Invalid YouTube URL' });
      const videoId = idMatch[1];
      // Primary: YouTube innertube API (ANDROID client) — survives bot walls that block HTML scraping
      let trackUrl = null;
      try {
        const ply = await fetch('https://www.youtube.com/youtubei/v1/player', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'com.google.android.youtube/19.09.37 (Linux; U; Android 11) gzip'
          },
          body: JSON.stringify({
            context: { client: { clientName: 'ANDROID', clientVersion: '19.09.37', androidSdkVersion: 30, hl: 'en' } },
            videoId
          })
        });
        const pj = await ply.json();
        const tracks = (pj && pj.captions && pj.captions.playerCaptionsTracklistRenderer && pj.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
        if (tracks.length > 0) {
          const en = tracks.find(t => (t.languageCode || '').startsWith('en')) || tracks[0];
          trackUrl = en.baseUrl;
        }
      } catch (e) { /* fall through to HTML scrape */ }

      // Fallback: scrape watch page HTML
      if (!trackUrl) {
        const captionUrl = `https://www.youtube.com/watch?v=${videoId}`;
        const pageHtml = await new Promise((resolve, reject) => {
          const rq = https.get(captionUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }, (resp) => {
            let data = '';
            resp.on('data', chunk => data += chunk);
            resp.on('end', () => resolve(data));
          });
          rq.on('error', reject);
          rq.on('timeout', () => { rq.destroy(new Error('timeout')); });
        });
        const captionMatch = pageHtml.match(/"captionTracks":\[.*?"baseUrl":"(.*?)"/);
        if (captionMatch) trackUrl = captionMatch[1].replace(/\\u0026/g, '&');
      }
      if (!trackUrl) {
        return res.status(400).json({ error: 'No captions found for this video. Try a video with subtitles enabled.' });
      }
      // SSRF defense-in-depth: the caption URL comes from YouTube's own data, but
      // guard it anyway before fetching, and time-box the request.
      try { await require('./_safeurl').assertPublicHttpUrl(trackUrl); }
      catch (e) { return res.status(400).json({ error: 'No captions found for this video. Try a video with subtitles enabled.' }); }
      const captionXml = await new Promise((resolve, reject) => {
        const rq = https.get(trackUrl, { timeout: 15000 }, (resp) => {
          let data = '';
          resp.on('data', chunk => data += chunk);
          resp.on('end', () => resolve(data));
        });
        rq.on('error', reject);
        rq.on('timeout', () => { rq.destroy(new Error('timeout')); });
      });
      const textParts = [];
      const textMatches = captionXml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g);
      for (const match of textMatches) {
        let text = match[1]
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n/g, ' ').trim();
        if (text) textParts.push(text);
      }
      if (textParts.length === 0) {
        return res.status(400).json({ error: 'Could not parse captions from video.' });
      }
      const fullText = textParts.join(' ');
      await require('./_usage').logUsage({ userId: _g.user.id, action: 'transcribe' });
      return res.status(200).json({ text: fullText, wordCount: fullText.split(/\s+/).length });
    }

    // --- Whisper audio transcription mode ---
    // Groq Whisper (whisper-large-v3) ONLY — OpenAI is used nowhere except /api/speak TTS.
    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) return res.status(500).json({ error: 'Transcription is temporarily unavailable.' });

    // Two ways in: small files arrive inline as base64; BIG files can't — Vercel
    // hard-caps serverless request bodies at ~4.5MB (the bodyParser '25mb' config
    // below is Next.js-only and never applied here), so the client uploads them to
    // the private Supabase Storage bucket `transcribe-tmp` and sends storagePath.
    // The path MUST live in the caller's own folder (<userId>/...) so nobody can
    // transcribe (or delete) another user's upload.
    const storagePath = (req.body.storagePath || '').toString();
    let audioBuffer = null;
    if (storagePath) {
      if (!/^[A-Za-z0-9_\-./]+$/.test(storagePath) || storagePath.includes('..') || !storagePath.startsWith(_g.user.id + '/')) {
        return res.status(400).json({ error: 'Bad upload reference.' });
      }
      const base = process.env.SUPABASE_URL, svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!base || !svcKey) return res.status(500).json({ error: 'Transcription is temporarily unavailable.' });
      const u = new URL(base);
      const objPath = '/storage/v1/object/transcribe-tmp/' + storagePath.split('/').map(encodeURIComponent).join('/');
      audioBuffer = await new Promise((resolve, reject) => {
        const rq = https.request({
          hostname: u.hostname, path: objPath, method: 'GET',
          headers: { 'Authorization': 'Bearer ' + svcKey, 'apikey': svcKey }
        }, (resp) => {
          if (resp.statusCode !== 200) { resp.resume(); return reject(new Error('upload fetch ' + resp.statusCode)); }
          const chunks = []; let size = 0;
          resp.on('data', c => { size += c.length; if (size > 25 * 1024 * 1024) return reject(new Error('file too large')); chunks.push(c); });
          resp.on('end', () => resolve(Buffer.concat(chunks)));
        });
        rq.on('error', reject);
        rq.setTimeout(30000, () => rq.destroy(new Error('upload fetch timeout')));
        rq.end();
      }).catch(e => { console.error('storage fetch failed:', e.message); return null; });
      if (!audioBuffer || !audioBuffer.length) return res.status(400).json({ error: "Couldn't read the uploaded file — please try again." });
      // Best-effort cleanup — the tmp upload is single-use (buffer is already in memory).
      try {
        const del = https.request({ hostname: u.hostname, path: objPath, method: 'DELETE', headers: { 'Authorization': 'Bearer ' + svcKey, 'apikey': svcKey } });
        del.on('error', () => {}); del.end();
      } catch (e) {}
    } else {
      if (!audio) {
        return res.status(400).json({ error: 'Missing audio data' });
      }
      audioBuffer = Buffer.from(audio, 'base64');
    }
    // Both values are attacker-controllable and go into multipart headers — filter them.
    const ext = safeExt(filename || 'audio.mp4');
    const fname = `upload.${ext}`;
    const mime = safeMime(mimeType, ext);

    const providers = [{ host: 'api.groq.com', path: '/openai/v1/audio/transcriptions', key: groqKey, model: 'whisper-large-v3' }];

    let transcript = null, lastErr = '';
    for (const p of providers) {
      const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
      const bodyBuffer = buildWhisperMultipart(boundary, p.model, fname, mime, audioBuffer);
      try {
        const response = await new Promise((resolve, reject) => {
          const request = https.request({
            hostname: p.host,
            path: p.path,
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${p.key}`,
              'Content-Type': `multipart/form-data; boundary=${boundary}`,
              'Content-Length': bodyBuffer.length
            }
          }, (resp) => {
            let data = '';
            resp.on('data', chunk => data += chunk);
            resp.on('end', () => resolve({ status: resp.statusCode, body: data }));
          });
          request.on('error', reject);
          request.setTimeout(50000, () => request.destroy(new Error('Transcription timed out')));
          request.write(bodyBuffer);
          request.end();
        });
        if (response.status === 200 && response.body && response.body.trim()) { transcript = response.body.trim(); break; }
        try { lastErr = JSON.parse(response.body).error.message; } catch (e) { lastErr = 'transcription error ' + response.status; }
        console.log(p.host + ' transcription failed:', lastErr);
      } catch (e) { lastErr = e.message; }
    }
    if (transcript == null) return res.status(502).json({ error: lastErr || "Couldn't transcribe that — please try again." });

    await require('./_usage').logUsage({ userId: _g.user.id, action: 'transcribe' });
    return res.status(200).json({ transcript });

  } catch (err) {
    console.error('Transcribe error:', err);
    return res.status(500).json({ error: "Couldn't transcribe that — please try again." });
  }
};

module.exports = handler;
// NOTE: this config line is Next.js-style and does NOT lift Vercel's ~4.5MB
// serverless body cap (it never did). Large uploads go through Supabase Storage
// via storagePath above — do not raise this expecting bigger inline bodies.
module.exports.config = { api: { bodyParser: { sizeLimit: '25mb' } } };
