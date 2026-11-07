#!/usr/bin/env node
// GATE (v716, app-wide style phase 1, owner-approved mockups design-options/appwide/, 2026-11-07). EXECUTED: the real v716 block
// (aw*), the real hybrid block (hy*), the real menu builders and their helpers are lifted out of app.html and run in node:vm
// against a fake DOM, spies and a stubbed fetch. No network, no AI.
//   1  Ideas (mockup 3): title "Ideas" + "N waiting", groups Today / This week / Earlier in that order with counts, one quiet row
//      per pending idea (title, type chip, format chip), ✕ skip / ✓ keep buttons; only pending ideas.
//   2  keep = quickApprove(id), skip = showDismissPopupFn(id) (the existing paths); a swipe right keeps, left skips, a short one
//      does nothing; a non-pending idea is refused.
//   3  Idea detail (3b): back, title, chips, Hook / Script / Shot list / Caption & tags each with a copy button, "Show all" on a long
//      script; the extra tools (Sharpen, Redo …) only behind "⋯"; copy copies the right text.
//   4  Film it keeps the idea (pending → filming, saved) and opens the REAL teleprompter (openTeleprompter) with the idea's script.
//   5  Pipeline (4): To film = status filming, Posted = done in the last 30 days, no Filmed group (nothing records it); counts;
//      "Film next" opens the top filmable To film post in the teleprompter.
//   6  Typed text in an EMPTY thread → the idea pills (My take, Myth buster, Story, Quick tip, Q&A, Series) and each runs
//      /api/remix with its mode (+ angle line); a link → the remix set (RX_MODES), unchanged.
//   7  Menu (12): drawer order exact, Classic tools collapsed (aria-expanded=false, hidden) with Quick Post / Idea Catcher / Classic
//      Make it yours / Brand brain / Help inside, credits line last; desktop sidebar and ⌘K palette in the same order.
//   8  XSS: an idea title / script / hook / shots / caption with markup is escaped in the list, the detail and the Pipeline.
//  10  review fixes: (1) the Ideas header ⋯ brings back the old workspace's tools (Select several → batchApprove, Show skipped →
//      undoStatus, Restore skipped → resetAll, Copy all kept → exportApproved, Generate ideas → generateNewIdeas, Content mix) and
//      the "N hidden — format switched off" line; (2) "Assign…" (toggleAssignPopup) in the idea page's ⋯ and a long press on a
//      Pipeline row; (3) carousel / image: the sticky button is the slide maker, never the teleprompter; (4) swipe: sideways lock
//      >16 px and >2× vertical, >24 px drift cancels, commit at 96 px, a 5 s "Undo" toast that reverts through the existing paths.
//   9  wiring + shared CSS: the screens' hosts, the dock outside .view, renderIdeas / renderPipeline redraw the calm lists,
//      one shared rule set (.aw-* with the hy-* aliases), tap targets ≥44 px.
// RUN: node scripts/verify/appwide-p1-v716.mjs        EXPECT: "APPWIDE P1 OK", exit 0.
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
const els = {}; const listeners = {};
function mk(id) {
  const attrs = {}; const cls = new Set();
  const e = { id, value: '', textContent: '', hidden: false, style: { setProperty() {} }, scrollTop: 0,
    focus() {}, scrollIntoView() {}, setSelectionRange() {}, addEventListener() {},
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
['awIdeas', 'awPipe', 'awDetail', 'awDock', 'hyApp', 'hyMain', 'hyBar', 'hyHint', 'hyInLbl', 'hySend', 'hyNewBtn', 'hyDock', 'tpTitle', 'tpBody', 'teleprompterOverlay', 'ideasQuickStatus'].forEach(host);
els.hyIn = mk('hyIn'); els.hyIn.setAttribute('placeholder', 'Paste a link or type an idea…');
const body = mk('body');
// ── stubs / spies ──
let calls = [], route = null, written = [], toasts = [], spy = [], saves = 0, tpOpened = 0;
const store = new Map();
const c = {
  console: { log() {}, warn() {}, error() {}, info() {} }, JSON, Promise, Date, Math, String, Number, Array, Object, Set, Map, RegExp, Error, TypeError, isFinite, encodeURIComponent, URL, setTimeout, clearTimeout,
  window: { scrollTo() {}, innerWidth: 390, innerHeight: 844, addEventListener() {}, requestAnimationFrame: f => f(), _remixDelivery: null, matchMedia: () => ({ matches: false }) },
  localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
  navigator: { clipboard: { readText: () => Promise.reject(new Error('no')), writeText: t => { written.push(t); return Promise.resolve(); } } },
  document: { getElementById: id => els[id] || null, querySelector: () => null, querySelectorAll: () => [], activeElement: null, body, documentElement: { scrollHeight: 2000, style: { setProperty() {} } },
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); }, createElement: () => mk('x') },
  fetch: async (url, opt) => { const b = opt && opt.body ? JSON.parse(opt.body) : null; calls.push({ url, body: b }); return route(url, b); },
  currentBrand: { id: 'b1' }, activeView: 'ideas', _switchSeq: 0, remixes: [], settings: { formatMix: {} },
  showToast: (...a) => toasts.push(a), copyFallback: t => written.push('FB:' + t), saveRemixes() {}, renderRemixResults() {}, saveRemixToIdeas: () => true,
  getBrandContext: () => ({ brandName: 'Acme' }), deliveryReq: () => 'face', deliveryUi: () => 'face', DELIVERY_FORMATS: new Set(['video']),
  leanBrandFetch: (url, base, full) => { if (typeof full !== 'function') throw new Error('no full-brand fallback'); return c.fetch(url, { body: JSON.stringify(base) }); },
  // the existing paths (spies): keep / skip / save / moves / the Plan my week lane
  quickApprove: id => spy.push(['quickApprove', id]), showDismissPopupFn: id => spy.push(['showDismissPopupFn', id]),
  saveState: () => { saves++; }, renderNav() {}, moveStage: (id, s) => spy.push(['moveStage', id, s]), ideasQuickGo: async b => spy.push(['ideasQuickGo']),
  sharpenIdea: id => spy.push(['sharpenIdea', id]), viralTwist: id => spy.push(['viralTwist', id]), ideaRedoOpen: id => spy.push(['ideaRedoOpen', id]), generateMore: id => spy.push(['generateMore', id]),
  openBroll: id => spy.push(['openBroll', id]), openCarouselMaker: id => spy.push(['openCarouselMaker', id]), openStatementEditor: id => spy.push(['openStatementEditor', id]),
  getTodayName: () => 'Monday', humanErr: (m, f) => m || f,
  // the real openTeleprompter runs; its formatting helpers are stand-ins that keep the text visible
  tpFormatScript: (t) => '<p>' + c.escAttr(t) + '</p>', tpPrimer: () => '', tpSetSmartSpeed() {}, tpFontSize: 30, _tpIdeaId: null, tpSyncDoneBtn() {},
  tpOpenMode: () => { tpOpened++; return 'film'; }, tpEnsureCamera() { throw new Error('camera without tpOpenMode'); }, TP_VOICE_SUPPORTED: false, tpVoiceEnabled: () => false,
  tvActiveIdea: () => null, tvNoIdea() {}, setRemixSource() {}, extractArticle: async () => {}, remixSetSource() {},
  bookmarkCategories: [], cfRender() {}, listLoadFailed: () => false,
  // review fixes: the old Ideas workspace's tools, Assign, Undo (spies)
  resetAll: () => spy.push(['resetAll']), exportApproved: () => spy.push(['exportApproved']), openContentMix: () => spy.push(['openContentMix']),
  generateNewIdeas: async () => spy.push(['generateNewIdeas']), undoStatus: id => spy.push(['undoStatus', id]), batchApprove: () => spy.push(['batchApprove', [...c._ideaSelected].sort()]),
  toggleAssignPopup: id => spy.push(['toggleAssignPopup', id]), closeApproveSheet: () => spy.push(['closeApproveSheet']), cancelDismissPopup: () => spy.push(['cancelDismissPopup']),
  openApprovePopup: null, openAssignId: null, _ideaSelectMode: false, _ideaSelected: new Set(),
};
c.globalThis = c; vm.createContext(c);
const load = src => vm.runInContext(src, c);
const V = src => vm.runInContext(src, c);
for (const n of ['escAttr', 'escHtml', 'safeUrl', 'nl2br', 'asText', 'typesValid', 'typesOf', 'getVisibleIdeas', 'getPendingIdeas', 'reindexIdeas', 'openTeleprompter',
  'humanErrCode', 'csBrandRef', 'remixDetectKind', 'remixAbsUrl', 'remixPickLink', 'remixCreatorFromUrl', 'remixFetchWords', 'remixParts', 'remixCopyText', 'remixHasContent',
  'csComposerSource', 'brandGate', 'readJsonOrThrow', '_leanNetFail', '_leanErrMsg', 'cfShortNum', 'cfAge', 'cfScoreLabel', 'cfHandle', 'cfReady', 'cfBrandNow', 'cfReset',
  'fpHttps', 'tvOpenTeleprompter', 'cfTtLink', 'cfCreatorTtLink', 'cfFollowedHandles', 'cfAllowLinks']) load(grab(n));
for (const re of [/\nconst FORMAT_LABELS = [^\n]*/, /\nconst POST_TYPE_IDS = [^\n]*/, /\nconst POST_TYPE_LABELS = [^\n]*/, /\nconst DAYS = [^\n]*/, /\nvar CS_READ_FORMATS = [^\n]*/,
  /\nconst CF_MAX_CREATORS = [^\n]*/, /\nconst RX_LINK_MAX_WORDS = [^\n]*/, /\nconst RX_IG_MSG = [^\n]*/, /\nconst CF_PASTE_CODES = [^\n]*/, /\nlet _cf = [^\n]*/]) load(line(re).replace(/^\n(const|let) /, '\nvar '));
load('var _cfRows = []; var _rxFetching = false;');
{ const m = /\nconst RX_MODES = \[[\s\S]*?\n\];/.exec(html); load(m[0].replace('const ', 'var ')); }
const HY = between('// ===== v714 HYBRID main screen', '// ===== end v714 hybrid =====');
load(HY.replace(/^(let|const) /gm, 'var '));
const AW = between('// ===== v716 APP-WIDE phase 1', '// ===== end v716 app-wide =====');
load(AW.replace(/^(let|const) /gm, 'var '));
const resp = (status, obj) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj), json: async () => obj });

// ── data ──
const now = Date.now(), DAY = 864e5;
const XSS = '<img src=x onerror=alert(1)>';
const LONG = 'Eight hours of sleep is eight hours without a sip. Then the first thing in is coffee. So the ten o\'clock crash is not the coffee\'s fault. '
  + 'Try one glass of water with a pinch of salt first, then the coffee. One week. Tell me if ten o\'clock feels different. ' + XSS;
const I = (o) => Object.assign({ status: 'pending', format: 'video', hook: '', script: '', shots: '', caption: '', tags: '', day: 'Monday' }, o);
const STATE = () => [
  I({ title: 'Water first, coffee second ' + XSS, postType: 'tip', statusAt: now - 60e3, hook: 'You are not tired. You are dry. ' + XSS, script: LONG,
    shots: '1. Alarm, kettle on, close-up\n2. Glass of water by the window\n3. Coffee, talk to camera ' + XSS, caption: 'Water before coffee. ' + XSS, tags: '#morningroutine' }),
  I({ title: 'Why does my drink taste plain?', format: 'qna', statusAt: now - 120e3 }),
  I({ title: 'What is in one scoop', postType: 'about', format: 'carousel', statusAt: now - 2 * DAY }),
  I({ title: 'Salt is not the enemy', postType: 'tip', format: 'statement', statusAt: now - 3 * DAY, boldText: 'Salt is not the enemy.' }),
  I({ title: 'How we taste-test a batch', postType: 'bts', statusAt: now - 20 * DAY }),
  I({ title: 'Already kept', status: 'filming', approvedAt: now - DAY }),
  I({ title: 'Skipped one', status: 'dismissed' }),
  I({ title: 'Carousel to film', status: 'filming', format: 'carousel', approvedAt: now - 1000, assignee: 'Kate Mills' }),
  I({ title: 'Film this one ' + XSS, status: 'filming', format: 'video', approvedAt: now - 5000, script: 'FILM NEXT SCRIPT' }),
  I({ title: 'Posted recently', status: 'done', doneAt: now - 2 * DAY }),
  I({ title: 'Posted long ago', status: 'done', doneAt: now - 60 * DAY })
];
const setState = () => { c.state = STATE(); V('reindexIdeas()'); };
const ideas = () => els.awIdeas.innerHTML, det = () => els.awDetail.innerHTML, dock = () => els.awDock.innerHTML, pipe = () => els.awPipe.innerHTML;

(async () => {
  // ═══ 1. Ideas ═══
  setState(); c.activeView = 'ideas'; c.awRender();
  {
    const h = ideas(), t = vis(h);
    ok(/<h1 class="aw-title">Ideas<\/h1>/.test(h) && /5 waiting · swipe right to keep, left to skip/.test(t), '1 title "Ideas" and a one-line count ("5 waiting · swipe right to keep, left to skip")');
    const gh = [...h.matchAll(/<div class="aw-gh"><span>([^<]+)<\/span><span>(\d+)<\/span><\/div>/g)].map(m => m[1] + ' ' + m[2]);
    ok(J(gh) === J(['Today 2', 'This week 2', 'Earlier 1']), '1 groups Today / This week / Earlier with counts (' + gh.join(', ') + ')');
    const rows = [...h.matchAll(/<div class="aw-row aw-irow" data-aw-id="(\d+)">([\s\S]*?)<\/span><\/div>/g)];
    ok(rows.length === 5 && rows.map(r => +r[1]).sort().join() === '0,1,2,3,4', '1 one row per pending idea, nothing else (kept / skipped / posted ideas are not listed)');
    const r0 = rows.find(r => r[1] === '0')[2];
    ok(/<span class="aw-tag">Tip<\/span><span class="aw-tag ghost">Video<\/span>/.test(r0), '1 a row shows its type chip (filled) and its format chip (outlined)');
    ok(/<span class="aw-tag">About us<\/span><span class="aw-tag ghost">Carousel<\/span>/.test(h) && /<span class="aw-tag">Behind the scenes<\/span>/.test(h) && /<span class="aw-tag">Tip<\/span><span class="aw-tag ghost">Statement<\/span>/.test(h), '1 the six existing types are the labels (About us, Behind the scenes …)');
    ok(/<span class="aw-tag">Q&amp;A<\/span><\/span>/.test(h), '1 a Q&A-format idea shows one Q&A chip, not two');
    ok(/aria-label="Skip [^"]*" title="Skip" onclick="event\.stopPropagation\(\);awSkip\(0\)"/.test(r0) && /aria-label="Keep [^"]*" title="Keep" onclick="event\.stopPropagation\(\);awKeep\(0\)"/.test(r0), '1 every row has the small ✕ skip and ✓ keep buttons');
    ok(/onclick="awPlanWeek\(\)"[^>]*>[\s\S]*?Plan my week/.test(dock()) && /class="aw-fab"/.test(dock()), '1 the floating "Plan my week" pill');
    spy = []; await c.awPlanWeek(); ok(spy.some(s => s[0] === 'ideasQuickGo'), '1 Plan my week runs the existing one-tap plan (ideasQuickGo)');
    c.window.innerWidth = 1440; c.awRender(); ok(/5 waiting · ✓ keeps, ✕ skips/.test(vis(ideas())), '1 on a desktop with a mouse the hint names the buttons'); c.window.innerWidth = 390; c.awRender();
  }
  // ═══ 2. keep / skip / swipe ═══
  spy = [];
  ok(c.awKeep(1) === true && J(spy) === J([['quickApprove', 1]]), '2 ✓ keep = quickApprove(id) (Film & Post + the "why" sheet, unchanged)');
  spy = []; ok(c.awSkip(2) === true && J(spy) === J([['showDismissPopupFn', 2]]), '2 ✕ skip = showDismissPopupFn(id) (the reasons sheet, unchanged)');
  spy = []; ok(c.awSwipeEnd(3, 120) === 'keep' && J(spy) === J([['quickApprove', 3]]), '2 swipe right keeps');
  spy = []; ok(c.awSwipeEnd(3, -120) === 'skip' && J(spy) === J([['showDismissPopupFn', 3]]), '2 swipe left skips');
  spy = []; ok(c.awSwipeEnd(3, 30) === '' && c.awSwipeEnd(3, -30) === '' && spy.length === 0, '2 a short swipe does nothing');
  spy = []; ok(c.awKeep(5) === false && c.awSkip(5) === false && spy.length === 0, '2 an idea that is not pending is refused');
  ok(/touch-action: pan-y/.test(css) && /touchstart/.test(AW) && /touchend/.test(AW), '2 rows take horizontal swipes, the page still scrolls');

  // ═══ 3. detail ═══
  setState(); c.activeView = 'ideas';
  ok(c.awOpen(0, 'ideas') === true, '3 a row opens the idea page');
  {
    const h = det(), t = vis(h);
    ok(/onclick="awBack\(\)"/.test(h) && /<h1 class="aw-h1">Water first, coffee second &lt;img/.test(h) && /<span class="aw-tag">Tip<\/span><span class="aw-tag ghost">Video<\/span><span>· about \d+ sec<\/span>/.test(h), '3 back, the title, type / format / length chips');
    const secs = [...h.matchAll(/<h2 class="aw-secl">([^<]+)<\/h2><button type="button" class="aw-cp"[^>]*onclick="awCopy\('(\w+)'\)"/g)].map(m => m[1] + ':' + m[2]);
    ok(J(secs) === J(['Hook:hook', 'Script:script', 'Shot list:shots', 'Caption &amp; tags:caption']), '3 sections Hook / Script / Shot list / Caption & tags, each with a copy button (' + secs.join(', ') + ')');
    ok(/class="aw-p aw-clamp"/.test(h) && />Show all</.test(h), '3 a long script is clamped with "Show all"');
    c.awShowAll(); ok(!/aw-clamp/.test(det()) && />Show less</.test(det()), '3 "Show all" opens the whole script'); c.awShowAll();
    ok((h.match(/<li><span class="aw-n">\d<\/span>/g) || []).length === 3 && t.includes('1 Alarm, kettle on, close-up'), '3 the shot list is numbered');
    ok(/class="hy-dots aw-dots" id="awDots" aria-label="More" aria-haspopup="menu" aria-expanded="false" onclick="awMenu\(\)"/.test(h), '3 the "⋯" button');
    ok(!/Sharpen|Viral twist|Redo with notes|B-roll|Make slides|Write 3 more/.test(t), '3 no extra tools as visible buttons');
    ok(/onclick="awFilm\(\)"[^>]*>[\s\S]*?Film it/.test(dock()) && /aria-label="Copy the script"[^>]*onclick="awCopy\('script'\)"/.test(dock()) && !/Plan my week/.test(dock()), '3 the sticky [Film it][copy] bar replaces the floating pill');
    c.awMenu();
    const m = det(), items = [...m.matchAll(/<button type="button" role="menuitem" onclick="event\.stopPropagation\(\);awAct\((\d+)\)">([^<]+)<\/button>/g)].map(x => x[2]);
    ok(/<div class="hy-menu aw-menu" role="menu">/.test(m) && ['Keep', 'Skip', 'B-roll preview', 'Sharpen', 'Viral twist', 'Redo with notes', 'Write 3 more like this', 'Copy everything'].every(x => items.includes(x)), '3 "⋯" holds the existing tools (' + items.join(', ') + ')');
    spy = []; c.awAct(items.indexOf('Sharpen')); ok(J(spy) === J([['sharpenIdea', 0]]) && !/role="menu"/.test(det()), '3 a menu row runs the existing function and the menu closes');
    spy = []; c.awMenu(); c.awAct(items.indexOf('Redo with notes')); ok(J(spy) === J([['ideaRedoOpen', 0]]) && /id="ideaRedo-0"/.test(det()), '3 Redo with notes opens in the page (its box is there)');
    written = []; c.awCopy('script'); c.awCopy('shots'); c.awCopy('caption');
    ok(written[0] === LONG && written[1] === '1. Alarm, kettle on, close-up\n2. Glass of water by the window\n3. Coffee, talk to camera ' + XSS && /^Water before coffee\./.test(written[2]) && /#morningroutine$/.test(written[2]), '3 copy copies the plain text of that section');
    // carousel / statement keep their own tools behind ⋯
    c.awOpen(2, 'ideas'); ok(/onclick="awSlides\(\)"[^>]*>[\s\S]*?Make slides/.test(dock()) && !/Film it/.test(dock()), '3 a carousel: the sticky button is Make slides');
    c.awOpen(3, 'ideas'); c.awMenu(); ok(/>Edit the statement</.test(det()) && /<h2 class="aw-secl">Text<\/h2>/.test(det()), '3 a statement: its text section + Edit the statement in ⋯');
    c.activeView = 'create'; c.awRender(); ok(det() === '' && els.awDetail.hidden === true, '3 another screen closes the idea page');
  }
  // ═══ 4. Film it ═══
  setState(); c.activeView = 'ideas'; c.awOpen(0, 'ideas'); saves = 0; tpOpened = 0;
  ok(c.awFilm() === true, '4 Film it');
  ok(c.state[0].status === 'filming' && c.state[0].approvedAt > 0 && saves >= 1, '4 …keeps the idea (pending → Film & Post, saved)');
  ok(els.teleprompterOverlay.classList.contains('open') && tpOpened === 1 && els.tpBody.innerHTML.includes('Eight hours of sleep') && els.tpTitle.textContent === c.state[0].title && V('_tpIdeaId') === 0,
    '4 …and opens the real teleprompter on this idea with its script (openTeleprompter: Mark done belongs to this post)');
  ok(!els.tpBody.innerHTML.includes(XSS), '4 the script reaches the teleprompter escaped');

  // ═══ 5. Pipeline ═══
  setState(); c.activeView = 'pipeline'; c.awRender();
  {
    const h = pipe(), t = vis(h);
    ok(/<h1 class="aw-title">Pipeline<\/h1>/.test(h) && /3 to film · 1 posted this week/.test(t), '5 title + "3 to film · 1 posted this week"');
    const gh = [...h.matchAll(/<div class="aw-gh"><span>([^<]+)<\/span><span>(\d+)<\/span><\/div>/g)].map(m => m[1] + ' ' + m[2]);
    ok(J(gh) === J(['To film 3', 'Posted 1']), '5 two calm groups, To film then Posted (no tabs; no Filmed group: nothing records it) — ' + gh.join(', '));
    const toFilm = h.slice(h.indexOf('To film'), h.indexOf('>Posted<'));
    ok(['Carousel to film', 'Film this one', 'Already kept'].every(x => toFilm.includes(x)) && !/Water first|Posted recently/.test(toFilm), '5 To film = the Film & Post posts only');
    const posted = h.slice(h.indexOf('>Posted<'));
    ok(posted.includes('Posted recently') && !posted.includes('Posted long ago') && /1 older post is kept/.test(posted) && /aw-row aw-prow aw-dim/.test(posted), '5 Posted = Done in the last 30 days (dimmed); older ones are said to be kept');
    ok(/<span class="aw-av" title="Kate Mills">KM<\/span>/.test(h) && /onclick="awOpen\(\d+,'pipeline'\)"/.test(h), '5 rows show who films it and open the idea page');
    ok(/id="awFilmNext" onclick="awFilmNext\(\)"[^>]*>[\s\S]*?Film next/.test(dock()), '5 the floating "Film next" pill');
    tpOpened = 0; const id = c.awFilmNext();
    ok(id === 8 && tpOpened === 1 && els.tpBody.innerHTML.includes('FILM NEXT SCRIPT'), '5 Film next opens the top filmable To film post in the teleprompter (a carousel above it is skipped)');
    c.awOpen(8, 'pipeline'); c.awMenu();
    ok(/>Mark as posted</.test(det()) && />Back to Ideas</.test(det()) && !/>Keep</.test(det()), '5 a To film post: Mark as posted / Back to Ideas in ⋯');
    spy = []; c.awAct([...det().matchAll(/role="menuitem" onclick="event\.stopPropagation\(\);awAct\((\d+)\)">([^<]+)</g)].find(x => x[2] === 'Mark as posted')[1] * 1);
    ok(J(spy) === J([['moveStage', 8, 'done']]), '5 Mark as posted = moveStage(id, \'done\')');
  }

  // ═══ 6. typed ideas in the main chat ═══
  c.activeView = 'create'; V('_cf.brandId = "b1"; _cf.data = { creators: [], videos: [], fetchedAt: null }; _cf.status = "ready";');
  c.hyNew(); calls = [];
  els.hyIn.value = 'why most people get hydration wrong <b>x</b>';
  await c.hySend();
  {
    const h = els.hyMain.innerHTML;
    const pills = [...h.matchAll(/<button type="button" class="hy-pill[^"]*" data-twist="([\w-]+)"[^>]*>([^<]+)<\/button>/g)].map(m => m[2]);
    ok(calls.length === 0 && J(pills) === J(['My take', 'Myth buster', 'Story', 'Quick tip', 'Q&amp;A', 'Series']), '6 typed text in an empty thread → the idea pills (' + pills.join(', ') + ')');
    ok(/Good one\. Pick a twist/.test(vis(h)) && h.includes('&lt;b&gt;x&lt;/b&gt;'), '6 "Good one. Pick a twist" under your words (escaped)');
  }
  route = async () => resp(200, { remix: { remixTitle: 'T', remixHook: 'H', remixScript: 'S', remixCaption: '', remixHashtags: '', remixFormat: 'video' } });
  calls = []; await c.hyTwist('myth');
  ok(calls.length === 1 && calls[0].url === '/api/remix' && calls[0].body.remixMode === 'flip' && calls[0].body.postDescription.indexOf('MY IDEA: why most people get hydration wrong') === 0
    && /\n\nANGLE: Make it a myth buster/.test(calls[0].body.postDescription) && calls[0].body.postUrl === '', '6 Myth buster runs /api/remix (mode flip + its angle line after your idea)');
  ok(/Your version <span class="hy-tag">Myth buster<\/span>/.test(els.hyMain.innerHTML) && els.hyIn.getAttribute('placeholder') === 'Ask for changes…', '6 the version is labelled with the pill; the input is now "Ask for changes…"');
  const modes = {};
  for (const id of ['remix', 'story', 'tip', 'qna', 'series']) { calls = []; await c.hyTwist(id); modes[id] = calls[0] && calls[0].body.remixMode; }
  ok(J(modes) === J({ remix: 'remix', story: 'remix', tip: 'simplify', qna: 'format-swap', series: 'series' }), '6 each idea pill maps to an existing /api/remix mode (' + J(modes) + ')');
  calls = []; ok(await c.hyTwist('roast') === false && calls.length === 0, '6 a remix-only twist is not offered on a typed idea');
  // a link → the remix set
  c.hyNew(); calls = [];
  route = async (url) => url === '/api/transcribe-url' ? resp(200, { transcript: 'Their words.' }) : resp(404, {});
  els.hyIn.value = 'https://www.tiktok.com/@morningcup/video/7341';
  await c.hySend(); await tick();
  {
    const pills = [...els.hyMain.innerHTML.matchAll(/<button type="button" class="hy-pill[^"]*" data-twist="([\w-]+)"[^>]*>([^<]+)<\/button>/g)].map(m => m[1]);
    ok(calls[0] && calls[0].url === '/api/transcribe-url' && J(pills) === J(['remix', 'simplify', 'flip', 'format-swap', 'series', 'roast']) && !/Good one/.test(els.hyMain.innerHTML), '6 a link → the remix set (My take, Simplify, Flip it …), unchanged');
  }

  // ═══ 7. menu, sidebar, palette ═══
  {
    const d = { console: c.console, JSON, String, Array, Object, Number, window: { APP_VERSION: 'vT' }, activeView: 'create', state: [], notebookNotes: [1, 2], bookmarkCategories: [{ entries: [1, 2, 3] }],
      getPendingIdeas: () => [1, 2, 3, 4, 5, 6], isBrandMinimumMet: () => true, csShelved: () => false, csUsageText: () => 'Pro · 312/750 this month', escHtml: c.escHtml,
      document: { getElementById: id => els[id] || null } };
    vm.createContext(d);
    vm.runInContext((/\nvar CS_REMIX_NAME = '[^'\n]+';/.exec(html) || [''])[0] + '\n' + between('var DS_ICONS = {', '\n};') + '\n};\n' + between('var CS_DRAWER_ICONS = {', '\n};') + '\n};\n'
      + line(/\nvar CS_LOCKED_VIEWS = [^\n]*/) + '\n' + grab('csNavLocked') + '\n' + between('var CS_DRAWER_GROUPS = [', '\n];') + '\n];\n' + grab('csDrawerCounts') + '\n' + grab('csDrawerHtml') + '\n' + grab('csDrawerClassic'), d);
    const dh = d.csDrawerHtml();
    const bodyPart = dh.slice(dh.indexOf('csd-body'), dh.indexOf('csd-foot'));
    const labels = [...bodyPart.matchAll(/<span class="csd-label">([^<]+)<\/span>/g)].map(m => m[1]);
    ok(J(labels) === J(['Make it yours', 'Ideas', 'Pipeline', 'Trends', 'What people search', 'Notebook', 'Creators', 'Coach', 'Settings']), '7 the menu order is exact (' + labels.join(', ') + ')');
    ok(/data-act="toggleBookmarkBar"[^>]*onclick="csDrawerClose\(\);toggleBookmarkBar\(\)">[\s\S]*?Creators<\/span><span class="csd-count">3<\/span>/.test(dh), '7 Creators = the Bookmarks list (same toggleBookmarkBar), with its count');
    const foot = dh.slice(dh.indexOf('csd-foot'));
    ok(/<button type="button" class="csd-item csd-fold" id="csdClassicBtn" aria-expanded="false" aria-controls="csdClassic" onclick="csDrawerClassic\(\)">/.test(foot) && /<div class="csd-classic-body" id="csdClassic" hidden>/.test(foot), '7 "Classic tools" at the bottom, collapsed');
    const cl = [...foot.matchAll(/<span class="csd-label">([^<]+)<\/span>/g)].map(m => m[1]);
    ok(J(cl) === J(['Classic tools', 'Quick Post', 'Idea Catcher', 'Classic Make it yours', 'Brand brain', 'Help']), '7 inside it: Quick Post, Idea Catcher, Classic Make it yours, Brand brain, Help');
    ok(/csd-credits[^>]*>Pro · 312\/750 this month<\/div><\/div>$/.test(dh), '7 the credits line is the very last thing');
    els.csdClassicBtn = mk('csdClassicBtn'); els.csdClassicBtn.setAttribute('aria-expanded', 'false'); els.csdClassic = mk('csdClassic'); els.csdClassic.hidden = true;
    ok(d.csDrawerClassic() === true && els.csdClassic.hidden === false && els.csdClassicBtn.getAttribute('aria-expanded') === 'true' && d.csDrawerClassic() === false && els.csdClassic.hidden === true, '7 tapping it opens and closes the fold');
    // desktop sidebar
    let built = null;
    const s = { console: c.console, String, window: { APP_VERSION: 'vT' }, escHtml: c.escHtml, syncDesktopNav() {}, renderUsagePill() {}, csxMod: () => 'Ctrl ',
      document: { getElementById: () => null, querySelector: () => ({ textContent: 'Acme' }), createElement: () => ({ innerHTML: '' }), body: { appendChild: e => { built = e; } } } };
    vm.createContext(s);
    vm.runInContext((/\nvar CS_REMIX_NAME = '[^'\n]+';/.exec(html) || [''])[0] + '\n' + between('var DS_ICONS = {', '\n};') + '\n};\n' + between('var CS_DRAWER_ICONS = {', '\n};') + '\n};\n' + grab('_dsItem') + '\n' + grab('buildDesktopSidebar'), s);
    s.buildDesktopSidebar(); const sb = built ? built.innerHTML : '';
    const main = sb.slice(0, sb.indexOf('ds-spring')), sl = [...main.matchAll(/<span>([^<]+)<\/span>/g)].map(m => m[1]).filter(x => !/New post|Acme/.test(x));
    ok(J(sl) === J(['Make it yours', 'Ideas', 'Pipeline', 'Trends', 'What people search', 'Notebook', 'Creators', 'Coach', 'Settings']), '7 the desktop sidebar follows the same order (' + sl.join(', ') + ')');
    ok(/id="dsClassicBtn" aria-expanded="false" aria-controls="dsClassic" onclick="dsClassic\(\)"/.test(sb) && /<div class="ds-classic" id="dsClassic" hidden>/.test(sb) && sb.lastIndexOf('id="dsPlan"') > sb.indexOf('id="dsClassic"'), '7 the sidebar folds Classic tools at the bottom, the plan line last');
    // palette
    const p = { console: c.console, String, Object, Array, document: { documentElement: { getAttribute: () => 'dark' } }, csShelved: () => false, allBrands: [], currentBrand: null };
    vm.createContext(p);
    vm.runInContext((/\nvar CS_REMIX_NAME = '[^'\n]+';/.exec(html) || [''])[0] + '\n' + grab('csxPaletteItems'), p);
    const go = p.csxPaletteItems().filter(i => i.g === 'Go to').map(i => i.label);
    ok(J(go) === J(['Make it yours', 'Ideas', 'Pipeline', 'Trends', 'What people search', 'Notebook', 'Creators', 'Coach', 'Settings']), '7 the ⌘K palette follows the same order (' + go.join(', ') + ')');
    ok(J(p.csxPaletteItems().filter(i => i.g === 'Classic tools').map(i => i.label)) === J(['Quick Post', 'Idea Catcher', 'Classic Make it yours', 'Brand brain']), '7 the palette keeps the classic tools under "Classic tools"');
  }

  // ═══ 8. XSS ═══
  setState(); c.activeView = 'ideas'; c.awRender();
  const raw = /<img src=x/;
  ok(!raw.test(ideas()) && ideas().includes('&lt;img src=x onerror=alert(1)&gt;'), '8 a title with markup is escaped in the Ideas list');
  c.awOpen(0, 'ideas');
  ok(!raw.test(det()) && (det().match(/&lt;img src=x onerror=alert\(1\)&gt;/g) || []).length >= 5, '8 title, hook, script, shot list and caption are escaped on the idea page');
  c.activeView = 'pipeline'; c.awRender();
  ok(!raw.test(pipe()) && pipe().includes('Film this one &lt;img'), '8 a title with markup is escaped in the Pipeline');

  // ═══ 10. review fixes ═══
  // (1) the Ideas header ⋯ + the hidden-format line
  setState(); c.activeView = 'ideas'; c.settings.formatMix = { qna: 0 }; c.awRender();
  ok(/<button type="button" class="aw-hidnote" onclick="openContentMix\(\)">1 hidden — format switched off<\/button>/.test(ideas()), '10.1 "1 hidden — format switched off" under the count (a switched-off format)');
  c.settings.formatMix = {}; c.awRender();
  ok(!/aw-hidnote/.test(ideas()) && /id="awIdeasDots" aria-label="Ideas tools" aria-haspopup="menu" aria-expanded="false" onclick="awIdeasMenu\(\)"/.test(ideas()), '10.1 no hidden line when nothing is hidden; a ⋯ in the Ideas header');
  c.awIdeasMenu();
  const IT = () => [...ideas().matchAll(/role="menuitem" onclick="event\.stopPropagation\(\);awIAct\((\d+)\)">([^<]+)</g)].map(m => m[2]);
  ok(J(IT()) === J(['Select several', 'Show skipped', 'Restore skipped ideas', 'Copy all kept', 'Generate ideas', 'Content mix']), '10.1 its tools: ' + IT().join(', '));
  const run = label => { const k = IT().indexOf(label); if (!/role="menu"/.test(ideas())) c.awIdeasMenu(); spy = []; c.awIAct(IT().indexOf(label) >= 0 ? IT().indexOf(label) : k); return spy; };
  ok(J(run('Restore skipped ideas')) === J([['resetAll']]) && !/aw-imenu/.test(ideas()), '10.1 Restore skipped ideas = resetAll (the menu closes)');
  ok(J(run('Copy all kept')) === J([['exportApproved']]), '10.1 Copy all kept = exportApproved');
  ok(J(run('Content mix')) === J([['openContentMix']]), '10.1 Content mix = openContentMix');
  run('Generate ideas'); await tick(); ok(spy.some(x => x[0] === 'generateNewIdeas'), '10.1 Generate ideas = generateNewIdeas');
  run('Show skipped');
  ok(/<h1 class="aw-title">Skipped<\/h1>/.test(ideas()) && /Skipped one/.test(ideas()) && !/Water first/.test(ideas()) && /onclick="event\.stopPropagation\(\);undoStatus\(6\)"/.test(ideas()) && dock().indexOf('Plan my week') < 0, '10.1 Show skipped lists the skipped ideas, each with ↺');
  spy = []; c.undoStatus(6); ok(J(spy) === J([['undoStatus', 6]]), '10.1 ↺ = undoStatus (back to Ideas)');
  c.awShowSkipped(false); ok(/<h1 class="aw-title">Ideas<\/h1>/.test(ideas()), '10.1 back to the ideas');
  c.awIdeasMenu(); run('Select several');
  ok(c._ideaSelectMode === true && /aw-row aw-irow aw-picking/.test(ideas()) && !/title="Keep"/.test(ideas()), '10.1 Select several: every row becomes a pick');
  c.awPick(0); c.awPick(3);
  ok(/aw-picking on/.test(ideas()) && /onclick="batchApprove\(\)">[\s\S]*?Keep 2/.test(dock()) && /onclick="awSelectEnd\(\)"/.test(dock()), '10.1 picked rows + a sticky "Keep 2" / cancel bar');
  spy = []; c.batchApprove(); ok(J(spy) === J([['batchApprove', [0, 3]]]), '10.1 Keep N = batchApprove on the picked ideas (the existing bulk approve)');
  c.awSelectEnd(); ok(c._ideaSelectMode === false && /title="Keep"/.test(ideas()), '10.1 cancel leaves picking');
  // (2) Assign…
  setState(); c.activeView = 'pipeline'; c.awRender(); c.awOpen(8, 'pipeline'); c.awMenu();
  { const items = [...det().matchAll(/role="menuitem" onclick="event\.stopPropagation\(\);awAct\((\d+)\)">([^<]+)</g)].map(x => x[2]);
    ok(items.includes('Assign…') && /id="assignPopup-8" class="assign-popup/.test(det()), '10.2 "Assign…" in the idea page ⋯, with the popup host on the page');
    spy = []; c.awAct(items.indexOf('Assign…')); ok(J(spy) === J([['toggleAssignPopup', 8]]), '10.2 Assign… = toggleAssignPopup(id)'); }
  c.awBack(); spy = []; ok(c.awAssign(7) === true && c.awDetailId() === 7 && J(spy) === J([['toggleAssignPopup', 7]]), '10.2 a long press on a Pipeline row opens its page with Assign… open');
  ok(/'pointerdown'/.test(AW) && /setTimeout\(function \(\) \{ t = null; awAssign\(/.test(AW) && /AW_HOLD = 500/.test(AW) && /awWireHold\(pipe\)/.test(AW), '10.2 the long press is wired on the Pipeline rows (500 ms)');
  // (3) carousel / image
  setState(); c.activeView = 'ideas'; c.awOpen(2, 'ideas'); tpOpened = 0; spy = []; els.teleprompterOverlay.classList.remove('open');
  ok(c.awFilm() === true && J(spy) === J([['openCarouselMaker', 2]]) && tpOpened === 0 && !els.teleprompterOverlay.classList.contains('open') && c.state[2].status === 'pending', '10.3 a carousel never opens the teleprompter: the slide maker opens');
  c.state[2].format = 'static'; c.awRender(); ok(/Make the image/.test(dock()), '10.3 an image: "Make the image"');
  // (4) swipe safety + Undo
  ok(c.awSwipeAct(95) === '' && c.awSwipeAct(-95) === '' && c.awSwipeAct(96) === 'keep' && c.awSwipeAct(-96) === 'skip', '10.4 a swipe commits only at 96 px');
  ok(c.awSwipeLock(17, 8) === true && c.awSwipeLock(17, 9) === false && c.awSwipeLock(16, 0) === false && c.awSwipeLock(-40, 10) === true, '10.4 sideways lock: more than 16 px and more than twice the vertical move');
  ok(c.awSwipeDrift(25) === true && c.awSwipeDrift(-25) === true && c.awSwipeDrift(24) === false, '10.4 more than 24 px up or down after the lock cancels it');
  ok(/else if \(awSwipeDrift\(dy\)\) \{ awSwipeReset\(s\); _aw\.sw = null; return; \}/.test(AW) && /if \(!awSwipeLock\(dx, dy\)\) return;/.test(AW), '10.4 the touch handler uses both rules');
  setState(); c.activeView = 'ideas'; c.awRender(); toasts = []; spy = [];
  ok(c.awSwipeEnd(1, 120) === 'keep' && toasts.length === 1 && toasts[0][0] === 'Kept' && toasts[0][1] === 5000 && toasts[0][3] === 'Undo' && typeof toasts[0][2] === 'function', '10.4 a swipe keep shows "Kept · Undo" for 5 s');
  c.state[1].status = 'filming'; spy = []; toasts[0][2]();
  ok(J(spy) === J([['closeApproveSheet'], ['undoStatus', 1]]), '10.4 Undo after a keep: the why-sheet closes, undoStatus puts it back');
  toasts = []; spy = []; ok(c.awSwipeEnd(2, -120) === 'skip' && toasts[0][3] === 'Undo', '10.4 a swipe skip offers Undo too');
  spy = []; toasts[0][2](); ok(J(spy) === J([['cancelDismissPopup']]), '10.4 Undo while the reasons sheet is open cancels it');
  c.state[2].status = 'dismissed'; spy = []; toasts[0][2](); ok(J(spy) === J([['undoStatus', 2]]), '10.4 Undo after the skip was saved = undoStatus');
  toasts = []; ok(c.awSwipeEnd(3, 60) === '' && toasts.length === 0, '10.4 a short swipe: nothing, no toast');
  ok(/function showToast\(message, duration = 3000, onTap, cta\)/.test(html) && /\$\{cta \? /.test(html), '10.4 the toast can say "Undo" (showToast\'s new optional word; "View ›" stays the default)');
  // nits
  ok(/try \{ if \(typeof awReset === 'function'\) awReset\(\); \} catch \(e\) \{\}/.test(grab('csOpenPushIdeas')), '10.5 a push link closes the idea page and lands on the plain list');
  ok(/csd-classic-open/.test(grab('csDrawerClassic')) && /\.csd-panel\.csd-classic-open \{ overflow-y: auto;/.test(css), '10.5 with Classic tools open the whole menu scrolls');

  // ═══ 9. wiring + one shared style ═══
  {
    const vIdeas = html.indexOf('<div class="view" id="view-ideas">'), vPipe = html.indexOf('<div class="view" id="view-pipeline">');
    ok(html.indexOf('<section class="aw-screen" id="awIdeas"') > vIdeas && html.indexOf('<section class="aw-screen" id="awIdeas"') < html.indexOf('id="filmingQueueContainer"'), '9 the calm Ideas list is the first thing in the Ideas view (the old markup stays below it)');
    ok(html.indexOf('<section class="aw-screen" id="awPipe"') > vPipe && html.indexOf('<section class="aw-screen" id="awPipe"') < html.indexOf('id="pipelineStages"'), '9 the calm Pipeline is the first thing in the Pipeline view');
    ok(html.indexOf('<section class="aw-detail" id="awDetail"') < vIdeas && html.indexOf('<div class="aw-dock" id="awDock"></div>') > html.indexOf('<!-- /view-create -->'), '9 the idea page sits before the views; the dock outside .view');
    ok(/\['renderIdeas', 'renderPipeline'\]\.forEach/.test(AW) && /try \{ awRender\(\); \} catch/.test(AW), '9 every redraw of the old lists redraws the calm ones');
    ok(/body\.aw-on #view-ideas > :not\(#awIdeas\), body\.aw-on #view-pipeline > :not\(#awPipe\) \{ display: none !important; \}/.test(css) && /body:not\(\.aw-on\) \.aw-screen/.test(css), '9 the old Ideas / Pipeline markup is hidden only while the calm screens run');
    const shared = ['.aw-gh,\n.hy-day {', '.aw-row,\n.hy-row {', '.aw-rt,\n.hy-rt {', '.aw-rm,\n.hy-rm {', '.aw-tag,\n.hy-tag {', '.aw-pill,\n.hy-pill {', '.aw-bar,\n.hy-bar {', '.aw-film,\n.hy-film {', '.aw-sq,\n.hy-copy {'];
    const miss = shared.filter(x => !css.includes(x));
    ok(!miss.length, '9 one shared rule set: list row, group header, chip, pill, sticky bar (the v714 hy-* names are aliases in the same rules)' + (miss.length ? ' — missing ' + miss.join(' | ') : ''));
    ok(['tag', 'pill', 'film', 'copy'].every(k => (css.match(new RegExp('\\n\\.hy-' + k + ' \\{', 'g')) || []).length === 1), '9 the old duplicate hy-* rules are gone (chip, pill, Film it, copy live only in the shared rules)');
    const rule = sel => [...css.matchAll(new RegExp('(?:^|\\n|,\\n)' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]*)\\}', 'g'))].map(m => m[1]).join(';');
    const px = (b, p) => { const m = new RegExp('(?:^|;|\\s)' + p + ':\\s*(\\d+)px').exec(b); return m ? +m[1] : 0; };
    const T = { '.aw-ib': 'height', '.aw-cp': 'height', '.aw-fab': 'height', '.hy-film': 'height', '.hy-copy': 'height', '.hy-row': 'min-height', '.hy-pill': 'min-height' };
    const small = Object.entries(T).filter(([s, p]) => px(rule(s), p) < 44).map(([s, p]) => s + ' ' + p + ' ' + px(rule(s), p));
    ok(!small.length, '9 tap targets ≥44 px (' + (small.join(', ') || 'all') + ')');
    ok(/font-size: 28px/.test(rule('.aw-title')) && /font-size: 16px/.test(rule('.hy-rt')) && /font-size: 14px/.test(rule('.hy-day')), '9 one type scale: screen title 28, row 16, group 14');
  }

  finished = true;
  if (fail) { console.log(fail + ' check(s) failed'); process.exit(1); }
  console.log('APPWIDE P1 OK');
})().catch(e => { console.log('FAIL: threw', e && e.stack || e); process.exit(1); });
