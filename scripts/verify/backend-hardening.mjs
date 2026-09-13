#!/usr/bin/env node
// Verification for the backend robustness / security hardening round.
//
//   node scripts/verify/backend-hardening.mjs
//
// Prints "backend hardening verification passed" as its LAST line only when every
// assertion holds; exits non-zero otherwise.
//
// WHAT IS PROVEN HOW — read this before trusting a green run.
//
//  [1] CRLF injection into multipart headers (transcribe.js, transcribe-voice.js)
//      BEHAVIOURAL. The REAL builder + filter functions are extracted from disk and
//      executed against a filename / mimeType / format / language that carries \r\n
//      and a complete forged `model` part. We assert the forged part is absent from
//      the produced body. Each case is paired with a CONTROL running the PRE-FIX
//      pattern (raw interpolation) against the SAME input, which must show the
//      injection — so a green result cannot be vacuous.
//
//  [3] people-also-ask item without `question`
//      BEHAVIOURAL. The ACTUAL parse+dedupe block is sliced out of the handler source
//      and run against a SerpAPI payload whose items are missing `question` / `query`
//      (plus null items and a non-string question). We assert it does not throw and
//      keeps only the well-formed rows. CONTROL: the pre-fix block against the same
//      payload must throw TypeError.
//
//  [2] crawl-social Apify timeouts + budget + error logging  — STRUCTURAL, except the
//      budget ARITHMETIC, which is computed from the constants in the file and checked
//      against the real maxDuration read out of vercel.json.
//  [4] PostgREST path encoding      — STRUCTURAL (no un-encoded `eq.${` left).
//  [5] stripe-webhook replay guard  — STRUCTURAL (+ ordering before setPlan).
//  [6] remix input caps + doc fetch — STRUCTURAL.
//  [7] expand-field coercion        — STRUCTURAL.
//  [M] module integrity             — every touched file require()s and still exports
//      its handler (@napi-rs/canvas is stubbed: no Linux native binding in this repo's
//      node_modules, which is environmental and predates this work).

import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API = path.join(ROOT, 'api');

let failures = 0;
const pass = (m) => console.log('  ok   ' + m);
const fail = (m) => { failures++; console.log('  FAIL ' + m); };
const check = (cond, m) => cond ? pass(m) : fail(m);

const read = (f) => fs.readFileSync(path.join(API, f), 'utf8');

// Pull a named top-level function's real source out of a file (brace matched).
// Reading from disk is deliberate: if a fix is reverted, these tests execute the
// reverted code and go red.
function extractFn(src, name, file) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error(`function ${name}() not found in ${file}`);
  let depth = 0;
  const open = src.indexOf('{', i);
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error(`unbalanced braces extracting ${name}() from ${file}`);
}
function extractConst(src, name, file) {
  const m = src.match(new RegExp('^const\\s+' + name + '\\s*=[^;]*;', 'm'));
  if (!m) throw new Error(`const ${name} not found in ${file}`);
  return m[0];
}
function loadFns(file, names, consts = []) {
  const src = read(file);
  const body = [
    ...consts.map(c => extractConst(src, c, file)),
    ...names.map(n => extractFn(src, n, file)),
  ].join('\n');
  return new Function('Buffer', `${body}\nreturn { ${names.join(', ')} };`)(Buffer);
}

// Count how many multipart parts declare a given field name.
const countField = (body, name) =>
  (String(body).match(new RegExp('name="' + name + '"', 'g')) || []).length;

// ── [1] BEHAVIOURAL: multipart header injection ───────────────────────────────
function multipartInjection() {
  console.log('\n[1] BEHAVIOURAL — user input can no longer inject multipart headers');

  const BOUND = '----TestBoundary123';
  const AUDIO = Buffer.from('FAKEAUDIO');
  // A filename that closes its own part and appends a complete forged `model` field.
  const EVIL_FILENAME = 'clip.mp4"\r\n\r\npwned\r\n--' + BOUND +
    '\r\nContent-Disposition: form-data; name="model"\r\n\r\nEVIL-MODEL\r\n';
  const EVIL_MIME = 'audio/mp4\r\n\r\nx\r\n--' + BOUND +
    '\r\nContent-Disposition: form-data; name="model"\r\n\r\nEVIL-MODEL\r\n';

  // --- transcribe.js -----------------------------------------------------------
  const t = loadFns('transcribe.js', ['safeExt', 'safeMime', 'buildWhisperMultipart'], ['ALLOWED_MIME']);

  // CONTROL: the exact pre-fix derivation + raw interpolation.
  const badExt = (EVIL_FILENAME || 'audio.mp4').split('.').pop() || 'mp4';
  const controlBody = `--${BOUND}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3\r\n` +
    `--${BOUND}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\ntext\r\n` +
    `--${BOUND}\r\nContent-Disposition: form-data; name="file"; filename="upload.${badExt}"\r\nContent-Type: ${EVIL_MIME}\r\n\r\n`;
  check(controlBody.includes('EVIL-MODEL') && countField(controlBody, 'model') === 3,
    `CONTROL transcribe.js: pre-fix interpolation DOES inject (model fields seen: ${countField(controlBody, 'model')}, EVIL-MODEL present) — test discriminates`);

  const ext = t.safeExt(EVIL_FILENAME);
  const mime = t.safeMime(EVIL_MIME, ext);
  const fixed = t.buildWhisperMultipart(BOUND, 'whisper-large-v3', `upload.${ext}`, mime, AUDIO).toString('binary');
  check(!fixed.includes('EVIL-MODEL'), 'transcribe.js: forged `model` value absent from the built body');
  check(countField(fixed, 'model') === 1, `transcribe.js: exactly one \`model\` part (got ${countField(fixed, 'model')})`);
  check(countField(fixed, 'file') === 1, `transcribe.js: exactly one \`file\` part (got ${countField(fixed, 'file')})`);
  check(/^[a-z0-9]{1,8}$/.test(ext) && ext === 'mp4', `transcribe.js: safeExt() reduced a CRLF filename to "${ext}"`);
  check(t.safeExt('a.' + 'x'.repeat(50)) === 'xxxxxxxx' && t.safeExt('noextension') === 'noextens' && t.safeExt('') === 'mp4',
    'transcribe.js: safeExt() is length-bounded and always yields a safe token');
  check(!/[\r\n";]/.test(mime) && t.safeMime(EVIL_MIME, ext) === mime, `transcribe.js: safeMime() returned a whitelisted value "${mime}"`);
  // Sanity: legitimate input still passes through untouched.
  check(t.safeExt('holiday.WEBM') === 'webm' && t.safeMime('audio/webm', 'webm') === 'audio/webm',
    'transcribe.js: legitimate filename/mimeType still round-trip unchanged');
  check(t.safeMime('text/html', 'mp4') === 'audio/mp4', 'transcribe.js: a non-audio mimeType falls back to a derived allowed type');

  // --- transcribe-voice.js -----------------------------------------------------
  const v = loadFns('transcribe-voice.js', ['safeVoiceFormat', 'safeLanguage', 'buildVoiceMultipart'], ['VOICE_FORMATS']);
  const EVIL_FORMAT = 'webm"\r\n\r\nx\r\n--' + BOUND +
    '\r\nContent-Disposition: form-data; name="model"\r\n\r\nEVIL-MODEL\r\n';
  const EVIL_LANG = 'en\r\n--' + BOUND +
    '\r\nContent-Disposition: form-data; name="model"\r\n\r\nEVIL-MODEL\r\n';

  const controlVoice = `--${BOUND}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3\r\n` +
    `--${BOUND}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${EVIL_LANG}\r\n` +
    `--${BOUND}\r\nContent-Disposition: form-data; name="file"; filename="audio.${EVIL_FORMAT}"\r\nContent-Type: audio/webm\r\n\r\n`;
  check(controlVoice.includes('EVIL-MODEL') && countField(controlVoice, 'model') === 3,
    `CONTROL transcribe-voice.js: pre-fix interpolation DOES inject (model fields seen: ${countField(controlVoice, 'model')}) — test discriminates`);

  const fmt = v.safeVoiceFormat(EVIL_FORMAT);
  const lang = v.safeLanguage(EVIL_LANG);
  const vFixed = v.buildVoiceMultipart(BOUND, 'whisper-large-v3', `audio.${fmt}`, 'audio/webm', lang, AUDIO).toString('binary');
  check(!vFixed.includes('EVIL-MODEL'), 'transcribe-voice.js: forged `model` value absent from the built body');
  check(countField(vFixed, 'model') === 1, `transcribe-voice.js: exactly one \`model\` part (got ${countField(vFixed, 'model')})`);
  check(countField(vFixed, 'language') === 1, `transcribe-voice.js: exactly one \`language\` part (got ${countField(vFixed, 'language')})`);
  check(fmt === 'webm' && lang === 'en', `transcribe-voice.js: hostile format/language fell back to safe defaults ("${fmt}"/"${lang}")`);
  check(v.safeVoiceFormat('MP4') === 'mp4' && v.safeLanguage('et') === 'et',
    'transcribe-voice.js: legitimate format/language still accepted');
  check(v.safeVoiceFormat('__proto__') === 'webm' && v.safeVoiceFormat('constructor') === 'webm',
    'transcribe-voice.js: prototype keys do not slip through the format whitelist');
}

// ── [3] BEHAVIOURAL: PAA item missing `question` ──────────────────────────────
function paaGuard() {
  console.log('\n[3] BEHAVIOURAL — a malformed SerpAPI item no longer 500s the request');

  const src = read('people-also-ask.js');
  const START = 'const allQuestions = [];';
  const END = 'return true;\n    });';
  const s = src.indexOf(START), e = src.indexOf(END);
  if (s < 0 || e < 0) throw new Error('could not locate the PAA parse block in people-also-ask.js');
  const block = src.slice(s, e + END.length);
  const runFixed = new Function('results', `${block}\nreturn unique;`);

  // Everything SerpAPI could plausibly hand back that the old code could not survive.
  const results = [{
    keyword: 'electrolytes',
    status: 200,
    body: {
      related_questions: [
        { question: 'Do electrolytes break a fast?', snippet: 'yes', source: { name: 'Healthline' } },
        { snippet: 'no question field at all' },          // <- the crasher
        { question: null },
        { question: 42 },
        null,
        { question: 'Do electrolytes break a fast?' },     // duplicate → deduped
      ],
      related_searches: [{ query: 'best electrolyte powder' }, { }, null],
    },
  }];

  // CONTROL: the pre-fix block must throw on the same payload.
  const controlBlock = `
    const allQuestions = [];
    for (const response of results) {
      const keyword = response.keyword;
      if (response.status === 200 && response.body.related_questions) {
        for (const q of response.body.related_questions) {
          allQuestions.push({ question: q.question, snippet: q.snippet || '', source: (q.source && q.source.name) || 'Google', keyword });
        }
      }
    }
    const seen = new Set();
    const unique = allQuestions.filter(q => {
      const key = q.question.toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });`;
  let controlThrew = null;
  try { new Function('results', `${controlBlock}\nreturn unique;`)(results); }
  catch (err) { controlThrew = err; }
  check(controlThrew instanceof TypeError,
    `CONTROL: pre-fix parse block throws on the same payload (${controlThrew ? controlThrew.constructor.name + ': ' + controlThrew.message : 'DID NOT THROW'}) — test discriminates`);

  let out = null, threw = null;
  try { out = runFixed(results); } catch (err) { threw = err; }
  check(!threw, `fixed parse block does not throw${threw ? ' [' + threw.message + ']' : ''}`);
  check(Array.isArray(out), 'fixed parse block returns an array');
  if (Array.isArray(out)) {
    const qs = out.map(q => q.question);
    check(qs.length === 2, `only the two well-formed questions survive (got ${qs.length}: ${JSON.stringify(qs)})`);
    check(qs.includes('Do electrolytes break a fast?') && qs.includes('best electrolyte powder'),
      'both real questions are kept (the guard skips, it does not drop everything)');
    check(out.every(q => typeof q.question === 'string' && q.question.length > 0),
      'every surviving row has a non-empty string question');
  }

  // And an entirely absent body must be inert rather than a crash.
  let emptyThrew = null;
  try { runFixed([{ keyword: 'k', status: 200, body: {} }, { keyword: 'k2', status: 0 }]); }
  catch (err) { emptyThrew = err; }
  check(!emptyThrew, `empty / failed SerpAPI responses are inert${emptyThrew ? ' [' + emptyThrew.message + ']' : ''}`);
}

// ── [2] crawl-social: timeouts, budget arithmetic, error logging ──────────────
function crawlSocial() {
  console.log('\n[2] crawl-social — Apify socket timeouts, a budget that fits, and a diagnosable failure');
  const cs = read('crawl-social.js');

  check(/function apifyRequest\(method, path, token, body, timeoutMs\)/.test(cs),
    'STRUCTURAL: apifyRequest takes a timeoutMs');
  check(/timeout:\s*timeoutMs\s*\|\|/.test(cs), 'STRUCTURAL: the socket timeout is set on the request options');
  check(/req\.on\('timeout'/.test(cs), "STRUCTURAL: a 'timeout' handler destroys the socket (options.timeout alone only emits)");
  check(/console\.error\('crawl-social: apify /.test(cs), 'STRUCTURAL: apify responses are logged with status + body head');
  check(/resp\.statusCode >= 400 \|\| \(parsed && parsed\.error\)/.test(cs),
    'STRUCTURAL: an Apify ERROR body is detected, not silently resolved as a string');
  check(/console\.error\('crawl-social: no defaultDatasetId/.test(cs),
    'STRUCTURAL: the generic 502 now names the actor id it failed on');
  check(!/waitForFinish=110/.test(cs), 'STRUCTURAL: the old 110s Apify wait is gone');

  // BEHAVIOURAL-ish: the arithmetic is computed from the file's own constants and
  // compared against the real platform budget in vercel.json.
  const num = (name) => {
    const m = cs.match(new RegExp('const\\s+' + name + '\\s*=\\s*(\\d+)'));
    if (!m) throw new Error('constant ' + name + ' not found in crawl-social.js');
    return Number(m[1]);
  };
  const RUN = num('RUN_TIMEOUT_MS'), DS = num('DATASET_TIMEOUT_MS'), BUDGET = num('FN_BUDGET_MS');
  const LLM_MAX = num('LLM_MAX_MS'), LLM_MIN = num('LLM_MIN_MS'), WAIT_S = num('RUN_WAIT_S');
  const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const maxDurationMs = (vercel.functions['api/crawl-social.js'].maxDuration) * 1000;

  check(WAIT_S * 1000 <= RUN, `RUN_WAIT_S (${WAIT_S}s) sits inside its socket timeout (${RUN}ms)`);
  // Worst case: run timeout + dataset timeout + whatever the clamp leaves for the model.
  const llmWorst = Math.max(LLM_MIN, Math.min(LLM_MAX, BUDGET - (RUN + DS)));
  const worst = RUN + DS + llmWorst;
  check(worst <= BUDGET, `worst-case sum ${worst}ms fits the self-imposed budget ${BUDGET}ms (run ${RUN} + dataset ${DS} + llm ${llmWorst})`);
  check(BUDGET < maxDurationMs, `self-imposed budget ${BUDGET}ms is under vercel.json maxDuration ${maxDurationMs}ms`);
  check(worst <= maxDurationMs * 0.85,
    `worst case ${worst}ms leaves >=15% headroom under the ${maxDurationMs}ms platform budget (${Math.round(100 - worst / maxDurationMs * 100)}% spare)`);
  check(/timeoutMs:\s*llmMs/.test(cs) && /FN_BUDGET_MS - \(Date\.now\(\) - _t0\)/.test(cs),
    'STRUCTURAL: the LLM call spends only what is LEFT of the budget');
  check(!/timeoutMs:\s*100000/.test(cs), 'STRUCTURAL: the old fixed 100s LLM timeout is gone');
}

// ── [4] PostgREST path encoding ───────────────────────────────────────────────
function postgrestEncoding() {
  console.log('\n[4] STRUCTURAL — PostgREST filter values are encodeURIComponent\'d');
  const files = ['_usage.js', 'meme.js', 'pull-trends.js'];
  for (const f of files) {
    const src = read(f);
    // Any `eq.${` / `gte.${` / `lte.${` that is NOT immediately encodeURIComponent(.
    const raw = src.match(/(?:eq|gte|lte|neq|like|ilike)\.\$\{(?!encodeURIComponent\()/g) || [];
    check(raw.length === 0, `${f}: ${raw.length} un-encoded filter interpolation(s)`);
    const encoded = (src.match(/\$\{encodeURIComponent\(/g) || []).length;
    check(encoded > 0, `${f}: uses encodeURIComponent (${encoded} site(s)) — the check above is not vacuous`);
  }
}

// ── [5] stripe-webhook replay guard ───────────────────────────────────────────
function stripeReplay() {
  console.log('\n[5] STRUCTURAL — stripe-webhook rejects a stale replayed event');
  const sw = read('stripe-webhook.js');
  check(/MAX_EVENT_AGE_MS/.test(sw), 'a max event age is declared');
  check(/Number\(evt\.created\)/.test(sw), "the guard reads the event's own `created` timestamp");
  check(/ignored:\s*'stale event'/.test(sw), 'a stale event is acknowledged (200) and ignored');
  // Measure RUNTIME order, not file order. The plan write now lives in an applyPlan() helper
  // declared ABOVE the handler, so a naive whole-file index comparison reports a failure for
  // code that is correct — the helper is only ever CALLED from inside the handler, after the
  // guard has already returned. Slice the handler body and compare positions within it.
  const hAt = sw.indexOf('module.exports = async function handler');
  const body = hAt > 0 ? sw.slice(hAt) : '';
  const guardAt = body.indexOf('stale event');
  const planCall = body.search(/\b(?:applyPlan|usage\.setPlan)\s*\(/);
  check(hAt > 0 && guardAt > 0 && planCall > 0 && guardAt < planCall,
    'the guard runs BEFORE any plan write is reached inside the handler');
  check(/Number\.isFinite\(createdMs\)/.test(sw), 'a missing/garbage `created` is treated as stale, not as now');
}

// ── [6] remix input caps + google doc fetch ───────────────────────────────────
function remixCaps() {
  console.log('\n[6] STRUCTURAL — remix caps its relayed inputs and bounds the doc fetch');
  const rx = read('remix.js');
  check(/var MAX_DESC = \d+;/.test(rx), 'postDescription has an explicit cap constant');
  check(/postDescription\.length > MAX_DESC/.test(rx), 'the cap is actually applied to postDescription');
  check(/creatorName = String\([^)]*\)\.slice\(0, \d+\)/.test(rx), 'creatorName is coerced + capped');
  check(/platform = String\([^)]*\)\.slice\(0, \d+\)/.test(rx), 'platform is coerced + capped');
  check(/postUrl = String\([^)]*\)\.slice\(0, \d+\)/.test(rx), 'postUrl is coerced + capped');
  const capAt = rx.indexOf('MAX_DESC');
  const promptAt = rx.indexOf("'Description/concept: '");
  check(capAt > 0 && promptAt > 0 && capAt < promptAt, 'the cap is applied before the prompt is built');
  // The three Google-Doc checks that stood here (fetchGoogleDoc's socket timeout, its byte cap,
  // and the masterPromptContent 8000-char cap) were removed in v636: the Master Prompt feature
  // was retired, fetchGoogleDoc is deleted, and remix no longer fetches or caps that content.
}

// ── [7] expand-field coercion ─────────────────────────────────────────────────
function expandField() {
  console.log('\n[7] STRUCTURAL — expand-field coerces before dereferencing');
  const ef = read('expand-field.js');
  check(/const currentValue = String\(/.test(ef), 'currentValue is String()-coerced');
  check(!/\{ fieldName, fieldLabel, currentValue, brandContext \} = req\.body/.test(ef),
    'currentValue is no longer taken raw off the destructured body');
  const coerceAt = ef.indexOf('const currentValue = String(');
  const trimAt = ef.indexOf('currentValue.trim()');
  check(coerceAt > 0 && coerceAt < trimAt, 'the coercion happens before the first .trim()');
  check(/const fieldLabel = String\(/.test(ef), 'fieldLabel is coerced + capped before landing in the prompt');
  check(/hasOwnProperty\.call\(fieldInstructions, fieldName\)/.test(ef),
    'the fieldInstructions lookup is own-property only (constructor/__proto__ cannot resolve)');
}

// ── [M] module integrity ──────────────────────────────────────────────────────
function moduleIntegrity() {
  console.log('\n[M] every touched module still require()s with its handler intact');
  // @napi-rs/canvas ships no binding for this checkout's platform (environmental) — keep
  // the stub so any future module that pulls it in can still be loaded here.
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === '@napi-rs/canvas') {
      return { createCanvas: () => ({ getContext: () => ({}) }), GlobalFonts: { registerFromPath: () => false } };
    }
    return origLoad.call(this, request, ...rest);
  };
  const req = createRequire(import.meta.url);
  const handlers = ['transcribe', 'transcribe-voice', 'crawl-social', 'people-also-ask',
    'meme', 'stripe-webhook', 'remix', 'expand-field'];
  try {
    for (const f of handlers) {
      try {
        const m = req(path.join(API, f + '.js'));
        check(typeof m === 'function', `${f}.js exports a handler function (got ${typeof m})`);
      } catch (e) { fail(`${f}.js failed to require: ${e.message.split('\n')[0]}`); }
    }
    try {
      const u = req(path.join(API, '_usage.js'));
      check(['guard', 'checkLimit', 'logUsage', 'setPlan', 'getOrInitPlan', 'effectivePlan', 'stripeCustomerId', 'userIdByStripe']
        .every(k => typeof u[k] === 'function'), '_usage.js keeps every exported function');
    } catch (e) { fail('_usage.js failed to require: ' + e.message.split('\n')[0]); }
    // transcribe.js's Next.js-style config line must survive the refactor.
    try {
      const t = req(path.join(API, 'transcribe.js'));
      check(!!(t.config && t.config.api && t.config.api.bodyParser), 'transcribe.js keeps its module.exports.config');
    } catch (e) { fail('transcribe.js config check failed: ' + e.message.split('\n')[0]); }
  } finally {
    Module._load = origLoad;
  }
}

// ── run ───────────────────────────────────────────────────────────────────────
try {
  multipartInjection();
  paaGuard();
  crawlSocial();
  postgrestEncoding();
  stripeReplay();
  remixCaps();
  expandField();
  moduleIntegrity();
} catch (e) {
  failures++;
  console.log('  FAIL harness error: ' + ((e && e.stack) || e));
}

if (failures) {
  console.log(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('\nbackend hardening verification passed');
process.exit(0);
