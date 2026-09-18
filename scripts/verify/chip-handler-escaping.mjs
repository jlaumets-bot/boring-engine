#!/usr/bin/env node
// GATE: a value going into an inline onclick="..." handler is JS-escaped, not HTML-escaped —
//       and the visible label beside it is HTML-escaped.
//
// WHY THIS EXISTS
//   The Settings example chips built their handler like this:
//       const safe = c.replace(/'/g, '&#39;');
//       '... onclick="spChipClick(\'' + key + '\',\'' + safe + '\',this)">' + c + '</span>'
//   That looks safe and is not. The HTML parser DECODES entities in an attribute value BEFORE
//   the JS is compiled, so `&#39;` became a bare apostrophe, the string literal ended there,
//   and the handler was a SyntaxError. The chip did nothing when tapped — no error, no toast,
//   nothing to report. A SHIPPED chip hit it: SP_CHIPS.productDetails contains
//   "What's included". So does every AI-written chip in spBrandChips, which is unbounded text.
//   The label `c` was also interpolated raw, so a chip could close the span and open a tag.
//   escJs exists for exactly this slot; escHtml for the label.
//
//   Two halves, both pinned here: spChipClick used to RE-DECODE `&#39;`, which was the other
//   half of the same bug. With correct escaping that decode silently mangles any chip whose
//   real text contains "&#39;" or "&quot;", so it is gone.
//
// HOW IT CHECKS
//   The real SP_CHIPS, escJs, escHtml, spRenderFieldExtras and spChipClick are lifted out of
//   app.html and run in a vm. Every rendered handler is entity-decoded the way a browser would
//   and then COMPILED with new Function — a SyntaxError fails the gate. Each handler is then
//   executed against a fake textarea, and the text that lands must equal the chip byte for
//   byte. A mutation arm re-runs the pre-fix markup and REQUIRES it to fail to compile.
//
// RUN:    node scripts/verify/chip-handler-escaping.mjs
// EXPECT: prints "PASS" and exits 0.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const fails = [];
const ok = (c, m) => { if (!c) fails.push(m); };

const grab = n => {
  const i = html.indexOf('\nfunction ' + n + '(');
  if (i < 0) { fails.push('app.html: function ' + n + ' is gone'); return 'function ' + n + '(){}'; }
  return html.slice(i + 1, html.indexOf('\n}', i) + 2);
};
const spStart = html.indexOf('const SP_CHIPS');
ok(spStart > -1, 'app.html: SP_CHIPS is gone');
const spSrc = html.slice(spStart, html.indexOf('\n};', spStart) + 3).replace(/^const /, 'var ');

// What a browser does to an attribute value before the JS is compiled.
const decodeAttr = v => v
  .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&amp;/g, '&');

const ctx = { console, settings: {}, spBrandChips: null, textareas: {}, updateSetting: () => {} };
ctx.document = { querySelector: s => { const k = (s.match(/data-sp-field="([^"]+)"/) || [])[1]; return ctx.textareas[k] || null; } };
vm.createContext(ctx);
vm.runInContext([
  spSrc, grab('escJs'), grab('escHtml'),
  'function spExamplesFor(key){var a=spBrandChips&&spBrandChips[key];return (Array.isArray(a)&&a.length)?a:(SP_CHIPS[key]||[]);}',
  grab('spRenderFieldExtras'), grab('spChipClick'),
].join('\n'), ctx);

// Chips a person or a model can really produce. The point is that NONE of these is special-cased.
const HOSTILE = [
  "What's included", 'He said "no"', 'a\\b', '</span><script>x=1</script>', "back\\'slash",
  'Tom & Jerry\'s', 'line\nbreak', 'tab\there', '&#39;literal entity&#39;', '&quot;q&quot;',
  "it's a 'quoted' thing", '— em dash —', '<img src=x onerror=1>', "';alert(1);//",
];

let handlers = 0;
const keys = vm.runInContext('Object.keys(SP_CHIPS)', ctx);
ok(keys.length > 0, 'SP_CHIPS is empty — this gate would prove nothing');

const check = (key, expected) => {
  const markup = vm.runInContext('spRenderFieldExtras(' + JSON.stringify(key) + ')', ctx);
  if (!markup) return;
  // one span per chip, balanced — a chip must not be able to inject a tag
  const opens = (markup.match(/<span/g) || []).length, closes = (markup.match(/<\/span>/g) || []).length;
  ok(opens === closes && opens === expected.length,
    key + ': ' + expected.length + ' chips rendered ' + opens + ' open / ' + closes + ' close spans — a chip escaped its tag');
  ok(!/<script/i.test(markup), key + ': a chip injected a <script> tag');
  // the visible label must not carry a raw < or >
  for (const l of [...markup.matchAll(/<span class="sp-chip[^"]*" onclick="[^"]*">([^<]*)<\/span>/g)].map(m => m[1]))
    ok(!/[<>]/.test(l), key + ': chip label is not HTML-escaped: ' + JSON.stringify(l));

  const got = [];
  ctx.textareas[key] = { value: '' };
  [...markup.matchAll(/onclick="([^"]*)"/g)].forEach((m, ix) => {
    handlers++;
    const js = decodeAttr(m[1]);
    try { new Function(js); } catch (e) {
      fails.push(key + ' chip ' + ix + ': handler does not COMPILE — ' + e.message + '  |  ' + js);
      return;
    }
    // run it for real against a fake textarea and see what lands
    ctx.textareas[key].value = '';
    try { vm.runInContext(js.replace(/,\s*this\)/, ', {classList:{add:function(){}}})'), ctx); }
    catch (e) { fails.push(key + ' chip ' + ix + ': handler threw when run — ' + e.message); return; }
    got.push(ctx.textareas[key].value);
  });
  expected.forEach((c, ix) => ok(got[ix] === c,
    key + ' chip ' + ix + ': the textarea got ' + JSON.stringify(got[ix]) + ' but the chip reads ' + JSON.stringify(c)));
};

for (const key of keys) check(key, vm.runInContext('SP_CHIPS[' + JSON.stringify(key) + ']', ctx));
ctx.spBrandChips = { usps: HOSTILE };          // the AI-written path, which is unbounded text
check('usps', HOSTILE);
ok(handlers >= keys.length, 'only ' + handlers + ' handlers were exercised');

// ── the re-decode in spChipClick must stay gone ────────────────────────────────────────────
const click = grab('spChipClick');
ok(!/replace\(\/&#39;\/g/.test(click),
  'spChipClick re-decodes &#39; again — that was the other half of the escaping bug and it mangles literal entity text');

// ── MUTATION: the pre-fix markup MUST fail, or this gate is vacuous ─────────────────────────
{
  const c = "What's included";
  const safe = c.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
  const old = '<span class="sp-chip" onclick="spChipClick(\'productDetails\',\'' + safe + '\',this)">' + c + '</span>';
  let broke = false;
  try { new Function(decodeAttr(old.match(/onclick="([^"]*)"/)[1])); } catch (e) { broke = true; }
  ok(broke, 'MUTATION CHECK FAILED: the pre-fix chip markup now compiles, so this gate proves nothing');
}
// and the current renderer must genuinely use escJs for the handler slot
ok(/onclick="spChipClick\(\\'' \+ escJs\(key\) \+ '\\','' \+ escJs\(c\)/.test(grab('spRenderFieldExtras')) ||
   /escJs\(c\)/.test(grab('spRenderFieldExtras')),
  'spRenderFieldExtras no longer JS-escapes the chip text for the handler');
ok(/escHtml\(c\)/.test(grab('spRenderFieldExtras')),
  'spRenderFieldExtras no longer HTML-escapes the visible chip label');

if (fails.length) { console.error('FAIL\n- ' + fails.join('\n- ')); process.exit(1); }
console.log('PASS — ' + handlers + ' chip handlers compile and deliver their text byte-exact');
