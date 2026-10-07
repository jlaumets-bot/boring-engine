#!/usr/bin/env node
// GATE (v701 desktop layout): the ≥900px ChatGPT-desktop shape — LOOK and layout only.
// EXECUTED where it can be: the real functions are lifted from app.html and run in node:vm.
//   1  every destination of the old content header row (brand switcher, Bookmarks, Brand brain, Settings,
//      Help) and every screen is reachable from the desktop sidebar; the sidebar's brand row calls the SAME
//      function as the header brand; the brand dropdown anchors to the sidebar row on desktop.
//   2  column max-widths (Ideas 1040, Pipeline 880, Quick Post / Remix / Idea Catcher / Notebook 760,
//      Settings 880); 1 idea column at 900–1099, 2 at ≥1100; the header row is hidden only at ≥900.
//   3  Ideas: on desktop the Approve / Skip pills ARE the existing ✓ / ✕ buttons (same handlers), labelled.
//   4  Pipeline: a "Read script" button on Film & Post cards opens openTeleprompter(<that idea>) for exactly
//      the formats the opened post offers the teleprompter for; Mark done stays; desktop-only.
//   5  csUsageText never prints "undefined": no numbers → the plan name only.
//   6  no "▶ " / "▼ " marker before idea or pipeline titles; a missing format label falls back to the format.
//   7  phones unchanged: every §7 rule in clean.css sits inside a min-width ≥900px media block, and the new
//      desktop-only pieces are hidden by default in app.html. (The rendered before/after phone measurements
//      live in .unlazy/redesign/phone-measure.json, taken with Playwright.)
// RUN: node scripts/verify/desktop-layout.mjs      EXPECT: prints "DESKTOP LAYOUT OK", exit 0.
import fs from 'node:fs'; import vm from 'node:vm';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'clean.css'), 'utf8');
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
const between = (src, a, b) => { const i = src.indexOf(a); const j = src.indexOf(b, i + a.length); if (i < 0 || j < 0) throw new Error('marker missing: ' + a.slice(0, 50)); return src.slice(i, j + b.length); };
const escHtml = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ═══ 1. sidebar holds every destination ═══ */
let sidebar = '';
{
  let built = null;
  const c = { window: { APP_VERSION: 'vT' }, escHtml, DS_ICONS: {}, syncDesktopNav() {}, renderUsagePill() {},
    document: { getElementById: () => null, querySelector: () => ({ textContent: 'Acme Co' }), createElement: () => ({ innerHTML: '' }), body: { appendChild: e => { built = e; } } } };
  vm.createContext(c);
  vm.runInContext(between(html, 'var CS_DRAWER_ICONS = {', '\n};') + '\n' + grab('_dsItem') + '\n' + grab('buildDesktopSidebar'), c);
  c.buildDesktopSidebar();
  sidebar = built ? built.innerHTML : '';
  ok(built && built.id === 'desktopSidebar' && sidebar.length > 500, '1 the desktop sidebar builds');
  const calls = new Set([...sidebar.matchAll(/onclick="([A-Za-z_$][\w$]*)\(/g)].map(m => m[1]));
  const views = new Set([...sidebar.matchAll(/switchView\('(\w+)'\)/g)].map(m => m[1]));
  // the old content header row, read live from the markup that is still in app.html
  const hdr = between(html, '<div class="header">', '<div class="csd-wrap"');
  const hdrActs = [...between(hdr, '<div class="header-actions">', '</div>').matchAll(/onclick="(\w+)\(/g)].map(m => m[1]);
  const brandAct = (/id="headerBrand" onclick="(\w+)\(\)"/.exec(hdr) || [])[1];
  ok(hdrActs.length === 4 && brandAct === 'toggleBrandSwitcher', '1 read the old header row: ' + [brandAct, ...hdrActs].join(', '));
  const missing = [brandAct, ...hdrActs].filter(a => !calls.has(a));
  ok(missing.length === 0, '1 every old header-row destination is in the sidebar' + (missing.length ? ' — missing ' + missing : ''));
  ok(['today', 'ideas', 'pipeline', 'create', 'idea', 'viral', 'notebook', 'questions'].every(v => views.has(v)) && calls.has('bvTabClick') && calls.has('csCheckUpdate')
    && ['/terms.html', '/privacy.html', '/refunds.html'].every(h => sidebar.includes('href="' + h + '"')), '1 every screen, the coach, the update check and the legal links are there');
  ok(/<button type="button" class="ds-brand" id="dsBrand"[^>]*onclick="toggleBrandSwitcher\(\)">[\s\S]*?id="dsBrandName">Acme Co</.test(sidebar) && sidebar.indexOf('id="dsBrand"') < sidebar.indexOf('ds-item'), '1 the brand switcher is the first row and calls the SAME toggleBrandSwitcher, showing the brand name');
  ok(/class="brand-switcher-wrap ds-brand-wrap"/.test(sidebar), '1 it sits in a .brand-switcher-wrap, so the dropdown\'s outside-click closer ignores it');
  const toolsIdx = sidebar.indexOf('>Tools<'), springIdx = sidebar.indexOf('ds-spring');
  ok(toolsIdx > 0 && sidebar.indexOf('data-act="toggleBookmarkBar"') > toolsIdx && sidebar.indexOf('data-act="openBrain"') > toolsIdx && sidebar.indexOf('data-act="openBrain"') < springIdx, '1 Bookmarks and Brand brain are in the Tools group');
  const bottom = sidebar.slice(springIdx);
  ok(/ds-coach/.test(bottom) && /data-act="openSettings"/.test(bottom) && /data-act="startTour"/.test(bottom) && /id="dsPlan"/.test(bottom), '1 bottom: coach, Settings, Help, plan row');
  // the dropdown anchors to the sidebar row on desktop, to the header brand on phones
  const pos = (dsW) => {
    const dd = { offsetWidth: 240, style: {} };
    const ds = { getBoundingClientRect: () => ({ left: 10, bottom: 54, width: dsW }) };
    const hb = { getBoundingClientRect: () => ({ left: 90, bottom: 50, width: 196 }) };
    const c2 = { window: { innerWidth: 1440 }, Math, document: { getElementById: id => ({ brandDropdown: dd, dsBrand: ds, headerBrand: hb })[id] || null } };
    vm.createContext(c2); vm.runInContext(grab('positionBrandDropdown'), c2); c2.positionBrandDropdown(); return dd.style;
  };
  ok(pos(240).top === '60px' && pos(240).left === '10px', '1 desktop: the brand dropdown opens under the sidebar row');
  ok(pos(0).top === '56px' && pos(0).left === '90px', '1 phone (sidebar hidden): it still opens under the header brand');
  ok(/try \{ const ds = document\.getElementById\('dsBrandName'\); if \(ds\) ds\.textContent = name \|\| 'Your Brand'; \} catch \(e\) \{\}/.test(grab('setHeaderBrand')), '1 a brand switch renames the sidebar row too');
}

/* ═══ clean.css §7 ═══ */
const s7 = css.slice(css.indexOf('/* ============ 7. desktop layout'));
ok(s7.length > 1000 && css.indexOf('/* ============ 7. desktop layout') > css.indexOf('/* ============ 6.'), '§7 is a section at the end of clean.css');
// split §7 into its top-level blocks (comments stripped)
const s7c = s7.replace(/\/\*[\s\S]*?\*\//g, '');
const blocks = []; { let d = 0, st = 0; for (let i = 0; i < s7c.length; i++) { const ch = s7c[i]; if (ch === '{') { if (d === 0) st = i; d++; } else if (ch === '}') { d--; if (d === 0) { const head = s7c.slice(s7c.lastIndexOf('}', st) + 1, st).trim(); blocks.push({ head, body: s7c.slice(st + 1, i) }); } } } }
const inMin = (b, px) => new RegExp('^@media \\(min-width: ' + px + 'px\\)$').test(b.head);
const desk = blocks.filter(b => inMin(b, 900)).map(b => b.body).join('\n');
const wide = blocks.filter(b => inMin(b, 1100)).map(b => b.body).join('\n');

/* ═══ 2. columns ═══ */
{
  const mw = sel => { const m = new RegExp('(?:^|\\n)\\s*' + sel.replace(/[#.()-]/g, c => '\\' + c) + '[^{]*\\{[^}]*max-width:\\s*(\\d+)px').exec(desk); return m ? +m[1] : null; };
  ok(mw('#view-ideas') === 1040, '2 Ideas column 1040');
  ok(/#view-pipeline, #view-viral, #view-questions \{ max-width: 880px; \}/.test(desk), '2 Pipeline column 880');
  ok(/#view-today, #view-create, #view-idea, #view-notebook, #view-dfy \{ max-width: 760px; \}/.test(desk), '2 Quick Post, Remix, Idea Catcher, Notebook 760');
  ok(/#settingsOverlay \.sp-header, #settingsOverlay \.sp-body \{ max-width: 880px !important; \}/.test(desk), '2 Settings 880');
  ok(/#mainViews \{ max-width: none !important; margin: 0 !important; padding: 24px 32px 0;/.test(desk), '2 32px side / 24px top padding');
  ok(/\.header-top \{ visibility: hidden; height: 0 !important;/.test(desk) && /#brandDropdown \{ visibility: visible; \}/.test(desk) && /backdrop-filter: none !important/.test(desk), '2 the content header row is gone on desktop; its dropdown can still open');
  ok(/#ideaContent > div \{ grid-template-columns: 1fr !important; \}/.test(desk) && /#ideaContent > div \{ grid-template-columns: 1fr 1fr !important; \}/.test(wide), '2 one idea column at 900–1099, two at ≥1100');
  ok(/body\[data-cs-view="ideas"\] \.cs-composer-box \{ max-width: 1040px; \}/.test(desk) && /body\[data-cs-view\] \.cs-composer \{ left: 260px !important;/.test(desk), '2 the composer is pinned at the column\'s width');
  ok(/\.cs-page-title \{ margin: 0; font-size: var\(--cs-fs-screen\);/.test(desk) && /var CS_PAGE_TITLES = \{ today: 'Quick Post', ideas: 'Ideas', pipeline: 'Pipeline', create: 'Remix'/.test(html), '2 a page title per screen');
}

/* ═══ 3. Approve / Skip ═══ */
{
  const ri = grab('renderIdeas');
  const a = /<button class="action-circle approve" onclick="quickApprove\(\$\{idea\.id\}\)"[^>]*>(?:(?!<\/button>)[\s\S])*?<span class="cs-act-lbl" aria-hidden="true">Approve<\/span><\/button>/.test(ri);
  const s = /<button class="action-circle dismiss" onclick="showDismissPopupFn\(\$\{idea\.id\}\)"[^>]*>(?:(?!<\/button>)[\s\S])*?<span class="cs-act-lbl" aria-hidden="true">Skip<\/span><\/button>/.test(ri);
  ok(a && s, '3 the Approve / Skip pills are the same buttons with the same handlers (quickApprove, showDismissPopupFn)');
  ok((ri.match(/quickApprove\(/g) || []).length === 1 && (ri.match(/showDismissPopupFn\(/g) || []).length === 1 && (ri.match(/class="cs-act-lbl"/g) || []).length === 2, '3 no second approve / dismiss control was added');
  ok(/#ideaContent \.list-actions \.action-circle \.cs-act-lbl \{ display: inline; \}/.test(desk) && /\.list-actions \.action-circle \.cs-act-lbl \{ display: none; \}/.test(html), '3 the labels show on desktop only');
  ok(/#ideaContent \.list-card-top \{ flex-direction: column;/.test(desk), '3 on desktop the actions sit under the text');
}

/* ═══ 4. Read script ═══ */
{
  const c = { STAGES: ['filming', 'done'], STAGE_LABELS: { filming: 'Film & Post', done: 'Done' }, STAGE_ICONS: {}, STAGE_NEXT: { filming: 'done' }, STAGE_PREV: { done: 'filming' },
    FORMAT_LABELS: { video: 'Video', carousel: 'Carousel', statement: 'Statement', micro: 'Micro-Lecture', qna: 'Q&A' }, ICO: { undo: '' }, expandedIds: new Set(), activePipelineStage: 'filming',
    escHtml, escAttr: escHtml, asText: x => String(x || ''), getInitials: () => 'X', renderDetailContent: () => '', renderEmptyState: () => 'EMPTY', Date, Set,
    state: [{ id: 0, title: 'A', format: 'video', status: 'filming', day: 'Monday' }, { id: 1, title: 'B', format: 'carousel', status: 'filming', day: 'Monday' },
      { id: 2, title: 'C', format: 'statement', status: 'filming', day: 'Monday' }, { id: 3, title: 'D', format: 'qna', status: 'filming', day: 'Monday' }] };
  const els = { pipelineStages: { innerHTML: '' }, pipelineContent: { innerHTML: '' } };
  c.document = { getElementById: id => els[id] || null };
  vm.createContext(c);
  vm.runInContext(between(html, 'var CS_READ_FORMATS', ';') + '\n' + grab('renderPipeline'), c);
  c.renderPipeline();
  const cards = els.pipelineContent.innerHTML.split('<div class="pipeline-card">').slice(1);
  const read = cards.map(h => (/<button class="pipe-btn cs-read-btn" onclick="openTeleprompter\((\d+)\)">Read script<\/button>/.exec(h) || [])[1]);
  ok(cards.length === 4 && read[0] === '0' && read[2] === '2' && read[3] === '3' && read[1] === undefined, '4 "Read script" opens openTeleprompter(<that card\'s idea>) for video / statement / Q&A, not for a carousel');
  ok(cards.every(h => /class="pipe-btn next" onclick="pipeAdvance\(event,\d+,'done'\)">Mark done</.test(h) && /pipe-undo/.test(h) && /toggleAssignPopup/.test(h)), '4 Mark done, undo and Assign stay on every card');
  ok(cards.every(h => h.indexOf('cs-read-btn') < 0 || h.indexOf('cs-read-btn') < h.indexOf('pipe-btn next')), '4 Read script comes first');
  ok(/var CS_READ_FORMATS = \['video', 'micro', 'qna', 'statement'\];/.test(html), '4 the same formats the opened post offers the teleprompter for');
  const ot = grab('openTeleprompter');
  ok((ot.match(/tpOpenMode\(\)/g) || []).length >= 2, '4 openTeleprompter ends in tpOpenMode() — desktop gets Read mode');
  ok(/\.pipeline-card \.pipe-btn\.cs-read-btn \{ display: none !important; \}/.test(html) && /\.pipeline-card \.pipe-btn\.cs-read-btn \{ display: inline-flex !important; background: var\(--cs-primary\)/.test(desk), '4 desktop-only primary; Mark done turns secondary next to it');
  ok(/\.pipeline-stage-tab \{ flex: none !important; flex-direction: row !important; height: 44px;[\s\S]{0,200}border-top: 4px solid transparent !important; border-bottom: 4px solid transparent !important; background-clip: padding-box !important;/.test(desk), '4 compact segmented control: a 36px painted segment in a 44px tap area');
}

/* ═══ 5. csUsageText ═══ */
{
  const run = u => { const c = { csUsage: u, isFinite }; vm.createContext(c); vm.runInContext(grab('planLabel') + '\n' + grab('csUsageText'), c); return c.csUsageText(); };
  ok(run({ plan: 'pro' }) === 'Pro' && run({ plan: 'trial', trialDaysLeft: 3 }) === 'Trial' && run({ plan: 'free', used: 5 }) === 'Free' && run({ plan: 'pro', used: null, limit: 750 }) === 'Pro', '5 missing numbers → the plan name only');
  ok(!/undefined|null|NaN/.test([run({ plan: 'pro' }), run({ plan: 'x', used: undefined, limit: undefined })].join()), '5 never "undefined"');
  ok(run({ plan: 'pro', used: 12, limit: 750 }) === 'Pro · 12/750 this month' && run({ plan: 'free', used: 3, limit: 40 }) === 'Free · 3/40 · Upgrade' && run({ plan: 'trial', trialDaysLeft: 2, used: 1, limit: 150 }) === 'Trial · 2 days left · 1/150', '5 with numbers the text is unchanged');
}

/* ═══ 6. no ▶ prefix ═══ */
{
  const ri = grab('renderIdeas'), rp = grab('renderPipeline');
  ok(!/\\u25B6|\\u25BC|▶|▼/.test(ri + rp), '6 no ▶ / ▼ marker before idea or pipeline titles');
  ok(/<div class="list-card-title">\$\{escHtml\(idea\.title\)\}<\/div>/.test(ri) && /<div class="pipeline-card-title" style="padding-right:50px">\$\{escHtml\(idea\.title\)\}<\/div>/.test(rp), '6 titles are the escaped title alone');
  ok(/\$\{escHtml\(FORMAT_LABELS\[idea\.format\] \|\| idea\.format \|\| ''\)\}/.test(ri) && /\.format-tag:empty \{ display: none; \}/.test(desk), '6 every card has a format chip (label, else the format itself)');
}

/* ═══ 7. phones unchanged ═══ */
{
  const stray = blocks.filter(b => !inMin(b, 900) && !inMin(b, 1100));
  ok(blocks.length >= 2 && stray.length === 0, '7 every §7 rule sits inside a min-width ≥900px media block' + (stray.length ? ' — stray: ' + stray.map(b => b.head).join(' | ') : ''));
  ok(/\n\.cs-page-head \{ display: none; \}/.test(html), '7 the page title is hidden by default (shown only at ≥900px)');
  const shell = html.slice(html.indexOf('<style>'), html.indexOf('</style>\n<!-- v699: the clean theme'));
  const hideIdx = shell.indexOf('.list-actions .action-circle .cs-act-lbl { display: none; }');
  const before = shell.slice(0, hideIdx); const openMedia = (before.match(/@media[^{]*\{/g) || []).length; const lastMediaOpen = before.lastIndexOf('@media');
  ok(hideIdx > 0 && (lastMediaOpen < 0 || before.slice(lastMediaOpen).split('{').length - 1 <= before.slice(lastMediaOpen).split('}').length - 1), '7 the label / Read script hide rules are top-level (apply on phones)');
  let pm = null; try { pm = JSON.parse(fs.readFileSync(path.join(ROOT, '.unlazy', 'redesign', 'phone-measure.json'), 'utf8')); } catch (e) {}
  if (pm) ok(['header', 'menu', 'pencil', 'brand', 'card', 'approve', 'dismiss', 'composer', 'ideasHead', 'pipeNext', 'qpBtn'].every(k => JSON.stringify(pm.before[k]) === JSON.stringify(pm.after[k])), '7 recorded 375px measurements: header, ☰, pencil, brand, card, ✓/✕, composer, Mark done, Quick Post button unchanged');
  else console.log('note: .unlazy/redesign/phone-measure.json not present (it is not shipped) — measurement check skipped');
}

finished = true;
if (fail) { console.log(`\n${fail} FAILED`); process.exit(1); }
console.log('\nDESKTOP LAYOUT OK');
