#!/usr/bin/env node
// GATE: the teleprompter's stress marks always belong to the script actually on screen.
//
// WHY THIS EXISTS
//   `emphasis` is the generator's list of short verbatim phrases to bold while the person reads to
//   camera — the ONE reading aid on that screen. Sharpen and Viral twist REPLACE the script but
//   left the old list behind. tpEmphasise's preferred branch is `if (marks.length)`, and it
//   RETURNS from there — so the number/flip-word heuristic never runs. Marks written for the old
//   script match nothing in the new one, and the teleprompter renders a flat wall of text.
//   Measured on the real tpEmphasise with a rewritten script containing a hard number and a flip
//   word:  stale marks kept -> 0 words emphasised;  marks pruned -> 2.
//   It fails mid-take, with the person on camera, and nothing says why. The mirror-image failure
//   is a stale mark that DOES appear in the new text, bolding a word the script never stressed.
//
// HOW IT CHECKS
//   Runs the real tpEmphasise and the real tpPruneEmphasis out of app.html. The wiring arm is
//   DERIVED, not a list: every call site that overwrites an idea's `script` from a model rewrite
//   must prune in the same block — so a fourth rewrite path added later fails here by itself.
//
// RUN:    node scripts/verify/teleprompter-emphasis-fresh.mjs
// EXPECT: prints "PASS" and exits 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const fails = [];
const bad = m => fails.push(m);

const fn = n => { const s = html.indexOf('function ' + n + '('); if (s < 0) throw new Error(n + ' missing from app.html');
  const e = html.indexOf('\n}', s); return html.slice(s, e + 2); };
const konst = n => { const m = html.match(new RegExp('^const ' + n + '\\s*=.*$', 'm'));
  if (!m) throw new Error(n + ' missing from app.html'); return m[0]; };

const { tpEmphasise, tpPruneEmphasis } = new Function([
  konst('TP_STRESS_A'), konst('TP_STRESS_B'),
  fn('tpEscape'), fn('tpOutsideTags'), fn('tpStressRx'), fn('tpEmphasise'), fn('tpPruneEmphasis'),
  'return { tpEmphasise, tpPruneEmphasis };'].join('\n'))();

const aids = s => (String(s).match(/tp-em/g) || []).length;

// ── 1. a rewritten script must not lose its reading aid ────────────────────────────────────
// Marks the generator wrote for the ORIGINAL script.
const OLD_MARKS = ['12 batches', '3 failed'];
// A rewrite with things the heuristic can act on, and none of the old marks in it.
const idea = { script: 'Most founders never check this, and it costs them 40% of their reach.', emphasis: OLD_MARKS.slice() };
const before = aids(tpEmphasise(idea.script, idea.emphasis));
tpPruneEmphasis(idea);
const after = aids(tpEmphasise(idea.script, idea.emphasis));
if (before !== 0) {
  bad('the fixture is not reproducing the defect — stale marks already emphasise something, so the ' +
      'comparison below proves nothing.');
}
if (after <= before) {
  bad(`pruning does not restore the reading aid: ${before} words emphasised before, ${after} after. ` +
      'A rewritten script leaves the person reading a flat wall of text, on camera, with nothing saying why.');
}

// ── 2. a mark that IS still in the text must survive ───────────────────────────────────────
const kept = { script: 'We tested 12 batches and most of them held.', emphasis: ['12 batches', '3 failed'] };
tpPruneEmphasis(kept);
if (!kept.emphasis.includes('12 batches')) {
  bad('pruning throws away a mark that is still present in the text. A rewrite that kept a phrase ' +
      'should keep its mark — blanket clearing loses the generator\'s own judgement.');
}
if (kept.emphasis.includes('3 failed')) bad('pruning kept a mark that is no longer anywhere in the text.');

// ── 3. it must look at every field the teleprompter renders, not just `script` ─────────────
const bodyOnly = { script: '', boldText: 'Nobody reads past the first line.', emphasis: ['Nobody reads'] };
tpPruneEmphasis(bodyOnly);
if (!bodyOnly.emphasis.length) bad('pruning ignores boldText, so a statement post loses marks that are genuinely still there.');

// ── 4. it can never throw, whatever it is handed ───────────────────────────────────────────
for (const v of [null, undefined, {}, { emphasis: null }, { emphasis: 'not an array' }, { emphasis: [null, 1, {}] }]) {
  try { tpPruneEmphasis(v); } catch (e) { bad('tpPruneEmphasis throws on ' + JSON.stringify(v) + ': ' + e.message); }
}

// ── 5. DERIVED: every rewrite path that overwrites the script must prune THAT object ──────
// Two things this arm learned the hard way. It first tested `/tpPruneEmphasis/` over a 600-char
// window, which (a) matched the word inside a nearby COMMENT and (b) was wide enough that a
// NEIGHBOURING block's prune satisfied it — two mutations escaped. So: comments are stripped
// first, and the prune must name the same object the rewrite just wrote to.
const stripComments = src => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');   // the [^:] keeps "https://" intact
const WRITERS = [
  ['Sharpen on an Ideas/Pipeline card', /Object\.keys\(nw\)\.forEach\(k=>\{ if\(nw\[k\]!=null && String\(nw\[k\]\)\.trim\(\)\) i\[k\]=nw\[k\]; \}\);/, 'i', 600],
  ["Sharpen's mirror write to the IDEAS row", /if\(_src && _src !== i\)/, '_src', 600],
  // v673: the assign coerces through asText() now — a model can send an array where a string
  // was asked for, and the raw value used to be persisted onto the idea (model-shape-coercion.mjs).
  ['Viral rewrite', /if\(nw\[k\]!==undefined && nw\[k\]!==null && asText\(nw\[k\]\)\.trim\(\)!==''\) i\[k\] = asText\(nw\[k\]\);/, 'i', 600],
  ["Viral rewrite's mirror write", /if\(src && src !== i\)/, 'src', 600],
  ['Quick Post sharpen', /if\(window\._tvIdea\)/, 'window._tvIdea', 600],
  ['a hand edit to a field', /if \(key\) idea\[key\] = after;/, 'idea', 600],
  // v692: marks are now SAVED with the row, so a stale list would also follow the post to other
  // devices. Two more paths that replace the text the marks are checked against:
  ['Quick Post viral twist (tvApplyTwist)', /_RWK\.forEach\(k => \{ if \(nw\[k\] !== undefined && nw\[k\] !== null && asText\(nw\[k\]\)\.trim\(\) !== ''\) i\[k\] = asText\(nw\[k\]\); \}\);/, 'i', 600],
  ['the statement editor (cmClose)', /state\[cmState\.ideaId\]\.boldText = newText;/, 'state[cmState.ideaId]', 200],
];
// NOT stripped file-wide: app.html is HTML + CSS + JS, so a file-wide /* */ strip mis-pairs on
// CSS blocks and on */ inside strings, and eats real code (it made all six of these fail at once).
// Strip the SLICE instead. The span is generous on purpose — what stops a neighbouring block's
// prune from counting is that the call must name THIS object, not that the window is narrow.
for (const [name, rx, target, span] of WRITERS) {
  const m = rx.exec(html);
  if (!m) { bad(`the ${name} write this gate watches is gone — re-point the gate at what replaced it.`); continue; }
  const near = stripComments(html.slice(m.index, m.index + span));
  const call = 'tpPruneEmphasis(' + target + ')';
  if (near.indexOf(call) === -1) {
    bad(`${name} replaces the script but never calls ${call}, so the teleprompter keeps bolding ` +
        'phrases from the version that is gone — or bolds nothing at all.');
  }
}

// The gate's own trap: prove a comment mentioning the function cannot satisfy the check above.
if (stripComments('foo(); // tpPruneEmphasis(i)').indexOf('tpPruneEmphasis(i)') !== -1) {
  bad("this gate's comment-stripping is broken, so a mention in a comment would pass for a real call.");
}

if (fails.length) {
  console.error('FAIL:');
  fails.forEach(f => console.error('  - ' + f));
  process.exit(1);
}
console.log(`teleprompter emphasis verified: pruning restores the reading aid on a rewritten script ` +
            `(${before} -> ${after} words emphasised), marks still present survive, and every path that ` +
            'replaces the script prunes in the same block.');
console.log('PASS');
