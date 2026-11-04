#!/usr/bin/env node
// GATE (v712, owner 2026-11-04: Remix is the main attraction — "the easiest to explain and to use").
// EXECUTED: the real functions lifted from app.html run in node:vm against stubs.
//   1  the default start screen is Remix: CS_START_VIEW = 'create'; csStartView() gives Remix for a plain open,
//      Ideas for the morning push (?open=ideas, or one sw.js posted before the app was ready) and Ideas while
//      Remix is still locked (brand minimum not met). initApp opens csStartView(), then the deep link runs.
//   2  Remix is the FIRST item in the desktop sidebar, the phone drawer, the command palette and both tab-bar
//      builders; every other screen keeps its old order. The visible name comes from ONE constant, CS_REMIX_NAME
//      (menus, page title, desktop toolbar title).
//   3  onboarding step 4 "Who do you follow on TikTok?": @handles and profile links become
//      https://www.tiktok.com/@name (lowercase, deduped); other sites, share links that name nobody and bare words
//      are refused with ONE plain line; more than 5 is refused; Skip goes on with nothing; the creators are saved
//      through the bookmark path (the "__bookmarks__" row, saveBookmarksToDB) under the ONE 5-creator rule.
//   4  the ending depends on step 4: creators saved → obFinish saves them FIRST, then lands on Remix (switchView('create')
//      → the feed's cfOpen sees them), nothing generated; skipped (or nothing saved) → the pre-v712 ending, unchanged
//      (Quick Post + the first post), so a new user never lands on an empty feed. The last step's words follow suit.
//      A brand created a moment ago gets its list saves armed.
//   5  humanErr maps daily_read_limit and fallback_limit; Remix Step 1 and the feed's transcript tap show those
//      words (never the server's raw sentence or the code) and open the "paste the words yourself" card.
//   6  no client copy says reading a link costs credits (a detector with its own positive control), and the
//      Remix FAQ says reading a TikTok link is free.
//   7  a returning user with no TikTok creators: Remix asks the server nothing and the feed is ONE non-wrapping line
//      ("Add one") above Step 1's paste box.
// RUN: node scripts/verify/remix-first-v712.mjs      EXPECT: prints "REMIX FIRST OK", exit 0.
import fs from 'node:fs'; import vm from 'node:vm';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
setTimeout(() => { console.log('FAIL: wall clock (60s) exceeded'); process.exit(2); }, 60000).unref();
let finished = false; process.on('exit', (code) => { if (!finished && code === 0) { console.log('FAIL: the gate ended before all checks ran'); process.exitCode = 1; } });
let fail = 0; const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('ok:', m); };
const J = v => JSON.stringify(v);
const grab = n => {
  let i = html.indexOf('\nfunction ' + n + '('); if (i < 0) i = html.indexOf('\nasync function ' + n + '(');
  if (i < 0) throw new Error('no ' + n + ' in app.html');
  const eol = html.indexOf('\n', i + 1), first = html.slice(i + 1, eol);
  let d = 0, seen = false; for (const ch of first) { if (ch === '{') { d++; seen = true; } else if (ch === '}') d--; }
  if (seen && d === 0) return first;
  return html.slice(i + 1, html.indexOf('\n}', i) + 2);
};
const line = re => { const m = re.exec(html); if (!m) throw new Error('line missing: ' + re); return m[0]; };
const between = (a, b) => { const i = html.indexOf(a); const j = html.indexOf(b, i + a.length); if (i < 0 || j < 0) throw new Error('marker missing: ' + a.slice(0, 50)); return html.slice(i, j + b.length); };
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const BASE = () => ({ console: { log() {}, warn() {}, error() {}, info() {} }, JSON, Promise, Date, Math, String, Number, Array, Object, Set, Map, RegExp, Error, TypeError, isFinite, encodeURIComponent, URL });
const run = (c, ...srcs) => { vm.createContext(c); for (const s of srcs) vm.runInContext(s, c); return c; };
const NAME_JS = line(/\nvar CS_REMIX_NAME = '[^'\n]+';/);
const NAME = /'([^']+)'/.exec(NAME_JS)[1];
const START_JS = line(/\nvar CS_START_VIEW = '[^'\n]+';/);
const LOCK_JS = line(/\nvar CS_LOCKED_VIEWS = \[[^\]\n]*\];/);
const ORDER_REST = ['today', 'ideas', 'pipeline', 'idea', 'viral', 'notebook', 'questions'];   // v711 order, unchanged

/* ═══ 1. the start screen ═══ */
{
  const mk = (unlocked, pending) => run(Object.assign(BASE(), { location: { origin: 'https://contentshrimp.com' }, window: { _csPendingOpen: pending || null }, isBrandMinimumMet: () => unlocked }),
    START_JS, NAME_JS, LOCK_JS, grab('csNavLocked'), grab('csReadOpen'), grab('csStartView'));
  const c = mk(true);
  ok(c.CS_START_VIEW === 'create', '1 CS_START_VIEW is Remix (\'create\', the real view id: #view-create)');
  ok(/<div class="view" id="view-create">/.test(html), '1 the Remix view really is #view-create');
  ok(c.csStartView('https://contentshrimp.com/app.html') === 'create', '1 a plain open lands on Remix');
  ok(c.csStartView('https://contentshrimp.com/app.html?open=ideas&b=abc') === 'ideas' && c.csStartView('/app.html?open=idea&t=x') === 'ideas', '1 the morning push link still opens Ideas (no Remix feed load first)');
  ok(mk(true, { brand: 'b1' }).csStartView('/app.html') === 'ideas', '1 a push posted by sw.js before the app was ready still opens Ideas');
  ok(mk(false).csStartView('/app.html') === 'ideas', '1 while Remix is locked (brand minimum not met) the app opens Ideas, never a locked screen');
  const init = grab('initApp');
  const sv = init.indexOf('const _sv = csStartView(window.location.href);'), sw = init.indexOf('switchView(_sv);'), deep = init.indexOf('csHandleOpenIdeas(window.location.href, true)');
  ok(sv > 0 && sw > sv && init.indexOf('switchView(') === sw && deep > sw, '1 initApp\'s first switch is to csStartView(), and the ?open= handler runs after it (so a deep link still wins)');
}

/* ═══ 2. Remix first in every menu, one name constant ═══ */
{
  let built = null;
  const c = run(Object.assign(BASE(), { window: { APP_VERSION: 'vT' }, escHtml: s => String(s), DS_ICONS: {}, syncDesktopNav() {}, renderUsagePill() {},
    document: { getElementById: () => null, querySelector: () => ({ textContent: 'Acme' }), createElement: () => ({ innerHTML: '' }), body: { appendChild: e => { built = e; } } } }),
    NAME_JS, between('var CS_DRAWER_ICONS = {', '\n};'), grab('_dsItem'), grab('buildDesktopSidebar'));
  c.buildDesktopSidebar();
  const sb = built ? built.innerHTML : '';
  const sbViews = [...sb.matchAll(/class="ds-item" data-view="(\w+)"/g)].map(m => m[1]);
  ok(sbViews[0] === 'create' && new RegExp('data-view="create"[^>]*>[^<]*(<svg[\\s\\S]*?</svg>)?<span>' + NAME + '</span>').test(sb), '2 desktop sidebar: Remix is the first screen, labelled from CS_REMIX_NAME (' + sbViews.join(',') + ')');
  ok(J(sbViews.slice(1)) === J(ORDER_REST), '2 desktop sidebar: everything else keeps its order');

  const d = run(Object.assign(BASE(), { DS_ICONS: {}, isBrandMinimumMet: () => true, csShelved: () => false, activeView: 'create', getPendingIdeas: () => [], state: [], remixes: [], notebookNotes: [], window: { APP_VERSION: 'vT' } }),
    NAME_JS, between('var CS_DRAWER_ICONS = {', '\n};'), LOCK_JS, grab('csNavLocked'), between('var CS_DRAWER_GROUPS = [', '\n];'), grab('csDrawerCounts'), grab('csDrawerHtml'));
  const dh = d.csDrawerHtml();
  const drViews = [...dh.matchAll(/class="csd-item[^"]*" data-view="(\w+)"/g)].map(m => m[1]);
  ok(drViews[0] === 'create' && new RegExp('data-view="create"[^>]*>(<svg[\\s\\S]*?</svg>)?<span class="csd-label">' + NAME + '</span>').test(dh), '2 phone drawer: Remix is the first row, labelled from CS_REMIX_NAME (' + drViews.join(',') + ')');
  ok(J(drViews.slice(1)) === J(ORDER_REST), '2 phone drawer: everything else keeps its order');
  const dl = run(Object.assign(BASE(), { DS_ICONS: {}, isBrandMinimumMet: () => false, csShelved: () => false, activeView: 'ideas', getPendingIdeas: () => [], state: [], remixes: [], notebookNotes: [], window: {} }),
    NAME_JS, between('var CS_DRAWER_ICONS = {', '\n};'), LOCK_JS, grab('csNavLocked'), between('var CS_DRAWER_GROUPS = [', '\n];'), grab('csDrawerCounts'), grab('csDrawerHtml')).csDrawerHtml();
  ok(/^[\s\S]*?class="csd-item locked" data-view="create"/.test(dl) && dl.indexOf('data-view="create"') < dl.indexOf('data-view="today"'), '2 phone drawer: a locked Remix is still the first row (with its lock)');

  const JS_A = '/* ===== v703 DESKTOP-NATIVE STRUCTURE (D2)', JS_B = '/* ===== end v703 desktop-native structure ===== */';
  const csx = html.slice(html.indexOf(JS_A), html.indexOf(JS_B));
  const stubDoc = { readyState: 'loading', addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    body: { children: [], getAttribute: () => null, hasAttribute: () => false, setAttribute() {}, removeAttribute() {}, appendChild() {} }, documentElement: { getAttribute: () => 'dark' }, activeElement: null };
  const p = Object.assign(BASE(), { Boolean, navigator: { platform: 'MacIntel', userAgent: '' }, matchMedia: () => ({ matches: true }), innerWidth: 1440, requestAnimationFrame: f => f(),
    escHtml: s => String(s), document: stubDoc, allBrands: [{ id: 'b1', brand_name: 'A' }, { id: 'b2', brand_name: 'B' }], currentBrand: { id: 'b1' }, csShelved: () => false });
  p.window = p; run(p, NAME_JS + '\n' + csx);
  const items = p.csxPaletteItems();
  ok(items[0] && items[0].label === NAME && J(items[0].call) === J(['switchView', 'create']), '2 command palette: Remix is the first item (' + (items[0] && items[0].label) + ')');
  const go = items.filter(i => i.call[0] === 'switchView').map(i => i.call[1]);
  ok(J(go) === J(['create'].concat(ORDER_REST)), '2 command palette: the other screens keep their order');
  const groups = items.map(i => i.g).filter((g, i, a) => i === 0 || a[i - 1] !== g);
  ok(J(groups) === J(['Go to', 'Switch brand', 'Actions']) && items.some(i => i.label === 'New post' && i.kbd === 'N'), '2 command palette: one heading per group, "New post" (N) kept, now leading Actions');
  ok(p.CSX_TITLES.create === NAME, '2 desktop toolbar title = CS_REMIX_NAME');

  for (const fn of ['renderNavWithLocks', 'renderNav']) {
    const el = { innerHTML: '' };
    const t = run(Object.assign(BASE(), { isBrandMinimumMet: () => true, getPendingIdeas: () => [], state: [], remixes: [], notebookNotes: [], activeView: 'create', csShelved: () => false, window: { innerWidth: 400 },
      document: { getElementById: id => id === 'navTabs' ? el : null, querySelectorAll: () => [] } }), NAME_JS, grab(fn));
    t[fn]();
    const tabs = [...el.innerHTML.matchAll(/data-tab="(\w+)"/g)].map(m => m[1]);
    ok(tabs[0] === 'create' && J(tabs.slice(1, 5)) === J(['today', 'ideas', 'pipeline', 'notebook']) && el.innerHTML.includes('</span>' + NAME), '2 tab bar (' + fn + '): Remix first, the rest in order (' + tabs.join(',') + ')');
  }
  ok(/var CS_PAGE_TITLES = \{[^}]*create: CS_REMIX_NAME/.test(html) && /function csShellSync\(view\)\{[\s\S]*?CS_PAGE_TITLES\[view\]/.test(html), '2 the screen heading (#csPageTitle) reads CS_REMIX_NAME');
  const vis = (html.match(/['">]Remix['<]/g) || []).length;
  ok(!/_dsItem\('create','Remix'\)|\{ view: 'create', label: 'Remix' \}|\['create', 'Remix'\]|id:"create",label:"Remix"|create: 'Remix', idea/.test(html), '2 no menu, page title or toolbar title spells "Remix" out any more (' + vis + ' other visible ones wait for the rename pass)');
  // (.unlazy/rename/remix-strings.md lists every other visible "Remix" for the rename pass; .unlazy is not in mutation copies, so not checked here)
}

/* ═══ 3 + 4. onboarding step 4 and the finish ═══ */
const OB_SRC = [NAME_JS, START_JS, LOCK_JS, line(/\nconst CF_MAX_CREATORS = \d+;/).replace('const', 'var'), line(/\nconst CF_MAX_MSG = [^\n]+;/).replace('const', 'var'),
  'var obPendingCreators = [], obSelectedTones = ["a","b"], obCommunities = ["x","y"], obCurrentStep = 3;',
  ...['obCreatorUrl', 'obParseCreators', 'obSkipCreators', 'obNext', 'obSaveCreators', 'obFinish', 'cfTtLink', 'cfCreatorTtLink', 'cfFollowedHandles', 'cfAllowLinks',
    'fpNameFromLink', 'bmId', 'saveBookmarksToDB', '_listLoaded', '_markListLoad', '_warnSaveFailed', 'csStartView', 'csReadOpen', 'csNavLocked', 'switchView'].map(grab)];
function obWorld(o = {}) {
  const els = {}, log = [], writes = [];
  const el = id => els[id] || (els[id] = { id, value: '', textContent: '', style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, focus() {}, scrollIntoView() {} });
  const c = Object.assign(BASE(), {
    window: {}, location: { origin: 'https://contentshrimp.com' }, setTimeout: () => 0,
    document: { getElementById: el, querySelectorAll: () => [], querySelector: () => null },
    currentBrand: o.brand || null, currentUser: { id: 'u1' }, sb: {}, settings: {}, allBrands: [], bookmarkCategories: o.cats || [],
    _listLoadOk: Object.assign({ remixes: false, productRefs: false, bookmarks: false, promptHistory: false, notebook: false }, o.loaded || {}),
    obClearErr: id => { el(id).textContent = ''; el(id).style.display = 'none'; }, obShowErr: (id, m) => { el(id).textContent = m; el(id).style.display = 'block'; log.push(['err', m]); },
    obGoToStep: s => { c.obCurrentStep = s; log.push(['step', s]); }, obVoiceWords: () => 0,
    _replaceBrandRows: async (table, brandId, rows, opts) => { writes.push({ table, brandId, rows: JSON.parse(J(rows)), opts }); log.push(['write']); return o.saveFails ? { ok: false, error: new Error('offline') } : { ok: true }; },
    _warnListNotSaved: l => log.push(['notSaved', l]), showToast: m => log.push(['toast', m]), rerenderBookmarks: () => log.push(['rerender']),
    debugLog() {}, setHeaderBrand() {}, renderStats() {}, renderIdeaFilters() {}, renderIdeas() {}, spDraftFromSocial() {}, obReviewCrawlFindings() {}, obResetFinishBtn() {}, obShowWizard: () => log.push(['wizard']),
    saveBrandToDB: async () => { if (!c.currentBrand) c.currentBrand = { id: 'b-new' }; log.push(['brandSaved']); }, loadAllBrandsFromDB: async () => [], saveIdeasToDB: async () => {},
    generateTodayTabPost: async () => log.push(['GENERATED']), applyFeatureLocks() {}, maybeShowBrandVoicePopup() {}, isBrandMinimumMet: () => true,
    // switchView's neighbours (the real switchView runs)
    VIEW_ORDER: ['today', 'ideas', 'pipeline', 'create'], openDismissPopup: null, openApprovePopup: null, activeView: 'ideas', csShelved: () => false,
    renderNav() {}, syncDesktopNav() {}, csShellSync() {}, renderTodayView: () => log.push(['today']), renderFilmingQueue() {}, restoreProToolsState() {}, renderCreate() {}, renderFollowPanels() {}, renderRemixDelivery() {}, renderFnFaq() {},
    cfOpen: () => log.push(['cfOpen', J(c.bookmarkCategories)]),
  });
  run(c, ...OB_SRC);
  return { c, els, log, writes, el };
}
{
  const { c } = obWorld();
  const p = c.obParseCreators('@Khaby.Lame\n tiktok.com/@MrBeast/video/7312  \nhttps://www.tiktok.com/@zach_king?lang=en, @khaby.lame');
  ok(J(p.urls) === J(['https://www.tiktok.com/@khaby.lame', 'https://www.tiktok.com/@mrbeast', 'https://www.tiktok.com/@zach_king']) && !p.error, '3 @handles, profile links and video links become https://www.tiktok.com/@name (lowercase, deduped): ' + J(p.urls));
  for (const bad of ['instagram.com/khaby', 'https://vm.tiktok.com/ZMabc123/', 'khaby', 'https://www.tiktok.com/', 'javascript:alert(1)', '@']) {
    const r = c.obParseCreators('@ok_one\n' + bad);
    ok(r.urls.length === 0 && typeof r.error === 'string' && r.error.length < 140 && !/\n/.test(r.error) && r.error.includes(bad.slice(0, 20)) && /TikTok/.test(r.error), '3 refused with one plain line: ' + J(bad) + ' → ' + J(r.error));
  }
  const six = c.obParseCreators('@a1 @a2 @a3 @a4 @a5 @a6');
  ok(six.urls.length === 0 && /up to 5/.test(six.error), '3 a 6th creator is refused (' + six.error + ')');
  ok(c.obParseCreators('@a1 @a2 @a3 @a4 @a5 @A5').urls.length === 5, '3 exactly 5 (a repeat does not count twice) is fine');
}
{
  const w = obWorld(); w.el('obCreators').value = 'facebook.com/someone';
  w.c.obNext(4);
  ok(w.c.obCurrentStep === 3 && /isn.t a TikTok profile/.test(w.el('obStep4Err').textContent) && w.el('obStep4Err').style.display === 'block', '3 step 4 with non-TikTok input stays put and shows the line in #obStep4Err');
  w.el('obCreators').value = '@Alpha\ntiktok.com/@beta'; w.c.obNext(4);
  ok(w.c.obCurrentStep === 5 && J(vm.runInContext('obPendingCreators', w.c)) === J(['https://www.tiktok.com/@alpha', 'https://www.tiktok.com/@beta']) && w.el('obStep4Err').textContent === '', '3 valid input moves on to the last step and keeps the 2 profile links');
  w.c.obSkipCreators();
  ok(w.c.obCurrentStep === 5 && J(vm.runInContext('obPendingCreators', w.c)) === '[]', '3 Skip moves on with nothing pending');
  const step4 = between('<div class="onboarding-step" data-step="4">', '<div class="onboarding-step" data-step="5">');
  ok(/Who do you follow on TikTok\?/.test(step4) && /id="obCreators"/.test(step4) && /onclick="obNext\(4\)"/.test(step4) && /onclick="obSkipCreators\(\)"[^>]*>Skip for now</.test(step4) && /id="obStep4Err"/.test(step4), '3 the step is in the wizard between the voice memo (3) and the finish (5), with Skip');
  ok(/class="onboarding-step" data-step="3"[\s\S]*?obGoToStep\(4\)[\s\S]*?data-step="4"/.test(html) && /const OB_TOTAL_STEPS = 5;/.test(html) && /if\(step === 5\) \{ obBuildSummary\(\); obFinaleCopy\(\); \}/.test(html), '3 the voice memo\'s Skip lands on it; the wizard is 5 steps; the summary is on 5');
}
{
  // a brand created a moment ago: the list never loaded, but it is genuinely empty → armed, written, capped
  const w = obWorld({ brand: { id: 'b-new' } });
  const n = await w.c.obSaveCreators(['https://www.tiktok.com/@a1', 'https://www.tiktok.com/@a2', 'https://www.tiktok.com/@a3'], true);
  const wr = w.writes[0];
  const cats = wr ? JSON.parse(wr.rows[0].notes) : [];
  ok(n === 3 && w.writes.length === 1 && wr.table === 'competitors' && wr.brandId === 'b-new' && wr.rows[0].name === '__bookmarks__' && J(wr.opts) === J({ match: { name: '__bookmarks__' } }), '3 saved in ONE write to the brand\'s "__bookmarks__" row (saveBookmarksToDB)');
  ok(cats.length === 1 && cats[0].name === 'Following' && J(cats[0].entries.map(e => [e.name, e.links])) === J([['a1', { tt: 'https://www.tiktok.com/@a1' }], ['a2', { tt: 'https://www.tiktok.com/@a2' }], ['a3', { tt: 'https://www.tiktok.com/@a3' }]]), '3 the same entry shape as "+ Add creator": { name, links: { tt } } in a "Following" list');
  ok(J(w.c.cfFollowedHandles(null)) === J(['a1', 'a2', 'a3']), '3 the creator feed\'s own rule now counts them');
}
{
  // an existing brand already following 4: only one more fits (the ONE 5-creator rule, cfAllowLinks)
  const cats = [{ id: 'c1', name: 'Mine', entries: ['x1', 'x2', 'x3', 'x4'].map(h => ({ id: 'e' + h, name: h, links: { tt: 'https://www.tiktok.com/@' + h } })) }];
  const w = obWorld({ brand: { id: 'b1' }, cats, loaded: { bookmarks: true } });
  const n = await w.c.obSaveCreators(['https://www.tiktok.com/@x2', 'https://www.tiktok.com/@n1', 'https://www.tiktok.com/@n2'], false);
  const saved = JSON.parse(w.writes[0].rows[0].notes);
  ok(n === 1 && saved[0].entries.length === 5 && saved[0].entries[4].links.tt === 'https://www.tiktok.com/@n1' && w.c.cfFollowedHandles(null).length === 5, '3 never past 5: an already-followed one is skipped, the 6th is refused');
  const w2 = obWorld({ brand: { id: 'b1' }, cats: [], loaded: { bookmarks: false } });
  const n2 = await w2.c.obSaveCreators(['https://www.tiktok.com/@n1'], false);
  ok(n2 === 0 && w2.writes.length === 0, '3 an existing brand whose list never loaded is never overwritten');
}
{
  // the finish: creators saved FIRST, then Remix (its feed opens with them already in Bookmarks); nothing generated
  const w = obWorld();
  vm.runInContext('obPendingCreators = ["https://www.tiktok.com/@a1", "https://www.tiktok.com/@a2"]', w.c);
  await w.c.obFinish(); await tick();
  const kinds = w.log.map(x => x[0]);
  const wi = kinds.indexOf('write'), co = kinds.indexOf('cfOpen');
  ok(w.c.activeView === 'create', '4 onboarding ends on Remix (activeView ' + w.c.activeView + ')');
  ok(wi >= 0 && co > wi && /@a1/.test(w.log[co][1]) && /@a2/.test(w.log[co][1]), '4 the creators are written before Remix opens its feed (cfOpen sees them)');
  ok(!kinds.includes('GENERATED') && !kinds.includes('today'), '4 no Quick Post is generated or shown');
  ok(J(w.c._listLoadOk) === J({ remixes: true, productRefs: true, bookmarks: true, promptHistory: true, notebook: true }), '4 a brand created a moment ago gets its list saves armed (its first remix can be saved)');
  ok(J(vm.runInContext('obPendingCreators', w.c)) === '[]', '4 the pending list is cleared');
  ok(!w.log.some(x => x[0] === 'GENERATED'), '4 creators added: no first post is generated (the feed is the payoff)');
  // the save itself fails (offline): 0 creators reported, the toast says so, and the first-post ending runs
  const sf = obWorld({ saveFails: true }); vm.runInContext('obPendingCreators = ["https://www.tiktok.com/@a1"]', sf.c);
  const sfN = await (async () => { const t = obWorld({ brand: { id: 'b1' }, loaded: { bookmarks: true }, saveFails: true }); const n = await t.c.obSaveCreators(['https://www.tiktok.com/@a1'], false); return [n, t.log.some(x => x[0] === 'toast' && /Couldn't save your bookmarks/.test(x[1]))]; })();
  ok(sfN[0] === 0 && sfN[1], '4 a failed bookmark save returns 0 and keeps the "couldn\'t save" toast');
  await sf.c.obFinish(); await tick();
  ok(sf.c.activeView === 'today' && sf.log.some(x => x[0] === 'GENERATED') && !sf.log.some(x => x[0] === 'cfOpen'), '4 a failed creator save keeps the first-post ending (never an empty feed)');
  // re-entering onboarding (+ Add new brand) clears step 4: the pending list AND the box
  const re = obWorld(); re.el('obCreators').value = '@old_brand_creator'; re.el('obStep4Err').textContent = 'old error';
  run(re.c, 'var _ok = window; window._obKeysWired = true;', 'function obStopSteps(){} function obRenderToneCards(){} function obRenderExampleChips(){} function obRenderCommunityTags(){} function obRenderAllExampleChips(){}', grab('obShowWizard'));
  vm.runInContext('obPendingCreators = ["https://www.tiktok.com/@old"]', re.c);
  re.c.obShowWizard();
  ok(re.el('obCreators').value === '' && re.el('obStep4Err').textContent === '' && J(vm.runInContext('obPendingCreators', re.c)) === '[]', '4 re-entering onboarding clears the creators box, its error and the pending list');
  // Skipped → the pre-v712 ending, unchanged: Quick Post, then ONE first post is written; Remix's feed is never opened
  const s = obWorld(); await s.c.obFinish(); await tick();
  const sk = s.log.map(x => x[0]);
  ok(s.c.activeView === 'today' && sk.indexOf('today') >= 0 && sk.indexOf('GENERATED') > sk.indexOf('today') && !sk.includes('cfOpen') && s.writes.length === 0, '4 Skip: the old ending — Quick Post and the first post, never an empty feed (' + sk.filter(k => /today|GENERATED|cfOpen/.test(k)).join(',') + ')');
  // creators typed but nothing could be saved (e.g. an existing brand whose list never loaded) → also the old ending
  const nf = obWorld({ brand: { id: 'b1' } }); vm.runInContext('obPendingCreators = ["https://www.tiktok.com/@a1"]', nf.c);
  await nf.c.obFinish(); await tick();
  ok(nf.c.activeView === 'today' && nf.log.some(x => x[0] === 'GENERATED') && !nf.log.some(x => x[0] === 'cfOpen'), '4 creators that could not be saved: the old ending too (no empty feed)');
  // the last step says what will happen
  const fw = obWorld(); const fsub = fw.el('obFinaleSub'), fbtn = fw.el('obFinishBtn');
  run(fw.c, line(/\nconst OB_FINALE = \{[\s\S]*?\n\};/).replace('const', 'var'), grab('obFinaleMode'), grab('obFinaleCopy'));
  fw.c.obFinaleCopy();
  const postCopy = [fsub.textContent, fbtn.textContent];
  vm.runInContext('obPendingCreators = ["https://www.tiktok.com/@a1"]', fw.c); fw.c.obFinaleCopy();
  ok(/write your first post/.test(postCopy[0]) && postCopy[1] === 'Write my first post →' && /their newest videos/i.test(fsub.textContent) && fbtn.textContent === 'Show their videos →', '4 the last step says what comes next: first post (skipped) or their videos (added) — ' + J([postCopy[1], fbtn.textContent]));
  ok(/id="obFinishBtn"[^>]*>Write my first post &rarr;</.test(html), '4 the markup default is the old first-post ending');
}

/* ═══ 5. the two read limits ═══ */
{
  const c = run(BASE(), grab('humanErr'), grab('humanErrCode'));
  ok(c.humanErr('daily_read_limit') === "You've read today's limit of videos. Paste the words yourself, or try again tomorrow.", '5 humanErr: daily_read_limit');
  ok(c.humanErr('fallback_limit') === "We couldn't read this video right now. Paste the words yourself.", '5 humanErr: fallback_limit');
  ok(c.humanErrCode('daily_read_limit') === c.humanErr('daily_read_limit') && c.humanErrCode('made_up_code') === '' && c.humanErrCode('A sentence.') === '', '5 humanErrCode: words for a known code, else nothing');

  // Remix Step 1: a pasted TikTok link over the daily limit
  const els = { remixQuickIn: { value: 'https://www.tiktok.com/@bob/video/1' }, remixQuickStatus: { textContent: '', style: {} } };
  const shown = [];
  let reply = { status: 429, body: { error: "You've read 5 videos today, the daily limit on your plan. Paste the spoken words instead, or try again tomorrow.", code: 'daily_read_limit' } };
  const q = run(Object.assign(BASE(), { window: {}, document: { getElementById: id => els[id] || null }, showToast() {}, btnWork: () => () => {}, remixShowOriginal: o => shown.push(o),
    remixPickLink: raw => ({ kind: 'tiktok', url: raw }), fetch: async () => ({ ok: false, status: reply.status, text: async () => J(reply.body) }) }),
    'var _rxFetching = false, _rxBusy = "";', line(/\nconst RX_IG_MSG = [^\n]+;/), grab('humanErr'), grab('humanErrCode'), grab('csBrandRef'), grab('remixCreatorFromUrl'), grab('remixFetchWords'), grab('remixQuickGo'));
  await q.remixQuickGo({});
  ok(els.remixQuickStatus.textContent === c.humanErr('daily_read_limit'), '5 Remix Step 1 shows the daily-limit words (' + els.remixQuickStatus.textContent + ')');
  ok(shown.length === 1 && shown[0].failed === true && shown[0].text === '' && shown[0].kind === 'tiktok' && shown[0].creator === 'bob', '5 …and opens the empty "paste the words yourself" card for that video');
  reply = { status: 500, body: { error: 'We couldn\'t read this TikTok the quick way, and the backup reader is used up for today.', code: 'fallback_limit' } };
  shown.length = 0; await q.remixQuickGo({});
  ok(els.remixQuickStatus.textContent === c.humanErr('fallback_limit') && shown.length === 1 && shown[0].failed === true, '5 Remix Step 1: fallback_limit → its words + the paste card');
  ok(/'Or paste the words yourself/.test(grab('remixOrigRender')), '5 the failed card says "paste the words yourself"');

  // the feed's transcript tap
  const fshown = [];
  let freply = { status: 429, body: { error: 'server sentence', code: 'daily_read_limit' } };
  const f = run(Object.assign(BASE(), { window: {}, currentBrand: { id: 'b1' }, showToast() {}, cfRender() {}, remixShowOriginal: o => fshown.push(o),
    fetch: async () => ({ ok: freply.status === 200, status: freply.status, text: async () => J(freply.body) }) }),
    'var _rxFetching = false, _rxBusy = "", _cfRows = [], _cf = { brandId: "b1", status: "ready", data: { creators: [], videos: [] }, err: "", note: "", rowErr: {}, busy: "", seq: 0 };',
    line(/\nconst CF_PASTE_CODES = [^\n]+;/), ...['humanErr', 'humanErrCode', 'safeUrl', 'fpHttps', 'remixCreatorFromUrl', 'cfHandle', 'cfReady', 'cfSorted', 'cfCall', 'cfApply', 'cfBrandNow', 'cfFill', 'cfPasteCard', 'cfPick'].map(grab));
  vm.runInContext('_cfRows = [{ videoId: "v9", handle: "Cat", url: "https://www.tiktok.com/@cat/video/v9", transcriptStatus: "none", transcript: null, score: 3 }]', f);
  await f.cfPick(0);
  const rowErr = vm.runInContext('_cf.rowErr.v9', f);
  ok(rowErr === c.humanErr('daily_read_limit') && !/daily_read_limit|server sentence/.test(rowErr), '5 the feed tap shows the daily-limit words on the row (' + rowErr + ')');
  ok(fshown.length === 1 && fshown[0].failed === true && fshown[0].text === '' && fshown[0].url === 'https://www.tiktok.com/@cat/video/v9' && fshown[0].creator === 'cat', '5 …and opens the paste card for that video');
  freply = { status: 500, body: { error: 'x', code: 'fallback_limit' } }; fshown.length = 0; vm.runInContext('_cf.rowErr = {}', f);
  await f.cfPick(0);
  ok(vm.runInContext('_cf.rowErr.v9', f) === c.humanErr('fallback_limit') && fshown.length === 1, '5 the feed tap: fallback_limit → its words + the paste card');
  freply = { status: 502, body: { error: 'transcribe_failed', code: 'transcribe_failed' } }; fshown.length = 0;
  await f.cfPick(0);
  ok(fshown.length === 0, '5 a one-off failure keeps "try again" on the row (no card)');
}

/* ═══ 5b. every link read names the brand (one shared daily pool per brand); uploads do not ═══ */
{
  const bodies = [];
  const c = run(Object.assign(BASE(), { window: {}, currentBrand: { id: 'brand-9' }, fetch: async (u, init) => { bodies.push([u, JSON.parse(init.body)]); return { ok: true, status: 200, text: async () => J({ transcript: 'w', text: 'w' }) }; } }),
    grab('humanErr'), grab('humanErrCode'), grab('csBrandRef'), grab('remixFetchWords'));
  await c.remixFetchWords('tiktok', 'https://www.tiktok.com/@a/video/1'); await c.remixFetchWords('youtube', 'https://youtu.be/x');
  ok(J(bodies) === J([['/api/transcribe-url', { url: 'https://www.tiktok.com/@a/video/1', brandId: 'brand-9' }], ['/api/transcribe', { url: 'https://youtu.be/x', mode: 'youtube', brandId: 'brand-9' }]]), '5b Remix Step 1 sends brandId with a TikTok and a YouTube read: ' + J(bodies));
  vm.runInContext('currentBrand = null', c);
  ok(J(c.csBrandRef()) === '{}', '5b no brand → no brandId (the server falls back to the user)');
  // every fetch to /api/transcribe(-url) in app.html: URL reads carry csBrandRef(), the file upload does not
  const sites = [...html.matchAll(/fetch\(([^,]*'\/api\/transcribe(?:-url)?'[^,]*),[\s\S]{0,260}?body:\s*JSON\.stringify\(([^\n]*)\)/g)].map(m => m[2]);
  const urlReads = sites.filter(b => /\burl\b/.test(b)), uploads = sites.filter(b => !/\burl\b/.test(b));
  ok(urlReads.length >= 8 && urlReads.every(b => /csBrandRef\(\)/.test(b)), '5b all ' + urlReads.length + ' link reads (Remix, Step 1, manual Remix, Trends, Idea Catcher) send brandId');
  ok(uploads.length === 1 && /payload/.test(uploads[0]) && !/csBrandRef/.test(uploads[0]), '5b the uploaded-file transcription does not');
}

/* ═══ 6. no copy says reading a link costs credits ═══ */
{
  // every visible-ish string: quoted literals and HTML text, comments removed
  const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--[\s\S]*?-->/g, ' ').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  const strings = src => {
    const out = [];
    for (const m of strip(src).matchAll(/'((?:[^'\\\n]|\\.){6,})'|"((?:[^"\\\n]|\\.){6,})"|`((?:[^`\\\n]|\\.){6,})`|>([^<>\n]{6,})</g)) out.push(m[1] || m[2] || m[3] || m[4]);
    return out;
  };
  const READ = /\b(reading|read (a|the|this|that|your|each|every) (link|video|tiktok)|links?|transcri\w*|the words|captions?)\b/i;
  const COST = /\b(credits?|charged?|charges|costs? (a|one|1|2|\d+)|uses? (a|one|1|2) (credit|post))\b/i;
  const FREE = /\b(free|costs? nothing|no credits?|never charged|not charged|nothing (is )?charged|costs? anything)\b/i;
  const claims = list => list.filter(s => READ.test(s) && COST.test(s) && !FREE.test(s));
  const control = claims(strings("x = 'Reading a TikTok link costs 2 credits.'; y = '<b>Each link you read uses one credit</b>';"));
  ok(control.length === 2, '6 positive control: the detector catches a credit claim (' + control.length + '/2)');
  const found = claims(strings(html));
  ok(found.length === 0, '6 no client copy says reading a link costs credits' + (found.length ? ' — ' + J(found.map(s => s.slice(0, 90))) : ''));
  const faq = between('\n  create: [\n    { q:\'What does', '\n  ],');
  ok(/getting the words from a TikTok cost anything\?', a:"No\. Reading a TikTok link is free, up to a daily limit\./.test(faq), '6 the Remix FAQ says reading a TikTok link is free (up to a daily limit)');
}

/* ═══ 7. a returning user with no creators: the feed is ONE line above Step 1 ═══ */
{
  const el = { innerHTML: '' }; let fetched = 0;
  const c = run(Object.assign(BASE(), { window: {}, currentBrand: { id: 'b1' }, bookmarkCategories: [], activeView: 'create', listLoadFailed: () => false, fetch: async () => { fetched++; return { ok: true, status: 200, text: async () => '{}' }; },
    document: { getElementById: id => id === 'creatorFeed' ? el : null }, escHtml: s => String(s), escAttr: s => String(s), safeUrl: s => s }),
    line(/\nconst CF_MAX_CREATORS = \d+;/).replace('const', 'var'), line(/\nconst CF_TOP = \d+;/).replace('const', 'var'),
    'var _cf = { brandId: "", status: "idle", data: null, err: "", note: "", noteBad: false, showAll: false, inflight: false, refreshing: false, busy: "", rowErr: {}, seq: 0 }, _cfRows = [];',
    ...['cfTtLink', 'cfCreatorTtLink', 'cfFollowedHandles', 'cfBrandNow', 'cfReset', 'cfLoad', 'cfOpen', 'cfCall', 'cfApply', 'cfSorted', 'cfRender', 'cfAge', 'cfHandle', 'cfReady', 'cfScoreLabel', 'cfShortNum'].map(grab));
  await c.cfOpen(); await tick();
  ok(fetched === 0, '7 no TikTok creators followed: Remix asks the server nothing');
  ok(/^<div class="cf-empty cf-empty-line"><span class="cf-empty-txt">[^<]{10,80}<\/span><button type="button" class="cf-add" onclick="cfAddCreator\(\)">Add one<\/button><\/div>$/.test(el.innerHTML), '7 the empty feed is ONE line + "Add one" (no heading, no skeleton): ' + el.innerHTML.slice(0, 120));
  ok(/\.cf-empty\.cf-empty-line\{flex-wrap:nowrap;/.test(html) && /\.cf-empty-line \.cf-empty-txt\{[^}]*white-space:nowrap;overflow:hidden;text-overflow:ellipsis;/.test(html), '7 …and it never wraps to a second line (the text gives way, the button stays)');
  const v = html.indexOf('<div class="view" id="view-create">'), feed = html.indexOf('<div id="creatorFeed"', v), quick = html.indexOf('id="remixQuickIn"', v);
  ok(v > 0 && feed > v && quick > feed, '7 that line sits above Step 1\'s paste box');
}

finished = true;
if (fail) { console.log('REMIX FIRST FAILED (' + fail + ')'); process.exit(1); }
console.log('REMIX FIRST OK');
