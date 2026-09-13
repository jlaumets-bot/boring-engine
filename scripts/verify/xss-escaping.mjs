#!/usr/bin/env node
/**
 * xss-escaping.mjs — behavioural oracle for the app.html escaping layer.
 *
 * This does NOT grep. It lifts the REAL source of nl2br / escHtml / escAttr / escJs /
 * vlEscAttr / safeUrl out of app.html, evaluates them, and feeds them live payloads.
 *
 * It asserts BOTH directions, because over-escaping is as much a bug as under-escaping:
 *   - dangerous input is neutralised (no live tag, no attribute break-out, no js: URL)
 *   - benign input with & < ' " and newlines still round-trips readably
 *
 * Exit 0 + "PASS" when every case holds; non-zero + the specific failing case otherwise.
 *
 *   node scripts/verify/xss-escaping.mjs
 *   EXPECT: exit 0 and a line matching /^PASS /
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP = path.join(ROOT, 'app.html');

const fails = [];
const fail = (name, msg) => fails.push(`${name}: ${msg}`);

/* ── lift the real implementations out of app.html ───────────────────────── */
const src = fs.readFileSync(APP, 'utf8');

/**
 * Extract `function NAME(...) { ... }` from the source file.
 *
 * Deliberately NOT a brace-matcher: these helpers are dense with regex literals such as
 * /"/g and /^data:image\//, and a naive scanner mistakes the quote or the escaped slash
 * for a string/comment and runs past the end of the function. Every one of these helpers
 * is a top-level declaration, so we anchor on the layout instead: a one-liner whose braces
 * balance on its own line, otherwise everything up to the next `}` in column 0.
 */
function extractFn(name) {
  const re = new RegExp(`\\bfunction\\s+${name}\\s*\\(`, 'g');
  const m = re.exec(src);
  if (!m) throw new Error(`could not find function ${name}() in app.html`);
  const eol = src.indexOf('\n', m.index);
  const firstLine = src.slice(m.index, eol < 0 ? src.length : eol);
  let text;
  if ((firstLine.match(/{/g) || []).length === (firstLine.match(/}/g) || []).length &&
      firstLine.includes('{')) {
    text = firstLine;                                   // single-line declaration
  } else {
    const end = src.indexOf('\n}', m.index);
    if (end < 0) throw new Error(`no closing brace found for ${name}()`);
    text = src.slice(m.index, end + 2);
  }
  // Guard against over-capture: the slice must hold exactly this one declaration.
  const decls = (text.match(/\bfunction\s+[A-Za-z_$][\w$]*\s*\(/g) || []).length;
  if (decls !== 1) throw new Error(`extraction for ${name}() captured ${decls} declarations`);
  return text;
}

const NAMES = ['nl2br', 'escHtml', 'escAttr', 'escJs', 'vlEscAttr', 'safeUrl'];
let fns;
try {
  const bundle = NAMES.map(extractFn).join('\n');
  // eslint-disable-next-line no-new-func
  fns = new Function(`${bundle}\nreturn {${NAMES.join(',')}};`)();
} catch (e) {
  console.error(`FAIL: could not load escaping helpers from app.html — ${e.message}`);
  process.exit(2);
}
for (const n of NAMES) {
  if (typeof fns[n] !== 'function') { console.error(`FAIL: ${n} did not evaluate to a function`); process.exit(2); }
}
const { nl2br, escHtml, escAttr, escJs, vlEscAttr, safeUrl } = fns;

/* ── payloads ────────────────────────────────────────────────────────────── */
const IMG = '<img src=x onerror=alert(1)>';
const TA_BREAK = '</textarea><script>alert(1)</script>';
const ATTR_BREAK = '" onmouseover="alert(1)';
const SCRIPT_CLOSE = '</script><script>alert(1)</script>';

// A benign string that MUST survive readably. Real content contains all of these.
const BENIGN = "Tom & Jerry's 5 < 10 \"rule\"\nline two\nline three";

/** No parsed markup may survive: no live tag, no attribute-terminating quote. */
function assertInert(name, out, { allowBr = false } = {}) {
  const stripped = allowBr ? String(out).replace(/<br>/g, '') : String(out);
  if (/<[a-zA-Z/!]/.test(stripped)) fail(name, `a live tag survived: ${JSON.stringify(out)}`);
  if (/on\w+\s*=/i.test(stripped) && /["']/.test(stripped)) {
    fail(name, `an event handler with a raw quote survived: ${JSON.stringify(out)}`);
  }
}

/* ── 1. nl2br — the root defect. MUST escape, MUST keep the <br>. ────────── */
{
  const out = nl2br(IMG);
  assertInert('nl2br/img', out, { allowBr: true });
  if (!out.includes('&lt;img')) fail('nl2br/img', `< was not escaped: ${JSON.stringify(out)}`);

  const ta = nl2br(TA_BREAK);
  assertInert('nl2br/textarea-break', ta, { allowBr: true });

  const ab = nl2br(ATTR_BREAK);
  if (ab.includes('"')) fail('nl2br/attr-break', `a raw " survived: ${JSON.stringify(ab)}`);

  // benign must stay READABLE, and newlines must still become <br>
  const b = nl2br(BENIGN);
  if ((b.match(/<br>/g) || []).length !== 2) fail('nl2br/benign', `expected 2 <br>, got: ${JSON.stringify(b)}`);
  if (b.includes('&amp;amp;')) fail('nl2br/benign', `double-escaped & : ${JSON.stringify(b)}`);
  if (!b.includes('Tom &amp; Jerry&#39;s') && !b.includes("Tom &amp; Jerry's")) {
    fail('nl2br/benign', `apostrophe/ampersand mangled: ${JSON.stringify(b)}`);
  }
  if (!b.includes('line two') || !b.includes('line three')) fail('nl2br/benign', `text lost: ${JSON.stringify(b)}`);
  if (nl2br(null) !== '' || nl2br(undefined) !== '') fail('nl2br/null', 'null/undefined must render empty');
}

/* ── 2. escHtml / escAttr — text and attribute contexts ──────────────────── */
{
  assertInert('escHtml/img', escHtml(IMG));
  if (escHtml(ATTR_BREAK).includes('"')) fail('escHtml/attr', 'a raw " survived');
  if (!escHtml(BENIGN).includes('line two')) fail('escHtml/benign', 'text lost');
  if (escHtml(BENIGN).includes('&amp;amp;')) fail('escHtml/benign', 'double-escaped &');

  assertInert('escAttr/img', escAttr(IMG));
  for (const ch of ['"', "'", '<', '>']) {
    if (escAttr(`x${ch}y`).includes(ch)) fail('escAttr', `raw ${ch} survived — unsafe in a quoted attribute`);
  }
  if (!escAttr(BENIGN).includes('line two')) fail('escAttr/benign', 'text lost');
}

/* ── 3. escJs — lands inside onclick="fn('…')": JS-string AND attribute ─── */
{
  const out = escJs(ATTR_BREAK);
  if (out.includes('"')) fail('escJs/attr-break', `a raw " survived and would close onclick=: ${JSON.stringify(out)}`);
  if (escJs("it's").includes("'") && !escJs("it's").includes("\\'")) fail('escJs/quote', 'single quote not JS-escaped');
  if (escJs(SCRIPT_CLOSE).includes('</script')) fail('escJs/script-close', '</script> survived verbatim');

  // Round-trip: HTML-decode the attribute, then evaluate the JS string literal.
  const htmlDecode = s => String(s)
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const probe of [BENIGN, ATTR_BREAK, IMG, 'a\\b', "quote\" and 'quote'"]) {
    const attr = escJs(probe);
    if (/"/.test(attr)) fail('escJs/roundtrip', `raw " in attribute output for ${JSON.stringify(probe)}`);
    let got;
    try { got = new Function(`return '${htmlDecode(attr)}';`)(); }
    catch (e) { fail('escJs/roundtrip', `not a valid JS string for ${JSON.stringify(probe)}: ${e.message}`); continue; }
    if (got !== probe) fail('escJs/roundtrip', `value mangled: ${JSON.stringify(probe)} -> ${JSON.stringify(got)}`);
  }
}

/* ── 4. vlEscAttr — used for the trend chips ─────────────────────────────── */
{
  assertInert('vlEscAttr/img', vlEscAttr(IMG));
  if (vlEscAttr(ATTR_BREAK).includes('"')) fail('vlEscAttr/attr', 'a raw " survived');
}

/* ── 5. safeUrl — scheme allowlist for every generated href/src ──────────── */
{
  const BLOCK = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '  javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'jav\u0000ascript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+',
  ];
  for (const u of BLOCK) {
    if (safeUrl(u) !== '') fail('safeUrl/block', `did NOT block ${JSON.stringify(u)} -> ${JSON.stringify(safeUrl(u))}`);
  }
  // even with allowData, script-capable schemes stay blocked
  for (const u of BLOCK) {
    if (safeUrl(u, { allowData: true }) !== '') fail('safeUrl/block+allowData', `did NOT block ${JSON.stringify(u)}`);
  }

  const ALLOW = [
    'https://www.tiktok.com/@someone/video/123?x=1#t=2',
    'http://example.com/a%20b',
    'mailto:hi@example.com',
    '/relative/path',
    'relative/path.html',
    '#anchor',
  ];
  for (const u of ALLOW) {
    if (safeUrl(u) !== u) fail('safeUrl/allow', `mangled a legitimate URL ${JSON.stringify(u)} -> ${JSON.stringify(safeUrl(u))}`);
  }
  const raster = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  if (safeUrl(raster, { allowData: true }) !== raster) fail('safeUrl/data', 'blocked a legitimate raster data: image thumbnail');
  if (safeUrl(raster) !== '') fail('safeUrl/data', 'data: image allowed without the explicit allowData opt-in');
  if (safeUrl('') !== '' || safeUrl(null) !== '') fail('safeUrl/empty', 'empty/null must return empty');
}

/* ── 6. call-site wiring: the sinks must actually USE the helpers ────────── */
{
  // These are the specific interpolations the audit found rendering raw. They are
  // checked as source text because the oracle cannot execute a whole render pass.
  const mustNotContain = [
    ['nl2br sinks',          /<div class="vl-take-text">\$\{a\.takeaway\}/],
    ['idea detail script',   /<div class="detail-text script">\$\{idea\.script\}/],
    ['idea title',           /<div class="list-card-title">\$\{exp\?'\\u25BC':'\\u25B6'\} \$\{idea\.title\}/],
    ['publish-log href',     /href="\$\{j\.payload\.link\}"/],
    ['settings textarea',    /\)">\$\{settings\.(webMentions|categoryGripes|reviewInsights)(\|\|'')?\}<\/textarea>/],
    ['viral hook raw',       /<div class="vt-hook">\$\{a\.hook\|\|''\}<\/div>/],
  ];
  for (const [name, re] of mustNotContain) {
    if (re.test(src)) fail('call-site/' + name, 'a raw unescaped interpolation is still present in app.html');
  }
  if (!/function\s+safeUrl\s*\(/.test(src)) fail('call-site/safeUrl', 'safeUrl() is not defined in app.html');

  // Every generated href must be scheme-checked — either inline, or via a local that was
  // assigned from safeUrl() just above it (the publish-log row does the latter).
  for (const m of src.matchAll(/href="\$\{([^}]*)\}"/g)) {
    const expr = m[1];
    const window = src.slice(Math.max(0, m.index - 400), m.index);
    if (!/safeUrl\(/.test(expr) && !/safeUrl\(/.test(window)) {
      fail('call-site/href', `an href interpolation has no safeUrl(): \${${expr}}`);
    }
  }
  // Same for every generated image src — data:image/svg+xml can carry <script>.
  for (const m of src.matchAll(/\bsrc="\$\{([^}]*)\}"/g)) {
    if (!/safeUrl\(/.test(m[1])) fail('call-site/src', `an img src interpolation has no safeUrl(): \${${m[1]}}`);
  }

  // The two bookmark renderers build their <a> by string concatenation, so the regex
  // above cannot see them. Same rule, same window: safeUrl must appear nearby.
  for (const m of src.matchAll(/href="' \+ ([A-Za-z_$][\w$.]*)\(([^)]*)\) \+ '"/g)) {
    const window = src.slice(Math.max(0, m.index - 300), m.index);
    if (!/safeUrl\(/.test(window) && m[1] !== 'safeUrl') {
      fail('call-site/concat-href', `a concatenated href has no safeUrl(): ${m[1]}(${m[2]})`);
    }
  }
}

/* ── report ──────────────────────────────────────────────────────────────── */
if (fails.length) {
  console.error(`FAIL (${fails.length}):`);
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}
console.log('PASS xss-escaping: nl2br/escHtml/escAttr/escJs/vlEscAttr/safeUrl neutralise ' +
  'tag-injection, attribute break-out and javascript:/data: URLs, benign text round-trips ' +
  'readably, and no audited sink still interpolates raw.');
