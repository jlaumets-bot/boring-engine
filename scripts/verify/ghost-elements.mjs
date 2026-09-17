#!/usr/bin/env node
// GATE: no LIVE code may read a DOM element that nothing in the app ever creates.
//
// WHY THIS EXISTS
//   `document.getElementById('x')` returns null when nothing renders `id="x"`, and almost every
//   reader here is null-guarded — so the code does not crash, it just silently does nothing. That
//   is the worst failure shape this app has: a control that renders and does not work, with no
//   error anywhere. Rename an id in the markup and forget one reader, and that reader stops
//   working forever with nothing to find.
//
//   Measured when this gate was written: 296 distinct ids are read, 15 of which nothing creates.
//   All 15 turned out to be inert for a documented reason (below) — but the NEXT one will not be,
//   and there was nothing to catch it.
//
// HOW IT CHECKS
//   Collects every id the code reads and every id the app can produce — static markup, template
//   literals (including interpolated `id="thing-${n}"` prefixes) and `el.id = '...'` — and fails on
//   any read with no producer that is not in the reviewed list below.
//
//   ADDING TO THE LIST IS NOT THE FIX. Each entry is a promise that the read is inert and why. If
//   a new id appears here, the element was probably renamed or its markup dropped — find the reader
//   and fix it. Only add an entry when you have proved the read cannot matter, and say why.
//
// RUN:    node scripts/verify/ghost-elements.mjs
// EXPECT: prints "PASS" and exits 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const fails = [];
const bad = m => fails.push(m);

// Reviewed 2026-09-17. Every one of these is inert, with the reason. See the v672 CLAUDE.md entry.
const KNOWN = {
  // The Quick Scenes / prompt-builder cluster. Its container is gone, so renderQuickScenes hits
  // `if (!container) return;` on every call and none of its buttons ever render — and every caller
  // of every other function in the cluster is INSIDE the cluster. It is a closed loop with no way
  // in. Verified by listing the call sites: all of them sit between app.html:20048 and :20337.
  quickScenesContainer: 'prompt-builder cluster — container removed, renderQuickScenes returns immediately',
  promptSceneInput:     'prompt-builder cluster — unreachable, see quickScenesContainer',
  promptText:           'prompt-builder cluster — unreachable',
  promptOutput:         'prompt-builder cluster — unreachable',
  promptCopiedMsg:      'prompt-builder cluster — unreachable',
  promptHistory:        'prompt-builder cluster — unreachable',
  promptRefGrid:        'prompt-builder cluster — unreachable',
  // The meme / product-reference tools are DELIBERATELY shelved (CS_SHELVED = { blog, meme }).
  // Their markup was removed and the renderers deliberately kept so the flag can revive them —
  // app.html says so in as many words. Deleting these would destroy that revive path.
  refGrid:              'shelved meme/product-ref tool (CS_SHELVED) — renderer kept on purpose',
  sparkInput:           'shelved spark tool — reader is null-guarded',
  sparkMicBtn:          'shelved spark tool — reader is null-guarded',
  sparkBtn:             'shelved spark tool — reader is null-guarded',
  // Deliberate cleanup of an element an OLDER build rendered: renderUsagePill does
  // `var old = getElementById('csUsagePill'); if (old) old.remove();`. Reading a thing in order to
  // delete it if present is correct — usage now lives in Settings > Account via spPlanBox/dsPlan,
  // both of which DO exist.
  csUsagePill:          'intentional cleanup of a removed element — remove-if-present',
  spUsageVal:           'optional Settings field — null-guarded; spPlanBox/dsPlan carry the real display',
  // Readers that sit inside functions nothing calls.
  tpCamBtn:             'read only by toggleTpCamera, which has no call site',
  obDayGrid:            'read only by obBuildDayGrid, which has no call site',
};

// Reads. A DYNAMIC id (`vtRewrite-${id}` or 'vtRewrite-' + id) is matched by PREFIX below, not by
// its literal text — the first version of this gate flagged one of those as a ghost when the
// element is created by concatenation two lines away.
const read = new Map();
for (const m of html.matchAll(/getElementById\(\s*[`'"]([^`'"]+)[`'"]\s*\)/g)) {
  const ln = html.slice(0, m.index).split('\n').length;
  if (!read.has(m[1])) read.set(m[1], []);
  read.get(m[1]).push(ln);
}
const made = new Set();
for (const m of html.matchAll(/\bid\s*=\s*["']([^"'${]+)["']/g)) made.add(m[1]);
for (const m of html.matchAll(/\bid\s*=\s*\\?["']([A-Za-z_][\w-]*)/g)) made.add(m[1]);
for (const m of html.matchAll(/\.id\s*=\s*['"]([^'"]+)['"]/g)) made.add(m[1]);
// ids built dynamically — record the PREFIX, from all three shapes the app uses:
//   id="viralTwist-${idea.id}"      (template literal in markup)
//   el.id = 'vtRewrite-' + id       (concatenation)
//   el.id = `vtRewrite-${id}`       (template literal assignment)
const prefixes = [
  ...[...html.matchAll(/\bid\s*=\s*["'`]([A-Za-z_][\w-]*?)-?\$\{/g)].map(m => m[1]),
  ...[...html.matchAll(/\.id\s*=\s*['"`]([A-Za-z_][\w-]*?)-?(?:\$\{|['"`]\s*\+)/g)].map(m => m[1]),
];

const ghosts = [];
for (const [id, lns] of read) {
  if (made.has(id)) continue;
  // Strip the dynamic tail before prefix-matching: `vtRewrite-${id}` is produced by `vtRewrite-`.
  const stem = id.split(/\$\{|\+/)[0].replace(/-$/, '');
  if (prefixes.some(p => stem.startsWith(p) || p.startsWith(stem))) continue;
  ghosts.push([id, lns]);
}
if (read.size < 200) bad(`only ${read.size} ids were found to be read — the scan is not seeing app.html properly.`);
if (made.size < 200) bad(`only ${made.size} ids were found to be produced — the scan is not seeing the markup properly.`);

for (const [id, lns] of ghosts) {
  if (KNOWN[id]) continue;
  bad(`nothing in the app ever creates id="${id}", but code reads it at app.html:${lns.join(', ')}. ` +
      'getElementById returns null and the guard swallows it, so this silently does nothing — a ' +
      'control that renders and does not work, with no error anywhere. Find the reader and fix it; ' +
      'only add it to KNOWN once you have proved the read cannot matter, with the reason.');
}
// The list must not rot: an entry that is no longer a ghost is either fixed (good, remove it) or
// the scan has drifted (bad). Either way, say so.
for (const id of Object.keys(KNOWN)) {
  if (!ghosts.some(([g]) => g === id)) {
    bad(`KNOWN lists "${id}" as a ghost, but it is no longer one. If the element is back, delete ` +
        'the entry. If the read is gone, delete the entry. A stale allowlist hides the next real one.');
  }
}

if (fails.length) {
  console.error('FAIL:');
  fails.forEach(f => console.error('  - ' + f));
  process.exit(1);
}
console.log(`ghost elements verified: ${read.size} ids read, ${made.size} produced, ` +
            `${ghosts.length} reads with no producer — all ${Object.keys(KNOWN).length} reviewed and inert.`);
console.log('PASS');
