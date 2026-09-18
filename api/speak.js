const https = require('https');

module.exports = async function handler(req, res) {
  const allowed = ['https://contentshrimp.com','https://bettercontent.app','https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const _g = await require('./_usage').guard(req, 'speak');
  if (!_g.user) return res.status(401).json({ error: 'Please sign in again.' });
  if (_g.over) return require('./_usage').denyResponse(res, _g.gate);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'No OpenAI API key configured' });

  try {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ error: 'No text provided' });

    // Truncate to ~4000 chars to keep costs reasonable
    const trimmed = text.length > 4000 ? text.slice(0, 4000) : text;

    // Newest, most natural OpenAI TTS. gpt-4o-mini-tts is "steerable" (you can direct
    // HOW it speaks via `instructions`). All three are env-overridable so the model/voice/
    // tone can change with no redeploy — just set OPENAI_TTS_MODEL / _VOICE / _INSTRUCTIONS.
    const model = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
    const voice = req.body.voice || process.env.OPENAI_TTS_VOICE || 'nova';
    const instructions = process.env.OPENAI_TTS_INSTRUCTIONS || '';
    const payloadObj = { model, input: trimmed, voice, response_format: 'mp3' };
    // Only the gpt-4o/gpt-5 style models accept `instructions`; older tts-1 ignores it.
    if (instructions && /gpt-/i.test(model)) payloadObj.instructions = instructions;
    const payload = JSON.stringify(payloadObj);

    const audioChunks = await new Promise((resolve, reject) => {
      const r = https.request({
        hostname: 'api.openai.com',
        path: '/v1/audio/speech',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      }, (resp) => {
        if (resp.statusCode !== 200) {
          let errData = '';
          resp.on('data', chunk => errData += chunk);
          resp.on('end', () => {
            try { reject(new Error(JSON.parse(errData).error?.message || `TTS error ${resp.statusCode}`)); }
            catch (e) { reject(new Error(`TTS error ${resp.statusCode}`)); }
          });
          return;
        }
        const chunks = [];
        resp.on('data', chunk => chunks.push(chunk));
        resp.on('end', () => resolve(Buffer.concat(chunks)));
      });
      r.on('error', reject);
      // The only https.request in api/ without a socket timeout: when OpenAI accepted the socket
      // and then went quiet this promise never settled, the function was killed by the platform at
      // maxDuration 30, and the caller got a bare 504 with no JSON and no usage row. 25s leaves the
      // handler room to turn this rejection into a real error response inside the 30s cap.
      r.setTimeout(25000, () => { r.destroy(new Error('The voice service took too long — please try again.')); });
      r.write(payload);
      r.end();
    });

    // Return audio as base64
    const base64 = audioChunks.toString('base64');
    await require('./_usage').logUsage({ userId: _g.billingUserId || _g.user.id, action: 'speak' });
    return res.status(200).json({ audio: base64, format: 'mp3' });

  } catch (err) {
    console.error('TTS error:', err);
    return res.status(500).json({ error: err.message });
  }
};
