#!/usr/bin/env node
// SITE CLEAN — the public website in the "A · Clean" dark look, with LOOK-only changes.
// Contract: .unlazy/redesign/PLAN-site.md. Pages: index.html, faq.html, terms.html, privacy.html, refunds.html.
//
// For each page, compared with `git show HEAD:<page>`:
//   T  visible text unchanged — comments, <script>, <style>, <svg> dropped, emoji stripped, whitespace
//      collapsed. The ONE hero phone mock (an element marked data-site-mock + aria-hidden="true") is
//      decoration and is skipped; a second one, or one a screen reader can see, fails.
//   H  the set of <a href> targets unchanged
//   M  <title>, every <meta>, canonical/icon/manifest links, JSON-LD (parsed) and external <script src> unchanged
//   S  no shrimp-mascot reference anywhere in the file
//   K  the dark tokens are declared with the app's values (--cs-bg #212121, --cs-raise #2a2a2a, --cs-text #ececec,
//      --cs-muted #b4b4b4, --cs-line #3d3d3d, --cs-chip #333333, --cs-primary #ececec, --cs-on-primary #0d0d0d),
//      and no declaration of those names carries another value
//   G  no gradient(
//   F  the only external stylesheet is fonts.googleapis.com, and Geist is linked from it
//   X  no Archivo / Instrument Serif / Newsreader
//   P  none of the old cream/lavender palette hexes
//
// Usage: node scripts/verify/site-clean.mjs [page.html ...]     (or SITE_ONLY=index.html,faq.html)
//        A partial run prints "SITE CLEAN OK (… partial run)"; only a full run covers the site.
// Baseline: git HEAD of this repo, or of SITE_BASE_REPO=<dir> when this runs in a copy without .git
// (mutate.mjs copies the repo without .git).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ALL = ['index.html', 'faq.html', 'terms.html', 'privacy.html', 'refunds.html'];
const argPages = process.argv.slice(2).filter(a => !a.startsWith('-'));
const envPages = (process.env.SITE_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
const pages = argPages.length ? argPages : envPages.length ? envPages : ALL;
for (const p of pages) if (!ALL.includes(p)) { console.error('site-clean: unknown page ' + p + ' (expected one of ' + ALL.join(', ') + ')'); process.exit(2); }
const baseRepo = process.env.SITE_BASE_REPO ? path.resolve(process.env.SITE_BASE_REPO) : root;

const TOKENS = { 'cs-bg': '#212121', 'cs-raise': '#2a2a2a', 'cs-text': '#ececec', 'cs-muted': '#b4b4b4',
  'cs-line': '#3d3d3d', 'cs-chip': '#333333', 'cs-primary': '#ececec', 'cs-on-primary': '#0d0d0d' };
const OLD_PALETTE = ['#F9F6EA', '#16130F', '#E7DAF9', '#CDB8F2', '#F5F1E3', '#DDD7C3', '#8A8270', '#5C564A', '#9A6420', '#3E7A52', '#3A3427', '#221E17'];
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{FE0E}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}]/gu;
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', middot: '·',
  copy: '©', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', times: '×', rarr: '→', larr: '←', darr: '↓', uarr: '↑',
  bull: '•', trade: '™', reg: '®', euro: '€', pound: '£', check: '✓' };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(cp); } catch { return m; } }
  return Object.prototype.hasOwnProperty.call(ENT, e) ? ENT[e] : m;
});
const noComments = h => h.replace(/<!--[\s\S]*?-->/g, ' ');

function headOf(p) {
  return execFileSync('git', ['-C', baseRepo, '--no-optional-locks', 'show', 'HEAD:' + p],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
}

// drop every element carrying data-site-mock (with its whole subtree); report misuse
function stripMocks(html, errs) {
  let out = html, n = 0;
  for (;;) {
    const m = /<([a-z][a-z0-9]*)\b[^>]*\bdata-site-mock\b[^>]*>/i.exec(out);
    if (!m) break;
    n++;
    if (!/\baria-hidden\s*=\s*"true"/i.test(m[0])) errs.push('T the data-site-mock element is not aria-hidden="true": ' + m[0].slice(0, 120));
    const tag = m[1].toLowerCase();
    const re = new RegExp('<(/?)' + tag + '\\b[^>]*>', 'gi');
    re.lastIndex = m.index;
    let depth = 0, end = -1, t;
    while ((t = re.exec(out))) {
      if (t[1]) { depth--; if (depth === 0) { end = re.lastIndex; break; } }
      else if (!/\/>$/.test(t[0])) depth++;
    }
    if (end < 0) { errs.push('T the data-site-mock element never closes'); break; }
    out = out.slice(0, m.index) + ' ' + out.slice(end);
  }
  if (n > 1) errs.push('T ' + n + ' data-site-mock elements (at most one hero mock is allowed)');
  return out;
}

function visibleText(html, errs) {
  let b = noComments(html);
  const body = b.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
  b = body ? body[1] : b;
  b = b.replace(/<(script|style|template|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  b = stripMocks(b, errs);
  b = b.replace(/<[^>]+>/g, ' ');
  return decode(b).replace(EMOJI, '').replace(/\s+/g, ' ').trim();
}

function attrs(tag) {
  const inner = tag.replace(/^<[a-z0-9]+/i, '').replace(/\/?>$/, '');
  const out = [];
  for (const m of inner.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g)) {
    let v = m[2] === undefined ? '' : m[2];
    if (/^["']/.test(v)) v = v.slice(1, -1);
    out.push([m[1].toLowerCase(), decode(v)]);
  }
  return out;
}
const norm = tag => attrs(tag).map(([k, v]) => k + '=' + v).sort().join(' | ');
const canon = v => Array.isArray(v) ? v.map(canon) : (v && typeof v === 'object')
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;

function headBits(html, errs, label) {
  const h = noComments(html), bits = [];
  for (const m of h.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)) bits.push('title: ' + decode(m[1]).replace(/\s+/g, ' ').trim());
  for (const m of h.matchAll(/<meta\b[^>]*>/gi)) bits.push('meta: ' + norm(m[0]));
  for (const m of h.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attrs(m[0]).find(([k]) => k === 'rel') || [, ''])[1].toLowerCase();
    if (/\b(canonical|icon|manifest|apple-touch-icon|alternate)\b/.test(rel)) bits.push('link: ' + norm(m[0]));
  }
  for (const m of h.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/application\/ld\+json/i.test(m[1])) {
      try { bits.push('json-ld: ' + JSON.stringify(canon(JSON.parse(m[2])))); }
      catch (e) { errs.push('M ' + label + ' JSON-LD does not parse: ' + e.message); }
    }
    const src = /\bsrc\s*=\s*"([^"]*)"/i.exec(m[1]);
    if (src) bits.push('script-src: ' + src[1]);
  }
  return bits.sort();
}

const hrefs = html => [...new Set([...noComments(html).matchAll(/<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)')/gi)].map(m => decode(m[2] ?? m[3])))].sort();

function diffList(a, b) {
  const A = new Map(), B = new Map();
  for (const x of a) A.set(x, (A.get(x) || 0) + 1);
  for (const x of b) B.set(x, (B.get(x) || 0) + 1);
  const gone = [...A].filter(([k, n]) => (B.get(k) || 0) < n).map(([k]) => k);
  const added = [...B].filter(([k, n]) => (A.get(k) || 0) < n).map(([k]) => k);
  return { gone, added };
}

function firstTextDiff(a, b) {
  const wa = a.split(' '), wb = b.split(' ');
  let i = 0; while (i < wa.length && i < wb.length && wa[i] === wb[i]) i++;
  return 'at word ' + i + ': HEAD "…' + wa.slice(Math.max(0, i - 6), i + 8).join(' ') + '…" vs now "…' + wb.slice(Math.max(0, i - 6), i + 8).join(' ') + '…"';
}

function checkPage(p) {
  const errs = [];
  let old, now;
  try { old = headOf(p); } catch (e) { return ['baseline: cannot read HEAD:' + p + ' from ' + baseRepo + ' (set SITE_BASE_REPO when running from a copy without .git): ' + String(e.message).split('\n')[0]]; }
  try { now = fs.readFileSync(path.join(root, p), 'utf8'); } catch (e) { return ['cannot read ' + p]; }

  // T
  const tOld = visibleText(old, []), tNow = visibleText(now, errs);
  if (tOld !== tNow) errs.push('T visible text changed ' + firstTextDiff(tOld, tNow));
  // H
  const hd = diffList(hrefs(old), hrefs(now));
  if (hd.gone.length || hd.added.length) errs.push('H link targets changed — gone: [' + hd.gone.join(', ') + '] added: [' + hd.added.join(', ') + ']');
  // M
  const md = diffList(headBits(old, [], 'HEAD'), headBits(now, errs, 'now'));
  for (const g of md.gone) errs.push('M missing or changed: ' + g.slice(0, 220));
  for (const a of md.added) errs.push('M new or changed:     ' + a.slice(0, 220));
  // S
  if (/shrimp-mascot/i.test(now)) errs.push('S a shrimp-mascot reference remains');
  // K
  const low = noComments(now).toLowerCase();
  for (const [name, val] of Object.entries(TOKENS)) {
    const decl = [...low.matchAll(new RegExp('--' + name + '\\s*:\\s*([^;}]+)', 'g'))].map(m => m[1].trim());
    if (!decl.length) errs.push('K token --' + name + ' is not declared');
    else if (decl.some(v => v !== val)) errs.push('K token --' + name + ' should be ' + val + ', found ' + decl.join(', '));
  }
  // G
  if (/gradient\s*\(/i.test(now)) errs.push('G a gradient( is present');
  // F
  const live = noComments(now);
  let geist = false;
  for (const m of live.matchAll(/<link\b[^>]*>/gi)) {
    const a = Object.fromEntries(attrs(m[0]));
    if (!/\bstylesheet\b/i.test(a.rel || '')) continue;
    const href = a.href || '';
    if (/^(https?:)?\/\//i.test(href)) {
      let host = ''; try { host = new URL(href, 'https://contentshrimp.com/').host; } catch {}
      if (host !== 'fonts.googleapis.com') errs.push('F external stylesheet not from fonts.googleapis.com: ' + href);
      else if (/family=Geist\b/.test(href)) geist = true;
    }
  }
  for (const m of live.matchAll(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)/gi)) {
    let host = ''; try { host = new URL(m[1], 'https://contentshrimp.com/').host; } catch {}
    if (host !== 'contentshrimp.com' && host !== 'fonts.googleapis.com') errs.push('F @import from ' + m[1]);
    if (host === 'fonts.googleapis.com' && /family=Geist\b/.test(m[1])) geist = true;
  }
  if (!geist) errs.push('F Geist is not linked from fonts.googleapis.com');
  // the font stack names Geist first-class, either in font-family or in a font custom property (--cs-font)
  if (!/(font-family|--[\w-]*font[\w-]*)\s*:\s*[^;}]*['"]Geist['"]/i.test(live)) errs.push('F no font stack names Geist');
  // X
  const face = now.match(/Archivo|Instrument[ +]Serif|Newsreader/i);
  if (face) errs.push('X old display face still referenced: ' + face[0]);
  // P
  const oldHex = OLD_PALETTE.filter(c => new RegExp(c + '(?![0-9a-f])', 'i').test(now));
  if (oldHex.length) errs.push('P old palette colours remain: ' + oldHex.join(' '));
  return errs;
}

let bad = 0;
for (const p of pages) {
  const errs = checkPage(p);
  if (errs.length) { bad++; console.log('FAIL ' + p); for (const e of errs) console.log('  - ' + e); }
  else console.log('PASS ' + p);
}
const partial = pages.length < ALL.length ? ' — partial run: ' + pages.join(', ') : '';
if (bad) { console.log('SITE CLEAN FAILED (' + bad + '/' + pages.length + ' pages' + partial + ')'); process.exit(1); }
console.log('SITE CLEAN OK (' + pages.length + '/' + ALL.length + ' pages' + partial + ')');
