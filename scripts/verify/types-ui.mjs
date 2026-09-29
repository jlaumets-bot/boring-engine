#!/usr/bin/env node
// GATE (types, leaf U): "what is the post about" in the app — EXECUTED. The real functions are lifted
// from app.html and run in node:vm against a fake DOM, a fake fetch and a fake PostgREST.
// See .unlazy/types/PLAN.md.
//   A  Quick Post chip row above the circle: Tip · About us · News · Q&A · Story · Behind the scenes ·
//      Surprise me (default; back to Surprise me on every app open / other brand); weighted pick by the mix.
//   B  the pick goes as postType to /api/angles and /api/write, the saved idea keeps it (+ news source);
//      "Rewrite as spoken script" sends the idea's own type; the classic path sends it too.
//   C  409 no_news: plain message under the chips, sheet closed, chips stay; Surprise me re-draws.
//   D  Plan my week steppers: bounds (0..10 each, total 1..14), saved to settings.typeMix → voice_extra,
//      read back validated, sent as typeMix with count = total.
//   E  auto-refill asks for the approved idea's type.
//   F  idea cards: type label, "Source: <headline>" link (https only), "By type" filter; old ideas fine.
//   G  post_type ↔ postType save/load, newsSource kept on the device + in the caption, missing-column retry.
// RUN: node scripts/verify/types-ui.mjs      EXPECT: prints "TYPES UI OK", exit 0.
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
const between = (a, b) => { const i = html.indexOf(a); const j = html.indexOf(b, i); if (i < 0 || j < 0) throw new Error('marker missing: ' + a.slice(0, 40)); return html.slice(i, j); };
const tick = async (n = 14) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const lift = (c, names) => { for (const n of names) vm.runInContext(grab(n), c); };
const CONST_RX = /^const (POST_TYPE_IDS|POST_TYPE_LABELS|DEFAULT_TYPE_MIX|TYPE_MIX_MAX_TOTAL|TYPES_NO_NEWS_MSG|FORMATS|FORMAT_LABELS) = .*$/gm;
const CONSTS = [...html.matchAll(CONST_RX)].map(m => m[0].replace(/^const /, 'var '));
const TYPES_BLOCK = between('/* types — "what is today\'s post about?"', '// ===== IDEAS (LIST) VIEW =====');
const liftTypes = (c) => { for (const s of CONSTS) vm.runInContext(s, c); vm.runInContext(TYPES_BLOCK, c); lift(c, ['escHtml', 'escAttr', 'safeUrl']); };
const liftEmph = (c) => { lift(c, ['tpEscape', 'tpOutsideTags', 'tpSenseLines', 'tpStressRx', 'tpEmphasise', 'tpPruneEmphasis', 'tpCleanEmphasis']);
  for (const m of html.matchAll(/^const (TP_STRESS_[AB]) = .*$/gm)) vm.runInContext(m[0].replace(/^const /, 'var '), c); };
const MSG = 'No fresh news in your category today — try another type';

function makeDom() {
  const els = {};
  function mk(id, extra) {
    return Object.assign({ id, value: '', innerHTML: '', textContent: '', className: '', disabled: false, attrs: {}, style: {}, dataset: {}, children: [],
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      getAttribute(k) { return this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = String(v); }, removeAttribute(k) { delete this.attrs[k]; },
      appendChild(ch) { this.children.push(ch); return ch; }, querySelector() { return null; }, focus() {}, scrollIntoView() {},
      remove() { if (els[this.id] === this) delete els[this.id]; this.removed = true; } }, extra || {});
  }
  const document = { getElementById: id => els[id] || null, createElement: () => mk(''),
    body: { style: {}, appendChild(e) { if (e.id) els[e.id] = e; return e; }, removeChild() {} },
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
  return { els, mk, document, put: (id, extra) => (els[id] = mk(id, extra)) };
}
// fake PostgREST: an unknown column is refused like PostgREST does (PGRST204)
function makeDb(columns) {
  const cols = new Set(columns); const rows = []; let seq = 0; const inserts = [];
  const db = { rows, inserts };
  db.from = (table) => {
    const q = { op: null, filters: [], payload: null, order: null, range: null };
    const run = () => {
      if (q.op === 'insert') {
        const list = Array.isArray(q.payload) ? q.payload : [q.payload];
        inserts.push(JSON.parse(JSON.stringify(list)));
        for (const r of list) for (const k of Object.keys(r)) if (!cols.has(k))
          return { data: null, error: { code: 'PGRST204', message: `Could not find the '${k}' column of '${table}' in the schema cache` } };
        for (const r of list) { seq++; const st = { id: 'id-' + seq, created_at: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString() };
          for (const c of cols) if (!(c in st)) st[c] = (c in r) ? JSON.parse(JSON.stringify(r[c])) : null; rows.push(st); }
        return { data: null, error: null };
      }
      const hit = rows.filter(r => q.filters.every(f => f(r)));
      if (q.op === 'delete') { for (const r of hit) rows.splice(rows.indexOf(r), 1); return { data: hit.map(r => ({ id: r.id })), error: null }; }
      let out = hit.slice();
      if (q.order) out.sort((a, b) => (a[q.order[0]] < b[q.order[0]] ? -1 : 1) * q.order[1]);
      if (q.range) out = out.slice(q.range[0], q.range[1] + 1);
      return { data: out.map(r => JSON.parse(JSON.stringify(r))), error: null };
    };
    const b = { select() { if (!q.op) q.op = 'select'; return b; }, insert(p) { q.op = 'insert'; q.payload = p; return b; },
      delete() { q.op = 'delete'; return b; }, eq(k, v) { q.filters.push(r => r[k] === v); return b; },
      in(k, vs) { q.filters.push(r => vs.includes(r[k])); return b; }, order(k, x) { q.order = [k, x && x.ascending === false ? -1 : 1]; return b; },
      range(a, z) { q.range = [a, z]; return b; }, then(res, rej) { return Promise.resolve().then(run).then(res, rej); } };
    return b;
  };
  return db;
}
const BASE_COLS = ['id', 'brand_id', 'day', 'community', 'format', 'title', 'hook', 'script', 'shots', 'screen', 'caption', 'reel_title',
  'tags', 'bold_text', 'status', 'dismiss_reason', 'assignee', 'is_generated', 'created_at', 'is_remix', 'original_creator'];
const baseCtx = (dom, extra) => {
  const c = Object.assign({
    console: { log() {}, warn() {}, error() {}, info() {} }, JSON, Promise, Date, Math, String, Number, Array, Object, Set, Map, RegExp, Error, TypeError, URL, AbortController, isFinite,
    window: {}, state: [], IDEAS: [], currentBrand: { id: 'b1' }, _switchSeq: 0, document: dom.document, settings: {},
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, lsSet: () => true, lsGet: () => null,
  }, extra || {});
  c.globalThis = c;
  return c;
};

(async () => {
  ok(CONSTS.length === 7, 'the type constants are single top-level lines in app.html (' + CONSTS.length + '/7)');
  ok(/^const DEFAULT_TYPE_MIX = \{tip:3,about:1,news:1,qna:1,story:1,bts:0\};$/m.test(html), 'DEFAULT_TYPE_MIX is the PLAN\'s {tip:3,about:1,news:1,qna:1,story:1,bts:0}');

  // ═════════ A — Quick Post chip row ═════════
  {
    const dom = makeDom();
    const mkCtx = () => { const c = baseCtx(dom, { getTodayName: () => 'Monday', getDayCommunities: () => ({ Monday: 'Myth Monday' }), isBrandMinimumMet: () => c.__ok !== false,
      homeBrainNudgeHtml: () => '', getMissingFields: () => ['Brand name'], localStorage: { getItem: () => null } });
      vm.createContext(c); liftTypes(c); lift(c, ['renderTodayView']); return c; };
    let c = mkCtx();
    dom.put('view-today'); c.renderTodayView();
    const page = dom.els['view-today'].innerHTML;
    const chips = [...page.matchAll(/<button type="button" class="qp-type( active)?"[^>]*>([^<]+)<\/button>/g)].map(m => [m[2], !!m[1]]);
    ok(J(chips.map(x => x[0])) === J(['Tip', 'About us', 'News', 'Q&amp;A', 'Story', 'Behind the scenes', 'Surprise me']), 'A the chips, in order: ' + J(chips.map(x => x[0])));
    ok(J(chips.filter(x => x[1]).map(x => x[0])) === J(['Surprise me']), 'A Surprise me is the one selected on open');
    ok(page.indexOf('What’s today’s post about?') > 0 && page.indexOf('id="tvTypeRow"') > 0 && page.indexOf('id="tvTypeRow"') < page.indexOf('id="tvGenerateBtn"'),
      'A "What’s today’s post about?" sits ABOVE the circle');
    dom.put('tvTypeRow'); dom.put('tvStatus');
    c.tvSetPostType('news');
    ok(c.window._tvPostType === 'news' && /class="qp-type active" aria-pressed="true"[^>]*>News</.test(dom.els.tvTypeRow.innerHTML) && (dom.els.tvTypeRow.innerHTML.match(/qp-type active/g) || []).length === 1,
      'A tapping News selects it (and only it), without redrawing the circle');
    c.tvSetPostType('bogus'); ok(c.window._tvPostType === 'surprise', 'A an unknown type falls back to Surprise me');
    c.tvSetPostType('story'); c.renderTodayView();
    ok(/qp-type active[^>]*>Story</.test(dom.els['view-today'].innerHTML), 'A the pick stays while the same brand stays open');
    c.currentBrand = { id: 'b2' }; c.renderTodayView();
    ok(/qp-type active[^>]*>Surprise me</.test(dom.els['view-today'].innerHTML) && c.window._tvPostType === 'surprise', 'A another brand opens on Surprise me');
    c = mkCtx(); c.window._tvPostType = undefined; c.renderTodayView();
    ok(/qp-type active[^>]*>Surprise me</.test(dom.els['view-today'].innerHTML), 'A a fresh app open is Surprise me (the pick is not remembered)');
    c.__ok = false; c.currentBrand = { id: 'b3' }; c.renderTodayView();
    ok(!/qp-type/.test(dom.els['view-today'].innerHTML), 'A a brand that is not set up yet shows no chips (the circle is locked anyway)');

    // weighted pick
    c = mkCtx();
    const sweep = (mix, ex) => { const n = {}; for (let i = 0; i < 700; i++) { const t = c.typesPickWeighted(mix, ex, () => (i + 0.5) / 700); n[t] = (n[t] || 0) + 1; } return n; };
    ok(J(sweep(c.DEFAULT_TYPE_MIX)) === J({ tip: 300, about: 100, news: 100, qna: 100, story: 100 }), 'A Surprise me is weighted by the mix (default: 3/7 tip, 1/7 each, never bts): ' + J(sweep(c.DEFAULT_TYPE_MIX)));
    ok(!('news' in sweep(c.DEFAULT_TYPE_MIX, ['news'])), 'A an excluded type is never drawn');
    ok(J(sweep({ bts: 2, story: 0 })) === J({ bts: 700 }), 'A a brand mix of only Behind the scenes always draws it');
    c.settings = { typeMix: { about: 3 } }; c.window._tvPostType = 'surprise';
    const rs = c.tvResolvePostType(); ok(rs.type === 'about' && rs.surprise === true, 'A Surprise me draws from the BRAND\'s saved mix');
    c.window._tvPostType = 'qna'; const rq = c.tvResolvePostType(); ok(rq.type === 'qna' && rq.surprise === false, 'A a picked chip is used as is');
    ok(J(c.typesNormMix({ tip: 99, about: -1, zzz: 5, news: '2' })) === J({ tip: 8, about: 0, news: 2, qna: 0, story: 0, bts: 0 }) && J(c.typesNormMix({ tip: 0 })) === J(c.DEFAULT_TYPE_MIX)
      && J(c.typesNormMix({ tip: 10, about: 10 })) === J({ tip: 5, about: 5, news: 0, qna: 0, story: 0, bts: 0 }), 'A a stored mix is validated: 0..10 each, total 1..10, junk → default');
    ok(c.TYPE_MIX_MAX_TOTAL === 10 && J(c.typesNormMix({ tip: 6, about: 3, news: 3 })) === J({ tip: 5, about: 3, news: 2, qna: 0, story: 0, bts: 0 })
      && J(c.typesNormMix({ tip: 7, about: 3, news: 1, qna: 1 })) === J({ tip: 6, about: 2, news: 1, qna: 1, story: 0, bts: 0 }),
      'A a mix above 10 (the server\'s batch cap) is scaled down to exactly 10 by largest remainders');
  }

  // ═════════ B + C — Quick Post sends the type; 409 no_news ═════════
  {
    const dom = makeDom(); const toasts = []; const calls = []; let route; let classic = 0;
    async function fetch(url, init) { const body = init && init.body ? JSON.parse(init.body) : null; calls.push({ url, body }); const r = await route(url, body);
      const t = JSON.stringify(r.body || {}); return { ok: r.status >= 200 && r.status < 300, status: r.status, url, text: async () => t, json: async () => JSON.parse(t), clone() { return this; } }; }
    const c = baseCtx(dom, { fetch, currentBrand: { id: 'brand-1' }, showToast: (m) => toasts.push(String(m)), btnWork: () => () => {}, flushBrandSave: async () => {}, getBrandContext: () => ({ brandName: 'X' }),
      _humanEditedTitles: () => [], saveState() {}, saveGeneratedIdeas() { return Promise.resolve({ ok: true }); }, DELIVERY_FORMATS: new Set(['video', 'micro', 'qna', 'statement']), saveIdeasToDB() {},
      renderNav() {}, switchView() {}, mascotReact() {}, refreshCurrentView() {}, renderRemixResults() {}, openTeleprompter() {}, autoRefillCheck() {}, showApprovePopupFn() {},
      notebookNotes: [], nbDevelop() {}, ideaDevelop() {}, usePAAQuestion() {}, generateTodayTabPost() { classic++; }, paaQuestions: [], paaUsed: new Set(),
      savePAAState() {}, renderPAASection() {}, refShotClear() {}, icDraftClear() {}, firstRunBrandGuard: () => false, getTodayName: () => 'Monday', getDayCommunities: () => ({ Monday: 'Myth Monday' }), DAYS: ['Monday'],
      lsSet: () => true, lsGet: () => null, lsDel() {} });
    vm.createContext(c);
    lift(c, ['escapeHtml', 'humanErr', '_leanNetFail', '_leanErrMsg', 'csAiPausedText', '_tvBcFieldCount', 'brandGate', 'asText', 'reindexIdeas', '_buildIdeaRows']);
    liftEmph(c); liftTypes(c);
    vm.runInContext(between('/* v693 — REMIX, REBUILT', '\nfunction removeRemix(idx) {').replace(/^(let|const) /gm, 'var '), c);
    const NEWS = { title: 'Salt prices rise 20%', url: 'https://news.example/salt' };
    const ANG = [{ id: 'a1', belief: 'Salt is not the enemy', why: 'w', newsSource: NEWS }];
    const IDEA = { title: 'Salt is fine', hook: 'Salt is fine.', script: 'Everyone fears salt.\n\nThey should not.', onScreen: [], caption: 'Salt, explained.', shots: 'Talking head', emphasis: [], hashtags: [] };
    let writeReply = (b) => ({ status: 200, body: { idea: Object.assign({}, IDEA, { format: b.format }, b.postType ? { postType: b.postType } : {}, b.postType === 'news' ? { newsSource: NEWS } : {}) } });
    let anglesReply = () => ({ status: 200, body: { angles: ANG } });
    route = (u, b) => u === '/api/angles' ? anglesReply(b) : u === '/api/write' ? writeReply(b) : { status: 200, body: {} };
    const reset = () => { calls.length = 0; toasts.length = 0; classic = 0; for (const k of Object.keys(dom.els)) delete dom.els[k];
      vm.runInContext('rv2SetRun("rv2Panel", null); rv2SetRun("rv2Sheet", null); state = []; IDEAS = []; window = {}; currentBrand = { id: "brand-1" }; settings = {};', c);
      dom.put('tvTypeRow', { innerHTML: 'CHIPS' }); dom.put('tvStatus'); };
    const angles = () => calls.filter(x => x.url === '/api/angles'), writes = () => calls.filter(x => x.url === '/api/write');
    const quick = async (type, fmt) => { reset(); c.window._tvSelectedFormat = fmt || 'video'; c.window._tvPostType = type; await c.tvGenerateV2(); await tick(); await c.rv2Pick(0); await tick(); const r = await c.rv2Save(); await tick(); return r; };

    let saved = await quick('news');
    ok(angles().length === 1 && angles()[0].body.postType === 'news', 'B News → /api/angles gets postType "news"');
    ok(writes().length === 1 && writes()[0].body.postType === 'news' && writes()[0].body.newsSource && writes()[0].body.newsSource.url === NEWS.url, 'B ...and /api/write gets postType "news" (+ the picked headline)');
    ok(saved && saved.postType === 'news' && saved.newsSource && saved.newsSource.url === NEWS.url && saved.newsSource.title === NEWS.title, 'B the saved idea keeps postType + newsSource');
    ok(saved && saved.caption === 'Salt, explained.\n\nSource: ' + NEWS.url, 'B ...and the link rides in the caption: ' + J(saved && saved.caption));
    ok(c._buildIdeaRows('brand-1')[0].post_type === 'news', 'B ...and reaches the database row as post_type');
    saved = await quick('qna', 'carousel');
    ok(angles()[0].body.postType === 'qna' && writes()[0].body.format === 'talking' && saved.format === 'qna' && saved.postType === 'qna', 'B a Q&A post is a Q&A (format qna), whatever format was last picked');
    reset(); c.settings = { typeMix: { story: 2 } }; c.window._tvPostType = 'surprise'; await c.tvGenerateV2(); await tick();
    ok(angles()[0].body.postType === 'story' && c.window._tvPostTypeRun === 'story', 'B Surprise me sends the type it drew from the brand mix');
    ok(c.tvClassicPostType() === 'story', 'B the classic writer (sheet footer link) gets that same drawn type');
    c.window._tvPostType = 'tip'; ok(c.tvClassicPostType() === 'tip', 'B ...or the picked chip');
    ok(/\.\.\.\(\(typeof tvClassicPostType === 'function' && tvClassicPostType\(\)\) \? \{ postType: tvClassicPostType\(\) \} : \{\}\)/.test(between('const _tvBody = (lean) => {', 'if (lean)')),
      'B the classic Quick Post request body carries postType');
    saved = await quick('surprise'); ok(saved && c.POST_TYPE_IDS.includes(saved.postType) && angles()[0].body.postType === saved.postType, 'B a Surprise me post is saved with the type it was written as');
    // rewrite keeps the idea's own type
    reset(); c.state = [{ id: 0, title: 'T1', format: 'video', belief: 'b', hook: 'h', script: 's', postType: 'story' }, { id: 1, title: 'T2', format: 'video', belief: 'b', hook: 'h', script: 's' },
      { id: 2, title: 'T2q', format: 'qna', belief: 'b', hook: 'h', script: 's' }];
    await c.rv2RewriteIdea(0); await tick(); await c.rv2RewriteIdea(1); await tick(); await c.rv2RewriteIdea(2); await tick();
    ok(J(writes().map(w => w.body.postType)) === J(['story', 'tip', 'qna']), 'B "Rewrite as spoken script" sends the idea\'s type (an old idea: tip, or qna for a Q&A): ' + J(writes().map(w => w.body.postType)));
    reset(); c.state = [{ id: 0, title: 'T3', format: 'video', belief: 'b', hook: 'h', script: 's', postType: 'news', newsSource: NEWS }];
    await c.rv2RewriteIdea(0); await tick();
    ok(writes()[0].body.postType === 'news' && J(writes()[0].body.newsSource) === J(NEWS), 'B rewriting a news idea sends its own headline back');
    // the angle list keeps only safe sources
    reset(); anglesReply = () => ({ status: 200, body: { angles: [{ id: 'x', belief: 'B1', why: '', newsSource: { title: 'h', url: 'javascript:alert(1)' } }, { id: 'y', belief: 'B2', why: '', newsSource: { title: 'h', url: 'http://plain.example' } }] } });
    c.window._tvPostType = 'news'; await c.tvGenerateV2(); await tick();
    ok(J(c._rv2Runs.rv2Sheet.angles.map(a => !!a.newsSource)) === J([false, false]), 'B a javascript: or http: source on an angle is dropped');
    anglesReply = () => ({ status: 200, body: { angles: ANG } });

    // ── C: no_news ──
    reset(); anglesReply = (b) => b.postType === 'news' ? { status: 409, body: { code: 'no_news', error: 'no_news' } } : { status: 200, body: { angles: ANG } };
    c.window._tvPostType = 'news'; await c.tvGenerateV2(); await tick();
    ok(angles().length === 1 && !c._rv2Runs.rv2Sheet, 'C 409 no_news: the sheet closes (nothing paid, nothing retried)');
    ok(dom.els.tvStatus.textContent === MSG && toasts.includes(MSG), 'C ...and says "' + MSG + '"');
    ok(dom.els.tvTypeRow && dom.els.tvTypeRow.innerHTML === 'CHIPS' && c.window._tvPostType === 'news', 'C ...the chips stay as they were');
    c.tvSetPostType('tip'); ok(dom.els.tvStatus.textContent === '', 'C picking another type clears the message');
    reset(); c.settings = { typeMix: { tip: 1, news: 1 } }; c.window._tvPostType = 'surprise'; const _M = c.Math; c.Math = Object.assign(Object.create(Math), { random: () => 0.9 });
    await c.tvGenerateV2(); await tick(); c.Math = _M;
    ok(J(angles().map(x => x.body.postType)) === J(['news', 'tip']) && c._rv2Runs.rv2Sheet && c._rv2Runs.rv2Sheet.stage === 'angles' && !dom.els.tvStatus.textContent,
      'C Surprise me that drew News with no news re-draws another type by itself: ' + J(angles().map(x => x.body.postType)));
    reset(); anglesReply = () => ({ status: 200, body: { angles: ANG } }); writeReply = () => ({ status: 409, body: { code: 'no_news' } });
    c.window._tvPostType = 'news'; await c.tvGenerateV2(); await tick(); await c.rv2Pick(0); await tick();
    ok(c._rv2Runs.rv2Sheet.stage === 'angles' && c._rv2Runs.rv2Sheet.err === MSG, 'C a no_news from /api/write says the same plain line');
  }

  // ═════════ D — Plan my week steppers ═════════
  {
    const dom = makeDom(); let saves = 0;
    const c = baseCtx(dom, { saveSettings() { saves++; } });
    vm.createContext(c); liftTypes(c);
    dom.put('ideasMixSlot'); c.ideasMixRender();
    const slot = () => dom.els.ideasMixSlot.innerHTML;
    const counts = () => [...slot().matchAll(/<span class="mix-n" id="mixN-(\w+)">(\d+)<\/span>/g)].map(m => m[1] + ':' + m[2]).join(',');
    ok(counts() === 'tip:3,about:1,news:1,qna:1,story:1,bts:0' && /7 posts/.test(slot()), 'D the card shows the default mix, total 7: ' + counts());
    ok(/One less Behind the scenes" onclick="ideasMixStep\('bts',-1\)" disabled/.test(slot()), 'D − is disabled at 0');
    ok(c.ideasMixStep('bts', 1) === true && c.settings.typeMix.bts === 1 && saves === 1 && /8 posts/.test(slot()), 'D + adds one, saves the brand (settings.typeMix) and redraws the total');
    c.settings.typeMix = { tip: 1 }; saves = 0; c.ideasMixRender();
    ok(c.ideasMixStep('tip', -1) === false && saves === 0 && /One less Tip" onclick="ideasMixStep\('tip',-1\)" disabled/.test(slot()), 'D the total never drops below 1');
    c.settings.typeMix = { tip: 6, about: 4 }; c.ideasMixRender();
    ok(c.ideasMixStep('story', 1) === false && (slot().match(/,1\)" disabled>\+/g) || []).length === 6 && /10 posts \u00b7 up to 10/.test(slot()), 'D the total never goes above 10, the server\'s cap (every + disabled, card says "up to 10")');
    c.settings.typeMix = { tip: 9 };
    ok(c.ideasMixStep('tip', 1) === true && c.ideasMixStep('tip', 1) === false && c.ideasMixStep('about', 1) === false && c.settings.typeMix.tip === 10, 'D ...one type alone can fill all 10, then + stops');
    c.settings.typeMix = { tip: 8, news: 6 }; c.ideasMixRender();
    ok(/10 posts/.test(slot()) && counts() === 'tip:6,about:0,news:4,qna:0,story:0,bts:0', 'D a saved mix above 10 shows scaled to 10: ' + counts());
    ok(c.ideasMixStep('nope', 1) === false, 'D an unknown type is ignored');
    // save / load through the brand row
    lift(c, ['settingsToBrand', 'brandToSettings']);
    Object.assign(c, { currentUser: { id: 'u1' }, bvState: { messages: [] }, currentBrand: { id: 'b1', voice_extra: {} }, defaultSettings: () => ({}) });
    c.settings = { typeMix: { tip: 2, news: 1, about: 0, qna: 0, story: 0, bts: 0 } };
    ok(J(c.settingsToBrand().voice_extra.typeMix) === J(c.settings.typeMix), 'D the mix is saved in voice_extra.typeMix');
    c.settings = {}; ok(!('typeMix' in c.settingsToBrand().voice_extra), 'D ...and not written until the person changes it');
    ok(J(c.brandToSettings({ voice_extra: { typeMix: { tip: '2', news: 20, zzz: 3 } } }).typeMix) === J({ tip: 2, about: 0, news: 8, qna: 0, story: 0, bts: 0 }), 'D a loaded mix is validated (and scaled to 10)');
    c.settings = c.brandToSettings({ voice_extra: {} }); ok(c.settings.typeMix === null && J(c.typesMix()) === J(c.DEFAULT_TYPE_MIX), 'D no saved mix → the default');
    // generateNewIdeas: typeMix + count
    const bodies = []; const st = dom.put('generateStatus'); dom.put('generateIdeasBtn');
    let reply = { ideas: [] };
    Object.assign(c, { firstRunBrandGuard: () => false, btnWork: () => () => {}, brandGate: () => () => true, state: [], IDEAS: [], DAYS: ['Monday'], getDayCommunities: () => ({ Monday: 'M' }),
      getVisibleIdeas: () => c.state, leanBrandFetch: async (u, body) => { bodies.push(body); return {}; }, readJsonOrThrow: async () => JSON.parse(J(reply)), rv2TagFlow: x => x,
      DELIVERY_FORMATS: new Set(['video']), saveState() {}, saveGeneratedIdeas() {}, renderStats() {}, renderIdeas() {}, stopThinking() {}, debugLog() {}, mascotReact() {}, _leanErrMsg: (e, m) => m, showToast() {} });
    lift(c, ['generateNewIdeas']);
    c.settings = { typeMix: { tip: 2, news: 1 }, formatMix: {} };
    reply = { ideas: [{ title: 'News one', day: 'Monday', format: 'video', caption: 'cap', postType: 'news', newsSource: { title: 'H', url: 'https://x.test/a' } },
      { title: 'Tip one', day: 'Monday', format: 'video', postType: 'tip' },
      { title: 'Bad one', day: 'Monday', format: 'video', postType: 'weird', newsSource: { title: 'H', url: 'javascript:alert(1)' } }] };
    await c.generateNewIdeas(); await tick();
    ok(bodies.length === 1 && bodies[0].count === 3 && J(bodies[0].typeMix) === J({ tip: 2, about: 0, news: 1, qna: 0, story: 0, bts: 0 }), 'D Plan my week sends typeMix and count = the total: ' + J({ count: bodies[0] && bodies[0].count, typeMix: bodies[0] && bodies[0].typeMix }));
    const byT = t => c.state.find(i => i.title === t) || {};
    ok(byT('News one').postType === 'news' && byT('News one').caption === 'cap\n\nSource: https://x.test/a' && byT('Tip one').postType === 'tip', 'D the batch keeps each idea\'s type (and the news link)');
    ok(!('postType' in byT('Bad one')) && !('newsSource' in byT('Bad one')), 'D an unknown type or an unsafe source from the server is dropped');
    ok(!/id="generateCount"/.test(html) && /<div id="ideasMixSlot"><\/div>[\s\S]{0,200}id="ideasQuickBtn"/.test(between('<div id="ideasQuick"', 'id="ideasManualPanel"')),
      'D the count dropdown is gone; the steppers sit on the Plan my week card itself');
    ok(/ideasMixRender\(\)/.test(grab('renderIdeaFilters')), 'D the steppers redraw whenever Ideas renders (brand switch included)');
  }

  // ═════════ E — refill asks for the same type ═════════
  {
    const dom = makeDom(); const bodies = []; let refills = [];
    const c = baseCtx(dom, { showToast() {}, FORMAT_LABELS: {}, getDayCommunities: () => ({ Monday: 'M' }), buildLearningContext: () => '', brandGate: () => () => true, DAYS: ['Monday'],
      getBrandContext: () => ({}), getRecentTrends: () => [], rv2TagFlow: x => x, getVisibleIdeas: () => c.state, saveState() {}, renderNav() {}, activeView: 'today',
      leanBrandFetch: async (u, body) => { bodies.push(body); const t = J({ ideas: [{ title: 'R' + bodies.length, day: 'Monday', format: 'video', postType: body.postType || undefined }] }); return { ok: true, status: 200, text: async () => t }; } });
    vm.createContext(c); liftTypes(c); lift(c, ['autoRefillCheck']);
    await c.autoRefillCheck('Monday', 'video', 'story'); await tick();
    ok(bodies[0].postType === 'story' && c.state[0].postType === 'story', 'E the refill asks for the approved idea\'s type (story) and keeps it');
    await c.autoRefillCheck('Monday', 'micro'); await tick();
    ok(!('postType' in bodies[1]), 'E an idea without a type refills exactly as before (no postType sent)');
    await c.autoRefillCheck('Monday', 'statement', 'bogus'); await tick();
    ok(!('postType' in bodies[2]), 'E a junk type is never sent');
    Object.assign(c, { reindexIdeas() {}, refreshCurrentView() {}, showApprovePopupFn() {}, autoRefillCheck: (...a) => refills.push(a) });
    lift(c, ['quickApprove']);
    c.state = [{ id: 0, day: 'Monday', format: 'video', status: 'pending', postType: 'about' }, { id: 1, day: 'Monday', format: 'video', status: 'pending' }, { id: 2, day: 'Monday', format: 'qna', status: 'pending' }];
    c.quickApprove(0); c.quickApprove(1); c.quickApprove(2);
    ok(J(refills) === J([['Monday', 'video', 'about'], ['Monday', 'video', 'tip'], ['Monday', 'qna', 'qna']]), 'E approving from Ideas passes the idea\'s type to the refill (old idea: tip / qna)');
    const RF = /autoRefillCheck\(idea\.day, idea\.format, \(typeof typesOf === 'function'\) \? typesOf\(idea\) : idea\.postType\)/;
    ok(RF.test(grab('moveStage')) && RF.test(grab('tvApprove')),
      'E Pipeline moves and the classic Quick Post approve pass it too');
  }

  // ═════════ F — cards + By type filter ═════════
  {
    const dom = makeDom();
    const c = baseCtx(dom, { getVisibleIdeas: () => c.state, ideaStatusFilter: 'pending', activeFilter: 'all', activeFormat: 'all', expandedIds: new Set(), openDismissPopup: null,
      _ideaSelectMode: false, _ideaSelected: new Set(), renderDetailContent: () => '', rv2BeliefLine: () => '', STAGE_LABELS: {}, ICO: { check: '', undo: '' }, DAYS: ['Monday', 'Tuesday'] });
    vm.createContext(c); liftTypes(c); lift(c, ['renderIdeas', 'renderIdeaFilters', 'visiblePendingIds', 'asText', 'renderEmptyState', 'isFreshIdea']);
    dom.put('ideaContent'); dom.put('ideaFilters');
    c.state = [
      { id: 0, title: 'News idea', day: 'Monday', format: 'video', status: 'pending', postType: 'news', newsSource: { title: 'Salt prices rise', url: 'https://news.example/salt?a=1&b=2' } },
      { id: 1, title: 'Tip idea', day: 'Monday', format: 'statement', status: 'pending', postType: 'tip' },
      { id: 2, title: 'Old idea', day: 'Tuesday', format: 'carousel', status: 'pending', hook: 'Old hook' },
      { id: 3, title: 'Plain http news', day: 'Tuesday', format: 'video', status: 'pending', postType: 'news', newsSource: { title: 'X', url: 'http://plain.example/x' } },
      { id: 4, title: 'Script news', day: 'Tuesday', format: 'video', status: 'pending', postType: 'news', newsSource: { title: 'Y', url: 'javascript:alert(1)' } },
      { id: 5, title: 'Untitled source', day: 'Tuesday', format: 'video', status: 'pending', postType: 'news', newsSource: { url: 'https://www.paper.example/p' } },
      { id: 6, title: 'Bts idea', day: 'Tuesday', format: 'micro', status: 'pending', postType: 'bts' },
      { id: 7, title: 'Old qna', day: 'Tuesday', format: 'qna', status: 'pending' } ];
    c.renderIdeas();
    const out = dom.els.ideaContent.innerHTML;
    const card = t => { const parts = out.split('<div class="list-card '); return parts.find(p => p.indexOf(t) >= 0) || ''; };
    ok(/<span class="type-tag type-news">News<\/span>/.test(card('News idea')) && /type-tag type-tip">Tip</.test(card('Tip idea')) && /type-tag type-bts">Behind the scenes</.test(card('Bts idea')),
      'F each card shows its type next to the format');
    ok(card('News idea').indexOf('<a class="type-src" href="https://news.example/salt?a=1&amp;b=2" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">Source: Salt prices rise</a>') >= 0,
      'F a news card links its source headline (https, new tab, rel=noopener)');
    ok(!/type-src/.test(card('Plain http news')) && !/type-src/.test(card('Script news')) && !/javascript:/.test(out), 'F an http: or javascript: source is never linked');
    ok(/>Source: paper\.example<\/a>/.test(card('Untitled source')), 'F a source with no headline shows its site name');
    ok(card('Old idea').indexOf('Old idea') >= 0 && /type-tag type-tip">Tip</.test(card('Old idea')) && !/type-src/.test(card('Old idea')) && /Old hook/.test(card('Old idea')),
      'F an old idea without a type renders fine, labelled Tip (post_type NULL = tip)');
    ok(/type-tag type-qna">Q&amp;A</.test(card('Old qna')), 'F an old Q&A-format idea is labelled Q&A');
    ok(c.typesOf({ postType: 'news', format: 'qna' }) === 'news' && c.typesOf({ format: 'qna' }) === 'qna' && c.typesOf({ format: 'video', postType: 'junk' }) === 'tip' && c.typesOf({}) === 'tip',
      'F typesOf: own type, else qna for Q&A format, else tip');
    c.renderIdeaFilters();
    const f = dom.els.ideaFilters.innerHTML;
    ok(/By type/.test(f) && (f.match(/filter-chip type-chip/g) || []).length === 6, 'F Filters has a "By type" row with the six types');
    c.setPostTypeFilter('news');
    const o2 = dom.els.ideaContent.innerHTML;
    ok(/News idea/.test(o2) && /Plain http news/.test(o2) && !/Tip idea/.test(o2) && !/Old idea/.test(o2) && !/Bts idea/.test(o2), 'F tapping News shows only news ideas');
    ok(/filter-chip type-chip active" onclick="setPostTypeFilter\('news'\)">News</.test(dom.els.ideaFilters.innerHTML) && J(c.visiblePendingIds()) === J([0, 3, 4, 5]), 'F ...the chip is lit and "approve several" sees the same list');
    c.setPostTypeFilter('news');
    ok(/Old idea/.test(dom.els.ideaContent.innerHTML) && c.activePostType === 'all', 'F tapping it again clears the filter');
    c.setPostTypeFilter('tip');
    ok(/Tip idea/.test(dom.els.ideaContent.innerHTML) && /Old idea/.test(dom.els.ideaContent.innerHTML) && !/Old qna/.test(dom.els.ideaContent.innerHTML) && J(c.visiblePendingIds()) === J([1, 2]),
      'F the Tip filter includes old ideas saved before types');
    c.setPostTypeFilter('qna'); ok(J(c.visiblePendingIds()) === J([7]), 'F ...and the Q&A filter the old Q&A-format ones');
    c.setPostTypeFilter('qna');
    ok(/activePostType = 'all'/.test(grab('ideasQuickGo')), 'F Plan my week clears the type filter so the new batch is visible');
  }

  // ═════════ G — save / load ═════════
  {
    const store = new Map();
    const mkCtx = (cols) => { const dom = makeDom(); const db = makeDb(cols);
      const c = baseCtx(dom, { sb: db, lsSet: (k, v) => { store.set(k, v); return true; }, lsGet: k => (store.has(k) ? store.get(k) : null) });
      vm.createContext(c); liftEmph(c); liftTypes(c); lift(c, ['_buildIdeaRows', '_saveIdeasToDBNow', 'normalizeIdeaStatus', '_ideaRowRecency', 'loadIdeasFromDB']);
      return { c, db }; };
    const IDEAS = () => [
      { title: 'News idea', day: 'Monday', format: 'video', caption: 'cap', status: 'pending', postType: 'news', newsSource: { title: 'Salt prices rise', url: 'https://news.example/salt' } },
      { title: 'Tip idea', day: 'Monday', format: 'video', caption: 'Mine.\n\nSource: https://own.example/x', status: 'pending', postType: 'tip', genFlow: 'v2', emphasis: ['Mine'] },
      { title: 'Old idea', day: 'Monday', format: 'video', caption: 'old', status: 'filming' } ];
    const FULL = BASE_COLS.concat(['emphasis', 'gen_flow', 'post_type']);
    let { c, db } = mkCtx(FULL);
    c.state = IDEAS(); await c._saveIdeasToDBNow('b1', c._buildIdeaRows('b1'));
    const row = t => db.rows.find(r => r.title === t) || {};
    ok(row('News idea').post_type === 'news' && row('Tip idea').post_type === 'tip' && row('Old idea').post_type === null, 'G post_type is saved (and an old idea sends none)');
    ok(!('post_type' in db.inserts[0].find(r => r.title === 'Old idea')), 'G ...an idea without a type does not even name the column');
    ok(row('News idea').caption === 'cap\n\nSource: https://news.example/salt', 'G the news link is kept in the caption (no column for it)');
    let loaded = await c.loadIdeasFromDB({}); const L = t => loaded.find(i => i.title === t) || {};
    ok(L('News idea').postType === 'news' && J(L('News idea').newsSource) === J({ title: 'Salt prices rise', url: 'https://news.example/salt' }), 'G loaded back: postType + the headline (this device)');
    ok(L('Tip idea').postType === 'tip' && !L('Tip idea').newsSource && !('postType' in L('Old idea')) && L('Old idea').status === 'filming', 'G a tip keeps its type, an old idea loads with none');
    c.state = loaded; await c._saveIdeasToDBNow('b1', c._buildIdeaRows('b1'));
    ok(db.rows.filter(r => r.title === 'News idea').every(r => r.caption.split('https://news.example/salt').length === 2), 'G saving again never adds the link twice');
    store.clear();
    loaded = await c.loadIdeasFromDB({});
    ok(J((loaded.find(i => i.title === 'News idea') || {}).newsSource) === J({ title: '', url: 'https://news.example/salt' }), 'G on another device the link comes back from the caption');
    // the format the server's morning batch writes (api/send-daily.js): "<caption>\n\nSource: <https url>"
    ok(c.typesSourceFromCaption('Salt prices jumped.\n\nSource: https://news.example/salt') === 'https://news.example/salt'
      && c.typesSourceFromCaption('Source: https://a.example/x  ') === 'https://a.example/x'
      && c.typesSourceFromCaption('x\n\nSource: http://a.example/x') === '' && c.typesSourceFromCaption('x\n\nSource: https://a.example/x more') === ''
      && c.typesSourceFromCaption('see Source: https://a.example/x') === '', 'G the caption reader takes exactly a last line "Source: <https url>"');
    // missing column → saved without it
    ({ c, db } = mkCtx(BASE_COLS.concat(['emphasis', 'gen_flow'])));
    c.state = IDEAS(); await c._saveIdeasToDBNow('b1', c._buildIdeaRows('b1'));
    ok(db.rows.length === 3 && c._ideasNoPostTypeCol === true && db.rows.every(r => !('post_type' in r)) && row('Tip idea').gen_flow === 'v2', 'G no post_type column yet: every idea is still saved (only the type is left out)');
    await c._saveIdeasToDBNow('b1', c._buildIdeaRows('b1'));
    ok(db.inserts.slice(-1)[0].every(r => !('post_type' in r)), 'G ...and later saves skip the column straight away');
    loaded = await c.loadIdeasFromDB({});
    ok(loaded.length === 3 && loaded.every(i => !('postType' in i)), 'G ...and they load fine without it');
    ({ c, db } = mkCtx(BASE_COLS));
    c.state = IDEAS(); await c._saveIdeasToDBNow('b1', c._buildIdeaRows('b1'));
    ok(db.rows.length === 3 && c._ideasNoPostTypeCol && c._ideasNoGenFlowCol && c._ideasNoEmphasisCol, 'G emphasis, gen_flow AND post_type all missing: still saved');
    ok(db.inserts.length === 4 && db.inserts[3].length === 3, 'G ...as one batch on its 4th try (one retry per missing column, no row-by-row fallback): ' + db.inserts.length + ' inserts');
  }

  finished = true;
  if (fail) { console.log('\n' + fail + ' check(s) failed'); process.exit(1); }
  console.log('\nTYPES UI OK');
})().catch(e => { console.log('FAIL: crashed:', e && e.stack || e); finished = true; process.exit(1); });
