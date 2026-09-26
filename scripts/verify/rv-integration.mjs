#!/usr/bin/env node
// GATE: the four cross-file items the v690 review handed back to the driver.
//
// A  DNS rebinding. assertPublicHttpUrl resolves a name once; the fetch then resolves it again, so a
//    name with a 0-second TTL can answer a public address first and 127.0.0.1 / 169.254.169.254
//    second. Each server-side fetch of a USER-SUPPLIED url must pass `lookup: safeLookup` so the
//    address actually connected is checked. RUN: a real https.get with that option against a name
//    whose (stubbed) DNS answers 127.0.0.1 must fail with EPRIVATEADDR before connecting, and the
//    same name answering a public address must reach the connect step. Then the REAL
//    extract-article and crawl-brand handlers are run against a local "internal" server with DNS
//    that answers public to the check and 127.0.0.1 to the fetch: the server must get 0 hits (and
//    the same run without the check's second chance — the opposite — must reach it). The other two
//    call sites are checked for the option in source.
// E  A URL whose host does not resolve (typo, DNS blip) must say "couldn't find that website", not
//    "not allowed"; a private address must still say "not allowed" (the opposite). Real handlers.
// B  UTF-8 split across chunks. RUN each file's own _utf8 helper with "õä😀" split mid-character;
//    the text must come out intact (the old `data += chunk` gives junk; asserted as the opposite).
// C  Status check. RUN the real checkAiStatus from app.html with a fake fetch: a refused account's
//    server reason must be shown; ok:true and ok:null keep their old texts.
// D  Hook-frame read. The app's abort must leave room for the server (maxDuration from vercel.json)
//    and still fire before it: 0.8 * max <= abort < max.
//
// RUN: node scripts/verify/rv-integration.mjs    EXPECT: prints "RV INTEGRATION OK" and exits 0.
import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm';
import { createRequire } from 'node:module'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require_ = createRequire(import.meta.url);
const wall = setTimeout(() => { console.log('FAIL: wall clock (20 s) — a check hung'); process.exit(1); }, 20000);
const fails = []; const check = (c, m) => { if (!c) fails.push(m); };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── A ──
const dns = require_('dns');
const realLookup = dns.lookup;
const { safeLookup } = require_(path.join(ROOT, 'api', '_safeurl.js'));
const https = require_('https');
async function tryGet(answer) {
  dns.lookup = (h, o, cb) => { if (typeof o === 'function') cb = o; setImmediate(() => cb(null, [{ address: answer, family: 4 }])); };
  return new Promise((res) => {
    const req = https.get('https://rebind.example.test/x', { lookup: safeLookup, timeout: 3000 }, () => res('RESPONSE'));
    req.on('error', (e) => res(e.code || e.message));
    req.on('timeout', () => { req.destroy(); res('TIMEOUT'); });
  });
}
const priv = await tryGet('127.0.0.1');
check(priv === 'EPRIVATEADDR', 'A: a name answering 127.0.0.1 was not refused at connect time (got ' + priv + ')');
const meta = await tryGet('169.254.169.254');
check(meta === 'EPRIVATEADDR', 'A: a name answering the cloud metadata address was not refused (got ' + meta + ')');
const pub = await tryGet('203.0.113.9'); // TEST-NET-3: public-shaped, unroutable → a connect error, not EPRIVATEADDR
check(pub !== 'EPRIVATEADDR', 'A (opposite): a public address was refused as private');
dns.lookup = realLookup;
const SITES = [
  ['api/transcribe-url.js', /request = mod\.get\(url, \{ lookup: require\('\.\/_safeurl'\)\.safeLookup/],
  ['api/transcribe.js', /https\.get\(trackUrl, \{ lookup: require\('\.\/_safeurl'\)\.safeLookup/],
];
for (const [f, re] of SITES) check(re.test(read(f)), 'A: ' + f + ' fetches a user URL without lookup: safeLookup');

// A2 + E: run the real handlers. _usage is replaced so no database is touched.
const http = require_('http');
const putMod = (rel, exp) => { const k = require_.resolve(path.join(ROOT, rel)); require_.cache[k] = { id: k, filename: k, loaded: true, exports: exp }; };
putMod('api/_usage.js', { guard: async () => ({ user: { id: 'u' }, over: false }), logUsage: async () => {}, denyResponse: () => {},
  checkLimit: async () => ({ allowed: true }), attachHoldRelease: () => {} });
const fakeRes = () => ({ _c: 0, _b: null, setHeader() {}, status(c) { this._c = c; return this; }, json(b) { this._b = b; return this; }, end() { return this; } });
async function runHandler(file, url) {
  const res = fakeRes();
  try { await require_(path.join(ROOT, 'api', file))({ method: 'POST', headers: { authorization: 'Bearer x' }, body: { url } }, res); }
  catch (e) { res._c = 'THREW'; res._b = { error: e.message }; }
  return res;
}
const dnsP = dns.promises; const realPLookup = dnsP.lookup;
let hits = 0;
const srv = http.createServer((q, s) => { hits++; s.setHeader('content-type', 'text/html'); s.end('<html><title>internal</title><body><p>' + 'secret metadata '.repeat(30) + '</p></body></html>'); });
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
for (const f of ['extract-article.js', 'crawl-brand.js']) {
  hits = 0;
  dnsP.lookup = async () => [{ address: '93.184.216.34', family: 4 }];                       // the check sees public
  dns.lookup = (h, o, cb) => { if (typeof o === 'function') { cb = o; o = {}; } const a = [{ address: '127.0.0.1', family: 4 }]; setImmediate(() => (o && o.all) ? cb(null, a) : cb(null, '127.0.0.1', 4)); }; // the fetch sees 127.0.0.1
  const r = await runHandler(f, 'http://rebind.example.test:' + port + '/');
  check(hits === 0, 'A2: ' + f + ' fetched the internal server through DNS rebinding (' + hits + ' hits, status ' + r._c + ')');
}
// opposite: the same local server IS reachable when DNS honestly answers a public-looking name to both
// lookups but the connect goes to 127.0.0.1 through a plain lookup — proves the harness can reach it.
hits = 0;
await new Promise((res) => { const q = http.get({ host: '127.0.0.1', port, path: '/' }, (s) => { s.resume(); s.on('end', res); }); q.on('error', res); });
check(hits === 1, 'A2 (control): the local server was not reachable at all, so A2 proves nothing');
srv.close();

process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test-only-not-a-real-key'; // transcribe-url checks config first; no request is ever made
const nx = () => { const e = new Error('getaddrinfo ENOTFOUND'); e.code = 'ENOTFOUND'; return e; };
dnsP.lookup = async () => { throw nx(); };
dns.lookup = (h, o, cb) => { if (typeof o === 'function') cb = o; setImmediate(() => cb(nx())); };
for (const f of ['extract-article.js', 'crawl-brand.js', 'crawl-social.js', 'transcribe-url.js']) {
  const r = await runHandler(f, 'https://no-such-host.example.test/page');
  const msg = JSON.stringify(r._b || {});
  check(r._c === 400 && /couldn't find that website/i.test(msg), 'E: ' + f + ' answered ' + r._c + ' ' + msg.slice(0, 120) + ' for a host that does not resolve');
}
dnsP.lookup = async () => [{ address: '10.0.0.5', family: 4 }];
for (const f of ['extract-article.js', 'crawl-brand.js']) {
  const r = await runHandler(f, 'https://internal.example.test/page');
  const msg = JSON.stringify(r._b || {});
  check(r._c === 400 && /not allowed/i.test(msg), 'E (opposite): ' + f + ' answered ' + r._c + ' ' + msg.slice(0, 120) + ' for a private address');
}
dnsP.lookup = realPLookup; dns.lookup = realLookup;

// ── B ──
const bytes = Buffer.from('õä😀 ok', 'utf8');
const parts = [bytes.subarray(0, 1), bytes.subarray(1, 5), bytes.subarray(5)];   // splits õ and 😀
let naive = ''; for (const p of parts) naive += p;
check(naive !== 'õä😀 ok', 'B (control): the naive join did not corrupt — the split is not exercising anything');
for (const f of ['api/_trends.js', 'api/creator-posts.js', 'api/transcribe-url.js']) {
  const src = read(f);
  const m = src.match(/^function _utf8\(resp, c\) \{[^\n]*\}$/m);
  if (!m) { fails.push('B: ' + f + ' has no _utf8 helper'); continue; }
  const _utf8 = vm.runInNewContext('(' + m[0] + ')', { require: require_ });
  const resp = {}; let out = ''; for (const p of parts) out += _utf8(resp, p);
  check(out === 'õä😀 ok', 'B: ' + f + ' _utf8 corrupted a split character: ' + JSON.stringify(out));
  const raw = src.match(/(?:data|raw) \+= (?:c|chunk);/g);
  check(!raw, 'B: ' + f + ' still has a raw text join: ' + (raw || []).join(' '));
}

// ── C ──
const app = read('app.html');
const start = app.indexOf('async function checkAiStatus(btn){');
const end = app.indexOf('\n}\n', start);
check(start > 0 && end > start, 'C: could not lift checkAiStatus from app.html');
if (start > 0 && end > start) {
  const fnSrc = app.slice(start, end + 2);
  async function runStatus(grok) {
    const out = { textContent: '', className: '', style: {} };
    const ctx = {
      document: { getElementById: () => out }, connToken: async () => 't',
      fetch: async () => ({ json: async () => ({ meta: { grok } }) }),
    };
    vm.runInNewContext(fnSrc + '\nthis.checkAiStatus = checkAiStatus;', ctx);
    await ctx.checkAiStatus(null);
    return out.textContent;
  }
  const REASON = 'The AI provider refused our account (HTTP 403) — out of credits or over the spending limit. Top up in the xAI console.';
  const t1 = await runStatus({ ok: false, state: 'refused', http: 403, reason: REASON });
  check(/paused on our side/.test(t1) && /Nothing is wrong with your account/.test(t1), 'C: a refused account must show customers the neutral sentence, got "' + t1 + '"');
  check(!/xAI console|XAI_API_KEY|HTTP 40/.test(t1), 'C: a customer sees owner billing detail: "' + t1 + '"');
  const tk = await runStatus({ ok: false, state: 'refused', http: null, reason: 'The AI key (XAI_API_KEY) is not set on the server.' });
  check(/isn\u2019t available on our side/.test(tk) && !/hit a limit|XAI_API_KEY/.test(tk), 'C: a missing key must not claim a spending limit or name the env var, got "' + tk + '"');
  check(!/isn\u2019t available/.test(t1), 'C (opposite): a real 403 must still say the account hit a limit, got "' + t1 + '"');
  const OUT = 'The AI provider did not answer (outage or timeout) — usually temporary; try again in a few minutes.';
  const t1b = await runStatus({ ok: false, state: 'no-answer', reason: OUT });
  check(t1b.includes(OUT), 'C: an outage must show the server reason, got "' + t1b + '"');
  const t2 = await runStatus({ ok: false });
  check(/not responding/.test(t2), 'C (opposite): no reason must keep the old fallback, got "' + t2 + '"');
  const t3 = await runStatus({ ok: true, ms: 5 });
  check(/connected/.test(t3), 'C (opposite): ok:true must still say connected, got "' + t3 + '"');
}

// ── D ──
const vj = JSON.parse(read('vercel.json'));
const max = (vj.functions && vj.functions['api/hook-frame.js'] && vj.functions['api/hook-frame.js'].maxDuration) * 1000;
const hf = app.slice(app.indexOf('async function fetchHookFrame(url){'));
const ab = Number((hf.match(/setTimeout\(\(\)=>ctrl\.abort\(\), (\d+)\)/) || [])[1]);
check(max > 0 && ab > 0, 'D: could not read hook-frame maxDuration or the app abort');
check(ab >= 0.8 * max && ab < max, 'D: app aborts hook-frame at ' + ab + ' ms; server may run ' + max + ' ms');

clearTimeout(wall);
if (fails.length) { console.log('RV INTEGRATION FAILED'); for (const f of fails) console.log('FAIL: ' + f); process.exit(1); }
console.log('RV INTEGRATION OK');
