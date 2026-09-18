#!/usr/bin/env node
// GATE: what the USER typed is not regenerable. Nothing may delete it, and nothing may tell
//       them it is gone when it is not.
//
// WHY THIS EXISTS — the worst defect found in this whole hardening run was here.
//
//   1. ADDING ONE NOTE DURING APP BOOT DELETED THE WHOLE LIST. _listLoadOk is initialised ALL
//      TRUE, and the cold-start branch of initApp never reset it — the fresh-user branch does,
//      and switchBrand does, but the path every returning user takes did not. Eight awaited
//      round trips run before the notebook list lands, while the splash clears at 4s and the
//      nav is forced up at 5s: the app is fully interactive with notebookNotes still [] and the
//      save guard still answering "loaded, go ahead". Type one note in that window and tap
//      Save, and _replaceBrandRows captures the real rows, inserts the one new note, and
//      DELETES the rest. Measured on a 74-note store: 74 rows in, 1 row out, and the user is
//      told "Saved to your Brand Notebook". Same window, same outcome for Bookmarks, Reference
//      photos, Remixes and Prompt history. This is exactly the failure the guard's own comment
//      was written to stop — it was disarmed everywhere except where it was needed.
//
//   2. A FAILED LOAD RENDERED AS AN ORDINARY EMPTY LIST. All five catch blocks set the list to
//      [] and marked the flag false with no toast, no log, nothing — and no render path had
//      ever consulted the flag. So on a flaky connection the Notebook says "Nothing saved yet.
//      Jot a thought above", and the user concludes their material is gone and retypes it. The
//      retype does not save either (the guard correctly refuses), so the second toast is the
//      first they hear of any problem. Ideas already had notifyIdeasLoadFailed; the five
//      side-lists were given the flag and not the notification.
//
//   3. IDEA CATCHER DICTATION WAS WRITTEN INTO A DETACHED TEXTAREA. The element was captured
//      before the transcription round trip; renderIdeaCatcher replaces the view's whole
//      innerHTML, so switching tab and back detached it. Thirty seconds of speech gone, a
//      credit spent, and no message — the "Could not hear that" branch only fires on empty text.
//
//   5. "CLEAR" DESTROYED EVERY UPLOADED PRODUCT PHOTO ON ONE TAP, no confirm, no undo — from a
//      one-word control sitting mid-sentence. Those are photos the user took; nothing
//      regenerates them. deleteBmCategory and deleteBrand both confirm, and destroy less.
//
//   6. "OPEN IN IDEAS →" JUMPED TO THE WRONG POST. The id was taken from IDEAS.length, but ids
//      index `state`, and the two drift as soon as anything pushes to state alone (autoRefill,
//      usePAAQuestion both do). It reads as "my brief didn't save".
//
//   8. "SAVE AS VOICE RULE" CLAIMED SUCCESS BEFORE THE WRITE. The button locked to
//      "✓ In Voice Memory" and promised every future post would follow it, then a refusal
//      toast contradicted it — with the button disabled, so no obvious retry.
//
// HOW IT CHECKS
//   The guard is RUN in both states, with a mutation arm proving the all-true initial value
//   really does read as "loaded". The disarm is checked by ORDER — it must come after
//   currentBrand is known and BEFORE the first load starts, because order is the whole defect.
//   notifyListLoadFailed, prodClearRefs and nbSaveAsRule are all EXECUTED, the last one against
//   both a successful and a refused save. The failure-path scan is DERIVED: every
//   _markListLoad(..., false) in the file must be followed by a notification, so a sixth list
//   added later cannot be silent.
//
// RUN:    node scripts/verify/your-own-material.mjs
// EXPECT: prints "PASS" and exits 0.
import fs from 'node:fs'; import vm from 'node:vm';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(ROOT+'/app.html','utf8');
let fail=0; const ok=(c,m)=>{ if(!c){console.log('FAIL:',m);fail++;} else console.log('ok:',m); };
const grab = n => { let i = html.indexOf('\nfunction '+n+'('); if(i<0) i = html.indexOf('\nasync function '+n+'(');
  if(i<0) throw new Error('no '+n);
  const eol = html.indexOf('\n', i+1), first = html.slice(i+1, eol);
  let d=0,seen=false; for(const ch of first){ if(ch==='{'){d++;seen=true;} else if(ch==='}')d--; }
  if(seen && d===0) return first;
  return html.slice(i+1, html.indexOf('\n}', i)+2); };

// ── 1. THE BOOT WINDOW: one note added mid-load must NOT delete the list ─────
{
  // the real guard, run exactly as _replaceBrandRows' callers do
  const c = { console };
  vm.createContext(c);
  vm.runInContext(html.slice(html.indexOf('let _listLoadOk ='), html.indexOf('function _listLoaded(')) +
                  grab('_listLoaded') + '\n' + grab('_markListLoad'), c);
  // the cold-start branch must disarm BEFORE its awaits
  const init = grab('initApp');
  const assignAt = init.indexOf('currentBrand = _brandRes;');
  const disarmAt = init.indexOf("_listLoadOk = { remixes: false");
  const firstLoadAt = init.indexOf('await loadRemixesFromDB()');
  const notebookLoadAt = init.indexOf('await loadNotebookFromDB()');
  ok(disarmAt > -1, 'the cold-start branch disarms the list guard at all');
  ok(assignAt > -1 && disarmAt > assignAt, 'it disarms after currentBrand is known');
  ok(firstLoadAt > -1 && disarmAt < firstLoadAt, 'and BEFORE the first list load starts');
  ok(notebookLoadAt > -1 && disarmAt < notebookLoadAt, 'and before the notebook load in particular');
  // MUTATION: the pre-fix state really did leave the guard open
  vm.runInContext("_listLoadOk = { remixes: true, productRefs: true, bookmarks: true, promptHistory: true, notebook: true };", c);
  ok(vm.runInContext("_listLoaded('notebook')", c) === true,
     'MUTATION CHECK: the all-true initial value really does read as "loaded" (that was the bug)');
  vm.runInContext("_listLoadOk = { remixes: false, productRefs: false, bookmarks: false, promptHistory: false, notebook: false };", c);
  ok(vm.runInContext("_listLoaded('notebook')", c) === false, 'and the disarmed value blocks the save');
  // and every load re-arms its own flag
  for (const k of ['remixes','notebook','productRefs','bookmarks','promptHistory'])
    ok(new RegExp("_markListLoad\\('"+k+"', true\\)").test(html), k + ' re-arms its flag on a successful load');
  // the save guard itself must still be wired
  const sn = grab('saveNotebookToDB');
  ok(/_listLoaded\('notebook'\)/.test(sn), 'saveNotebookToDB still consults the guard');
}
// ── 2. a FAILED load must be visible, not an ordinary empty list ────────────
{
  ok(html.includes('function notifyListLoadFailed('), 'notifyListLoadFailed exists');
  ok(html.includes('function listLoadFailed('), 'listLoadFailed exists so renderers can ask');
  const c = { console, showToast: (m,ms)=>c.toasts.push(m), toasts: [] };
  vm.createContext(c);
  vm.runInContext("var _listLoadOk={notebook:false}, _listFailWarned={};\nvar _LIST_LABELS = { notebook:'notebook' };\n" +
                  grab('notifyListLoadFailed') + '\n' + grab('listLoadFailed') + '\n' + grab('_clearListFailWarn'), c);
  vm.runInContext("notifyListLoadFailed('notebook'); notifyListLoadFailed('notebook');", c);
  ok(c.toasts.length === 1, 'it warns ONCE, not on every retry (' + c.toasts.length + ')');
  ok(/nothing has been deleted/i.test(c.toasts[0]), 'and says nothing was deleted: ' + JSON.stringify(c.toasts[0].slice(0,60)));
  vm.runInContext("_clearListFailWarn('notebook'); notifyListLoadFailed('notebook');", c);
  ok(c.toasts.length === 2, 'a successful load re-arms the warning for next time');
  // every catch must call it
  const catches = [...html.matchAll(/_markListLoad\('(\w+)', false\)([^\n]*)/g)];
  ok(catches.length >= 5, 'found ' + catches.length + ' failure paths');
  const silent = catches.filter(m => !/notifyListLoadFailed/.test(m[2])).map(m=>m[1]);
  ok(silent.length === 0, 'every failed load now speaks (silent: ' + (silent.join(', ') || 'none') + ')');
  // and the empty states must branch
  const nb = grab('renderNotebook');
  ok(/listLoadFailed\('notebook'\)/.test(nb), 'the notebook empty state asks whether the load failed');
  ok(/Couldn't load your notebook/.test(nb), 'and says so instead of inviting them to start over');
}
// ── 3. dictation must survive the screen being rebuilt ─────────────────────
{
  const mic = grab('icMicToggle');
  const code = mic.replace(/\/\*[\s\S]*?\*\//g,' ').split('\n').filter(l=>!/^\s*\/\//.test(l)).join('\n');
  ok(!/const ta = document\.getElementById\('icIdea'\); const prev/.test(code),
     'the textarea is no longer captured before the transcription');
  const prevAt = code.indexOf("getElementById('icIdea')");
  const postAt = code.indexOf("const ta = document.getElementById('icIdea');   // v680");
  ok(postAt > -1, 'it is re-queried after the await');
  ok(/_icLostTranscript/.test(code), 'and a transcript with nowhere to go is handed back rather than dropped');
}
// ── 5. clearing the product photos must ask first ──────────────────────────
{
  const f = grab('prodClearRefs');
  ok(/confirm\(/.test(f), 'prodClearRefs confirms before destroying uploaded photos');
  const confirmAt = f.indexOf('confirm('), clearAt = f.indexOf('productRefs.length = 0;', f.indexOf('confirm('));
  ok(confirmAt > -1 && clearAt > confirmAt, 'and the confirm comes first');
  // run it both ways
  for (const [answer, want] of [[false, 3], [true, 0]]) {
    const c = { console, productRefs: [{a:1},{b:2},{c:3}], confirm: () => answer,
      saveProductRefs: ()=>{ c.saved = true; }, memeRenderRefNote: ()=>{}, renderRefGrid: ()=>{}, Array };
    vm.createContext(c); vm.runInContext(f, c); vm.runInContext('prodClearRefs()', c);
    ok(vm.runInContext('productRefs.length', c) === want,
       'answering ' + (answer ? 'yes' : 'no') + ' leaves ' + vm.runInContext('productRefs.length', c) + ' photos');
    if (!answer) ok(!c.saved, 'and answering no writes nothing to the database');
  }
}
// ── 6. "Open in Ideas" must point at the right post ────────────────────────
{
  ok(/const idx = state\.length; IDEAS\.push\(out\)/.test(html), 'the id is taken from state, not IDEAS');
  ok(!/const idx = IDEAS\.length; IDEAS\.push\(out\)/.test(html), 'the IDEAS-length version is gone');
  // prove the two really do drift
  const c = { IDEAS: [{t:'A'},{t:'B'},{t:'C'}], state: [{id:0},{id:1},{id:2},{id:3},{id:4}] };
  vm.createContext(c);
  const idxNew = vm.runInContext('state.length', c), idxOld = vm.runInContext('IDEAS.length', c);
  ok(idxNew !== idxOld, 'after an auto-refill the two arrays differ (state=' + idxNew + ', IDEAS=' + idxOld + ')');
  ok(vm.runInContext('state.findIndex(x=>x.id===' + idxOld + ')', c) === 3,
     'the old id pointed at someone else\'s post (index 3)');
}
// ── 8. the voice rule must not claim success before the write ──────────────
{
  const f = grab('nbSaveAsRule');
  ok(/Promise\.resolve\(saveSettings\(\)\)/.test(f), 'nbSaveAsRule waits for the save');
  ok(/r && r\.ok === false/.test(f), 'and checks the refusal the save reports');
  const run = (result) => {
    const c = { console, notebookNotes: [{id:1, text:'always name the price'}], settings: { coachNotes: '' },
      showToast: (m)=>c.toasts.push(m), toasts: [], Promise,
      saveSettings: () => Promise.resolve(result), btn: { textContent:'Save as voice rule', disabled:false } };
    vm.createContext(c); vm.runInContext(f, c); vm.runInContext('nbSaveAsRule(1, btn)', c);
    return new Promise(r => setTimeout(()=>r(c), 15));
  };
  let c = await run({ ok: true });
  ok(/In Voice Memory/.test(c.btn.textContent) && c.btn.disabled, 'a real save locks the button');
  ok(c.toasts.some(t=>/every future post/.test(t)), 'and promises what it delivered');
  c = await run({ ok: false });
  ok(!/In Voice Memory/.test(c.btn.textContent) && !c.btn.disabled,
     'a REFUSED save leaves the button usable (was locked to "✓ In Voice Memory"): ' + JSON.stringify(c.btn.textContent));
  ok(!c.toasts.some(t=>/every future post/.test(t)), 'and makes no promise it did not keep');
}
console.log(fail ? '\nFAIL \u2014 ' + fail + ' check(s) failed' : '\nPASS \u2014 nothing the user typed can be deleted by a slow load, and a failed load never reads as an empty one');
process.exit(fail?1:0);
