#!/usr/bin/env node
// Verification for the backend defect fixes.
//
//   node scripts/verify/backend-fixes.mjs
//
// Prints "backend fixes verification passed" as its LAST line only when every
// assertion holds; exits non-zero otherwise.
//
// WHAT IS PROVEN HOW
//  1. Never-settling promises (crawl-brand fetchJina/fetchPage, _trends
//     fetchNewsRss/apifyReq, extract-article fetchPage) — BEHAVIOURAL. A real local
//     http server streams MORE than each function's cap and never ends the response,
//     the ACTUAL function source is loaded from disk and executed against it, and we
//     assert the returned promise SETTLES inside a deadline. A control case runs the
//     pre-fix pattern against the same server and must NOT settle — proving the test
//     discriminates rather than passing vacuously.
//  2. Usage logging (video-beats, hook-frame) — STRUCTURAL (source assertions).
//  3. Cron failure logging + failed/skipped split — STRUCTURAL (source assertions).
//  4. extract-article content-type guard — STRUCTURAL; its size cap is behavioural (1).

import { StringDecoder as StringDecoderReal } from 'node:string_decoder';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../api');
const SETTLE_DEADLINE_MS = 4000;   // every internal timeout in the code under test is >= 10s
const HANG_PROOF_MS = 3000;        // control: pre-fix code must still be pending after this

let failures = 0;
const pass = (m) => console.log('  ok   ' + m);
const fail = (m) => { failures++; console.log('  FAIL ' + m); };
const check = (cond, m) => cond ? pass(m) : fail(m);

// ── helpers ───────────────────────────────────────────────────────────────────
const read = (f) => fs.readFileSync(path.join(API, f), 'utf8');

// Pull a named function's real source out of a file (brace matched). Reading from
// disk is deliberate: if the fix is reverted, these tests execute the reverted code.
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

const requireStub = (id) => {
  if (String(id).includes('_safeurl')) return { assertPublicHttpUrl: async () => {} };
  if (id === 'string_decoder') return { StringDecoder: StringDecoderReal }; // v690 _utf8 helper
  throw new Error('unexpected require() in test scope: ' + id);
};

// Module-level `const NAME = ...;` a function under test closes over.
function extractConst(src, name, file) {
  const m = src.match(new RegExp('^const\\s+' + name + '\\s*=[^;]*;', 'm'));
  if (!m) throw new Error(`const ${name} not found in ${file}`);
  return m[0];
}

function loadFns(file, names, consts = []) {
  const src = read(file);
  const fns = names.map(n => extractFn(src, n, file));
  // v690 — the fetchers now decode through a module-level _utf8(resp, c) helper; lift it too.
  const helper = src.match(/^function _utf8\(resp, c\) \{[^\n]*\}$/m);
  const body = [
    ...consts.map(c => extractConst(src, c, file)),
    ...(helper && fns.some(f => f.includes('_utf8(')) ? [helper[0]] : []),
    ...fns,
  ].join('\n');
  return new Function('https', 'http', 'require', 'console',
    `${body}\nreturn { ${names.join(', ')} };`)(https, http, requireStub, console);
}

// Streams `totalBytes` then goes quiet FOREVER — never calls res.end(). So the only
// way a caller can settle is its own cap branch.
function startStreamServer(totalBytes) {
  const CHUNK = 'x'.repeat(64 * 1024);
  const srv = http.createServer((req, res) => {
    req.resume();
    res.on('error', () => {});
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    let sent = 0;
    const pump = () => {
      if (res.destroyed || !res.writable || sent >= totalBytes) return;
      sent += CHUNK.length;
      if (res.write(CHUNK)) setImmediate(pump); else res.once('drain', pump);
    };
    pump();
  });
  srv.on('clientError', () => {});
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}

// Redirect every https call in the code under test to the local server.
const realRequest = https.request, realGet = https.get;
function patchHttps(port) {
  https.request = function (a, b, c) {
    const optsIsObj = a && typeof a === 'object' && !(a instanceof URL);
    const opts = optsIsObj ? a : (b && typeof b === 'object' ? b : {});
    const cb = typeof b === 'function' ? b : (typeof c === 'function' ? c : undefined);
    return http.request({
      hostname: '127.0.0.1', port, path: '/',
      method: opts.method || 'GET', headers: opts.headers, timeout: opts.timeout,
    }, cb);
  };
  https.get = function (a, b, c) { const r = https.request(a, b, c); r.end(); return r; };
}
function unpatchHttps() { https.request = realRequest; https.get = realGet; }

const why = (r) => r.settled ? (r.ok ? '' : ` [rejected: ${(r.e && r.e.message) || r.e}]`) : ' [NEVER SETTLED]';

async function settlesWithin(label, fn, ms) {
  const t0 = Date.now();
  const HANG = Symbol('hang');
  let timer;
  const res = await Promise.race([
    Promise.resolve().then(fn).then(v => ({ ok: true, v }), e => ({ ok: false, e })),
    new Promise(r => { timer = setTimeout(() => r(HANG), ms); }),
  ]);
  clearTimeout(timer);
  if (res === HANG) return { settled: false, ms: Date.now() - t0 };
  return { settled: true, ms: Date.now() - t0, ...res };
}

// ── 1. BEHAVIOURAL: capped fetchers must settle ───────────────────────────────
async function behavioural() {
  console.log('\n[1] BEHAVIOURAL — capped fetchers settle instead of hanging');

  const { srv, port } = await startStreamServer(5 * 1024 * 1024); // > the largest cap (4MB)
  patchHttps(port);
  try {
    // control: the exact pre-fix pattern (destroy at the cap, no resolve) must HANG.
    const control = await settlesWithin('control', () => new Promise((resolve, reject) => {
      https.get('https://example.com/', { timeout: 25000 }, (resp) => {
        let data = '';
        resp.setEncoding('utf8');
        resp.on('data', c => { data += c; if (data.length > 200000) resp.destroy(); }); // <- the bug
        resp.on('end', () => resolve(data));
        resp.on('error', reject);
      }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
    }), HANG_PROOF_MS);
    check(!control.settled,
      `CONTROL: pre-fix pattern still unsettled after ${HANG_PROOF_MS}ms (test discriminates)`);

    const cb = loadFns('crawl-brand.js', ['fetchJina', 'fetchPage']);
    const jina = await settlesWithin('fetchJina', () => cb.fetchJina('https://example.com/'), SETTLE_DEADLINE_MS);
    check(jina.settled && jina.ok && typeof jina.v === 'string' && jina.v.length > 200000,
      `crawl-brand fetchJina settled in ${jina.ms}ms with ${jina.settled && jina.ok ? String(jina.v).length : 0} truncated chars${why(jina)}`);

    const cbp = await settlesWithin('fetchPage', () => cb.fetchPage('https://example.com/'), SETTLE_DEADLINE_MS);
    check(cbp.settled && cbp.ok && typeof cbp.v === 'string' && cbp.v.length > 200000,
      `crawl-brand fetchPage settled in ${cbp.ms}ms with ${cbp.settled && cbp.ok ? String(cbp.v).length : 0} truncated chars${why(cbp)}`);

    const tr = loadFns('_trends.js',
      ['fetchNewsRss', 'apifyReq', 'parseRssItems', 'decodeEntities', 'newsWhen', 'clampWindow'],
      ['DEFAULT_WINDOW_HOURS', 'ALLOWED_WINDOW_HOURS']);
    const news = await settlesWithin('fetchNewsRss', () => tr.fetchNewsRss('anything', 48), SETTLE_DEADLINE_MS);
    check(news.settled && news.ok && news.v && Array.isArray(news.v.items),
      `_trends fetchNewsRss settled in ${news.ms}ms with an items array${why(news)}`);

    const apify = await settlesWithin('apifyReq', () => tr.apifyReq('GET', '/v2/x', 'tok', null), SETTLE_DEADLINE_MS);
    check(apify.settled && apify.ok && apify.v === null,
      `_trends apifyReq settled in ${apify.ms}ms (null — truncated JSON is unparseable, per its contract)${why(apify)}`);

    const ea = loadFns('extract-article.js', ['fetchPage']);
    const eap = await settlesWithin('extract fetchPage', () => ea.fetchPage('https://example.com/'), SETTLE_DEADLINE_MS);
    check(eap.settled && eap.ok && typeof eap.v === 'string' && eap.v.length > 1_000_000,
      `extract-article fetchPage settled in ${eap.ms}ms with ${eap.settled && eap.ok ? String(eap.v).length : 0} chars (capped, not unbounded)${why(eap)}`);
  } finally {
    unpatchHttps();
    srv.close();
    srv.closeAllConnections?.();
  }
}

// ── 2-4. STRUCTURAL ───────────────────────────────────────────────────────────
function structural() {
  console.log('\n[2] STRUCTURAL — metered actions are recorded');
  const vb = read('video-beats.js');
  check(/logUsage\(\{[^}]*action:\s*'beats'/s.test(vb), "video-beats.js calls logUsage with action 'beats'");
  check(vb.indexOf("guard(req, 'beats')") < vb.indexOf('logUsage('), 'video-beats.js logs usage after the guard');
  check(vb.indexOf('logUsage(') < vb.lastIndexOf('secondsPerBeat: 3.25'), 'video-beats.js logs usage before returning 200');

  const hf = read('hook-frame.js');
  check(/logUsage\(\{[^}]*action:\s*'hookframe'/s.test(hf), "hook-frame.js calls logUsage with action 'hookframe'");
  check(/if \(out\) \{[\s\S]{0,600}logUsage\(/.test(hf), 'hook-frame.js only logs when a read was actually produced (no charge for misses)');

  console.log('\n[3] STRUCTURAL — cron failures are logged and counted separately');
  const cron = read('pull-trends-cron.js');
  check(!/catch\s*\(e\)\s*\{\s*skipped\+\+;\s*\}/.test(cron), 'pull-trends-cron.js no longer swallows per-brand errors into skipped');
  check(/catch\s*\(e\)\s*\{[\s\S]{0,300}failed\+\+/.test(cron), 'pull-trends-cron.js increments a separate `failed` counter');
  check(/console\.error\([^)]*pull-trends-cron: brand[\s\S]{0,200}b\.id/.test(cron), 'pull-trends-cron.js logs the brand id in the catch');
  check(/console\.error\([\s\S]{0,200}e && e\.message/.test(cron), 'pull-trends-cron.js logs the error message in the catch');
  // v670: these two used to match the literal inline shape
  // `heartbeat('...', h, { considered, updated, skipped, failed, ranOut })`. When the cron grew
  // per-lane counts and skip REASONS, those fields moved into a named `_meta` object and both
  // assertions failed while `failed` was still being reported — a gate failing on formatting, which
  // is worse than useless because it trains you to ignore it. Check the FACT instead: whatever
  // object the heartbeat and the response are built from must carry `failed` and `skipped`.
  const cronMeta = (cron.match(/const _meta = \{[\s\S]*?\};/) || [])[0] ||
                   (cron.match(/heartbeat\([^,]+,[^,]+,\s*(\{[\s\S]*?\})\s*\)/) || [])[1] || '';
  check(/\bfailed\b/.test(cronMeta) && /\bskipped\b/.test(cronMeta),
    'pull-trends-cron.js reports `failed` and `skipped` in what the heartbeat records');
  check(/heartbeat\('pull-trends-cron'[^)]*\)/.test(cron),
    'pull-trends-cron.js still writes a heartbeat');
  const cronResp = (cron.match(/return res\.status\(200\)\.json\(([\s\S]*?)\);/) || [])[1] || '';
  check(/\bfailed\b|_meta/.test(cronResp),
    'pull-trends-cron.js returns `failed` alongside `skipped` in its response');

  console.log('\n[4] STRUCTURAL — extract-article guards its response');
  const ea = read('extract-article.js');
  check(/content-type/i.test(ea) && /resp\.headers\['content-type'\]/.test(ea), 'extract-article.js checks Content-Type');
  check(/text\\\/\|html\|xml\|json/.test(ea) || /\/\^text\\\//.test(ea), 'extract-article.js rejects non-text payloads');
  check(/MAX_CHARS\s*=\s*2_000_000/.test(ea), 'extract-article.js declares an explicit size cap');

  console.log('\n[+] STRUCTURAL — the caps themselves are still in place');
  const cb = read('crawl-brand.js');
  check((cb.match(/data\.length > 200000/g) || []).length === 2, 'crawl-brand.js keeps both 200KB caps');
  const tr = read('_trends.js');
  check(/bytes > 2_000_000/.test(tr) && /bytes > 4_000_000/.test(tr), '_trends.js keeps the 2MB + 4MB caps');
  check((tr.match(/const done = \(v\) =>/g) || []).length === 2, '_trends.js settles once per capped fetcher');
}

// ── run ───────────────────────────────────────────────────────────────────────
try {
  await behavioural();
  structural();
} catch (e) {
  failures++;
  console.log('  FAIL harness error: ' + (e && e.stack || e));
}

if (failures) {
  console.log(`\n${failures} assertion(s) FAILED`);
  process.exit(1);
}
console.log('\nbackend fixes verification passed');
process.exit(0);
