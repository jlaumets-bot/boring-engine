#!/usr/bin/env node
// GATE: Quick Post must not upload data the server never reads, and must not give up
// before the server does.
//
// WHY THIS EXISTS — a real failure, diagnosed from the Vercel logs on 2026-08-27:
//   Jörgen tapped Quick Post and got "Timed out — tap to try again". The logs showed
//   /api/generate-ideas returned 200 at 04:17:20. The server WROTE the post. The phone
//   had already stopped waiting.
//
//   Two causes, both here:
//   1. getApprovedExamples() sent `hook` (<=200) and `body` (<=1400) per example. api/_brain.js
//      reads ONLY text/format/title — measured ~2.2KB of dead weight per generate with realistic
//      content, which at his 0.06 KB/s is ~35s of pure waste. The examples alone took ~74s to
//      upload against a 90s timeout.
//   2. The client aborted at 90s while api/generate-ideas has maxDuration 300 — giving up on work
//      the server was still legitimately doing.
//
// RUN:    node scripts/verify/request-payload.mjs
// EXPECT: prints "PASS: request-payload" and exits 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
const fails = [];
const check = (n, c, d) => { if (!c) fails.push(n + (d ? ' — ' + d : '')); };

// ── 1. The example payload carries only what the server reads ────────────────
// Behavioural: lift the real builder and inspect the object it returns.
const gi = app.indexOf('function getApprovedExamples');
if (gi < 0) {
  console.error('FAIL: request-payload — getApprovedExamples not found (renamed? this gate is now blind)');
  process.exit(2);
}
let d = 0, j = app.indexOf('{', gi), end = 0;
for (let k = j; k < app.length; k++) {
  if (app[k] === '{') d++;
  else if (app[k] === '}') { d--; if (!d) { end = k + 1; break; } }
}
const src = app.slice(gi, end);

// Drive the real function with a stubbed library of approved ideas.
const fn = new Function('state', 'lsGet', 'clean', `${src}; return getApprovedExamples('video');`);
const stubState = Array.from({ length: 6 }, (_, i) => ({
  status: i % 2 ? 'done' : 'filming', format: 'video',
  title: 'Idea ' + i, hook: 'H'.repeat(300), script: 'S'.repeat(2000),
  approvedAt: Date.now() - i * 1000
}));
let out = [];
try { out = fn(stubState, () => null, s => String(s == null ? '' : s).trim()) || []; }
catch (e) { check('getApprovedExamples threw when driven', false, String(e.message).slice(0, 90)); }

if (out.length) {
  const keys = new Set();
  for (const e of out) for (const k of Object.keys(e)) keys.add(k);
  check('still uploads `hook` — api/_brain.js never reads it', !keys.has('hook'));
  check('still uploads `body` — api/_brain.js never reads it', !keys.has('body'));
  // Positive control: it must still send what the server DOES read, or output degrades.
  check('stopped sending `text` — the server renders this and nothing else', keys.has('text'));
  check('stopped sending `format`', keys.has('format'));
  check('stopped sending `title`', keys.has('title'));
  const bytes = Buffer.byteLength(JSON.stringify(out));
  check('example payload is implausibly large', bytes < 9000, bytes + ' bytes for ' + out.length + ' examples');
} else {
  check('getApprovedExamples returned nothing when driven with approved ideas', false,
    'the probe cannot see the payload, so this gate proves nothing');
}

// ── 2. The client must not give up before the server does ────────────────────
const vj = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
const serverMs = ((vj.functions || {})['api/generate-ideas.js'] || {}).maxDuration * 1000;
const qp = app.indexOf('async function generateTodayTabPost');
const qpBody = app.slice(qp, qp + 40000);
const m = qpBody.match(/_genCtrl\.abort\(\);?\s*\}\s*catch[^}]*\}\s*stop\(\);\s*\},\s*(\d+)\)/);
check('could not find the Quick Post abort timer', !!m);
if (m) {
  const clientMs = Number(m[1]);
  check('client gives up long before the server does', clientMs >= 180000,
    'client aborts at ' + clientMs / 1000 + 's but the server may work until ' + serverMs / 1000 + 's — a slow upload alone can outlast it, and the post is lost after the server already produced it');
  check('client waits past the server budget', clientMs < serverMs,
    'client ' + clientMs / 1000 + 's >= server ' + serverMs / 1000 + 's; the server timeout should win so the user gets a real error, not an ambiguous abort');
}

// ── 2b. btnWork's DEFAULT guards every other generate button (Ideas, Remix, Sharpen,
//        Meme, Viral, Idea Catcher). Same bug, wider blast radius. ────────────
const bw = app.match(/opts\.maxMs\s*\|\|\s*(\d+)/);
check('could not find btnWork default maxMs', !!bw);
if (bw) {
  const ms = Number(bw[1]);
  check('btnWork still defaults to a sub-server timeout', ms >= 180000,
    'default ' + ms / 1000 + 's aborts every generate button before the 300s server budget — the same defect that lost a completed Quick Post');
  check('btnWork default exceeds the server budget', ms < serverMs,
    'default ' + ms / 1000 + 's >= server ' + serverMs / 1000 + 's');
}

// ── 3. The timeout copy must not blame a component we did not observe fail ───
check('timeout message still blames the AI', !/the AI is slow right now/.test(app),
  'the server returned 200 in the real incident — blaming the AI sent the diagnosis the wrong way');

if (fails.length) {
  console.error('FAIL: request-payload —');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('PASS: request-payload — no dead fields uploaded, client outlasts a slow link, timeout copy is honest');
