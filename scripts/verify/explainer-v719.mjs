#!/usr/bin/env node
// GATE (v719, owner 2026-11-08): the format shown as "Micro-Lecture" is now called "Explainer". Its internal id stays
// `micro` everywhere (data, API, storage, FORMAT_ALIAS, the batch); only the labels and the writing shape changed.
// STATIC + node-only (no browser, no network, no AI):
//   1  no visible "micro-lecture" (any case, any spacing) in app.html (comments blanked) or in api/*.js prompt text.
//   2  FORMAT_LABELS.micro === 'Explainer' (the one map every chip, filter, card and the post-mix settings read);
//      the id is still 'micro' (app FORMATS, _write FORMAT_ALIAS).
//   3  postRules({format:'micro'}) carries the explainer shape (the question in one plain line -> how it actually works,
//      in plain words or with one everyday comparison -> what it means for the viewer), keeps the short-format limit
//      (one point, no list of steps) and still carries the no-sell rule and the no-invention rules; every other prompt
//      that describes the micro format says the same shape.
//   4  an existing saved idea with format 'micro' renders (the real renderPipeline + the real FORMAT_LABELS) as "Explainer".
// RUN: node scripts/verify/explainer-v719.mjs      EXPECT: prints "EXPLAINER V719 OK", exit 0.
import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm';
import { fileURLToPath } from 'node:url'; import { createRequire } from 'node:module';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require_ = createRequire(import.meta.url);
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let finished = false; process.on('exit', (code) => { if (!finished && code === 0) { console.log('FAIL: the gate ended before all checks ran'); process.exitCode = 1; } });
let fail = 0; const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('ok:', m); };

const blank = s => s.replace(/[^\n]/g, ' ');
const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/<!--[\s\S]*?-->/g, blank)
  .replace(/(^|[\s;{}(),])\/\/[^\n]*/gm, (m, a) => a + ' '.repeat(m.length - a.length));
const OLD = /micro[\s\-_]*lectures?/i;
const hitsIn = (src) => stripComments(src).split('\n').map((l, i) => OLD.test(l) ? (i + 1) + ': ' + l.trim().slice(0, 120) : null).filter(Boolean);

/* ═══ 0. the detector proves itself ═══ */
{
  const bad = ['micro:"Micro-Lecture"', 'desc:"professor-mode micro-lectures."', "'(VIDEO, MICRO-LECTURE, Q&A)'", 'a micro lecture'];
  const good = ['// talking head micro lecture', '/* Micro-Lecture */', '<!-- micro-lecture -->', "micro: 'micro'", "'micro[\\\\s-]?lectures?'"];
  ok(bad.every(s => hitsIn(s).length) && good.every(s => !hitsIn(s).length), '0 the detector flags visible "micro-lecture" and leaves comments / the id alone');
}

const app = read('app.html');
/* ═══ 1. no visible "micro-lecture" ═══ */
{
  const h = hitsIn(app);
  ok(!h.length, '1 app.html shows no "micro-lecture"' + (h.length ? ' — ' + h.join(' | ') : ''));
  const apiDir = path.join(ROOT, 'api'), bad = [];
  for (const f of fs.readdirSync(apiDir).filter(f => f.endsWith('.js'))) {
    const hh = hitsIn(fs.readFileSync(path.join(apiDir, f), 'utf8'));
    if (hh.length) bad.push('api/' + f + ' ' + hh.join(' | '));
  }
  ok(!bad.length, '1 no api/*.js prompt says "micro-lecture"' + (bad.length ? ' — ' + bad.join(' || ') : ''));
}

/* ═══ 2. the label, and the id that stays ═══ */
const W = require_(path.join(ROOT, 'api', '_write.js'));
let LABELS = null;
{
  const m = /\nconst FORMAT_LABELS = (\{[^\n]*?\});/.exec(app);
  try { LABELS = m && vm.runInNewContext('(' + m[1] + ')'); } catch (e) { LABELS = null; }
  ok(LABELS && LABELS.micro === 'Explainer', "2 FORMAT_LABELS.micro === 'Explainer' (got " + JSON.stringify(LABELS && LABELS.micro) + ')');
  ok(LABELS && Object.keys(LABELS).join() === 'video,carousel,static,statement,micro,bonus,qna', '2 the format ids are unchanged (micro is still micro)');
  ok(/\nconst FORMATS = \["video","carousel","static","statement","micro","bonus","qna"\];/.test(app), '2 app FORMATS still lists the id "micro"');
  ok(W._internals.normPostFormat('micro') === 'micro', '2 _write FORMAT_ALIAS still maps micro -> micro');
}

/* ═══ 3. the writing shape ═══ */
{
  const pr = W.postRules({ format: 'micro' });
  const shape = /the question in one plain line, then how it actually works \(in plain words or with one everyday comparison\), then what it means for the viewer/;
  ok(typeof W.EXPLAINER_SHAPE === 'string' && shape.test(W.EXPLAINER_SHAPE), '3 EXPLAINER_SHAPE is the owner\'s shape: question -> how it works / comparison -> what it means');
  ok(/EXPLAINER/.test(pr) && shape.test(pr), '3 postRules({format:"micro"}) says it is an EXPLAINER video, with that shape');
  ok(/One point, no list of steps\./.test(pr) && /short explainer video/.test(pr), '3 the short-format limit stays (one point, no list of steps)');
  ok(pr.indexOf(W.NO_SELL_RULE) >= 0, '3 the no-sell rule is still there');
  ok(pr.indexOf(W.SLOT_RULE) >= 0 && /never an invented number, name or result/.test(pr), '3 the no-invention rules are still there (slot rule + no invented facts)');
  ok(['talking', 'statement', 'carousel', 'qna', 'static'].every(f => !shape.test(W.postRules({ format: f }))), '3 only the micro format gets the explainer shape');
  ok(['tip', 'about', 'news', 'story', 'bts'].every(t => shape.test(W.postRules({ type: t, format: 'micro' })) && W.postRules({ type: t, format: 'micro' }).indexOf(W.SHORT_SHAPES[t]) >= 0), '3 every typed micro post keeps its type shape AND gets the explainer beats');
  ok(W.TYPE_SHAPES.tip === 'the problem, then 2 to 4 concrete steps the viewer can do, then the result they get' && Object.keys(W.TYPE_SHAPES).join() === 'tip,about,news,qna,story,bts', '3 TYPE_SHAPES and the six types are untouched');
  const desc = { 'api/_brain.js': /micro: '10-15s EXPLAINER video[^\n]*how it actually works/, 'api/generate-ideas.js': /- micro \(shown to users as "Explainer"\): [^\n]*how it actually works[^\n]*never an invented statistic/,
    'api/viral-rewrite.js': /micro: '10-15s EXPLAINER video[^\n]*how it actually works[^\n]*never a made-up statistic/, 'api/sharpen.js': /micro: 'This is a short SPOKEN explainer video[^\n]*how it actually works/ };
  for (const [f, re] of Object.entries(desc)) ok(re.test(read(f)), '3 ' + f + ' describes micro as an explainer, with the same shape');
}

/* ═══ 4. a saved micro idea renders as "Explainer" ═══ */
{
  const grab = n => { const i = app.indexOf('\nfunction ' + n + '('); if (i < 0) throw new Error('no ' + n); return app.slice(i + 1, app.indexOf('\n}', i) + 2); };
  const between = (src, a, b) => { const i = src.indexOf(a); const j = src.indexOf(b, i + a.length); if (i < 0 || j < 0) throw new Error('marker missing: ' + a); return src.slice(i, j + b.length); };
  const escHtml = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let html = '';
  try {
    const c = { STAGES: ['filming', 'done'], STAGE_LABELS: { filming: 'Film & Post', done: 'Done' }, STAGE_ICONS: {}, STAGE_NEXT: { filming: 'done' }, STAGE_PREV: { done: 'filming' },
      FORMAT_LABELS: LABELS || {}, ICO: { undo: '' }, expandedIds: new Set(), activePipelineStage: 'filming',
      escHtml, escAttr: escHtml, asText: x => String(x || ''), getInitials: () => 'X', renderDetailContent: () => '', renderEmptyState: () => 'EMPTY', Date, Set,
      state: [{ id: 0, title: 'An old saved micro idea', format: 'micro', status: 'filming', day: 'Monday', script: 'x' }] };
    const els = { pipelineStages: { innerHTML: '' }, pipelineContent: { innerHTML: '' } };
    c.document = { getElementById: id => els[id] || null };
    vm.createContext(c);
    vm.runInContext(between(app, 'var CS_READ_FORMATS', ';') + '\n' + grab('renderPipeline'), c);
    c.renderPipeline(); html = els.pipelineContent.innerHTML;
  } catch (e) { html = 'ERROR ' + e.message; }
  ok(/<span class="format-tag micro">Explainer<\/span>/.test(html), '4 a saved idea with format "micro" renders with the "Explainer" label' + (/ERROR/.test(html) ? ' — ' + html : ''));
  ok(!OLD.test(html), '4 and never with the old name');
}

finished = true;
if (fail) { console.log('EXPLAINER V719 FAILED: ' + fail); process.exit(1); }
console.log('EXPLAINER V719 OK');
