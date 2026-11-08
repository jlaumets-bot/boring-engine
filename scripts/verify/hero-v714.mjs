#!/usr/bin/env node
// GATE (v714, owner-approved copy 2026-11-06; MOVED in v722, owner-approved Grok-style mockups 2026-11-08): the 4 steps
// and the phone that plays them as a short loop. Since v722 they live in "How it works" (#how), not in the hero: the first
// screen is the paste box (landing-v722.mjs). The phone frames, buttons, motion rules and asset rules are unchanged.
// STATIC (plain node, no git, no browser):
//   1  the h1 is still exactly: Paste any TikTok. <em>Make it yours.</em>
//   2  in #how, under "Four steps.", ONE <ol id="heroSteps"> holds exactly the 4 v722 steps (title + one line), and the
//      v714 hero list / old "Tell it about your brand once…" paragraph are gone.
//   3  the phone (the one data-site-mock, aria-hidden) sits in #how next to the list and holds exactly 5 frames, data-frame
//      1..5 in order, one shown by default; frame 2 "Exact words", frame 3 "Your version" with a "My take" chip, frame 4 the
//      teleprompter with a ••• breathing gap, a highlighted line and stressed words, frame 5 a split screen with a B-roll caption.
//   4  5 frame buttons + 1 pause/play button sit OUTSIDE the aria-hidden phone, each a <button type="button"> with an
//      aria-label; the script wires them, pauses off-screen (IntersectionObserver) and in background tabs, and lights the
//      matching step: frames 1-5 → steps Paste link, Exact words, Your version, Film it, Film it (STEP=[0,1,2,3,3]).
//   5  no external URL added: every absolute or protocol-relative URL is on the v713 list; no src=, url( or @import.
//   6  reduced motion: the CSS @media(prefers-reduced-motion:reduce) block stops .hd-frame animation/transition,
//      and the script reads matchMedia('(prefers-reduced-motion: reduce)') and then does not auto-advance.
//   7  no gradient( anywhere; the demo script parses.
// RUN: node scripts/verify/hero-v714.mjs      EXPECT: prints "HERO V714 OK", exit 0.
import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const live = html.replace(/<!--[\s\S]*?-->/g, ' ');
let finished = false; process.on('exit', (code) => { if (!finished && code === 0) { console.log('FAIL: the gate ended before all checks ran'); process.exitCode = 1; } });
let fail = 0; const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('ok:', m); };

// the element that starts at index i (its tag), up to its matching close tag
function elementAt(src, i) {
  const tag = /^<([a-z][a-z0-9]*)/i.exec(src.slice(i));
  if (!tag) return '';
  const re = new RegExp('<(/?)' + tag[1] + '\\b[^>]*>', 'gi'); re.lastIndex = i;
  let depth = 0, t;
  while ((t = re.exec(src))) { if (t[1]) { if (--depth === 0) return src.slice(i, re.lastIndex); } else if (!/\/>$/.test(t[0])) depth++; }
  return '';
}

/* 1 */
const h1s = [...live.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map(m => m[1].trim());
ok(h1s.length === 1 && h1s[0] === 'Paste any TikTok. <em>Make it yours.</em>', '1 the h1 is unchanged: "Paste any TikTok. <em>Make it yours.</em>" (' + h1s.join(' | ') + ')');

/* 2 */
const ITEMS = [
  ['Paste link', 'Copy it from TikTok and paste it here.'],
  ['Exact words', 'Every word they said, written out.'],
  ['Your version', 'Rewritten in your brand’s voice, with your facts.'],
  ['Film it', 'A teleprompter that follows your voice. Add B-roll if you want.'],
];
const howAt = live.search(/<section\b[^>]*\bid="how"/);
const how = howAt >= 0 ? elementAt(live, howAt) : '';
ok(/<h2>Four steps\.<\/h2>/.test(how), '2 #how is headed "Four steps."');
const ols = [...live.matchAll(/<ol\b[^>]*\bid="heroSteps"[^>]*>/g)];
ok(ols.length === 1 && howAt >= 0 && ols[0].index > howAt && ols[0].index < howAt + how.length, '2 one <ol id="heroSteps">, inside #how (' + ols.length + ')');
const ol = ols.length ? elementAt(live, ols[0].index) : '';
const lis = [...ol.matchAll(/<li class="lp-bs">[\s\S]*?<b class="t">([^<]+)<\/b><span class="d">([^<]+)<\/span>[\s\S]*?<\/li>/g)].map(m => [m[1], m[2]]);
ok((ol.match(/<li\b/g) || []).length === 4 && lis.length === 4, '2 exactly 4 steps (' + lis.length + ')');
ITEMS.forEach((t, i) => ok(lis[i] && lis[i][0] === t[0] && lis[i][1] === t[1], '2 step ' + (i + 1) + ' is the approved text' + (lis[i] && lis[i][0] === t[0] && lis[i][1] === t[1] ? '' : ' — got: ' + (lis[i] || ['(missing)']).join(' / '))));
ok(!/class="hero-steps"/.test(live) && !/Tell it about your brand once/.test(live) && !/<p class="sub">/.test(live), '2 the v714 hero list and the old hero paragraph are gone');

/* 3 */
const mocks = [...live.matchAll(/<([a-z]+)\b[^>]*\bdata-site-mock\b[^>]*>/g)];
ok(mocks.length === 1 && /aria-hidden="true"/.test(mocks[0][0]), '3 one data-site-mock phone, aria-hidden="true"');
ok(mocks.length === 1 && mocks[0].index > howAt && mocks[0].index < howAt + how.length, '3 the phone sits in #how, beside the steps');
const mock = mocks.length ? elementAt(live, mocks[0].index) : '';
const frameTags = [...mock.matchAll(/<div class="hd-frame\b[^"]*"[^>]*>/g)];
const frames = frameTags.map(m => elementAt(mock, m.index));
ok(frames.length === 5, '3 the phone holds exactly 5 frames (' + frames.length + ')');
ok(frameTags.map(m => (/data-frame="(\d)"/.exec(m[0]) || [])[1]).join('') === '12345', '3 frames are data-frame 1..5 in order');
ok(frameTags.filter(m => /class="hd-frame[^"]*\bon\b/.test(m[0])).length === 1, '3 exactly one frame is shown by default');
const f = i => frames[i] || '';
ok(/@calm\.creator/.test(f(0)) && /hd-link/.test(f(0)) && !/<img|tiktok-logo/i.test(mock), '3 frame 1: a link by the fictional @calm.creator being pasted, no image or logo');
ok(/Exact words/.test(f(1)) && (f(1).match(/class="hd-ln"/g) || []).length >= 3, '3 frame 2: "Exact words" with a 3-4 line transcript');
ok(/Your version/.test(f(2)) && /class="mk-chip on">My take</.test(f(2)), '3 frame 3: "Your version" with the "My take" chip');
ok(/hd-beat/.test(f(3)) && /hd-cur/.test(f(3)) && (f(3).match(/class="hd-em"/g) || []).length >= 1 && /\.hd-beat::before\{content:'\\2022\\2022\\2022'/.test(live),
  '3 frame 4: teleprompter with a ••• breathing gap, a highlighted line and stressed words');
ok(/hd-split/.test(f(4)) && /hd-cam/.test(f(4)) && /hd-broll/.test(f(4)) && /hd-cap/.test(f(4)), '3 frame 5: split screen, speaker on top, B-roll with a caption below');

/* 4 */
const demoAt = live.indexOf('id="heroDemo"');
const demo = demoAt >= 0 ? elementAt(live, live.lastIndexOf('<', demoAt)) : '';
const outside = demo.replace(mock, ' ');
const dots = [...outside.matchAll(/<button\b[^>]*class="hd-dot"[^>]*>/g)].map(m => m[0]);
ok(dots.length === 5 && dots.every(b => /type="button"/.test(b) && /aria-label="[^"]+"/.test(b)), '4 5 frame buttons, type=button, each labelled, outside the hidden phone');
ok(/<button\b[^>]*class="hd-play"[^>]*aria-label="[^"]+"/.test(outside), '4 a labelled pause/play button');
ok(!/<button/.test(mock) && !/tabindex/.test(mock), '4 nothing focusable inside the aria-hidden phone');
ok(!/aria-live="(assertive)"/.test(demo), '4 no assertive live region');
const scripts = [...live.matchAll(/<script(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const js = scripts.find(s => /getElementById\('heroDemo'\)/.test(s)) || '';
let parses = false; try { new vm.Script(js); parses = !!js; } catch (e) {}
ok(parses, '7 the demo script exists and parses');
ok(/new IntersectionObserver\(/.test(js) && /\.observe\(demo\)/.test(js), '4 pauses off-screen (IntersectionObserver on the demo)');
ok(/visibilitychange/.test(js) && /document\.hidden/.test(js), '4 pauses in a background tab');
ok(/addEventListener\('click'/.test(js) && /setAttribute\('aria-current','step'\)/.test(js), '4 the buttons switch frames and mark the current one');
ok(/getElementById\('heroSteps'\)/.test(js) && /items\[k\]\.classList\.toggle\('on',k===STEP\[i\]\)/.test(js) && /STEP=\[0,1,2,3,3\]/.test(js), '4 the matching step is lit with its frame (STEP=[0,1,2,3,3])');

/* 5 */
const ALLOWED = new Set(['https://contentshrimp.com', 'https://contentshrimp.com/', 'https://contentshrimp.com/og-image.png',
  'https://fonts.googleapis.com', 'https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap',
  'https://fonts.gstatic.com', 'https://schema.org']);
const urls = [...html.matchAll(/(?:https?:)?\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+[^"'\s)<>]*/g)].map(m => m[0])
  .filter(u => !/^\/\/\s/.test(u));
const extra = [...new Set(urls)].filter(u => !ALLOWED.has(u));
ok(!extra.length, '5 no external URL added' + (extra.length ? ' — ' + extra.join(', ') : ''));
ok(!/\bsrc\s*=/.test(live) && !/url\(/.test(live) && !/@import/.test(live), '5 no src=, url( or @import (no outside assets)');

/* 6 */
const rm = [...live.matchAll(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{([\s\S]*?)\n\}/g)].map(m => m[1]).join('\n');
ok(/\.hd-frame[^{]*\{[^}]*animation:none!important;transition:none!important/.test(rm), '6 the reduced-motion CSS stops the demo frames moving');
ok(/matchMedia\('\(prefers-reduced-motion: reduce\)'\)/.test(js) && /running=!\(mq&&mq\.matches\)/.test(js) && /show\(running\?0:2\)/.test(js),
  '6 the script reads reduced motion: no auto-advance, frame 3 shows');

/* 7 */
ok(!/gradient\s*\(/i.test(html), '7 no gradient(');

finished = true;
if (fail) { console.log('\nHERO V714 FAILED (' + fail + ')'); process.exit(1); }
console.log('\nHERO V714 OK');
