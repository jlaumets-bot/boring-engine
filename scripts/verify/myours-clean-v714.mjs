#!/usr/bin/env node
// GATE (v714, owner 2026-11-06): the "Make it yours" screen is calm. Owner: "so much text on this function, full of
// text, also the boxes who I follow maybe bigger." EXECUTED — the real functions are lifted out of app.html and run
// in node:vm against a fake DOM (same approach as creator-panels-ui.mjs).
//   1  the removed paragraphs are gone: "Start from what's proven… inspired by, never copied", the long paste-box
//      helper, the per-twist explainer ("My take writes it from… The other five…"), the "How this works" link on this
//      screen. What stays: the title, ONE short line, a short placeholder, the main button, "or set it up manually"
//      (still opens the real manual form).
//   2  word count: the screen's own words (static markup that is visible + the creator cards' chrome + the FAQ link +
//      the Step 1/2 card's chrome; the creators' captions, handles and notes are content, not counted) are at least
//      40% fewer than v713. Baseline measured with this file's --measure on v713 (git 1957984): BASE_WORDS below.
//   3  creator cards: whole card is a ≥56 px target (112 px), @handle ≥17 px, note one line, grid of 2 at 390 px and
//      4 at 1440 px; feed rows: ≥56 px targets and every word ≥16 px.
//   4  the "⋯" menu: opens Edit / Remove on that card only, toggles closed, closes on Escape and on a tap outside,
//      Edit opens the editor, Remove still asks "Remove?" first and then removes through the real save path.
//   5  the "+ Add creator" card shows only while fewer than 5 TikTok creators are followed (the one creator rule,
//      cfFollowedHandles), and the add path still refuses a 6th.
//   6  v714 HYBRID (owner-approved mockup, 2026-11-07) SUPERSEDES this screen as the main one: "Make it yours" now opens on
//      the hybrid (scripts/verify/hybrid-v714.mjs — its start screen's words are checked there). This decluttered layout
//      is kept whole as the menu's "Classic Make it yours" (body.hy-classic), so checks 1–5 still guard it; the hybrid's
//      own markup is left out of the word count in 2.
// RUN: node scripts/verify/myours-clean-v714.mjs        EXPECT: "MYOURS CLEAN OK", exit 0.
// MEASURE another copy: node scripts/verify/myours-clean-v714.mjs --measure <path/to/app.html>
import fs from 'node:fs'; import vm from 'node:vm';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MEASURE = process.argv.indexOf('--measure');
const html = fs.readFileSync(MEASURE > 0 ? process.argv[MEASURE + 1] : path.join(ROOT, 'app.html'), 'utf8');
setTimeout(() => { console.log('FAIL: wall clock (60s) exceeded'); process.exit(2); }, 60000).unref();
let finished = false; process.on('exit', (code) => { if (!finished && code === 0) { console.log('FAIL: the gate ended before all checks ran'); process.exitCode = 1; } });
let fail = 0; const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('ok:', m); };
const BASE_WORDS = 147;  // v713 (git 1957984), measured with --measure on that file; see the header

const grab = n => {
  let i = html.indexOf('\nfunction ' + n + '('); if (i < 0) i = html.indexOf('\nasync function ' + n + '(');
  if (i < 0) throw new Error('no ' + n + ' in app.html');
  const eol = html.indexOf('\n', i + 1), first = html.slice(i + 1, eol);
  let d = 0, seen = false; for (const ch of first) { if (ch === '{') { d++; seen = true; } else if (ch === '}') d--; }
  if (seen && d === 0) return first;
  return html.slice(i + 1, html.indexOf('\n}', i) + 2);
};
const between = (a, b) => { const i = html.indexOf(a); const j = html.indexOf(b, i); if (i < 0 || j < 0) throw new Error('marker missing: ' + a.slice(0, 40)); return html.slice(i, j); };
const constLine = n => { const m = new RegExp('\\nconst ' + n + ' = [^\\n]*').exec(html); if (!m) throw new Error('no const ' + n); return m[0].trim(); };
const constObj = n => { const i = html.indexOf('\nconst ' + n + ' = {'); if (i < 0) throw new Error('no ' + n); return html.slice(i + 1, html.indexOf('\n};', i) + 3); };
const tick = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const dec = t => t.replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '—').replace(/&hellip;/g, '…').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const words = h => dec(String(h).replace(/<[^>]*>/g, ' ')).split(/\s+/).filter(w => /[A-Za-z0-9]/.test(w));

// ── fake DOM ──
const els = {}; const handlers = {};
const mk = id => ({ id, value: '', textContent: '', style: {}, focus() {}, scrollIntoView() {} });
function host(id) {
  const e = mk(id); els[id] = e; let h = ''; let kids = [];
  Object.defineProperty(e, 'innerHTML', { get: () => h, set: v => {
    h = String(v); for (const k of kids) delete els[k]; kids = [];
    for (const m of h.matchAll(/<(\w+)([^>]*?)\bid="([^"]+)"([^>]*)>/g)) { const k = mk(m[3]); kids.push(m[3]); els[m[3]] = k; }
  } });
  return e;
}
let saves = [];
const c = {
  console: { log() {}, warn() {}, error() {}, info() {} }, JSON, Promise, Date, Math, String, Number, Array, Object, Set, Map, RegExp, Error, URL,
  window: {}, currentBrand: { id: 'brand-1' }, bookmarkCategories: [],
  document: { getElementById: id => els[id] || null, querySelector: () => null, addEventListener: (t, f) => { (handlers[t] = handlers[t] || []).push(f); },
    createElement: () => ({ className: '', innerHTML: '', remove() {} }), head: { appendChild() {} } },
  listLoadFailed: () => false, _warnListNotSaved() {}, _warnSaveFailed() {}, _listLoaded: () => true,
  _replaceBrandRows: async (table, brandId, rows) => { saves.push({ table, rows: JSON.parse(JSON.stringify(rows)) }); return { ok: true }; },
  renderBookmarkBar() {}, renderBookmarksInner: () => '', toggleBookmarkBar() {}, rerenderBookmarks() { c.renderFollowPanels(); },
  renderRemixDelivery() {}, remixRefImage: null, _rxOptsOpen: false, _rxBusy: '', _rxOrig: null,
};
c.globalThis = c; vm.createContext(c);
const load = src => vm.runInContext(src, c);
load(between('// ===== follow-panels:', '\nfunction saveBookmarks() {').replace(/^(let|const) /gm, 'var '));
for (const n of ['escapeHtml', 'escAttr', 'safeUrl', 'escHtml', 'bmId', 'saveBookmarks', 'saveBookmarksToDB', 'renderFnFaq', 'remixOrigRender', 'rxWordCount', 'rxWordsLabel']) load(grab(n));
for (const n of ['FN_FAQ_TITLE', 'FN_FAQ']) load(constObj(n).replace(/^const /, 'var '));
{ const m = /\nconst RX_MODES = \[[\s\S]*?\n\];/.exec(html); if (!m) throw new Error('no RX_MODES'); load(m[0].replace('const ', 'var ')); }
const HAS_CF = html.includes('\nfunction cfFollowedHandles(');
if (HAS_CF) { for (const n of ['cfTtLink', 'cfCreatorTtLink', 'cfFollowedHandles', 'cfAllowLinks']) load(grab(n)); for (const n of ['CF_MAX_CREATORS', 'CF_MAX_MSG']) load(constLine(n).replace(/^const /, 'var ')); }

const P = () => els.followPanels.innerHTML;
const cards = () => P().split('<div class="fp-panel').slice(1).map(x => '<div class="fp-panel' + x);
const ent = id => c.bookmarkCategories.flatMap(k => k.entries).find(e => e.id === id);
const FIX = () => [
  { id: 'c1', name: 'Competitors', entries: [
    { id: 'e1', name: 'Monday.com', links: { tt: 'https://tiktok.com/@mondaydotcom', web: 'https://monday.com' }, note: 'Clean product demos, every week' },
    { id: 'e2', name: 'Asana', links: { ig: 'https://instagram.com/asana' }, note: 'Watch how they launch features' } ] },
  { id: 'c2', name: 'Creators I like', entries: [
    { id: 'e3', name: 'Studio Ops Daily', links: { tt: 'https://tiktok.com/@studioops' }, note: 'Best hooks in my niche' },
    { id: 'e4', name: 'Calm Founder', links: { tt: 'https://www.tiktok.com/@calmfounder' } },
    { id: 'e5', name: 'Morning Cup Co', links: { tt: 'https://www.tiktok.com/@morningcup' }, note: 'Coffee storytelling that never feels like an ad' } ] } ];
const reset = cats => {
  for (const k of Object.keys(els)) delete els[k];
  host('followPanels'); saves = []; c.bookmarkCategories = cats;
  load('_fpEdit = ""; _fpAdding = false; _fpConfirm = ""; _fpReplaceAsk = "";' + (html.includes('let _fpMenu') ? ' _fpMenu = "";' : ''));
  c.renderFollowPanels();
};

// ── the screen's own words ──
function screenWords() {
  let v = between('<div class="view" id="view-create">', '<!-- /view-create -->');
  v = v.replace(/<style>[\s\S]*?<\/style>/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  v = v.replace(/<section class="hy-app" id="hyApp"[\s\S]*?<\/section>/, ' ');   // v714: the hybrid is checked by hybrid-v714
  const mp = v.indexOf('id="remixManualPanel"'), rv = v.indexOf('<div id="rv2Panel">');
  if (mp > 0 && rv > mp) v = v.slice(0, v.lastIndexOf('<div', mp)) + v.slice(rv);   // folded away ("remix-manual-hidden")
  const stat = words(v);
  reset(FIX());
  const card = words(P().replace(/<span class="fp-(?:name|note|handle|av)[^"]*"[^>]*>[^<]*<\/span>/g, ' ').replace(/<div class="fp-name">[^<]*<\/div>/g, ' '));
  const faqHost = { kids: [], querySelector: () => null, appendChild(x) { this.kids.push(x); } };
  c.renderFnFaq('create', faqHost);
  const faq = faqHost.kids.length ? words((/<summary>([\s\S]*?)<\/summary>/.exec(faqHost.kids[0].innerHTML) || [, ''])[1].replace(/<span class="cs-sr">[\s\S]*?<\/span>/g, '')) : [];
  host('remixOrigCard'); host('rxOrigText'); c._rxOrig = { kind: 'tiktok', url: 'https://www.tiktok.com/@bob/video/1', creator: 'bob', platform: 'tiktok', text: 'one two three', empty: false, failed: false, note: '' };
  load('_rxOrig = globalThis._rxOrig'); c.remixOrigRender();
  const orig = words(els.remixOrigCard.innerHTML.replace(/<textarea[\s\S]*?<\/textarea>/g, ' ').replace(/<div class="rx-opts-body">[\s\S]*?<\/details>/g, ' ').replace(/<span class="rx-orig-creator">[^<]*<\/span>/g, ' '));
  return { total: stat.length + card.length + faq.length + orig.length, stat: stat.join(' '), card: card.join(' '), faq: faq.join(' '), orig: orig.join(' ') };
}

(async () => {
  if (MEASURE > 0) { const w = screenWords(); console.log(JSON.stringify(w, null, 1)); finished = true; return; }
  const view = between('<div class="view" id="view-create">', '<!-- /view-create -->');
  // ═══ 1. the removed paragraphs are gone ═══
  const GONE = ["Start from what's proven", 'inspired by, never copied', 'The smartest creators study what already works',
    'You see the exact words first', 'Paste a TikTok, YouTube or article link &mdash; or any text', 'My take writes it from a point you pick',
    'The other five rewrite the original', 'Seen something that works?', 'Save the creators you learn from', 'Add why you follow them'];
  const still = GONE.filter(t => html.includes(t));
  ok(!still.length, '1 the removed paragraphs are gone from app.html (' + (still.length ? 'still there: ' + still.join(' | ') : GONE.length + ' phrases') + ')');
  ok(!/class="al-banner"/.test(view), '1 no banner box on the screen');
  ok(/class="cs-rx-title"[^>]*>Make it yours<\/div>\s*<div class="rx-sub">Paste a TikTok\. Get your version\.<\/div>/.test(view), '1 the title + ONE short line under it');
  ok(/id="remixQuickIn" placeholder="Paste a TikTok link"/.test(view) && /id="remixQuickBtn" onclick="remixQuickGo\(this\)">Make it yours<\/button>/.test(view), '1 short placeholder; the main button stays');
  ok(/onclick="remixToggleManual\(\)"[^>]*>or set it up manually/.test(view) && /id="remixManualPanel"/.test(view) && /function remixToggleManual\(/.test(html), '1 "or set it up manually" stays as a small link and still opens the real manual form');
  { const faqHost = { kids: [], querySelector: () => null, appendChild(x) { this.kids.push(x); } };
    c.renderFnFaq('create', faqHost); const n1 = faqHost.kids.length; c.renderFnFaq('ideas', faqHost);
    ok(n1 === 0 && faqHost.kids.length === 1, '1 no "How this works" link on Make it yours (other screens keep theirs)'); }
  // ═══ 2. word count ═══
  { const w = screenWords();
    const limit = Math.floor(BASE_WORDS * 0.6);
    ok(w.total <= limit, '2 the screen\'s own words: ' + BASE_WORDS + ' (v713) → ' + w.total + ' (limit ' + limit + ', at least 40% fewer) [' + w.stat + ' | ' + w.card + ' | ' + w.faq + ' | ' + w.orig + ']'); }
  // ═══ 3. sizes ═══
  const rule = sel => { const m = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}').exec(html); return m ? m[1] : ''; };
  const px = (body, prop) => { const m = new RegExp('(?:^|;)' + prop + ':(\\d+(?:\\.\\d+)?)px').exec(body); return m ? +m[1] : 0; };
  { const grid = rule('#view-create #followPanels .fp-row');
    const mm = /minmax\((\d+)px,1fr\)/.exec(grid), gap = px(grid, 'gap'), col = mm ? +mm[1] : 0;
    const cols = w => Math.floor((w + gap) / (col + gap));
    ok(/display:grid !important/.test(grid) && col > 0 && cols(390 - 32) === 2 && cols(760) >= 3 && cols(760) <= 4, '3 cards: a grid, ' + cols(358) + ' a row on a 390 px phone, ' + cols(760) + ' on desktop (min ' + col + ' px, gap ' + gap + ')'); }
  { const open = rule('#followPanels .fp-card .fp-open,#followPanels .fp-add .fp-add-btn'), card = rule('#followPanels .fp-card');
    ok(px(open, 'min-height') >= 56 && px(card, 'min-height') >= 56 && /width:100%/.test(open), '3 each card is one tap target ≥56 px tall (' + px(open, 'min-height') + ' px)'); }
  { const h = rule('#followPanels .fp-handle,#followPanels .fp-add-lbl'), n = rule('#followPanels .fp-card .fp-note'), av = rule('#followPanels .fp-av');
    ok(px(h, 'font-size') >= 17 && px(h, 'font-size') <= 18 && /text-overflow:ellipsis/.test(h), '3 the @handle is ' + px(h, 'font-size') + ' px');
    ok(/white-space:nowrap/.test(n) && /text-overflow:ellipsis/.test(n), '3 the "why I follow" note is one line with an ellipsis');
    ok(px(av, 'width') >= 44 && px(av, 'height') >= 44 && /border-radius:50%/.test(av), '3 a big initial circle (' + px(av, 'width') + ' px)'); }
  { const fs16 = rule('#creatorFeed .cf-handle,#creatorFeed .cf-cap,#creatorFeed .cf-age,#creatorFeed .cf-views,#creatorFeed .cf-chip,#creatorFeed .cf-open,#creatorFeed .cf-row-err,#creatorFeed .cf-cerr');
    ok(px(fs16, 'font-size') >= 16 && px(rule('#creatorFeed .cf-open'), 'min-height') >= 56 && /min-height:5[6-9]px|min-height:[6-9]\dpx/.test(rule('.cf-main')),
      '3 feed rows: every word ≥16 px; the row and its Open link are ≥56 px targets'); }
  // ═══ 4. the "⋯" menu ═══
  reset(FIX());
  { const ps = cards();
    ok(ps.slice(0, 5).every((p, i) => p.includes('onclick="fpMenuToggle(' + i + ')" aria-haspopup="menu" aria-expanded="false"') && !/>Edit</.test(p) && !/>Remove</.test(p)), '4 every card has a "⋯" button and no visible Edit / Remove');
    ok(/class="fp-handle">@mondaydotcom</.test(ps[0]) && /class="fp-av" aria-hidden="true">M</.test(ps[0]) && ps[0].includes('href="https://www.tiktok.com/@mondaydotcom" target="_blank" rel="noopener noreferrer"'),
      '4 a card shows the initial and @handle and opens the profile'); }
  c.fpMenuToggle(2);
  ok(/role="menu"/.test(cards()[2]) && /onclick="fpEditOpen\(2\)">Edit</.test(cards()[2]) && /onclick="fpRemove\(2\)">Remove</.test(cards()[2]) && (P().match(/role="menu"/g) || []).length === 1, '4 "⋯" opens Edit / Remove on that card only');
  c.fpMenuToggle(2); ok(!/role="menu"/.test(P()), '4 a second tap closes it');
  c.fpMenuToggle(1);
  (handlers.keydown || []).forEach(f => f({ key: 'Escape' }));
  ok(!/role="menu"/.test(P()) && (handlers.keydown || []).length === 1, '4 Escape closes it (one listener, wired once)');
  c.fpMenuToggle(1);
  (handlers.click || []).forEach(f => f({ target: { closest: s => (/\.fp-menu/.test(s) ? { menu: 1 } : null) } }));
  ok(/role="menu"/.test(P()), '4 a tap inside the menu keeps it open');
  (handlers.click || []).forEach(f => f({ target: { closest: () => null } }));
  ok(!/role="menu"/.test(P()) && (handlers.click || []).length === 1, '4 a tap anywhere else closes it');
  c.fpMenuToggle(0); c.fpEditOpen(0);
  ok(!/role="menu"/.test(P()) && els.fpEditNote && /fp-editing/.test(cards()[0]), '4 Edit opens the editor and closes the menu');
  c.fpCancel();
  c.fpMenuToggle(1); c.fpRemove(1);
  ok(ent('e2') && saves.length === 0 && />Remove\?</.test(cards()[1]) && !/role="menu"/.test(P()), '4 Remove still asks first ("Remove?"), on the card');
  ok(c.fpRemove(1) === true && !ent('e2'), '4 the second Remove removes them'); await tick();
  ok(saves.length === 1 && saves[0].table === 'competitors', '4 …through the real bookmarks save');
  // ═══ 5. the add card and the 5-creator rule ═══
  reset(FIX());
  ok(HAS_CF && c.cfFollowedHandles(null).length === 4 && /class="fp-add-btn" onclick="fpAddOpen\(\)"/.test(P()) && /Add creator/.test(cards().slice(-1)[0]), '5 4 TikTok creators followed: the "+ Add creator" card is last');
  c.fpAddOpen(); els.fpAddLink.value = 'https://www.tiktok.com/@fifth'; c.fpAdd(); await tick();
  ok(c.cfFollowedHandles(null).length === 5 && !/fp-add-btn/.test(P()) && !/Add creator/.test(P()), '5 the 5th is added through the existing add path; the add card disappears at 5');
  { const cats = FIX(); cats[0].entries.push({ id: 'e6', name: 'Six', links: { tt: 'https://www.tiktok.com/@six' } }); reset(cats); }
  ok(!/Add creator/.test(P()) && c.cfFollowedHandles(null).length === 5, '5 5 TikTok + 1 Instagram: no add card');
  c.fpAddOpen(); els.fpAddLink.value = 'https://www.tiktok.com/@seventh';
  ok(c.fpAdd() === false && els.fpAddErr.textContent === c.CF_MAX_MSG, '5 the add path still refuses a 6th TikTok creator ("' + c.CF_MAX_MSG + '")');
  c.fpCancel();
  { const cats = FIX(); cats[0].entries.splice(0, 1); reset(cats); }
  ok(c.cfFollowedHandles(null).length === 3 && /Add creator/.test(P()), '5 under 5 again: the add card is back');

  // ═══ 6. superseded by the v714 hybrid: this layout is now "Classic Make it yours" ═══
  { const css = fs.readFileSync(path.join(ROOT, 'clean.css'), 'utf8');
    ok(view.indexOf('<section class="hy-app" id="hyApp"') >= 0 && view.indexOf('id="hyApp"') < view.indexOf('id="createRemix"'), '6 the hybrid main screen comes first in the view; this layout follows it, whole');
    ok(/body:not\(\.hy-classic\) #view-create > #createRemix \{ display: none !important; \}/.test(css) && /\{ act: 'hyClassic', icon: 'create', label: 'Classic Make it yours' \}/.test(html) && /function hyClassic\(\)\{ _hy\.classicReq = true; switchView\('create'\);/.test(html),
      '6 this layout opens from the menu as "Classic Make it yours" (hidden on the main screen, nothing removed)'); }

  finished = true;
  if (fail) { console.log(fail + ' check(s) failed'); process.exit(1); }
  console.log('MYOURS CLEAN OK');
})().catch(e => { console.log('FAIL: threw', e && e.stack || e); process.exit(1); });
