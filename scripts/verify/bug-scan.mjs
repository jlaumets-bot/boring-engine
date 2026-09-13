// Scanners for the bug CLASSES that have actually cost this project time (see CLAUDE.md).
// Each prints findings. Exit 1 if any class has findings, so it can be a gate.
//
// v656 — two of the seven scanners were imprecise enough to be dishonest, and the noise was
// hiding the one class that is real:
//
//   class 1 (DEAD onclick handlers) reported `if` and `fn`. `if` is the JS keyword at the start
//   of `onclick="if(typeof openContentMix==='function')openContentMix()"`, and `fn` came from a
//   CODE COMMENT inside app.html describing an old escJs bug. Neither is a handler. It also only
//   ever looked at the FIRST identifier in the attribute, so the real call in that same handler
//   was never checked at all. Now: script bodies are comment-stripped first, JS keywords are
//   excluded, and EVERY call in the attribute is checked, not just the first.
//
//   class 6 (unauthenticated endpoints) tested /guard\(|_requireUser|requireUser|CRON_SECRET|
//   getUser\(/ against the raw file, so the word counted wherever it appeared — including inside
//   a comment or a string. It then still reported three false positives, because it knew only
//   one shape of authentication: delete-account.js (Bearer token), generate-blog.js (a 410 stub
//   that does nothing at all) and stripe-webhook.js (authenticated by re-fetching the event from
//   Stripe by id with our secret key) were all called unguarded. Now each recognised form of
//   authentication is named, and matched against comment/string-stripped code.
//
// The 19 bare localStorage writes in class 5 are REAL and stay reported.
import fs from 'fs'; import path from 'path';
import { stripCode, stripComments, selfTest } from './_srcscan.mjs';
const root = process.cwd();
const app = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
const findings = [];
const add = (cls, items) => { if (items.length) findings.push([cls, items]); };
selfTest();   // the comment/string stripper must be proven before its result is trusted

// app.html is HTML with five inline <script> blocks. Strip comments INSIDE those blocks only
// (keeping string contents, since the handlers we are looking for live inside template literals),
// so a commented-out example cannot be mistaken for live markup. Offsets are preserved.
const appCode = app.replace(/(<script(?![^>]*\bsrc=)[^>]*>)([\s\S]*?)(<\/script>)/g,
  (m, open, body, close) => open + stripComments(body) + close);

// 1. DEAD HANDLERS — an inline on*= attribute calling a function that does not exist.
const defined = new Set([...app.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
[...app.matchAll(/\b(?:window\.)?([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/g)].forEach(m => defined.add(m[1]));
const RESERVED = new Set(['if','else','for','while','do','switch','case','return','typeof','instanceof',
  'new','delete','void','try','catch','finally','throw','function','in','of','await','yield','this','var','let','const']);
const builtins = new Set(['event','this','window','document','console','setTimeout','setInterval','JSON','Math','Object','Array','String','Number','Boolean','Date','Promise','alert','confirm','prompt','location','navigator','preventDefault','stopPropagation','getElementById','querySelector','querySelectorAll','close','open','focus','blur','reload','click','remove','push','forEach','map','filter','parseInt','parseFloat','encodeURIComponent','decodeURIComponent','requestAnimationFrame']);
const called = new Set();
for (const m of appCode.matchAll(/\son(?:click|change|input|submit|toggle)="([^"]*)"/g)) {
  // every call in the handler body, not just the first token. A call preceded by "." is a
  // METHOD on some object (e.style.setProperty, JSON.stringify) — it is not a global handler
  // and cannot be looked up in `defined`, so it is excluded rather than reported as dead.
  for (const c of m[1].matchAll(/(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) called.add(c[1]);
}
add('DEAD onclick handlers', [...called].filter(f => !defined.has(f) && !builtins.has(f) && !RESERVED.has(f)));

// 2. UNDEFINED CSS VAR with a fallback — silently hardcodes the fallback and can never theme.
//    This is what made the header brand pill a permanent white island in dark mode.
const declared = new Set([...app.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
const usedWithFallback = [...app.matchAll(/var\((--[\w-]+)\s*,\s*[^)]+\)/g)].map(m => m[1]);
add('var(--x, fallback) where --x is never declared', [...new Set(usedWithFallback.filter(v => !declared.has(v)))]);

// 3. INLINE hardcoded light backgrounds inside JS template literals — beat every stylesheet rule,
//    so they cannot be fixed by a dark-mode override. Two of these were found by hand today.
add('inline hardcoded light background in markup/JS', [...app.matchAll(/style="[^"]*background:\s*(#fff\b|#ffffff\b|white)[^"]*"/gi)].map(m => m[0].slice(0, 90)));

// 4. UNGUARDED JSON.parse — a corrupted stored value takes out the whole screen.
const lines = app.split('\n');
add('JSON.parse with no try/catch nearby', lines.map((l, i) => ({ l, i }))
  .filter(({ l, i }) => /JSON\.parse\(/.test(l) && !/try\s*\{/.test(lines.slice(Math.max(0,i-3), i+1).join(' ')))
  .map(({ i, l }) => `L${i+1}: ${l.trim().slice(0, 80)}`));

// Keys that are genuinely per-DEVICE, never per-brand. Each is a UI/dismissal state: the same
// value is correct whichever brand is open, so namespacing them per brand would be the bug.
//   notif-prompt-dismissed  this browser was already asked for notification permission
//   cs_onb_hidden           the activation checklist was dismissed on this device
//   sp-tab                  which Settings tab was last open
//   bc_tour_done            the product tour was completed on this device
//   mascot-hidden           the mascot was hidden on this device
//   pwa-dismissed           the "install the app" prompt was dismissed
//   bv_mic_tip_seen         the microphone tip was shown once
//   stmt_tpl                the statement-card style last picked in the editor
// notebook_<brandId> is EXCLUDED separately: it is brand-scoped, but its write pins the brand id
// captured BEFORE the await (app.html ~14980, _nbBrandId), which is the correct fix for this class
// — lsSet would resolve bkey() at write time and is not safer here.
const DEVICE_GLOBAL = new Set([
  'notif-prompt-dismissed', 'cs_onb_hidden', 'sp-tab', 'bc_tour_done',
  'mascot-hidden', 'pwa-dismissed', 'bv_mic_tip_seen', 'stmt_tpl',
]);

// 5. BRAND BLEED — per-brand cache written with a bare localStorage call instead of lsGet/lsSet,
//    which namespaces by brand. This leaked one brand's blog/questions into another (v385).
//    DEVICE_GLOBAL below is an explicit judgement, not a silence: each key names a setting that
//    belongs to the DEVICE, not to a brand, so a shared value is the correct behaviour. A key that
//    is not listed here is treated as brand-scoped and fails. Adding a key here is a deliberate
//    claim that the same value is right for every brand on this device — justify it in the comment.
add('bare localStorage write bypassing lsSet (brand-bleed risk)',
  [...app.matchAll(/localStorage\.setItem\(\s*['"`]([\w-]+)['"`]/g)].map(m => m[1])
    .filter(k => !/^(cs_last_brand|bn-dark-mode|_ls_ns_migrated|tp_|mascot_|blog_started|home-brain-open|boring_pro_tools_open|tp_primer_v2|trend_window_hours)/.test(k))
    .filter(k => !DEVICE_GLOBAL.has(k))
    .filter(k => !/^notebook_/.test(k)));

// 6. UNAUTHENTICATED endpoints — any api route that has NO recognised form of access control.
//    Each accepted form is named, and matched against code with comments and string contents
//    removed (`code`), or with comments removed and strings kept (`text`) where the evidence is
//    legitimately a literal — a require() path, a Stripe URL, the word Bearer.
{
  // Vercel does not route files whose name starts with "_"; they are shared modules.
  // health.js is a deliberately public liveness probe and returns no user data.
  const skip = new Set(['health.js', 'push-key.js']);
  const AUTH_FORMS = [
    ['plan meter (guard/checkLimit)', (code) => /\bguard\s*\(\s*req\b/.test(code) || /\bcheckLimit\s*\(/.test(code)],
    ['signed-in user (_requireUser/getUser)', (code, text) =>
      /require\(['"]\.\/_requireUser['"]\)/.test(text) || /\bgetUser\s*\(/.test(code)],
    ['Vercel cron secret', (code) => /process\.env\.CRON_SECRET/.test(code) && /req\.headers\.authorization/.test(code)],
    ['Bearer token on the request', (code, text) => /req\.headers\.authorization/.test(code) && /Bearer /.test(text)],
    ['Stripe-authenticated webhook (event re-fetched by id with our secret key)', (code, text) =>
      /\/v1\/events\//.test(text) && /process\.env\.STRIPE_SECRET_KEY/.test(code)],
    ['retired stub (answers 410 and nothing else)', (code) =>
      /status\(410\)/.test(code) && !/status\(2\d\d\)/.test(code)],
  ];
  const unauth = [];
  let scanned = 0;
  for (const f of fs.readdirSync(path.join(root, 'api')).filter(f => f.endsWith('.js') && !f.startsWith('_') && !skip.has(f))) {
    const raw = fs.readFileSync(path.join(root, 'api', f), 'utf8');
    const code = stripCode(raw), text = stripComments(raw);
    scanned++;
    if (!AUTH_FORMS.some(([, test]) => test(code, text))) unauth.push(f);
  }
  if (scanned < 25) unauth.push(`(scanner reached only ${scanned} endpoints — it is broken, not the code)`);
  add('api endpoint with no auth or cron guard', unauth);
}

// 7. TEMPLATE-LITERAL REGEX with single backslashes in the harness taps — the escape is eaten on
//    evaluation, so the regex either throws or silently matches the wrong thing (cost 3 runs).
const harness = fs.readFileSync(path.join(root,'mobile-user.js'),'utf8');
add('single-backslash regex inside a taps template literal',
  [...harness.matchAll(/taps:\s*\[[\s\S]{0,4000}?\]/g)].flatMap(m =>
    [...m[0].matchAll(/(?<!\\)\\[sdwSDW(){}]/g)].map(x => `...${m[0].slice(Math.max(0,x.index-40), x.index+20).replace(/\n/g,' ')}...`)));

if (findings.length) {
  for (const [cls, items] of findings) { console.error(`\n■ ${cls} — ${items.length}`); items.slice(0,12).forEach(i => console.error('   ' + i)); if (items.length>12) console.error(`   ...and ${items.length-12} more`); }
  console.error(`\n${findings.length} bug class(es) with findings`);
  process.exit(1);
}
console.log('scanned 7 bug classes, no findings');
console.log('bug scan verification passed');
