#!/usr/bin/env node
// GATE (v703 desktop-native STRUCTURE, agent D2): the ≥900px app is built like a desktop app, and phones are untouched.
// EXECUTED where it can be: the <script id="csx-desktop"> block and the app functions it leans on are lifted from
// app.html and run in node:vm against stub DOMs (no browser, no network). The rendered proof (Playwright, 1440/1000/375)
// lives outside the repo; this gate pins the logic and the markup contract.
//   1  reachability: the sidebar opens with "New post" (Composer dialog) above the brand row; the ⌘K palette reaches
//      every screen, Bookmarks, Brand brain, Assistant, Settings, New post, the theme toggle and every other brand —
//      and every function a palette item calls exists in app.html.
//   2  toolbar: every screen (11) gets a toolbar with its title and AT MOST ONE primary; Ideas filters (type segmented,
//      day + format dropdowns, status) call the existing filter functions; "Select" toggles the existing select mode;
//      Plan my week / Write today's post / Pipeline stages / Trends tabs map to the existing actions.
//   3  master-detail: selection survives a re-render by id and moves to the NEXT item when the selected one leaves;
//      below 1100px a row opens the detail as a dialog; the detail reuses the existing detail nodes (moved, put back).
//   4  keyboard: J/K/↑/↓/Enter, Ideas A/S/E, Pipeline R/M, ⌘K, "?", N — and nothing fires while typing in an input,
//      textarea, select or contenteditable, or while a dialog is open (Esc still works).
//   5  Escape: ONE capture-phase handler closes the topmost layer; every registered dialog type is created by app.html
//      and has a working close path; Esc reaches each one.
//   6  Composer dialog: the SAME routing — the text goes through csComposerSend (link → remixQuickGo, text → rv2Start).
//   7  Settings: the existing tabs become the left subnav, the body the panel; the Workspace tab sits INSIDE .sp-body.
//   8  phones unchanged: every csx-layout rule sits in a min-width 900/1100 block (the one max-width block only hides
//      csx pieces), and every entry point returns at once below 900px.
//   9  the upgrade card says "You've hit your trial limit" only when the limit was hit; toasts carry .csx-toast.
// RUN: node scripts/verify/desktop-native.mjs      EXPECT: prints "DESKTOP NATIVE OK", exit 0.
import fs from 'node:fs'; import vm from 'node:vm';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
setTimeout(() => { console.log('FAIL: wall clock (60s) exceeded'); process.exit(2); }, 60000).unref();
let finished = false; process.on('exit', (code) => { if (!finished && code === 0) { console.log('FAIL: the gate ended before all checks ran'); process.exitCode = 1; } });
let fail = 0; const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('ok:', m); };
const grab = (src, n) => {
  let i = src.indexOf('\nfunction ' + n + '('); if (i < 0) i = src.indexOf('\nasync function ' + n + '(');
  if (i < 0) throw new Error('no ' + n);
  const eol = src.indexOf('\n', i + 1), first = src.slice(i + 1, eol);
  let d = 0, seen = false; for (const ch of first) { if (ch === '{') { d++; seen = true; } else if (ch === '}') d--; }
  if (seen && d === 0) return first;
  return src.slice(i + 1, src.indexOf('\n}', i) + 2);
};
const between = (src, a, b) => { const i = src.indexOf(a); const j = src.indexOf(b, i + a.length); if (i < 0 || j < 0) throw new Error('marker missing: ' + a.slice(0, 50)); return src.slice(i, j + b.length); };
const escHtml = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const appDefines = n => new RegExp('\\n(?:async )?function ' + n.replace(/\$/g, '\\$') + '\\(').test(html);

const JS_A = '/* ===== v703 DESKTOP-NATIVE STRUCTURE (D2)', JS_B = '/* ===== end v703 desktop-native structure ===== */';
const js = between(html, JS_A, JS_B);
const css = between(html, '<style id="csx-layout">', '</style>');
const rest = html.replace(js, '');      // app.html without D2's own script (where the dialogs must come from)
ok(js.length > 20000 && css.length > 2000, 'the csx-layout style and the desktop structure code are in app.html');
ok(html.indexOf(JS_A) > html.lastIndexOf('function renderIdeas(') && html.indexOf('</script>', html.indexOf(JS_B)) === html.lastIndexOf('</script>'), 'the structure code runs last: the end of the last inline script (after the functions it wraps)');

// a stub world: document never answers unless a test says so; touching it below 900px is a failure
const stubDoc = (over = {}) => Object.assign({ readyState: 'loading', addEventListener() {}, getElementById: () => null, querySelector: () => null,
  querySelectorAll: () => [], body: { children: [], getAttribute: () => null, hasAttribute: () => false, setAttribute() {}, removeAttribute() {}, appendChild() {} },
  documentElement: { getAttribute: () => 'dark' }, activeElement: null }, over);
const world = (extra = {}, wide = true, desk = true) => {
  const c = Object.assign({ console, Math, JSON, String, Number, Array, Object, RegExp, Set, Map, Date, Promise, Boolean, Error,
    navigator: { platform: 'MacIntel', userAgent: '' }, matchMedia: q => ({ matches: /1100/.test(q) ? (desk && wide) : desk }),
    innerWidth: 1440, requestAnimationFrame: f => f(), escHtml, document: stubDoc() }, extra);
  c.window = c; vm.createContext(c); vm.runInContext(js, c); return c;
};

/* ═══ 1. reachability ═══ */
{
  let built = null;
  const c = { window: { APP_VERSION: 'vT' }, escHtml, DS_ICONS: {}, syncDesktopNav() {}, renderUsagePill() {},
    document: { getElementById: () => null, querySelector: () => ({ textContent: 'Acme Co' }), createElement: () => ({ innerHTML: '' }), body: { appendChild: e => { built = e; } } } };
  vm.createContext(c);
  vm.runInContext(between(html, 'var CS_DRAWER_ICONS = {', '\n};') + '\n' + grab(html, '_dsItem') + '\n' + grab(html, 'buildDesktopSidebar'), c);
  c.buildDesktopSidebar();
  const sb = built ? built.innerHTML : '';
  const np = sb.indexOf('class="csx-newpost'), br = sb.indexOf('id="dsBrand"');
  ok(np >= 0 && np < br && /class="csx-newpost csx-btn csx-btn--secondary" id="csxNewPost" onclick="csxComposerOpen\(\)">[\s\S]*?<span>New post<\/span><kbd class="csx-kbd">Ctrl K<\/kbd><\/button>/.test(sb), '1 sidebar: "New post" is the top row, opens the Composer dialog, shows the ⌘K hint');
  const c2 = world({ allBrands: [{ id: 'b1', brand_name: 'Acme' }, { id: 'b2', brand_name: 'Northwind  Coffee' }], currentBrand: { id: 'b1' }, csShelved: v => v === 'dfy' });
  const items = c2.csxPaletteItems();
  const calls = items.map(i => i.call[0] + '(' + i.call.slice(1).map(a => JSON.stringify(a)).join(',') + ')');
  const need = ["csxComposerOpen()", "switchView(\"today\")", "switchView(\"ideas\")", "switchView(\"pipeline\")", "switchView(\"create\")", "switchView(\"idea\")", "switchView(\"viral\")",
    "switchView(\"notebook\")", "switchView(\"questions\")", "toggleBookmarkBar()", "openBrain()", "bvTabClick()", "openSettings()", "switchBrand(\"b2\")", "addNewBrand()", "toggleDarkMode(false)", "csxShortcutsOpen()", "startTour()"];
  const miss = need.filter(n => calls.indexOf(n) < 0);
  ok(!miss.length, '1 the palette reaches every screen, Bookmarks, Brand brain, Assistant, Settings, New post, theme, the other brand' + (miss.length ? ' — missing ' + miss : ''));
  ok(!calls.includes('switchBrand("b1")') && items.find(i => i.call[0] === 'switchBrand').label === 'Northwind Coffee', '1 the current brand is not offered; names are tidied');
  const undef = [...new Set(items.map(i => i.call[0]))].filter(n => !appDefines(n));
  ok(!undef.length, '1 every function a palette item calls exists in app.html' + (undef.length ? ' — missing ' + undef : ''));
  ok(c2.csxPaletteFilter(items, 'pipe').map(i => i.label).join() === 'Pipeline' && c2.csxPaletteFilter(items, 'theme').length === 1, '1 palette filtering by typed text');
  ok(/<span>Bookmarks<\/span>/.test(sb) && /data-act="openSettings"/.test(sb), '1 the sidebar keeps Bookmarks and Settings');
}

/* ═══ 2. toolbar ═══ */
const ideaWorld = (sel = false, picked = 0, extra = {}) => world(Object.assign({
  getPendingIdeas: () => [1, 2, 3], getVisibleIdeas: () => [{ status: 'pending' }, { status: 'pending' }, { status: 'pending' }, { status: 'filming' }, { status: 'dismissed' }],
  ideaStatusFilter: 'pending', POST_TYPE_IDS: ['tip', 'news'], POST_TYPE_LABELS: { tip: 'Tip', news: 'News' }, activePostType: 'tip', DAYS: ['Monday', 'Tuesday'], activeFilter: 'Tuesday',
  FORMATS: ['video', 'bonus', 'qna'], FORMAT_LABELS: { video: 'Video', qna: 'Q&A' }, activeFormat: 'all', _ideaSelectMode: sel, _ideaSelected: new Set(Array.from({ length: picked }, (_, i) => i)), visiblePendingIds: () => [1, 2, 3] }, extra));
{
  const prim = h => (h.match(/csx-btn--primary/g) || []).length;
  const fake = (cls, txt, attrs = {}) => ({ className: cls, textContent: txt, classList: { contains: k => cls.split(' ').includes(k) }, querySelector: () => ({ textContent: '3' }), getAttribute: a => attrs[a] || null });
  const docFor = { pipeline: { querySelectorAll: s => /pipelineStages/.test(s) ? [fake('pipeline-stage-tab s-filming active', 'Film'), fake('pipeline-stage-tab s-done', 'Done')] : [] },
    viral: { querySelectorAll: s => /vlTabs/.test(s) ? [fake('create-sub-tab active', "What's rising", { 'data-vt': 'watch' }), fake('create-sub-tab', 'Analyze a video', { 'data-vt': 'analyze' })] : [] },
    today: { getElementById: id => id === 'tvGenerateBtn' ? { textContent: 'Write today’s post' } : null } };
  const screens = ['today', 'ideas', 'pipeline', 'create', 'idea', 'viral', 'notebook', 'questions', 'bookmarks', 'settings', 'assistant'];
  let allOk = true; const bad = [];
  for (const s of screens) {
    const c = ideaWorld(false, 0, { STAGE_LABELS: { filming: 'Film & Post', done: 'Done' }, notebookNotes: [1, 2], bookmarkCategories: [{ entries: [1] }], document: stubDoc(docFor[s] || {}) });
    const m = c.csxToolbarModel(s);
    if (!m.title || m.title !== c.CSX_TITLES[s] || prim(m.ctx + m.actions) > 1) { allOk = false; bad.push(s); }
  }
  ok(allOk, '2 every screen (' + screens.length + ') has a toolbar title and at most one primary' + (bad.length ? ' — bad: ' + bad : ''));
  const c = ideaWorld();
  const m = c.csxToolbarModel('ideas');
  ok(/csx-btn--primary" onclick="csxPlanOpen\(\)">Plan my week</.test(m.actions) && /onclick="toggleIdeaSelectMode\(\)">Select</.test(m.actions), '2 Ideas: Plan my week is the primary; "Select" toggles the existing select mode');
  ok(/class="csx-seg"[^>]*aria-label="Type"/.test(m.ctx) && /aria-pressed="true"[^>]*onclick="setPostTypeFilter\('tip'\)">Tip</.test(m.ctx) && /onclick="setPostTypeFilter\('all'\)">All</.test(m.ctx), '2 Ideas: type is a segmented control on the existing setPostTypeFilter');
  ok(/aria-label="Day"[^>]*onchange="setFilter\(this\.value\)">[\s\S]*?value="Tuesday" selected/.test(m.ctx) && /aria-label="Format"[^>]*onchange="setFormat\(this\.value\)"/.test(m.ctx) && !/value="bonus"/.test(m.ctx), '2 Ideas: day and format dropdowns on setFilter / setFormat (current value selected)');
  ok(/aria-label="Status"[^>]*onchange="setIdeaStatus\(this\.value\)">[\s\S]*?value="pending" selected>3 pending</.test(m.ctx), '2 Ideas: status (the old stat squares) on setIdeaStatus, with counts');
  const ms = ideaWorld(true, 2).csxToolbarModel('ideas');
  ok(/csx-btn--primary" onclick="batchApprove\(\)">Approve 2</.test(ms.actions) && !/csxPlanOpen/.test(ms.actions) && /ideaSelectAll\(\)/.test(ms.actions) && prim(ms.actions) === 1, '2 Ideas select mode: Approve N (batchApprove) is the one primary, plus Select all / Cancel');
  ok(/disabled/.test(ideaWorld(true, 0).csxToolbarModel('ideas').actions), '2 Approve is disabled with nothing picked');
  const narrow = ideaWorld(); narrow.innerWidth = 1000; const mn = narrow.csxToolbarModel('ideas');
  ok(/aria-label="Type"[^>]*onchange="setPostTypeFilter\(this\.value\)"/.test(mn.ctx), '2 narrow windows: the type control becomes a dropdown (same function)');
  const cp = ideaWorld(); cp._csxCompactUpTo = 5000; const mc = cp.csxToolbarModel('ideas');
  ok(/onclick="csxFiltersOpen\(\)" data-k="Filters">Filters · 2</.test(mc.ctx) && !/aria-label="Day"/.test(mc.ctx) && /aria-label="Status"/.test(mc.ctx), '2 too narrow for every dropdown: one "Filters" button (with the active count) instead');
  const fl = cp.csxIdeaFilters().map(f => f[0] + ':' + f[1]).join();
  ok(fl === 'Type:setPostTypeFilter(this.value),Day:setFilter(this.value),Format:setFormat(this.value)', '2 … and its dialog holds the same three dropdowns on the same functions');
  const today = world({ document: stubDoc(docFor.today) }).csxToolbarModel('today');
  ok(prim(today.ctx + today.actions) === 0 && !/display: none[^}]*tvGenerateBtn|tvGenerateBtn[^{]*\{[^}]*display: none/.test(css)
    && /<button type="button" class="cs-primary-btn" id="tvGenerateBtn"/.test(html) && /class="tp-shz-angle csx-btn csx-btn--secondary" onclick="openAngleSheet\(\)">Pick the angle myself/.test(html),
    "2 Quick Post: the ONE primary is the page's own Write today's post (toolbar has none); Pick the angle myself is a secondary button");
  const pl = world({ STAGE_LABELS: { filming: 'Film & Post', done: 'Done' }, document: stubDoc(docFor.pipeline) }).csxToolbarModel('pipeline');
  ok(/onclick="setPipelineStage\('filming'\)">Film &amp; Post <span class="csx-seg-count">3<\/span>/.test(pl.ctx) && /setPipelineStage\('done'\)/.test(pl.ctx), '2 Pipeline: stages segmented on setPipelineStage, counts read from the existing tabs');
  const vl = world({ document: stubDoc(docFor.viral) }).csxToolbarModel('viral');
  ok(/onclick="vlTab\('watch'\);csxToolbarSync\(\)">What&#39;s rising/.test(vl.ctx) && /vlTab\('analyze'\)/.test(vl.ctx), "2 Trends: its two tabs live in the toolbar (vlTab)");
  ok(/host\.insertBefore\(tb, host\.firstChild\)/.test(grab(js, 'csxToolbarSync')) && /if \(screen === 'settings'\) return document\.getElementById\('settingsOverlay'\);/.test(js), '2 the toolbar is the first child of the screen (Settings and Assistant included)');
  ok(/#csPageHead, #csIdeasHead, #view-notebook \.nb-header h2, #view-viral \.vl-head h2, #view-idea \.vl-head h2, #view-dfy \.vl-head h2,\s*#vlTabs, #view-create \.cs-rx-title \{ display: none !important; \}/.test(css) && /class="cs-rx-title"/.test(html), '2 duplicate page titles and headers are hidden on desktop');
  ok(/#csComposer \{ display: none !important; \}/.test(css), '2 no bottom-pinned composer on desktop');
  const po = grab(js, 'csxPlanOpen');
  ok(/document\.getElementById\('ideasQuick'\)/.test(po) && /body\.appendChild\(q\)/.test(po) && /onClose: csxPlanRestore/.test(po) && /id="ideasQuickBtn" onclick="ideasQuickGo\(this\)"/.test(html), '2 Plan my week opens the existing plan card (ideasQuickGo) in a dialog and puts it back');
}

/* ═══ 3. master-detail ═══ */
{
  const c = world();
  ok(c.csxPickAfter(['1', '2', '3'], ['1', '3'], '2') === '3', '3 the selected item left: the next one is selected');
  ok(c.csxPickAfter(['1', '2', '3'], ['1', '2'], '3') === '2', '3 the last one left: the one before it is selected');
  ok(c.csxPickAfter(['1', '2', '3'], ['3', '1', '2'], '2') === '2', '3 a re-render keeps the selection by id');
  ok(c.csxPickAfter([], ['1'], null) === null && c.csxPickAfter(['9'], ['1'], '7') === null, '3 nothing selected stays nothing (the empty state shows)');
  ok(/csxSel\[view\] = csxPickAfter\(csxOrder\[view\], ids, csxSel\[view\]\);/.test(grab(js, 'csxRenderMD')), '3 every list render runs the selection through csxPickAfter');
  // a row click below 1100 opens the dialog; at ≥1100 it does not
  for (const wide of [false, true]) {
    const w = world({}, wide); let dlg = null; w.csxDetailDialog = v => { dlg = v; }; w.csxRenderDetail = () => {};
    w.csxSelectRow('ideas', '4', true);
    ok(wide ? dlg === null : dlg === 'ideas', '3 ' + (wide ? '≥1100: a row selects into the pane' : '900–1099: a row opens the detail as a dialog'));
  }
  ok(/body\[data-csx-md\] #csxDetail \{ display: flex;[^}]*position: fixed;/.test(css.slice(css.indexOf('@media (min-width: 1100px)'))) && /\.csx-detail \{ display: none; \}/.test(css), '3 the detail pane exists only from 1100px');
  ok(/rv2BeliefLine/.test(grab(js, 'csxDetailParts')) && /card\.querySelector\('\.list-card-detail'\)/.test(js) && /card\.querySelector\('\.list-actions'\)/.test(js) && /pc\.querySelector\('\.pipeline-card-detail'\)/.test(js)
    && /pc\.querySelector\('\.pipeline-card-actions'\)/.test(js) && /el\.querySelector\('\.nb-note-actions'\)/.test(js), '3 the detail holds the EXISTING detail nodes and action buttons (moved, not copied)');
  ok(/^  csxRestoreMoved\(\);$/m.test(grab(js, 'csxRenderDetail')) && /onClose: csxRestoreMoved/.test(js), '3 moved nodes go back to their card before the pane changes, and when the dialog closes');
  ok(/if \(!csxIsDesk\(\) \|\| csxScreen\(\) !== view\) return;/.test(grab(js, 'csxRenderDetail')), '3 the pane only ever shows the screen that is up');
  ok(/csxWrap\('renderIdeas'/.test(js) && /csxWrap\('renderPipeline'/.test(js) && /csxWrap\('renderNotebook'/.test(js) && /csxWrap\('rerenderBookmarks'/.test(js), '3 lists follow the existing renderers');
  ok(/if \(typeof csxIsDesk === 'function' && csxIsDesk\(\)\) \{ closeBookmarks\(\); switchView\('bookmarks'\); return; \}/.test(grab(html, 'openBookmarks')) && /<div class="view" id="view-bookmarks"><\/div>/.test(html), '3 Bookmarks is a master-detail screen on desktop; phones keep the sheet');
}

{
  // a closed Settings keeps its own copy of the bookmark editor (same ids, earlier in the page): Save must read the editor it is in
  const html2 = html; const sv = (()=>{ const i = html2.indexOf('\nfunction saveBmLinks('); return html2.slice(i + 1, html2.indexOf('\n}', i) + 2); })();
  const ent = { id: 'e1', links: { ig: 'old' } };
  const c = { bookmarkCategories: [{ id: 'c1', entries: [ent] }], fpCleanNote: x => String(x || '').trim(), saveBookmarks() {}, rerenderBookmarks() {}, _bmEditingEntry: { entId: 'e1' } };
  const stale = id => ({ value: id.endsWith('_ig') ? 'https://stale.example' : (id.startsWith('bmNote') ? 'stale note' : '') });
  const fresh = id => ({ value: id.endsWith('_ig') ? 'https://fresh.example' : (id.startsWith('bmNote') ? 'fresh note' : '') });
  c.document = { getElementById: id => stale(id) };
  const editor = { querySelector: sel => { const m = /\[id="([^"]+)"\]/.exec(sel); return m ? fresh(m[1]) : null; } };
  vm.createContext(c); vm.runInContext(sv, c);
  c.saveBmLinks('c1', 'e1', { closest: s => s === '.bm-link-editor' ? editor : null });
  ok(ent.links.ig === 'https://fresh.example' && ent.note === 'fresh note', '3 Save in a bookmark editor reads THAT editor, not a hidden copy with the same ids (' + ent.links.ig + ')');
  ok(/class="bm-save-btn" onclick="saveBmLinks\(\\'' \+ cat\.id \+ '\\',\\'' \+ ent\.id \+ '\\',this\)"/.test(html), '3 the Save button passes itself');
}

/* ═══ 4. keyboard ═══ */
{
  const c = world({ CS_READ_FORMATS: ['video', 'statement'] });
  const A = (k, s, i) => JSON.stringify(c.csxKeyAction(k, s, i));
  const pend = { id: 7, status: 'pending', format: 'video' }, film = { id: 8, status: 'filming', format: 'video' }, car = { id: 9, status: 'filming', format: 'carousel' };
  ok(A('j', 'ideas', pend) === '["csxMove","ideas",1]' && A('ArrowDown', 'notebook', null) === '["csxMove","notebook",1]' && A('k', 'pipeline', film) === '["csxMove","pipeline",-1]' && A('ArrowUp', 'bookmarks', null) === '["csxMove","bookmarks",-1]', '4 J/K and ↓/↑ move in every list');
  ok(A('Enter', 'ideas', pend) === '["csxOpenDetail","ideas"]', '4 Enter goes to the detail');
  ok(A('a', 'ideas', pend) === '["quickApprove",7]' && A('s', 'ideas', pend) === '["showDismissPopupFn",7]' && A('e', 'ideas', pend) === '["csxEditIdea",7]', '4 Ideas: A approve, S skip, E edit (the existing handlers)');
  ok(A('a', 'ideas', { id: 7, status: 'filming' }) === 'null', '4 A does nothing on an idea that is not pending');
  ok(A('r', 'pipeline', film) === '["openTeleprompter",8]' && A('r', 'pipeline', car) === 'null' && A('m', 'pipeline', film) === '["pipeAdvance",null,8,"done"]' && A('m', 'pipeline', { id: 3, status: 'done' }) === 'null', '4 Pipeline: R reads the script (teleprompter formats only), M marks done');
  // the live handler
  const run = (ev, layers = 0, tp = false) => {
    const fired = [];
    const w = world({ CS_READ_FORMATS: ['video'], state: [pend], activeView: 'ideas', quickApprove: id => fired.push('approve:' + id) });
    Object.assign(w, { csxPaletteToggle: () => fired.push('palette'), csxShortcutsOpen: () => fired.push('keys'), csxComposerOpen: () => fired.push('composer'), csxEscape: () => { fired.push('esc'); return true; } });
    w.document = stubDoc({ getElementById: id => id === 'teleprompterOverlay' && tp ? { classList: { contains: () => true } } : null });
    w.csxLayers = () => Array.from({ length: layers }, () => ({ el: { id: ev._top || 'dpBackdrop', contains: () => false } }));
    w.csxSel.ideas = '7'; w.csxOnKey(Object.assign({ preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() { fired.push('stopped'); }, target: { tagName: 'BODY' } }, ev));
    return fired.join(',');
  };
  ok(run({ key: 'a' }) === 'approve:7', '4 A approves the selected idea');
  ok(run({ key: 'a', target: { tagName: 'INPUT' } }) === '' && run({ key: 'j', target: { tagName: 'TEXTAREA' } }) === '' && run({ key: 's', target: { tagName: 'SELECT' } }) === '' && run({ key: 'a', target: { tagName: 'DIV', isContentEditable: true } }) === '', '4 keys are ignored while typing (input, textarea, select, contenteditable)');
  ok(run({ key: 'a' }, 1) === '' && run({ key: '?' }, 1) === '', '4 keys are ignored while a dialog is open');
  ok(run({ key: 'a', _top: 'csxDetailDlg' }, 1) === 'approve:7' && run({ key: 'a', _top: 'csxDetailDlg', target: { tagName: 'TEXTAREA' } }, 1) === '' && run({ key: 'a', _top: 'csxDetailDlg' }, 2) === '',
    '4 … except the 900–1099 detail dialog: A / S / E still work there (not while typing, not under another dialog)');
  ok(run({ key: 'Escape' }, 1) === 'stopped,esc' && run({ key: 'Escape', target: { tagName: 'INPUT' } }) === 'stopped,esc', '4 … except Esc, which always reaches the one handler (and stops the older ones)');
  ok(run({ key: 'k', ctrlKey: true, target: { tagName: 'INPUT' } }) === 'stopped,palette' && run({ key: 'K', metaKey: true }) === 'stopped,palette', '4 ⌘K / Ctrl+K opens the palette, even from a text box');
  ok(run({ key: '?' }) === 'keys' && run({ key: 'n' }) === 'composer', '4 "?" opens the shortcuts, N a new post');
  ok(run({ key: 'a' }, 0, true) === '' && run({ key: 'Escape' }, 0, true) === '', '4 the teleprompter Read mode keeps its own keys');
  ok(/window\.addEventListener\('keydown', csxOnKey, true\);/.test(js), '4 the handler is registered once, on window, in the capture phase');
  ok(/'Ideas', \[\['A', 'Approve'\], \['S', 'Skip'\], \['E', 'Edit'\]\]/.test(js) && /'Pipeline', \[\['R', 'Read script'\], \['M', 'Mark done'\]\]/.test(js), '4 the "?" dialog lists the keys');
}

/* ═══ 5. Escape closes every registered dialog type ═══ */
{
  const c = world();
  const D = c.CSX_DIALOGS;
  const created = d => { const hm = /:has\(#([\w-]+)\)$/.exec(d.root); if (hm && !new RegExp('id="' + hm[1] + '"').test(rest)) return false; const r = d.root.replace(/:has\(.*\)$/, ''); if (r[0] === '#') { const id = r.slice(1); return new RegExp("\\.id ?= ?'" + id + "'|id=\"" + id + '"|id = \'' + id + "'").test(rest); } const cls = r.slice(1); return new RegExp("className ?= ?'" + cls + "'").test(rest); };
  const notMade = D.filter(d => !created(d)).map(d => d.k);
  ok(D.length >= 14 && !notMade.length, '5 ' + D.length + ' dialog types registered, each one created by app.html' + (notMade.length ? ' — not found: ' + notMade : ''));
  const req = ['dismiss', 'approve', 'angle', 'opinion', 'bookmarks', 'upgrade', 'broll', 'slides', 'brain-review', 'install', 'notif'];
  ok(req.every(k => D.some(d => d.k === k)), '5 covers the approve + dismiss sheets, angle sheet, opinion sheet, bookmarks, paywall, B-roll, Make Slides, brand review, install guide, notifications');
  const xTok = x => x.split(/[\s>]+/).pop();
  const closeOk = D.filter(d => !(d.close ? appDefines(d.close) : true) || (d.x && rest.indexOf(xTok(d.x).replace(/^\./, 'class="').replace(/^#/, 'id="')) < 0 && rest.indexOf("'" + xTok(d.x).slice(1)) < 0)).map(d => d.k);
  ok(!closeOk.length, '5 every close function / close button a dialog names exists' + (closeOk.length ? ' — ' + closeOk : ''));
  const unsafe = D.filter(d => !d.noClose && !(d.x || d.close || d.cancel || d.removable)).map(d => d.k);
  ok(!unsafe.length, '5 every adopted sheet closes only through a path it already had (its X, close function, cancel/skip button, or removal where that IS its close)' + (unsafe.length ? ' — ' + unsafe : ''));
  const so = D.find(d => d.k === 'split-offer'), gen = D.find(d => d.k === 'sheet');
  ok(so && /tpSplitGo/.test(so.root) && so.cancel === '#tpSplitCancel, #tpSplitSkip' && !so.removable && D.indexOf(so) < D.findIndex(d => d.root === '.br-backdrop'), '5 the "Filmed ✓" split offer closes through its own Skip / "Stop and just save my video" (both save the take)');
  ok(gen && gen.noClose && D[D.length - 1] === D.find(d => d.k === 'coach-popup') || (gen && gen.noClose), '5 any other .br-backdrop sheet is centred but only its own buttons close it');
  ok(D.find(d => d.k === 'filmed-ask').close === 'tpFilmedAnswer' && JSON.stringify(D.find(d => d.k === 'filmed-ask').args) === '[false]', '5 "Mark as filmed?" closes as "Not yet"');
  {
    const w = world(); const log = [];
    const btn = (id, vis) => ({ id, disabled: false, getClientRects: () => vis ? [1] : [], click: () => log.push(id) });
    const mk = (skipVis, cancelVis) => ({ querySelector: () => null, querySelectorAll: () => [btn('tpSplitCancel', cancelVis), btn('tpSplitSkip', skipVis)], remove: () => log.push('REMOVED') });
    w.csxCloseLayer({ el: mk(true, false), d: so });
    w.csxCloseLayer({ el: mk(false, true), d: so });
    const r3 = w.csxCloseLayer({ el: mk(false, false), d: so });
    const r4 = w.csxCloseLayer({ el: mk(false, false), d: gen });
    const r5 = w.csxCloseLayer({ el: mk(false, false), d: { close: 'csxNoSuchCloser' } });
    ok(log.join() === 'tpSplitSkip,tpSplitCancel' && r3 === false && r4 === false && r5 === false, '5 X / Esc on the split offer = Skip (or Stop-and-save while it renders); with neither on screen nothing is removed (' + log.join() + ')');
    ok(/if \(!x && csxClosable\(d\) && !head\.querySelector\('\[data-csx-close\]'\)\)/.test(grab(js, 'csxAdopt')) && !/L\.el\.remove\(\);\n\}/.test(grab(js, 'csxCloseLayer')), '5 no X is added to a sheet that has no safe close, and nothing is ever just removed by default');
  }
  // Esc → the topmost layer's close
  let res = [];
  D.forEach(d => {
    const w = world(); const log = [];
    if (d.close) w[d.close] = (...a) => log.push(d.close + JSON.stringify(a));
    const el = { querySelector: s => (d.x && s === d.x) ? { click: () => log.push('x') } : null, remove: () => log.push('remove'), id: 'L' };
    if (!d.x && !d.close && d.removable === undefined) return;
    const under = { querySelector: () => null, remove: () => log.push('UNDER') };
    w.csxLayers = () => [{ el: under, d: {} }, { el, d }];
    if (d.noClose || d.cancel) return;   // checked above with real buttons
    const did = w.csxEscape();
    res.push(did && log.length === 1 && log[0] !== 'UNDER' ? null : d.k + ':' + log.join('/'));
  });
  res = res.filter(Boolean);
  ok(!res.length, '5 Esc closes the TOPMOST layer for every dialog type (close button, close function or removal)' + (res.length ? ' — ' + res : ''));
  const order = []; const w = world({ toggleBrandSwitcher: () => order.push('dropdown'), openAssignId: 4, toggleAssignPopup: id => order.push('assign' + id), toggleSettings: () => order.push('settings') });
  w.csxLayers = () => [];
  w.document = stubDoc({ getElementById: id => id === 'brandDropdown' ? { classList: { contains: () => true } } : null });
  w.csxEscape();
  ok(order.join() === 'dropdown', '5 with no dialog, Esc closes the brand dropdown next');
  const w2 = world({ openAssignId: 4, toggleAssignPopup: id => order.push('assign' + id) }); w2.csxLayers = () => []; w2.csxEscape();
  ok(order.join() === 'dropdown,assign4', '5 … then the assign popup');
  ok(/if \(L\.length\) \{ csxCloseLayer\(L\[L\.length - 1\]\); return true; \}/.test(grab(js, 'csxEscape')), '5 topmost = last open layer');
  ok(/getClientRects\(\)\.length/.test(grab(js, 'csxShown')) && /if \(!csxIsDesk\(\)\) return;/.test(grab(js, 'csxOnKey')), '5 only shown layers count');
  const ad = grab(js, 'csxAdopt');
  ok(/root\.classList\.add\('csx-backdrop'\)/.test(ad) && /panel\.classList\.add\('csx-dialog'\)/.test(ad) && /csx-dialog-head/.test(ad) && /body\.classList\.add\('csx-dialog-body'\)/.test(ad) && /foot\.classList\.add\('csx-dialog-foot'\)/.test(ad), '5 an opened sheet becomes a dialog: head (title + close), scrolling body, foot');
  ok(/body > \.csx-backdrop \{ display: flex; position: fixed !important; inset: 0 !important;[\s\S]*?align-items: center !important; justify-content: center !important;/.test(css) && /\.csx-backdrop \.csx-dialog \{ position: relative !important; inset: auto !important; transform: none !important;/.test(css), '5 dialogs are centred on the WINDOW');
  ok(/max-height: 85vh !important/.test(css) && /\.csx-dialog-body \{ flex: 1 1 auto; min-height: 0; overflow: auto !important; \}/.test(css), '5 dialog body scrolls inside 85vh');
  const tick = grab(js, 'csxTick');
  ok(/l\.el\._csxOpener = _csxLastFocus/.test(tick) && /op\.focus\(/.test(tick) && /function csxTrapTab\(e\)/.test(js), '5 focus moves into a dialog, Tab is trapped, focus returns on close');
}

/* ═══ 6. Composer dialog routing ═══ */
{
  const route = between(html, 'function csComposerRoute(raw){', '\n}');
  const send = grab(html, 'csComposerSend');
  ok(/return remixQuickGo\(document\.getElementById\('remixQuickBtn'\)\);/.test(send) && /var p = rv2Start\(null, csComposerSource\(raw\), \{ host: 'rv2Sheet'/.test(send), '6 csComposerSend still routes link → remixQuickGo, text → rv2Start');
  const runSend = (text, keep) => {
    const box = { value: '' }, ta = { value: text, focus() {} }, log = [];
    const w = world({ remixPickLink: t => /^https?:/.test(t) ? { kind: 'tiktok' } : { kind: 'text' } });
    vm.runInContext(route, w);
    w.document = stubDoc({ getElementById: id => id === 'csxComposerIn' ? ta : id === 'csComposerIn' ? box : null });
    w.csxDialogClose = id => log.push('close:' + id); w.csxComposerOpen = t => log.push('reopen:' + t);
    w.csComposerSend = () => { log.push('send:' + box.value); if (!keep) box.value = ''; return 'R'; };
    let r; try { r = w.csxComposerSend(); } catch (er) { log.push('threw:' + er.message); } return { log: log.join('|'), r };
  };
  const a = runSend('https://www.tiktok.com/@x/video/1'), b = runSend('why deadlines slip'), e = runSend('   '), k = runSend('a link', true);
  ok(a.log === 'close:csxComposerDlg|send:https://www.tiktok.com/@x/video/1' && a.r === 'R', '6 a link goes through csComposerSend (→ Remix)');
  ok(b.log === 'close:csxComposerDlg|send:why deadlines slip', '6 text goes through csComposerSend (→ the writer)');
  ok(e.log === '', '6 an empty box sends nothing');
  ok(k.log === 'close:csxComposerDlg|send:a link|reopen:a link', '6 when nothing started (Remix busy / locked) the text comes back into the dialog');
  ok(/if \(!csxIsDesk\(\)\) \{ if \(typeof csNewPost === 'function'\) csNewPost\(\); return; \}/.test(grab(js, 'csxComposerOpen')), '6 below 900px "new post" stays the phone pencil (Quick Post)');
  {
    // Esc / X / Cancel with text typed keeps it: the next New post opens with the draft
    const w = world(); let last = null; const ta = { value: '', addEventListener() {}, focus() {} };
    w.csxDialogOpen = o => { last = o; return { querySelector: s => s === '#csxComposerIn' ? ta : null }; };
    w.csxComposerOpen(); ta.value = 'half a thought'; last.onClose();
    const ta2 = { value: '', addEventListener() {}, focus() {} }; w.csxDialogOpen = o => { last = o; return { querySelector: () => ta2 }; };
    w.csxComposerOpen();
    const kept = ta2.value;
    ta2.value = '   '; last.onClose(); const ta3 = { value: '', addEventListener() {}, focus() {} }; w.csxDialogOpen = o => ({ querySelector: () => ta3 }); w.csxComposerOpen();
    ok(kept === 'half a thought' && ta3.value === '', '6 closing the composer with text keeps the draft for the next New post (an empty box keeps nothing)');
  }
}

/* ═══ 7. Settings ═══ */
{
  const sl = grab(js, 'csxSettingsLayout');
  ok(/so\.querySelectorAll\('\.sp-tabs \.sp-tab'\)\.forEach\(function\(t\)\{ t\.classList\.add\('csx-subnav-item'\); nav\.appendChild\(t\); \}\);/.test(sl) && /nav\.className = 'csx-subnav'/.test(sl) && /body\.classList\.add\('csx-panel'\)/.test(sl) && /csxWrap\('renderSettingsPanel'/.test(js), '7 the existing tabs become the left subnav (same spSetTab buttons), the body becomes the panel');
  ok(/#settingsOverlay\.csx-settings\.open:has\(> \.csx-subnav\) \{ display: grid; grid-template-columns: 200px minmax\(0, 720px\)/.test(css), '7 subnav 200 + panel 720');
  // the Workspace tab must sit inside .sp-body, and the template must balance
  const rs = html.slice(html.indexOf('\nfunction renderSettingsPanel('), html.indexOf('\n  // Render community tags after innerHTML is set', html.indexOf('\nfunction renderSettingsPanel(')));
  const tpl = rs.slice(rs.indexOf('<div class="sp-body">'));
  let d = 0, wsDepth = null, minD = 1e9;
  const re = /<div\b|<\/div>|display:\$\{spActiveTab==='workspace'/g; let mm;
  while ((mm = re.exec(tpl))) { if (mm[0] === '<div') d++; else if (mm[0] === '</div>') { d--; minD = Math.min(minD, d); } else if (wsDepth === null) wsDepth = d; }
  ok(wsDepth === 2 && d === 0 && minD >= 0, '7 the Workspace tab is rendered INSIDE .sp-body (audit #1) and the template balances (depth ' + wsDepth + ', end ' + d + ', min ' + minD + ')');
}

/* ═══ 8. phones unchanged ═══ */
{
  const body = css.replace(/^<style id="csx-layout">/, '').replace(/<\/style>$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const tops = []; { let dd = 0, st = 0; for (let i = 0; i < body.length; i++) { const ch = body[i]; if (ch === '{') { if (dd === 0) st = i; dd++; } else if (ch === '}') { dd--; if (dd === 0) { tops.push({ head: body.slice(body.lastIndexOf('}', st) + 1, st).trim(), inner: body.slice(st + 1, i) }); } } } }
  const badTop = tops.filter(t => !/^@media \(min-width: (900|1100)px\)$/.test(t.head) && t.head !== '@media (max-width: 899.98px)');
  ok(tops.length >= 3 && !badTop.length, '8 every csx-layout rule sits in a min-width 900/1100 block' + (badTop.length ? ' — stray: ' + badTop.map(t => t.head).join(' | ') : ''));
  const ph = tops.filter(t => t.head === '@media (max-width: 899.98px)').map(t => t.inner).join('');
  ok(/^\s*\.csx-toolbar, \.csx-newpost, \.csx-list, \.csx-detail, #csxDetail \{ display: none !important; \}\s*$/.test(ph), '8 the only phone rule HIDES the desktop pieces');
  const guarded = ['csxToolbarSync', 'csxRenderMD', 'csxRenderDetail', 'csxSettingsLayout', 'csxOnKey', 'csxOnView'];
  ok(guarded.every(n => /^function \w+\([^)]*\)\{\n  if \(!csxIsDesk\(\)/.test(grab(js, n))), '8 every entry point returns at once below 900px (' + guarded.join(', ') + ')');
  ok(/var w = function\(\)\{ var r = orig\.apply\(this, arguments\); try \{ if \(csxIsDesk\(\)\) after\.apply\(this, arguments\); \} catch \(e\) \{\} return r; \};/.test(grab(js, 'csxWrap')), '8 the wrapped renderers run unchanged and only add desktop work at ≥900px');
  // run the entry points on a "phone": touching the document is a failure
  const w = world({}, false, false);
  w.document = new Proxy({}, { get: (_, k) => { throw new Error('phone touched document.' + String(k)); } });
  let threw = null; try { w.csxOnView('ideas'); w.csxToolbarSync(); w.csxRenderMD('ideas'); w.csxRenderDetail('ideas'); w.csxSettingsLayout(); w.csxOnKey({ key: 'a' }); } catch (e) { threw = e.message; }
  ok(threw === null, '8 below 900px the entry points do nothing' + (threw ? ' — ' + threw : ''));
  ok(/try \{ if \(typeof csxOnView === 'function'\) csxOnView\(view\); \} catch \(e\) \{\}/.test(grab(html, 'csShellSync')), '8 the shell hook is a guarded call');
  ok(/\.generic-toast\.csx-toast \{ left: auto !important; right: 16px !important; top: auto !important; bottom: 16px !important;/.test(css) && /toast\.className = 'generic-toast csx-toast'/.test(grab(html, '_drainToasts')), '9 toasts carry .csx-toast and sit bottom-right on desktop only');
}

/* ═══ 9. upgrade card wording ═══ */
{
  const run = info => {
    let el = null;
    const c = { csUsage: null, planLabel: p => p, CS_PAY_ISSUE_LINE: '', showManageBilling() {}, document: { getElementById: id => id === 'csUpgradeOverlay' ? null : null, createElement: () => ({ set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h; } }), body: { appendChild: e => { el = e; } } } };
    vm.createContext(c); vm.runInContext(grab(html, 'showUpgrade'), c); c.showUpgrade(info);
    return (/class="cs-upgrade-title">([^<]*)</.exec(el.innerHTML) || [])[1];
  };
  ok(run({ plan: 'trial', used: 20, limit: 150 }) === 'Keep going after your trial', '9 trial, opened by hand under the limit: no "hit your trial limit"');
  ok(run({ plan: 'trial', used: 150, limit: 150, error: 'limit_reached' }) === 'You’ve hit your trial limit' && run({ plan: 'trial', error: 'limit_reached' }) === 'You’ve hit your trial limit', '9 the 402 "limit_reached" path keeps its message');
  ok(run({ plan: 'free', used: 40, limit: 40 }) === 'Your free posts are used up' && run({ plan: 'free', used: 3, limit: 40 }) === 'Upgrade your plan', '9 free plan: used up only when it is');
}

finished = true;
if (fail) { console.log('\nDESKTOP NATIVE FAILED (' + fail + ')'); process.exit(1); }
console.log('\nDESKTOP NATIVE OK');
