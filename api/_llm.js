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
        /* v681 — A REPLY CUT OFF AT max_tokens CAME BACK AS ORDINARY TEXT. finish_reason was
           read only on the empty-200 path below, so a completion that stopped mid-sentence
           because it hit the ceiling was indistinguishable from a finished one — and
           expand-field REPLACES a whole brand field with whatever it gets. Record it so a
           caller that overwrites something can refuse a half-written answer. */
        try {
          const _fr = resp.body?.choices?.[0]?.finish_reason;
          LAST_TRUNCATED = (_fr === 'length');
          if (LAST_TRUNCATED) console.log('xAI reply hit max_tokens (' + payload.max_tokens + ') — it is CUT OFF; model=' + model);
        } catch (_) { LAST_TRUNCATED = false; }
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

/* Pull whatever text a Responses-API payload carries, whatever shape it arrives in. Used for a
   buffered body AND for each streamed event, so neither path needs to know the event names. */
function grokSearchTextFrom(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.response && typeof obj.response === 'object') {
    const t = extractResponsesText(obj.response);
    if (t) return t;
  }
  return extractResponsesText(obj);
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
    /* v686 — STREAMED, BECAUSE THE OLD TIMEOUT WAS MEASURING THE WRONG THING.
       Production 2026-09-19 05:35: every single call ended in "timed out", never once an HTTP
       status — at 90s before v684 and at 45s after. A rejected key would have answered 401, a
       rate limit 429; nothing arrived at all. The endpoint and body are NOT wrong: docs.x.ai
       documents exactly this shape (POST /v1/responses, input, tools:[{type:'web_search'}],
       grok-4.6), and there is no parameter that bounds how much searching it does.
       The mechanism is that req.setTimeout is Node's socket INACTIVITY timeout, not a total one.
       A non-streaming agentic search sends ZERO bytes while it works, so "still thinking" and
       "dead socket" are the same event. Streaming keeps bytes flowing, so the idle timer only
       fires on real silence, and an absolute deadline — which the old code never had — is what
       bounds the call. If the server refuses to stream we now get an HTTP status instead of
       nothing, which is also an answer.
       The numbers below (first byte, bytes, events, elapsed) are logged on EVERY outcome, so the
       next nightly run says how long this actually takes instead of only that it did not fit. */
    const body = JSON.stringify({
      model,
      input: [{ role: 'user', content: String(prompt) }],
      tools: [tool],
      max_output_tokens: Math.min(opts.maxTokens || 1500, 4000),
      stream: true,
    });
    const TOTAL_MS = Math.max(5000, Math.min(Number(opts.timeoutMs) || 90000, 240000));
    const IDLE_MS = Math.max(4000, Math.min(TOTAL_MS, 30000));
    const started = Date.now();
    let attempt = 0;
    const attemptOnce = () => {
      const leftMs = TOTAL_MS - (Date.now() - started);
      if (leftMs < 2000) { console.error('grok-search: no time left for attempt ' + (attempt + 1)); return resolve(null); }
      attempt++;
      let done = false, bytes = 0, events = 0, firstByteMs = -1, deltas = '', best = null, deadline = null;
      const finish = (text, why) => {
        if (done) return;
        done = true;
        try { if (deadline) clearTimeout(deadline); } catch (_) {}
        const el = Date.now() - started;
        const stat = 'first byte ' + (firstByteMs < 0 ? 'never' : firstByteMs + 'ms') + ', ' + bytes + ' bytes, ' +
                     events + ' events, ' + el + 'ms total, budget ' + TOTAL_MS + 'ms';
        if (text) console.log('grok-search: ok — ' + stat);
        else console.error('grok-search: ' + why + ' — ' + stat);
        resolve(text || null);
      };
      const r = https.request({
        hostname: 'api.x.ai', path: '/v1/responses', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, 'Content-Length': Buffer.byteLength(body), 'Accept': 'text/event-stream' },
      }, (resp) => {
        let buf = '';
        const streaming = String(resp.headers['content-type'] || '').indexOf('event-stream') !== -1;
        resp.on('data', (c) => {
          if (firstByteMs < 0) firstByteMs = Date.now() - started;
          bytes += c.length; buf += c;
          if (!streaming) return;                       // buffered JSON: parse it at 'end'
          let nl;
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
            if (!line || line.indexOf('data:') !== 0) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            events++;
            let ev = null;
            try { ev = JSON.parse(payload); } catch (_) { continue; }
            // Shape-tolerant on purpose: a delta field is appended, and any event carrying a full
            // response wins outright. Nothing here depends on knowing the event names.
            if (typeof ev.delta === 'string') deltas += ev.delta;
            const whole = grokSearchTextFrom(ev);
            if (whole) best = whole;
          }
        });
        resp.on('end', () => {
          if (resp.statusCode !== 200) {
            console.error('grok-search: http ' + resp.statusCode + ' — ' + String(buf).slice(0, 300));
            return finish(null, 'refused with http ' + resp.statusCode);
          }
          if (!streaming) {
            // The server ignored `stream` and sent one JSON body. Parse it the old way.
            let text = null;
            try { text = grokSearchTextFrom(JSON.parse(buf)); }
            catch (e) { return finish(null, 'unparseable body — ' + ((e && e.message) || e)); }
            return finish(text, 'answered 200 with no text in it');
          }
          const out = best || (deltas.trim() ? deltas.trim() : null);
          finish(out, 'stream ended with no text in it');
        });
      });
      // The ABSOLUTE deadline. The old code had only the idle timer, so nothing bounded a call
      // that kept trickling bytes, and nothing distinguished slow from stuck.
      deadline = setTimeout(() => {
        const partial = best || (deltas.trim() ? deltas.trim() : null);
        try { r.destroy(); } catch (_) {}
        // Partial output is NOT returned: every caller parses this as whole JSON, and half a JSON
        // array is worse than none. It is reported, so the next run says how close it got.
        if (partial) console.error('grok-search: cut off at the ' + TOTAL_MS + 'ms budget with ' + partial.length + ' chars of partial text — it is WORKING, just slower than the budget allows');
        finish(null, 'hit the ' + TOTAL_MS + 'ms budget');
      }, leftMs);
      r.on('error', (e) => {
        if (done) return;
        const msg = (e && e.message) || String(e);
        const canRetry = attempt < 2 && (TOTAL_MS - (Date.now() - started)) > 8000;
        if (canRetry) {
          console.error('grok-search: request failed on attempt ' + attempt + ' — ' + msg + ' — retrying once');
          try { if (deadline) clearTimeout(deadline); } catch (_) {}
          done = true;
          return setTimeout(attemptOnce, 900);
        }
        finish(null, 'request failed on attempt ' + attempt + ' — ' + msg + ' — giving up');
      });
      // Idle timeout only: with streaming this fires on REAL silence, not on a model still thinking.
      r.setTimeout(IDLE_MS, () => {
        if (done) return;
        try { r.destroy(); } catch (_) {}
        finish(null, 'silent for ' + Math.round(IDLE_MS / 1000) + 's on attempt ' + attempt + ' — not retried (a stall means it may still be working)');
      });
      r.write(body); r.end();
    };
    attemptOnce();
  });
}

/**
 * Main entry point. Always Grok (primary) → Groq (fallback). No OpenAI, no Claude.
 * @param {Object} opts - { messages, temperature?, max_tokens?, images? }  (model/engine ignored)
 * @returns {string} LLM response text
 */
// v681: set by callXAI on every successful 200 — see the note there. Read ONLY through
// callLLM's `wantMeta` option, immediately after the await, so there is no window in which a
// second call in the same instance could overwrite it before the first caller looks.
let LAST_TRUNCATED = false;

async function callLLM(opts = {}) {
  const { messages, temperature = 0.7, max_tokens = 2000, images = null, timeoutMs = 0, wantMeta = false } = opts;

  // PURE GROK — no fallback (Jörgen's call: rather not generate than fall back to Llama).
  // If xAI is down / out of credits, this throws and the caller shows a retry message.
  LAST_TRUNCATED = false;
  const text = await callXAI({ messages, temperature, max_tokens, images, timeoutMs });
  // v681: `wantMeta` is opt-in, so every existing caller still gets a plain string.
  if (text) return wantMeta ? { text: text, truncated: LAST_TRUNCATED } : text;

  throw new Error('The AI is having a moment and could not respond. Please try again in a few seconds.');
}

module.exports = { callLLM, callGrokSearch };
