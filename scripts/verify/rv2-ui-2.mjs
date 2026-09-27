#!/usr/bin/env node
// GATE (v693 wave 2, content-v2 leaf-U): the app's other ONE-seed → ONE-idea flows run through the
// opinion-first panel, idea cards show the belief and can be rewritten as a spoken script, and
// gen_flow stays honest across the deploy.
//
// It EXECUTES the real functions lifted from app.html in node:vm (fake DOM, fake fetch answering in
// the shapes of .unlazy/content-v2/PLAN.md C-API-1..3, fake PostgREST):
//   F1 Notebook develop   → kind 'note'      F2 Idea Catcher → kind 'idea' (+ video transcript)
//   F3 People-also-ask    → kind 'question'  F4 Quick Post   → kind 'idea' (today's theme)
//   F5 top post via Remix → kind 'trend'     each: source sent right, saved with its origin fields and
//   gen_flow 'v2', the classic path one tap away, formats the writer lacks go classic.
//   S  the sheet asks before throwing away a written script.
//   B  the belief line (escaped) + persisted on this device.   R  "Rewrite as spoken script": keep
//   mine leaves the script alone, use replaces it (and its stress marks), errors change nothing.
//   G  gen_flow rule: a generate-ideas idea is 'v2' only when the reply carries a belief — run through
//   the real nbDevelop intake and the real row builder; the tag line sits at every intake.
// RUN: node scripts/verify/rv2-ui-2.mjs      EXPECT: prints "UI V2 FLOWS OK", exit 0.
import fs from 'node:fs'; import vm from 'node:vm';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
setTimeout(() => { console.log('FAIL: wall clock (60s) exceeded'); process.exit(2); }, 60000).unref();
// a promise that never settles would let node exit 0 half-way: that is a failure, not a pass
let finished = false; process.on('exit', (code) => { if (!finished && code === 0) { console.log('FAIL: the gate ended before all checks ran (a promise never settled)'); process.exitCode = 1; } });
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
const els = {};
function mk(id, extra) {
  return Object.assign({ id, value: '', innerHTML: '', placeholder: '', disabled: false, textContent: '', className: '', attrs: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    getAttribute(k) { return this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = String(v); },
    dispatchEvent() {}, scrollIntoView() {}, focus() {}, remove() { delete els[this.id]; } }, extra || {});
}
const put = (id, extra) => (els[id] = mk(id, extra));
const calls = []; let route = () => ({ status: 404, body: {} });
async function fakeFetch(url, init) {
  const body = init && init.body ? JSON.parse(init.body) : null;
  calls.push({ url, body });
  const r = await route(url, body);
  if (r instanceof Error) throw r;
  const txt = JSON.stringify(r.body == null ? {} : r.body);
  return { ok: r.status >= 200 && r.status < 300, status: r.status, url, text: async () => txt, json: async () => JSON.parse(txt), clone() { return this; } };
}
const callsTo = (u) => calls.filter(c => c.url === u);
function makeDb(columns) {
  const cols = new Set(columns); const rows = []; let seq = 0; const db = { rows };
  db.from = (table) => {
    const q = { op: null, filters: [], payload: null, order: null, range: null };
    const run = () => {
      if (q.op === 'insert') {
        const list = Array.isArray(q.payload) ? q.payload : [q.payload];
        for (const r of list) for (const k of Object.keys(r)) if (!cols.has(k)) return { data: null, error: { code: 'PGRST204', message: `Could not find the '${k}' column of '${table}' in the schema cache` } };
        for (const r of list) { seq++; const st = { id: 'id-' + seq, created_at: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString() };
          for (const c of cols) if (!(c in st)) st[c] = (c in r) ? JSON.parse(JSON.stringify(r[c])) : null; rows.push(st); }
        return { data: null, error: null };
      }
      const hit = rows.filter(r => q.filters.every(f => f(r)));
      if (q.op === 'delete') { for (const r of hit) rows.splice(rows.indexOf(r), 1); return { data: hit.map(r => ({ id: r.id })), error: null }; }
      let out = hit.slice(); if (q.order) out.sort((a, b) => (a[q.order[0]] < b[q.order[0]] ? -1 : 1) * q.order[1]); if (q.range) out = out.slice(q.range[0], q.range[1] + 1);
      return { data: out.map(r => JSON.parse(JSON.stringify(r))), error: null };
    };
    const b = { select() { if (!q.op) q.op = 'select'; return b; }, insert(p) { q.op = 'insert'; q.payload = p; return b; }, delete() { q.op = 'delete'; return b; },
      eq(k, v) { q.filters.push(r => r[k] === v); return b; }, in(k, vs) { q.filters.push(r => vs.includes(r[k])); return b; },
      order(k, x) { q.order = [k, x && x.ascending === false ? -1 : 1]; return b; }, range(a, z) { q.range = [a, z]; return b; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); } };
    return b;
  };
  return db;
}
const COLS = ['id', 'brand_id', 'day', 'community', 'format', 'title', 'hook', 'script', 'shots', 'screen', 'caption', 'reel_title',
  'tags', 'bold_text', 'status', 'dismiss_reason', 'assignee', 'is_generated', 'created_at', 'is_remix', 'original_creator', 'emphasis', 'gen_flow'];
const store = new Map(); const toasts = []; const classic = [];
const c = {
  console: { log() {}, warn() {}, error() {}, info() {} }, JSON, Promise, Date, Math, String, Number, Array, Object, Set, Map, RegExp, Error, TypeError,
  window: {}, state: [], IDEAS: [], currentBrand: { id: 'brand-1' }, sb: null, _switchSeq: 0,
  document: { getElementById: id => els[id] || null, createElement: () => mk(''), body: { appendChild(e) { if (e.id) els[e.id] = e; } }, querySelector: () => null, querySelectorAll: () => [] },
  fetch: fakeFetch, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  lsSet: (k, v) => { store.set(k, v); return true; }, lsGet: k => (store.has(k) ? store.get(k) : null), lsDel: k => store.delete(k),
  showToast: (m) => toasts.push(String(m)), btnWork: () => () => {}, flushBrandSave: async () => {}, getBrandContext: () => ({ brandName: 'X' }),
  _humanEditedTitles: () => [], saveState() { c.__saveState = (c.__saveState || 0) + 1; }, saveGeneratedIdeas() { return Promise.resolve({ ok: true }); }, DELIVERY_FORMATS: new Set(['video', 'micro', 'qna', 'statement']), saveIdeasToDB() { c.__saveDb = (c.__saveDb || 0) + 1; },
  renderNav() {}, switchView() {}, renderRemixHookRead() {}, mascotReact() {}, refreshCurrentView() { c.__refresh = (c.__refresh || 0) + 1; }, renderRemixResults() {},
  notebookNotes: [{ id: 'n1', text: 'Customers keep asking if cheaper is worse. It is not, and here is why.' }],
  nbDevelop: (id) => classic.push('nbDevelop:' + id), ideaDevelop: () => classic.push('ideaDevelop'),
  usePAAQuestion: (i, f) => classic.push('usePAAQuestion:' + i + ':' + f), generateTodayTabPost: () => classic.push('generateTodayTabPost'),
  paaQuestions: [{ question: 'Is <b>bottled</b> water worse than tap?', keyword: 'water', source: 'PAA' }], paaUsed: new Set(),
  savePAAState() { c.__paaSaved = (c.__paaSaved || 0) + 1; }, renderPAASection() {}, refShotClear() {}, icDraftClear() { c.__icCleared = (c.__icCleared || 0) + 1; },
  firstRunBrandGuard: () => false, getTodayName: () => 'Monday', getDayCommunities: () => ({ Monday: 'Myth-busting Monday' }), DAYS: ['Monday'],
};
vm.createContext(c);
for (const n of ['escapeHtml', 'escHtml', 'humanErr', '_leanNetFail', '_leanErrMsg', 'csAiPausedText', '_tvBcFieldCount', 'brandGate', 'asText',
  'tpEscape', 'tpOutsideTags', 'tpSenseLines', 'tpStressRx', 'tpEmphasise', 'tpPruneEmphasis', 'tpCleanEmphasis',
  '_buildIdeaRows', '_saveIdeasToDBNow', 'normalizeIdeaStatus', '_ideaRowRecency', 'loadIdeasFromDB']) vm.runInContext(grab(n), c);
for (const m of html.matchAll(/^const (TP_STRESS_[AB]) = .*$/gm)) vm.runInContext(m[0].replace(/^const /, 'var '), c);
vm.runInContext(between('/* v693 — REMIX, REBUILT', '\nfunction removeRemix(idx) {').replace(/^(let|const) /gm, 'var '), c);
const XSS = '<img src=x onerror=alert(1)>';
const ANGLES = [{ id: 'a1', belief: 'Cheap is not the same as worse', why: 'Price is read as quality.' }, { id: 'a2', belief: 'Most premium is packaging', why: 'Nobody checks.' }];
const IDEA = { title: 'Cheap is not worse', hook: 'Cheaper is not worse.', script: 'Everyone thinks cheap means worse.\n[your story: a customer who switched]\nThat is it.',
  onScreen: ['Cheap ≠ worse'], caption: 'Price is not quality.', shots: ['Talking head'], format: 'talking', emphasis: ['cheap means worse'], genFlow: 'v2' };
const defaultRoute = (u, b) => {
  if (u === '/api/angles') return { status: 200, body: { angles: ANGLES, flow: 'v2' } };
  if (u === '/api/write') return { status: 200, body: { idea: Object.assign({}, IDEA, { format: b.format }) } };
  if (u === '/api/brand-memory') return { status: 200, body: { item: {} } };
  if (u === '/api/transcribe-url') return { status: 200, body: { transcript: 'In the video she pours both into glasses.' } };
  return { status: 404, body: {} };
};
const reset = () => { calls.length = 0; toasts.length = 0; classic.length = 0; for (const k of Object.keys(els)) delete els[k];
  vm.runInContext('rv2SetRun("rv2Panel", null); rv2SetRun("rv2Sheet", null); state = []; IDEAS = []; window = {}; currentBrand = { id: "brand-1" }; paaUsed = new Set();', c); route = defaultRoute; };
const sheet = () => (els.rv2Sheet ? els.rv2Sheet.innerHTML : '');
async function pickAndSave() { await c.rv2Pick(0); await tick(); const r = await c.rv2Save(); await tick(); return r; }

(async () => {
  // ═══ F1 Notebook ═══
  reset();
  await c.nbDevelopV2('n1', mk('nbBtn')); await tick();
  let a = callsTo('/api/angles')[0];
  ok(a && a.body.source.kind === 'note' && a.body.source.text === c.notebookNotes[0].text && a.body.brandId === 'brand-1', 'F1 notebook: /api/angles gets kind note + the note text');
  ok(/Develop your note/.test(sheet()) && (sheet().match(/class="rv2-angle[ "]/g) || []).length === 2, 'F1 the opinions open in the full-screen sheet');
  ok(/Use the classic develop instead/.test(sheet()), 'F1 the classic path is one tap away');
  let saved = await pickAndSave();
  ok(saved && c.state.length === 1 && c.state[0].sparkSource === true && c.state[0].isRemix === false && c.state[0].genFlow === 'v2'
    && c.state[0].belief === ANGLES[0].belief && c.state[0].status === 'pending' && c.state[0].originalCreator === '', 'F1 saved as a pending v2 idea from your note (not a remix), with its belief');
  ok(!els.rv2Sheet, 'F1 the sheet closes after saving');
  reset(); await c.nbDevelopV2('n1', mk('nbBtn')); await tick(); c.rv2Classic();
  ok(J(classic) === J(['nbDevelop:n1']) && !els.rv2Sheet && c._rv2 === null, 'F1 "classic" runs the old nbDevelop and closes the sheet');
  // ═══ F2 Idea Catcher ═══
  reset(); put('icIdea', { value: 'Bottled vs tap' }); put('icUrl', { value: 'https://www.tiktok.com/@x/video/9' }); put('icNotes', { value: '' }); put('icStatus'); put('icBtn'); put('icResult');
  await c.icDevelopV2(); await tick();
  a = callsTo('/api/angles')[0];
  ok(callsTo('/api/transcribe-url').length === 1 && a && a.body.source.kind === 'idea' && a.body.source.url.includes('tiktok')
    && /MY IDEA: Bottled vs tap/.test(a.body.source.text) && /WHAT THE REFERENCE VIDEO SAYS: In the video she pours/.test(a.body.source.text), 'F2 Idea Catcher: kind idea, the typed idea + the video transcript');
  saved = await pickAndSave();
  ok(saved && c.state[0].sparkSource === true && c.state[0].genFlow === 'v2' && els.icIdea.value === '' && els.icUrl.value === '' && c.__icCleared === 1 && /Saved to your Ideas/.test(els.icResult.innerHTML),
    'F2 saved; the form and its draft are cleared only after saving');
  reset(); put('icIdea', { value: 'Bottled vs tap' }); put('icUrl', { value: 'https://www.tiktok.com/@x/video/9' }); put('icNotes', { value: 'short' }); put('icStatus'); put('icBtn'); put('icResult');
  route = (u, b) => u === '/api/transcribe-url' ? { status: 502, body: { error: 'private video' } } : defaultRoute(u, b);
  await c.icDevelopV2(); await tick();
  ok(callsTo('/api/angles').length === 0 && /Couldn't read that video automatically \(private video\)/.test(els.icResult.innerHTML), 'F2 an unreadable video with no notes is never written blind');
  reset(); put('icIdea', { value: '' }); put('icStatus'); await c.icDevelopV2();
  ok(callsTo('/api/angles').length === 0 && /Type or say your idea first/.test(els.icStatus.textContent), 'F2 no idea typed → no call');
  // ═══ F3 People also ask ═══
  reset(); put('paaBtn0');
  await c.paaAnswerV2(0); await tick();
  a = callsTo('/api/angles')[0];
  ok(a && a.body.source.kind === 'question' && a.body.source.text.startsWith('Is <b>bottled</b> water worse than tap?') && /"water"/.test(a.body.source.text), 'F3 PAA: kind question + the question');
  ok(sheet().includes('Answer a real question') && !sheet().includes('<b>bottled'), 'F3 the sheet opens (question text never injected as HTML)');
  await c.rv2Pick(0); await tick();
  ok(callsTo('/api/write')[0].body.format === 'talking', 'F3 one tap answers as a spoken script');
  saved = await c.rv2Save(); await tick();
  ok(saved && c.state[0].paaSource === 'Is <b>bottled</b> water worse than tap?' && c.paaUsed.has('is <b>bottled</b> water worse than tap?') && c.__paaSaved >= 1, 'F3 saved with its question, and the question is marked used');
  await c.paaAnswerV2(0); await tick();
  ok(callsTo('/api/angles').length === 1, 'F3 a used question does not run again');
  reset(); await c.paaAnswerV2(0, 'statement'); await tick(); await c.rv2Pick(1); await tick();
  ok(callsTo('/api/write')[0].body.format === 'statement' && c._rv2.idea.format === 'statement', 'F3 the Statement chip asks the writer for a statement');
  ok((await c.rv2Save()) === false && c.state.length === 0, 'F3 a statement with an open story slot is not saved (it would show on screen)');
  await c.rv2FillSlot(0, 'Mia switched and saved half.', false, 'a customer who switched'); await tick();
  saved = await c.rv2Save(); await tick();
  ok(saved.format === 'statement' && saved.boldText === 'Everyone thinks cheap means worse.\nMia switched and saved half.\nThat is it.' && saved.screen === '', 'F3 a statement\'s text is its final script, story filled in');
  reset(); await c.paaAnswerV2(0, 'qna'); await tick(); await c.rv2Pick(0); await tick();
  saved = await c.rv2Save(); await tick();
  ok(callsTo('/api/write')[0].body.format === 'talking' && saved.format === 'qna', 'F3 the Q&A chip writes a spoken answer and saves it as Q&A');
  reset(); await c.paaAnswerV2(0, 'static'); await tick();
  ok(J(classic) === J(['usePAAQuestion:0:static']) && callsTo('/api/angles').length === 0, 'F3 a format the new writer lacks (Image) goes straight to the classic path');
  // ═══ F4 Quick Post ═══
  reset(); c.window._tvSelectedFormat = 'micro'; c.window._tvDelivery = 'faceless';
  await c.tvGenerateV2(); await tick();
  a = callsTo('/api/angles')[0];
  ok(a && a.body.source.kind === 'idea' && /Myth-busting Monday/.test(a.body.source.text), 'F4 Quick Post: kind idea, today\'s theme as the seed');
  ok(/Use the classic Quick Post instead/.test(sheet()), 'F4 classic Quick Post one tap away');
  await c.rv2Pick(0); await tick();
  ok(callsTo('/api/write')[0].body.format === 'micro', 'F4 the picked format reaches the writer');
  saved = await c.rv2Save(); await tick();
  ok(saved.community === 'Myth-busting Monday' && saved.day === 'Monday' && saved.format === 'micro' && saved.genFlow === 'v2' && saved.delivery === 'faceless', 'F4 saved on today\'s theme and day, with the Faceless choice');
  reset(); c.window._tvSelectedFormat = 'qna'; await c.tvGenerateV2(); await tick(); await c.rv2Pick(0); await tick();
  saved = await c.rv2Save(); await tick();
  ok(saved.format === 'qna' && saved.delivery === 'faceon', 'F4 a Q&A Quick Post is saved as Q&A, not Video');
  reset(); c.window._tvSelectedFormat = 'static'; await c.tvGenerateV2(); await tick();
  ok(J(classic) === J(['generateTodayTabPost']) && callsTo('/api/angles').length === 0, 'F4 Image (static) stays on the classic Quick Post');
  // ═══ F5 trend (a top post dropped into Remix) ═══
  reset(); put('remixDescription', { value: 'Everyone is doing the 5am routine thing and it is nonsense' }); put('remixPostUrl'); put('youtubeUrl'); put('articleUrl'); put('remixCreatorName'); put('remixPlatform');
  c.window._rv2TrendText = 'Everyone is doing the 5am routine thing and it is nonsense';
  ok(c.rv2Source().kind === 'trend', 'F5 a top post from the trends screen is sent as kind trend');
  els.remixDescription.value = 'A completely different pasted transcript';
  ok(c.rv2Source().kind === 'remix', 'F5 opposite arm: anything else in Remix is still kind remix');
  ok(/window\._rv2TrendText = String\(p\.text/.test(grab('remixTopPost')), 'F5 remixTopPost marks the trend text');
  // ═══ S sheet close ═══
  reset(); await c.nbDevelopV2('n1', null); await tick(); await c.rv2Pick(0); await tick();
  c.rv2CloseSheet();
  ok(c._rv2 && /Tap again to throw this away/.test(sheet()), 'S closing a written script asks once more');
  c.rv2OpenSlot(0);
  ok(!/Tap again/.test(sheet()), 'S the question is dropped once the sheet changes');
  c.rv2CloseSheet();
  ok(c._rv2Runs.rv2Sheet && /Tap again to throw this away/.test(sheet()), 'N7 closing after the change asks AGAIN (it does not close)');
  c.rv2CloseSheet();
  ok(c._rv2 === null && !els.rv2Sheet, 'S the second tap closes it');
  reset(); await c.nbDevelopV2('n1', null); await tick(); c.rv2CloseSheet();
  ok(c._rv2 === null && !els.rv2Sheet, 'S with only opinions on screen it closes at once');
  ok(/body:has\(\.rv2-lab\) #voicePill \{ z-index: 9500; \}/.test(html) && /\.rv2-lab \{ position: fixed; inset: 0; z-index: 9000;/.test(html), 'S the recording pill (tap to stop) sits above the sheet');
  // ═══ wiring (the buttons now open the new flow) ═══
  ok(/onclick="nbDevelopV2\('\$\{n\.id\}', this\)"/.test(html) && !/onclick="nbDevelop\('/.test(html), 'wiring: Notebook "Develop into post" → nbDevelopV2');
  ok(/id="icBtn" onclick="icDevelopV2\(\)"/.test(html), 'wiring: Idea Catcher → icDevelopV2');
  ok(/onclick="paaAnswerV2\(\$\{idx\}\)"/.test(html) && /onclick="paaAnswerV2\(\$\{idx\},'\$\{k\}'\)"/.test(html) && !/onclick="usePAAQuestion\(/.test(html), 'wiring: PAA one-tap and format chips → paaAnswerV2');
  ok(/_ok \? 'tvGenerateV2\(\)'/.test(html) && /function angleGenerate\(\)\{ closeAngleSheet\(\); tvGenerateV2\(\); \}/.test(html), 'wiring: Quick Post button and angle sheet → tvGenerateV2');
  // ═══ B belief line ═══
  ok(c.rv2BeliefLine({ belief: 'Hot take ' + XSS }) === '<div class="rv2-idea-belief">Your take: Hot take &lt;img src=x onerror=alert(1)&gt;</div>', 'B the belief line renders escaped');
  ok(c.rv2BeliefLine({ belief: '  ' }) === '' && c.rv2BeliefLine({}) === '', 'B no belief → no line');
  ok(/rv2BeliefLine\(idea\)/.test(grab('renderIdeas')), 'B idea cards render it');
  { const db = makeDb(COLS); c.sb = db; store.clear();
    c.state = [{ title: 'With take', hook: 'h', script: 's', status: 'pending', format: 'video', belief: 'Cheap is not worse' }, { title: 'No take', hook: 'h', script: 's', status: 'pending', format: 'video' }];
    await c._saveIdeasToDBNow('brand-1', c._buildIdeaRows('brand-1'));
    c.state = [];
    const back = await c.loadIdeasFromDB();
    ok(back.find(i => i.title === 'With take').belief === 'Cheap is not worse' && !('belief' in back.find(i => i.title === 'No take')), 'B the belief survives a reload (kept on this device by title)'); }
  // ═══ R rewrite as spoken script ═══
  reset(); put('rv2Rw-0');
  const base = { title: 'Water', hook: 'Tap water is fine.', script: 'OLD SCRIPT', format: 'video', status: 'pending', emphasis: ['OLD'], belief: 'Tap beats bottled ' + XSS };
  c.state = [Object.assign({}, base)];
  ok(c.rv2CanRewrite(c.state[0]) && !c.rv2CanRewrite({ format: 'video', title: 't' }) && !c.rv2CanRewrite({ format: 'carousel', belief: 'b' }) && c.rv2CanRewrite({ format: 'qna', hook: 'h' }),
    'R the action shows for a filmable idea with a belief or hook, not otherwise');
  ok(/rv2CanRewrite\(idea\)[\s\S]{0,120}rv2RewriteIdea\(\$\{idea\.id\},this\)/.test(grab('renderDetailContent')) && /id="rv2Rw-\$\{idea\.id\}"/.test(grab('renderDetailContent')), 'R the card carries the button and the preview slot');
  route = (u, b) => u === '/api/write' ? { status: 200, body: { idea: { script: 'NEW SPOKEN SCRIPT ' + XSS, emphasis: ['NEW SPOKEN'] } } } : { status: 404, body: {} };
  await c.rv2RewriteIdea(0, mk('b')); await tick();
  const w = callsTo('/api/write')[0];
  ok(w && w.body.angle.belief === 'Tap beats bottled ' + XSS && w.body.source.kind === 'idea' && /OLD SCRIPT/.test(w.body.source.text) && /Tap water is fine\./.test(w.body.source.text) && w.body.format === 'talking',
    'R /api/write gets the belief as the angle and the idea\'s own text as the source');
  ok(c.state[0].script === 'OLD SCRIPT' && /NEW SPOKEN SCRIPT &lt;img/.test(els['rv2Rw-0'].innerHTML) && !els['rv2Rw-0'].innerHTML.includes(XSS), 'R the new script waits (escaped) — the old one is untouched');
  c.rv2RwKeep(0);
  ok(c.state[0].script === 'OLD SCRIPT' && els['rv2Rw-0'].innerHTML === '' && !c.__saveDb, 'R "Keep mine" changes nothing');
  await c.rv2RewriteIdea(0, mk('b')); await tick();
  ok(c.rv2RwUse(0) === true && c.state[0].script === 'NEW SPOKEN SCRIPT ' + XSS && J(c.state[0].emphasis) === J(['NEW SPOKEN']) && c.__saveDb === 1, 'R "Use the new script" replaces it (and its stress marks) and saves');
  c.state = [Object.assign({}, base)]; c.__saveDb = 0;
  route = (u) => u === '/api/write' ? { status: 503, body: { error: 'The AI writer is paused.', code: 'AI_UNAVAILABLE' } } : { status: 404, body: {} };
  await c.rv2RewriteIdea(0, mk('b')); await tick();
  ok(c.state[0].script === 'OLD SCRIPT' && /The AI writer is paused\./.test(els['rv2Rw-0'].innerHTML) && c.rv2RwUse(0) === false && !c.__saveDb, 'R an error is said and the script is unchanged');
  c.rv2RwKeep(0);
  route = (u) => u === '/api/write' ? { status: 200, body: { idea: { script: 'X' } } } : { status: 404, body: {} };
  c.state = [Object.assign({}, base)]; await c.rv2RewriteIdea(0, mk('b')); await tick();
  c.state = [{ title: 'Other', script: 'o' }, Object.assign({}, base)];   // the list moved while it was writing
  ok(c.rv2RwUse(0) === true && c.state[0].script === 'o' && c.state[1].script === 'X', 'R if the list moved, the rewrite lands on the SAME idea (by title), never on another');
  { // M11 a brand switch while the rewrite is written: nothing is offered on the other brand
    reset(); put('rv2Rw-0'); c.state = [Object.assign({}, base)];
    let res; const held = new Promise(r => { res = r; });
    route = (u) => u === '/api/write' ? held : { status: 404, body: {} };
    const pr = c.rv2RewriteIdea(0, mk('b')); await tick();
    vm.runInContext('_switchSeq++; currentBrand = { id: "brand-2" }; state = [{ title: "Brand two idea", script: "B2", format: "video", hook: "h" }]', c);
    res({ status: 200, body: { idea: { script: 'NEW' } } }); await pr; await tick();
    ok(!c._rv2Rw[0] && els['rv2Rw-0'].innerHTML === '' && c.rv2RwUse(0) === false && c.state[0].script === 'B2', 'M11 a rewrite that lands after a brand switch is dropped, never offered on the other brand');
    vm.runInContext('currentBrand = { id: "brand-1" }', c); }
  // ═══ G gen_flow rule ═══
  ok(c.rv2TagFlow({ title: 't', belief: '  A take  ' }).genFlow === 'v2-batch' && c.rv2TagFlow({ title: 't', belief: 'A take' }).belief === 'A take', 'G an idea with a belief is tagged v2-batch (the panel alone is v2)');
  ok(!('genFlow' in c.rv2TagFlow({ title: 't', genFlow: 'v2' })) && !('genFlow' in c.rv2TagFlow({ title: 't', belief: '' })), 'G without a belief it is NOT tagged, even if the reply says v2');
  ok(c.rv2TagFlow({ belief: 'x'.repeat(300) }).belief.length === 140, 'G the belief is capped at 140');
  ok(!('genFlow' in c.rv2TagFlow({ title: 't', belief: '   \n  ' })), 'G a whitespace-only belief is no belief');
  { // through the real nbDevelop intake + the real row builder
    const answers = [{ ideas: [{ title: 'New server idea', hook: 'h', script: 's', format: 'video', belief: 'Beliefs first' }] },
                     { ideas: [{ title: 'Old server idea', hook: 'h', script: 's', format: 'video', genFlow: 'v2' }] }];
    vm.runInContext(grab('nbDevelop'), c);
    const leanBrandFetch = async () => ({ ok: true, status: 200, json: async () => answers.shift() });
    Object.assign(c, { leanBrandFetch, getTodayName: () => 'Monday' }); c.state = []; c.IDEAS = [];
    await vm.runInContext('nbDevelop', c)('n1', mk('b')); await vm.runInContext('nbDevelop', c)('n1', mk('b'));
    const rows = c._buildIdeaRows('brand-1');
    ok(c.state[0].genFlow === 'v2-batch' && rows[0].gen_flow === 'v2-batch', 'G the belief-first server\'s idea is saved with gen_flow v2-batch');
    ok(!c.state[1].genFlow && !('gen_flow' in rows[1]), 'G the old server\'s idea (no belief) stays untagged, so the metric is honest across the deploy');
  }
  const TAGLINE = "data.ideas = data.ideas.map(rv2TagFlow)";
  for (const fn of ['autoRefillCheck', 'generateNewIdeas', 'generateTodayTabPost', 'usePAAQuestion', 'nbDevelop', 'sparkDevelop', 'ideaDevelop'])
    ok(grab(fn).includes(TAGLINE), 'G ' + fn + ' tags its /api/generate-ideas reply before using it');
  ok(html.split(TAGLINE).length - 1 === 7, 'G and nowhere else (7 intakes)');

  if (fail) { console.log('\n' + fail + ' check(s) failed'); process.exit(1); }
  finished = true;
  console.log('\nUI V2 FLOWS OK');
})().catch(e => { console.log('FAIL: gate crashed: ' + (e && e.stack || e)); process.exit(1); });
