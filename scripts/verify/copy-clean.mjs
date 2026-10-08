#!/usr/bin/env node
// GATE (v703 copy & polish, SPEC.md "Copy & symbols"): words and symbols that work on a phone AND a desktop.
// Static scan of app.html's UI strings (comments are blanked first), plus the tour and the note dates run in node:vm.
//   1  no "tap" (any case, as a word) in a UI string — markup, placeholders, toasts, tooltips, tour text.
//   2  no emoji / text glyphs used as icons: 🎙 ★ ↻ ▲ ✎ ↳ ◀ ▶ ▼ ▾ and "← Close" / "← Back" (also as entities / \u escapes).
//   3  one label set for the same fields on Quick Post, the Ideas / Pipeline detail and the writer sheet:
//      Title · Hook · Script · Shot list · Caption · Hashtags · Call to action (+ the format-only ones), sentence case,
//      one label component (.detail-label) and one copy button (.section-copy-btn, tooltip "Copy").
//   4  no shrimp images on the splash, sign-in or any onboarding step; the setting is "Coach bubble".
//   5  the Help tour: every step has a desktop AND a phone target that the app actually renders; the tooltip is
//      kept inside the window; the dim is one translucent layer (the screen stays readable).
//   6  note dates read "Today", "Yesterday" or a local date with the month as a word — never 10/8/2026.
// RUN: node scripts/verify/copy-clean.mjs      EXPECT: prints "COPY CLEAN OK", exit 0.
import fs from 'node:fs'; import vm from 'node:vm';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
setTimeout(() => { console.log('FAIL: wall clock (60s) exceeded'); process.exit(2); }, 60000).unref();
let finished = false; process.on('exit', (code) => { if (!finished && code === 0) { console.log('FAIL: the gate ended before all checks ran'); process.exitCode = 1; } });
let fail = 0; const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('ok:', m); };
const grab = n => {
  let i = html.indexOf('\nfunction ' + n + '('); if (i < 0) throw new Error('no ' + n);
  return html.slice(i + 1, html.indexOf('\n}', i) + 2);
};
// UI text = app.html with comments blanked (offsets kept, so line numbers stay true)
const blank = m => m.replace(/[^\n]/g, ' ');
let ui = html.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/<!--[\s\S]*?-->/g, blank)
  .replace(/(^|[\s;{}(),])\/\/[^\n]*/gm, (m, a) => a + ' '.repeat(m.length - a.length));
const lineOf = i => html.slice(0, i).split('\n').length;
const hits = (re) => { const out = []; let m; const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'); while ((m = r.exec(ui))) out.push(lineOf(m.index) + ': ' + html.slice(Math.max(0, m.index - 40), m.index + 40).replace(/\s+/g, ' ')); return out; };

/* ═══ 1. tap ═══ */
{
  const ALLOW = [];   // none needed
  const h = hits(/(?<![\w.\-#])(?:tap|taps|tapped|tapping)(?![\w\-])/i).filter(x => !ALLOW.some(a => x.includes(a)));
  ok(!h.length, '1 no "tap" wording in UI strings' + (h.length ? ' — ' + h.length + ':\n    ' + h.slice(0, 8).join('\n    ') : ''));
  ok(/'Press again to discard' : 'Close'/.test(html) && /Pick one to open it in Remix/.test(html) && /<span class="tp-edit-hint">\$\{pencil\}Edit<\/span>/.test(html), '1 the named replacements are in (discard / Remix / Edit)');
}

/* ═══ 2. glyph icons ═══ */
{
  const h = hits(/🎙|★|↻|▲|✎|↳|◀|▶|▼|▾|&#9664;|&#9654;|&#9660;|&#9650;|&#9662;|\\u25B6|\\u25C0|\\u25BC|\\u25B2|\\u25BE|\\u2605|\\u21BB|\\u270E|\\u21B3|← ?Close|← ?Back|&larr; ?Back|\\u2190 ?(?:Back|Close)/i);
  ok(!h.length, '2 no emoji / text-glyph icons (🎙 ★ ↻ ▲ ✎ ↳ ◀ ▶ ▼ ▾, ← Close, ← Back)' + (h.length ? ' — ' + h.length + ':\n    ' + h.slice(0, 8).join('\n    ') : ''));
  ok((html.match(/<span class="fold-caret" aria-hidden="true"><svg class="cs-ic"/g) || []).length >= 7, '2 the "or … " folds use a drawn chevron');
  ok(/aria-label="Previous slide"/.test(html) && /aria-label="Next slide"/.test(html), '2 Make Slides arrows are drawn icons with labels');
  ok(/\.header-brand::after \{\n  content: url\("data:image\/svg\+xml/.test(html), '2 the phone header caret is a drawn chevron');
}

/* ═══ 3. one label set ═══ */
{
  const ALLOWED = new Set(['Title', 'Hook', 'Script', 'Shot list', 'Caption', 'Hashtags', 'Call to action', 'Preview', 'Text', 'Design instructions', 'Statement', 'Slides', 'Shooting tips', 'Why you follow them', 'Links']);
  const rdc = grab('renderDetailContent');
  const labels = [];
  for (const m of rdc.matchAll(/class="detail-label">([^<$]+?)\s*(?:\$\{|<)/g)) labels.push(m[1].trim());
  for (const m of rdc.matchAll(/class="detail-label">\$\{[^?]+\?'([^']+)':'([^']+)'\}/g)) labels.push(m[1], m[2]);
  const tvSrc = html.slice(html.indexOf('function tvFieldHtml('), html.indexOf('const dismissChips', html.indexOf('function tvFieldHtml(')));
  for (const m of tvSrc.matchAll(/tvFieldHtml\((?:[^,]*\?\s*)?'([^']+)'(?:\s*:\s*'([^']+)')?/g)) { labels.push(m[1]); if (m[2]) labels.push(m[2]); }
  const rv2 = html.slice(html.indexOf('function rv2CardHtml('), html.indexOf('\n}', html.indexOf('function rv2CardHtml(')));
  for (const m of rv2.matchAll(/class="detail-label">([^<]+)</g)) labels.push(m[1]);
  const csx = html.slice(html.indexOf('/* ===== v703 DESKTOP-NATIVE STRUCTURE (D2)'), html.indexOf('/* ===== end v703 desktop-native structure ===== */'));
  for (const m of csx.matchAll(/class="detail-label">([^<]+)</g)) labels.push(m[1]);
  const bad = [...new Set(labels.filter(l => !ALLOWED.has(l)))];
  ok(labels.length >= 14 && !bad.length, '3 every field label on Quick Post, the detail panes and the writer sheet is from the one set (' + labels.length + ' labels)' + (bad.length ? ' — off-set: ' + bad : ''));
  const banned = hits(/Reel Title|Full Script|Design Instructions|Say this first|Your script, to say out loud|>Shot List|'Shot List'|tvFieldHtml\('CTA'|tvFieldHtml\('Tags'|>Tags \$\{|class="[^"]*\btp-field-copy|class="[^"]*\bcopy-reel-btn|class="tp-field-label"|class="rv2-lbl">(?:Hook|Script)/);
  ok(!banned.length, '3 the old names and the old label / copy components are gone' + (banned.length ? ' — ' + banned.slice(0, 6).join(' | ') : ''));
  ok(/title="Copy" aria-label="Copy\$\{lab\}"/.test(grab('sectionCopyBtn')) && /<button class="section-copy-btn" onclick="tvCopy\('\$\{id\}',this\)" title="Copy"/.test(tvSrc)
    && /if \(btn && btn\.classList && btn\.classList\.contains\('section-copy-btn'\) && typeof copyText === 'function'\) return copyText\(el\.textContent, btn\);/.test(grab('tvCopy')), '3 one copy button (icon, tooltip "Copy") everywhere, with one copied feedback');
  ok(/<div class="tp-field"><div class="detail-label"><span>\$\{label\}<\/span>/.test(tvSrc), '3 Quick Post fields use the same label component as the detail panes');
}

/* ═══ 4. shrimp art ═══ */
{
  const seg = (a, b) => { const i = html.indexOf(a); const j = html.indexOf(b, i); return i < 0 || j < 0 ? '' : html.slice(i, j); };
  const splash = seg('<div id="csSplash">', '</div>\n</div>');
  const auth = seg('<div id="authScreen"', '<div id="onboardingOverlay"');
  const onb = seg('<div id="onboardingOverlay"', '<!-- ===== END ONBOARDING WIZARD ===== -->');
  ok(splash.length > 50 && auth.length > 200 && onb.length > 2000, '4 found the splash, sign-in and onboarding markup');
  ok(![splash, auth, onb].some(x => /shrimp[^"']*\.png/i.test(x)), '4 no shrimp image on the splash, sign-in or any onboarding step');
  ok(!/The shrimp will remind you|the shrimp will resurface|>Shrimp Mascot</.test(ui) && /<div class="ws-row-title">Coach bubble<\/div>/.test(html), '4 no shrimp wording in UI chrome; the setting is "Coach bubble"');
  ok(!/mascot-bubble-av"><img src="\/shrimp/.test(html) && !/textContent ?= ?'Shrimp/.test(ui), '4 the coach bubble head says "Coach" with a drawn icon');
}

/* ═══ 5. tour ═══ */
{
  const c = { window: { innerWidth: 1440 }, console };
  vm.createContext(c);
  const block = html.slice(html.indexOf('const TOUR_STEPS = ['), html.indexOf('function startTour()'));
  vm.runInContext(block.replace(/^const /, 'var ').replace(/\nlet /g, '\nvar '), c);
  const S = c.TOUR_STEPS;
  const produced = id => new RegExp('\\bid="' + id + '"|\\.id ?= ?[\'"]' + id + '[\'"]|id="' + id.replace(/-.*/, '') + '-|\\bid = \'' + id + '\'|\'' + id.replace(/-\w+$/, '-') + '\' \\+ view').test(html);
  const ids = sel => [...String(sel).matchAll(/#([A-Za-z][\w-]*)/g)].map(m => m[1]);
  const missingIds = [...new Set(S.flatMap(s => [...ids(s.deskTarget), ...ids(s.phoneTarget)]).filter(id => !produced(id)))];
  ok(S.length >= 5 && S.every(s => s.deskTarget && s.phoneTarget && s.title && s.text && s.phoneText), '5 every tour step has a desktop target, a phone target, a title and both texts (' + S.length + ' steps)');
  ok(S.every(s => c.tourTargetSel(s, 1440) === s.deskTarget && c.tourTargetSel(s, 375) === s.phoneTarget), '5 ≥900px uses the desktop target, <900px the phone target');
  ok(!missingIds.length, '5 every id a step points at is rendered by the app' + (missingIds.length ? ' — missing: ' + missingIds : ''));
  ok(!S.some(s => /nav-tab|#navTabs|\.header-actions/.test(s.deskTarget + s.phoneTarget)), '5 no step points at the retired tab bar or header row');
  ok(S.some(s => s.deskTarget === '#csxNewPost') && S.some(s => /csx-toolbar/.test(s.deskTarget)) && S.some(s => /csxList-/.test(s.deskTarget)) && S.some(s => /\{modK\}/.test(s.text)) && S.some(s => /desktopSidebar/.test(s.deskTarget)),
    '5 the desktop tour covers New post, the sidebar, the toolbar, list/detail and ⌘K');
  ok(S.filter(s => s.deskView || s.phoneView).every(s => ['ideas', 'today', 'pipeline'].includes(s.deskView) || ['ideas', 'today', 'pipeline'].includes(s.phoneView)), '5 steps that explain a screen open it first');
  const sts = grab('showTourStep');
  ok(/left = Math\.max\(12, Math\.min\(left, vw - ttw - 12\)\);/.test(sts) && /top = Math\.max\(12, Math\.min\(top, vh - tth - 12\)\);/.test(sts), '5 the tooltip is clamped inside the window (desktop step 1 used to land below the fold)');
  ok(/hl\.style\.boxShadow = '0 0 0 4000px rgba\(0,0,0,0\.5\)';/.test(sts) && /bd\.style\.background = 'transparent'/.test(sts), '5 one translucent dim — the screen being explained stays visible');
  ok(/if \(!el\) \{ tourStep \+= \(dir === -1 \? -1 : 1\);/.test(sts), '5 a step whose target is not on screen is skipped, not pointed at nothing');
}

/* ═══ 6. note dates ═══ */
{
  const c = { Date, Math, console }; vm.createContext(c); vm.runInContext(grab('nbTimeAgo'), c);
  const now = Date.now(), day = 86400000;
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const r = [c.nbTimeAgo(now - 30 * 60000), c.nbTimeAgo(today0.getTime() + 1000), c.nbTimeAgo(today0.getTime() - 3600000), c.nbTimeAgo(now - 40 * day)];
  ok(r[0] === '30 min ago' && (r[1] === 'Today' || /min ago/.test(r[1])) && r[2] === 'Yesterday', '6 recent notes read "30 min ago", "Today", "Yesterday" (' + r.slice(0, 3).join(' / ') + ')');
  ok(!/\d+\/\d+\/\d+/.test(r[3]) && /[A-Za-z]{3}/.test(r[3]) && /\d{4}/.test(r[3]), '6 older notes read as a local date with the month as a word (' + r[3] + ')');
}

finished = true;
if (fail) { console.log('\nCOPY CLEAN FAILED (' + fail + ')'); process.exit(1); }
console.log('\nCOPY CLEAN OK');
