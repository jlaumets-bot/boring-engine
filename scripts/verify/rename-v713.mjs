#!/usr/bin/env node
// GATE (v713, owner 2026-11-04): the public name of "Remix" is now "Make it yours" ("Remix" reads as copying;
// the product makes YOUR version in your brand's voice). The homepage headline is "Paste any TikTok. Make it yours."
// STATIC (the rendered-DOM pass lives in the cloud harness; this gate must run anywhere with plain node):
//   1  CS_REMIX_NAME = 'Make it yours' (it feeds the sidebar, drawer, tab bars, palette and both page titles).
//   2  app.html has no visible "remix" (any case): comments are blanked, then every stand-alone word
//      remix / remixes / remixed / remixing is judged. Code stays code: identifiers (remixCount, isRemix,
//      .remix-mode-tag, /api/remix, REMIXES_KEY), bare lowercase keys ('remix', remix: …), console text and
//      internal Error() text. Anything capitalised, or lowercase inside a quoted phrase with a space, or inside
//      a >text< node, is visible copy and fails. The detector proves itself first on planted samples.
//   3  index.html, faq.html, llms.txt and brand-brain-animation.html carry no "remix" at all (comments aside).
//   4  the homepage h1 is exactly: Paste any TikTok. <em>Make it yours.</em>  (one h1 on the page).
//   5  "Make it mine" is gone (app + homepage); the Trends button says "Make it yours →", so the app uses one phrase.
//   6  the default angle's badges follow Step 2's name "My take" (never the old feature name).
// RUN: node scripts/verify/rename-v713.mjs      EXPECT: prints "RENAME V713 OK", exit 0.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let finished = false; process.on('exit', (code) => { if (!finished && code === 0) { console.log('FAIL: the gate ended before all checks ran'); process.exitCode = 1; } });
let fail = 0; const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('ok:', m); };

const blank = s => s.replace(/[^\n]/g, ' ');
const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/<!--[\s\S]*?-->/g, blank)
  .replace(/(^|[\s;{}(),])\/\/[^\n]*/gm, (m, a) => a + ' '.repeat(m.length - a.length));

// Visible-"remix" detector. Returns [{line, text}] of hits judged visible.
function visibleRemix(src) {
  const lines = stripComments(src).split('\n'), out = [];
  const W = /(?<![A-Za-z0-9_$.\-/#])(remix(?:es|ed|ing)?)(?![A-Za-z0-9_$\-])/gi;
  const Q = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\\n]|\\.)*`/g;
  lines.forEach((l, i) => {
    let m; W.lastIndex = 0;
    while ((m = W.exec(l))) {
      const a = m.index, b = a + m[1].length, w = m[1], lower = w === w.toLowerCase();
      const pre = a ? l[a - 1] : '', post = l[b] || '';
      if (lower && /['"`]/.test(pre) && post === pre) continue;              // 'remix' — a key / mode id
      if (lower && /^\s*:/.test(l.slice(b))) continue;                       // remix: … — an object key
      if (l.slice(0, a).includes('console.')) continue;                      // console text, never shown
      if (lower && /Error\(\s*['"]$/.test(l.slice(Math.max(0, a - 30), a))) continue;   // internal Error() text, never shown
      let vis = !lower;
      if (!vis) {
        Q.lastIndex = 0; let q;
        while ((q = Q.exec(l))) if (q.index < a && q.index + q[0].length > b && / /.test(q[0])) vis = true;
        if (/>[^<>'"]*$/.test(l.slice(0, a)) && /^[^<>'"]*</.test(l.slice(b))) vis = true;
      }
      if (vis) out.push({ line: i + 1, text: l.slice(Math.max(0, a - 50), b + 40).trim() });
    }
  });
  return out;
}

/* ═══ 0. the detector proves itself ═══ */
{
  const bad = ["showToast('Remix copied');", '<button onclick="go()">Remix it</button>', "say(\"Couldn't remix that.\");",
    '<p>paste a link to remix it</p>', '<button aria-label="Open remix">x</button>', "const t = { create:'Remix' };",
    "x = '<span class=\"tag\">REMIXES</span>';", "tip: 'Use Remix to adapt'"];
  const good = ["const remixCount = remixes.length;", "setRemixMode(this, 'remix')", "data-mode=\"remix\"", "{ remix: 'My take' }",
    "/api/remix", "class=\"remix-mode-tag\"", "isRemix: true", "const REMIXES_KEY = 'x';", "console.error('Remixes load error:', e);",
    "return { error: new Error('remixes were never loaded') };", "// Remix comment", "/* Remix */", "<!-- Remix -->", "remix.platform = p;"];
  const missed = bad.filter(s => !visibleRemix(s).length), wrong = good.filter(s => visibleRemix(s).length);
  ok(!missed.length, '0 the detector flags every planted visible "remix"' + (missed.length ? ' — missed: ' + missed.join(' | ') : ''));
  ok(!wrong.length, '0 the detector leaves code alone' + (wrong.length ? ' — flagged: ' + wrong.join(' | ') : ''));
}

const app = read('app.html');
/* ═══ 1. the one constant ═══ */
ok(/\nvar CS_REMIX_NAME = 'Make it yours';/.test(app), "1 CS_REMIX_NAME = 'Make it yours'");
ok((app.match(/label:\s*CS_REMIX_NAME/g) || []).length >= 3 && /create:\s*CS_REMIX_NAME/.test(app), '1 menus and titles still read the constant');

/* ═══ 2. no visible "remix" in the app ═══ */
{
  const h = visibleRemix(app);
  ok(!h.length, '2 app.html shows no "remix" anywhere (labels, toasts, titles, aria, placeholders)' + (h.length ? ' — ' + h.length + ':\n    ' + h.slice(0, 10).map(x => x.line + ': ' + x.text).join('\n    ') : ''));
}

/* ═══ 3. public pages ═══ */
for (const f of ['index.html', 'faq.html', 'llms.txt', 'brand-brain-animation.html']) {
  let s; try { s = read(f); } catch (e) { ok(false, '3 ' + f + ' is readable'); continue; }
  const m = stripComments(s).match(/.{0,40}remix.{0,40}/i);
  ok(!m, '3 ' + f + ' never says "remix"' + (m ? ' — ' + m[0].trim() : ''));
}

/* ═══ 4. the homepage headline ═══ */
{
  const idx = read('index.html'), live = stripComments(idx);
  const h1s = [...live.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map(m => m[1].trim());
  ok(h1s.length === 1, '4 one h1 on the homepage (' + h1s.length + ')');
  ok(h1s[0] === 'Paste any TikTok. <em>Make it yours.</em>', '4 the h1 is exactly "Paste any TikTok. <em>Make it yours.</em>" (' + (h1s[0] || '') + ')');
  ok(!/never wonder/i.test((h1s[0] || '')), '4 the old "Never wonder what to post again" h1 is gone');
}

/* ═══ 5. one phrase ═══ */
{
  const idx = read('index.html');
  ok(!/make it mine/i.test(stripComments(app)) && !/make it mine/i.test(stripComments(idx)), '5 "Make it mine" is gone from the app and the homepage');
  ok(/onclick="remixTopPost\(\$\{i\}\)">Make it yours →<\/button>/.test(app), '5 the Trends button says "Make it yours →"');
}

/* ═══ 6. the default angle is "My take" everywhere ═══ */
ok(/\{ id: 'remix', label: 'My take' \}/.test(app) && /const modeBadges = \{ remix: 'My take',/.test(app)
  && /modeBadges\[r\.remixMode\] \|\| 'My take'/.test(app) && /const modeLabels = \{ remix: 'My take',/.test(app)
  && /data-mode="remix">My take<\/button>/.test(app), '6 Step 2, the classic form, the result badge and the saved label all call the default angle "My take"');

finished = true;
if (fail) { console.log('\nRENAME V713 FAILED (' + fail + ')'); process.exit(1); }
console.log('\nRENAME V713 OK');
