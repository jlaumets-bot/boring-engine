#!/usr/bin/env node
/**
 * dark-mode.selftest.mjs — proves dark-mode.mjs actually detects the bugs.
 *
 * A verifier that only ever passes is worthless. This takes app.html, RE-BREAKS
 * each fixed defect one at a time into a temp copy, runs dark-mode.mjs against
 * it, and asserts (a) it exits non-zero and (b) the failure text names the right
 * thing. Finally it re-checks the untouched file still passes.
 *
 * Usage: node scripts/verify/dark-mode.selftest.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..', '..', 'app.html');
const CHECKER = path.join(__dirname, 'dark-mode.mjs');
const src = fs.readFileSync(APP, 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'darkmode-selftest-'));

/** Each mutation reintroduces exactly one original defect. */
const MUTATIONS = [
  {
    name: 'nav indicator re-hardcoded to ink (the original dead-code bug)',
    expect: /nav active indicator/i,
    apply: (s) => s.replace('</style>\n</head>', '@media (max-width: 600px) { .nav-tab.active::before { background: #16130F !important; height: 3px; } }\n</style>\n</head>'),
  },
  {
    name: 'active bottom-nav icon re-hardcoded to ink',
    expect: /nav active tab icon/i,
    apply: (s) => s.replace('</style>\n</head>', '@media (max-width: 600px) { .nav-tab.active .tab-icon svg { stroke: #16130F !important; } }\n</style>\n</head>'),
  },
  // ── THE HISTORICAL FAILURE MODE ────────────────────────────────────────────
  // Every past dark-mode fix died the same way: it was written at normal weight
  // while an older sweep hardcoded ink/white with !important lower in the sheet,
  // so the fix was dead on arrival. These mutations strip the !important armour
  // off the new fixes — i.e. they write the *naive* fix — and the verifier must
  // notice that the old hardcoded rule is still what actually renders.
  {
    name: 'white-button-tier dark fix written WITHOUT !important (v275 #fff !important wins)',
    expect: /white tier/i,
    apply: (s) => s.replace(
      '[data-theme="dark"] .vt-copy {\n  background: var(--surface2) !important; color: var(--text) !important; border-color: var(--border2) !important;\n}',
      '[data-theme="dark"] .vt-copy {\n  background: var(--surface2); color: var(--text); border-color: var(--border2);\n}'),
  },
  {
    name: 'Assistant close x dark fix written WITHOUT !important (base ink !important wins)',
    expect: /Assistant (close x|header svg)/i,
    apply: (s) => s.replace(
      '[data-theme="dark"] .bv-overlay .bv-header svg { color: var(--text) !important; stroke: var(--text) !important; }',
      '[data-theme="dark"] .bv-overlay .bv-header svg { color: var(--text); stroke: var(--text); }'),
  },
  {
    name: 'filter-chip border fix written WITHOUT !important (v274 border !important wins)',
    expect: /OVERRIDDEN DARK FIX.*filter-chip/is,
    apply: (s) => s.replace(
      '[data-theme="dark"] .filter-chip { border-color: var(--border2) !important; }',
      '[data-theme="dark"] .filter-chip { border-color: var(--border2); }'),
  },
  {
    name: 'the "Generate anyway" / Skip fix reverted entirely',
    expect: /Generate anyway/i,
    apply: (s) => s.replace(
      '[data-theme="dark"] .dismiss-popup .dp-cancel { background: var(--surface2) !important; color: var(--text) !important; border-color: var(--border2) !important; }',
      ''),
  },
  {
    name: 'the Remix quick-lane card back to a hardcoded white island',
    expect: /remixQuick/i,
    apply: (s) => s.replace('<div id="remixQuick" style="background:var(--surface,#fff);', '<div id="remixQuick" style="background:#fff;'),
  },
  {
    name: 'the angle-sheet close x back to ink (the "trapped in Pick the angle" bug)',
    expect: /angle-sheet close x/i,
    apply: (s) => s.replace('background:var(--surface,#fff);color:var(--text,#16130F);font-size:17px', 'background:var(--surface,#fff);color:#16130F;font-size:17px'),
  },
  {
    name: 'locked-toast loses pointer-events:none (invisible but hit-testable)',
    expect: /TAP BLOCKER.*locked-toast/is,
    apply: (s) => s.replace('  pointer-events: none;\n  backdrop-filter: blur(12px);', '  backdrop-filter: blur(12px);'),
  },
  {
    name: 'mascot back above the nav stacking level',
    expect: /TAP BLOCKER.*mascot/is,
    apply: (s) => s.replace('position: fixed; bottom: 16px; right: 16px; z-index: 150;', 'position: fixed; bottom: 16px; right: 16px; z-index: 9999;'),
  },
  {
    name: 'the shrimp made untappable (over-correction must also be caught)',
    expect: /no longer tappable/i,
    apply: (s) => s.replace('.mascot-pet {\n  pointer-events: auto; cursor: pointer;', '.mascot-pet {\n  pointer-events: none; cursor: pointer;'),
  },
  {
    name: 'ink-on-surface sweep reverted for the batch-approve flow',
    expect: /ink-on-surface \.(idea-pick|batch-enter)/i,
    apply: (s) => s.replace('[data-theme="dark"] .idea-pick,\n', ''),
  },
  {
    name: 'quick-lane card left with an ink border in dark (edgeless card)',
    expect: /remixQuick.*(border|invisible)/is,
    apply: (s) => s.replace('[data-theme="dark"] #remixQuick,\n', ''),
  },
  {
    name: 'quick-lane ink ring silently changed in LIGHT mode too',
    expect: /changed in LIGHT mode/i,
    apply: (s) => s.replace('<div id="memeQuick" style="background:var(--surface,#fff);border:1.5px solid #16130F;', '<div id="memeQuick" style="background:var(--surface,#fff);border:1.5px solid var(--border2,#16130F);'),
  },
  {
    name: 'brand-brain card title reverted to inline ink',
    expect: /inline .*brain card title|brain card title/i,
    apply: (s) => s.replace('font-weight:800;font-size:16px;color:var(--text);">${ICO.spark} Your brand brain', 'font-weight:800;font-size:16px;color:#16130F;">${ICO.spark} Your brand brain'),
  },
  {
    name: '"Go to Settings" recovery link reverted to inline ink',
    expect: /Go to Settings/i,
    apply: (s) => s.replace('<span onclick="openSettingsFromLock()" style="color:var(--text,#16130F);cursor:pointer;font-weight:700;', '<span onclick="openSettingsFromLock()" style="color:#16130F;cursor:pointer;font-weight:700;'),
  },
  {
    name: 'white text left on the --accent fills (contrast failure)',
    expect: /contrast \.paa-badge/i,
    apply: (s) => s.replace('[data-theme="dark"] .paa-badge,\n', ''),
  },
];

function run(file) {
  const r = spawnSync(process.execPath, [CHECKER, file], { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

let bad = 0;
console.log('── baseline ────────────────────────────────────────────────');
const base = run(APP);
if (base.code !== 0) { console.error('FAIL: the real app.html does not pass.\n' + base.out); process.exit(1); }
console.log('  ok  untouched app.html passes\n');

console.log('── re-broken copies (each MUST be caught) ──────────────────');
for (const m of MUTATIONS) {
  const mutated = m.apply(src);
  if (mutated === src) { console.error(`  ✗  ${m.name}\n       MUTATION DID NOT APPLY — the anchor text moved; this test proves nothing.`); bad++; continue; }
  const f = path.join(tmp, 'app.html');
  fs.writeFileSync(f, mutated);
  const r = run(f);
  if (r.code === 0) { console.error(`  ✗  ${m.name}\n       NOT CAUGHT — verifier still passed.`); bad++; continue; }
  if (!m.expect.test(r.out)) {
    console.error(`  ✗  ${m.name}\n       caught, but for the wrong reason (expected ${m.expect}).\n${r.out.split('\n').filter((l) => l.includes('✗')).slice(0, 4).join('\n')}`);
    bad++; continue;
  }
  const why = (r.out.split('\n').find((l) => l.includes('✗') && m.expect.test(l)) || '').trim();
  console.log(`  ok  ${m.name}\n       -> ${why.slice(0, 150)}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('');
if (bad) { console.error(`${bad} of ${MUTATIONS.length} mutation(s) NOT detected — the verifier cannot be trusted.`); process.exit(1); }
console.log(`all ${MUTATIONS.length} re-broken variants detected`);
console.log('dark mode selftest passed');
