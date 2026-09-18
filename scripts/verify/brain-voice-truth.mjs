#!/usr/bin/env node
// GATE: what the app tells the model about the USER must actually come from the user, and what
//       it calls "working right now" must actually be recent.
//
// WHY THIS EXISTS
//   TWO separate lies, both feeding the same prompt, both invisible on screen.
//
//   1. THE MODEL'S OWN WRITING, LABELLED AS THE FOUNDER'S VOICE.
//      Sharpen, Viral twist and the viral rewrite each log an edit signal whose `after` is the
//      MODEL's text. v665 tagged them `by:'ai'` and filtered them in exactly ONE reader. Four
//      other readers of the same localStorage key kept handing them to the model under headings
//      that assert they are the user's own:
//        "HOW THE USER EDITS OUR DRAFTS (mirror these fixes — this is their real voice)"   ×2
//        the humanEditedTitles list, which the SERVER PREFERS over its own filtered DB query
//        "They edit their drafts by hand (N logged)"  and  "N manual edits"
//      Measured on a store of 6 typed edits and 8 model rewrites: 8 of the 8 lines under "this
//      is their real voice" were model-written. The brand brain was learning to imitate itself,
//      and the more the user used Sharpen the worse it got.
//      The fix is ONE reader — humanEditSignals() — because five inline filters is precisely how
//      the v665 fix came to be missed twice. So this gate pins the RULE, not a list: no code may
//      read the edit-signal store raw.
//
//   2. THE 16 OLDEST TRENDS, CALLED "RIGHT NOW".
//      getRecentTrends read `getTrendStore().concat(getAutoTrends())` and sliced from the FRONT.
//      The store is oldest-first and caps at 40; the nightly cron's items are appended LAST. So
//      after one busy week the model was handed the 16 stalest topics, and 0 of the 12 fresh
//      cron items reached the prompt at all — under a heading (trendsBlock) that tells it these
//      are working right now. Measured before the fix: 0/12. After: 12/12.
//
// HOW IT CHECKS
//   It RUNS the real functions, lifted out of app.html into a vm with a fake localStorage, over
//   a store built to look like a real user's. Then it re-runs the pre-fix expressions and
//   REQUIRES them to produce the wrong answer, so a green result cannot come from a dead test.
//
// RUN:    node scripts/verify/brain-voice-truth.mjs
// EXPECT: prints "PASS" and exits 0.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const fails = [];
const ok = (c, m) => { if (!c) fails.push(m); };
const grab = n => {
  const i = html.indexOf('\nfunction ' + n + '(');
  if (i < 0) { fails.push('app.html: function ' + n + ' is gone'); return 'function ' + n + '(){}'; }
  return html.slice(i + 1, html.indexOf('\n}', i) + 2);
};

// ── PART 1: nothing reads the edit-signal store raw ─────────────────────────────────────────
// Comments are stripped first — a NAME IN A COMMENT IS NOT A CALL SITE, and this file is
// HTML+CSS+JS in one, so only whole-line // comments are removed (never /* */ file-wide).
const code = html.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const RAW = /(JSON\.parse\(\s*lsGet\(\s*'edit_signals'\s*\)[^\n]*)/g;
const rawReads = [];
for (const m of code.matchAll(RAW)) {
  const line = code.slice(0, m.index).split('\n').length;
  rawReads.push({ line, text: m[1].replace(/\s+/g, ' ').slice(0, 110) });
}
// A raw read is legitimate in exactly three places, each named with its reason. Anything
// else is a reader that will drift away from the filter the way five of them already did.
const RAW_OK = {
  humanEditSignals: 'it IS the filter',
  saveEditSignals:  'the writer \u2014 it reads the existing array to append to it',
  brainCountNewSignals: 'a lifetime tally of signals of every kind, on purpose',
  brainAutoDistill: 'api/distill-voice.js splits typed vs chosen server-side and needs both',
  brainDistill:     'same distill payload as brainAutoDistill',
};
// Which function is a given offset inside? The top-level functions in this file close with a
// `}` at column 0, so the nearest preceding `\nfunction NAME(` / `\nasync function NAME(` wins.
const DECLS = [...code.matchAll(/\n(?:async )?function (\w+)\s*\(/g)].map(m => ({ at: m.index, name: m[1] }));
const enclosing = off => { let n = '(top level)'; for (const d of DECLS) { if (d.at > off) break; n = d.name; } return n; };
const offenders = rawReads.filter(r => !RAW_OK[enclosing(code.indexOf(r.text.slice(0, 50)))])
  .map(r => ({ ...r, fn: enclosing(code.indexOf(r.text.slice(0, 50))) }));
// and the allow-list must not rot: every name on it must still exist
for (const n of Object.keys(RAW_OK))
  ok(new RegExp('function ' + n + '\\s*\\(').test(code), 'brain-voice-truth allow-list names ' + n + ', which no longer exists');

ok(offenders.length === 0,
  'code reads the edit-signal store RAW instead of through humanEditSignals(), so the model\'s own\n' +
  '      rewrites are handed back as the user\'s voice again:\n      ' +
  offenders.map(o => 'app.html:' + o.line + '  in ' + o.fn + '()  ' + o.text).join('\n      '));

ok(html.includes('function humanEditSignals('), 'humanEditSignals() is gone — the shared filter this gate exists to protect');

// ── the real readers, run against a real-shaped store ───────────────────────────────────────
const STORE = [];
for (let i = 0; i < 6; i++) STORE.push({ ts: i, field: 'hook', before: 'b' + i, after: 'A person actually typed this line number ' + i + ' here' });
for (let i = 0; i < 8; i++) STORE.push({ ts: 100 + i, by: 'ai', field: 'sharpen:hook', before: 'b', after: 'The model wrote this rewrite number ' + i + ' itself' });

const ctx = { console, lsGet: k => (k === 'edit_signals' ? JSON.stringify(STORE) : null), state: [], settings: {} };
vm.createContext(ctx);
vm.runInContext([grab('humanEditSignals'), grab('buildLearningContext'), grab('_humanEditedTitles')].join('\n'), ctx);

const human = vm.runInContext('humanEditSignals()', ctx);
ok(human.length === 6, 'humanEditSignals kept ' + human.length + ' of 14 signals; 6 were typed by a person');
ok(human.every(s => s.by !== 'ai'), 'humanEditSignals let a model-written signal through');
ctx.lsGet = () => 'not json at all';
ok(vm.runInContext('humanEditSignals()', ctx).length === 0, 'humanEditSignals must return [] on a corrupt store, not throw');
ctx.lsGet = k => (k === 'edit_signals' ? JSON.stringify({ not: 'an array' }) : null);
ok(vm.runInContext('humanEditSignals()', ctx).length === 0, 'humanEditSignals must return [] when the store is not an array');
ctx.lsGet = k => (k === 'edit_signals' ? JSON.stringify(STORE) : null);

const learn = vm.runInContext('buildLearningContext()', ctx);
const voice = learn.split('\n').filter(l => l.startsWith('• '));
ok(voice.length > 0, 'buildLearningContext stopped emitting the voice block entirely');
ok(voice.every(l => !l.includes('The model wrote')),
  voice.filter(l => l.includes('The model wrote')).length + ' of ' + voice.length +
  ' lines under "this is their real voice" are the MODEL\'s own text');
ok(/this is their real voice/.test(learn), 'the voice heading is gone — check the claim still matches the content');

ctx.state = [
  { status: 'done', title: 'Matched only the model', script: 'The model wrote this rewrite number 3 itself' },
  { status: 'done', title: 'Matched a real edit', script: 'A person actually typed this line number 2 here' },
  { status: 'done', title: 'Flagged at capture time', humanEdited: true, script: 'nothing matches' },
];
const titles = vm.runInContext('_humanEditedTitles()', ctx);
ok(!titles.includes('Matched only the model'),
  '_humanEditedTitles calls a post human-rewritten because it matched the MODEL\'s own text');
ok(titles.includes('Matched a real edit'), '_humanEditedTitles stopped matching a genuine rewrite');
ok(titles.includes('Flagged at capture time'), '_humanEditedTitles stopped honouring the humanEdited flag');

// MUTATION: the pre-fix reader MUST get it wrong, or Part 1 proves nothing.
{
  const pre = JSON.parse(ctx.lsGet('edit_signals')).slice(-8);
  ok(pre.filter(e => e.by === 'ai').length === 8,
    'MUTATION CHECK FAILED: the pre-fix reader no longer picks up model-written signals, so this gate is vacuous');
}

// ── PART 2: "right now" means recent ────────────────────────────────────────────────────────
const tctx = { console };
vm.createContext(tctx);
tctx.store = []; tctx.auto = [];
vm.runInContext('function getTrendStore(){return store;} function getAutoTrends(){return auto;}\n' + grab('getRecentTrends'), tctx);

// a busy week: the store is full (40, oldest first) and the cron added 12 fresh items
tctx.store = Array.from({ length: 40 }, (_, i) => ({ text: 'manual' + i, ts: 1000 + i }));
tctx.auto = Array.from({ length: 12 }, (_, i) => ({ text: 'cron' + i, ts: 900000 + i, auto: true }));
const got = vm.runInContext('getRecentTrends()', tctx);
ok(got.length === 16, 'getRecentTrends returned ' + got.length + ', expected the 16-item cap');
ok(got.filter(t => t.startsWith('cron')).length === 12,
  'only ' + got.filter(t => t.startsWith('cron')).length + '/12 nightly-cron trends reached the prompt');
ok(got.includes('manual39'), 'the newest hand-typed trend was dropped');
ok(!got.includes('manual0'), 'the OLDEST hand-typed trend is still being sent as "working right now"');

// dedupe must keep the fresher copy, and junk must not throw
tctx.store = [{ text: 'Same topic', ts: 1 }]; tctx.auto = [{ text: 'same TOPIC', ts: 99 }];
const dd = vm.runInContext('getRecentTrends()', tctx);
ok(dd.length === 1, 'a case-different duplicate was not deduped');
ok(dd[0] === 'same TOPIC', 'dedupe kept the STALER copy of a duplicate trend');
tctx.store = [{ text: '  ' }, { text: null }, null, { ts: 5 }, {}]; tctx.auto = [];
ok(vm.runInContext('getRecentTrends()', tctx).length === 0, 'blank/!text entries must not become trend lines');
tctx.store = []; tctx.auto = [];
ok(vm.runInContext('getRecentTrends()', tctx).length === 0, 'an empty store must give []');

// MUTATION: the pre-fix slice MUST return 0 cron items.
{
  const store = Array.from({ length: 40 }, (_, i) => ({ text: 'manual' + i, ts: 1000 + i }));
  const auto = Array.from({ length: 12 }, (_, i) => ({ text: 'cron' + i, ts: 900000 + i }));
  const seen = new Set(); const out = [];
  for (const t of store.concat(auto)) { const k = (t.text || '').toLowerCase().trim(); if (!k || seen.has(k)) continue; seen.add(k); out.push(t.text); }
  const pre = out.slice(0, 16);
  ok(pre.filter(t => t.startsWith('cron')).length === 0,
    'MUTATION CHECK FAILED: the pre-fix slice now includes cron items, so Part 2 proves nothing');
}

if (fails.length) { console.error('FAIL\n- ' + fails.join('\n- ')); process.exit(1); }
console.log('PASS — the voice block carries only what the user typed, and "right now" means the newest 16');
