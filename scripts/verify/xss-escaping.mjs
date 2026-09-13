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
  // ── 6a. historical regressions ────────────────────────────────────────────
  // HONEST LABEL: these six regexes match the EXACT source strings the 2026-08 audit found
  // rendering raw. They can only ever re-detect those exact strings — rename a variable and
  // they go quiet. They are regression witnesses for six specific lines, NOT a check of the
  // class. The class checks are 6b/6c below; do not read this list as coverage.
  const HISTORICAL_REGRESSIONS = [
    ['nl2br sinks',          /<div class="vl-take-text">\$\{a\.takeaway\}/],
    ['idea detail script',   /<div class="detail-text script">\$\{idea\.script\}/],
    ['idea title',           /<div class="list-card-title">\$\{exp\?'\\u25BC':'\\u25B6'\} \$\{idea\.title\}/],
    ['publish-log href',     /href="\$\{j\.payload\.link\}"/],
    ['settings textarea',    /\)">\$\{settings\.(webMentions|categoryGripes|reviewInsights)(\|\|'')?\}<\/textarea>/],
    ['viral hook raw',       /<div class="vt-hook">\$\{a\.hook\|\|''\}<\/div>/],
  ];
  for (const [name, re] of HISTORICAL_REGRESSIONS) {
    if (re.test(src)) fail('call-site/' + name, 'a raw unescaped interpolation is still present in app.html');
  }
  if (!/function\s+safeUrl\s*\(/.test(src)) fail('call-site/safeUrl', 'safeUrl() is not defined in app.html');

  /* ── expression-level judgement ─────────────────────────────────────────────
   * v656: the href rule used to be "safeUrl( appears somewhere in the preceding 400
   * characters". That is a property of the NEIGHBOURHOOD, not of the value being written:
   * a brand-new unsafe sink placed next to a safe one passed. And the extractor was
   * /href="\$\{([^}]*)\}"/ — `[^}]*` stops at the first `}`, so every sink whose expression
   * contains an object literal (escAttr(safeUrl(x,{allowData:true}))) was INVISIBLE to the
   * gate: 1 href and all 4 src sinks. Both are fixed here: brace-balanced extraction, and
   * the interpolated EXPRESSION must itself pass through safeUrl.
   */
  const ENCODER = /^(?:escapeHtml|escHtml|escAttr|escJs|vlEscAttr|encodeURI|encodeURIComponent|String|esc)\s*\(/;
  const SANITISER = /^safeUrl\s*\(/;
  const ESCAPERS = /\b(?:escapeHtml|escHtml|escAttr|escJs|vlEscAttr|nl2br|tpEscape|brollEsc|esc)\s*\(/;

  // Locally-minted URLs that no attacker can influence, named one by one with the reason.
  // A blob: URL from URL.createObjectURL() or a FileReader data: URL of a file the user
  // themselves just picked is not a scheme-injection vector — there is no attacker string.
  const LOCAL_URL_ORIGINS = /^(?:URL\.createObjectURL\s*\(|window\.URL\.createObjectURL\s*\()/;
  const PROVENANCE_ALLOWLIST = {
    // "<sink expression>": why it needs no safeUrl
    'dataUrl': 'a FileReader result for a file the user picked in this very handler (refShotSet / _applyBrandLogo) — never a remote string',
  };

  const matchParen = (s, open) => {
    let d = 0;
    for (let i = open; i < s.length; i++) {
      if (s[i] === '(') d++;
      else if (s[i] === ')') { d--; if (d === 0) return i; }
    }
    return -1;
  };
  // Peel output encoders. They make a string safe to SIT IN an attribute; they do not
  // validate its scheme, so escapeHtml('javascript:…') is still a live hole.
  function peelEncoders(expr) {
    let cur = String(expr).trim();
    for (let n = 0; n < 6; n++) {
      const m = ENCODER.exec(cur);
      if (!m) break;
      const close = matchParen(cur, m[0].length - 1);
      if (close !== cur.length - 1) break;            // the call is not the whole expression
      cur = cur.slice(m[0].length, close).trim();
      // drop trailing option arguments: safeUrl(x, {allowData:true}) is peeled as a unit later
    }
    return cur;
  }
  // Split on a top-level operator (depth 0, outside quotes).
  function topSplit(expr, ops) {
    const parts = []; let d = 0, q = null, last = 0;
    for (let i = 0; i < expr.length; i++) {
      const c = expr[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; continue; }
      if (c === '(' || c === '[' || c === '{') d++;
      else if (c === ')' || c === ']' || c === '}') d--;
      else if (d === 0) {
        for (const op of ops) {
          if (expr.startsWith(op, i)) { parts.push(expr.slice(last, i)); last = i + op.length; i += op.length - 1; break; }
        }
      }
    }
    parts.push(expr.slice(last));
    return parts.length > 1 ? parts.map(p => p.trim()).filter(Boolean) : null;
  }
  // The nearest preceding `const|let|var NAME = …` — a one-step def-use resolution, so a local
  // that was assigned FROM safeUrl() counts, while a local assigned from anything else does not.
  function assignmentsTo(name, at) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:(?:const|let|var)\\s+|(?:^|[^\\w$.]))${esc}\\s*=\\s*([^;\\n]+)`, 'g');
    const selfMemo = new RegExp(`^${esc}\\s*\\|\\|\\s*`);
    const out = [];
    let m;
    while ((m = re.exec(src)) && m.index < at) {
      let rhs = m[1].trim();
      // memo cell: `x = x || <source>` — the self-reference carries whatever <source> produced,
      // so the provenance question is entirely about <source>.
      if (selfMemo.test(rhs)) rhs = rhs.replace(selfMemo, '').trim();
      out.push(rhs);
    }
    return out;
  }
  function schemeChecked(expr, at, depth = 0) {
    const e = peelEncoders(expr);
    if (!e) return { ok: false, why: 'empty expression' };
    if (/^(['"`]).*\1$/.test(e)) return { ok: true, why: 'string literal' };
    if (SANITISER.test(e) && matchParen(e, e.indexOf('(')) === e.length - 1) {
      return { ok: true, why: 'safeUrl() applied to the value itself' };
    }
    if (LOCAL_URL_ORIGINS.test(e)) return { ok: true, why: 'locally minted blob: URL' };
    // depth 0 only: the allowlist excuses THAT sink expression, it must never be reachable
    // through a resolution chain (or any value that happens to be assigned from a variable of
    // the same name inherits the exemption — caught by mutation-testing this gate).
    if (depth === 0 && PROVENANCE_ALLOWLIST[e]) return { ok: true, why: 'allowlisted provenance — ' + PROVENANCE_ALLOWLIST[e] };
    for (const ops of [['?', ':'], ['||'], ['&&']]) {
      const parts = topSplit(e, ops);
      if (parts) {
        const bad = parts.map(p => [p, schemeChecked(p, at, depth + 1)]).filter(([, r]) => !r.ok);
        if (!bad.length) return { ok: true, why: 'every branch is scheme-checked' };
        return { ok: false, why: `branch \`${bad[0][0]}\` is not scheme-checked` };
      }
    }
    if (depth < 3 && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(e)) {
      const rhss = assignmentsTo(e, at);
      if (!rhss.length) return { ok: false, why: `\`${e}\` has no resolvable assignment before the sink` };
      // A bare local is block-scoped: the nearest preceding declaration is the one in effect.
      // A property path (settings.brandLogo) is written from anywhere at any time, so textual
      // order proves nothing — EVERY assignment to it must be scheme-checked, not just the last.
      const candidates = e.includes('.') ? rhss : [rhss[rhss.length - 1]];
      for (const rhs of candidates) {
        const r = schemeChecked(rhs, at, depth + 1);
        if (!r.ok) return { ok: false, why: `\`${e}\` is assigned from \`${rhs}\`, which is not scheme-checked` };
      }
      return { ok: true, why: `every assignment to \`${e}\` is scheme-checked` };
    }
    return { ok: false, why: 'the value never passes through safeUrl()' };
  }

  // ── 6b. every generated href/src must be scheme-checked ───────────────────
  // Brace-balanced extraction of  attr="${ … }"  (an object literal inside no longer hides it).
  function interpolatedSinks(attr) {
    const out = [];
    const needle = `${attr}="\${`;
    let i = 0;
    while ((i = src.indexOf(needle, i)) !== -1) {
      const open = i + attr.length + 2;                // index of '$'
      let d = 0, end = -1;
      for (let j = open + 1; j < src.length; j++) {
        if (src[j] === '{') d++;
        else if (src[j] === '}') { d--; if (d === 0) { end = j; break; } }
      }
      if (end === -1) { out.push({ expr: '(unbalanced)', index: i }); i = open; continue; }
      out.push({ expr: src.slice(open + 2, end), index: i, full: src[end + 1] === '"' });
      i = end;
    }
    return out;
  }
  let sinksSeen = 0;
  for (const attr of ['href', 'src']) {
    for (const s of interpolatedSinks(attr)) {
      sinksSeen++;
      const r = schemeChecked(s.expr, s.index);
      if (!r.ok) fail('call-site/' + attr, `a ${attr} interpolation is not scheme-checked: \${${s.expr}} — ${r.why}`);
    }
    // string-concatenation form:  attr="' + expr + '"
    const cre = new RegExp(`${attr}="'\\s*\\+\\s*([^+]+?)\\s*\\+\\s*'`, 'g');
    let m;
    while ((m = cre.exec(src))) {
      sinksSeen++;
      const r = schemeChecked(m[1], m.index);
      if (!r.ok) fail('call-site/concat-' + attr, `a concatenated ${attr} is not scheme-checked: ${m[1]} — ${r.why}`);
    }
    // Nothing may slip past the two extractors above unexamined.
    const raw = (src.match(new RegExp(`${attr}="(?:\\\\$\\\\{|'\\\\s*\\\\+)`, 'g')) || []).length;
    const seen = interpolatedSinks(attr).length + (src.match(cre) || []).length;
    if (seen < raw) fail('call-site/' + attr, `${raw} dynamic ${attr}= sinks exist but the scanner only parsed ${seen} — it is under-reporting`);
  }
  if (sinksSeen < 15) fail('call-site/scanner', `only ${sinksSeen} dynamic href/src sinks found — the scanner is broken (18 when written)`);

  // ── 6c. textarea bodies — the class the "settings textarea" witness belongs to ──
  // `…>${x}</textarea>` is a raw-HTML sink: a "</textarea>" inside x closes the element and
  // everything after it is parsed as markup. Checked as a CLASS, not as six remembered strings.
  {
    let checked = 0;
    for (const m of src.matchAll(/\$\{([^{}]*)\}\s*<\/textarea>/g)) {
      checked++;
      if (!ESCAPERS.test(m[1])) {
        const line = src.slice(0, m.index).split('\n').length;
        fail('call-site/textarea', `app.html:${line} interpolates \${${m[1]}} straight into a <textarea> body ` +
             `with no escaper — a "</textarea>" in the value closes the element and the rest is parsed as markup`);
      }
    }
    if (checked < 10) fail('call-site/textarea', `only ${checked} textarea interpolations scanned — the scanner is broken`);
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
