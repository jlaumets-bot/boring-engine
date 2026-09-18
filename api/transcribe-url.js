const https = require('https');
const http = require('http');
const { Buffer } = require('buffer');

// ── TIME + SIZE BUDGET ────────────────────────────────────────────────────────
// vercel.json gives api/transcribe-url.js maxDuration: 120s. Every network stage
// below has to fit inside that, because a PLATFORM kill is the worst failure this
// endpoint can have: a bare 504 with no app-level error and no log line, which is
// indistinguishable from "the AI is broken" and impossible to diagnose afterwards.
//
// The whole request therefore runs against ONE wall-clock budget of 110s (see
// HANDLER_BUDGET_MS) and every stage is clamped to whatever is LEFT of it, so we
// always fail first, with a named error that reaches both the logs and the user.
//
// Normal path (tikwm or cobalt returns a media URL), worst case:
//     auth + usage guard          ~ 2s
//     provider metadata          <= 15s   FETCH_JSON_TIMEOUT_MS   (whole redirect chain)
//     audio download             <= 40s   DOWNLOAD_TIMEOUT_MS     (whole redirect chain)
//     Whisper transcription      <= 50s   WHISPER_TIMEOUT_MS      (unchanged)
//                                 -----
//                                  107s  <= 110s budget <= 120s platform cap (13s spare)
//
// Apify fallback path (only reached when tikwm returns nothing): the run URL asks
// Apify to hold the connection for up to 90s (`waitForFinish=90`), so 90s + 40s +
// 50s cannot fit in 120s no matter what timeout is chosen — that path was already
// over budget before this change. Lowering waitForFinish would break runs that
// currently succeed, so it is left alone; instead APIFY_RUN_TIMEOUT_MS bounds the
// hang and the remaining-budget clamp guarantees we surface a named "took too long"
// error at ~110s instead of being killed at 120s.
const HANDLER_BUDGET_MS     = 110000; // stop before Vercel's 120s kill
const MIN_STAGE_MS          = 3000;   // less than this left => don't even start a stage
const FETCH_JSON_TIMEOUT_MS = 15000;  // tikwm / cobalt metadata lookup
const APIFY_RUN_TIMEOUT_MS  = 95000;  // covers the actor's own waitForFinish=90
const APIFY_READ_TIMEOUT_MS = 20000;  // dataset read (limit=1, tiny)
const DOWNLOAD_TIMEOUT_MS   = 40000;  // media download
const WHISPER_TIMEOUT_MS    = 50000;  // unchanged from before
const MAX_REDIRECTS         = 5;
const MAX_AUDIO_BYTES       = 25 * 1024 * 1024; // unchanged product limit
const MAX_JSON_BYTES        = 2 * 1024 * 1024;  // provider JSON is a few KB; 2MB is already absurd

// User-facing failure text. `err.message` from this file is handed straight to the
// browser by the catch below, so every message thrown here is written for a person.
const MSG_SLOW_OVERALL  = 'This video took too long to process — try a shorter one, or paste the spoken words instead.';
const MSG_SLOW_DOWNLOAD = 'That video took too long to download — try a shorter one, or paste the spoken words instead.';
const MSG_TOO_LARGE     = 'Audio file too large (over 25MB). Try a shorter video.';
const MSG_CUT_OFF       = 'The download was cut off before it finished — try again, or paste the spoken words instead.';
const MSG_HOST          = "Couldn't download that video — the host didn't respond. Try again, or paste the spoken words or a short description instead.";
const MSG_BAD_LINK      = 'That video host returned a link we cannot follow — paste the spoken words or a short description instead.';
const MSG_PROVIDER_SLOW = "The video service didn't respond in time — try again in a minute, or paste the spoken words instead.";
const MSG_UNEXPECTED    = 'Something went wrong on our side — try again, or paste the spoken words instead.';

// Node's socket failures (ECONNRESET, "socket hang up", ENOTFOUND, CERT_HAS_EXPIRED…)
// carry an err.code and read as gibberish to a user. Every message thrown deliberately
// in this file is a sentence written for the user and carries NO code — so `code` is
// the discriminator, and the hand-written messages still pass through untouched.
function userMessage(err) {
  const raw = err && err.message ? String(err.message) : '';
  // A programming error is not one of those hand-written sentences — its message names our own
  // internals (a body-less POST used to hand the caller our raw TypeError). Never relayed.
  if (err instanceof TypeError || err instanceof ReferenceError
      || err instanceof RangeError || err instanceof SyntaxError) return MSG_UNEXPECTED;
  if ((err && err.code) ||
      /socket hang up|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|EHOSTUNREACH|ENETUNREACH|ERR_[A-Z_]{3,}/.test(raw)) {
    return MSG_HOST;
  }
  return raw || MSG_HOST;
}

const handler = async function (req, res) {
  // Started before the auth round-trip so the guard's own latency counts against the budget.
  const deadline = Date.now() + HANDLER_BUDGET_MS;
  // Clamp a stage to what is left of the budget; refuse to start one that cannot finish.
  const stageBudget = (max, stage) => {
    const left = deadline - Date.now();
    if (left < MIN_STAGE_MS) {
      console.error('transcribe-url: out of time budget before ' + stage + ' (' + left + 'ms left of ' + HANDLER_BUDGET_MS + 'ms)');
      throw new Error(MSG_SLOW_OVERALL);
    }
    return Math.min(max, left);
  };

  const allowed = ['https://contentshrimp.com','https://bettercontent.app','https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const _g = await require('./_usage').guard(req, 'transcribeurl', res);
  if (!_g.user) return res.status(401).json({ error: 'Please sign in again.' });
  if (_g.over) return require('./_usage').denyResponse(res, _g.gate);

  // Transcription provider: Groq Whisper ONLY (OpenAI is used nowhere except /api/speak TTS).
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return res.status(500).json({ error: 'Transcription is not configured on the server.' });

  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Missing video URL' });
    try { await require('./_safeurl').assertPublicHttpUrl(String(url).trim()); }
    catch (e) { return res.status(400).json({ error: 'That URL is not allowed.' }); }

    // Detect platform and get audio download URL
    let audioDownloadUrl;
    const isTikTok = url.includes('tiktok.com') || url.includes('vm.tiktok');
    const isInstagram = url.includes('instagram.com');

    if (isTikTok) {
      // 1) tikwm.com — free, fast. Now sent WITH a browser User-Agent (it rejects
      //    UA-less requests with "Url parsing is failed", which broke this before).
      try {
        console.log('TikTok detected, trying tikwm.com...');
        const tikwmResp = await fetchJson('https://www.tikwm.com/api/', {
          method: 'POST',
          timeoutMs: stageBudget(FETCH_JSON_TIMEOUT_MS, 'tikwm lookup'),
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Accept': 'application/json'
          },
          body: 'url=' + encodeURIComponent(url) + '&hd=1'
        });
        if (tikwmResp && tikwmResp.data) {
          audioDownloadUrl = tikwmResp.data.play || tikwmResp.data.wmplay || tikwmResp.data.music;
        }
      } catch (e) { console.log('tikwm failed:', e.message); }

      // 2) Fallback: Apify TikTok scraper (reliable, already used elsewhere) — used only
      //    if tikwm couldn't return a media URL.
      if (!audioDownloadUrl) {
        const apifyToken = process.env.APIFY_API_TOKEN;
        if (!apifyToken) {
          throw new Error("Couldn't read that TikTok automatically right now — paste the spoken words or a short description instead.");
        }
        console.log('tikwm gave nothing — falling back to Apify...');
        const run = await apifyRequest('POST', '/v2/acts/clockworks~tiktok-scraper/runs?waitForFinish=90', apifyToken, {
          postURLs: [url], resultsPerPage: 1, shouldDownloadVideos: false, shouldDownloadCovers: false, shouldDownloadSubtitles: false
        }, stageBudget(APIFY_RUN_TIMEOUT_MS, 'Apify run'));
        const datasetId = run && run.data && run.data.defaultDatasetId;
        if (!datasetId) throw new Error("Couldn't read that TikTok right now — try again in a minute, or paste a description.");
        const items = await apifyRequest('GET', `/v2/datasets/${datasetId}/items?limit=1&format=json`, apifyToken, null,
          stageBudget(APIFY_READ_TIMEOUT_MS, 'Apify dataset read'));
        const item = (Array.isArray(items) ? items : [])[0] || {};
        audioDownloadUrl =
          (Array.isArray(item.mediaUrls) && item.mediaUrls[0]) ||
          (item.videoMeta && item.videoMeta.downloadAddr) ||
          (item.video && item.video.downloadAddr) ||
          item.downloadAddr || null;
      }

      if (!audioDownloadUrl) {
        throw new Error("Couldn't get the audio from that TikTok (it may be private or region-locked). Paste the spoken words or a short description instead.");
      }
    } else {
      // For YouTube, Instagram, etc — use cobalt if configured
      const cobaltApiKey = process.env.COBALT_API_KEY;
      const cobaltApiUrl = process.env.COBALT_API_URL || 'https://api.cobalt.tools';

      console.log('Using cobalt for:', url);
      const cobaltHeaders = {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      };
      if (cobaltApiKey) {
        cobaltHeaders['Authorization'] = 'Api-Key ' + cobaltApiKey;
      }

      const cobaltResp = await fetchJson(cobaltApiUrl, {
        method: 'POST',
        timeoutMs: stageBudget(FETCH_JSON_TIMEOUT_MS, 'cobalt lookup'),
        headers: cobaltHeaders,
        body: JSON.stringify({
          url: url,
          downloadMode: 'audio',
          audioFormat: 'mp3'
        })
      });

      if (cobaltResp.status === 'error') {
        const errCode = cobaltResp.error?.code || '';
        if (errCode.includes('auth') || errCode.includes('jwt')) {
          throw new Error("We can't read that link automatically yet — TikTok links work best. Paste a TikTok URL, or type a short description of the video instead.");
        }
        throw new Error(errCode || cobaltResp.text || 'Could not get download link.');
      }

      audioDownloadUrl = cobaltResp.url;
      if (!audioDownloadUrl) {
        throw new Error('No download URL returned.');
      }
    }

    // Download the audio file — re-validate the third-party URL (it came from tikwm/cobalt,
    // not the user, so it could point at an internal/metadata host).
    try { await require('./_safeurl').assertPublicHttpUrl(audioDownloadUrl); }
    catch (e) { throw new Error('The video host returned an unsafe download link.'); }
    console.log('Downloading audio from:', audioDownloadUrl.substring(0, 80) + '...');
    const audioBuffer = await downloadFile(audioDownloadUrl, { timeoutMs: stageBudget(DOWNLOAD_TIMEOUT_MS, 'audio download') });
    console.log('Downloaded:', audioBuffer.length, 'bytes');

    // Belt-and-braces only: downloadFile now enforces MAX_AUDIO_BYTES *during* the
    // stream, so this can no longer be the thing that catches an oversized file.
    if (audioBuffer.length > MAX_AUDIO_BYTES) {
      throw new Error(MSG_TOO_LARGE);
    }

    // Transcribe — Groq Whisper (whisper-large-v3) ONLY. No OpenAI fallback anywhere.
    console.log('Transcribing...');
    const whisperMs = stageBudget(WHISPER_TIMEOUT_MS, 'transcription');
    const providers = [{ host: 'api.groq.com', path: '/openai/v1/audio/transcriptions', key: groqKey, model: 'whisper-large-v3' }];

    let transcript = null, lastErr = '';
    for (const p of providers) {
      try {
        const r = await whisperTranscribe(p, audioBuffer, whisperMs);
        if (r.status === 200 && r.body && r.body.trim()) { transcript = r.body.trim(); break; }
        try { lastErr = JSON.parse(r.body).error.message; } catch (e) { lastErr = 'transcription error ' + r.status; }
        console.log(p.host + ' transcription failed:', lastErr);
      } catch (e) { lastErr = e.message; }
    }
    if (transcript == null) throw new Error(lastErr || 'Could not transcribe the audio — try again.');

    await require('./_usage').logUsage({ userId: _g.billingUserId || _g.user.id, action: 'transcribeurl' });
    return res.status(200).json({ transcript });

  } catch (err) {
    console.error('Transcribe-url error:', err);
    // userMessage() keeps every hand-written sentence above verbatim and swaps raw
    // socket noise ("socket hang up", ECONNRESET) for something a user can act on.
    return res.status(500).json({ error: userMessage(err) });
  }
};

// Provider metadata lookup (tikwm / cobalt). Bounded three ways, because an
// unbounded read of a third-party endpoint hangs the whole function:
//   • one absolute deadline spanning the ENTIRE redirect chain (opts.timeoutMs)
//   • MAX_JSON_BYTES enforced DURING the stream
//   • MAX_REDIRECTS hops, each re-validated by the SSRF guard (unchanged)
function fetchJson(url, options, depth, deadlineAt) {
  options = options || {};
  depth = depth || 0;
  if (!deadlineAt) deadlineAt = Date.now() + (options.timeoutMs || FETCH_JSON_TIMEOUT_MS);
  if (depth > MAX_REDIRECTS) return Promise.reject(new Error(MSG_BAD_LINK));
  return new Promise(function (resolve, reject) {
    var settled = false, timer = null, request = null, blocked = '';
    function done(v) { if (settled) return; settled = true; clearTimeout(timer); resolve(v); }
    function fail(e, why) {
      if (settled) return; settled = true; clearTimeout(timer);
      console.error('transcribe-url: provider lookup failed (' + why + ') for ' + url.slice(0, 80) + ':', (e && e.message) || e);
      reject(e);
    }

    var left = deadlineAt - Date.now();
    if (left <= 0) return fail(new Error(MSG_PROVIDER_SLOW), 'no time budget left');

    var parsed;
    try { parsed = new URL(url); } catch (e) { return fail(new Error(MSG_BAD_LINK), 'unparseable url'); }
    var mod = parsed.protocol === 'https:' ? https : http;
    var headers = Object.assign({}, options.headers || {});
    if (options.body && headers['Content-Length'] == null) {
      headers['Content-Length'] = Buffer.byteLength(options.body);
    }
    var reqOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: headers
    };
    request = mod.request(reqOptions, function(resp) {
      if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location) {
        resp.resume();
        var next;
        try { next = new URL(resp.headers.location, url).toString(); }
        catch (e) { return fail(new Error(MSG_BAD_LINK), 'unparseable redirect'); }
        clearTimeout(timer); // the next hop carries the SAME absolute deadline
        require('./_safeurl').assertPublicHttpUrl(next)
          .then(
            function() { return fetchJson(next, options, depth + 1, deadlineAt); },
            // Only the SSRF guard's own rejection is a blocked redirect. Anything that
            // fails on the NEXT hop keeps its real cause instead of being mislabelled.
            function(e) { blocked = 'SSRF guard rejected ' + next.slice(0, 80) + ' — ' + ((e && e.message) || e); throw new Error(MSG_BAD_LINK); }
          )
          .then(done, function(e) { fail(e, blocked || 'redirect hop'); });
        return;
      }
      var data = '', bytes = 0;
      resp.on('data', function(chunk) {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > MAX_JSON_BYTES) {
          fail(new Error(MSG_PROVIDER_SLOW), 'response over ' + MAX_JSON_BYTES + ' bytes');
          try { resp.destroy(); } catch (e) {}
          try { request.destroy(); } catch (e) {}
          return;
        }
        data += chunk;
      });
      resp.on('end', function() {
        try { done(JSON.parse(data)); }
        catch (e) { done({ status: 'error', text: data }); }
      });
      resp.on('aborted', function() { fail(new Error(MSG_PROVIDER_SLOW), 'connection closed mid-response'); });
      resp.on('error', function(e) { fail(e, 'stream error'); });
    });
    request.on('error', function(e) { fail(e, 'network'); });
    // Hard wall-clock cap. request.setTimeout() is an INACTIVITY timeout — a host that
    // dribbles a byte a second never trips it — so the guarantee has to be a timer.
    timer = setTimeout(function() {
      fail(new Error(MSG_PROVIDER_SLOW), 'timed out after ' + Math.round(left / 1000) + 's');
      try { request.destroy(); } catch (e) {}
    }, left);
    if (options.body) request.write(options.body);
    request.end();
  });
}

// Download the media. Bounded three ways, because reading an arbitrary third-party
// media URL with no cap is either a memory blow-up or a silent platform kill:
//   • MAX_AUDIO_BYTES enforced DURING the stream — reject AND destroy the response
//     the moment the cap is crossed, so the rest of the file never arrives. Checking
//     the size after 'end' (what this used to do) is checking far too late.
//   • one absolute deadline spanning the ENTIRE redirect chain (opts.timeoutMs).
//   • MAX_REDIRECTS hops, each re-validated by the SSRF guard (unchanged).
function downloadFile(url, opts) {
  opts = opts || {};
  var depth = opts.depth || 0;
  var deadlineAt = opts.deadlineAt || (Date.now() + (opts.timeoutMs || DOWNLOAD_TIMEOUT_MS));
  if (depth > MAX_REDIRECTS) return Promise.reject(new Error(MSG_BAD_LINK));
  return new Promise(function (resolve, reject) {
    var settled = false, timer = null, request = null, blocked = '';
    function done(v) { if (settled) return; settled = true; clearTimeout(timer); resolve(v); }
    function fail(e, why) {
      if (settled) return; settled = true; clearTimeout(timer);
      console.error('transcribe-url: audio download failed (' + why + '):', (e && e.message) || e);
      reject(e);
    }

    var left = deadlineAt - Date.now();
    if (left <= 0) return fail(new Error(MSG_SLOW_DOWNLOAD), 'no time budget left');

    var parsed;
    try { parsed = new URL(url); } catch (e) { return fail(new Error(MSG_BAD_LINK), 'unparseable url'); }
    var mod = parsed.protocol === 'https:' ? https : http;

    request = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, function (resp) {
      if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location) {
        resp.resume();
        var next;
        try { next = new URL(resp.headers.location, url).toString(); }
        catch (e) { return fail(new Error(MSG_BAD_LINK), 'unparseable redirect'); }
        clearTimeout(timer); // the next hop carries the SAME absolute deadline
        require('./_safeurl').assertPublicHttpUrl(next)
          .then(
            function () { return downloadFile(next, { depth: depth + 1, deadlineAt: deadlineAt }); },
            // Only the SSRF guard's own rejection is a blocked redirect. Anything that
            // fails on the NEXT hop keeps its real cause instead of being mislabelled.
            function (e) { blocked = 'SSRF guard rejected ' + next.slice(0, 80) + ' — ' + ((e && e.message) || e); throw new Error(MSG_BAD_LINK); }
          )
          .then(done, function (e) { fail(e, blocked || 'redirect hop'); });
        return;
      }
      if (resp.statusCode !== 200) {
        resp.resume();
        return fail(new Error("The video host wouldn't hand over the audio (HTTP " + resp.statusCode + "). Paste the spoken words or a short description instead."), 'HTTP ' + resp.statusCode);
      }
      var chunks = [], size = 0;
      resp.on('data', function (c) {
        if (settled) return;
        size += c.length;
        if (size > MAX_AUDIO_BYTES) {
          // Settle FIRST (fail() flips `settled` synchronously), then kill the socket
          // so the destroy's own 'error'/'aborted' events can't double-settle.
          fail(new Error(MSG_TOO_LARGE), 'over ' + MAX_AUDIO_BYTES + ' bytes (aborted at ' + size + ')');
          try { resp.destroy(); } catch (e) {}
          try { request.destroy(); } catch (e) {}
          return;
        }
        chunks.push(c);
      });
      resp.on('end', function () { done(Buffer.concat(chunks)); });
      resp.on('aborted', function () { fail(new Error(MSG_CUT_OFF), 'connection closed after ' + size + ' bytes'); });
      resp.on('error', function (e) { fail(e, 'stream error'); });
    });
    request.on('error', function (e) { fail(e, 'network'); });
    // Hard wall-clock cap. request.setTimeout() is an INACTIVITY timeout — a host that
    // dribbles a byte a second never trips it — so the guarantee has to be a timer.
    timer = setTimeout(function () {
      fail(new Error(MSG_SLOW_DOWNLOAD), 'timed out after ' + Math.round(left / 1000) + 's');
      try { request.destroy(); } catch (e) {}
    }, left);
  });
}

// Post the downloaded media to an OpenAI-compatible Whisper endpoint (Groq).
function whisperTranscribe(provider, audioBuffer, timeoutMs) {
  var budget = timeoutMs || WHISPER_TIMEOUT_MS;
  return new Promise(function (resolve, reject) {
    var boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    var parts = [];
    parts.push('--' + boundary + '\r\nContent-Disposition: form-data; name="model"\r\n\r\n' + provider.model + '\r\n');
    parts.push('--' + boundary + '\r\nContent-Disposition: form-data; name="response_format"\r\n\r\ntext\r\n');
    // TikTok/Apify give us an mp4 video; Whisper extracts the speech from it.
    parts.push('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="audio.mp4"\r\nContent-Type: application/octet-stream\r\n\r\n');
    parts.push(audioBuffer);
    parts.push('\r\n--' + boundary + '--\r\n');
    var bodyBuffer = Buffer.concat(parts.map(function (p) { return typeof p === 'string' ? Buffer.from(p) : p; }));

    var settled = false, timer = null, request = null;
    function done(v) { if (settled) return; settled = true; clearTimeout(timer); resolve(v); }
    function fail(e, why) {
      if (settled) return; settled = true; clearTimeout(timer);
      console.error('transcribe-url: whisper request failed (' + why + '):', (e && e.message) || e);
      reject(e);
    }

    request = https.request({
      hostname: provider.host,
      path: provider.path,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + provider.key,
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': bodyBuffer.length
      }
    }, function (resp) {
      var data = '';
      resp.on('data', function (c) { data += c; });
      resp.on('end', function () { done({ status: resp.statusCode, body: data }); });
      resp.on('aborted', function () { fail(new Error('The transcription service cut the connection — try again.'), 'connection closed mid-response'); });
      resp.on('error', function (e) { fail(e, 'stream error'); });
    });
    request.on('error', function (e) { fail(e, 'network'); });
    // Inactivity timeout (fast failure on a dead socket) PLUS a hard wall-clock cap,
    // so a dribbling response can't outlive the function's own budget.
    request.setTimeout(budget, function () { request.destroy(new Error('The transcription service took too long — try again, or paste the spoken words instead.')); });
    timer = setTimeout(function () {
      fail(new Error('The transcription service took too long — try again, or paste the spoken words instead.'), 'timed out after ' + Math.round(budget / 1000) + 's');
      try { request.destroy(); } catch (e) {}
    }, budget);
    request.write(bodyBuffer);
    request.end();
  });
}

// Minimal Apify REST helper (same pattern as crawl-social.js). Bounded by a hard
// wall-clock cap and MAX_JSON_BYTES — the run endpoint deliberately holds the
// connection open (waitForFinish=90), so with no timeout at all it could hang the
// whole function until the platform killed it with a bare 504.
function apifyRequest(method, path, token, body, timeoutMs) {
  var budget = timeoutMs || APIFY_READ_TIMEOUT_MS;
  return new Promise(function (resolve, reject) {
    var settled = false, timer = null, request = null;
    function done(v) { if (settled) return; settled = true; clearTimeout(timer); resolve(v); }
    function fail(e, why) {
      if (settled) return; settled = true; clearTimeout(timer);
      console.error('transcribe-url: apify ' + method + ' ' + path.slice(0, 60) + ' failed (' + why + '):', (e && e.message) || e);
      reject(e);
    }

    request = https.request({
      hostname: 'api.apify.com',
      path: path,
      method: method,
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
    }, function (resp) {
      var data = '', bytes = 0;
      resp.on('data', function (c) {
        if (settled) return;
        bytes += c.length;
        if (bytes > MAX_JSON_BYTES) {
          fail(new Error(MSG_PROVIDER_SLOW), 'response over ' + MAX_JSON_BYTES + ' bytes');
          try { resp.destroy(); } catch (e) {}
          try { request.destroy(); } catch (e) {}
          return;
        }
        data += c;
      });
      resp.on('end', function () { try { done(JSON.parse(data)); } catch (e) { done(data); } });
      resp.on('aborted', function () { fail(new Error(MSG_PROVIDER_SLOW), 'connection closed mid-response'); });
      resp.on('error', function (e) { fail(e, 'stream error'); });
    });
    request.on('error', function (e) { fail(e, 'network'); });
    timer = setTimeout(function () {
      fail(new Error(MSG_PROVIDER_SLOW), 'timed out after ' + Math.round(budget / 1000) + 's');
      try { request.destroy(); } catch (e) {}
    }, budget);
    if (body) request.write(JSON.stringify(body));
    request.end();
  });
}

module.exports = handler;
