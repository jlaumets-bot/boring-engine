#!/usr/bin/env node
// GATE (v714, owner 2026-11-06): two teleprompter bugs.
//   A  While recording, the timer pill sat on top of "Mark done" (and on "Close"), and the full-screen script (fixed,
//      z-index 3) lay over the whole top bar (z-index 2), so Mark done / Close were drawn but every tap hit the script.
//      Now: timer + mode chip on the LEFT (where the hidden title was), the bar above the script, buttons tappable.
//      CHECKED from the real CSS in app.html + clean.css: the effective left/right/top of the timer and the chip, the
//      button sizes, and a box model of a 390 px and a 1440 px screen (widths over-estimated at 0.7 em per letter, so
//      a pass is not luck). Plus the stacking: bar above the script, timer above the bar's scrim, timer not tappable.
//   B  Voice-follow skipped a sentence when a word repeats later ("…your first cup. … one cup you never skip"): the
//      recogniser re-delivers words already credited, and the old "cup" could only score at the NEXT "cup".
//      EXECUTED: the real tpVoiceMatch (+ tpNormWord, tpNormWords, tpWordNear, TP_CONTENT_WORD, TP_STOPWORDS,
//      TP_LEAP_MARGIN) is lifted out of app.html and fed the sample script word by word in 10 delivery patterns
//      (whole transcript, per sentence, last 1–6 words, re-delivered stale results, dropped words). It must never land
//      in a later sentence than the word being said, must still reach the end, and must still jump on a real
//      ≥3-word match far ahead (and never on one or two stray words).
// RUN: node scripts/verify/tp-fixes-v714.mjs     EXPECT: "TP FIXES OK", exit 0.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const cleanCss = fs.existsSync(path.join(ROOT, 'clean.css')) ? fs.readFileSync(path.join(ROOT, 'clean.css'), 'utf8') : '';
setTimeout(() => { console.log('FAIL: wall clock (60s) exceeded'); process.exit(2); }, 60000).unref();
let fail = 0; const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('ok:', m); };

/* ══ A. layout ══════════════════════════════════════════════════════════════ */
const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n') + '\n' + cleanCss;
const RULES = [...styles.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(m => ({ sels: m[1].split(',').map(s => s.trim().replace(/\s+/g, ' ')), body: m[2] }));
const decl = (body, prop) => { let v = null; for (const d of body.split(';')) { const i = d.indexOf(':'); if (i > 0 && d.slice(0, i).trim() === prop) v = d.slice(i + 1).trim(); } return v; };
// the value the LAST rule with exactly this selector sets (source order = cascade order at equal specificity)
const eff = (sel, prop) => { let v = null; for (const r of RULES) if (r.sels.includes(sel)) { const d = decl(r.body, prop); if (d != null) v = d; } return v; };
const num = v => (v == null ? NaN : parseFloat(v));
const R = '.teleprompter-overlay.recording ';
{
  const tl = eff(R + '.tp-rec-timer', 'left'), tr = eff(R + '.tp-rec-timer', 'right'), tt = eff(R + '.tp-rec-timer', 'top');
  const ml = eff(R + '.tp-mode', 'left'), mr = eff(R + '.tp-mode', 'right'), mt = eff(R + '.tp-mode', 'top');
  ok(num(tl) >= 0 && tr === 'auto' && ml === tl && mr === 'auto', 'A while recording the timer and the mode chip sit on the LEFT (left ' + tl + ', right ' + tr + ')');
  // nothing stronger moves them back to the right
  const imp = RULES.filter(r => r.sels.some(s => /\.tp-rec-timer|\.tp-mode(?![\w-])/.test(s)) && /(?:^|;)\s*(?:left|right)\s*:[^;]*!important/.test(r.body));
  ok(!imp.length, 'A no !important left/right anywhere overrides that (' + imp.length + ')');
  // box model, at 390 px and 1440 px: the actions are right-aligned in the top bar
  const pr = num(eff('.teleprompter-top', 'padding-right')) || 16;
  const doneFs = 12, doneTxt = 'Mark done', closeTxt = 'Close';
  const doneW = 2 * 14 + doneTxt.length * doneFs * 0.7 + 3, closeW = 2 * 4 + closeTxt.length * 13 * 0.7, gap = 8;
  const timerW = 8 + 7 + '00:00'.length * 14 * 0.7, modeW = 'FOLLOWING YOUR VOICE'.length * 10.5 * 0.7 * 1.1;
  for (const W of [390, 1440]) {
    const doneX0 = W - pr - closeW - gap - doneW, doneX1 = W - pr - closeW - gap;
    // where the box really is: from `left`, else from `right` (the recording rule, else the base rule)
    const span = (sel, w) => { const l = num(eff(R + sel, 'left')); if (!isNaN(l)) return [l, l + w];
      const r = num(eff(R + sel, 'right') !== 'auto' && eff(R + sel, 'right') != null ? eff(R + sel, 'right') : eff(sel, 'right')); return [W - r - w, W - r]; };
    const timer = span('.tp-rec-timer', timerW), mode = span('.tp-mode', modeW);
    const apart = (a, b) => a[1] <= b[0] || b[1] <= a[0];
    ok(apart(timer, [doneX0, doneX1]) && apart(mode, [doneX0, doneX1]) && apart(timer, [W - pr - closeW, W - pr]) && apart(mode, [W - pr - closeW, W - pr]),
      'A at ' + W + ' px: timer [' + timer.map(Math.round) + '] and chip [' + mode.map(Math.round) + '] never touch Mark done [' + [doneX0, doneX1].map(Math.round) + '] or Close');
  }
  ok(num(mt) > num(tt) && num(mt) - num(tt) >= 20, 'A the chip sits under the timer (top ' + tt + ' / ' + mt + '), not on it');
  // stacking: the bar (and so Mark done / Close) above the fixed script; the timer above the bar's scrim
  const bodyZ = num(eff(R + '.teleprompter-body', 'z-index')), topZ = num(eff(R + '.teleprompter-top', 'z-index'));
  ok(eff(R + '.teleprompter-top', 'position') === 'relative' && topZ > bodyZ && eff(R + '.teleprompter-top-actions', 'pointer-events') === 'auto' && /pointer-events:\s*none/.test(RULES.filter(r => r.sels.includes(R + '.teleprompter-top')).map(r => r.body).join(';')),
    'A the top bar rides above the full-screen script (z ' + topZ + ' > ' + bodyZ + '): Mark done and Close take the tap; the rest of the bar lets taps through');
  ok(num(eff(R + '.tp-rec-timer', 'z-index')) > topZ && eff(R + '.tp-rec-timer', 'pointer-events') === 'none', 'A the timer is drawn above the bar\'s scrim and never takes a tap');
  ok(/<button class="teleprompter-done" id="tpDoneBtn" onclick="tpMarkDone\(\)"/.test(html) && /<div class="tp-rec-timer" id="tpRecTimer">/.test(html), 'A Mark done and the timer are still there');
}

/* ══ B. the matcher ═════════════════════════════════════════════════════════ */
function fnText(name) {
  const m = new RegExp('(?:^|\\n)function\\s+' + name + '\\s*\\(').exec(html);
  if (!m) throw new Error('function ' + name + '() is not in app.html');
  const at = m.index + (html[m.index] === '\n' ? 1 : 0), eol = html.indexOf('\n', at), first = html.slice(at, eol);
  if (first.includes('{') && (first.match(/{/g) || []).length === (first.match(/}/g) || []).length) return first;
  return html.slice(at, html.indexOf('\n}', at) + 2);
}
const constText = n => { const m = new RegExp('(?:^|\\n)const\\s+' + n + '\\s*=.*').exec(html); if (!m) throw new Error('no const ' + n); return m[0].trim(); };
const M = new Function(`
  let tpVoiceWords = [], tpVoiceCursor = 0, tpVoiceLastAdvanceDone = false;
  ${[constText('TP_LEAP_MARGIN'), constText('TP_STOPWORDS'), fnText('tpNormWord'), fnText('tpNormWords'), fnText('tpWordNear'), fnText('TP_CONTENT_WORD'), fnText('tpVoiceMatch')].join('\n')}
  return {
    load(script) { tpVoiceWords = String(script).split(/\\s+/).filter(Boolean).map(t => ({ key: tpNormWord(t) })).filter(w => w.key); tpVoiceCursor = 0; tpVoiceLastAdvanceDone = false; },
    at(cur, adv) { tpVoiceCursor = cur; tpVoiceLastAdvanceDone = !!adv; },
    hear(h) { const i = tpVoiceMatch(h); if (i > tpVoiceCursor) { tpVoiceCursor = i; tpVoiceLastAdvanceDone = true; } return i; },
    cursor() { return tpVoiceCursor; },
    follow(script, cur, heard, adv) { this.load(script); this.at(cur, adv); return tpVoiceMatch(heard); }
  };`)();

const COFFEE = 'Most people treat coffee like fuel. But the ritual matters more than the caffeine. Think about your first cup. It sets the pace for the whole morning. That is why I keep one cup you never skip.';
const W = COFFEE.split(/\s+/);
const starts = [0]; W.forEach((w, i) => { if (/[.!?]$/.test(w) && i + 1 < W.length) starts.push(i + 1); });
const sentOf = i => starts.filter(s => s <= i).length - 1;
const firstCup = W.indexOf('cup.'), think = W.indexOf('Think'), lastCup = W.lastIndexOf('cup');
let rnd = 7; const rand = () => (rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648;
const patterns = [['whole transcript', 'full'], ['per sentence', 'seg'], ...[1, 2, 3, 4, 5, 6].map(n => ['last ' + n + ' word(s)', n]), ['stale re-delivery', 'stale'], ['dropped words', 'drop']];
for (const [label, p] of patterns) {
  const runs = p === 'drop' ? 60 : 1; let skips = [], ends = [];
  for (let r = 0; r < runs; r++) {
    M.load(COFFEE); let seg = 0, said = [], prev = '';
    for (let i = 0; i < W.length; i++) {
      if (starts.includes(i)) seg = i;
      if (p !== 'drop' || rand() > 0.25) said.push(W[i]);
      const heard = p === 'full' || p === 'drop' ? said.slice(-8).join(' ') : p === 'seg' ? W.slice(seg, i + 1).join(' ') : p === 'stale' ? W.slice(Math.max(0, i - 3), i + 1).join(' ') : W.slice(Math.max(0, i + 1 - p), i + 1).join(' ');
      M.hear(heard);
      if (p === 'stale' && prev) { M.hear(prev); M.hear(W[Math.max(0, i - 1)]); }   // the recogniser repeats itself
      prev = heard;
      const nc = M.cursor();
      if (nc - 1 > i && sentOf(nc - 1) > sentOf(i)) { skips.push('said "' + W[i] + '" (#' + i + ') → jumped to "' + W[nc - 1] + '" (#' + (nc - 1) + ')'); break; }
    }
    ends.push(M.cursor());
  }
  ok(!skips.length, 'B ' + label + ': never skips a sentence on a repeated word' + (skips.length ? ' — ' + skips[0] : ''));
  if (p !== 'drop') ok(ends[0] >= W.length - 1, 'B ' + label + ': still follows to the end (' + ends[0] + '/' + W.length + ')');
}
ok(M.follow(COFFEE, firstCup + 1, 'cup', true) === -1 && M.follow(COFFEE, firstCup + 1, 'about your first cup', true) === -1,
  'B the owner\'s case: just past "your first cup." a re-delivered "cup" stays put (not the "one cup" a sentence down)');
ok(M.follow(COFFEE, firstCup + 1, 'cup it sets the pace', true) === firstCup + 5, 'B …and the next words they really say still move it (' + M.follow(COFFEE, firstCup + 1, 'cup it sets the pace', true) + ')');
{ const S = 'Your first cup. Then the walk. Then one cup you never skip.';
  ok(M.follow(S, 3, 'cup', true) === -1 && M.follow(S, 3, 'your first cup', true) === -1, 'B a repeat INSIDE the near window: an already-said "cup" does not jump to the next "cup"'); }
{ const NATO = 'alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima mike november purple oscar papa quebec romeo sierra tango';
  ok(M.follow(NATO, 0, 'purple', true) === -1, 'B one stray content word 14 words ahead never moves the prompter (nearest first, within ~12 words)');
  ok(M.follow(NATO, 0, 'romeo sierra tango', false) === 21, 'B a real skip — 3 words in a row far ahead — still jumps (' + M.follow(NATO, 0, 'romeo sierra tango', false) + ')');
  ok(M.follow(NATO, 0, 'alpha bravo charlie', false) === 3, 'B reading from the top still moves'); }
ok(M.follow(COFFEE, think, 'one cup you never skip', true) === W.length, 'B on the sample: jumping to "one cup you never skip" (5 words in a row) lands there');
ok(M.follow(COFFEE, think, 'never skip', true) === -1, 'B …but two words far ahead are not enough');

if (fail) { console.log(fail + ' check(s) failed'); process.exit(1); }
console.log('TP FIXES OK');
