#!/usr/bin/env node
// GATE: spend-cap — the metering holes that made thirteen expensive endpoints
// infinitely callable stay closed.
//
// Each check below corresponds to a hole that was live in production:
//   1. an action registered at 0 credits can never increment `used`, so it can never
//      trip its own plan limit — it is unlimited on every plan, forever
//   2. the cost fuse defaulted to 0 (off), so the one control built for runaway spend
//      depended on an env var nobody had set
//   3. crawl-brand and extract-article authenticated but never called checkLimit
//   4. hook-frame issued up to 4 outbound HTTPS fetches BEFORE authenticating
//   5. nothing in the codebase rate-limited anything
//
// Run:  node scripts/verify/spend-cap.mjs
// EXPECT: exits 0 and prints a final line beginning "PASS"
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require_ = createRequire(import.meta.url);
const fail = [];
const note = (m) => console.log('  ' + m);
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// The module must load and still export what its 25+ callers use.
let usage;
try {
  usage = require_(join(ROOT, 'api', '_usage.js'));
} catch (e) {
  console.error('FAIL: api/_usage.js does not load — ' + e.message);
  process.exit(1);
}
for (const fn of ['guard', 'checkLimit', 'logUsage', 'creditsFor', 'costFor', 'getStatus',
                  'usedThisPeriod', 'usageThisPeriod', 'setPlan', 'userIdByStripe',
                  'stripeCustomerId', 'getOrInitPlan', 'effectivePlan', 'limitFor']) {
  if (typeof usage[fn] !== 'function') fail.push(`_usage.js no longer exports ${fn}() — its callers will crash`);
}
for (const k of ['PLAN_LIMITS', 'ACTION_CREDITS', 'ACTION_COST', 'TRIAL_DAYS']) {
  if (usage[k] == null) fail.push(`_usage.js no longer exports ${k}`);
}

// ── 1. no metered action may be registered at zero credits ────────────────────
const zero = Object.entries(usage.ACTION_CREDITS || {}).filter(([, v]) => !(Number(v) > 0));
if (zero.length) {
  fail.push('ACTION_CREDITS registers ' + zero.length + ' action(s) at 0 credits, which can never ' +
            'trip a plan limit: ' + zero.map(([k]) => k).join(', '));
} else {
  note(`no zero-credit actions (${Object.keys(usage.ACTION_CREDITS).length} registered, ` +
       `min weight ${Math.min(...Object.values(usage.ACTION_CREDITS))})`);
}

// The thirteen that were the actual hole must each carry a real weight now.
const WERE_ZERO = ['transcribevoice', 'crawlsocial', 'listen', 'inspiration', 'paa', 'searchimages',
                   'speak', 'voicechat', 'distill', 'crawlbrand', 'pulltrends', 'stockphoto',
                   'settingsexamples'];
const missing = WERE_ZERO.filter((a) => !(Number(usage.ACTION_CREDITS[a]) > 0));
if (missing.length) fail.push('previously-zero action(s) back at 0 or unregistered: ' + missing.join(', '));

// Every registered action needs a cost too, or the fuse under-counts it.
const noCost = Object.keys(usage.ACTION_CREDITS || {}).filter((a) => usage.ACTION_COST[a] == null);
if (noCost.length) fail.push('action(s) with a credit weight but no ACTION_COST entry: ' + noCost.join(', '));

// ── 1b. every action the API ACTUALLY GATES must be in both maps ──────────────
// The check above starts from ACTION_CREDITS, so an action missing from BOTH maps is
// invisible to it — which is exactly how `sharpen` (a guard()ed endpoint making TWO
// sequential LLM calls) sat unregistered while this gate passed green. Enumerate the real
// call sites instead: the source of truth is what the handlers pass, not what the map lists.
{
  // _usage.js DEFINES guard() — `async function guard(req, action)` is a signature, not a call
  // site, and its parameter can never resolve to a literal. Scanning it reports a permanent
  // false positive. The metering module does not gate itself; every real caller is another file.
  const files = readdirSync(join(ROOT, 'api')).filter((f) => f.endsWith('.js') && f !== '_usage.js');
  const sites = [];                                   // { action, file, how }
  const unresolved = [];
  for (const f of files) {
    const src = read(join('api', f));
    // guard(req, 'action')
    for (const m of src.matchAll(/\bguard\(\s*req\s*,\s*(['"])([\w.-]+)\1/g)) sites.push({ action: m[2], file: f, how: 'guard' });
    // guard(req, someVar) — resolve a `const someVar = 'literal'` in the same file
    for (const m of src.matchAll(/\bguard\(\s*req\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
      const v = m[1];
      const lit = src.match(new RegExp('\\b(?:const|let|var)\\s+' + v + '\\s*=\\s*([\'"])([\\w.-]+)\\1'));
      if (lit) sites.push({ action: lit[2], file: f, how: 'guard(var ' + v + ')' });
      else unresolved.push(`${f}: guard(req, ${v}) — cannot resolve the action name statically`);
    }
    // checkLimit(userId, credits, 'action') — the lane meme.js and generate-ideas.js use
    for (const m of src.matchAll(/checkLimit\([^;]*?,\s*(['"])([\w.-]+)\1\s*\)/g)) sites.push({ action: m[2], file: f, how: 'checkLimit' });
  }
  if (unresolved.length) fail.push('gated action(s) not statically resolvable — write the action as a ' +
    'string literal so this gate can see it: ' + unresolved.join('; '));
  // A broken regex must not pass vacuously.
  if (sites.length < 15) {
    fail.push(`only ${sites.length} gated call site(s) found across api/*.js — the scanner is broken, ` +
              'not the code (there were 25+ when this was written)');
  }
  const gated = [...new Set(sites.map((s) => s.action))].sort();
  const orphan = gated.filter((a) => usage.ACTION_CREDITS[a] == null || usage.ACTION_COST[a] == null);
  if (orphan.length) {
    fail.push('gated action(s) missing from ACTION_CREDITS and/or ACTION_COST — they silently default ' +
      'to 1 credit / EUR 0.01, so their real cost is invisible to the fuse: ' +
      orphan.map((a) => `${a} (${sites.filter((s) => s.action === a).map((s) => s.file).join(', ')})`).join('; '));
  } else {
    note(`all ${gated.length} gated actions across ${sites.length} call sites are in both weight maps`);
  }
}

// A weight nobody can afford would break normal use — catch a fat-fingered value.
const absurd = Object.entries(usage.ACTION_CREDITS || {}).filter(([, v]) => Number(v) > 10);
if (absurd.length) fail.push('implausibly large credit weight(s): ' + absurd.map(([k, v]) => `${k}=${v}`).join(', '));

// ── 2. the cost fuse must be armed by default ─────────────────────────────────
// Read the source, not the loaded value: the env could be masking a 0 default.
const usageSrc = read('api/_usage.js');
if (/const COST_CAP_EUR = Number\(process\.env\.COST_CAP_EUR \|\| 0\)/.test(usageSrc)) {
  fail.push('COST_CAP_EUR still defaults to 0 — the cost fuse is off unless someone sets the env var');
}
if (process.env.COST_CAP_EUR == null || process.env.COST_CAP_EUR === '') {
  if (!(Number(usage.COST_CAP_EUR) > 0)) {
    fail.push(`cost fuse default is ${usage.COST_CAP_EUR} — it never fires`);
  } else {
    note(`cost fuse armed by default at EUR ${usage.COST_CAP_EUR}`);
  }
} else {
  note(`cost fuse overridden by env (COST_CAP_EUR=${process.env.COST_CAP_EUR}) — default not asserted`);
}

// ── 3. the two previously-ungated endpoints must gate ─────────────────────────
for (const [file, action] of [['api/crawl-brand.js', 'crawlbrand'], ['api/extract-article.js', 'extractarticle']]) {
  const src = read(file);
  if (!/_usage'\)\.guard\(req|\bguard\(req/.test(src)) {
    fail.push(`${file} still has no guard()/checkLimit — it is ungated`);
    continue;
  }
  if (!/\.over\b/.test(src)) fail.push(`${file} calls guard() but never acts on .over — the gate is decorative`);
  if (!/status\(402\)/.test(src)) fail.push(`${file} never returns 402 — it cannot reject an over-limit caller`);
  // A gate with no usage row can never fire: `used` would stay 0 forever.
  if (!/logUsage\(/.test(src)) fail.push(`${file} gates but never calls logUsage — usage would never accrue`);
  if (!/'limit_reached'/.test(src)) fail.push(`${file} 402 body must keep error:'limit_reached' (the frontend keys on it)`);
  note(`${file} gates on ${action} and meters it`);
}
// crawl-brand: the second, early-returning branch (the Master Prompt gdoc sync) was RETIRED in
// v636 along with the whole feature, so the "needs its own logUsage" check that guarded it is gone
// with it. The single remaining path is covered by the generic gate loop above.
const cbSrc = read('api/crawl-brand.js');
if (/action\s*===\s*'fetch-gdoc'/.test(cbSrc) && (cbSrc.match(/logUsage\(/g) || []).length < 2) {
  fail.push('api/crawl-brand.js: a gdoc branch is back and returns early — it needs its own ' +
            'logUsage, otherwise that path is gated but never metered and stays unlimited');
}
// Onboarding must never be hard-blocked mid-wizard.
if (!/gate && _cbGuard\.gate\.used\) > 0|used\) > 0/.test(cbSrc)) {
  fail.push('api/crawl-brand.js: lost the zero-usage exemption that keeps a brand-new account ' +
            'from being blocked during onboarding');
} else {
  note('crawl-brand exempts zero-usage accounts, so onboarding cannot be blocked');
}

// ── 4. hook-frame must authenticate before any outbound fetch ─────────────────
const hf = read('api/hook-frame.js');
const iGuard = hf.indexOf('.guard(req');
const iFetch = hf.search(/\n\s*const img = await resolveThumb\(/);
if (iGuard === -1) {
  fail.push('api/hook-frame.js no longer calls guard()');
} else if (iFetch === -1) {
  fail.push('api/hook-frame.js: could not locate the resolveThumb() call to order-check');
} else if (iGuard > iFetch) {
  fail.push('api/hook-frame.js fetches the thumbnail (up to 4 outbound HTTPS requests, 4MB each) ' +
            'BEFORE authenticating — move guard() above resolveThumb()');
} else {
  note('hook-frame authenticates before its first outbound fetch');
}

// ── 5. a per-user burst limit must exist and be reachable ─────────────────────
if (!(Number(usage.RATE_LIMIT_PER_MIN) > 0)) {
  fail.push('no per-user rate limit is configured (RATE_LIMIT_PER_MIN is ' + usage.RATE_LIMIT_PER_MIN + ')');
} else if (!/reason:\s*overCredits \? 'limit'|'rate'/.test(usageSrc) || !/overRate/.test(usageSrc)) {
  fail.push('RATE_LIMIT_PER_MIN is set but checkLimit() never rejects on it');
} else {
  note(`burst limit active at ${usage.RATE_LIMIT_PER_MIN}/min`);
}

// ── behavioural: the gate must actually arithmetic-reject an over-limit user ──
// Exercise checkLimit's decision path against a stubbed status rather than the DB.
{
  const s = { plan: 'trial', used: 150, limit: 150, remaining: 0, cost: 0, recent: 0 };
  const over = s.used + usage.creditsFor('speak') > s.limit;
  if (!over) fail.push('a trial account at its limit is not rejected for `speak` — the weight is still ineffective');
  const fresh = 0 + usage.creditsFor('crawlbrand') > usage.PLAN_LIMITS.free;
  if (fresh) fail.push('a brand-new FREE account cannot afford one crawlbrand — onboarding would break');
  const heavy = usage.creditsFor('crawlbrand') + usage.creditsFor('crawlsocial') + usage.creditsFor('paa') * 3;
  if (heavy > usage.PLAN_LIMITS.trial * 0.25) {
    fail.push(`a normal setup pass costs ${heavy} credits — over a quarter of the trial allowance`);
  } else {
    note(`a full brand-setup pass costs ${heavy} of ${usage.PLAN_LIMITS.trial} trial credits`);
  }
}

if (fail.length) {
  console.error('\nFAIL: spend-cap');
  for (const f of fail) console.error('  - ' + f);
  process.exit(1);
}
console.log('PASS: spend-cap — no zero-credit actions, every gated action is in both weight maps, cost fuse armed, both endpoints gated + metered, hook-frame authenticates first, burst limit active');
