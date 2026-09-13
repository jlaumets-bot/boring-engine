#!/usr/bin/env node
// G37 — nothing in the UI points at something that no longer exists.
//
// Written 2026-08-28, after a day that deleted three whole features (publishing, the marketing
// blog, the Master Prompt doc) and ~55KB of app.html. Parsing proves the file is valid JavaScript;
// it says nothing about whether a button still calls a function that is there, or whether a nav
// entry still leads to a view that exists. Those break at TAP TIME, in front of the user, and no
// existing gate catches them.
//
// This is the deletion-damage gate. It fails when:
//   1. an inline handler (onclick=…) calls a function name that is not defined anywhere,
//   2. a switchView('x') target has no matching #view-x in the markup,
//   3. app.html contains a raw NUL byte (introduced twice in one day by hashing code; it makes
//      the file read as BINARY to grep/diff and hides everything from every text tool).
//
// Deliberately NOT checked: getElementById targets. Most are created dynamically at render time,
// so a static check produces mostly false positives — and a gate that cries wolf gets ignored,
// which is worse than not having it.
//
// Read-only. Run: node scripts/verify/no-dangling-refs.mjs

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const appPath = path.join(root, 'app.html');
const app = fs.readFileSync(appPath, 'utf8');
const fails = [];

// ── 1. inline handlers must resolve ──
const handlers = new Set();
for (const m of app.matchAll(/\bon(?:click|change|input|submit|focus|blur|keyup|keydown|toggle)\s*=\s*"([^"]*)"/g)) {
  for (const c of m[1].matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) handlers.add(c[1]);
}

const defined = new Set();
for (const m of app.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) defined.add(m[1]);
for (const m of app.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/g)) defined.add(m[1]);
for (const m of app.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);

// Language keywords and host built-ins are not app functions. Without this list the regex above
// reports `if` and `fn` as "dead handlers", which is exactly the false-positive noise that made an
// earlier scanner's output get ignored.
const BUILTIN = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'event', 'this',
  'alert', 'confirm', 'prompt', 'setTimeout', 'setInterval', 'parseInt', 'parseFloat', 'String',
  'Number', 'Boolean', 'Array', 'Object', 'JSON', 'Math', 'Date', 'fetch', 'require', 'console',
  'document', 'window', 'navigator', 'localStorage', 'encodeURIComponent', 'decodeURIComponent']);

const dead = [...handlers].filter(h =>
  !defined.has(h) && !BUILTIN.has(h) &&
  !new RegExp('\\.' + h + '\\s*\\(').test(app)   // a method call like el.closest(...)
);
if (dead.length) {
  fails.push(`${dead.length} inline handler(s) call a function that does not exist — these are ` +
             `dead buttons: ${dead.join(', ')}`);
}

// ── 2. every nav destination must exist ──
const targets = [...new Set([...app.matchAll(/switchView\(\s*'([a-z-]+)'/g)].map(m => m[1]))];
const views = new Set([...app.matchAll(/id="view-([a-z-]+)"/g)].map(m => m[1]));
const missingViews = targets.filter(t => !views.has(t));
if (missingViews.length) {
  fails.push(`switchView points at ${missingViews.length} view(s) with no markup — tapping these ` +
             `lands on nothing: ${missingViews.join(', ')}`);
}

// ── 3. no raw NUL bytes ──
const nul = fs.readFileSync(appPath).filter(b => b === 0).length;
if (nul) {
  fails.push(`app.html contains ${nul} raw NUL byte(s) — the file reads as BINARY to grep, diff ` +
             `and most editors. Use the \\u0000 escape in source instead of a literal NUL.`);
}

if (fails.length) {
  console.log('FAIL: no-dangling-refs');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log(`PASS: no-dangling-refs — ${handlers.size} inline handlers all resolve, ` +
            `${targets.length} nav targets all exist, no NUL bytes`);
