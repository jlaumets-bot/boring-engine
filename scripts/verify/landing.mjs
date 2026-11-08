#!/usr/bin/env node
// G42 — landing page (index.html) says only true things and is structurally sound.
//
// The landing is the one shipped page nothing else parses. This gate proves:
//   A. structure — tag balance (comments stripped), every inline script parses, JSON-LD parses
//      and carries the live prices, every in-page anchor resolves to an id on the page, the footer
//      carries the legal links;
//   B. honesty — no shelved or removed feature is advertised (memes, blog, publishing/auto-pilot,
//      the analyzer under its old name), no stale price or trial length, no model vendor named;
//   C. the agreed shape — v722 (owner-approved Grok-style mockups design-options/landing/ A1–A4, 2026-11-08):
//      first screen (h1 + paste box + 4 tiny steps) → How it works ("Four steps." + the phone loop) →
//      Everything else inside → Pricing (3 plans) → FAQ (the existing 9 questions) → footer.
//      The v705–v721 long-form sections (pain strip, brain animation, format cards, idea sources, learn
//      cards, ChatGPT comparison, final call) were removed by that approval and must not creep back half-way.
// Assertions are on structure and concepts; the exact v722 copy is frozen by landing-v722.mjs.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const live = html.replace(/<!--[\s\S]*?-->/g, '');            // what a visitor actually gets
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + m); } };
const count = (s, re) => (s.match(re) || []).length;
const section = (id) => { const m = live.match(new RegExp('<section[^>]*id="' + id + '"[\\s\\S]*?<\\/section>')); return m ? m[0] : ''; };

// ── A. structure ──────────────────────────────────────────────────────────────────────────────
for (const tag of ['section', 'div', 'header', 'nav', 'footer', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'p', 'a', 'span', 'form', 'button', 'label', 'details', 'summary', 'style', 'script']) {
  const open = count(live, new RegExp('<' + tag + '(\\s|>)', 'g')), close = count(live, new RegExp('</' + tag + '>', 'g'));
  ok(open === close, 'A1 <' + tag + '> balanced (' + open + ' open / ' + close + ' close)');
}
const scripts = [...live.matchAll(/<script(?![^>]*type="application\/ld\+json")[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
ok(scripts.length >= 3, 'A2 inline scripts found (' + scripts.length + ')');
scripts.forEach((src, i) => { try { new vm.Script(src); pass++; } catch (e) { fail++; console.log('  FAIL: A3 inline script #' + i + ' does not parse: ' + e.message); } });
const ld = (live.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/) || [])[1];
let ldObj = null; try { ldObj = JSON.parse(ld); } catch (e) {}
ok(ldObj && ldObj['@type'] === 'SoftwareApplication', 'A4 JSON-LD parses as SoftwareApplication');
const prices = (ldObj && ldObj.offers || []).map(o => o.price).join(',');
ok(prices === '0,24,79', 'A5 JSON-LD offers carry the live prices 0/24/79 (' + prices + ')');
for (const m of live.matchAll(/href="#([a-z-]+)"/g)) ok(new RegExp('id="' + m[1] + '"').test(live), 'A6 anchor #' + m[1] + ' resolves to an id on the page');
const foot = (live.match(/<footer[\s\S]*?<\/footer>/) || [''])[0];
for (const h of ['/faq.html', '/terms.html', '/privacy.html', '/refunds.html', '/app.html']) ok(foot.includes('href="' + h + '"'), 'A7 the footer links ' + h);

// ── B. honesty ────────────────────────────────────────────────────────────────────────────────
const banned = [
  [/\bmemes?\b/i, 'memes (shelved v571)'], [/\bblog\b/i, 'blog (shelved v444, retired v627)'],
  [/auto-?pilot|auto-?publish|one-tap publish/i, 'publishing/auto-pilot (deleted v633)'],
  [/viral lab/i, 'Viral Lab (renamed v462)'], [/reverse-engineers/i, 'the analyzer pitch (demoted v646)'],
  [/loopFrame|brand-brain-animation/, 'the loop iframe (removed)'], [/id="demoCard"|dmRowBrand|typewriter/, 'the hidden hero demo (removed)'],
  [/id="easy"/, 'the effortless grid (folded into one line)'], [/21-day|\$49|\$99/, 'stale price or trial length'],
  [/Claude|Groq|OpenAI|Whisper|Apify|tikwm/, 'a model or data vendor'],
  [/Assistant/, 'the old "Assistant" name (it is "Coach")'], [/Jord\b/i, 'the wrong company name (JORG DIGITAL LTD)'],
];
for (const [re, why] of banned) ok(!re.test(live), 'B1 page does not mention ' + why + ' — ' + (live.match(re) || [''])[0]);
ok(/\bGrok\b|frontier model/i.test(live), 'B2 the engine is described honestly (Grok / frontier model)');
ok(/7[- ]day/.test(live) && /\$24/.test(live) && /\$79/.test(live), 'B3 visible copy carries 7-day trial, $24 and $79');

// ── C. the agreed shape (v722) ────────────────────────────────────────────────────────────────
const h1 = (live.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '';
ok(h1.trim() === 'Paste any TikTok. <em>Make it yours.</em>', 'C1 H1 is the v713 promise "Paste any TikTok. Make it yours." (' + h1.replace(/<[^>]+>/g, '').trim() + ')');
ok(count(live, /<h1[\s>]/g) === 1, 'C1b one h1');
const order = ['id="top"', 'id="how"', 'id="inside"', 'id="pricing"', 'id="faq"', '<footer'].map(k => live.indexOf(k));
ok(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), 'C2 sections in the approved order: first screen, How it works, Everything else inside, Pricing, FAQ, footer (' + order.join(',') + ')');
ok(/<form\b[^>]*id="tryForm"/.test(live) && /id="tryUrl"/.test(live) && count((live.match(/<ol[^>]*id="trySteps"[\s\S]*?<\/ol>/) || [''])[0], /<li>/g) === 4, 'C3 the first screen is the paste box with 4 tiny steps');
ok(count(section('how'), /<li class="lp-bs">/g) === 4 && /id="heroDemo"/.test(section('how')), 'C4 How it works: 4 steps and the phone loop');
ok(count(section('inside'), /<li class="lp-feat"/g) === 11, 'C5 Everything else inside: 11 features (' + count(section('inside'), /<li class="lp-feat"/g) + ')');
ok(count(section('pricing'), /<div class="price( pro)?">/g) === 3, 'C6 three price cards');
const removed = [[/class="pain-strip"/, 'pain strip'], [/class="lp-brain"|lpStage/, 'brain animation'], [/class="cmp-row"/, 'ChatGPT comparison'],
  [/id="formats"|class="func reveal"/, 'format / tool cards'], [/id="sources"/, 'idea sources'], [/class="beat reveal"/, 'learn cards'], [/class="final"/, 'final call']];
for (const [re, what] of removed) ok(!re.test(live), 'C7 the removed long-form ' + what + ' is not half back');
const faqQs = [...live.matchAll(/<details class="fq"><summary>([\s\S]*?)<span/g)].map(m => m[1].trim());
ok(faqQs.length === 9, 'C8 the 9 existing FAQ questions (' + faqQs.length + ')');
ok(faqQs.some(q => /sound like me/i.test(q)) && /heard you/i.test(live), 'C9 FAQ answers "will it sound like me" with the voice');
ok(faqQs.some(q => /kinds of posts/i.test(q)) && faqQs.some(q => /nothing to say/i.test(q)), 'C10 FAQ covers the formats and the sources');
const fmts = ['script', 'statement', 'carousel', 'explainer', 'q&amp;a', 'static'];
const fmtAnswer = (live.match(/kinds of posts[\s\S]*?<\/details>/) || [''])[0];
for (const f of fmts) ok(new RegExp(f, 'i').test(fmtAnswer), 'C11 the formats answer names: ' + f);

console.log(fail ? 'landing: ' + pass + ' passed, ' + fail + ' FAILED' : 'landing verification passed (' + pass + ' assertions)');
process.exit(fail ? 1 : 0);
