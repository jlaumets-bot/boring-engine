#!/usr/bin/env node
// GATE (v709 consistency, agent APP): the app side of .unlazy/consistency/CONTRACT.md.
// It EXECUTES the real functions lifted from app.html in node:vm (fake DOM, fake fetch; no network, no AI):
//   A  ONE "How you film" setting per brand (voice_extra.delivery 'face'|'faceless'), sent by every writer
//      request; per-post switches start on it and still override; no per-device / brand-switch reset.
//   B  no paid auto-refill after approving (owner decision 2).
//   C  coach replies are text; a speaker button plays ONE reply; a 402 is said in words, no upgrade sheet.
//   D  dismissed headlines live on the brand (max 200, newest kept), migrate once, travel as newsDismissed.
//   E  Content Mix: formatsOff mirror; "Write today's post" never picks a switched-off format; the classic
//      (Image) path saves to Ideas, not the Pipeline.
//   F  paid work is never dropped silently (second My take, "Use the classic … instead", Not for me).
//   G  Sharpen stays busy until the server answers (or 300 s).   H  Remix classic statement/carousel boldText.
//   I  carousel slides read "1: … 2: …" from boldText, never design notes.   J  Redo / Generate more postType,
//      Redo keeps the news link.   K  clashing titles get a suffix.   L  Idea Catcher screenshot is read.
//   M  news headlines label.   N  approve reasons travel with Plan my week.   O  smaller fixes.
// RUN: node scripts/verify/consistency-APP.mjs      EXPECT: prints "CONSISTENCY APP OK", exit 0.
import fs from 'node:fs'; import vm from 'node:vm';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'clean.css'), 'utf8');
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
const has = n => html.indexOf('\nfunction ' + n + '(') >= 0 || html.indexOf('\nasync function ' + n + '(') >= 0;
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
const FORMATS = ['video', 'carousel', 'static', 'statement', 'micro', 'bonus', 'qna'];
const DELIVERY_FORMATS = new Set(['video', 'micro', 'qna', 'statement']);
const DELIV_FNS = ['brandDelivery', 'deliveryUi', 'deliveryReq', 'newsDismissedList', 'newsDismissedAdd', 'formatOn', 'formatsOffFrom', 'uniqueIdeaTitle'];
function ctx(extra) {
  const c = Object.assign({ console: { log() {}, warn() {}, error() {} }, JSON, Math, Date, Set, Map, Promise, Array, Object, String, Number, RegExp, Error,
    setTimeout: () => 0, clearTimeout() {}, AbortController, FORMATS, DELIVERY_FORMATS, NEWS_DISMISSED_MAX: 200,
    window: {}, settings: { delivery: null, newsDismissed: [], formatMix: {} }, state: [], IDEAS: [], toasts: [],
    showToast(m) { c.toasts.push(String(m)); } }, extra || {});
  vm.createContext(c);
  return c;
}
const lift = (c, names) => { for (const n of names) vm.runInContext(grab(n), c); return c; };
function el(id, extra) { return Object.assign({ id, value: '', innerHTML: '', textContent: '', className: '', disabled: false, style: {}, attrs: {},
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
  scrollIntoView() {}, focus() {}, remove() {} }, extra || {}); }

// ═════════ A — one How you film setting per brand ═════════
{
  for (const n of DELIV_FNS.concat(['setBrandDelivery', 'brandFilmSettingHtml', 'brandPrefsMigrate', 'rv2DeliveryOf'])) ok(has(n), 'A ' + n + ' exists');
  const c = ctx({ saveSettings() { c.saves = (c.saves || 0) + 1; }, renderSettingsPanel() {} });
  lift(c, DELIV_FNS.concat(['setBrandDelivery']));
  ok(c.deliveryReq(null) === 'face' && c.deliveryUi(null) === 'faceon', 'A never chosen = face-on, sent as "face"');
  c.settings.delivery = 'faceless';
  ok(c.deliveryReq(null) === 'faceless' && c.deliveryUi(undefined) === 'faceless', 'A the brand setting is what every switch starts on (faceless)');
  ok(c.deliveryReq('faceon') === 'face' && c.deliveryReq('face') === 'face' && c.deliveryUi('faceon') === 'faceon', 'A a per-post switch still overrides the brand setting');
  c.window._ideaDelivery = 'faceon'; c.window._remixDelivery = 'faceless'; c.window._tvDelivery = 'faceon';
  c.setBrandDelivery('faceon');
  ok(c.settings.delivery === 'face' && c.saves === 1 && c.window._ideaDelivery === null && c.window._remixDelivery === null && c.window._tvDelivery === null,
    'A Settings saves voice_extra.delivery ("face") and the switches follow it');
  c.setBrandDelivery('faceless');
  ok(c.settings.delivery === 'faceless' && /faceless/.test(c.toasts.join('|')), 'A Faceless is saved and said');
  // the Settings control: Brand Voice tab, labelled "How you film", the same chip component
  const d = ctx({ deliverySegHtml: (cur, fn, o) => '<SEG cur="' + cur + '" fn="' + fn + '" cap="' + (o && o.cap) + '">' });
  lift(d, DELIV_FNS.concat(['brandFilmSettingHtml'])); d.settings.delivery = 'faceless';
  ok(/cap="How you film"/.test(d.brandFilmSettingHtml()) && /cur="faceless" fn="setBrandDelivery"/.test(d.brandFilmSettingHtml()), 'A "How you film" shows the brand setting and saves through setBrandDelivery');
  const vt = html.indexOf("spActiveTab==='voice'?'block':'none'"), bb = html.indexOf('Brand Basics ${spFill', vt), fs1 = html.indexOf('brandFilmSettingHtml()', vt);
  ok(vt > 0 && fs1 > vt && fs1 < bb, 'A it sits in Settings → Brand Voice, above the sections (always visible)');
  // the round trip on the brand row
  const r = ctx({ currentUser: { id: 'u1' }, bvState: { messages: [] }, currentBrand: { voice_extra: {} }, defaultSettings: () => ({}) });
  lift(r, ['brandToSettings', 'settingsToBrand', 'formatsOffFrom']);
  const s1 = r.brandToSettings({ voice_extra: { delivery: 'faceless', newsDismissed: ['a', 'b'] }, format_mix: { video: 2, qna: 0 } });
  ok(s1.delivery === 'faceless' && J(s1.newsDismissed) === J(['a', 'b']), 'A brandToSettings reads voice_extra.delivery and newsDismissed');
  ok(r.brandToSettings({ voice_extra: { delivery: 'bogus' } }).delivery === null, 'A junk delivery reads as "not chosen"');
  r.settings = Object.assign({}, s1, { formatMix: { video: 2, qna: 0, static: 0 } });
  const row = r.settingsToBrand();
  ok(row.voice_extra.delivery === 'faceless' && J(row.voice_extra.newsDismissed) === J(['a', 'b']) && J(row.voice_extra.formatsOff) === J(['static', 'qna']),
    'A settingsToBrand writes delivery, newsDismissed and formatsOff (voice_extra is replaced wholesale)');
  r.settings = Object.assign({}, s1, { delivery: null }); ok(!('delivery' in r.settingsToBrand().voice_extra), 'A not chosen = not written (the server default face applies)');
  // one-time moves from the device
  const ls = { tv_delivery: 'faceless', auto_trends_dismissed: J(['Old Headline', 'b']) };
  const m = ctx({ lsGet: k => (k in ls ? ls[k] : null), lsSet: (k, v) => { ls[k] = v; }, saveSettingsDebounced() { m.saved = (m.saved || 0) + 1; }, currentBrand: { voice_extra: {} } });
  lift(m, DELIV_FNS.concat(['brandPrefsMigrate'])); m.settings.newsDismissed = ['b'];
  m.brandPrefsMigrate();
  ok(m.settings.delivery === 'faceless' && J(m.settings.newsDismissed.slice().sort()) === J(['b', 'old headline']) && m.saved === 1 && ls.news_dismissed_moved === '1',
    'A the old Quick Post Faceless and the old dismissed set move onto the brand once, and are saved');
  m.saved = 0; ls.auto_trends_dismissed = J(['later']); m.currentBrand.voice_extra.formatsOff = [];
  m.brandPrefsMigrate();
  ok(!m.settings.newsDismissed.includes('later') && !m.saved, 'A the move runs once (nothing re-read, nothing saved again)');
  m.settings.delivery = 'face'; ls.tv_delivery = 'faceless'; m.brandPrefsMigrate();
  ok(m.settings.delivery === 'face', 'A a brand setting already chosen beats the old device value');
  // rv2Body: delivery + newsDismissed on /api/angles and /api/write
  const b = ctx({ _tvBcFieldCount: () => 7, getBrandContext: () => ({}), _humanEditedTitles: () => [] });
  lift(b, DELIV_FNS.concat(['rv2DeliveryOf', 'rv2Body'])); b.settings.delivery = 'faceless'; b.settings.newsDismissed = ['x headline'];
  const qp = b.rv2Body({ brandId: 'B', origin: { name: 'quickpost', meta: { delivery: 'faceon' } } }, { source: {} });
  ok(qp.delivery === 'face' && J(qp.newsDismissed) === J(['x headline']), 'A Quick Post v2 sends its pick (face-on here) + the dismissed headlines');
  ok(b.rv2Body({ brandId: 'B', origin: { name: 'catcher', meta: {} } }).delivery === 'faceless', 'A Idea Catcher / composer / Notebook / PAA send the brand setting');
  ok(b.rv2Body({ brandId: 'B', origin: { name: 'remix', meta: {} } }).delivery === 'faceless', 'A Remix My take with no switch = the brand setting');
  b.window._remixDelivery = 'faceon';
  ok(b.rv2Body({ brandId: 'B', origin: { name: 'remix', meta: {} } }).delivery === 'face', 'A Remix My take follows the Remix switch');
  ok(b.rv2Body({ brandId: 'B' }, { delivery: 'face' }).delivery === 'face', 'A a caller can still pass the idea\'s own delivery');
  // leanBrandFetch: every writer request
  const sent = [];
  const l = ctx({ currentBrand: { id: 'B' }, flushBrandSave: async () => {}, _tvBcFieldCount: () => 7, getRecentTrends: () => [], _humanEditedTitles: () => [], _leanNetFail: () => false,
    fetch: async (u, init) => { sent.push({ u, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; } });
  lift(l, DELIV_FNS.concat(['leanBrandFetch'])); l.window._brandSaveOk = true; l.settings.delivery = 'faceless'; l.settings.newsDismissed = ['gone'];
  await l.leanBrandFetch('/api/generate-ideas', { count: 1 }, () => ({}));
  await l.leanBrandFetch('/api/generate-ideas', { count: 1, delivery: 'faceon' }, () => ({}));
  await l.leanBrandFetch('/api/remix', { remixMode: 'flip' }, () => ({}));
  await l.leanBrandFetch('/api/brand-voice-chat', { message: 'hi' }, () => ({}));
  l.window._brandSaveOk = false; await l.leanBrandFetch('/api/sharpen', { content: {} }, () => ({ full: 1 }));
  ok(sent[0].body.delivery === 'faceless' && J(sent[0].body.newsDismissed) === J(['gone']), 'A generate-ideas (classic develop, PAA classic, Notebook classic…) sends the brand setting + dismissed headlines');
  ok(sent[1].body.delivery === 'face', 'A a caller\'s override wins (Plan my week / Redo / Generate more pass theirs)');
  ok(sent[2].body.delivery === 'faceless' && !('newsDismissed' in sent[2].body), 'A remix sends delivery (no news there)');
  ok(!('delivery' in sent[3].body), 'A the coach chat is not a writer: no delivery');
  ok(sent[4].body.delivery === 'faceless' && sent[4].body.brandContext && sent[4].body.brandContext.full === 1, 'A the full-context fallback carries it too');
  // the call sites
  ok(/delivery: \(typeof deliveryReq === 'function'\) \? deliveryReq\(window\._ideaDelivery\)/.test(grab('generateNewIdeas')), 'A Plan my week sends its switch (brand setting when untouched)');
  const gt = grab('generateTodayTabPost');
  ok(/deliveryReq\(window\._tvDelivery\)/.test(gt) && /newsDismissed: \(typeof newsDismissedList === 'function'\) \? newsDismissedList\(\)/.test(gt), 'A classic Quick Post sends delivery + dismissed headlines');
  ok(/deliveryReq\(window\._remixDelivery\)/.test(grab('remixContent')) && /deliveryReq\(window\._remixDelivery\)/.test(grab('tryAllModes')), 'A Remix classic and Try all modes send the Remix switch');
  ok(/delivery: idea\.delivery/.test(grab('ideaRedoRun')) && /delivery: i\.delivery/.test(grab('generateMore')), 'A Redo with notes and Generate more send the idea\'s own delivery');
  // no per-device or brand-switch reset
  ok(!/lsGet\('tv_delivery'\) === 'faceless'\) \? 'faceless' : 'faceon'/.test(grab('renderTodayView')) && /window\._tvDelivery = null;/.test(grab('renderTodayView')), 'A Quick Post no longer reads its own per-device delivery');
  ok(!/lsSet\('tv_delivery'/.test(html), 'A nothing writes the old per-device delivery any more');
  ok(/window\._ideaDelivery = null; window\._remixDelivery = null; window\._tvDelivery = null;/.test(html) && !/window\._ideaDelivery = 'faceon'; window\._remixDelivery = 'faceon';/.test(html),
    'A a brand switch puts the switches back on the NEW brand\'s setting, never on face-on');
  ok(!/window\._ideaDelivery = window\._ideaDelivery \|\| 'faceon'/.test(html), 'A the session default of face-on is gone');
}

// ═════════ B — no auto-refill (owner decision 2) ═════════
{
  ok(!/autoRefillCheck\s*\(/.test(html), 'B no auto-refill function and no call to one');
  for (const fn of ['quickApprove', 'moveStage', 'tvApprove', 'tvMakeSlides', 'batchApprove'])
    ok(!/leanBrandFetch|generate-ideas|generateTodayTabPost|generateNewIdeas/.test(grab(fn)), 'B ' + fn + ' never generates (approving is free)');
}

// ═════════ C — coach voice off by default ═════════
{
  const speakCalls = (html.match(/\bbvSpeak\(/g) || []).length;
  ok(speakCalls === 2 && /bvSpeak\(String\(m\.content\)\)/.test(grab('bvSpeakMsg')), 'C bvSpeak runs only from the speaker button (' + speakCalls + ' mentions: the definition + bvSpeakMsg)');
  ok(!/bvSpeak\(/.test(grab('bvSend')) && !/bvSpeak\(/.test(grab('bvRenderHome')), 'C a reply and the greeting are text only');
  ok(/bvSpeakBtnHtml\(i\)/.test(grab('bvRenderMessages')) && /m\.role !== 'user'/.test(grab('bvRenderMessages')), 'C each coach reply carries a speaker button');
  const calls = [];
  const c = ctx({ bvState: { messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'A reply.' }], isSpeaking: false }, document: { querySelectorAll: () => [] },
    bvWaveSet() {}, bvVoiceUnavailable() { c.unavail = 1; }, bvSpeakBrowser: () => false, showUpgrade() { c.upgrade = 1; },
    fetch: async (u, init) => { calls.push({ u, body: JSON.parse(init.body) }); return { ok: false, status: 402, json: async () => ({ error: 'limit_reached' }) }; } });
  c.BV_SPEAK_SVG = '<svg/>';
  lift(c, ['bvSpeakBtnHtml', 'bvSpeakPaint', 'bvSpeakMsg', 'bvStopSpeaking', 'bvVoiceDenied', 'bvSpeak']); vm.runInContext('var _bvSpeakSeq = 0;', c);
  ok(/aria-label="Play this reply"/.test(c.bvSpeakBtnHtml(1)) && /onclick="bvSpeakMsg\(1\)"/.test(c.bvSpeakBtnHtml(1)), 'C the button plays that one reply');
  c.bvSpeakMsg(0); await tick();
  ok(calls.length === 0, 'C a user message is never spoken');
  c.bvSpeakMsg(1); await tick();
  ok(calls.length === 1 && calls[0].u === '/api/speak' && calls[0].body.text === 'A reply.', 'C pressing it makes ONE paid voice call, for that reply');
  ok(!c.upgrade && /out of credits for the voice/i.test(c.toasts.join('|')), 'C a 402 is said in plain words, no upgrade sheet');
  // the global fetch wrapper: never the upgrade sheet for /api/speak
  const at = html.indexOf('_resp.status === 402'); const start = html.indexOf('.json().then(function(d){', at); const bodyStart = html.indexOf('{', start + 15);
  let depth = 0, end = bodyStart; for (; end < html.length; end++) { if (html[end] === '{') depth++; else if (html[end] === '}') { depth--; if (!depth) break; } }
  const run = new Function('d', 'window', 'showToast', 'showUpgrade', 'showFeatureLock', '_u', html.slice(bodyStart + 1, end));
  let up = 0; run({ error: 'limit_reached' }, {}, () => {}, () => up++, () => {}, 'https://x/api/speak');
  const upSpeak = up; run({ error: 'limit_reached' }, {}, () => {}, () => up++, () => {}, 'https://x/api/generate-ideas');
  ok(upSpeak === 0 && up === 1, 'C the app-wide 402 handler skips the coach voice, keeps every other endpoint');
  ok(/\.bv-speak-btn\{[^}]*width:44px;height:44px/.test(css), 'C the speaker button is a 44px target');
}

// ═════════ D — dismissed headlines on the brand ═════════
{
  const c = ctx({ lsGet: () => J(['legacy one']), lsSet() {}, saveSettings() { c.saves = (c.saves || 0) + 1; }, renderTrendMemory() {} });
  lift(c, DELIV_FNS.concat(['_atDismissed', 'dismissAutoTrend']));
  c.dismissAutoTrend('Battery Electrolyte Breakthrough');
  ok(J(c.settings.newsDismissed) === J(['battery electrolyte breakthrough']) && c.saves === 1, 'D × writes voice_extra.newsDismissed (lower-cased headline) and saves');
  ok(c._atDismissed().has('legacy one') && c._atDismissed().has('battery electrolyte breakthrough'), 'D the chips hide both the brand list and the old device set');
  for (let i = 0; i < 205; i++) c.dismissAutoTrend('h' + i);
  ok(c.settings.newsDismissed.length === 200 && c.settings.newsDismissed[199] === 'h204' && !c.settings.newsDismissed.includes('h4') && c.settings.newsDismissed.includes('h5'), 'D max 200, newest kept');
  c.dismissAutoTrend('h10'); ok(c.settings.newsDismissed[199] === 'h10' && c.settings.newsDismissed.filter(x => x === 'h10').length === 1, 'D a repeat moves to newest, never twice');
}

// ═════════ E — Content Mix ═════════
{
  const c = ctx(); lift(c, DELIV_FNS);
  ok(J(c.formatsOffFrom({ video: 3, qna: 0, static: 0, carousel: 1 })) === J(['static', 'qna']), 'E formatsOff = the app/generate-ideas ids set to 0');
  c.settings.formatMix = { video: 0 }; ok(c.formatOn('video') === false && c.formatOn('micro') === true, 'E an unset format counts as on');
  const runs = []; let classic = 0;
  const t = ctx({ firstRunBrandGuard: () => false, tvResolvePostType: () => ({ type: c2type, surprise: true }), RV2_FORMATS: { video: 'talking', micro: 'micro', qna: 'talking', statement: 'statement', carousel: 'carousel' },
    generateTodayTabPost() { classic++; }, getTodayName: () => 'Monday', getDayCommunities: () => ({ Monday: 'Salt' }), rv2Start: (b, src, o) => runs.push(o) });
  let c2type = 'tip';
  lift(t, DELIV_FNS.concat(['tvGenerateV2']));
  t.settings.formatMix = { video: 0, carousel: 0, static: 0, statement: 2, micro: 0, qna: 0, bonus: 0 }; t.window._tvSelectedFormat = 'video';
  t.tvGenerateV2();
  ok(runs[0] && runs[0].appFormat === 'statement' && !classic, 'E "Write today\'s post" never runs a format switched off (video off → statement)');
  c2type = 'qna'; t.tvGenerateV2();
  ok(runs[1] && runs[1].appFormat === 'statement' && runs[1].postType === 'qna', 'E a Q&A type with Q&A off keeps the type, not the switched-off format');
  t.window._tvFormatChosen = true; t.window._tvSelectedFormat = 'micro'; c2type = 'tip'; t.tvGenerateV2();
  ok(runs[2] && runs[2].appFormat === 'micro', 'E a format the person picked themselves still runs');
  const rt = grab('renderTodayView');
  ok(/const _pool = _mixOn\.length \? _mixOn : formatKeys;/.test(rt) && /availableFormats = _pool\.filter/.test(rt) && /!_pool\.includes\(window\._tvSelectedFormat\)/.test(rt), 'E the random default draws from the formats switched on');
  // the Image (classic) path saves to Ideas, like every other writer
  const v = ctx({ tvCaptureEdits: () => false, saveState() {}, saveGeneratedIdeas: () => Promise.resolve({ ok: true }), renderNav() {}, document: { querySelector: () => null },
    beatsCacheGet: () => null, beatsCacheSet() {}, showApprovePopupFn() {}, switchView() {}, mascotReact() {} });
  lift(v, DELIV_FNS.concat(['tvApprove']));
  v.state.push({ id: 0, title: 'Salt myths', status: 'filming' });
  v.window._todayTabIdea = { title: 'Salt myths', format: 'static', tags: ['#a'] };
  v.tvApprove(); await tick();
  ok(v.state[1] && v.state[1].status === 'pending' && !v.state[1].approvedAt, 'E the classic Quick Post (Image) saves to Ideas as pending, never straight to the Pipeline');
  ok(v.state[1].title === 'Salt myths (2)', 'E … and a clashing title gets a suffix');
  ok(/Saved to your Ideas/.test(v.toasts.join('|')) && !/Pipeline/.test(v.toasts.join('|')), 'E it says "Saved to your Ideas"');
  ok(/onclick="tvApprove\(\)">Save to Ideas</.test(html) && /onclick="tvMakeSlides\(\)">Save &amp; make slides</.test(html), 'E the buttons say what they do (Save to Ideas / Save & make slides)');
}

// ═════════ F — paid work never dropped silently ═════════
{
  // a second Remix My take while a written script is unsaved
  const posts = [];
  const c = ctx({ currentBrand: { id: 'B' }, _rv2Runs: { rv2Panel: { brandId: 'B', stage: 'script', script: 'paid words', host: 'rv2Panel' } }, _rv2Seq: 0,
    rv2Source: () => ({ kind: 'remix', text: 'new words' }), rv2OriginFor: (n) => ({ name: n || 'remix', meta: {} }), typesValid: t => t || '',
    rv2SetRun: (h, s) => { c._rv2Runs[h] = s; }, rv2ClearDraft() { c.cleared = (c.cleared || 0) + 1; }, rv2Render() {}, document: { getElementById: () => null },
    btnWork: () => () => {}, flushBrandSave: async () => {}, rv2Post: async (u, b) => { posts.push(u); return { ok: false, status: 500, data: {} }; },
    rv2Body: (s, x) => x, rv2Live: () => true, rv2ErrText: () => 'x', rv2SaveDraft() {}, _leanErrMsg: () => 'x' });
  lift(c, ['rv2Start']);
  await c.rv2Start(null); await tick();
  ok(posts.length === 0 && c._rv2Runs.rv2Panel.script === 'paid words' && !c.cleared && /unsaved script/.test(c.toasts.join('|')), 'F a second My take first asks; the unsaved script and its draft stay');
  await c.rv2Start(null); await tick();
  ok(posts.length === 1 && c._rv2Runs.rv2Panel.script !== 'paid words', 'F pressing again replaces it');
  c._rv2Runs.rv2Panel = { brandId: 'B', stage: 'angles', script: '', host: 'rv2Panel' }; posts.length = 0;
  await c.rv2Start(null); await tick(); ok(posts.length === 1, 'F with nothing written yet, no question is asked');
  // "Use the classic … instead"
  let classicRuns = 0;
  const s = { host: 'rv2Sheet', brandId: 'B', stage: 'script', busy: false, script: 'paid', openAsk: null, picked: { id: '1' }, origin: { classic: () => { classicRuns++; } } };
  const k = ctx({ rv2Active: () => s, rv2SetRun() { k.set = (k.set || 0) + 1; }, rv2ClearDraft() {}, rv2Render() {} });
  lift(k, ['rv2StateKey', 'rv2Classic']);
  k.rv2Classic();
  ok(!k.set && !classicRuns && s.classicAsk, 'F "Use the classic … instead" on a written script asks first');
  k.rv2Classic();
  ok(k.set === 1 && classicRuns === 1, 'F the second press runs the classic writer');
  ok(/Press again to drop this script/.test(grab('rv2CardHtml')), 'F the link says what the second press does');
  // classic "Not for me"
  let gens = 0; const res = el('tvResult');
  const n = ctx({ saveState() {}, saveGeneratedIdeas() {}, generateTodayTabPost() { gens++; }, document: { getElementById: id => id === 'tvResult' ? res : null } });
  lift(n, ['tvDismissWithReason']); n.window._todayTabIdea = { title: 'Meh', format: 'video' };
  n.tvDismissWithReason('Too generic');
  ok(gens === 0 && n.state[0].status === 'dismissed' && n.state[0].dismissReason === 'Too generic', 'F "Not for me" only dismisses — it never writes (and pays for) a new post by itself');
  ok(/Write another post/.test(res.innerHTML) && /onclick="generateTodayTabPost\(\)"/.test(res.innerHTML), 'F writing another is its own button');
}

// ═════════ G — Sharpen stays busy until the server answers ═════════
{
  let workOpts = null, resolveFetch, calls = 0;
  const c = ctx({ btnWork: (b, set, o) => { workOpts = o; return () => { c.stopped = (c.stopped || 0) + 1; }; }, brandGate: () => () => true,
    leanBrandFetch: (u, body, mk, thin, o) => { calls++; c.lastSig = o && o.signal; return new Promise(r => { resolveFetch = r; }); }, saveEditSignals() {}, mascotReact() {} });
  lift(c, ['sharpenNow']);
  const p = c.sharpenNow({ content: { hook: 'h' }, btn: {}, apply() {} });
  await tick();
  ok(workOpts && workOpts.maxMs === 300000 && typeof workOpts.onTimeout === 'function', 'G the button stays busy up to 300 s (the server may work 280 s)');
  ok(c.lastSig && typeof c.lastSig.aborted === 'boolean', 'G the request can be cancelled at the deadline');
  await c.sharpenNow({ content: { hook: 'h' }, btn: {}, apply() {} });
  ok(calls === 1 && /Still sharpening/.test(c.toasts.join('|')), 'G a second press while it runs never sends (or pays for) a second sharpen');
  resolveFetch({ ok: true, status: 200, json: async () => ({ sharpened: { hook: 'H' } }) }); await p;
  ok(c.stopped === 1 && c.window._csSharpenBusy === false, 'G the button comes back only when the server answered');
}

// ═════════ H — Remix classic statement / carousel keep their text ═════════
{
  const c = ctx({ typesValid: t => t || '' }); lift(c, ['remixParts', 'remixToIdeas']);
  const st = c.remixToIdeas({ remixTitle: 'S', remixFormat: 'statement', remixScript: 'Salt is not the enemy. Water alone is.' }, 'pending')[0];
  const ca = c.remixToIdeas({ remixTitle: 'C', remixFormat: 'carousel', remixScript: '1: a\n2: b' }, 'pending')[0];
  const vi = c.remixToIdeas({ remixTitle: 'V', remixFormat: 'video', remixScript: 'talk' }, 'pending')[0];
  ok(st.boldText === 'Salt is not the enemy. Water alone is.' && ca.boldText === '1: a\n2: b' && !vi.boldText, 'H a statement / carousel remix saves its words as boldText (the graphic and the slides read it)');
}

// ═════════ I — carousel slides ═════════
{
  const c = ctx(); lift(c, ['_carouselSplitMarked', '_parseCarouselSlidesRaw', 'parseCarouselSlides']);
  const T = i => c.parseCarouselSlides(i).map(s => s.text);
  ok(J(T({ boldText: '1: Stop rinsing rice. 2: It washes off nothing useful. 3: Soak it instead. 4: Save this.' })) === J(['Stop rinsing rice.', 'It washes off nothing useful.', 'Soak it instead.', 'Save this.']), 'I "1: … 2: …" on one line = one slide each');
  ok(J(T({ boldText: '1: Short\n2: Also short\n3: Third' })) === J(['Short', 'Also short', 'Third']), 'I one "N:" per line works, even for short slides');
  ok(J(T({ boldText: 'Soak rice.\n\nIt cooks evenly.', script: 'Slide 1: huge headline, black bg. Slide 2: smaller text, photo of rice.' })) === J(['Soak rice.', 'It cooks evenly.']), 'I design notes in script never become slides when boldText exists');
  ok(J(T({ boldText: '1: Rated 4.8 stars by 600 people. 2: Here is why.' })) === J(['Rated 4.8 stars by 600 people.', 'Here is why.']), 'I a number inside a sentence is not a slide break');
  ok(J(T({ boldText: 'Slide 1: One\nSlide 2: Two' })) === J(['One', 'Two']), 'I "Slide N:" still works');
  ok(J(T({ boldText: '', script: 'Slide 1: Old one\nSlide 2: Old two' })) === J(['Old one', 'Old two']), 'I an older idea with slides only in script still opens');
}

// ═════════ J — Redo with notes / Generate more ═════════
{
  const bodies = []; const note = el('ideaRedoNote-0', { value: 'make it shorter' });
  const c = ctx({ document: { getElementById: id => (id === 'ideaRedoNote-0' ? note : null), querySelector: () => null }, brandGate: () => () => true, startThinking() {}, stopThinking() {},
    getTodayName: () => 'Monday', getBrandContext: () => ({}), saveEditSignals() {}, saveState() {}, saveGeneratedIdeas() {}, renderIdeas() {}, expandedIds: new Set(), currentBrand: null,
    POST_TYPE_IDS: ['tip', 'about', 'news', 'qna', 'story', 'bts'], safeUrl: u => u,
    leanBrandFetch: async (u, body) => { bodies.push(body); const t = J({ ideas: [{ title: 'Other idea', hook: 'h2', caption: 'New caption', postType: 'tip' }] }); return { ok: true, status: 200, text: async () => t }; } });
  lift(c, DELIV_FNS.concat(['typesValid', 'typesOf', 'typesNewsSource', 'typesCaptionWithSource', 'typesNormIdea', 'ideaRedoRun']));
  c.state = [{ id: 0, title: 'Salt tax news', format: 'video', status: 'pending', postType: 'news', delivery: 'faceless', newsSource: { title: 'Salt tax rises', url: 'https://news.example/salt' }, caption: 'Old\n\nSource: https://news.example/salt' },
    { id: 1, title: 'Other idea', format: 'video', status: 'pending' }];
  await c.ideaRedoRun(0); await tick();
  const r0 = c.state[0];
  ok(bodies[0].postType === 'news' && bodies[0].delivery === 'faceless' && /Salt tax rises/.test(bodies[0].learningContext), 'J Redo sends the post type, its delivery and names the headline');
  ok(r0.postType === 'news' && r0.newsSource && r0.newsSource.url === 'https://news.example/salt' && /\n\nSource: https:\/\/news\.example\/salt$/.test(r0.caption) && r0.delivery === 'faceless',
    'J the redone News idea keeps its type, its source link (once) and its delivery');
  ok(r0.title === 'Other idea (2)', 'J a redone title that clashes with another idea gets a suffix');
  ok(/postType: typesOf\(i\)/.test(grab('generateMore')) && /typesNormIdea\(x\)/.test(grab('generateMore')), 'J Generate more sends the post type and normalises the replies');
}

// ═════════ K — clashing titles ═════════
{
  const c = ctx({ document: { getElementById: () => null }, saveIdeasToDB() {}, switchView() {} }); lift(c, DELIV_FNS.concat(['addViralIdeaToList']));
  c._vlIdeas = [{ format: 'video' }, { format: 'video' }];
  const btn = el('b');
  c.addViralIdeaToList(0, btn); c.addViralIdeaToList(1, el('b2'));
  ok(c.state[0].title === 'Viral-inspired idea' && c.state[1].title === 'Viral-inspired idea (2)', 'K two untitled Trends ideas never share a title (the loader would hide one)');
  const u = ctx(); lift(u, DELIV_FNS); u.state = [{ title: 'A' }, { title: 'a (2)' }];
  ok(u.uniqueIdeaTitle('a') === 'a (3)' && u.uniqueIdeaTitle('  B  ') === 'B' && u.uniqueIdeaTitle('') === 'Untitled', 'K the suffix rule');
  const tk = new Set(); ok(u.uniqueIdeaTitle('X', tk) === 'X' && u.uniqueIdeaTitle('x', tk) === 'x (2)', 'K a batch never clashes with itself');
  for (const fn of ['tvApprove', 'nbDevelop', 'ideaDevelop', 'usePAAQuestion', 'ideaRedoRun', 'generateNewIdeas', 'addViralIdeaToList'])
    ok(/uniqueIdeaTitle\(/.test(grab(fn)), 'K ' + fn + ' gives a clashing title a suffix');
  ok(/uniq\(/.test(grab('remixToIdeas')) && /taken\.has\(title\.toLowerCase\(\)\)/.test(grab('rv2BuildIdea')), 'K Remix and the opinion sheet keep their own suffix rule');
}

// ═════════ L — Idea Catcher screenshot ═════════
{
  let classic = 0, v2 = 0;
  const vals = { icIdea: 'Bottled vs tap', icUrl: '', icNotes: '' };
  const c = ctx({ document: { getElementById: id => el(id, { value: vals[id] || '' }) }, ideaDevelop() { classic++; }, rv2Start() { v2++; }, btnWork: () => () => {}, icRefImage: 'data:image/png;base64,AA' });
  lift(c, ['icDevelopV2']);
  await c.icDevelopV2(); ok(classic === 1 && v2 === 0, 'L with a screenshot attached, the develop that reads it runs (the promise on screen holds)');
  c.icRefImage = null; await c.icDevelopV2(); ok(classic === 1 && v2 === 1, 'L without one, the opinion-first writer runs');
}

// ═════════ M / N / O ═════════
{
  ok(/News headlines from the web <span class="vl-trend-sub">/.test(html) && !/Auto-pulled from the web <span/.test(html), 'M the auto headlines are labelled news headlines');
  ok(/loved: ' \+ i\.approveReason/.test(grab('generateNewIdeas')), 'N Plan my week carries why approved ideas were liked');
  ok(/postType: 'qna'/.test(grab('paaAnswerV2')), 'O "Answer a real question" is a Q&A post in the v2 writer');
  const r = ctx(); lift(r, ['rv2CanRewrite']);
  ok(r.rv2CanRewrite({ format: 'video', status: 'filming', hook: 'h' }) && !r.rv2CanRewrite({ format: 'video', status: 'done', hook: 'h' }), 'O a Done post has no paid rewrite');
  ok(!/alert\('Remix failed/.test(html), 'O a Remix error is said in words, not a raw alert');
  ok(!/product facts baked in/.test(html), 'O the Remix FAQ no longer promises product facts (never salesy)');
  const f = []; const c = ctx({ fetch: async (u) => { f.push(u); return { ok: true, status: 200, text: async () => J({ transcript: 'the words' }) }; } });
  vm.runInContext('const _icTranscripts = new Map();', c); lift(c, ['csBrandRef', 'icReadVideo']);   // v712: link reads send brandId
  const a1 = await c.icReadVideo('https://www.tiktok.com/@x/video/1'); const a2 = await c.icReadVideo('https://www.tiktok.com/@x/video/1');
  ok(f.length === 1 && a1.text === 'the words' && a2.text === 'the words', 'O Idea Catcher reads (and pays for) a video once per session');
}

// ═════════ P — voice_extra is merged on save, never replaced with stale values (review item 1) ═════════
{
  const c = ctx(); lift(c, ['_veNorm', 'mergeVoiceExtra']);
  const base = { delivery: 'face', newsDismissed: ['a'], formatsOff: [], painPoints: 'old pains', voiceLearn: true };
  const fresh = { delivery: 'faceless', newsDismissed: ['a', 'from-a'], formatsOff: ['qna'], painPoints: 'old pains', voiceLearn: true, typeMix: { tip: 3 } };
  // device B: stale on delivery/formatsOff, changed painPoints, dismissed one headline
  const mine = { delivery: 'face', newsDismissed: ['a', 'from-b'], formatsOff: [], painPoints: 'new pains', voiceLearn: true };
  const m = c.mergeVoiceExtra(base, mine, fresh);
  ok(m.delivery === 'faceless' && J(m.formatsOff) === J(['qna']) && J(m.typeMix) === J({ tip: 3 }), 'P a stale device never writes back another device\'s delivery / formatsOff / other keys');
  ok(m.painPoints === 'new pains', 'P a key this device changed is applied');
  ok(J(m.newsDismissed) === J(['a', 'from-a', 'from-b']), 'P newsDismissed is a union, never a replacement');
  const big = c.mergeVoiceExtra({}, { newsDismissed: Array.from({ length: 150 }, (_, i) => 'b' + i) }, { newsDismissed: Array.from({ length: 150 }, (_, i) => 'a' + i) }).newsDismissed;
  ok(big.length === 200 && big[199] === 'b149' && !big.includes('a99') && big.includes('a100'), 'P the union is capped at 200, newest kept');
  ok(c.mergeVoiceExtra({ delivery: 'face' }, { delivery: 'faceless' }, { delivery: 'face' }).delivery === 'faceless', 'P a delivery changed here wins');
  ok(c.mergeVoiceExtra({ formatsOff: undefined }, { formatsOff: [] }, { formatsOff: ['qna'] }).formatsOff[0] === 'qna', 'P "never set" and "empty" are the same (no phantom change)');
  // the real save: one read, the merged object written; a failed read falls back to the old wholesale write
  const runSave = async (readFails) => {
    const ops = [];
    const sb = { auth: { getSession: async () => ({ data: { session: {} } }) },
      from(t) { const q = { t, op: null }; const bld = {
        select(cols) { if (!q.op) { q.op = 'select'; q.cols = cols; } return bld; }, eq() { return bld; },
        update(d) { q.op = 'update'; q.data = d; return bld; },
        maybeSingle() { ops.push(q); if (readFails === 'throw') return Promise.reject(new Error('network')); return Promise.resolve(readFails ? { data: null, error: { message: 'offline' } } : { data: { voice_extra: { delivery: 'faceless', newsDismissed: ['x'], keep: 1 } }, error: null }); },
        then(res, rej) { ops.push(q); return Promise.resolve({ data: [{ id: 'B' }], error: null }).then(res, rej); } }; return bld; } };
    const s = ctx({ sb, currentUser: { id: 'u' }, currentBrand: { id: 'B', voice_extra: { delivery: 'face', newsDismissed: [] } }, _brandLoadFailed: false, debugLog() {}, notifyBrandSaveBlocked() {}, alert() {},
      settingsToBrand: () => ({ brand_name: 'X', voice_extra: { delivery: 'face', newsDismissed: ['y'], painPoints: 'p' } }) });
    s.settings = { delivery: 'face', newsDismissed: ['y'] };
    lift(s, ['_veNorm', 'mergeVoiceExtra', '_saveBrandToDBInner']);
    await s._saveBrandToDBInner();
    return { ops, s };
  };
  const r1 = await runSave(false);
  const reads = r1.ops.filter(q => q.op === 'select' && q.cols === 'voice_extra'), upd = r1.ops.find(q => q.op === 'update');
  ok(reads.length === 1 && upd && upd.data.voice_extra.delivery === 'faceless' && upd.data.voice_extra.keep === 1 && upd.data.voice_extra.painPoints === 'p'
    && J(upd.data.voice_extra.newsDismissed) === J(['x', 'y']), 'P a save re-reads voice_extra ONCE and writes the merge');
  ok(r1.s.settings.delivery === 'faceless' && J(r1.s.settings.newsDismissed.slice().sort()) === J(['x', 'y']) && r1.s.currentBrand.voice_extra.delivery === 'faceless',
    'P this device takes the stored delivery and headlines, and the merge is the next save\'s base');
  const r2 = await runSave(true);
  const upd2 = r2.ops.find(q => q.op === 'update');
  ok(upd2 && upd2.data.voice_extra.delivery === 'face' && J(upd2.data.voice_extra.newsDismissed) === J(['y']) && r2.s.window._brandSaveOk === true, 'P a failed re-read falls back to today\'s wholesale save');
  const r3 = await runSave('throw'); const upd3 = r3.ops.find(q => q.op === 'update');
  ok(upd3 && upd3.data.voice_extra.painPoints === 'p' && J(upd3.data.voice_extra.newsDismissed) === J(['y']) && r3.s.window._brandSaveOk === true, 'P a re-read that throws also falls back to the wholesale save');
}

// ═════════ Q — a short batch is said plainly (review item 2) ═════════
{
  const c = ctx(); lift(c, ['shortBatchNote']);
  ok(c.shortBatchNote({ short: true, requested: 5, delivered: 3 }) === '5 asked, 3 came back \u2014 the others broke your rules and were left out.', 'Q "5 asked, 3 came back — the others broke your rules and were left out."');
  ok(c.shortBatchNote({ ideas: [] }) === '' && c.shortBatchNote({ short: true, requested: 3, delivered: 3 }) === '' && c.shortBatchNote(null) === '', 'Q nothing is said when the batch is whole');
  ok(!/\btap/i.test(c.shortBatchNote({ short: true, requested: 7, delivered: 1 })), 'Q no "tap" wording');
  ok(/shortBatchNote\(data\)/.test(grab('generateNewIdeas')), 'Q Plan my week says it under the button');
  // Generate more, run for real
  const st = []; const gm = ctx({ _gmKey: i => 'k' + i.id, _gmBusy: new Set(), brandGate: () => () => true, ICO: {}, getTodayName: () => 'Monday', getBrandContext: () => ({}), getDayCommunities: () => ({}),
    saveState() {}, renderNav() {}, csAiPausedText: x => x, humanErr: (a, b) => b, _leanErrMsg: (e, f) => (e && e.message) || f, document: { getElementById: () => null },
    leanBrandFetch: async () => { const t = J({ ideas: [{ title: 'One' }, { title: 'Two' }], short: true, requested: 3, delivered: 2 }); return { ok: true, status: 200, text: async () => t }; } });
  lift(gm, DELIV_FNS.concat(['shortBatchNote', 'generateMore']));
  gm.state = [{ id: 0, title: 'Base', format: 'video', day: 'Monday' }];
  await gm.generateMore(0, null); await tick();
  ok(gm.state.length === 3 && /^2 new versions added\. 3 asked, 2 came back/.test(gm.toasts.join('|')), 'Q Generate more says how many came back');
}

if (fail) { console.log('\n' + fail + ' check(s) failed'); process.exit(1); }
finished = true;
console.log('\nCONSISTENCY APP OK');
