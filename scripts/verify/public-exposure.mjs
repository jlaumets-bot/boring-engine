#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// GATE: nothing internal is served on the public internet, and the security
// headers are present.
//
// vercel.json sets outputDirectory "." — the repo root IS the public site — so
// any file that is uploaded is reachable at https://contentshrimp.com/<path>.
// A file is only kept out of the deployment by .vercelignore.
//
// This oracle proves three things WITHOUT deploying:
//   1. every sensitive file present in the repo is excluded by .vercelignore
//   2. every file the running app actually needs is NOT excluded
//      (including every URL in the sw.js precache CORE list — if one of those
//      404s the service-worker install fails and the PWA breaks)
//   3. vercel.json is valid JSON and carries the expected security headers
//
// The .vercelignore matcher below is implemented to gitignore semantics and
// self-tested on known cases before it is trusted (see matcherSelfTest).
//
//   RUN:    node scripts/verify/public-exposure.mjs
//   EXPECT: exits 0 and prints "PASS"
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const failures = [];
const fail = (m) => failures.push(m);

// ── gitignore-style matcher ──────────────────────────────────────────────────
const RE_SPECIAL = /[.+^${}()|[\]\\]/g;

function globToRegex(glob, anchored) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const before = i === 0 || glob[i - 1] === '/';
        const afterSlash = glob[i + 2] === '/';
        if (before && afterSlash) { out += '(?:.*/)?'; i += 2; continue; }   // "**/" → any depth
        if (before && i + 2 === glob.length) { out += '.*'; i += 1; continue; } // trailing "**"
        out += '.*'; i += 1; continue;                                        // "a/**/b"
      }
      out += '[^/]*';
      continue;
    }
    if (c === '?') { out += '[^/]'; continue; }
    if (c === '/') { out += '/'; continue; }
    out += c.replace(RE_SPECIAL, '\\$&');
  }
  // "a/**" (written as a/** → out ends with .*) must also match "a" itself? gitignore says
  // a/** matches everything INSIDE a, which our prefix handling already covers.
  const prefix = anchored ? '^' : '^(?:|.*/)';
  return new RegExp(prefix + out + '$');
}

function compileRule(line) {
  let p = line;
  let neg = false;
  if (p.startsWith('!')) { neg = true; p = p.slice(1); }
  if (p.startsWith('\\#') || p.startsWith('\\!')) p = p.slice(1);
  let dirOnly = false;
  while (p.endsWith('/')) { dirOnly = true; p = p.slice(0, -1); }
  // A pattern containing a slash (after the trailing one is stripped) is anchored to the root.
  const anchored = p.includes('/');
  if (p.startsWith('/')) p = p.slice(1);
  return { src: line, neg, dirOnly, re: globToRegex(p, anchored) };
}

function parseIgnore(text) {
  return text.split(/\r?\n/)
    .map(l => l.replace(/\s+$/, ''))
    .filter(l => l !== '' && !l.startsWith('#'))
    .map(compileRule);
}

// Returns true when `relPath` would be EXCLUDED from the deployment.
function isIgnored(rules, relPath, isDir = false) {
  const parts = relPath.split('/').filter(Boolean);
  let ignored = false;
  for (let i = 0; i < parts.length; i++) {
    const sub = parts.slice(0, i + 1).join('/');
    const subIsDir = i < parts.length - 1 ? true : isDir;
    let cur = ignored;
    for (const r of rules) {
      if (r.dirOnly && !subIsDir) continue;
      if (r.re.test(sub)) cur = !r.neg;
    }
    // gitignore: a file cannot be re-included if one of its parent dirs is excluded.
    if (ignored && cur === false) cur = true;
    ignored = cur;
  }
  return ignored;
}

// ── prove the matcher before trusting it ─────────────────────────────────────
function matcherSelfTest() {
  const cases = [
    [['*.md'], 'CLAUDE.md', true],
    [['*.md'], 'api/notes.md', true],
    [['*.md'], 'app.html', false],
    [['sql/'], 'sql/team-tables.sql', true],
    [['sql/'], 'sql', true, true],   // matches the DIRECTORY sql/
    [['sql/'], 'sql', false],        // ...but a FILE named "sql" is not a directory
    [['sql/'], 'mysql.txt', false],
    [['scripts/'], 'scripts/verify/x.mjs', true],
    [['scripts/'], 'api/scripts.js', false],
    [['*.sql'], 'cs-blog-setup.sql', true],
    [['mobile-user*.json'], 'mobile-user-prev.json', true],
    [['mobile-user*.json'], 'package.json', false],
    [['node_modules/'], 'node_modules/ms/index.js', true],
    [['.env.*'], '.env.local', true],
    [['.env'], '.env', true],
    [['*.md', '!README.md'], 'README.md', false],          // negation re-includes
    [['docs/', '!docs/keep.md'], 'docs/keep.md', true],    // ...but not under an excluded dir
    [['render-test.html'], 'render-test.html', true],
    [['render-test.html'], 'app.html', false],
    [['*.sh'], 'mobile-audit.sh', true],
    [['*.webm'], 'mobile-user-video.webm', true],
    [['qa-*.png'], 'mobile-test-shots/qa-ideas.png', true],
    [['*.bak'], 'app.html.bak', true],
  ];
  for (const [pats, p, want, isDir = false] of cases) {
    const got = isIgnored(parseIgnore(pats.join('\n')), p, isDir);
    if (got !== want) {
      fail(`matcher self-test FAILED: [${pats.join(', ')}] vs "${p}"${isDir ? ' (dir)' : ''} → ${got}, expected ${want}`);
    }
  }
}

// ── inputs ───────────────────────────────────────────────────────────────────
const IGNORE_FILE = path.join(ROOT, '.vercelignore');
if (!fs.existsSync(IGNORE_FILE)) {
  console.error('FAIL: .vercelignore is missing — every internal file would be published.');
  process.exit(1);
}
const rules = parseIgnore(fs.readFileSync(IGNORE_FILE, 'utf8'));
matcherSelfTest();

// Optional lookup mode:  node scripts/verify/public-exposure.mjs --explain CLAUDE.md sql/team-tables.sql
if (process.argv[2] === '--explain') {
  if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
  for (const p of process.argv.slice(3)) {
    const rel = p.replace(/^\//, '');
    console.log(`${isIgnored(rules, rel) ? 'EXCLUDED    ' : 'PUBLISHED   '} /${rel}`);
  }
  process.exit(0);
}

// ── 1. required public assets must SURVIVE ───────────────────────────────────
// If any of these is excluded the live site breaks. Each must also exist on disk,
// so a renamed/deleted asset fails here rather than silently passing.
const REQUIRED_PUBLIC = [
  'app.html', 'index.html', 'sw.js', 'manifest.json', 'supabase.min.js',
  'brand-brain-animation.html',
  'faq.html', 'terms.html', 'privacy.html', 'refunds.html',
  'llms.txt', 'robots.txt', 'sitemap.xml', 'sitemap-main.xml',
  'favicon.ico', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'og-image.png',
  'shrimp-mascot.png', 'shrimp-mascot-blink.png', 'shrimp-mascot-half.png',
  'shrimp-burp.png', 'shrimp-burp-2.png',
  // package.json is how Vercel installs the serverless functions' dependencies
  'package.json',
  // a representative slice of the API surface
  'api/generate-ideas.js', 'api/_llm.js', 'api/_usage.js', 'api/_build.js',
  'vercel.json',
];
for (const rel of REQUIRED_PUBLIC) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    fail(`required public asset is MISSING from the repo: ${rel}`);
    continue;
  }
  if (isIgnored(rules, rel)) {
    fail(`.vercelignore would EXCLUDE a required public asset: ${rel}`);
  }
}

// every api/*.js endpoint must ship
for (const f of fs.readdirSync(path.join(ROOT, 'api'))) {
  if (f.endsWith('.js') && isIgnored(rules, `api/${f}`)) {
    fail(`.vercelignore would EXCLUDE an API endpoint: api/${f}`);
  }
}

// ── 2. the sw.js precache list must be fully deployable ──────────────────────
// The service worker install() fetches every URL in CORE. A 404 there breaks the PWA.
const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const coreMatch = sw.match(/const\s+CORE\s*=\s*\[([^\]]*)\]/);
if (!coreMatch) {
  fail('could not find the CORE precache array in sw.js — cannot verify the service worker.');
} else {
  const urls = [...coreMatch[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map(m => m[1]);
  if (urls.length === 0) fail('sw.js CORE precache list parsed as empty — parser is wrong.');
  for (const u of urls) {
    const rel = u === '/' ? 'index.html' : u.replace(/^\//, '');
    if (!fs.existsSync(path.join(ROOT, rel))) {
      fail(`sw.js precaches "${u}" but ${rel} does not exist in the repo.`);
    } else if (isIgnored(rules, rel)) {
      fail(`sw.js precaches "${u}" but .vercelignore EXCLUDES ${rel} — the SW install would fail.`);
    }
  }
  // sw.js also references these directly (push notification icons)
  for (const rel of ['icon-192.png']) {
    if (isIgnored(rules, rel)) fail(`sw.js references /${rel} but it is excluded.`);
  }
}

// ── 3. sensitive files must be EXCLUDED ──────────────────────────────────────
// (a) named files the auditor confirmed were live on production
const MUST_BE_EXCLUDED = [
  'CLAUDE.md', 'GATES.md', 'HANDOFF.md', 'BUG-AUDIT.md', 'ENV-SETUP.md',
  'STRIPE-SETUP.md', 'desktop-user-report.md', 'linkedin-outreach.md',
  'mobile-user-report.md', 'mobile-user-prev.json', 'mobile-user-video.webm',
  'render-test.html',
  'sql/team-tables.sql', 'sql/security-fixes-batch1b.sql', 'cs-blog-setup.sql',
  'scripts/stamp-build.js', 'scripts/verify/dark-mode.mjs',
  'mobile-user.js', 'mobile-test.js', 'qa.js', 'measure-consistency.js',
  'mobile-audit.sh', 'DEPLOY.command',
  '.env', '.env.local', '.auth.json', 'app.html.bak',
  'node_modules/ms/index.js', 'mobile-test-shots/qa-ideas.png',
  '_render-selftest/statement-tpl0.png',
];
for (const rel of MUST_BE_EXCLUDED) {
  if (!isIgnored(rules, rel)) {
    fail(`.vercelignore does NOT exclude a sensitive path: ${rel}`);
  }
}

// (b) live sweep — catch anything new that lands in the repo later
const SKIP_WALK = new Set(['.git', 'node_modules', 'mobile-test-shots', 'mobile-shots']);
const SENSITIVE_EXT = new Set(['.md', '.sql', '.sh', '.bak', '.webm', '.zip', '.command']);
const SENSITIVE_DIR = ['sql/', 'scripts/', '_render-selftest/'];

function walk(dir, rel = '') {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (SKIP_WALK.has(e.name)) continue;
      walk(path.join(dir, e.name), r);
      continue;
    }
    const ext = path.extname(e.name).toLowerCase();
    const sensitive =
      SENSITIVE_EXT.has(ext) ||
      SENSITIVE_DIR.some(d => r.startsWith(d)) ||
      e.name.startsWith('.env') ||
      e.name === '.auth.json';
    if (sensitive && !isIgnored(rules, r)) {
      fail(`internal file would be PUBLISHED: /${r}`);
    }
  }
}
walk(ROOT);

// ── 4. vercel.json: valid JSON + security headers ────────────────────────────
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
} catch (e) {
  console.error(`FAIL: vercel.json is not valid JSON — ${e.message}`);
  process.exit(1);
}

const global = (cfg.headers || []).find(h => h.source === '/(.*)');
if (!global) {
  fail('vercel.json has no global "/(.*)" headers block.');
} else {
  const got = new Map(global.headers.map(h => [h.key.toLowerCase(), h.value]));
  const REQUIRED_HEADERS = {
    'x-content-type-options': /nosniff/i,
    'x-frame-options': /SAMEORIGIN|DENY/i,
    'strict-transport-security': /max-age=\d{7,}/i,
    'referrer-policy': /strict-origin-when-cross-origin|no-referrer/i,
    'permissions-policy': /geolocation=\(\)/i,
  };
  for (const [k, re] of Object.entries(REQUIRED_HEADERS)) {
    if (!got.has(k)) fail(`missing security header: ${k}`);
    else if (!re.test(got.get(k))) fail(`security header "${k}" has an unexpected value: ${got.get(k)}`);
  }
  // the app uses the camera (teleprompter) and mic (dictation) — a policy that
  // denies them would silently break filming.
  const pp = got.get('permissions-policy') || '';
  if (pp && !/camera=\(self\)/i.test(pp)) fail('Permissions-Policy must keep camera=(self) — the teleprompter records video.');
  if (pp && !/microphone=\(self\)/i.test(pp)) fail('Permissions-Policy must keep microphone=(self) — dictation records audio.');
}

// the untouched plumbing must still be intact
if (cfg.outputDirectory !== '.') fail('vercel.json outputDirectory changed — expected ".".');
if (!Array.isArray(cfg.rewrites) || cfg.rewrites.length < 2) fail('vercel.json rewrites were altered.');
if (!Array.isArray(cfg.crons) || cfg.crons.length < 2) fail('vercel.json crons were altered.');
// Named, not counted: a bare "at least N entries" floor fails every time an endpoint is
// legitimately retired (it did, when the publishing system was removed) and says nothing
// about whether the entries that MATTER survived. parse-all.mjs already fails on an entry
// pointing at a missing file; this one guards the reverse — a long-running function losing
// its budget and silently reverting to the ~10s platform default.
if (!cfg.functions || !Object.keys(cfg.functions).length) {
  fail('vercel.json function maxDuration map is missing or empty.');
} else {
  for (const k of ['api/generate-ideas.js', 'api/remix.js', 'api/crawl-brand.js',
                   'api/send-daily.js', 'api/pull-trends-cron.js', 'api/video-beats.js',
                   'api/transcribe-url.js', 'api/extract-article.js']) {
    if (!cfg.functions[k]) fail(`vercel.json lost the maxDuration entry for ${k} — it would fall back to the ~10s default.`);
  }
}

// ── report ───────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`FAIL (${failures.length}):`);
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('PASS — no internal file is publishable, every required public asset survives, security headers present.');
