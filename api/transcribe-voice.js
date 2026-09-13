const https = require('https');

// ── multipart header hygiene ───────────────────────────────────────────────────
// `format` (→ the part's filename) and `language` (→ a form field body) come from
// the JSON request body, and a JSON string can contain \r\n. Unfiltered, either one
// could close its multipart part and inject extra fields into the Whisper request
// (e.g. override `model`). Impact is bounded — our key, our request, no cross-user
// data — but it is unvalidated input crossing a protocol boundary, so both are
// whitelisted here rather than interpolated raw.
const VOICE_FORMATS = {
  webm: 'audio/webm', mp4: 'audio/mp4', m4a: 'audio/mp4', ogg: 'audio/ogg',
  oga: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac'
};
function safeVoiceFormat(format) {
  const f = String(format == null ? '' : format).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(VOICE_FORMATS, f) ? f : 'webm';
}
// Whisper wants an ISO-639-1 code ("en", optionally "en-us"). Anything else → 'en'.
function safeLanguage(language) {
  const l = String(language == null ? '' : language).trim().toLowerCase();
  return /^[a-z]{2}(-[a-z]{2})?$/.test(l) ? l : 'en';
}

// Extracted so the header construction can be tested directly with hostile input.
function buildVoiceMultipart(boundary, model, filename, mimeType, language, audioBuffer) {
  const parts = [];
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`);
  if (language) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}\r\n`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
  parts.push(audioBuffer);
  parts.push(`\r\n--${boundary}--\r\n`);
  return Buffer.concat(parts.map(p => typeof p === 'string' ? Buffer.from(p) : p));
}

// Voice → text for the assistant mic + every "Dictate" button in the app.
// Groq Whisper (whisper-large-v3) ONLY. Dictation runs on the app's GROQ key;
// OpenAI is used nowhere in the app except the spoken-reply TTS in /api/speak.
module.exports = async function handler(req, res) {
  const allowed = ['https://contentshrimp.com','https://bettercontent.app','https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const _g = await require('./_usage').guard(req, 'transcribevoice');
  if (!_g.user) return res.status(401).json({ error: 'Please sign in again.' });
  if (_g.over) return res.status(402).json({ error: 'limit_reached', plan: _g.gate.plan, used: _g.gate.used, limit: _g.gate.limit, trialEndsAt: _g.gate.trialEndsAt });

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return res.status(500).json({ error: 'Transcription is not configured on the server.' });

  try {
    const { audio, format = 'webm', language = 'en' } = req.body;
    if (!audio) return res.status(400).json({ error: 'No audio data provided' });

    const audioBuffer = Buffer.from(audio, 'base64');
    // Both land in multipart headers/fields — whitelist before interpolating.
    const fmt = safeVoiceFormat(format);
    const lang = safeLanguage(language);
    const filename = `audio.${fmt}`;
    const mimeType = VOICE_FORMATS[fmt];

    // Groq ONLY — OpenAI is used nowhere in the app except the spoken-reply TTS (/api/speak).
    const providers = [{ host: 'api.groq.com', path: '/openai/v1/audio/transcriptions', key: groqKey, model: 'whisper-large-v3' }];

    let text = null, lastErr = '';
    for (const p of providers) {
      try {
        const r = await whisperTranscribe(p, audioBuffer, filename, mimeType, lang);
        if (r.status === 200 && r.text && r.text.trim()) { text = r.text.trim(); break; }
        lastErr = r.error || ('transcription error ' + r.status);
        console.log(p.host + ' voice transcription failed:', lastErr);
      } catch (e) { lastErr = e.message; }
    }
    if (text == null) return res.status(502).json({ error: lastErr || "Couldn't transcribe your voice — please try again." });

    await require('./_usage').logUsage({ userId: _g.user.id, action: 'transcribevoice' });
    return res.status(200).json({ text });

  } catch (err) {
    console.error('Transcribe error:', err);
    return res.status(500).json({ error: "Couldn't transcribe your voice — please try again." });
  }
};

function whisperTranscribe(provider, audioBuffer, filename, mimeType, language) {
  return new Promise((resolve, reject) => {
    const boundary = '----WhisperBoundary' + Math.random().toString(36).slice(2);
    const body = buildVoiceMultipart(boundary, provider.model, filename, mimeType, language, audioBuffer);

    const r = https.request({
      hostname: provider.host,
      path: provider.path,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + provider.key,
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length,
      },
    }, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        let text = '', error = '';
        try { const j = JSON.parse(data); text = j.text || ''; error = j.error && j.error.message; }
        catch (e) { error = 'bad transcription response'; }
        resolve({ status: resp.statusCode, text, error });
      });
    });
    r.on('error', reject);
    r.setTimeout(50000, () => r.destroy(new Error('Transcription timed out')));
    r.write(body);
    r.end();
  });
}
