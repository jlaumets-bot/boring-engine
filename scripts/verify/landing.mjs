#!/usr/bin/env node
// G42 — landing page (index.html) says only true things and is structurally sound.
//
// The landing is the one shipped page nothing else parses. This gate proves:
//   A. structure — tag balance (comments stripped), every inline script parses, JSON-LD parses
//      and carries the live prices, every nav anchor resolves to an id on the page;
//   B. honesty — no shelved or removed feature is advertised (memes, blog, publishing/auto-pilot,
//      the analyzer under its old name), no removed section survives (the loop iframe, the hidden
//      typewriter demo, the "effortless" grid), no stale price or trial length;
//   C. the agreed shape — H1, 6 format cards, 8 tool cards, 4 learn cards, 4 comparison rows,
//      the pain strip and brain animation kept, the voice named in the learn section and the FAQ.
// Assertions are on structure and concepts, never on exact marketing copy (v619 lesson).
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
for (const tag of ['section', 'div', 'header', 'nav', 'footer', 'ul', 'li', 'h1', 'h2', 'h3', 'p', 'a', 'span', 'style', 'script']) {
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

// ── B. honesty ────────────────────────────────────────────────────────────────────────────────
const banned = [
  [/\bmemes?\b/i, 'memes (shelved v571)'], [/\bblog\b/i, 'blog (shelved v444, retired v627)'],
  [/auto-?pilot|auto-?publish|one-tap publish/i, 'publishing/auto-pilot (deleted v633)'],
  [/viral lab/i, 'Viral Lab (renamed v462)'], [/reverse-engineers/i, 'the analyzer pitch (demoted v646)'],
  [/loopFrame|brand-brain-animation/, 'the loop iframe (removed)'], [/id="demoCard"|dmRowBrand|typewriter/, 'the hidden hero demo (removed)'],
  [/id="easy"/, 'the effortless grid (folded into one line)'], [/21-day|\$49|\$99/, 'stale price or trial length'],
  [/Claude|Groq|OpenAI/, 'a model vendor other than the engine in use'],
];
for (const [re, why] of banned) ok(!re.test(live), 'B1 page does not mention ' + why + ' — ' + (live.match(re) || [''])[0]);
ok(/\bGrok\b|frontier model/i.test(live), 'B2 the engine is described honestly (Grok / frontier model)');
ok(/7[- ]day/.test(live) && /\$24/.test(live) && /\$79/.test(live), 'B3 visible copy carries 7-day trial, $24 and $79');

// ── C. the agreed shape ───────────────────────────────────────────────────────────────────────
const h1 = (live.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '';
ok(/what to post/i.test(h1), 'C1 H1 is the "never wonder what to post" promise (' + h1.replace(/<[^>]+>/g, '').trim() + ')');
ok(/class="pain-strip"/.test(live), 'C2 pain strip kept');
ok(/class="lp-brain"/.test(live) && /lpStage/.test(live), 'C3 brain animation kept');
ok(count(section('formats'), /class="func reveal"/g) === 6, 'C4 exactly 6 format cards (' + count(section('formats'), /class="func reveal"/g) + ')');
ok(count(section('features'), /class="func reveal"/g) === 8, 'C5 exactly 8 tool cards (' + count(section('features'), /class="func reveal"/g) + ')');
ok(count(section('how'), /class="beat reveal"/g) === 4, 'C6 exactly 4 learn cards (' + count(section('how'), /class="beat reveal"/g) + ')');
const first = (section('how').match(/<h3>([^<]+)<\/h3>/) || [])[1] || '';
ok(/hear/i.test(first), 'C7 the first learn card is "it hears you" (' + first + ')');
ok(count(live, /class="cmp-row"(?! cmp-head)/g) === 8, 'C8 exactly 8 comparison rows (' + count(live, /class="cmp-row"(?! cmp-head)/g) + ')');
// the comparison must CONCEDE what ChatGPT does (a straw man loses the reader): every left cell leads with a bold topic and none opens with a negative glyph
const them = [...live.matchAll(/<div class="cmp-cell them">([\s\S]*?)<\/div>/g)].map(m => m[1]).slice(1);
ok(them.length === 8 && them.every(c => /<b>[^<]+<\/b>/.test(c)) && !them.some(c => /cmp-x/.test(c)), 'C8b every ChatGPT cell concedes a real capability under a bold topic, no ○ straw-man glyph');
ok(/remembers (things|facts) about you/i.test(live) && /browses/i.test(live), 'C8c the intro concedes memory and browsing honestly');
ok(count(section('sources'), /class="moat-row"/g) === 5, 'C9 five idea sources');
const fmts = ['script', 'statement', 'carousel', 'micro-lecture', 'q&amp;a', 'static'];
for (const f of fmts) ok(new RegExp(f, 'i').test(section('formats')), 'C10 format present: ' + f);
const faqQs = [...live.matchAll(/class="faq-q"[^>]*>([\s\S]*?)<span/g)].map(m => m[1].trim());
ok(faqQs.some(q => /sound like me/i.test(q)) && /heard you/i.test(live), 'C11 FAQ answers "will it sound like me" with the voice');
ok(faqQs.some(q => /kinds of posts/i.test(q)) && faqQs.some(q => /nothing to say/i.test(q)), 'C12 FAQ covers the formats and the sources');
ok(/voiceLearn|How you talk/.test(live), 'C13 the animation streams "How you talk" in as a source');
ok(!/Memes|Viral angles/.test((live.match(/var TOOL=\[[^\]]*\]/) || [''])[0]), 'C14 the animation streams no shelved tool out');

console.log(fail ? 'landing: ' + pass + ' passed, ' + fail + ' FAILED' : 'landing verification passed (' + pass + ' assertions)');
process.exit(fail ? 1 : 0);
