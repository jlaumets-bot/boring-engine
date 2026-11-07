#!/usr/bin/env node
// GATE (v717, app-wide style phases 2+3, owner-approved mockups design-options/appwide/ 5–10, 2026-11-07). EXECUTED: the real v717
// block (aw2*), the real v716 block (aw*) and the real hybrid block (hy*) are lifted out of app.html and run in node:vm against a
// fake DOM, spies and a stubbed fetch. No network, no AI.
//   1  Trends (5): groups Rising now / This week / Earlier, one calm row per trend (shared .aw-row/.aw-rt/.aw-tag), a source chip
//      (Google News / X / TikTok / Competitor / Added by you) and an age; "Pull fresh trends" = the existing pullWebTrends.
//   2  a Trends row → the MAIN chat (view 'create', the hy thread) as a typed idea: the six idea pills, "From Trends · <source>",
//      nothing sent until a pill is picked; the row ⋯ keeps dismiss / remove / "see the post" / remixTopPost.
//   3  What people search (7): grouped by keyword with "N new", chips People also ask / Related, "Answered"; a question → the
//      chat with Q&A lit; a version made from it marks it answered (paaUsed); "Find more questions" = fetchPAAQuestions(true);
//      the row ⋯ keeps paaAnswerV2 (and every format).
//   4  Notebook (8): Today / Yesterday / Earlier this week / Earlier, time, voice length, "Used in a post"; a note's page → "Make
//      it yours" opens the chat; Edit saves through saveNotebookToDB; Delete asks once, then nbDelete; Develop / voice rule kept;
//      New note moves the old capture box (nbSaveNote + nbToggleMic) in and back; a save keeps the voice length.
//   5  Creators (9): ≤5 TikTok creators (the ONE creator rule), "New today · 4.2× usual" from the feed, "N spots left", every
//      other bookmark under "Other bookmarks"; "+ Add creator" respects the cap and runs fpAdd; ⋯ links / edit / remove.
//   6  Settings (10): one page, Brand / Content / Account rows, values, legal links + version in the footer; each row opens the
//      existing panel (the old Settings, one section) and the old ways in (openBrain, openContentMix …) land on their part.
//   7  Coach (6): the brand-brain strip ("Brand brain 72%", "N left to fill", gap chips → bvAskField); typing still sends through
//      bvSendTyped → bvSend; the mic button is still bvToggleMic.
//   8  XSS: trend text, question, note, creator note, bookmark / category names with markup are escaped everywhere they render.
//   9  nothing previously reachable is lost: the old functions of each screen are behind a row, a ⋯ item or "Classic view".
//  10  wiring + shared CSS: hosts, hide rules, dock on the four screens, the v716 pieces reused (no look-alike rules).
// RUN: node scripts/verify/appwide-p23-v717.mjs        EXPECT: "APPWIDE P23 OK", exit 0.
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
const between = (a, b, from) => { const i = html.indexOf(a, from || 0); const j = html.indexOf(b, i); if (i < 0 || j < 0) throw new Error('marker missing: ' + a.slice(0, 40)); return html.slice(i, j); };
const line = re => { const m = re.exec(html); if (!m) throw new Error('missing ' + re); return m[0]; };
const tick = async (n = 14) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const vis = h => String(h).replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, m => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[m] || ' ')).replace(/\s+/g, ' ').trim();
const J = JSON.stringify;

// ── fake DOM ──
const els = {};
function mk(id) {
  const attrs = {}; const cls = new Set();
  const e = { id, value: '', textContent: '', hidden: false, style: { setProperty() {} }, scrollTop: 0, kids: [],
    focus() {}, scrollIntoView() {}, setSelectionRange() {}, addEventListener() {},
    appendChild(n) { e.kids.push(n); n.parent = e; return n; }, insertBefore(n, ref) { e.kids.push(n); n.parent = e; n.before = ref; return n; },
    querySelector(sel) { return sel === '.nb-capture' ? (e.kids.find(k => k.isCapture) || null) : null; },
    setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return k in attrs ? attrs[k] : null }, removeAttribute(k) { delete attrs[k]; }, hasAttribute(k) { return k in attrs; },
    classList: { add: (...x) => x.forEach(y => cls.add(y)), remove: (...x) => x.forEach(y => cls.delete(y)), toggle: (x, on) => { if (on === undefined ? !cls.has(x) : on) cls.add(x); else cls.delete(x); }, contains: x => cls.has(x) } };
  return e;
}
function host(id) {
  const e = mk(id); els[id] = e; let h = ''; let kids = [];
  Object.defineProperty(e, 'innerHTML', { get: () => h, set: v => {
    h = String(v); for (const k of kids) delete els[k]; kids = [];
    for (const m of h.matchAll(/<(\w+)([^>]*?) id="([^"]+)"([^>]*)>/g)) { const k = mk(m[3]); kids.push(m[3]); els[m[3]] = k; if (/ hidden[ >]/.test(m[0])) k.hidden = true; }
  } });
  return e;
}
['awTrends', 'awSearch', 'awNotesHead', 'awNotesCap', 'awNotesBody', 'awCreators', 'awIdeas', 'awPipe', 'awDetail', 'awDock', 'settingsOverlay',
  'hyApp', 'hyMain', 'hyBar', 'hyHint', 'hyInLbl', 'hySend', 'hyNewBtn', 'hyDock', 'bvHome', 'trendPullStatus', 'view-notebook', 'nbList'].forEach(host);
els.hyIn = mk('hyIn'); els.hyIn.setAttribute('placeholder', 'Paste a link or type an idea…');
els.bvTextInput = mk('bvTextInput');
const capture = mk('capture'); capture.isCapture = true; els['view-notebook'].appendChild(capture);
const body = mk('body');
// ── stubs / spies ──
let calls = [], route = null, toasts = [], spy = [], rendered = 0;
const store = new Map();
const now = Date.now(), H = 36e5, DAY = 864e5;
const XSS = '<img src=x onerror=alert(1)>';
const c = {
  console: { log() {}, warn() {}, error() {}, info() {} }, JSON, Promise, Date, Math, String, Number, Array, Object, Set, Map, RegExp, Error, TypeError, isFinite, parseInt, encodeURIComponent, URL, setTimeout, clearTimeout,
  scrollTo() {}, innerWidth: 390, innerHeight: 844, addEventListener() {}, requestAnimationFrame: f => f(), _remixDelivery: null, matchMedia: () => ({ matches: false }), APP_VERSION: 'v716',
  localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
  navigator: { clipboard: { readText: () => Promise.reject(new Error('no')), writeText: () => Promise.resolve() } },
  document: { getElementById: id => els[id] || null, querySelector: s => (s === '#view-notebook .nb-capture' ? (els['view-notebook'].kids.find(k => k.isCapture) || null) : null), querySelectorAll: () => [], activeElement: null, body,
    documentElement: { scrollHeight: 2000, style: { setProperty() {} } }, addEventListener() {}, createElement: () => mk('x') },
  fetch: async (url, opt) => { const b = opt && opt.body ? JSON.parse(opt.body) : null; calls.push({ url, body: b }); return route(url, b); },
  currentBrand: { id: 'b1', auto_trends: { at: now - 2 * H, items: [{ text: 'Studios moving off spreadsheets', source: 'Reuters' }],
    competitorMoves: '- **Monday.com** launched an AI planner (https://monday.com/blog). ' + XSS, compAt: now - 5 * DAY } },
  activeView: 'viral', remixes: [], settings: { brandName: 'Acme', openSections: {}, formatMix: {} },
  showToast: (...a) => toasts.push(a), saveRemixes() {}, renderRemixResults() {}, humanErr: (m, f) => m || f,
  getBrandContext: () => ({ brandName: 'Acme' }), deliveryReq: () => 'face', deliveryUi: () => 'face', DELIVERY_FORMATS: new Set(['video']),
  leanBrandFetch: (url, base, full) => { if (typeof full !== 'function') throw new Error('no full-brand fallback'); return c.fetch(url, { body: JSON.stringify(base) }); },
  setRemixSource() {}, extractArticle: async () => {}, remixSetSource() {}, listLoadFailed: () => false, getTodayName: () => 'Monday',
  // the screens' existing functions (spies)
  switchView: v => { spy.push(['switchView', v]); c.activeView = v; },
  getAutoTrends: () => [{ text: 'Studios moving off spreadsheets', ts: now - 2 * H, hot: true, link: 'https://news.google.com/rss/a' },
    { text: 'Rising ' + XSS, ts: now - 3 * DAY, hot: false, link: 'https://x.com/someone/status/1' }],
  getTopPosts: () => [{ text: 'I run a 6-person studio and we stopped using Asana.', link: 'https://www.tiktok.com/@studioops/video/1', handle: 'studioops', ts: now - 20 * DAY }],
  getTrendStore: () => [{ text: 'Cold plunge and electrolytes', ts: now - 30 * DAY }],
  dismissAutoTrend: t => spy.push(['dismissAutoTrend', t]), removeTrend: (ts, t) => spy.push(['removeTrend', ts, t]), remixTopPost: i => spy.push(['remixTopPost', i]),
  pullWebTrends: async () => { spy.push(['pullWebTrends']); els.trendPullStatus.textContent = 'Sources came back empty this time — try again in a minute.'; },
  vlTab: t => spy.push(['vlTab', t]), renderTrendMemory: () => { rendered++; }, renderPAASection: () => { rendered++; },
  paaQuestions: [{ question: 'Do electrolytes break a fast?', keyword: 'electrolytes' }, { question: 'Q ' + XSS, keyword: 'electrolytes', source: 'Related' },
    { question: 'How do I know if I am dehydrated?', keyword: 'Hydration' }],
  paaUsed: new Set(['how do i know if i am dehydrated?']), paaLoading: false, savePAAState: () => spy.push(['savePAAState']),
  fetchPAAQuestions: f => spy.push(['fetchPAAQuestions', f]), paaAnswerV2: (i, f) => spy.push(['paaAnswerV2', i, f]), spScrollToField: k => spy.push(['spScrollToField', k]),
  notebookNotes: [], _nbRec: null, renderNotebook: () => { rendered++; }, saveNotebookToDB: async () => { spy.push(['saveNotebookToDB']); return { ok: true }; }, _warnSaveFailed: () => spy.push(['warn']),
  nbDelete: id => spy.push(['nbDelete', id]), nbDevelopV2: id => spy.push(['nbDevelopV2', id]), nbSaveAsRule: id => spy.push(['nbSaveAsRule', id]),
  nbToggleMic: () => { spy.push(['nbToggleMic']); c._nbRec = c._nbRec ? null : { state: 'recording' }; return Promise.resolve(); },
  nbSaveNote: () => { spy.push(['nbSaveNote']); c.notebookNotes.unshift({ id: 'nbNEW', text: 'Spoken note', createdAt: Date.now() }); c.renderNotebook(); },
  bookmarkCategories: [], rerenderBookmarks: () => { rendered++; }, cfRender: () => {}, cfRefresh: () => spy.push(['cfRefresh']),
  fpAdd: p => { spy.push(['fpAdd', p]); return true; }, deleteBmEntry: (a, b) => spy.push(['deleteBmEntry', a, b]), closeBookmarks: () => spy.push(['closeBookmarks']),
  toggleBookmarkBar: () => spy.push(['openBookmarks-sheet']), _bmEditingEntry: null,
  getBrandCompleteness: () => ({ pct: 72 }), allBrands: [{ id: 'b1' }, { id: 'b2' }], teamMembers: [{ user_id: 'u2' }], currentUser: { id: 'u1' },
  typesMix: () => ({}), typesMixTotal: () => 7, lsGet: k => ({ 'daily-push-on': '1', 'daily-push-hour': '8' }[k] || null), csResolveTheme: () => 'dark',
  csUsage: { plan: 'pro', used: 312, limit: 750 }, csUsageLoadFailed: false,
  openBillingPortal: () => spy.push(['openBillingPortal']), showUpgrade: () => spy.push(['showUpgrade']), startTour: () => spy.push(['startTour']),
  handleLogout: () => spy.push(['handleLogout']), toggleDarkMode: on => spy.push(['toggleDarkMode', on]),
  spActiveTab: 'voice',
  renderSettingsPanel: () => { spy.push(['renderSettingsPanel', c._aw2 && c._aw2.sp]); els.settingsOverlay.innerHTML = '<div class="sp-header"><button class="sp-back" onclick="toggleSettings()">Back</button><h2>Settings</h2></div>'; },
  openSettings: () => { spy.push(['openSettings']); els.settingsOverlay.classList.add('open'); c.renderSettingsPanel(); },
  toggleSettings: () => { const o = els.settingsOverlay.classList.contains('open'); spy.push(['toggleSettings', !o]); if (o) els.settingsOverlay.classList.remove('open'); else { els.settingsOverlay.classList.add('open'); c.renderSettingsPanel(); } },
  openBrain: () => { spy.push(['openBrain']); if (els.settingsOverlay.classList.contains('open')) c.renderSettingsPanel(); else c.toggleSettings(); },
  openSettingsToBookmarks: () => { spy.push(['openSettingsToBookmarks']); if (!els.settingsOverlay.classList.contains('open')) c.toggleSettings(); c.spSetTab('workspace'); },
  openSettingsToTeam: () => { spy.push(['openSettingsToTeam']); if (!els.settingsOverlay.classList.contains('open')) c.toggleSettings(); },
  openContentMix: () => { spy.push(['openContentMix']); c.openSettings(); c.renderSettingsPanel(); },
  spSetTab: t => { spy.push(['spSetTab', t]); c.renderSettingsPanel(); }, toggleSection: k => { spy.push(['toggleSection', k]); c.renderSettingsPanel(); },
  brainCoverage: () => ({ pct: 72, missing: ['painPoints', 'avoidWords', 'originStory', 'ctaStyle'] }), _brainLabel: k => ({ painPoints: 'Pain points', avoidWords: 'Words to avoid', originStory: 'Your story' }[k] || k),
  bvState: { onboardingMode: false }, bvRenderHome: () => spy.push(['bvRenderHome']), bvAskField: k => spy.push(['bvAskField', k]), bvSend: t => spy.push(['bvSend', t]),
  closeBrandVoice: () => spy.push(['closeBrandVoice']),
};
c.window = c; c.globalThis = c; vm.createContext(c);
const load = src => vm.runInContext(src, c);
for (const n of ['escAttr', 'escHtml', 'escJs', 'safeUrl', 'nl2br', 'asText', 'typesValid', 'typesOf', 'getVisibleIdeas', 'getPendingIdeas', 'reindexIdeas',
  'humanErrCode', 'csBrandRef', 'remixDetectKind', 'remixAbsUrl', 'remixPickLink', 'remixCreatorFromUrl', 'remixParts', 'remixHasContent',
  'csComposerSource', 'brandGate', 'readJsonOrThrow', '_leanNetFail', '_leanErrMsg', 'cfShortNum', 'cfAge', 'cfScoreLabel', 'cfHandle', 'cfReady', 'cfBrandNow', 'cfReset',
  'fpHttps', 'fpCleanNote', 'cfTtLink', 'cfCreatorTtLink', 'cfFollowedHandles', 'cfAllowLinks', 'planLabel', 'bvSendTyped']) load(grab(n));
for (const re of [/\nconst FORMAT_LABELS = [^\n]*/, /\nconst POST_TYPE_IDS = [^\n]*/, /\nconst POST_TYPE_LABELS = [^\n]*/, /\nconst DAYS = [^\n]*/,
  /\nconst CF_MAX_CREATORS = [^\n]*/, /\nconst CF_MAX_MSG = [^\n]*/, /\nconst FP_NOTE_MAX = [^\n]*/, /\nconst RX_LINK_MAX_WORDS = [^\n]*/, /\nconst RX_IG_MSG = [^\n]*/, /\nlet _cf = [^\n]*/]) load(line(re).replace(/^\n(const|let) /, '\nvar '));
load('var _cfRows = []; var _rxFetching = false; var state = [];');
{ const m = /\nconst RX_MODES = \[[\s\S]*?\n\];/.exec(html); load(m[0].replace('const ', 'var ')); }
{ const m = /\nconst BM_PLATFORMS = \[[\s\S]*?\n\];/.exec(html); load(m[0].replace('const ', 'var ')); }
const HY = between('// ===== v714 HYBRID main screen', '// ===== end v714 hybrid =====');
load(HY.replace(/^(let|const) /gm, 'var '));
const AW = between('// ===== v716 APP-WIDE phase 1', '// ===== end v716 app-wide =====');
load(AW.replace(/^(let|const) /gm, 'var '));
const AW2 = between('// ===== v717 APP-WIDE phases 2+3', '// ===== end v717 app-wide =====');
load(AW2.replace(/^(let|const) /gm, 'var '));
const resp = (status, obj) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj), json: async () => obj });
const R = () => c.aw2Render();
const dock = () => els.awDock.innerHTML;
const pills = () => [...els.hyMain.innerHTML.matchAll(/<button type="button" class="hy-pill([^"]*)" data-twist="([\w-]+)"[^>]*>([^<]+)<\/button>/g)].map(m => ({ on: /\bon\b/.test(m[1]), id: m[2], label: m[3] }));
const fresh = () => { c.hyNew(); calls = []; spy = []; };
// run every item of a ⋯ menu (links are collected, functions executed) — returns the spies and hrefs seen
async function runMenu(key, render) {
  const out = { spy: [], hrefs: [], labels: [] };
  c._aw2.menu = key; (render || R)();
  const items = c._aw2.items.slice();
  for (let k = 0; k < items.length; k++) {
    const m = items[k]; out.labels.push(m.label);
    if (m.href) { out.hrefs.push(m.href); continue; }
    spy = []; c._aw2.menu = key; c._aw2.items = items;
    if (m.confirm) { c.aw2Act(k); }   // the first tap asks
    c._aw2.menu = key; c._aw2.items = items; c.aw2Act(k); await tick(3);
    out.spy.push(...spy);
  }
  c._aw2.menu = ''; return out;
}

(async () => {
  // ═══ 1. Trends ═══
  c.activeView = 'viral'; R();
  {
    const h = els.awTrends.innerHTML, t = vis(h);
    ok(/<h1 class="aw-title">Trends<\/h1>/.test(h) && /Pick one to make it yours · updated 2 h ago/.test(t), '1 title "Trends" + "Pick one to make it yours · updated 2 h ago"');
    const gh = [...h.matchAll(/<div class="aw-gh"><span>([^<]+)<\/span><\/div>/g)].map(m => m[1]);
    ok(J(gh) === J(['Rising now', 'This week', 'Earlier']), '1 groups Rising now / This week / Earlier (' + gh.join(', ') + ')');
    const rows = [...h.matchAll(/<div class="aw-row aw2-row" data-aw2-k="(\d+)">([\s\S]*?)<\/span><\/div>/g)];
    ok(rows.length === 5, '1 one calm row per trend: headlines, a top post, the competitor digest and a taught trend (' + rows.length + ')');
    const chips = rows.map(r => (/<span class="aw-tag">([^<]+)<\/span>/.exec(r[2]) || [])[1]);
    ok(J(chips) === J(['Google News', 'X', 'Competitor', 'TikTok', 'Added by you']), '1 source chips in group order (' + chips.join(', ') + ')');
    ok(/rising · 2 h ago/.test(vis(rows[0][2])) && /3 days/.test(vis(rows[1][2])) && /5 days/.test(vis(rows[2][2])) && /@studioops/.test(vis(rows[3][2])), '1 ages ("rising · 2 h ago", "3 days") and the post\'s @handle');
    ok(rows.every(r => /class="aw-rb"/.test(r[2]) && /<span class="aw-rt">/.test(r[2]) && /class="aw-rm"/.test(r[2])), '1 rows use the shared v716 pieces (.aw-row .aw-rb .aw-rt .aw-rm .aw-tag)');
    ok(/class="aw-fab" id="aw2Pull" onclick="aw2Pull\(\)"[^>]*>[\s\S]*?Pull fresh trends/.test(dock()), '1 the floating "Pull fresh trends" pill');
    spy = []; const p = c.aw2Pull(); ok(/Pulling trends…/.test(dock()) && /disabled/.test(dock()), '1 while it pulls the pill says so and is disabled');
    await p; ok(spy.some(s => s[0] === 'pullWebTrends') && /Sources came back empty/.test(vis(els.awTrends.innerHTML)), '1 the pill runs the existing pullWebTrends; its outcome line shows under the list');
    c._aw2.pullMsg = '';
  }
  // ═══ 2. Trends row → the main chat ═══
  fresh(); c.activeView = 'viral'; R();
  ok(c.aw2TrendGo(0) === true && J(spy.filter(s => s[0] === 'switchView')) === J([['switchView', 'create']]), '2 a row opens the main chat (switchView create)');
  {
    const s = c._hy.t && c._hy.t.src, p = pills();
    ok(s && s.kind === 'text' && s.text === 'Studios moving off spreadsheets' && s.from === 'trend' && s.label === 'From Trends · Google News' && s.url === 'https://news.google.com/rss/a', '2 the trend is the thread\'s source (typed idea, from trend, its source + link)');
    ok(J(p.map(x => x.label)) === J(['My take', 'Myth buster', 'Story', 'Quick tip', 'Q&amp;A', 'Series']) && !p.some(x => x.on), '2 the idea pills show (it is text), none picked yet');
    ok(/class="hy-label hy-from">From Trends · Google News · <a class="hy-watch" href="https:\/\/news\.google\.com\/rss\/a"/.test(els.hyMain.innerHTML), '2 "From Trends · Google News · Source ↗" above the bubble');
    ok(calls.length === 0, '2 nothing is sent until a pill is picked (no fetch)');
  }
  route = async () => resp(200, { remix: { remixTitle: 'T', remixHook: 'H', remixScript: 'S', remixFormat: 'video' } });
  calls = []; await c.hyTwist('myth');
  ok(calls.length === 1 && calls[0].url === '/api/remix' && calls[0].body.postDescription.indexOf('MY IDEA: Studios moving off spreadsheets') === 0 && calls[0].body.postUrl === '', '2 a pill runs /api/remix on the trend as your idea (the typed-idea path)');
  fresh(); c.activeView = 'viral'; c._hy.busy = 'twist'; ok(c.aw2TrendGo(0) === false, '2 one at a time: a running twist is not replaced'); c._hy.busy = '';
  {
    const keyOf = txt => 't' + c._aw2.trows.findIndex(r => r.text.indexOf(txt) === 0);
    c.activeView = 'viral'; R();
    const a = await runMenu(keyOf('Studios moving')), b = await runMenu(keyOf('Cold plunge')), p = await runMenu(keyOf('I run a 6')), m = await runMenu(keyOf('Monday.com'));
    ok(a.hrefs[0] === 'https://news.google.com/rss/a' && a.spy.some(s => s[0] === 'dismissAutoTrend' && s[1] === 'Studios moving off spreadsheets'), '2 row ⋯ on a headline: open the source, "Not relevant — remove" (dismissAutoTrend)');
    ok(b.spy.some(s => s[0] === 'removeTrend' && s[2] === 'Cold plunge and electrolytes'), '2 row ⋯ on a taught trend: Remove (removeTrend)');
    ok(p.hrefs[0] === 'https://www.tiktok.com/@studioops/video/1' && p.spy.some(s => s[0] === 'remixTopPost' && s[1] === 0), '2 row ⋯ on a top post: see the post, "Make it yours with their words" (remixTopPost)');
    ok(m.hrefs[0] === 'https://monday.com/blog' && c._aw2.classic === 'viral', '2 row ⋯ on a competitor move: its source, "All competitor moves" (classic view)');
    c.aw2ClassicEnd();
  }

  // ═══ 3. What people search ═══
  fresh(); c.activeView = 'questions'; R();
  {
    const h = els.awSearch.innerHTML, t = vis(h);
    ok(/<h1 class="aw-title">What people search<\/h1>/.test(h) && /Real Google questions · pick one to answer it/.test(t), '3 title + "Real Google questions · pick one to answer it"');
    const gh = [...h.matchAll(/<div class="aw-gh"><span>([^<]+)<\/span><span>([^<]*)<\/span><\/div>/g)].map(m => m[1] + '|' + m[2]);
    ok(J(gh) === J(['electrolytes|2 new', 'hydration|']), '3 grouped by keyword with "N new" (' + gh.join(', ') + ')');
    ok(/People also ask/.test(t) && /Related/.test(t) && (h.match(/class="aw2-done"/g) || []).length === 1 && /Answered/.test(t), '3 chips People also ask / Related; "Answered" on the one already used');
    ok(/class="aw-fab" id="aw2Find" onclick="aw2Find\(\)"[^>]*>[\s\S]*?Find more questions/.test(dock()), '3 the floating "Find more questions" pill');
    spy = []; c.aw2Find(); ok(J(spy) === J([['fetchPAAQuestions', true]]), '3 the pill runs the existing search (fetchPAAQuestions(true))');
    c.paaLoading = true; R(); ok(/Searching…/.test(dock()) && /disabled/.test(dock()) && /Searching Google for real questions/.test(vis(els.awSearch.innerHTML)), '3 while it searches the pill is busy'); c.paaLoading = false;
  }
  fresh(); c.activeView = 'questions';
  ok(c.aw2AskGo(0) === true && c._hy.t.src.text === 'Do electrolytes break a fast?' && c._hy.t.src.from === 'search', '3 a question opens the main chat as a typed idea');
  {
    const p = pills();
    ok(p.find(x => x.id === 'qna').on && p.filter(x => x.on).length === 1 && calls.length === 0, '3 the Q&A pill is lit (preselected), nothing sent');
  }
  ok(!c.paaUsed.has('do electrolytes break a fast?'), '3 opening it does not mark it answered');
  route = async () => resp(200, { remix: { remixTitle: 'T', remixHook: 'H', remixScript: 'S', remixFormat: 'video' } });
  spy = []; await c.hyTwist('qna');
  ok(c.paaUsed.has('do electrolytes break a fast?') && spy.some(s => s[0] === 'savePAAState'), '3 a version made from it marks it answered (paaUsed + savePAAState, as "Answer this" did)');
  ok(pills().find(x => x.id === 'qna').on, '3 after the version the picked pill stays lit');
  {
    c.activeView = 'questions'; R();
    const k = c._aw2.qrows.indexOf(1);
    const m = await runMenu('q1');
    const fmts = Object.keys(vm.runInContext('FORMAT_LABELS', c));
    ok(k >= 0 && m.spy.some(s => s[0] === 'paaAnswerV2' && s[1] === 1 && s[2] === undefined) && fmts.every(f => m.spy.some(s => s[0] === 'paaAnswerV2' && s[2] === f)), '3 row ⋯ keeps "Answer this" and every format (paaAnswerV2)');
  }

  // ═══ 4. Notebook ═══
  c.notebookNotes = [
    { id: 'n1', text: 'People say the lemon one tastes like nothing.', createdAt: now },
    { id: 'n2', text: 'Rate gas-station drinks by sugar per sip.', createdAt: new Date(now - DAY).toISOString() },
    { id: 'n3', text: 'Best comments come when I admit ' + XSS, createdAt: now - 3 * DAY },
    { id: 'n4', text: 'Stop saying hydration hacks.', createdAt: now - 20 * DAY }];
  store.set('cs_nb_meta::b1', J({ 'people say the lemon one tastes like nothing.': { v: 21 }, 'rate gas-station drinks by sugar per sip.': { u: 1 } }));
  fresh(); c.activeView = 'notebook'; R();
  {
    const hd = els.awNotesHead.innerHTML, h = els.awNotesBody.innerHTML, t = vis(h);
    ok(/<h1 class="aw-title">Notebook<\/h1>/.test(hd) && /4 notes/.test(vis(hd)), '4 title "Notebook" + "4 notes"');
    const gh = [...h.matchAll(/<div class="aw-gh"><span>([^<]+)<\/span><\/div>/g)].map(m => m[1]);
    ok(J(gh) === J(['Today', 'Yesterday', 'Earlier this week', 'Earlier']), '4 groups Today / Yesterday / Earlier this week / Earlier (' + gh.join(', ') + ')');
    const d0 = new Date(now), hhmm = String(d0.getHours()).padStart(2, '0') + ':' + String(d0.getMinutes()).padStart(2, '0');
    ok(t.includes(hhmm) && /class="aw2-voice"/.test(h) && /0:21/.test(t) && /<span class="aw-tag ghost">Used in a post<\/span>/.test(h), '4 time, the voice length (0:21) and "Used in a post"');
    ok((h.match(/class="aw-row aw2-nrow"/g) || []).length === 4 && /onclick="aw2NoteOpen\(0\)"/.test(h), '4 one calm row per note; a row opens the note');
    ok(/class="aw-fab" id="aw2New" onclick="aw2NoteNew\(\)"[^>]*>[\s\S]*?New note/.test(dock()), '4 the floating "New note" pill');
  }
  ok(c.aw2NoteOpen(0) === true && /People say the lemon one/.test(vis(els.awNotesBody.innerHTML)) && els.awNotesHead.innerHTML === '', '4 a note opens its page (text, time)');
  ok(/onclick="aw2NoteChat\(\)"[^>]*>[\s\S]*?Make it yours/.test(dock()) && /onclick="aw2NoteEdit\(\)"/.test(dock()), '4 its page: [Make it yours] and edit in the sticky bar');
  spy = []; calls = [];
  ok(c.aw2NoteChat() === true && spy.some(s => s[0] === 'switchView' && s[1] === 'create') && c._hy.t.src.text === 'People say the lemon one tastes like nothing.' && c._hy.t.src.from === 'note', '4 Make it yours → the main chat with the note as a typed idea');
  ok(pills().length === 6 && pills()[1].label === 'Myth buster' && calls.length === 0, '4 the idea pills, nothing sent');
  route = async () => resp(200, { remix: { remixTitle: 'T', remixHook: 'H', remixScript: 'S', remixFormat: 'video' } });
  store.set('cs_nb_meta::b1', J({})); await c.hyTwist('remix');
  ok(JSON.parse(store.get('cs_nb_meta::b1'))['people say the lemon one tastes like nothing.'].u === 1, '4 a version made from a note marks it "Used in a post"');
  c.activeView = 'notebook'; R(); c.aw2NoteOpen(0);
  {
    const m = await runMenu('nd');
    ok(m.spy.some(s => s[0] === 'nbDevelopV2' && s[1] === 'n1') && m.spy.some(s => s[0] === 'nbSaveAsRule' && s[1] === 'n1') && m.spy.some(s => s[0] === 'nbDelete' && s[1] === 'n1'), '4 ⋯ keeps Develop into a post (nbDevelopV2), Save as a voice rule, Delete (nbDelete)');
    c.aw2NoteOpen(0); c._aw2.menu = 'nd'; R(); const items = c._aw2.items, di = items.findIndex(x => x.label === 'Delete');
    spy = []; ok(c.aw2Act(di) === 'ask' && !spy.some(s => s[0] === 'nbDelete') && /Press again to delete this note/.test(els.awNotesBody.innerHTML), '4 Delete asks once on the menu itself before deleting');
    c._aw2.menu = '';
  }
  c.aw2NoteOpen(0); c.aw2NoteEdit();
  ok(/<textarea id="aw2NbEdit"/.test(els.awNotesBody.innerHTML) && dock().indexOf('aw2NoteChat') < 0, '4 Edit shows the text in a box (the sticky bar steps aside)');
  els.aw2NbEdit.value = 'Lemon tastes like nothing — lean into boring.'; spy = [];
  ok(c.aw2NoteSave() === true && c.notebookNotes[0].text === 'Lemon tastes like nothing — lean into boring.', '4 Save changes the note');
  await tick(); ok(spy.some(s => s[0] === 'saveNotebookToDB') && toasts.some(x => x[0] === 'Note saved'), '4 … through the notebook\'s own save (saveNotebookToDB), then "Note saved"');
  c.aw2NoteBack();
  // New note: the old capture box moves in, saves with the voice length, moves back
  spy = []; ok(c.aw2NoteNew() === true && els.awNotesCap.kids.includes(capture) && els.awNotesCap.hidden === false, '4 New note moves the old capture box (its textarea, mic, Save note) under the title');
  ok(!/id="aw2New"/.test(dock()) && /New note/.test(vis(els.awNotesHead.innerHTML)) && /aw2NoteNewEnd\(\)/.test(els.awNotesHead.innerHTML), '4 … with a Cancel, and the pill steps aside');
  c.nbToggleMic(); await tick(); c._aw2.voice -= 12000; c.nbToggleMic(); await tick();
  c.nbSaveNote();
  ok(spy.filter(s => s[0] === 'nbToggleMic').length === 2 && spy.some(s => s[0] === 'nbSaveNote'), '4 the mic and Save note are the old nbToggleMic / nbSaveNote');
  ok(JSON.parse(store.get('cs_nb_meta::b1'))['spoken note'].v === 12, '4 a spoken note keeps its voice length (12 s)');
  ok(els['view-notebook'].kids.includes(capture) && capture.parent === els['view-notebook'] && els.awNotesCap.hidden === true && c._aw2.capOpen === false, '4 after the save the box goes back where it was');

  // ═══ 5. Creators ═══
  const tt = h => ({ tt: 'https://www.tiktok.com/@' + h });
  c.bookmarkCategories = [
    { id: 'cA', name: 'Following', entries: ['a1', 'a2', 'a3'].map((h, i) => ({ id: 'e' + i, name: h, links: tt(h), note: i === 0 ? 'Great first three seconds ' + XSS : '' })) },
    { id: 'cB', name: 'Rivals ' + XSS, entries: [{ id: 'e3', name: 'a4', links: tt('a4') }, { id: 'e4', name: 'a5', links: tt('a5') }, { id: 'e5', name: 'a6 the sixth', links: tt('a6') },
      { id: 'e6', name: 'Asana ' + XSS, links: { ig: 'https://instagram.com/asana', li: 'https://linkedin.com/company/asana' }, note: 'Watch how they launch' }] }];
  c._cf = { brandId: 'b1', data: { videos: [{ handle: 'a1', videoId: '1', postedAt: new Date(now).toISOString(), score: 4.2 }, { handle: 'a1', videoId: '0', postedAt: new Date(now - 9 * DAY).toISOString(), score: 9 },
    { handle: 'a2', videoId: '2', postedAt: new Date(now - DAY).toISOString(), score: 1.1 }] } };
  fresh(); c.activeView = 'bookmarks'; R();
  {
    const h = els.awCreators.innerHTML, t = vis(h);
    ok(/<h1 class="aw-title">Creators<\/h1>/.test(h) && /5 of 5 · their new videos show on Make it yours/.test(t), '5 title "Creators" + "5 of 5 · their new videos show on Make it yours"');
    const fol = h.slice(h.indexOf('<span>Following</span>'), h.indexOf('aw2-left'));
    const handles = [...fol.matchAll(/<span class="aw-rt">@([\w.]+)<\/span>/g)].map(m => m[1]);
    ok(J(handles) === J(['a1', 'a2', 'a3', 'a4', 'a5']), '5 Following = the first 5 TikTok creators, the ONE creator rule (' + handles.join(', ') + ')');
    ok(/class="aw2-av" aria-hidden="true">A<\/span>/.test(fol) && /New today · 4\.2× usual/.test(vis(fol)) && /Yesterday/.test(vis(fol)) && !/1\.1×/.test(fol), '5 initial circle, "TikTok · New today · 4.2× usual" from the feed (newest video), no × under 1.5');
    ok(/All 5 spots used/.test(t), '5 at five: "All 5 spots used"');
    const oth = h.slice(h.indexOf('Other bookmarks'));
    ok(/<span class="aw-rt">a6 the sixth<\/span>/.test(oth) && /Asana &lt;img/.test(oth) && /<span class="aw-tag">Instagram<\/span><span class="aw-tag">LinkedIn<\/span>/.test(oth), '5 the 6th TikTok and every non-TikTok bookmark show under "Other bookmarks" (nothing hidden)');
    ok(/class="aw-fab aw2-full" id="aw2Add" aria-disabled="true" onclick="aw2AddOpen\(\)"/.test(dock()), '5 the "+ Add creator" pill shows full at five');
    toasts = []; ok(c.aw2AddOpen() === false && c._aw2.adding === false && toasts.some(x => x[0] === vm.runInContext('CF_MAX_MSG', c)), '5 … and at five it refuses with the 5-creator message (no form)');
  }
  { const sixth = c.bookmarkCategories[1].entries.splice(2, 1); R(); toasts = [];
    ok(c.cfFollowedHandles(null).length === 5 && c.aw2AddOpen() === false && c._aw2.adding === false && toasts.length === 1, '5 at exactly five followed the pill refuses too');
    c.bookmarkCategories[1].entries.splice(2, 0, sixth[0]); }
  c.bookmarkCategories[1].entries.splice(0, 3); R();
  {
    ok(/3 of 5/.test(vis(els.awCreators.innerHTML)) && /2 spots left/.test(vis(els.awCreators.innerHTML)), '5 under five: "3 of 5" and "2 spots left"');
    ok(c.aw2AddOpen() === true && /id="aw2AddLink"/.test(els.awCreators.innerHTML) && !/id="aw2Add"/.test(dock()), '5 under five the pill opens the add form');
    spy = []; ok(c.aw2AddSave() === true && J(spy.filter(s => s[0] === 'fpAdd')) === J([['fpAdd', 'aw2Add']]) && c._aw2.adding === false, '5 Add = the follow panel\'s own fpAdd (link check + the 5 rule + save)');
    const m = await runMenu('c0');
    ok(m.hrefs[0] === 'https://www.tiktok.com/@a1' && m.spy.some(s => s[0] === 'deleteBmEntry' && s[1] === 'cA' && s[2] === 'e0') && J(c._bmEditingEntry) === J({ catId: 'cA', entId: 'e0' }), '5 row ⋯: open the profile, Edit note and links (the Bookmarks editor), Remove (deleteBmEntry)');
  }
  spy = []; c.toggleBookmarkBar(); ok(spy.some(s => s[0] === 'switchView' && s[1] === 'bookmarks') && !spy.some(s => s[0] === 'openBookmarks-sheet'), '5 the menu\'s Creators (toggleBookmarkBar) opens this screen');

  // ═══ 6. Settings ═══
  fresh(); els.settingsOverlay.classList.remove('open'); c._aw2.sp = 'x'; c.openSettings();
  {
    const h = els.settingsOverlay.innerHTML, t = vis(h);
    ok(c._aw2.sp === '' && /<h1 class="aw-title">Settings<\/h1>/.test(h), '6 the menu\'s Settings opens the one page');
    const gh = [...h.matchAll(/<div class="aw-gh"><span>([^<]+)<\/span><\/div>/g)].map(m => m[1]);
    ok(J(gh) === J(['Brand', 'Content', 'Account']), '6 groups Brand / Content / Account');
    const rows = [...h.matchAll(/<button type="button" class="aw-row aw2-srow" onclick="([^"]+)">[\s\S]*?<span class="aw2-lb">([^<]+)<\/span>(?:<span class="aw2-v">([^<]*)<\/span>)?/g)].map(m => [m[2], m[3] || '', m[1]]);
    ok(J(rows.map(r => r[0])) === J(['Brand brain', 'Brands', 'Team', 'Post mix', 'Daily idea', 'Plan', 'Billing', 'Help', 'Log out']) && /Dark mode/.test(t), '6 rows: Brand brain, Brands, Team, Post mix, Daily idea, Dark mode, Plan, Billing, Help, Log out');
    ok(J(rows.slice(0, 6).map(r => r[1])) === J(['72%', '2', '2 people', '7 a week', '08:00', 'Pro · 312 of 750']), '6 values on the right (72%, 2, 2 people, 7 a week, 08:00, Pro · 312 of 750)');
    ok(!/<p\b/.test(h.replace(/<p class="aw-sub">[^<]*<\/p>/g, '')) && /Terms<\/a> · <a href="\/privacy\.html"[^>]*>Privacy<\/a> · <a href="\/refunds\.html"[^>]*>Refunds<\/a> · v716/.test(h), '6 no paragraph text; Terms · Privacy · Refunds · version in the footer');
    const go = {}; rows.forEach(r => { go[r[0]] = r[2]; });
    for (const [lb, key] of [['Brand brain', 'brain'], ['Brands', 'brands'], ['Team', 'team'], ['Post mix', 'mix'], ['Daily idea', 'daily'], ['Plan', 'danger']]) {
      spy = []; c._aw2.sp = ''; vm.runInContext(go[lb], c);
      ok(c._aw2.sp === key && spy.some(s => s[0] === 'renderSettingsPanel' && s[1] === key) && c.spActiveTab === (key === 'brain' ? 'voice' : 'workspace'), '6 ' + lb + ' → the old panel (' + (key === 'brain' ? 'Brand Voice tab' : 'section ' + key) + ')');
    }
    ok(c.settings.openSections.team === true && c.settings.openSections.danger === true, '6 a section sub-page opens that section');
    c._aw2.sp = ''; c.renderSettingsPanel();
    const h2 = els.settingsOverlay.innerHTML, r2 = {}; [...h2.matchAll(/onclick="([^"]+)">[\s\S]*?<span class="aw2-lb">([^<]+)<\/span>/g)].forEach(m => { r2[m[2]] = m[1]; });
    for (const [lb, fn] of [['Billing', 'openBillingPortal'], ['Help', 'startTour'], ['Log out', 'handleLogout']]) { spy = []; vm.runInContext(r2[lb], c); ok(spy.some(s => s[0] === fn), '6 ' + lb + ' → ' + fn); }
    c.csUsage = { plan: 'free', used: 3, limit: 10 }; spy = []; c.aw2Billing(); ok(spy.some(s => s[0] === 'showUpgrade'), '6 Billing on a free plan → the upgrade sheet'); c.csUsage = { plan: 'pro', used: 312, limit: 750 };
    els.settingsOverlay.classList.add('open'); c._aw2.sp = ''; c.renderSettingsPanel(); spy = []; c.aw2Dark(false);
    ok(spy.some(s => s[0] === 'toggleDarkMode' && s[1] === false) && /class="aw2-tog" role="switch"/.test(els.settingsOverlay.innerHTML), '6 Dark mode is a switch (toggleDarkMode)');
  }
  // the old ways into one part of Settings
  for (const [fn, key] of [['openBrain', 'brain'], ['openSettingsToBookmarks', 'bookmarks'], ['openSettingsToTeam', 'team'], ['openContentMix', 'mix']]) {
    els.settingsOverlay.classList.remove('open'); c._aw2.sp = ''; spy = []; vm.runInContext(fn + '()', c);
    ok(c._aw2.sp === key && spy.filter(s => s[0] === 'renderSettingsPanel').pop()[1] === key, '6 ' + fn + '() lands on its part (' + key + ')');
  }
  els.settingsOverlay.classList.add('open'); c._aw2.sp = ''; c.toggleSection('schedule'); ok(c._aw2.sp === 'schedule', '6 a section toggled from the rows page opens that section');
  c._aw2.sp = 'team'; c.toggleSettings(); ok(c._aw2.sp === '' && !els.settingsOverlay.classList.contains('open'), '6 closing Settings forgets the sub-page');
  {
    const m = await runMenu('sp', () => { els.settingsOverlay.classList.add('open'); c._aw2.sp = ''; c.renderSettingsPanel(); });
    ok(J(m.labels) === J(['All settings', 'Bookmarks', 'Posting target']), '6 the page\'s ⋯: All settings, Bookmarks, Posting target (every old part stays reachable)');
  }
  // a sub-page: the old panel, Back → the rows, one section shown on its own
  {
    const nd = (cls) => { const n = mk('n'); n.classList.add(cls); return n; };
    const box = mk('box'), a = nd('ws-row'), sec = nd('sp-section'), b = nd('sp-section'), hdr = mk('hdr'), back = mk('back'), h2 = mk('h2');
    box.children = [a, sec, b]; sec.parentElement = box; hdr.closest = s => (s === '.sp-section' ? sec : null);
    const ov = { querySelector: s => ({ '.sp-back': back, '.sp-header h2': h2, '.sp-section-header[onclick="toggleSection(\'team\')"]': hdr }[s] || null) };
    const got = c.aw2SpDecorate(ov, 'team');
    ok(got === sec && !sec.classList.contains('aw2-sp-hide') && a.classList.contains('aw2-sp-hide') && b.classList.contains('aw2-sp-hide'), '6 a section sub-page shows that section alone (the others hidden, not removed)');
    ok(back.getAttribute('onclick') === 'aw2SpBack()' && back.textContent === 'Settings' && h2.textContent === 'Team', '6 its Back goes to the rows page; the title names the part');
    spy = []; els.settingsOverlay.classList.add('open'); c._aw2.sp = 'team'; c.aw2SpBack(); ok(c._aw2.sp === '' && /aw2-srow/.test(els.settingsOverlay.innerHTML), '6 Back → the rows page again');
  }

  // ═══ 7. Coach ═══
  spy = []; c.bvRenderHome();
  {
    const h = els.bvHome.innerHTML;
    ok(spy[0] && spy[0][0] === 'bvRenderHome' && /Brand brain 72%/.test(vis(h)) && /4 left to fill/.test(vis(h)) && /aria-valuenow="72"/.test(h) && /<i style="width:72%"><\/i>/.test(h), '7 the strip: "Brand brain 72%", "4 left to fill", the bar (after the old home renderer)');
    const chips = [...h.matchAll(/onclick="bvAskField\('(\w+)'\)">([^<]+)</g)].map(m => m[1]);
    ok(J(chips) === J(['painPoints', 'avoidWords', 'originStory']) && /closeBrandVoice\(\);openBrain\(\)">\+1 more/.test(h) && /class="aw-tag aw2-chip"/.test(h), '7 gap chips (Pain points, Words to avoid, Your story) → bvAskField; "+1 more" → Brand brain');
  }
  els.bvTextInput.value = 'ok, go'; spy = []; c.bvSendTyped();
  ok(J(spy) === J([['bvSend', 'ok, go']]) && els.bvTextInput.value === '', '7 typing still sends through the old path (bvSendTyped → bvSend)');
  {
    const ov = between('<div class="bv-overlay" id="bvOverlay"', '<!-- ===== AUTH SCREEN');
    ok(/onkeydown="if\(event\.key==='Enter'\)\{bvSendTyped\(\)\}"/.test(ov) && /id="bvSendBtn" onclick="bvSendTyped\(\)"/.test(ov) && /id="bvMicBtn" onclick="bvToggleMic\(\)"/.test(ov) && /class="bv-header-title">Coach</.test(ov), '7 the input bar keeps Enter / send / mic on bvSendTyped / bvToggleMic; the header says Coach');
    ok(/\.bv-text-input:placeholder-shown ~ \.bv-send-btn \{ display: none !important; \}/.test(css) && /\.bv-msg\.user \{[^}]*border-radius: 22px 22px 6px 22px/.test(css), '7 the shared chat look: your lines as bubbles, the mic in the pill input (send shows once you type)');
  }

  // ═══ 8. XSS ═══
  c.activeView = 'viral'; R(); const T = els.awTrends.innerHTML;
  c.activeView = 'questions'; R(); const S = els.awSearch.innerHTML;
  c.activeView = 'notebook'; c._aw2.note = ''; R(); const N = els.awNotesBody.innerHTML; c.aw2NoteOpen(c._aw2.nrows.indexOf('n3')); const ND = els.awNotesBody.innerHTML; c.aw2NoteBack();
  c.bookmarkCategories[1].entries.unshift({ id: 'e9', name: 'x', links: { tt: 'https://www.tiktok.com/@zz' }, note: 'n ' + XSS });
  c.activeView = 'bookmarks'; R(); const C = els.awCreators.innerHTML;
  const raw = [T, S, N, ND, C].filter(x => x.indexOf('<img src=x') >= 0).length, esc = [T, S, N, ND, C].filter(x => x.indexOf('&lt;img src=x onerror=alert(1)&gt;') >= 0).length;
  ok(raw === 0 && esc === 5, '8 markup in a trend, question, note (list + page), creator note, bookmark and category name is escaped (' + esc + '/5 escaped, ' + raw + ' raw)');
  ok(c.aw2SrcName('javascript:alert(1)', '') === 'Web' && c._aw2.trows.every(r => !r.link || /^https:/.test(r.link)), '8 links are only https (safeUrl)');

  // ═══ 9. nothing previously reachable is lost ═══
  {
    const classic = [];
    for (const [v, host, key] of [['viral', 'awTrends', 'th'], ['questions', 'awSearch', 'sh'], ['notebook', 'awNotesHead', 'nh']]) {
      c.activeView = v; c._aw2.view = v; c._aw2.note = ''; R();
      c._aw2.menu = key; R(); const i = c._aw2.items.findIndex(x => /classic view/i.test(x.label)); c.aw2Act(i);
      classic.push(c._aw2.classic === v && body.getAttribute('data-aw2-classic') === v && /aw2ClassicEnd\(\)/.test(els[host].innerHTML) && dock() === '<div class="aw-dock-in"></div>');
      c.aw2ClassicEnd();
    }
    ok(classic.every(Boolean) && /body\.aw-on:not\(\[data-aw2-classic="viral"\]\) #view-viral > :not\(#awTrends\)/.test(css), '9 every screen\'s ⋯ has "Classic view": the old screen, whole, with a way back');
    c.activeView = 'viral'; R(); c._aw2.menu = 'th'; R(); spy = []; c.aw2Act(c._aw2.items.findIndex(x => /Analyze a video/.test(x.label)));
    ok(spy.some(s => s[0] === 'vlTab' && s[1] === 'analyze') && c._aw2.classic === 'viral', '9 Trends ⋯ → Analyze a video (the old analyzer tab)'); c.aw2ClassicEnd();
    const rt = grab('renderTrendMemory'), rp = grab('renderPAASection');
    ok(/setTrendWindow\(/.test(rt) && /pullWebTrends\(\)/.test(rt) && /id="trendPullTopic"/.test(rt) && /togglePAA\(\)/.test(rp) && /showPAAFormats\(/.test(rp), '9 the old renderers (topic, time window, pull; collapse, format picker) are unchanged — the classic views draw them');
    const vn = between('<div class="view" id="view-notebook">', '<!-- /view-notebook -->');
    ok(/id="nbMic" onclick="nbToggleMic\(\)"/.test(vn) && /onclick="nbSaveNote\(\)"/.test(vn) && /id="nbInput"/.test(vn), '9 the notebook\'s capture box (mic + Save note) is still in the page');
    const vv = between('<div class="view" id="view-viral">', '<div class="view" id="view-idea">');
    ok(/id="vlQuickBtn" onclick="vlQuickGo\(this\)"/.test(vv) && /onclick="analyzeViral\(\)"/.test(vv) && /onclick="vlToggleManual\(\)"/.test(vv), '9 the Trends analyzer markup is still in the page');
    const want = { trends: ['pullWebTrends', 'dismissAutoTrend', 'removeTrend', 'remixTopPost', 'vlTab'], search: ['fetchPAAQuestions', 'paaAnswerV2', 'spScrollToField'], notebook: ['nbToggleMic', 'nbSaveNote', 'nbDevelopV2', 'nbSaveAsRule', 'nbDelete', 'saveNotebookToDB'],
      creators: ['fpAdd', 'deleteBmEntry', 'cfRefresh', '_bmEditingEntry', 'cfFollowedHandles'], settings: ['openBillingPortal', 'showUpgrade', 'startTour', 'handleLogout', 'toggleDarkMode', 'toggleSettings'], coach: ['bvAskField', 'openBrain'] };
    const miss = []; Object.entries(want).forEach(([k, fns]) => fns.forEach(f => { if (!new RegExp('\\b' + f + '\\(|\\b' + f + ' =|aw2Wrap\\(\'' + f + '\'').test(AW2)) miss.push(k + ':' + f); }));   // called, or wrapped (the old button calls it)
    ok(!miss.length, '9 every old function of each screen is still called from the new screens (' + (miss.join(', ') || 'all') + ')');
    c.activeView = 'bookmarks'; R(); c._aw2.menu = 'ch'; R(); const ci = c._aw2.items.map(x => x.label);
    spy = []; c.aw2Act(c._aw2.items.findIndex(x => x.label === 'Check for new videos'));
    ok(J(ci) === J(['Manage all bookmarks', 'Check for new videos']) && spy.some(s => s[0] === 'cfRefresh'), '9 Creators ⋯: Manage all bookmarks (categories, rename, delete), Check for new videos (cfRefresh)');
  }

  // ═══ 11. review nits: Esc order, unsaved note, arrow keys, desktop sub-page back ═══
  {
    c.activeView = 'notebook'; c._aw2.view = 'notebook'; c._aw2.classic = ''; R(); c.aw2NoteOpen(0); c.aw2NoteEdit();
    els.aw2NbEdit.value = 'changed words';
    ok(c.aw2Esc() === true && c._aw2.edit === true && c._aw2.ask === true && /Discard changes\?/.test(vis(els.awNotesBody.innerHTML)) && els.aw2NbEdit.value === 'changed words', '11 Esc on a note with unsaved edits asks "Discard changes?" on the page and keeps the edit');
    ok(c.aw2Esc() === true && c._aw2.edit === true && c._aw2.ask === false, '11 a second Esc keeps editing (nothing lost)');
    c.aw2Esc(); ok(c.aw2NoteEditEnd() === true && c._aw2.edit === false && !!c.aw2NoteObj(), '11 Discard leaves the edit, the note stays open');
    c.aw2NoteEdit(); ok(c.aw2Esc() === true && c._aw2.edit === false && !!c.aw2NoteObj(), '11 Esc with no changes just leaves the edit');
    c._aw2.menu = 'nd'; R(); ok(c.aw2Esc() === true && c._aw2.menu === '' && !!c.aw2NoteObj(), '11 Esc closes an open ⋯ menu first (the note stays open)');
    ok(c.aw2Esc() === true && !c.aw2NoteObj(), '11 then Esc closes the note page');
    const ck = grab('csxOnKey');
    ok(/if \(typeof aw2Esc === 'function' && aw2Esc\(\)\) \{ e\.preventDefault\(\); return; \} if \(csxEscape\(\)\)/.test(ck), '11 desktop: csxOnKey hands Esc to the calm screens (menus, unsaved note) before its own Esc');
    ok(/scr === 'ideas' \|\| scr === 'pipeline' \|\| scr === 'bookmarks' \|\| \(scr === 'notebook' && document\.body\.getAttribute\('data-aw2-classic'\) !== 'notebook'\)\)\) return;/.test(ck)
      && /var scr = csxScreen\(\); if \(CSX_MD_VIEWS\.indexOf\(scr\) < 0\) return;/.test(ck), '11 desktop arrows: no hidden-row selection on Notebook / Creators (Trends, search, Settings are not list-key screens) — arrows scroll');
    const pb = mk('pb'), back = mk('back'), ins = [];
    pb.insertBefore = (n) => { ins.push(n); return n; };
    c.aw2SpDecorate({ querySelector: s => ({ '.sp-back': back, '.sp-body': pb }[s] || null) }, 'brain');
    ok(ins.length === 1 && ins[0].getAttribute('onclick') === 'aw2SpBack()' && /Settings$/.test(ins[0].innerHTML) && /\.aw2-spdback \{ display: none; \}/.test(css)
      && /@media \(min-width: 900px\) \{ #settingsOverlay\.aw2-sub \.aw2-spdback, #settingsOverlay \.sp-body > \.aw2-spdback \{ display: inline-flex;/.test(css), '11 a desktop sub-page gets a visible "‹ Settings" back to the rows (phones keep the header Back)');
  }

  // ═══ 10. wiring + one shared style ═══
  {
    const at = (v, id) => { const i = html.indexOf('<div class="view" id="view-' + v + '">'); return i >= 0 && html.indexOf('id="' + id + '"', i) > i && html.indexOf('id="' + id + '"', i) - i < 300; };
    ok(at('viral', 'awTrends') && at('questions', 'awSearch') && at('notebook', 'awNotes') && /c\.id = 'awCreators'; vb\.insertBefore\(c, vb\.firstChild \|\| null\)/.test(AW2), '10 each screen\'s calm host is the first thing in its view (Creators: added to the v703 view at first draw)');
    ok(/\['renderTrendMemory', 'renderPAASection', 'renderNotebook', 'rerenderBookmarks'\]\.forEach/.test(AW2) && /aw2Wrap\('switchView'/.test(AW2) && /aw2Wrap\('renderSettingsPanel'/.test(AW2), '10 the old renderers (and every screen change) redraw the calm screens');
    ok(/if \(typeof aw2DockHtml === 'function'\) return aw2DockHtml\(v\);/.test(AW) && ['viral', 'questions', 'notebook', 'bookmarks'].every(v => css.includes('body.aw-on[data-cs-view="' + v + '"] .aw-dock')), '10 the v716 dock carries the four screens\' pills');
    const blk = css.slice(css.indexOf('v717 APP-WIDE phases 2+3'), css.indexOf('/* ============ v714 HYBRID main screen'));
    const dup = ['.aw-row {', '.aw-tag {', '.aw-gh {', '.aw-fab {', '.aw-rt {', '.aw-film {', '.hy-menu {'].filter(s => blk.includes('\n' + s));
    ok(!dup.length && !/#[0-9a-f]{3,6}\b/i.test(blk.replace(/#(view|settings|bv|aw|mainViews|csx)[\w-]*/g, '')), '10 the shared v716 pieces are reused (no look-alike rules), tokens only' + (dup.length ? ' — ' + dup.join(' ') : ''));
    const rule = sel => [...css.matchAll(new RegExp('(?:^|\\n)' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]*)\\}', 'g'))].map(m => m[1]).join(';');
    ok(/height: 48px|min-height: 48px/.test(rule('.aw2-in, .aw2-ta')) && /min-height: 52px/.test(rule('.aw2-srow')) && /width: 40px/.test(rule('.aw2-av')), '10 tap targets: inputs 48, settings rows 52, avatars 40');
  }

  finished = true;
  if (fail) { console.log(fail + ' check(s) failed'); process.exit(1); }
  console.log('APPWIDE P23 OK');
})().catch(e => { console.log('FAIL: threw', e && e.stack || e); process.exit(1); });
