#!/usr/bin/env node
// GATE rv-llm-3 (v690 review): dictation (api/transcribe-voice.js) answers with OUR message
// inside its platform budget, and returns the words exactly as spoken.
//
// WHY: maxDuration was 30s while the Whisper socket waited up to 50s of SILENCE — and an upload
// or reply that kept trickling bytes never tripped that idle timer at all. The platform killed
// the function first, so the app got Vercel's 504 page and printed the JSON parse error. The
// reply was also decoded one network chunk at a time, so "õ" split across two chunks came back
// as two replacement marks in the user's dictated text.
//
// HOW: the REAL handler runs with node:https replaced by an in-memory Groq whose socket idle timer
// re-arms on every byte (like a real one). To keep the gate fast, the source is compiled with only
// the WHISPER_TOTAL_MS number shrunk; the code path is the file's own.
// RUN: node scripts/verify/rv-llm-3.mjs      EXPECT: "PASS", exit 0.
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import Module from 'node:module';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const require_ = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const API = path.join(ROOT, 'api');
const WALL = setTimeout(() => { console.log('FAIL: rv-llm-3 wall clock (30s) — something hung'); process.exit(1); }, 30000);
let failed = 0;
const ok = (c, m) => { if (c) console.log('ok: ' + m); else { console.log('FAIL: ' + m); failed++; } };

const FILE = path.join(API, 'transcribe-voice.js');
const src = fs.readFileSync(FILE, 'utf8');
const m = src.match(/const WHISPER_TOTAL_MS = (\d+);/);
ok(!!m, 'transcribe-voice.js declares one WHISPER_TOTAL_MS total limit');
if (!m) { console.log('1 failure(s)'); process.exit(1); }

// ── the budget arithmetic, from the real files ──
const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const maxMs = ((vercel.functions['api/transcribe-voice.js'] || {}).maxDuration || 10) * 1000;
const sb = +((fs.readFileSync(path.join(API, '_usage.js'), 'utf8').match(/let\s+SB_TIMEOUT_MS\s*=\s*(\d+)/) || [0, 8000])[1]);
ok(+m[1] + sb <= maxMs, 'Whisper total ' + m[1] + 'ms + the usage write ' + sb + 'ms fit maxDuration ' + maxMs + 'ms');

// ── stubs ──
const stubMod = (rel, exports) => { const f = require_.resolve(path.join(API, rel)); const x = new Module(f); x.filename = f; x.loaded = true; x.exports = exports; require_.cache[f] = x; };
stubMod('_usage.js', { guard: async () => ({ user: { id: 'u-test' }, over: false }), denyResponse: (r) => r.status(402).json({}), logUsage: async () => {} });
process.env.GROQ_API_KEY = 'test-only-not-a-real-key';
const https = require_('https');
let behave = null;
https.request = (opts, cb) => {
  const req = new EventEmitter();
  let idle = null, idleFn = null, idleMs = 0, dead = false;
  const arm = () => { if (idle) clearTimeout(idle); idle = (idleFn && !dead) ? setTimeout(idleFn, idleMs) : null; };
  const kill = () => { dead = true; if (idle) clearTimeout(idle); };
  req.setTimeout = (ms, fn) => { idleMs = ms; idleFn = fn; arm(); return req; };
  req.write = () => {};
  req.destroy = (e) => { if (dead) return; kill(); if (e) setImmediate(() => req.emit('error', e)); };
  req.end = () => setTimeout(() => {
    const resp = new EventEmitter(); resp.statusCode = 200; resp.headers = { 'content-type': 'application/json' }; resp.complete = false;
    cb(resp);
    behave({ resp, arm, kill, dead: () => dead });
  }, 1);
  return req;
};
// compile the real source with only the limit shrunk
const small = src.replace(/const WHISPER_TOTAL_MS = \d+;/, 'const WHISPER_TOTAL_MS = 1200;');
const mod = new Module(FILE); mod.filename = FILE; mod.paths = Module._nodeModulePaths(API);
mod._compile(small, FILE);
const handler = mod.exports;
const call = async () => {
  const res = { statusCode: 0, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
  const t0 = Date.now();
  const done = await Promise.race([handler({ method: 'POST', headers: {}, body: { audio: Buffer.from('fake-audio').toString('base64'), format: 'webm' } }, res).then(() => 'done'),
                                   new Promise(r => setTimeout(() => r('__HUNG__'), 4000))]);
  return { res, ms: Date.now() - t0, hung: done === '__HUNG__' };
};

// T1 — a reply that trickles forever
{
  behave = (x) => { const h = setInterval(() => { if (x.dead()) return clearInterval(h); x.arm(); x.resp.emit('data', Buffer.from(' ')); }, 100); };
  const r = await call();
  ok(!r.hung && r.res.statusCode === 502 && r.ms < 2500, 'T1: a Whisper reply trickling bytes forever ends at the total limit with our own 502 (' + (r.hung ? 'hung' : r.ms + 'ms, status ' + r.res.statusCode) + ')');
}
// T2 — a connection dropped mid-reply
{
  behave = (x) => { setTimeout(() => { x.resp.emit('data', Buffer.from('{"te')); x.kill(); x.resp.emit('close'); }, 5); };
  const r = await call();
  ok(!r.hung && r.res.statusCode === 502 && r.ms < 1000, 'T2: a reply dropped mid-body answers at once with our 502 (' + (r.hung ? 'hung' : r.ms + 'ms') + ')');
}
// T3 — the opposite: a normal reply, split mid-letter, arrives exactly
{
  const whole = Buffer.from(JSON.stringify({ text: 'Tõnu ütles tere 😀' }));
  const cut = whole.indexOf(Buffer.from('õ')) + 1;
  behave = (x) => { setTimeout(() => { x.resp.emit('data', whole.subarray(0, cut)); x.resp.emit('data', whole.subarray(cut)); x.resp.complete = true; x.resp.emit('end'); x.resp.emit('close'); }, 5); };
  const r = await call();
  ok(!r.hung && r.res.statusCode === 200 && r.res.body && r.res.body.text === 'Tõnu ütles tere 😀', 'T3: dictated text split mid-letter across chunks arrives intact (' + JSON.stringify(r.res.body) + ')');
}

// T4 (v690 r2) — transcribe-url's provider lookup (fetchJson) passes the SSRF-checking DNS lookup
// on EVERY hop, like downloadFile and crawl-brand. Without it only the NAME is checked before the
// request, so a DNS answer that changes in between (rebinding) could reach an internal address.
{
  const SENTINEL = function safeLookupSentinel() {};
  stubMod('_safeurl.js', { assertPublicHttpUrl: async () => true, safeLookup: SENTINEL, urlRefusalMessage: (e, d) => d, isBlockedUrlSync: () => false });
  const TU = path.join(API, 'transcribe-url.js');
  const tu = new Module(TU); tu.filename = TU; tu.paths = Module._nodeModulePaths(API);
  tu._compile(fs.readFileSync(TU, 'utf8') + '\nmodule.exports.__fetchJson = fetchJson;\n', TU);
  const seen = [];
  const prev = https.request;
  https.request = (opts, cb) => {
    seen.push({ path: opts.path, lookup: opts.lookup });
    const req = new EventEmitter(); req.write = () => {}; req.setTimeout = () => req; req.destroy = () => {};
    req.end = () => setImmediate(() => {
      const resp = new EventEmitter(); resp.resume = () => resp; resp.headers = {};
      if (opts.path === '/first') { resp.statusCode = 302; resp.headers.location = 'https://provider.test/next'; cb(resp); return; }
      resp.statusCode = 200; resp.headers['content-type'] = 'application/json'; cb(resp);
      resp.emit('data', Buffer.from('{"ok":1}')); resp.emit('end');
    });
    return req;
  };
  let out = null, err = null;
  try { out = await Promise.race([tu.exports.__fetchJson('https://provider.test/first', { timeoutMs: 3000 }), new Promise((_, j) => setTimeout(() => j(new Error('hung')), 3500))]); } catch (e) { err = e; }
  https.request = prev;
  ok(out && out.ok === 1, 'T4 opposite: a redirected provider lookup still returns its JSON (' + (err ? err.message : JSON.stringify(out)) + ')');
  ok(seen.length === 2 && seen.every(x => x.lookup === SENTINEL), 'T4: every hop (' + seen.map(x => x.path).join(', ') + ') connects through _safeurl.safeLookup (' + seen.map(x => x.lookup === SENTINEL).join(',') + ')');
}

clearTimeout(WALL);
if (failed) { console.log(failed + ' failure(s)'); process.exit(1); }
console.log('PASS — rv-llm-3: dictation ends inside its budget with our own message, and keeps every letter');
process.exit(0);
