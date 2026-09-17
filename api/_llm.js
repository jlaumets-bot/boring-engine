const https = require('https');

/**
 * Shared LLM helper — PURE GROK (xAI). NO fallback of any kind. If xAI is down / out of
 * credits the call throws and the caller shows a retry message. (No Groq/Llama, no OpenAI,
 * no Claude.) The only non-Grok AI left in the whole app is the TTS spoken-reply in
 * /api/speak (OpenAI) and image generation in /api/meme (the user's OWN Gemini key).
 *
 * `model`/`engine` opts are still accepted (call sites pass model:'grok' etc.) but
 * IGNORED — the model is always Grok. Bump it with the XAI_MODEL env var
 * (default grok-4.6) — no redeploy needed.
 *
 * Env: XAI_API_KEY (required). (GROQ_API_KEY is still set, but used ONLY for Whisper
 * dictation in the transcribe endpoints — NOT here.)
 */

function httpsPost(url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const r = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
    }, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try { resolve({ status: resp.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: resp.statusCode, body: { raw: data } }); }
      });
    });
    r.on('error', reject);
    // If a provider hangs, fail this attempt so callLLM can fall over to the next one
    // instead of blocking until the platform kills the whole function with no cleanup.
    // 240s default: grok-4.6 is a REASONING model — it thinks before emitting, so a big JSON batch
    // (a week of ideas, a remix, a viral breakdown) routinely runs past the old 55s cut, which
    // surfaced to users as "The AI is having a moment" on EVERY large generation while short chat
    // replies still worked. The real ceiling is each function's maxDuration (300 on the heavy ones).
    r.setTimeout(timeoutMs || 240000, () => { r.destroy(new Error('Provider request timed out')); });
    r.write(body);
    r.end();
  });
}

// ── xAI (Grok) — OpenAI-compatible API. The ONLY text writer (no fallback). ──
// `images` (optional): [{ mime, data(base64) }] attached to the last user turn so Grok
// can actually SEE a screenshot. (Grok is the only writer — there is no fallback.)
async function callXAI({ messages, temperature = 0.7, max_tokens = 2000, images = null, timeoutMs = 0 }) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return null;

  let outMsgs = messages;
  if (Array.isArray(images) && images.length) {
    outMsgs = (messages || []).map(m => ({ ...m }));
    for (let i = outMsgs.length - 1; i >= 0; i--) {
      if (outMsgs[i].role === 'user') {
        const parts = [{ type: 'text', text: String(outMsgs[i].content || '') }];
        for (const im of images) {
          if (im && im.data) parts.push({ type: 'image_url', image_url: { url: `data:${im.mime || 'image/jpeg'};base64,${im.data}` } });
        }
        outMsgs[i].content = parts;
        break;
      }
    }
  }

  const model = process.env.XAI_MODEL || 'grok-4.6';
  // REASONING DEPTH. xAI defaults this to "high" when unset — deep multi-step reasoning, the level
  // meant for maths proofs and competition problems. We never set it, so every post this app has
  // ever written ran on "high". Measured consequence, from the production logs on 2026-08-27:
  //   xAI EMPTY 200 after 52771ms — completion_tokens: 0, reasoning_tokens: 2533
  // i.e. 52 seconds of thinking and not one word written, then a retry — which is most of the
  // "why does it take so long". Writing a brand post is a voice task, not a logic puzzle, so the
  // depth was buying latency and empty responses rather than better copy.
  // "low" is the default: xAI describes it as "uses some reasoning tokens, but still fast", and
  // nobody waits around for a social post. Reasoning is never disabled, just not luxurious.
  // Env-overridable so the level moves WITHOUT a deploy if the writing gets worse or stays slow:
  // XAI_REASONING_EFFORT=low|medium|high|xhigh.
  // NOTE: reasoning cannot be disabled, and presence_penalty/frequency_penalty/stop are REJECTED
  // by reasoning models — this file sends none of them, keep it that way.
  const effort = process.env.XAI_REASONING_EFFORT || 'low';
  const payload = { model, messages: outMsgs, temperature, max_tokens: Math.min(max_tokens, 32000) };
  if (effort && effort !== 'default') payload.reasoning_effort = effort;
  const url = 'https://api.x.ai/v1/chat/completions';
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
  const bodyStr = JSON.stringify(payload);

  // Up to 4 attempts (3 retries) on a transient failure. 429 rate-limits and 5xx come back
  // fast, so exponential backoff (~0.9s → 1.8s → 3.6s, small jitter) fits inside the function
  // budget and clears most transient xAI blips — the #1 cause of "the AI is having a moment".
  // BUDGET-CAPPED: never START a new attempt past ~40s, so a slow call + a retry can't blow a
  // 60s function. A hard timeout already burned the budget → not retried. Pure Grok has no
  // model fallback, so this retry is the app's only cushion.
  const t0 = Date.now();
  const backoff = a => Math.min(900 * Math.pow(2, a), 4000) + Math.floor(Math.random() * 300);
  for (let attempt = 0; attempt < 4; attempt++) {
    let resp;
    try { resp = await httpsPost(url, headers, bodyStr, timeoutMs); }
    catch (e) {
      const isTimeout = /timed out/i.test(String(e && e.message));
      if (!isTimeout && (Date.now() - t0) < 150000) { await new Promise(r => setTimeout(r, backoff(attempt))); continue; }
      // WAS SILENT: a timeout or an exhausted network retry returned null with no log, so the
      // user saw "the AI is having a moment" and the logs showed nothing at all.
      console.log('xAI FAILED after ' + (Date.now() - t0) + 'ms on attempt ' + (attempt + 1) + ' — ' +
        (isTimeout ? 'TIMEOUT' : 'network: ' + String(e && e.message).slice(0, 90)) + ' | model=' + model);
      return null;
    }
    if (resp.status === 200) {
      const txt = resp.body?.choices?.[0]?.message?.content;
      if (txt) {
        // Every FAILURE path below logs a duration; success logged nothing, so there was no way to
        // compare latency between reasoning_effort settings except by feel — which cannot settle
        // "is medium worth the wait?". reasoning_tokens is the number that actually moves with the
        // setting, so log it next to the wall-clock time. One line per LLM call, no PII, no bodies.
        try {
          const u = resp.body?.usage || {};
          console.log('xAI OK ' + (Date.now() - t0) + 'ms · effort=' + effort +
            ' · reasoning_tokens=' + (u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens ?? '?') +
            ' · completion_tokens=' + (u.completion_tokens ?? '?') +
            ' · model=' + model + (attempt ? ' · attempt=' + (attempt + 1) : ''));
        } catch (_) {}
        return txt;
      }
      // WAS SILENT, and this is the likely one: grok-4.6 is a REASONING model, so it can burn the
      // whole completion budget thinking and emit no text. A 200 with empty content fell through
      // `content || null` and looked identical to an outage. Now it is named AND retried, because
      // an empty emission is transient — the same prompt usually succeeds on the next attempt.
      console.log('xAI EMPTY 200 after ' + (Date.now() - t0) + 'ms, attempt ' + (attempt + 1) +
        ' — finish_reason=' + (resp.body?.choices?.[0]?.finish_reason) +
        ' usage=' + JSON.stringify(resp.body?.usage || {}) +
        ' model=' + model + ' max_tokens=' + payload.max_tokens);
      if (attempt < 3 && (Date.now() - t0) < 150000) { await new Promise(r => setTimeout(r, backoff(attempt))); continue; }
      return null;
    }
    const transient = resp.status === 429 || resp.status >= 500;
    console.log('xAI ' + (transient ? 'transient' : 'error') + ' (' + resp.status + ') attempt ' + (attempt + 1) + ': ' + JSON.stringify(resp.body).slice(0, 160));
    if (transient && (Date.now() - t0) < 150000) { await new Promise(r => setTimeout(r, backoff(attempt))); continue; }
    return null;
  }
  console.log('xAI gave up after 4 attempts / ' + (Date.now() - t0) + 'ms — model=' + model);
  return null;
}

// ── Grok WEB SEARCH (xAI Responses API + the web_search tool) ──
// One agentic call: Grok searches the LIVE web, browses pages, and answers WITH
// citations. Uses XAI_API_KEY (no new provider). Returns the answer text, or null on
// ANY failure so callers can fall back to their existing search path. Never throws.
// Model defaults to grok-4.6 (reasoning) — override with XAI_SEARCH_MODEL.
function extractResponsesText(b) {
  if (!b || typeof b !== 'object') return null;
  if (typeof b.output_text === 'string' && b.output_text.trim()) return b.output_text.trim();
  const parts = [];
  for (const item of (Array.isArray(b.output) ? b.output : [])) {
    for (const c of (Array.isArray(item && item.content) ? item.content : [])) {
      if (c && typeof c.text === 'string') parts.push(c.text);
    }
    if (item && typeof item.text === 'string') parts.push(item.text);
  }
  const joined = parts.join('').trim();
  if (joined) return joined;
  const cc = b.choices && b.choices[0] && b.choices[0].message && b.choices[0].message.content;
  return (typeof cc === 'string' && cc.trim()) ? cc.trim() : null;
}

function callGrokSearch(prompt, opts = {}) {
  return new Promise((resolve) => {
    const apiKey = process.env.XAI_API_KEY;
    // v670 — SAY WHY IT RETURNED NOTHING. Five of the six exits below resolved null with no log at
    // all, so a rejected key, a socket drop, a timeout or an unparseable body were indistinguishable
    // from "the search found nothing" — and the caller (pullGrokTrends) turns null into an empty
    // lane, which is simply absent from the trends feed. Silent, permanent, and undiagnosable.
    if (!apiKey) { console.error('grok-search: no XAI_API_KEY — the web-search lane is off'); return resolve(null); }
    if (!prompt) { console.error('grok-search: called with an empty prompt'); return resolve(null); }
    const model = process.env.XAI_SEARCH_MODEL || 'grok-4.6';
    const tool = { type: 'web_search' };
    if (Array.isArray(opts.allowedDomains) && opts.allowedDomains.length) tool.filters = { allowed_domains: opts.allowedDomains.slice(0, 5) };
    const body = JSON.stringify({
      model,
      input: [{ role: 'user', content: String(prompt) }],
      tools: [tool],
      max_output_tokens: Math.min(opts.maxTokens || 1500, 4000),
    });
    const r = https.request({
      hostname: 'api.x.ai', path: '/v1/responses', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(body) },
    }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        // console.ERROR, not log: this is a failure, and it is the line someone greps for.
        if (resp.statusCode !== 200) { console.error('grok-search: http ' + resp.statusCode + ' — ' + String(data).slice(0, 300)); return resolve(null); }
        try {
          const text = extractResponsesText(JSON.parse(data));
          if (!text) console.error('grok-search: 200 but no text in the response body — ' + String(data).slice(0, 200));
          resolve(text);
        } catch (e) {
          console.error('grok-search: 200 with an unparseable body — ' + (e && e.message) + ' — ' + String(data).slice(0, 200));
          resolve(null);
        }
      });
    });
    r.on('error', (e) => { console.error('grok-search: request failed — ' + (e && e.message)); resolve(null); });
    // agentic search can take longer than a chat call
    r.setTimeout(90000, () => { console.error('grok-search: timed out after 90s'); r.destroy(); resolve(null); });
    r.write(body); r.end();
  });
}

/**
 * Main entry point. Always Grok (primary) → Groq (fallback). No OpenAI, no Claude.
 * @param {Object} opts - { messages, temperature?, max_tokens?, images? }  (model/engine ignored)
 * @returns {string} LLM response text
 */
async function callLLM(opts = {}) {
  const { messages, temperature = 0.7, max_tokens = 2000, images = null, timeoutMs = 0 } = opts;

  // PURE GROK — no fallback (Jörgen's call: rather not generate than fall back to Llama).
  // If xAI is down / out of credits, this throws and the caller shows a retry message.
  const text = await callXAI({ messages, temperature, max_tokens, images, timeoutMs });
  if (text) return text;

  throw new Error('The AI is having a moment and could not respond. Please try again in a few seconds.');
}

module.exports = { callLLM, callGrokSearch };
