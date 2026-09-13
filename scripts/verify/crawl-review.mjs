#!/usr/bin/env node
// crawl-review.mjs — proves the onboarding website crawl cannot put unreviewed or junk
// values into the brand brain.
//
// This does NOT re-implement the rules. It slices the REAL functions out of app.html and
// executes them against stubs, so if the shipped wiring changes the oracle notices. Two
// properties, both asserted in BOTH directions:
//
//   1. REVIEW GATE   a crawl result cannot reach `settings` without the user seeing it and
//                    pressing Save — and pressing Save DOES land what they kept (a gate
//                    that saved nothing would be just as broken as one that saved silently).
//   2. SANITY GATE   junk (cookie banners, "Not specified", page dumps, markup) is rejected
//                    AND realistic brand copy survives byte-for-byte (a validator that eats
//                    real brand information is as broken as one that swallows junk).
//
// Exit 0 + "PASS" when both hold. Non-zero + a specific reason otherwise.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP = path.join(ROOT, 'app.html');

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };
const die = (msg) => { console.error('FAIL: ' + msg); process.exit(1); };

if (!fs.existsSync(APP)) die('app.html not found at ' + APP);
const src = fs.readFileSync(APP, 'utf8');

/* ────────────────────────── declaration slicer ──────────────────────────
   Walks the source skipping strings, template literals, comments and regex
   literals, so braces inside them cannot confuse the depth counter.        */
function sliceDecl(s, name) {
  const decl = new RegExp('(?:^|\\n)[ \\t]*(function|const|let|var)[ \\t]+' + name + '\\b');
  const m = decl.exec(s);
  if (!m) return null;
  const kind = m[1];
  let i = m.index + (m[0].startsWith('\n') ? 1 : 0);
  const start = i;
  let depth = 0, sawBody = false, prevSig = '';
  while (i < s.length) {
    const c = s[i], c2 = s[i + 1];
    // comments
    if (c === '/' && c2 === '/') { i = s.indexOf('\n', i); if (i === -1) i = s.length; continue; }
    if (c === '/' && c2 === '*') { const e = s.indexOf('*/', i + 2); i = e === -1 ? s.length : e + 2; continue; }
    // strings / templates
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < s.length) { if (s[i] === '\\') { i += 2; continue; } if (s[i] === q) { i++; break; } i++; }
      prevSig = q; continue;
    }
    // regex literal (heuristic: only where a value may begin)
    if (c === '/' && /[(,=:[!&|?{};+\-*%~^]/.test(prevSig)) {
      i++; let cls = false;
      while (i < s.length) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === '[') cls = true;
        else if (s[i] === ']') cls = false;
        else if (s[i] === '/' && !cls) { i++; break; }
        else if (s[i] === '\n') break;
        i++;
      }
      while (i < s.length && /[a-z]/.test(s[i])) i++;
      prevSig = '/'; continue;
    }
    if ('{[('.includes(c)) { depth++; if (c === '{') sawBody = true; }
    else if ('}])'.includes(c)) {
      depth--;
      if (depth === 0 && kind === 'function' && sawBody) return s.slice(start, i + 1);
      if (depth < 0) return null;
    }
    else if (c === ';' && depth === 0 && kind !== 'function') return s.slice(start, i + 1);
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  return null;
}

const NEEDED = [
  // sanity gate
  'CRAWL_MAX_LEN', 'CRAWL_BOILERPLATE_STRONG', 'CRAWL_BOILERPLATE_WEAK',
  'CRAWL_PLACEHOLDERS', 'CRAWL_REFUSAL_RX', 'CRAWL_MARKUP_RX',
  'crawlValueOk', 'CRAWL_MAX_LIST_ITEM', 'crawlListOk', 'crawlUrlOk',
  // review sheet
  'BRAIN_FIELD_LABELS', '_brainFills', '_brainReviewOpts', '_brvPreview',
  'openBrainReview', '_brvCount', 'closeBrainReview',
  // onboarding
  'OB_REVIEW_FIELDS', 'obPendingBrainFills', 'obPrefillFromCrawl', 'obReviewCrawlFindings'
];

const pieces = {};
for (const n of NEEDED) {
  const cut = sliceDecl(src, n);
  if (!cut) die(`could not find declaration "${n}" in app.html — the crawl review wiring is gone or renamed, so this property is NOT verified`);
  pieces[n] = cut;
}

/* ── STATIC: obPrefillFromCrawl must not write settings at all ───────────── */
const prefillSrc = pieces.obPrefillFromCrawl;
const settingsWrite = /settings\s*(\[[^\]]*\]|\.[A-Za-z_$][\w$]*)\s*(=[^=]|\+=)/.exec(prefillSrc);
ok(!settingsWrite,
  'obPrefillFromCrawl writes to settings directly (' + (settingsWrite ? settingsWrite[0].trim() : '') +
  ') — crawl output reaches the brand brain without review');
ok(/obPendingBrainFills\s*=/.test(prefillSrc),
  'obPrefillFromCrawl no longer holds findings in obPendingBrainFills — nothing feeds the review');
ok(/obReviewCrawlFindings\s*\(/.test(src.slice(src.indexOf('async function obFinish'))),
  'obFinish never calls obReviewCrawlFindings — findings are collected and then silently dropped');
ok(/openBrainReview\s*\(/.test(pieces.obReviewCrawlFindings),
  'obReviewCrawlFindings does not open the review sheet');

/* ────────────────────────── sandbox ────────────────────────── */
function mkEl(id) {
  const el = {
    id: id || '', value: '', textContent: '', innerHTML: '', className: '', disabled: false,
    style: {}, onclick: null,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    appendChild() {}, remove() {}, focus() {}, scrollIntoView() {}
  };
  return el;
}
const DOM = {};
const getEl = (id) => { if (!(id in DOM)) DOM[id] = mkEl(id); return DOM[id]; };
[ 'obWebsiteUrl','obSocialUrl','obBrandName','obBrandBadge','obTagline','obTaglineBadge',
  'obTaglineExamples','obAudience','obAudienceBadge','obAudienceExamples','obUsps',
  'obUspsBadge','obUspsExamples','obTopicExamples','obCommunityTags','obExampleChips'
].forEach(getEl);

const calls = { toast: [], saveSettings: 0, reviewOpened: null };
const sandbox = {
  console,
  settings: {},
  obSelectedTones: [],
  obCommunities: [],
  OB_TONE_OPTIONS: [{ id: 'deadpan' }, { id: 'witty' }, { id: 'warm' }, { id: 'blunt' }],
  obRenderToneCards() {}, obRenderCommunityTags() {}, obRenderExampleChips() {},
  renderSettingsPanel() {},
  saveSettings() { calls.saveSettings++; },
  showToast(m) { calls.toast.push(String(m)); },
  escHtml: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  requestAnimationFrame(fn) { fn(); },
  setTimeout(fn, ms) { return setTimeout(fn, ms); },
  document: {
    getElementById: (id) => (id in DOM ? DOM[id] : null),
    querySelectorAll: () => [],
    createElement: () => mkEl(''),
    body: { appendChild(el) { if (el.id) DOM[el.id] = el; } }
  }
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const program = NEEDED.map(n => pieces[n]).join('\n\n') + `
// harness hooks. top-level const/let in a vm script live in the lexical scope and are NOT
// own properties of the context object, so anything the assertions need is exported here.
globalThis.__fills = () => _brainFills;
globalThis.__pending = () => obPendingBrainFills;
globalThis.__resetPending = () => { obPendingBrainFills = null; };
globalThis.__reviewFields = OB_REVIEW_FIELDS;
`;
try { vm.runInContext(program, sandbox, { filename: 'app.html:crawl-review' }); }
catch (e) { die('extracted crawl/review code failed to evaluate: ' + e.message); }

// Wrap openBrainReview to record what it was asked to show (real one still runs).
const realOpen = sandbox.openBrainReview;
sandbox.openBrainReview = function (fills, label, opts) {
  calls.reviewOpened = { fills: fills.map(f => f.key), label, opts };
  return realOpen.call(sandbox, fills, label, opts);
};

/* ────────────────────────── fixtures ────────────────────────── */
// A crawl that returned something for every field. Values are the plausible-looking kind a
// model invents — which is exactly why they must be shown before they become brand fact.
const CRAWL = {
  brandName: 'Mila Sourcing',
  tagline: 'Factories you can actually trust',
  targetAudience: 'Founders of small e-commerce brands buying from overseas factories',
  usps: 'We audit every factory in person before you place an order',
  tones: ['deadpan', 'blunt'],
  communities: ['sourcing mistakes', 'factory audits', 'shipping delays'],
  socialUrl: 'instagram.com/milasourcing',
  socialProof: 'Trusted by 4,200 brands and featured in Forbes',
  productDetails: 'Audit reports include batch photos, CoA scans and a signed inspector note',
  originStory: 'Started in 2019 after a container of faulty goods arrived two weeks late',
  competitors: 'Sourcify, Alibaba Verified, Supplyia',
  webMentions: 'Reddit threads praise the batch photos and criticise the lead times',
  categoryGripes: 'Buyers say agents vanish once the deposit clears',
  painPoints: 'Paying a deposit and having no idea if the factory is real',
  bannedTopics: 'Politics, tariffs speculation',
  avoidWords: 'synergy, leverage, seamless',
  brandVocab: 'batch, inspector, deposit, container',
  ctaStyle: 'Direct — "book an audit" with no hype',
  channels: 'Instagram, LinkedIn, newsletter',
  visualStyle: 'Warehouse photography, hand-written annotations',
  exampleContent: 'Most sourcing agents will not show you the factory floor. We film it.'
};
const REVIEW_KEYS = (sandbox.__reviewFields || []).slice();
if (REVIEW_KEYS.length < 10) die('OB_REVIEW_FIELDS lists only ' + REVIEW_KEYS.length + ' fields — the crawl writes more than that, so some are escaping review');

function freshPrefill(overrides) {
  sandbox.settings = Object.assign({}, overrides || {});
  Object.values(DOM).forEach(el => { el.value = ''; });
  sandbox.obCommunities = [];
  sandbox.obSelectedTones = [];
  sandbox.__resetPending();
  calls.reviewOpened = null;
  sandbox.obPrefillFromCrawl(CRAWL, 'https://mila.example');
}

/* ── PROPERTY 1: the review gate ────────────────────────────── */

// 1a. The crawl writes NOTHING to settings.
freshPrefill();
ok(Object.keys(sandbox.settings).length === 0,
  'obPrefillFromCrawl wrote ' + JSON.stringify(Object.keys(sandbox.settings)) +
  ' into settings — crawl output reached the brand brain unreviewed');

// 1b. ...but the crawl is NOT neutered: the on-screen fields are still prefilled.
ok(DOM.obBrandName.value === 'Mila Sourcing', 'brand name was not prefilled — the crawl has been neutered');
ok(DOM.obTagline.value === CRAWL.tagline, 'tagline was not prefilled — the crawl has been neutered');
ok(DOM.obAudience.value === CRAWL.targetAudience, 'audience was not prefilled — the crawl has been neutered');
ok(DOM.obUsps.value === CRAWL.usps, 'USPs were not prefilled — the crawl has been neutered');
ok(sandbox.obCommunities.length === 3, 'topics were not prefilled — the crawl has been neutered');
ok(sandbox.obSelectedTones.length === 2, 'tones were not prefilled — the crawl has been neutered');

// 1c. Every off-screen field is HELD for review, none missing.
const pend = sandbox.__pending() || [];
const pendKeys = pend.map(f => f.key);
const missing = REVIEW_KEYS.filter(k => !pendKeys.includes(k));
ok(missing.length === 0, 'crawl values for ' + JSON.stringify(missing) + ' were neither saved nor held for review — they vanished');
ok(pendKeys.includes('socialUrl'), 'the crawl-detected social profile is not reviewed (it silently trains voice from that account)');
ok(pendKeys[0] === 'socialProof',
  'review list is not ordered riskiest-first (got "' + pendKeys[0] + '") — factual claims must sit above stylistic ones');
ok(DOM.obSocialUrl.value === '', 'crawl-detected social URL was pushed into the (unseen) input, bypassing review');

// 1d. Opening the review still saves nothing.
sandbox.obReviewCrawlFindings();
ok(calls.reviewOpened && calls.reviewOpened.fills.length === pend.length, 'the review sheet was not opened with the held findings');
ok(Object.keys(sandbox.settings).length === 0, 'opening the review sheet already wrote to settings — the user never got to decide');

// 1e. Cancelling saves nothing, and says where it went.
calls.toast = [];
sandbox.closeBrainReview(false);
ok(Object.keys(sandbox.settings).length === 0,
  'cancelling the review still wrote ' + JSON.stringify(Object.keys(sandbox.settings)) + ' to settings');
ok(calls.toast.some(t => /scan my whole site/i.test(t)),
  'cancelling the onboarding review is a silent dead end — it must point at the Settings re-scan');

// 1f. Saving DOES land exactly what was kept (a gate that saves nothing is equally broken).
freshPrefill();
sandbox.obReviewCrawlFindings();
const fills = sandbox.__fills();
ok(Array.isArray(fills) && fills.length > 1, 'review sheet holds no rows to keep/discard');
const dropped = fills[0].key;
fills[0].keep = false;
calls.saveSettings = 0;
sandbox.closeBrainReview(true);
ok(calls.saveSettings === 1, 'pressing Save did not persist the brand brain');
ok(!(dropped in sandbox.settings), `unchecked field "${dropped}" was saved anyway — the checkboxes do nothing`);
for (const k of pendKeys) {
  if (k === dropped) continue;
  ok(sandbox.settings[k] === CRAWL[k] || k === 'socialUrl',
    `kept field "${k}" did not reach settings intact after Save`);
}

// 1g. Review never offers to overwrite something the user already wrote.
freshPrefill({ competitors: 'My own list', painPoints: 'Mine too' });
const pend2 = (sandbox.__pending() || []).map(f => f.key);
ok(!pend2.includes('competitors') && !pend2.includes('painPoints'),
  'the review offers to overwrite fields the user already filled in');

// 1h. Findings are shown once and cannot leak into the next brand.
freshPrefill();
sandbox.obReviewCrawlFindings();
sandbox.closeBrainReview(false);
ok(sandbox.__pending() == null, 'held findings survive the review — they could be applied to a different brand later');

/* ── PROPERTY 2: the sanity gate, both directions ────────────── */

const REJECT = [
  ['', 'empty string'],
  ['     \n\t  ', 'whitespace only'],
  ['x'.repeat(6001), 'a whole-page dump (over the length cap)'],
  ['<div class="cta">Book an audit</div>', 'raw HTML markup'],
  ['<script>window.dataLayer=[]</script>', 'a leaked script tag'],
  ['We use cookies to improve your experience. Accept all cookies or manage cookies below.', 'a cookie consent banner'],
  ['Cookie preferences — choose which cookies we may store on your device.', 'a cookie preference panel'],
  ['Skip to main content', 'a nav skip link'],
  ['This site requires JavaScript. Please enable JavaScript and reload.', 'a JavaScript-disabled notice'],
  ['Page not found', 'a 404 page'],
  ['Lorem ipsum dolor sit amet, consectetur adipiscing elit.', 'placeholder filler text'],
  ['Home About Contact. Terms of service. Privacy policy. All rights reserved.', 'a footer link dump'],
  ['Not specified', 'a model placeholder'],
  ['N/A', 'a model placeholder'],
  ['none.', 'a model placeholder with punctuation'],
  ['Unknown', 'a model placeholder'],
  ['No competitors found.', 'a model refusal sentence'],
  ['Could not determine the origin story from this site.', 'a model refusal sentence'],
  ['Unable to identify a tagline.', 'a model refusal sentence'],
  ['No information available', 'a model placeholder']
];

// Real brand content — must come back BYTE FOR BYTE. Each of these is deliberately close to
// a rejection rule, because a validator is only conservative if it survives the near misses.
const KEEP = [
  'Paying a deposit and having no idea if the factory is real, or if the photos are stock.',
  'Sourcify, Alibaba Verified, Supplyia',
  'No fluff, ever.',
  'None of our competitors publish batch results.',
  'Privacy policy: we never sell your data, and we never will.',
  'We use cookies for the checkout basket, and that is the only thing we use them for. Everything else about how this shop runs is explained on the About page, in plain language, because that is the whole point of the brand.',
  'Anything under $50 — price < $50 is our sweet spot for a first order.',
  'No two containers are the same, which is why we photograph every batch.',
  'Not everyone needs an audit. Small first orders are usually fine without one.',
  'Nothing about this is glamorous. It is spreadsheets, inspectors and a lot of phone calls.',
  'Direct — "book an audit", no hype, no exclamation marks.',
  'a'.repeat(3800)  // long but under the cap: a real multi-paragraph origin story
];

for (const [val, why] of REJECT) {
  ok(sandbox.crawlValueOk(val) === '', `junk accepted into the brand brain: ${why} — ${JSON.stringify(String(val).slice(0, 70))}`);
}
for (const val of KEEP) {
  const out = sandbox.crawlValueOk(val);
  ok(out === val, `real brand content was rejected or altered: ${JSON.stringify(val.slice(0, 70))} -> ${JSON.stringify(String(out).slice(0, 70))}`);
}
ok(REJECT.length >= 15, 'reject table was gutted — fewer than 15 junk cases left');
ok(KEEP.length >= 10, 'keep table was gutted — fewer than 10 real-content cases left');

// list + URL gates
ok(JSON.stringify(sandbox.crawlListOk(['sourcing mistakes', 'Not specified', '', 'factory audits'], 10))
   === JSON.stringify(['sourcing mistakes', 'factory audits']), 'crawlListOk did not filter junk topics correctly');
ok(sandbox.crawlListOk(['x'.repeat(81)], 10).length === 0, 'crawlListOk accepted a sentence as a topic chip');
ok(sandbox.crawlListOk('not an array', 10).length === 0, 'crawlListOk did not reject a non-array');
ok(sandbox.crawlUrlOk('instagram.com/milasourcing') === 'instagram.com/milasourcing', 'a valid social URL was rejected');
ok(sandbox.crawlUrlOk('https://x.com/mila') === 'https://x.com/mila', 'a valid social URL was rejected');
ok(sandbox.crawlUrlOk('Their main channel is Instagram') === '', 'prose was accepted as a social profile URL');
ok(sandbox.crawlUrlOk('Not specified') === '', 'a placeholder was accepted as a social profile URL');

/* ────────────────────────── verdict ────────────────────────── */
if (fails.length) {
  console.error('FAIL (' + fails.length + '):');
  fails.forEach(f => console.error('  - ' + f));
  process.exit(1);
}
console.log('PASS — crawl findings reach the brand brain only through review; junk rejected, real brand copy untouched');
process.exit(0);
