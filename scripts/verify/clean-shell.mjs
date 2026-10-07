#!/usr/bin/env node
// GATE (redesign, agent S): the clean shell — LOOK changes only, every destination still reachable.
// EXECUTED where it can be: the real functions are lifted from app.html and run in node:vm on a fake DOM.
//   1  CS_DEFAULT_THEME is 'dark' and decides only for people with no saved choice; a choice saved under
//      'cs-theme' ('dark'|'light'|'system', written by toggleDarkMode) wins; the OLD key bn-dark-mode is
//      ignored and removed (v702: a leftover '0' kept people on white); 'light' / 'system' defaults work;
//      the Settings switch shows the theme actually on screen.
//   2  /clean.css is linked once, after the big inline <style>, as the LAST stylesheet before </head>;
//      the Geist font is linked.
//   3  the drawer lists EVERY destination the old phone tab bar + More sheet reached (read live from
//      renderNavWithLocks / toggleMoreSheet, which still exist, AND from a snapshot of v698 HEAD), plus the
//      header buttons hidden on phones; every onclick in the new markup names a function that exists.
//   4  lock rules: the drawer locks exactly the screens renderNavWithLocks locks, locked rows only call
//      showLockedToast, and csDrawerGo refuses a locked screen.
//   5  drawer behaviour: opens with aria-expanded=true and focus inside; Esc, backdrop, navigating and
//      csShellSync (every switchView) close it; aria-expanded=false after.
//   6  composer routing: a link (remixPickLink's ≤8-plain-words rule) → Remix via remixQuickGo with the
//      text in #remixQuickIn (not while a Remix read/twist runs); plain words → the Idea Catcher writer
//      (rv2Start, "MY IDEA: …", origin 'composer') with ONLY the composer text — the Idea Catcher draft is
//      never read or touched; empty → nothing;
//      a link while Remix is locked → showLockedToast only. Composer padding + safe area in CSS.
//   7  the app opens on Ideas (CS_START_VIEW) and the ?open= deep link handler runs AFTER that switch.
//   8  Quick Post: one primary button "Write today’s post", same id and same onclick as v698's circle;
//      no mascot image; "or pick the angle myself" kept.
//   9  the phone tab bar is hidden at every width; decorative emoji / mascot art gone from main screens.
//  10  the open drawer and its backdrop sit ABOVE the install banner (.pwa-banner) and below the tour.
//  12  Ideas first: with pending ideas a "N ideas ready" heading + "Plan my week" pill; the plan card (same ids)
//      folds and unfolds in place; with 0 pending the full card shows; every renderIdeas refreshes it.
//  13  the per-screen FAQ (renderFnFaq) sits at the BOTTOM as a muted "How this works" link, same Q&A inside.
//  14  the floating shrimp is OFF for people who never chose; a saved choice wins; the Settings switch works.
//  15  review fixes: /clean.css is served from cache only when fetched for this BUILD (else network, cached
//      + marked; offline → cached; a 404 never fails install); the status-bar colour + manifest are dark
//      from the first paint; the Assistant row keeps press-and-hold; the page behind the open drawer does
//      not scroll and the drawer closes at ≥900px; a Plan my week run from 0 pending keeps the card open.
//  11  the guided tour under 900px points at the ☰ menu / pencil (never the hidden tab bar); a step whose
//      target is missing or not on screen is skipped; at 900px+ it points at the desktop sidebar.
// RUN: node scripts/verify/clean-shell.mjs      EXPECT: prints "CLEAN SHELL OK", exit 0.
import fs from 'node:fs'; import vm from 'node:vm';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
setTimeout(() => { console.log('FAIL: wall clock (60s) exceeded'); process.exit(2); }, 60000).unref();
let finished = false; process.on('exit', (code) => { if (!finished && code === 0) { console.log('FAIL: the gate ended before all checks ran'); process.exitCode = 1; } });
let fail = 0; const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('ok:', m); };
const grab = n => {
  let i = html.indexOf('\nfunction ' + n + '('); if (i < 0) i = html.indexOf('\nasync function ' + n + '(');
  if (i < 0) throw new Error('no ' + n + ' in app.html');
  const eol = html.indexOf('\n', i + 1), first = html.slice(i + 1, eol);
  let d = 0, seen = false; for (const ch of first) { if (ch === '{') { d++; seen = true; } else if (ch === '}') d--; }
  if (seen && d === 0) return first;
  return html.slice(i + 1, html.indexOf('\n}', i) + 2);
};
const between = (a, b, from = 0) => { const i = html.indexOf(a, from); const j = html.indexOf(b, i); if (i < 0 || j < 0) throw new Error('marker missing: ' + a.slice(0, 50)); return html.slice(i, j + b.length); };
const fnExists = n => new RegExp('\\n\\s*(?:async )?function ' + n + '\\(|window\\.' + n + '\\s*=\\s*(?:async )?function').test(html);

// ── fake DOM ──
function mkEl(id) {
  const e = { id, value: '', hidden: false, innerHTML: '', textContent: '', disabled: false, attrs: {}, style: {}, dataset: {}, children: [],
    classList: { _s: new Set(), add(...k) { k.forEach(x => this._s.add(x)); }, remove(...k) { k.forEach(x => this._s.delete(x)); }, toggle(k, f) { const on = f === undefined ? !this._s.has(k) : f; on ? this._s.add(k) : this._s.delete(k); }, contains(k) { return this._s.has(k); } },
    getAttribute(k) { return this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; },
    focus() { DOC.activeElement = this; }, scrollIntoView() {}, click() {}, appendChild(c) { this.children.push(c); return c; }, remove() {},
    contains(x) { return x === this || (x && x._parent === this); }, querySelector() { return null; }, querySelectorAll() { return []; } };
  return e;
}
let DOC;
function freshDom() {
  const els = {}, keyHandlers = [];
  const put = id => (els[id] = mkEl(id));
  DOC = { activeElement: null, getElementById: id => els[id] || null, createElement: () => mkEl(''), querySelector: () => null, querySelectorAll: () => [],
    addEventListener: (t, f) => { if (t === 'keydown') keyHandlers.push(f); },
    body: Object.assign(mkEl('body'), {}), documentElement: mkEl('html') };
  return { els, put, keyHandlers };
}

/* ═══ 1. theme default ═══ */
{
  const head = between('var CS_DEFAULT_THEME', "try { document.documentElement.dataset.theme = csResolveTheme(); } catch (e) {}");
  const m = /var CS_DEFAULT_THEME = '(\w+)';/.exec(head);
  ok(m && m[1] === 'dark', '1 CS_DEFAULT_THEME is \'dark\'');
  ok(html.indexOf('var CS_DEFAULT_THEME') < html.indexOf('</head>') && html.indexOf('var CS_DEFAULT_THEME') < html.indexOf('<link rel="stylesheet" href="/clean.css">'), '1 the theme is applied in <head>, before the first paint');
  ok((html.match(/CS_DEFAULT_THEME = '/g) || []).length === 1, '1 the default lives in ONE constant');
  const run = (saved, def, sysDark, old) => {
    const store = saved == null ? {} : { 'cs-theme': saved };
    if (old != null) store['bn-dark-mode'] = old;
    const de = { dataset: {} };
    const c = { window: { matchMedia: () => ({ matches: !!sysDark }) }, localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
      document: { documentElement: de, querySelector: () => ({ content: '' }) } };
    c.window.localStorage = c.localStorage;
    vm.createContext(c);
    vm.runInContext(def ? head.replace("var CS_DEFAULT_THEME = 'dark'", "var CS_DEFAULT_THEME = '" + def + "'") : head, c);
    return { theme: de.dataset.theme, c, store, de };
  };
  ok(run(null).theme === 'dark', '1 no saved choice → dark');
  const legacy = run(null, null, false, '0');
  ok(legacy.theme === 'dark' && !('bn-dark-mode' in legacy.store), '1 an old bn-dark-mode=\'0\' from the previous design is ignored (still dark) and removed');
  ok(run(null, null, false, '1').theme === 'dark' && run('light', null, false, '1').theme === 'light', '1 the old key never decides, either way');
  ok(run('light').theme === 'light', '1 cs-theme=\'light\' wins over the dark default');
  ok(run('dark').theme === 'dark' && run('dark', 'light').theme === 'dark', '1 cs-theme=\'dark\' → dark (even with a light default)');
  ok(run('system', null, true).theme === 'dark' && run('system', null, false).theme === 'light', '1 cs-theme=\'system\' follows the device');
  ok(run('nonsense').theme === 'dark' && run('0').theme === 'dark', '1 an unknown cs-theme value falls back to the default');
  ok(run(null, 'light').theme === 'light' && run(null, 'system', true).theme === 'dark' && run(null, 'system', false).theme === 'light', '1 default \'light\' / \'system\' work for people who never chose');
  // the switch: toggleDarkMode writes cs-theme, and the resolver then obeys it
  const r = run(null);
  vm.runInContext(grab('toggleDarkMode'), r.c);
  r.c.toggleDarkMode(false);
  ok(r.store['cs-theme'] === 'light' && !('bn-dark-mode' in r.store) && r.de.dataset.theme === 'light' && r.c.csResolveTheme() === 'light', '1 Settings → Dark Mode off: cs-theme=\'light\' saved, applied, and it now beats the default');
  r.c.toggleDarkMode(true);
  ok(r.store['cs-theme'] === 'dark' && r.c.csResolveTheme() === 'dark', '1 Dark Mode on: cs-theme=\'dark\' saved and applied');
  ok(!/localStorage\.(getItem|setItem)\('bn-dark-mode'/.test(html), '1 nothing reads or writes bn-dark-mode any more');
  {
    const restore = between("// Restore dark mode on load\n(function() {", '})();');
    const de2 = { dataset: {} }, meta2 = { content: '' };
    const c2 = { csResolveTheme: () => 'light', document: { documentElement: de2, querySelector: () => meta2 } };
    vm.createContext(c2); vm.runInContext(restore, c2);
    const c3 = { csResolveTheme: () => 'dark', document: { documentElement: { dataset: {} }, querySelector: () => ({ content: '' }) } };
    vm.createContext(c3); vm.runInContext(restore, c3);
    ok(de2.dataset.theme === 'light' && meta2.content === '#ffffff' && c3.document.documentElement.dataset.theme === 'dark', '1 the on-load restore applies the resolved theme both ways');
  }
  ok(/<input type="checkbox" \$\{csResolveTheme\(\)==='dark'\?'checked':''\} onchange="toggleDarkMode\(this\.checked\)">/.test(html), '1 the Settings switch shows the theme on screen (default included)');
}

/* ═══ 2. stylesheet order + font ═══ */
{
  const headEnd = html.indexOf('</head>');
  const headPart = html.slice(0, headEnd);
  const link = '<link rel="stylesheet" href="/clean.css">';
  const li = headPart.indexOf(link);
  ok(li > 0 && (html.match(/href="\/clean\.css"/g) || []).length === 1, '2 /clean.css is linked exactly once, inside <head>');
  const lastStyleClose = headPart.lastIndexOf('</style>');
  const bigOpen = headPart.indexOf('<style>');
  ok(bigOpen > 0 && lastStyleClose > bigOpen && (lastStyleClose - bigOpen) > 100000, '2 the big inline <style> is in <head>');
  ok(li > lastStyleClose, '2 /clean.css loads AFTER the big inline <style>');
  const tail = headPart.slice(li + link.length);
  ok(!/<link[^>]*rel="stylesheet"|<style/i.test(tail), '2 nothing stylesheet-like follows it in <head> (it is the last)');
  ok(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2\?family=Geist:wght@400;500;600&display=swap">/.test(headPart), '2 the Geist font is linked');
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  ok(/const CORE = \[[^\]]*'\/clean\.css'[^\]]*\];/.test(sw), '2 sw.js re-downloads /clean.css with every build (in CORE; the rest is cache-first)');
}

/* ═══ shared context: nav, More sheet, shell ═══ */
const shell = between('// ===== v699 CLEAN SHELL (agent S)', '// ===== end v699 CLEAN SHELL =====');
ok(/function csComposerSend\(\)/.test(shell) && /function csDrawerHtml\(\)/.test(shell), 'shell block found');
function makeCtx(unlocked) {
  const d = freshDom();
  ['navTabs', 'csDrawerWrap', 'csDrawer', 'csMenuBtn', 'csComposerIn', 'remixQuickIn', 'remixQuickBtn', 'icIdea', 'icUrl', 'icNotes', 'csIdeasHead', 'view-ideas', 'ideasQuick'].forEach(d.put);
  d.els.csDrawerWrap.hidden = true;
  d.els.csDrawer._parent = d.els.csDrawerWrap;
  d.els.csDrawer.querySelector = () => { const it = mkEl('item'); it._parent = d.els.csDrawerWrap; return it; };
  const calls = [];
  const c = { console: { log() {}, warn() {}, error() {}, info() {} }, JSON, String, Number, Array, Object, Set, Map, RegExp, Math, Date, Error,
    window: { APP_VERSION: 'vTEST', innerWidth: 375 }, document: DOC, requestAnimationFrame: f => f(),
    state: [{ status: 'filming' }, { status: 'pending' }], remixes: [{}, {}], notebookNotes: [{}], activeView: 'ideas',
    isBrandMinimumMet: () => unlocked, getPendingIdeas: () => [{}], csShelved: () => false, DS_ICONS: {},
    switchView: v => { calls.push(['switchView', v]); c.activeView = v; }, showLockedToast: () => calls.push(['showLockedToast']),
    remixQuickGo: b => calls.push(['remixQuickGo', b && b.id]), icDevelopV2: () => calls.push(['icDevelopV2']),
    icDraftQueue: () => calls.push(['icDraftQueue']), closeMoreSheet: () => {},
    showToast: m => calls.push(['showToast', m]), _rxBusy: '', _rxFetching: false, _rv2Runs: { rv2Panel: null, rv2Sheet: null },
    lsGet: k => { calls.push(['lsGet', k]); return null; }, lsSet: k => calls.push(['lsSet', k]), lsDel: k => calls.push(['lsDel', k]) };
  c.rv2Start = (btn, src, opts) => { calls.push(['rv2Start', btn, src, opts]); c._rv2Runs.rv2Sheet = { source: src }; return Promise.resolve(); };
  vm.createContext(c);
  for (const n of ['renderNavWithLocks', 'toggleMoreSheet', 'remixDetectKind', 'remixAbsUrl', 'remixPickLink']) vm.runInContext(grab(n), c);
  vm.runInContext(between('const RX_LINK_MAX_WORDS', ';'), c);
  vm.runInContext(shell, c);
  return { c, d, calls };
}
const parseViews = h => new Set([...h.matchAll(/(?:switchView|moreGo|csDrawerGo)\('(\w+)'\)/g)].map(m => m[1]));
const parseActs = h => new Set([...h.matchAll(/onclick="(?:closeMoreSheet\(\);|csDrawerClose\(\);)?(\w+)\(/g)].map(m => m[1]));
const parseHrefs = h => new Set([...h.matchAll(/href="(\/[\w.-]+\.html)"/g)].map(m => m[1]));
const sub = (a, b) => [...a].filter(x => !b.has(x));

/* ═══ 3. every destination is in the drawer ═══ */
for (const unlocked of [true, false]) {
  const { c, d } = makeCtx(unlocked);
  c.renderNavWithLocks();
  const tabs = d.els.navTabs.innerHTML;
  let wrap = null; c.document.body.appendChild = w => { wrap = w; return w; };
  c.toggleMoreSheet();
  const more = wrap ? wrap.innerHTML : '';
  const drawer = c.csDrawerHtml();
  const dataViews = new Set([...drawer.matchAll(/data-view="(\w+)"/g)].map(m => m[1]));
  // old destinations (live from the code that still exists)
  const tabViews = new Set([...tabs.matchAll(/data-tab="(\w+)"/g)].map(m => m[1]).filter(v => v !== 'more' && v !== 'coach'));
  const oldViews = new Set([...tabViews, ...parseViews(more)]);
  const oldActs = new Set([...parseActs(tabs), ...parseActs(more)].filter(a => !['switchView', 'toggleMoreSheet', 'moreGo', 'closeMoreSheet', 'showLockedToast'].includes(a)));
  const tag = unlocked ? '(unlocked)' : '(locked)';
  ok(oldViews.size >= 8, '3 read the old tab bar + More screens ' + tag + ': ' + [...oldViews].join(','));
  ok(sub(oldViews, dataViews).length === 0, '3 every old screen is a drawer row ' + tag + (sub(oldViews, dataViews).length ? ' — missing ' + sub(oldViews, dataViews) : ''));
  const dActs = parseActs(drawer);
  ok(sub(oldActs, dActs).length === 0 && oldActs.has('bvTabClick') && oldActs.has('csCheckUpdate'), '3 every old action (Assistant, check for update) is in the drawer ' + tag + (sub(oldActs, dActs).length ? ' — missing ' + sub(oldActs, dActs) : ''));
  ok(sub(parseHrefs(more), parseHrefs(drawer)).length === 0 && parseHrefs(more).size === 3, '3 Terms, Privacy, Refunds are in the drawer ' + tag);
  // v698 HEAD snapshot (git show HEAD:app.html on 2026-10-04): tab bar today,ideas,pipeline,create,notebook + coach(bvTabClick) + More;
  // More: idea,questions,notebook,viral + bvTabClick + terms/privacy/refunds + csCheckUpdate; header: toggleBookmarkBar, openBrain, openSettings, startTour
  const SNAP_VIEWS = ['today', 'ideas', 'pipeline', 'create', 'notebook', 'idea', 'questions', 'viral'];
  const SNAP_ACTS = ['bvTabClick', 'csCheckUpdate', 'toggleBookmarkBar', 'openBrain', 'openSettings', 'startTour'];
  ok(SNAP_VIEWS.every(v => dataViews.has(v)), '3 v698 snapshot: all 8 screens in the drawer ' + tag);
  ok(SNAP_ACTS.every(a => dActs.has(a)), '3 v698 snapshot: Assistant, update check and the 4 header buttons (hidden on phones) in the drawer ' + tag);
}
{
  const hdr = between('<div class="header">', '<div class="csd-wrap" id="csDrawerWrap" hidden>');
  ok(/class="header-actions"/.test(hdr) && /onclick="toggleBookmarkBar\(\)"/.test(hdr) && /onclick="startTour\(\)"/.test(hdr), '3 the desktop header buttons are still there (≥900px)');
  ok(/id="csMenuBtn"[^>]*aria-controls="csDrawerWrap"[^>]*aria-expanded="false"[^>]*onclick="csDrawerToggle\(\)"/.test(hdr), '3 ☰ opens the drawer and carries aria-expanded');
  ok(/id="headerBrand" onclick="toggleBrandSwitcher\(\)"/.test(hdr), '3 the brand name still opens the brand switcher');
  ok(/id="csNewBtn"[^>]*onclick="csNewPost\(\)"/.test(hdr) && /function csNewPost\(\)\{ csDrawerClose\(\); switchView\('today'\); \}/.test(html), '3 the pencil opens Quick Post');
  const newMarkup = hdr + between('<div class="csd-wrap" id="csDrawerWrap" hidden>', '</div>\n', 0) + between('<form class="cs-composer"', '</form>') + makeCtx(true).c.csDrawerHtml() + makeCtx(false).c.csDrawerHtml();
  const targets = new Set([...newMarkup.matchAll(/on(?:click|submit|keydown|input)="([^"]*)"/g)].flatMap(m => [...m[1].matchAll(/(?:^|[;\s(])([A-Za-z_$][\w$]*)\(/g)].map(x => x[1])).filter(n => !['event', 'preventDefault'].includes(n)));
  const missing = [...targets].filter(n => !fnExists(n));
  ok(targets.size >= 12 && missing.length === 0, '3 every onclick target in the new header/drawer/composer exists (' + targets.size + ')' + (missing.length ? ' — missing ' + missing : ''));
}

/* ═══ 4. lock rules ═══ */
for (const unlocked of [true, false]) {
  const { c, d, calls } = makeCtx(unlocked);
  c.renderNavWithLocks();
  const tabLocked = new Set([...d.els.navTabs.innerHTML.matchAll(/class="nav-tab locked-tab" data-tab="(\w+)"/g)].map(m => m[1]));
  const drawer = c.csDrawerHtml();
  const rows = [...drawer.matchAll(/<button type="button" class="csd-item([^"]*)" data-view="(\w+)"[^>]*onclick="([^"]*)"/g)];
  const drLocked = new Set(rows.filter(r => /\blocked\b/.test(r[1])).map(r => r[2]));
  const tag = unlocked ? '(brand set up)' : '(brand minimum not met)';
  ok([...tabLocked].sort().join() === [...drLocked].sort().join() && (unlocked ? tabLocked.size === 0 : tabLocked.size === 2), '4 the drawer locks exactly what renderNavWithLocks locks ' + tag + ': [' + [...drLocked] + ']');
  ok(rows.filter(r => /\blocked\b/.test(r[1])).every(r => /showLockedToast\(\)/.test(r[3]) && !/switchView|csDrawerGo/.test(r[3])), '4 a locked row only shows the lock toast ' + tag);
  ok(!/🔒/.test(drawer) && (unlocked || /class="csd-lock"/.test(drawer)), '4 the lock is a plain icon, not the emoji ' + tag);
  calls.length = 0; c.csDrawerGo('create');
  ok(unlocked ? calls.some(x => x[0] === 'switchView' && x[1] === 'create') : (calls.some(x => x[0] === 'showLockedToast') && !calls.some(x => x[0] === 'switchView')), '4 csDrawerGo(\'create\') ' + (unlocked ? 'opens Remix' : 'refuses and shows the toast'));
}

/* ═══ 5. drawer behaviour ═══ */
{
  const { c, d, calls } = makeCtx(true);
  c.csDrawerOpen();
  ok(d.els.csDrawerWrap.hidden === false && d.els.csMenuBtn.attrs['aria-expanded'] === 'true' && d.els.csDrawerWrap.classList.contains('open'), '5 ☰ opens it, aria-expanded=true');
  ok(DOC.activeElement === d.els.csDrawer, '5 focus moves to the drawer panel itself (no ring on a row after a tap-open)');
  ok(/role="dialog" aria-modal="true" aria-label="Menu"/.test(html), '5 the panel is a labelled modal dialog');
  ok(d.keyHandlers.length >= 1, '5 a keydown handler is registered');
  let prevented = false;
  d.keyHandlers.forEach(h => h({ key: 'Escape', preventDefault() { prevented = true; } }));
  ok(d.els.csDrawerWrap.hidden === true && d.els.csMenuBtn.attrs['aria-expanded'] === 'false' && prevented, '5 Esc closes it, aria-expanded=false');
  ok(DOC.activeElement === d.els.csMenuBtn, '5 focus returns to ☰');
  c.csDrawerOpen(); calls.length = 0; c.csDrawerGo('notebook');
  ok(d.els.csDrawerWrap.hidden === true && calls.some(x => x[0] === 'switchView' && x[1] === 'notebook'), '5 tapping a screen closes it and navigates');
  c.csDrawerOpen(); c.csShellSync('pipeline');
  ok(d.els.csDrawerWrap.hidden === true && DOC.body.attrs['data-cs-view'] === 'pipeline', '5 any switchView (csShellSync) closes it and tags the screen');
  ok(/<div class="csd-backdrop" onclick="csDrawerClose\(\)"><\/div>/.test(html), '5 a backdrop tap closes it');
  ok(/try\{ if\(typeof csShellSync==='function'\) csShellSync\(view\); \}catch\(e\)\{\}/.test(grab('switchView')), '5 switchView calls csShellSync');
  c.csDrawerToggle(); ok(d.els.csDrawerWrap.hidden === false, '5 toggle opens'); c.csDrawerToggle(); ok(d.els.csDrawerWrap.hidden === true, '5 toggle closes');
}

/* ═══ 6. composer routing ═══ */
{
  const { c } = makeCtx(true);
  const R = t => c.csComposerRoute(t);
  ok(R('') === '' && R('   \n ') === '', '6 empty → nothing');
  ok(R('https://www.tiktok.com/@chef/video/7351234567890') === 'remix' && R('vm.tiktok.com/ZMabc/') === 'remix', '6 a TikTok link → Remix');
  ok(R('check this out https://vm.tiktok.com/ZMabc/ #fyp') === 'remix', '6 a shared TikTok with a few words → Remix');
  ok(R('https://youtu.be/dQw4w9WgXcQ') === 'remix' && R('https://example.com/blog/post-1') === 'remix', '6 YouTube and article links → Remix');
  ok(R('one two three four five six seven eight nine words then https://vm.tiktok.com/ZMabc/') === 'idea', '6 more than 8 plain words around a link = my own words (v698 rule)');
  ok(R('why most people quit posting after two weeks') === 'idea', '6 plain words → my own idea');
  const send = (unlocked, text) => { const x = makeCtx(unlocked); x.d.els.csComposerIn.value = text; x.c.csComposerSend(); return x; };
  let x = send(true, 'https://vm.tiktok.com/ZMabc/');
  ok(x.calls.some(k => k[0] === 'switchView' && k[1] === 'create') && x.d.els.remixQuickIn.value === 'https://vm.tiktok.com/ZMabc/' && x.calls.some(k => k[0] === 'remixQuickGo' && k[1] === 'remixQuickBtn') && !x.calls.some(k => k[0] === 'icDevelopV2'), '6 link: Remix opens, the link is in its box, remixQuickGo runs with its button');
  ok(x.d.els.csComposerIn.value === '', '6 link: the composer is cleared after hand-off');
  {
    const t = makeCtx(true);
    t.d.els.icIdea.value = 'MY SAVED DRAFT idea'; t.d.els.icUrl.value = 'https://vm.tiktok.com/OLD/'; t.d.els.icNotes.value = 'old notes';
    t.d.els.csComposerIn.value = '  why most people quit posting  ';
    t.c.csComposerSend();
    const st = t.calls.find(k => k[0] === 'rv2Start');
    ok(st && st[1] === null && JSON.stringify(st[2]) === JSON.stringify({ kind: 'idea', text: 'MY IDEA: why most people quit posting' }) && st[3].host === 'rv2Sheet' && st[3].origin.name === 'composer',
      '6 words: the Idea Catcher writer (rv2Start, sheet) runs with ONLY "MY IDEA: <composer text>" — no link, notes or screenshot');
    ok(t.d.els.icIdea.value === 'MY SAVED DRAFT idea' && t.d.els.icUrl.value === 'https://vm.tiktok.com/OLD/' && t.d.els.icNotes.value === 'old notes', '6 words: the Idea Catcher fields are untouched');
    ok(!t.calls.some(k => ['icDraftQueue', 'icDevelopV2', 'lsGet', 'lsSet', 'lsDel', 'switchView', 'remixQuickGo'].includes(k[0])), '6 words: no draft read/write, no autosave, no screen change, no Remix');
    ok(t.d.els.csComposerIn.value === '', '6 words: the composer clears once the run has started');
    const t2 = makeCtx(true); t2.c.rv2Start = () => Promise.resolve(); t2.d.els.csComposerIn.value = 'keep me';
    t2.c.csComposerSend();
    ok(t2.d.els.csComposerIn.value === 'keep me', '6 words: if no run started (no brand, a save in progress), the text stays');
    // the 'composer' origin: same tags as Idea Catcher, never clears Idea Catcher on save
    const oc = { csComposerClassic: () => 'classic', nbDevelop() {}, ideaDevelop() {}, generateTodayTabPost() {}, Object, String, Array };
    vm.createContext(oc); vm.runInContext(grab('rv2OriginFor'), oc);
    const o = oc.rv2OriginFor('composer', { text: 'hi' }), cat = oc.rv2OriginFor('catcher', {});
    ok(o.name === 'composer' && JSON.stringify(o.extra) === JSON.stringify(cat.extra) && typeof o.onSaved !== 'function' && typeof o.classic === 'function' && o.classic() === 'classic',
      '6 the composer origin tags the idea like Idea Catcher, has no onSaved (never clears Idea Catcher) and its own classic');
    const cc = grab('csComposerClassic');
    ok(/icDraftLoad\(\)/.test(cc) && /if \(busy\) \{ try \{ showToast\([^)]*\); \} catch \(e\) \{\} return; \}/.test(cc) && cc.indexOf('if (busy)') < cc.indexOf('ic.value ='), '6 its classic path only fills Idea Catcher when there is no draft there');
  }

  x = send(true, '   ');
  ok(!x.calls.some(k => ['switchView', 'remixQuickGo', 'rv2Start', 'showLockedToast'].includes(k[0])), '6 empty: nothing happens');
  x = send(false, 'https://vm.tiktok.com/ZMabc/');
  ok(x.calls.some(k => k[0] === 'showLockedToast') && !x.calls.some(k => k[0] === 'remixQuickGo' || k[0] === 'switchView') && x.d.els.csComposerIn.value === 'https://vm.tiktok.com/ZMabc/', '6 link while Remix is locked: lock toast, nothing sent, the link stays');
  x = send(false, 'my own idea');
  ok(x.calls.some(k => k[0] === 'rv2Start'), '6 words while locked still go to the Idea Catcher writer (it was never locked)');
  for (const busy of [['_rxBusy', 'simplify'], ['_rxFetching', true]]) {
    const b = makeCtx(true); b.c[busy[0]] = busy[1];
    b.d.els.remixQuickIn.value = 'the running one'; b.d.els.csComposerIn.value = 'https://vm.tiktok.com/NEW/';
    b.c.csComposerSend();
    ok(b.calls.some(k => k[0] === 'showToast' && k[1] === 'Wait for this one to finish first.') && b.d.els.csComposerIn.value === 'https://vm.tiktok.com/NEW/' && b.d.els.remixQuickIn.value === 'the running one' && !b.calls.some(k => k[0] === 'remixQuickGo' || k[0] === 'switchView'),
      '6 link while Remix is busy (' + busy[0] + '): "Wait for this one to finish first.", the composer keeps it, the Remix box is untouched');
  }
  const form = between('<form class="cs-composer"', '</form>');
  ok(/onsubmit="event\.preventDefault\(\);csComposerSend\(\);"/.test(form) && /<input type="text"[^>]*id="csComposerIn"[^>]*placeholder="Write a post about… or paste a TikTok link"/.test(form) && /type="submit"[^>]*aria-label="Send"/.test(form) && /<label for="csComposerIn"/.test(form), '6 the composer: labelled field, placeholder, Send button, submit → csComposerSend');
  ok(html.indexOf('<form class="cs-composer"') > html.indexOf('id="mainViews"') && html.indexOf('<form class="cs-composer"') < html.indexOf('id="settingsOverlay"'), '6 the composer lives inside #mainViews (hidden with it under Settings)');
  ok(/body\[data-cs-view="ideas"\] \.cs-composer, body\[data-cs-view="today"\] \.cs-composer \{\s*display: block; position: fixed;[^}]*bottom: 0;[^}]*env\(safe-area-inset-bottom\)/.test(html), '6 pinned at the bottom of Ideas + Quick Post, iOS safe area respected');
  const pad = /body\[data-cs-view="ideas"\] #view-ideas, body\[data-cs-view="today"\] #view-today \{ padding-bottom: calc\((\d+)px \+ env\(safe-area-inset-bottom\)\) !important; \}/.exec(html);
  ok(pad && +pad[1] >= 52 + 8 + 10 + 24, '6 the last card clears the composer (padding ' + (pad && pad[1]) + 'px + safe area)');
}

/* ═══ 7. start screen ═══ */
{
  ok(/var CS_START_VIEW = 'ideas';/.test(html), '7 CS_START_VIEW is Ideas');
  const init = grab('initApp');
  const sv = init.indexOf('switchView(CS_START_VIEW);'), deep = init.indexOf('csHandleOpenIdeas(window.location.href, true)');
  ok(sv > 0 && !/switchView\('today'\);\n\s*debugLog\('initApp: switchView\(today\)/.test(init), '7 initApp opens CS_START_VIEW (not Quick Post)');
  ok(deep > sv, '7 the ?open= deep link is handled AFTER the start screen, so it wins');
  const c = { URL, location: { origin: 'https://contentshrimp.com' } }; vm.createContext(c); vm.runInContext(grab('csReadOpen'), c);
  ok(c.csReadOpen('/app.html?open=ideas&b=abc') && !c.csReadOpen('/app.html'), '7 csReadOpen still reads ?open=ideas');
}

/* ═══ 8. Quick Post button ═══ */
{
  const out = {}; const d = freshDom(); const tv = mkEl('view-today'); d.els['view-today'] = tv;
  const mk = ok2 => {
    const c = { document: DOC, window: {}, localStorage: { getItem: () => null }, state: [], FORMATS: ['video', 'statement', 'bonus'], FORMAT_LABELS: { video: 'Video' },
      currentBrand: { id: 'b1' }, lsGet: () => null, getTodayName: () => 'Monday', getDayCommunities: () => ({ Monday: 'Tips' }), escHtml: s => String(s),
      isBrandMinimumMet: () => ok2, getMissingFields: () => ['Brand name'], homeBrainNudgeHtml: () => '', tvTypeRowHtml: () => '<div>types</div>', Math, Set };
    vm.createContext(c); vm.runInContext(grab('renderTodayView'), c); c.renderTodayView(); return tv.innerHTML;
  };
  const on = mk(true), off = mk(false);
  const b = /<button type="button" class="cs-primary-btn" id="tvGenerateBtn" onclick="([^"]+)">([^<]+)<\/button>/.exec(on);
  ok(b && b[2] === 'Write today’s post', '8 Quick Post shows one primary button "Write today’s post"');
  ok(b && b[1] === 'tvGenerateV2()', '8 it calls the same function as v698\'s circle (tvGenerateV2)');
  const b2 = /id="tvGenerateBtn" onclick="([^"]+)"/.exec(off);
  ok(b2 && b2[1] === 'showLockedToast()', '8 locked brand: the same lock toast as before');
  ok(!/<img/.test(on) && !/shrimp-mascot/.test(on) && !/tp-shz-ring/.test(on), '8 no mascot image or pulsing rings');
  ok(/onclick="openAngleSheet\(\)">or pick the angle myself/.test(on), '8 "or pick the angle myself" kept');
  ok(on.indexOf('id="tvTypeRow"') < on.indexOf('id="tvGenerateBtn"') && /id="tvShzCap"/.test(on) && /class="tp-shz-stage/.test(on) && /id="tvStatus"/.test(on), '8 the pieces generateTodayTabPost drives are still there (stage, caption, status)');
}

/* ═══ 9. tab bar hidden, decoration gone ═══ */
{
  ok(/\n#navTabs \{ display: none !important; \}/.test(html.slice(0, html.indexOf('</head>'))), '9 the bottom tab bar is hidden at every width (top-level rule, not only the ≥900px one)');
  ok(/@media \(max-width: 899px\) \{[\s\S]{0,900}\.header-actions \{ display: none !important; \}[\s\S]{0,200}\.cs-hdr-btn \{ display: inline-flex; \}/.test(html), '9 under 900px (phones AND 601–899 tablets): ☰ + pencil, header icons move to the drawer');
  ok(/@media \(min-width: 900px\) \{ \.csd-wrap \{ display: none !important; \} \}/.test(html) && /#desktopSidebar \{\s*display: flex;/.test(html), '9 desktop keeps the sidebar, no drawer');
  ok(!/<img class="empty-shrimp"/.test(grab('renderEmptyState')), '9 empty states: no mascot image');
  ok(!/DS_ICONS\.shrimp/.test(grab('buildDesktopSidebar')), '9 desktop sidebar: no mascot mark');
  ok(!/al-banner-anim|ai-learns-anim/.test(between('<div class="main-views" id="mainViews">', '<form class="cs-composer"')), '9 Ideas + Remix banners: decorative emoji animation removed');
  ok(!/🔒/.test(grab('applyFeatureLocks') + grab('showLockedToast') + grab('renderNavWithLocks')), '9 the 🔒 emoji is a plain lock icon');
  ok(!/\\u2713|\\u2717|✓/.test(grab('renderFilmingQueue') + between("const _fresh = day === '__fresh__';", 'grouped[day].forEach')), '9 tick/cross characters on main-screen buttons are gone');
}

/* ═══ 10. drawer above the install banner ═══ */
{
  // the highest z-index any rule for exactly this selector sets (null = none)
  const zOf = (src, sel) => { const zs = [...src.matchAll(new RegExp('(?:^|\\n|\\})\\s*' + sel.replace(/[.#-]/g, c => '\\' + c) + '\\s*\\{([^}]*)\\}', 'g'))].map(m => /z-index:\s*(\d+)/.exec(m[1])).filter(Boolean).map(z => +z[1]); return zs.length ? Math.max(...zs) : null; };
  const pwa = zOf(html, '.pwa-banner'), csd = zOf(html, '.csd-wrap'), tour = /\.tour-overlay\{[^}]*z-index:(\d+)/.exec(html);
  ok(pwa != null && csd != null && csd > pwa, '10 the drawer (z ' + csd + ') sits above the install banner (z ' + pwa + ')');
  ok(tour && csd < +tour[1], '10 …and below the guided tour (z ' + (tour && tour[1]) + ')');
  ok(/\.csd-backdrop \{ position: absolute; inset: 0;/.test(html) && /\.csd-panel \{ position: absolute;/.test(html), '10 backdrop and panel live inside that layer');
  let cc = ''; try { cc = fs.readFileSync(path.join(ROOT, 'clean.css'), 'utf8'); } catch (e) {}
  const ccPwa = [...cc.matchAll(/\.pwa-banner\s*\{([^}]*)\}/g)].map(m => /z-index:\s*(\d+)/.exec(m[1])).filter(Boolean).map(m => +m[1]);
  const ccCsd = [...cc.matchAll(/\.csd-wrap\s*\{([^}]*)\}/g)].map(m => /z-index:\s*(\d+)/.exec(m[1])).filter(Boolean).map(m => +m[1]);
  ok(ccPwa.every(z => z < csd) && ccCsd.every(z => z > pwa), '10 clean.css does not reorder them');
}

/* ═══ 11. guided tour targets ═══ */
{
  const steps = between('const TOUR_STEPS = [', '\n];');
  const mkTour = (w, present) => {
    const tt = { innerHTML: '', style: {}, offsetHeight: 0 }, hl = { style: {} };
    const els = {};
    for (const [sel, vis] of Object.entries(present)) els[sel] = { getBoundingClientRect: () => vis ? { top: 6, left: 6, bottom: 50, right: 50, width: 44, height: 44 } : { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 } };
    let ended = 0;
    const c = { window: { innerWidth: w, innerHeight: 812, scrollY: 0 }, document: { querySelector: sel => els[sel] || null },
      tourOverlay: { querySelector: s => s === '.tour-highlight' ? hl : tt }, endTour: () => { ended++; }, Math };
    vm.createContext(c);
    vm.runInContext(steps + '\n;\nvar tourStep = 0;\n' + grab('tourTargetSel') + '\n' + grab('tourTargetEl') + '\n' + grab('tourVisibleSteps') + '\n' + grab('showTourStep') + '\nthis.TOUR_STEPS = TOUR_STEPS;', c);
    return { c, tt, ended: () => ended };
  };
  const PHONE = { '#csMenuBtn': true, '#csNewBtn': true, '#navTabs': false, '.nav-tab:nth-child(1)': false, '.nav-tab:nth-child(2)': false, '.nav-tab:nth-child(3)': false, '.nav-tab:nth-child(4)': false, '.header-actions': false };
  for (const w of [375, 768]) {
    const t = mkTour(w, PHONE);
    const vis = t.c.tourVisibleSteps();
    ok(vis.map(s => t.c.tourTargetSel(s)).join() === '#csMenuBtn,#csNewBtn,#csMenuBtn', '11 at ' + w + 'px the tour points at ☰ / pencil / ☰ (' + vis.map(s => s.title).join(' · ') + ')');
    ok(t.c.TOUR_STEPS.every(s => { const sel = t.c.tourTargetSel(s); return !sel || !/nav-tab|navTabs|header-actions/.test(sel); }), '11 at ' + w + 'px no step targets the hidden tab bar or header icons');
    t.c.showTourStep();
    ok(/Step 1 of 3/.test(t.tt.innerHTML) && /every screen is in this menu/.test(t.tt.innerHTML) && t.ended() === 0, '11 at ' + w + 'px step 1 of 3 shows the phone wording');
  }
  const noPencil = mkTour(375, Object.assign({}, PHONE, { '#csNewBtn': false }));
  ok(noPencil.c.tourVisibleSteps().every(s => s.title !== 'Quick Post'), '11 a step whose target is not on screen is skipped');
  const none = mkTour(375, {});
  none.c.showTourStep();
  ok(none.ended() === 1 && none.tt.innerHTML === '', '11 nothing to point at → the tour ends instead of pointing at nothing');
  const desk = mkTour(1280, { '#desktopSidebar': true, '#desktopSidebar .ds-item[data-view="today"]': true, '#desktopSidebar .ds-item[data-view="ideas"]': true, '#desktopSidebar .ds-item[data-view="pipeline"]': true, '#desktopSidebar .ds-item[data-view="create"]': true, '#desktopSidebar .ds-bottom': true, '.header-actions': false, '#navTabs': false });
  ok(desk.c.tourVisibleSteps().length === 6, '11 at 1280px all 6 steps point at the desktop sidebar (v701: the header icons moved there)');
}

/* ═══ 12. Ideas first ═══ */
{
  const x = makeCtx(true);
  const head = x.d.els.csIdeasHead, view = x.d.els['view-ideas'];
  x.c.getPendingIdeas = () => [{}, {}, {}];
  x.c.csIdeasHeadSync();
  ok(head.hidden === false && /<h1 class="cs-ih-title">3 ideas ready<\/h1>/.test(head.innerHTML) && /Pick the ones you’d post\. Skip the rest\./.test(head.innerHTML), '12 pending ideas → "3 ideas ready" + the one-line hint');
  ok(/<button type="button" class="cs-pill-btn" id="csPlanToggle" aria-controls="ideasQuick" aria-expanded="false" onclick="csPlanToggle\(\)">Plan my week<\/button>/.test(head.innerHTML), '12 a "Plan my week" pill on the heading\'s right');
  ok(view.classList.contains('cs-plan-folded') && view.classList.contains('cs-ideas-has'), '12 the plan card is folded while ideas are waiting');
  x.c.csPlanToggle();
  ok(!view.classList.contains('cs-plan-folded') && /aria-expanded="true"/.test(head.innerHTML), '12 the pill unfolds the same card in place');
  x.c.csPlanToggle();
  ok(view.classList.contains('cs-plan-folded'), '12 …and folds it again');
  x.c.getPendingIdeas = () => [{}];
  x.c.csIdeasHeadSync();
  ok(/>1 idea ready</.test(head.innerHTML), '12 singular: "1 idea ready"');
  x.c.getPendingIdeas = () => [];
  x.c.csIdeasHeadSync();
  ok(head.hidden === true && !view.classList.contains('cs-plan-folded') && !view.classList.contains('cs-ideas-has'), '12 0 pending → no heading, the full Plan my week card');
  ok(/#view-ideas\.cs-plan-folded #ideasQuick, #view-ideas\.cs-plan-folded #ideasManualPanel \{ display: none !important; \}/.test(html), '12 folding hides the card (and its tweak panel), never removes it');
  ok(/\.cs-ih-title \{ margin: 0; font-size: 26px; font-weight: 600; letter-spacing: -0\.02em;/.test(html), '12 heading is 26/600');
  const ideasMarkup = between('<div class="view" id="view-ideas">', '<div id="ideaContent"></div>');
  const hi = ideasMarkup.indexOf('<div class="cs-ideas-head" id="csIdeasHead" hidden></div>'), qi = ideasMarkup.indexOf('<div id="ideasQuick"'), fi = ideasMarkup.indexOf('onclick="toggleFilters(this)"');
  ok(hi > 0 && hi < qi && qi < fi, '12 order: heading → (folded) plan card → Filters → cards');
  ok(/id="ideasQuickBtn" onclick="ideasQuickGo\(this\)"/.test(ideasMarkup) && /<div id="ideasMixSlot"><\/div>/.test(ideasMarkup), '12 the plan card keeps its ids and functions');
  // every renderIdeas refreshes the heading
  const y = makeCtx(true); let origRan = 0;
  y.c.getPendingIdeas = () => [{}, {}];
  const yc = Object.assign({}, y.c); vm.createContext(yc);
  yc.window = { renderIdeas: () => { origRan++; } };
  vm.runInContext(shell, yc);
  yc.window.renderIdeas();
  ok(origRan === 1 && /2 ideas ready/.test(y.d.els.csIdeasHead.innerHTML), '12 renderIdeas still runs and then refreshes the heading');
}

/* ═══ 13. FAQ at the bottom ═══ */
{
  const kids = []; let inserted = 0;
  const el = { querySelector: () => null, appendChild: k => { kids.push(k); return k; }, insertBefore: (k) => { inserted++; kids.unshift(k); return k; }, firstChild: null };
  const c = { document: { getElementById: () => ({}), createElement: () => ({ className: '', innerHTML: '' }), head: { appendChild() {} } },
    FN_FAQ: { ideas: [{ q: 'Q one?', a: 'A one.' }] }, FN_FAQ_TITLE: { ideas: 'Ideas' }, escHtml: t => String(t) };
  vm.createContext(c); vm.runInContext(grab('renderFnFaq'), c);
  c.renderFnFaq('ideas', el);
  ok(kids.length === 1 && inserted === 0, '13 the FAQ is appended at the bottom of the screen, not inserted at the top');
  const w = kids[0] || { innerHTML: '' };
  ok(/<details class="fn-faq-box cs-faq-link"><summary>How this works/.test(w.innerHTML) && !/FAQ — about/.test(w.innerHTML), '13 it reads "How this works"');
  ok(/Q one\?/.test(w.innerHTML) && /A one\./.test(w.innerHTML), '13 …and opens the same Q&A');
  ok(/#mainViews \.fn-faq \.fn-faq-box\.cs-faq-link > summary \{[^}]*font-size: 13px;[^}]*color: var\(--cs-muted\)/.test(html), '13 small and muted');
}

/* ═══ 14. floating shrimp off by default ═══ */
{
  ok(/var CS_MASCOT_DEFAULT_ON = false;/.test(html), '14 CS_MASCOT_DEFAULT_ON is false');
  const run = saved => { const st = saved == null ? {} : { 'mascot-hidden': saved }; const c = { localStorage: { getItem: k => (k in st ? st[k] : null) } };
    vm.createContext(c); vm.runInContext(between('var CS_MASCOT_DEFAULT_ON', ';') + '\n' + grab('csMascotHidden'), c); return c.csMascotHidden(); };
  ok(run(null) === true, '14 no saved choice → hidden');
  ok(run('0') === false && run('1') === true, '14 a saved choice wins (on stays on, off stays off)');
  ok(/if \(csMascotHidden\(\)\) \{[^\n]*\n\s*setTimeout\(function\(\)\{ const w = document\.getElementById\('mascotWrap'\); if \(w\) w\.style\.display = 'none'; \}, 0\);/.test(html), '14 on load the wrap is hidden by the same rule');
  ok(/<input type="checkbox" \$\{csMascotHidden\(\)\?'':'checked'\} onchange="setMascotVisible\(this\.checked\)">/.test(html) && /window\.setMascotVisible = function\(on\) \{\n\s*localStorage\.setItem\('mascot-hidden', on \? '0' : '1'\);/.test(html), '14 the Settings switch shows the real state and still saves the choice');
}

/* ═══ 15. review fixes ═══ */
// (a) clean.css freshness in the service worker — driven, not grepped
await (async () => {
  const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const BUILD = (/const BUILD = '([^']+)'/.exec(swSrc) || [])[1];
  const mk = (fetchImpl) => {
    const store = new Map(), listeners = {}, net = [];
    const cache = { put: async (k, v) => { store.set(String(k), v); }, match: async k => store.get(String(k)), delete: async k => store.delete(String(k)) };
    const sb = { self: { addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); }, skipWaiting() {}, clients: { claim: async () => {}, matchAll: async () => [] }, registration: { showNotification: async () => {} } },
      caches: { open: async () => cache, match: async k => store.get(String(k)), keys: async () => [], delete: async () => true },
      fetch: async (u, o) => { net.push(String(u)); return fetchImpl(String(u)); }, Response, URL, console, Promise, Map, Set, JSON };
    sb.clients = sb.self.clients; sb.globalThis = sb;
    vm.runInNewContext(swSrc, sb);
    const fire = async (type, ev) => { let p = null; const e = Object.assign({ waitUntil: x => { p = x; }, respondWith: x => { p = x; } }, ev); listeners[type][0](e); return p ? await p : undefined; };
    return { store, net, fire };
  };
  const ok200 = body => async u => new Response(body + ':' + u, { status: 200 });
  let w = mk(ok200('v2'));
  await w.fire('install', {});
  ok(w.store.has('/clean.css') && w.store.get('/__cs_css_build') && (await w.store.get('/__cs_css_build').clone().text()) === BUILD, '15 install caches /clean.css and marks it with this BUILD');
  w = mk(async u => u === '/clean.css' ? new Response('nope', { status: 404 }) : new Response('ok', { status: 200 }));
  let threw = false; try { await w.fire('install', {}); } catch (e) { threw = true; }
  ok(!threw && w.store.has('/app.html') && !w.store.has('/__cs_css_build'), '15 a clean.css 404 never fails install, and leaves no mark');
  // served from cache only when the mark matches this BUILD
  w = mk(ok200('fresh'));
  await w.store.set('/clean.css', new Response('old-css')); await w.store.set('/__cs_css_build', new Response(BUILD));
  let r = await w.fire('fetch', { request: { method: 'GET', url: 'https://contentshrimp.com/clean.css' } });
  ok(r && (await r.text()) === 'old-css' && !w.net.includes('/clean.css'), '15 cached clean.css for THIS build → served from cache, no network');
  w = mk(ok200('fresh'));
  await w.store.set('/clean.css', new Response('old-css')); await w.store.set('/__cs_css_build', new Response('v1-old'));
  r = await w.fire('fetch', { request: { method: 'GET', url: 'https://contentshrimp.com/clean.css' } });
  ok(r && /^fresh:/.test(await r.text()) && w.net.includes('/clean.css') && (await w.store.get('/__cs_css_build').clone().text()) === BUILD, '15 cached clean.css from an OLDER build → fetched fresh, cached, re-marked');
  w = mk(async () => { throw new Error('offline'); });
  await w.store.set('/clean.css', new Response('old-css')); await w.store.set('/__cs_css_build', new Response('v1-old'));
  r = await w.fire('fetch', { request: { method: 'GET', url: 'https://contentshrimp.com/clean.css' } });
  ok(r && (await r.text()) === 'old-css', '15 offline → the cached copy still serves');
})();
// (b) status-bar colour + manifest
{
  const headTop = html.slice(0, html.indexOf('<script>'));
  ok(/<meta name="theme-color" content="#212121">/.test(headTop), '15 the theme-color meta is dark and comes BEFORE the first script');
  const seg = between('var CS_DEFAULT_THEME', "if (_csTc) _csTc.content = csResolveTheme() === 'dark' ? '#212121' : '#ffffff'; } catch (e) {}");
  const run = (saved, old) => { const st = saved == null ? {} : { 'cs-theme': saved }; if (old != null) st['bn-dark-mode'] = old; const meta = { content: 'x' };
    const c = { window: {}, localStorage: { getItem: k => (k in st ? st[k] : null), removeItem: k => { delete st[k]; } }, document: { documentElement: { dataset: {} }, querySelector: q => (/theme-color/.test(q) ? meta : null) } };
    vm.createContext(c); vm.runInContext(seg, c); return meta.content; };
  ok(run(null) === '#212121' && run('light') === '#ffffff' && run('dark') === '#212121' && run(null, '0') === '#212121', '15 the early script sets it from the resolved theme (#212121 / #ffffff; an old bn-dark-mode=0 stays dark)');
  ok(/content = on \? '#212121' : '#ffffff';/.test(grab('toggleDarkMode')), '15 the Dark Mode switch keeps it in step');
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  ok(man.background_color === '#212121' && man.theme_color === '#212121', '15 manifest background_color + theme_color are #212121');
}
// (c) Assistant press-and-hold on the drawer row = the old tab's handlers
{
  const { c, d } = makeCtx(true);
  c.renderNavWithLocks();
  const oldTab = /<button class="nav-tab coach-tab"[^>]*>/.exec(d.els.navTabs.innerHTML)[0];
  const row = /<button type="button" class="csd-item" data-act="bvTabClick"[^>]*>/.exec(c.csDrawerHtml());
  const attrs = t => Object.fromEntries([...t.matchAll(/(on\w+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
  const A = attrs(oldTab), B = row ? attrs(row[0]) : {};
  ok(Object.keys(A).length === 5 && Object.entries(A).every(([k, v]) => B[k] && B[k].includes(v.replace(/\(\)$/, ''))), '15 the drawer Assistant row keeps every handler of the old tab (' + Object.keys(A).join(', ') + ')');
}
// (d) scroll lock + close at ≥900px
{
  ok(/body\.csd-open \{ overflow: hidden; overscroll-behavior: none; \}/.test(html) && /\.csd-backdrop \{ touch-action: none; \}/.test(html), '15 the page behind the open drawer cannot scroll');
  const x = makeCtx(true);
  x.c.csDrawerOpen();
  ok(x.d.els.csDrawerWrap.hidden === false && DOC.body.classList.contains('csd-open'), '15 open: body.csd-open is on');
  x.c.csDrawerClose();
  ok(!DOC.body.classList.contains('csd-open'), '15 closed: body.csd-open is off');
  // the ≥900px listener (a fresh context whose window has matchMedia)
  const d2 = freshDom(); ['csDrawerWrap', 'csDrawer', 'csMenuBtn'].forEach(d2.put); d2.els.csDrawerWrap.hidden = true;
  let mqFn = null, mqQ = '';
  const c2 = Object.assign({}, x.c, { document: DOC, window: { matchMedia: q => { mqQ = q; return { addEventListener: (t, f) => { if (t === 'change') mqFn = f; } }; } } });
  vm.createContext(c2); vm.runInContext(shell, c2);
  c2.csDrawerOpen();
  ok(typeof mqFn === 'function' && mqQ === '(min-width: 900px)', '15 a (min-width: 900px) listener is registered');
  if (mqFn) mqFn({ matches: true });
  ok(d2.els.csDrawerWrap.hidden === true && d2.els.csMenuBtn.attrs['aria-expanded'] === 'false' && !DOC.body.classList.contains('csd-open'), '15 crossing to ≥900px closes it (state, aria-expanded, body class)');
}
// (e) Plan my week run from 0 pending keeps the card (and its success line) open
{
  const x = makeCtx(true); const view = x.d.els['view-ideas'];
  x.c.getPendingIdeas = () => []; x.c.csIdeasHeadSync();
  x.c.getPendingIdeas = () => [{}, {}, {}, {}, {}, {}, {}]; x.c.csIdeasHeadSync();
  ok(!view.classList.contains('cs-plan-folded') && /aria-expanded="true"/.test(x.d.els.csIdeasHead.innerHTML), '15 0 → 7 pending: the card stays open with its "Added N ideas" line');
  x.c.csPlanToggle();
  ok(view.classList.contains('cs-plan-folded'), '15 …until the pill folds it');
  const y = makeCtx(true); y.c.getPendingIdeas = () => [{}, {}]; y.c.csIdeasHeadSync();
  ok(y.d.els['view-ideas'].classList.contains('cs-plan-folded'), '15 opening with ideas already waiting still starts folded');
}

finished = true;
if (fail) { console.log(`\n${fail} FAILED`); process.exit(1); }
console.log('\nCLEAN SHELL OK');
