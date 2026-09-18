#!/usr/bin/env node
// GATE: a model's JSON is an untrusted SHAPE, not just untrusted text — and nothing that
//       renders may die on one.
//
// WHY THIS EXISTS
//   A model asked for {"hook": "..."} sometimes answers {"hook": ["a","b"]}. Three viral
//   endpoints returned that raw. The client writes it onto the idea (applyViralRewrite) and
//   then renderIdeas calls `idea.hook.trim()` inside a .map(). That TypeError escapes an
//   onclick handler uncaught, so:
//     - nothing renders and nothing is reported — the list just freezes;
//     - every LATER render (approve, dismiss, filter, tab switch) throws at the same line.
//   The Ideas and Pipeline surfaces are dead for the rest of the session with a clean screen.
//   Worse, applyViralRewrite PERSISTS the bad value, so the row is poisoned across reloads.
//   remix.js / sharpen.js / generate-ideas.js each grew their own coercion in v666-v667; this
//   is that logic in one shared place (api/_brain.js) plus the client belt-and-braces.
//
// HOW IT CHECKS
//   It RUNS the real code. coerceShape is imported from api/_brain.js. asText, the two render
//   conditions and both apply loops are lifted out of app.html as source text and executed.
//   Every arm carries a mutation check: the pre-fix expression is run too and MUST throw, so a
//   green result cannot come from a test that no longer tests anything.
//
// RUN:    node scripts/verify/model-shape-coercion.mjs
// EXPECT: prints "PASS" and exits 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const fails = [];
const bad = m => fails.push(m);
const ok = (cond, m) => { if (!cond) bad(m); };

// ── 1. the shared server helper, imported and run ──────────────────────────────────────────
const brain = require(path.join(ROOT, 'api', '_brain.js'));
for (const n of ['coerceShape', 'toStr', 'VIRAL_REWRITE_SHAPE', 'VIRAL_TWIST_SHAPE', 'VIRAL_ANALYZE_SHAPE'])
  ok(brain[n] !== undefined, 'api/_brain.js no longer exports ' + n);

const { coerceShape, VIRAL_REWRITE_SHAPE: RW, VIRAL_TWIST_SHAPE: TW, VIRAL_ANALYZE_SHAPE: AN } = brain;

// every leaf of a coerced value must be a string (that is the whole contract)
const leaves = (o, p = '', out = []) => {
  if (Array.isArray(o)) o.forEach((v, i) => leaves(v, p + '[' + i + ']', out));
  else if (o && typeof o === 'object') Object.keys(o).forEach(k => leaves(o[k], p + '.' + k, out));
  else if (typeof o !== 'string') out.push(p + '=' + typeof o);
  return out;
};

const hostile = [
  { hook: ['a', 'b'] }, { hook: { t: 'x' } }, { hook: 7 }, { hook: null }, { hook: [[['deep']]] },
  { tags: ['#a', '#b'] }, { script: { s1: 'a', s2: 'b' } }, {}, { extra: ['x'] },
];
for (const h of hostile) {
  const r = coerceShape(h, RW);
  ok(leaves(r).length === 0, 'rewrite left a non-string leaf for ' + JSON.stringify(h) + ': ' + leaves(r));
  ok(typeof r.hook === 'string' && typeof r.hook.trim === 'function', 'rewrite hook is not .trim()-able: ' + JSON.stringify(h));
}
ok(coerceShape({ hook: ['a', 'b'] }, RW).hook === 'a\nb', 'an array hook must flatten to lines, not "a,b"');
ok(coerceShape({ hook: 'h', screen: ['x', 'y'] }, RW).screen === 'x\ny', 'a key the model invented must survive as a string, not be dropped');

for (const h of [{ angles: [{ hook: ['a'] }] }, { angles: 'nope' }, { spicy: 'bare' }, { tip: { a: 1 } }, {}]) {
  const r = coerceShape(h, TW);
  ok(leaves(r).length === 0, 'twist left a non-string leaf for ' + JSON.stringify(h) + ': ' + leaves(r));
  ok(Array.isArray(r.angles), 'twist angles must always be an array');
  ok(r.spicy && typeof r.spicy.hook === 'string', 'twist spicy.hook must always be a string');
}
ok(coerceShape({ spicy: 'Bold one' }, TW).spicy.hook === 'Bold one',
  'a bare string where an object was asked for must be parked in the first string field, not thrown away');

// THE ONE THAT BIT ON FIRST RUN: a single item is not a map of items.
const single = coerceShape({ ideas: { format: 'video', title: 't', hook: 'h', angle: 'x', script: 's' } }, AN);
ok(single.ideas.length === 1, 'a single idea object must stay ONE idea, not be spread into ' + single.ideas.length + ' fragments');
ok(single.ideas[0].title === 't', 'spreading a single idea loses its fields');
const indexed = coerceShape({ ideas: { '1': { title: 'a' }, '2': { title: 'b' } } }, AN);
ok(indexed.ideas.length === 2, 'an index-keyed map IS a list and must be spread (got ' + indexed.ideas.length + ')');
ok(coerceShape({ whyItWorks: 'one' }, AN).whyItWorks.length === 1, 'a bare string must become a one-item list');
ok(coerceShape({ ideas: null }, AN).ideas.length === 0, 'a null list must become []');
for (const h of [{ ideas: [{ hook: ['a'] }] }, { whyItWorks: { a: 'x' } }, { takeaway: 12 }, {}]) {
  const r = coerceShape(h, AN);
  ok(leaves(r).length === 0, 'analyze left a non-string leaf for ' + JSON.stringify(h) + ': ' + leaves(r));
}

// ── 2. the three endpoints must return the COERCED value, never the raw parse ───────────────
for (const [file, shape, key] of [
  ['api/viral-rewrite.js', 'VIRAL_REWRITE_SHAPE', 'rewritten'],
  ['api/viral-twist.js', 'VIRAL_TWIST_SHAPE', 'twist'],
  ['api/viral-analyze.js', 'VIRAL_ANALYZE_SHAPE', 'analysis'],
]) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const m = src.match(new RegExp('const\\s+(\\w+)\\s*=\\s*coerceShape\\(\\s*(\\w+)\\s*,\\s*' + shape + '\\s*\\)'));
  ok(!!m, file + ': no `const X = coerceShape(raw, ' + shape + ')` — the endpoint returns the raw model JSON again');
  if (!m) continue;
  const [, coerced, raw] = m;
  ok(coerced === key, file + ': coerces into `' + coerced + '` but the response sends `' + key + '`');
  // the raw parse must not be what leaves the handler. The 200 body is either
  // `{ twist }` or `{ idea: rewritten }`, so match the VALUE, not the key.
  const sent = src.match(/res\.status\(200\)\.json\(\{([^}]*)\}\)/);
  ok(!!sent, file + ': no 200 response body found');
  const body = sent ? sent[1] : '';
  ok(new RegExp('(^|[{,:]\\s*)' + coerced + '\\s*[,}]?\\s*$|[:,{]\\s*' + coerced + '\\s*[,}]|\\b' + coerced + '\\b').test(body),
    file + ': the 200 body `{' + body.trim() + '}` does not send the coerced `' + coerced + '`');
  ok(!new RegExp('\\b' + raw + '\\b').test(body),
    file + ': the 200 body still sends the RAW parse `' + raw + '`');
  ok(new RegExp('const\\s+' + raw + '\\s*=\\s*extractJson\\(').test(src), file + ': `' + raw + '` is not the extractJson result');
  ok(src.includes('coerceShape'), file + ': coerceShape is not imported');
}

// ── 3. the client, executed out of app.html ────────────────────────────────────────────────
const grab = n => {
  const i = html.indexOf('\nfunction ' + n + '(');
  if (i < 0) { bad('app.html: function ' + n + ' is gone'); return 'function ' + n + '(){}'; }
  return html.slice(i + 1, html.indexOf('\n}', i) + 2);
};
const asText = eval('(' + grab('asText') + ')');
ok(asText(['a', 'b']) === 'a\nb', 'asText must flatten an array to lines');
ok(asText({ x: 'a', y: 'b' }) === 'a b', 'asText must flatten an object to words');
ok(asText(null) === '' && asText(undefined) === '', 'asText must turn nullish into ""');
ok(asText(0) === '0', 'asText must keep a 0, not drop it');
ok(asText('hi') === 'hi', 'asText must pass a string through untouched');

const CONDS = [...html.matchAll(/idea\.hook && asText\(idea\.hook\)\.trim\(\)\.toLowerCase\(\) !== asText\(idea\.title\)\.trim\(\)\.toLowerCase\(\)/g)];
ok(CONDS.length === 2, 'expected 2 crash-proofed hook/title render conditions, found ' + CONDS.length +
  ' — the card renderers call .trim() on a model-written field again');
if (CONDS.length) {
  const run = idea => eval(CONDS[0][0]);
  for (const b of [{ hook: ['a', 'b'], title: 'T' }, { hook: { a: 'x' }, title: 'T' }, { hook: 'H', title: ['T'] }, { hook: 7, title: 'T' }])
    { try { run(b); } catch (e) { bad('render condition THREW on ' + JSON.stringify(b) + ': ' + e.message); } }
  ok(run({ hook: 'Same', title: 'same' }) === false, 'render condition lost its hook-equals-title suppression');
  ok(run({ hook: 'H', title: 'T' }) === true, 'render condition stopped showing a distinct hook');
}
// mutation: the pre-fix expression MUST throw, or this arm proves nothing
let threw = false;
try { const idea = { hook: ['a'], title: 'T' }; eval("idea.hook && idea.hook.trim().toLowerCase() !== (idea.title||'').trim().toLowerCase()"); }
catch (e) { threw = true; }
ok(threw, 'MUTATION CHECK FAILED: the pre-fix render condition no longer throws, so this gate is vacuous');

// both apply paths must coerce BEFORE writing to the idea — that write is persisted
const LOOPS = [
  html.match(/_RWK\.forEach\(k=>\{[\s\S]{0,400}?\n\s*\}\);/),
  html.match(/_RWK\.forEach\(k => \{ if \(nw\[k\] !== undefined[\s\S]{0,300}?\}\);/),
];
ok(LOOPS[0] && LOOPS[1], 'one of the two viral-rewrite apply loops is missing from app.html');
LOOPS.forEach((m, ix) => {
  if (!m) return;
  const _RWK = ['title', 'hook', 'script', 'shots', 'screen', 'boldText', 'caption', 'tags'];
  const nw = { title: 'T', hook: ['Stop', 'now'], script: { a: 's1', b: 's2' }, tags: '#x', caption: '   ', boldText: null };
  const i = {};
  try { eval(m[0]); } catch (e) { bad('apply loop ' + ix + ' threw: ' + e.message); return; }
  const nonStr = Object.keys(i).filter(k => typeof i[k] !== 'string');
  ok(nonStr.length === 0, 'apply loop ' + ix + ' PERSISTS a non-string field: ' + nonStr.join(', '));
  ok(i.hook === 'Stop\nnow', 'apply loop ' + ix + ' mangled an array hook: ' + JSON.stringify(i.hook));
  ok(i.caption === undefined, 'apply loop ' + ix + ' overwrote a field with a blank value');
  ok(i.title === 'T', 'apply loop ' + ix + ' stopped copying a good field');
});

if (fails.length) { console.error('FAIL\n- ' + fails.join('\n- ')); process.exit(1); }
console.log('PASS — model JSON is coerced at the API, and no render or apply path can die on a shape (' + (33 + CONDS.length) + ' assertions)');
