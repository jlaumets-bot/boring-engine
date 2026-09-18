#!/usr/bin/env node
// GATE: the brand brain is the product. Nothing may write one brand's into another, nothing may
//       overwrite what the user just typed, and nothing may report a save that did not happen.
//
// WHY THIS EXISTS — five defects, and one of them was a FIX THAT COULD NOT WORK.
//
//   1. saveBrandToDB RETURNED `undefined` ON EVERY PATH, AND A CALLER WAS CHECKING THE RESULT.
//      v680 gave nbSaveAsRule an `if (r && r.ok === false)` branch so a refused save could not
//      be reported as "✓ In Voice Memory". The branch could never run. A fix that is
//      load-bearing on a return value that does not exist is worse than no fix, because it
//      reads as handled — so this gate drives the whole chain and asserts the branch FIRES.
//      Every inner branch already recorded the outcome in window._brandSaveOk, so the fix is a
//      wrapper that reports it; the inner function is untouched, and anything that is not an
//      explicit `true` reports as not-saved.
//
//   2. SWITCHING BRAND WITH SETTINGS OPEN LEFT THE OLD BRAND'S BRAIN ON SCREEN. The brand
//      switcher is in the sticky header, which is OUTSIDE #mainViews — and only #mainViews is
//      hidden when Settings opens — so the dropdown is tappable with the whole panel showing
//      (the Brands list inside the panel is a second route). Nothing re-rendered it, so every
//      textarea still held the PREVIOUS brand's pain points, USPs, product details, voice
//      memory and origin story, reading as the new brand's. Each keeps its live
//      oninput="updateSetting(...)", so ONE character — one autocorrect, one suggestion chip —
//      wrote the old brand's entire field into the new brand's row, permanently and silently.
//
//   3. "MAKE IT BETTER" WAS THE ONE ROUND TRIP IN THE FILE WITH NO BRAND PIN. Every sibling has
//      one. Tap it on brand A, switch brand while it thinks, and brand A's rewrite landed in
//      brand B's field and row. And the textarea stays editable during the call while `val` is
//      captured before it, so anything typed in those seconds was discarded without a word.
//
//   4. A REWRITE CUT OFF AT max_tokens REPLACED THE WHOLE FIELD ANYWAY. callXAI read
//      finish_reason only on the empty-200 path, so a completion that stopped mid-sentence came
//      back as ordinary text — and expand-field replaces the entire field with it, no diff, no
//      undo. Anything past the input cap was never shown to the model either, yet the reply
//      replaced the part it never saw.
//
//   5. THE DISTILLER WAS SHOWN 40 RULES WHILE THE APP ALLOWS 60. Past 40, it stopped being told
//      about the oldest under "do NOT repeat or restate these" and began re-deriving them in
//      different words; the client's only defence is an exact case-insensitive match, which a
//      restatement walks past. The list then fills with near-duplicates and eventually with
//      rules that contradict older ones — all handed to the model under "obey ALL".
//
// HOW IT CHECKS
//   The save chain is EXECUTED through every outcome including an exception, and nbSaveAsRule is
//   then run against a refused save to prove the branch fires. The switchBrand fragment is RUN
//   with Settings open and closed. The rest are derived rules anchored on ORDER — gate before
//   fetch, textarea re-queried after the await — because order is the defect. Arm 5 compares the
//   two caps by READING BOTH, so raising one without the other fails here.
//
// RUN:    node scripts/verify/brand-brain-writes.mjs
// EXPECT: prints "PASS" and exits 0.
import fs from 'node:fs'; import vm from 'node:vm';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(ROOT+'/app.html','utf8');
const llm = fs.readFileSync(ROOT+'/api/_llm.js','utf8');
const ef  = fs.readFileSync(ROOT+'/api/expand-field.js','utf8');
const dv  = fs.readFileSync(ROOT+'/api/distill-voice.js','utf8');
let fail=0; const ok=(c,m)=>{ if(!c){console.log('FAIL:',m);fail++;} else console.log('ok:',m); };
const grab = n => { let i = html.indexOf('\nfunction '+n+'('); if(i<0) i = html.indexOf('\nasync function '+n+'(');
  if(i<0) throw new Error('no '+n);
  const eol = html.indexOf('\n', i+1), first = html.slice(i+1, eol);
  let d=0,seen=false; for(const ch of first){ if(ch==='{'){d++;seen=true;} else if(ch==='}')d--; }
  if(seen && d===0) return first;
  return html.slice(i+1, html.indexOf('\n}', i)+2); };

// ── 1. saveBrandToDB must actually REPORT its outcome ──────────────────────
{
  ok(html.includes('async function _saveBrandToDBInner()'), 'the inner save is untouched and separate');
  const w = grab('saveBrandToDB');
  ok(/return \{ ok:/.test(w), 'saveBrandToDB now returns a result');
  ok(/window\._brandSaveOk = null/.test(w), 'and starts from "unknown" so a previous save cannot be read as this one');
  const c = { console, window: {}, Promise };
  c._saveBrandToDBInner = async () => { c.window._brandSaveOk = c.__next; };
  vm.createContext(c); vm.runInContext(w, c);
  for (const [v, want, label] of [[true, true, 'a real save'], [false, false, 'a refused save'],
                                  [null, false, 'a save that never said'], [undefined, false, 'an untouched flag']]) {
    c.__next = v;
    const r = await vm.runInContext('saveBrandToDB()', c);
    ok(r && r.ok === want, label + ' reports ok=' + (r && r.ok));
  }
  // an exception must report not-saved, not throw
  c._saveBrandToDBInner = async () => { throw new Error('boom'); };
  const r = await vm.runInContext('saveBrandToDB()', c);
  ok(r && r.ok === false, 'an exception reports ok=false rather than escaping');
  // and the queue must not swallow it
  const q = grab('_queueBrandSave');
  ok(/catch\(\(\) => \(\{ ok: false \}\)\)/.test(q) || /catch\(\(\) => \({ ok: false }\)\)/.test(q),
     'the save queue maps a rejection to ok:false instead of undefined');
  // NOW the v680 nbSaveAsRule branch can finally fire
  const f = grab('nbSaveAsRule');
  const run = (result) => {
    const cc = { console, notebookNotes: [{id:1, text:'always name the price'}], settings: { coachNotes: '' },
      showToast: (m)=>cc.toasts.push(m), toasts: [], Promise,
      saveSettings: () => Promise.resolve(result), btn: { textContent:'Save as voice rule', disabled:false } };
    vm.createContext(cc); vm.runInContext(f, cc); vm.runInContext('nbSaveAsRule(1, btn)', cc);
    return new Promise(r2 => setTimeout(()=>r2(cc), 15));
  };
  let cc = await run({ ok: false });
  ok(!cc.btn.disabled && !/In Voice Memory/.test(cc.btn.textContent),
     'a refused save no longer shows "✓ In Voice Memory" — the v680 branch is reachable at last');
}
// ── 2. Settings must be re-rendered on a brand switch ──────────────────────
{
  const sw = grab('switchBrand');
  ok(/settingsOverlay/.test(sw), 'switchBrand looks at whether Settings is open');
  ok(/renderSettingsPanel\(\)/.test(sw), 'and re-renders it');
  const openAt = html.indexOf("overlay.classList.add('open')");
  ok(openAt > -1, 'openSettings really marks the overlay with .open (the class this check reads)');
  // run the branch both ways
  for (const [isOpen, want] of [[true, 1], [false, 0]]) {
    const c = { console, rendered: 0,
      document: { getElementById: (id) => id === 'settingsOverlay'
        ? { classList: { contains: (k) => k === 'open' && isOpen } } : null },
      renderSettingsPanel: () => { c.rendered++; } };
    vm.createContext(c);
    const frag = sw.slice(sw.indexOf('    try {\n      // openSettings()'), sw.indexOf('} catch (e) {}', sw.indexOf('settingsOverlay')) + 14);
    vm.runInContext(frag, c);
    ok(c.rendered === want, 'Settings ' + (isOpen ? 'open' : 'closed') + ' → re-rendered ' + c.rendered + ' time(s)');
  }
}
// ── 3. "Make it better" must be brand-pinned and must not clobber typing ────
{
  const f = grab('spExpandField');
  const gateAt = f.indexOf('brandGate()'), fetchAt = f.indexOf('await fetch');
  ok(gateAt > -1 && gateAt < fetchAt, 'the brand gate is captured BEFORE the fetch');
  ok(/_sameBrand && !_sameBrand\(\)/.test(f), 'and enforced after it');
  ok(/_live\.value\.trim\(\) !== val/.test(f), 'and the field is re-read, so concurrent typing is not overwritten');
  const liveAt = f.indexOf("const _live = document.querySelector"), assignAt = f.indexOf('_live.value = data.expanded');
  ok(liveAt > -1 && liveAt < assignAt, 'the textarea is re-queried after the await, not reused');
  ok(!/\n    ta\.value = data\.expanded;/.test(f), 'the stale-reference assignment is gone');
}
// ── 4. a truncated rewrite must not replace the field ──────────────────────
{
  ok(/wantMeta/.test(llm), 'callLLM has an opt-in meta channel');
  ok(/LAST_TRUNCATED = \(_fr === 'length'\)/.test(llm), 'callXAI records finish_reason=length');
  ok(/wantMeta \? \{ text: text, truncated: LAST_TRUNCATED \} : text/.test(llm),
     'and every existing caller still gets a plain string');
  ok(/wantMeta: true/.test(ef), 'expand-field asks for it');
  ok(/_res && _res\.truncated/.test(ef), 'and refuses a cut-off rewrite');
  ok(/error: 'too_long'/.test(ef), 'with a named reason');
  ok(/max_tokens: 1600/.test(ef), 'and a bigger ceiling than the 800 that caused it');
  ok(/const FIELD_IN_CAP = 6000;/.test(ef), 'the input cap is a named constant');
  ok(/clipped: _wasClipped/.test(ef), 'and the client is told when the field was too long to read whole');
  const cl = grab('spExpandField');
  ok(/data\.clipped/.test(cl), 'which the client surfaces');
  // MUTATION: the old shape really did hand a truncated string straight through
  ok(!/max_tokens: 800/.test(ef), 'MUTATION CHECK: the 800-token ceiling is gone');
}
// ── 5. the distiller must see every rule the app allows ────────────────────
{
  const appCap = Number((html.match(/BRAIN_RULES_SOFT_CAP = (\d+)/) || [])[1]);
  const srvCap = Number((dv.match(/const RULES_MAX = (\d+)/) || [])[1]);
  ok(Number.isFinite(appCap) && Number.isFinite(srvCap), 'both caps are readable (app=' + appCap + ', server=' + srvCap + ')');
  ok(srvCap >= appCap, 'the distiller is shown every rule the app allows (' + srvCap + ' >= ' + appCap + ')');
}
console.log(fail ? '\nFAIL \u2014 ' + fail + ' check(s) failed' : '\nPASS \u2014 a save reports its real outcome, Settings follows the brand, and no rewrite overwrites what the user just typed');
process.exit(fail?1:0);
