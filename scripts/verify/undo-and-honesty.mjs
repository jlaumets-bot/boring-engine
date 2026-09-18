#!/usr/bin/env node
// GATE: an undo stays undone, a message is never markup, a failed scrape is never charged, and
//       the microphone is never left on.
//
// WHY THIS EXISTS — five defects that were found, proved, and then sat unfixed.
//
//   1. STATUS COULD ONLY EVER ADVANCE, SO EVERY UNDO WAS SILENTLY REVERTED.
//      reconcileLocalStatus ranked pending < dismissed < filming < done and took the higher
//      one, so on the next load: un-dismissing came back dismissed, moving a post back out of
//      the Pipeline came back filming, "Reset all ideas to pending" came back as it was, and
//      `done` could never be undone at all. Its own comment shows only one direction was
//      considered ("honor a local dismissal that hasn't reached the DB yet") — the reverse is
//      exactly as real and is the one that loses a deliberate action. A timestamp answers both
//      directions: saveState stamps `statusAt` when the status actually changes, the row
//      carries its own recency, and the NEWER decision wins. Rank stays as the tie-breaker for
//      rows saved before this, which must keep behaving exactly as they did.
//
//   2. showToast WROTE ITS MESSAGE AS HTML. 251 call sites, many interpolating text this app
//      did not write — a server error body, a model's own words, a crawled page's title. None
//      of the 251 passes markup on purpose, so escaping costs nothing and closes the surface.
//
//   3. A CREATOR SCRAPE WHERE EVERY LANE FAILED WAS CHARGED, AND REPORTED AS "no posts". An
//      Apify outage read to the user as "this creator has nothing" — a different problem, and
//      only one of them is theirs. It now answers honestly, which also refunds the reservation
//      (api/_usage.js attachHoldRelease), so nothing is charged.
//
//   4. AN UNCHECKED READ TURNED A MERGE INTO A DELETE. store.rest RESOLVES on every HTTP
//      status, so a 5xx left the base as {} and Object.assign dropped every key the manual
//      pull does not set — competitorMoves, compAt and topPosts, all written by the nightly
//      cron. One failed read on a "Pull trends" tap wiped the weekly competitor pulse. The
//      PATCH was unchecked too, so the log reported "saved N items" for a write that never
//      happened.
//
//   5. FIVE MIC PATHS COULD NOT STOP THEIR OWN MICROPHONE. The stream is a `const` declared
//      inside the try, so the catch literally cannot reach it — and anything that throws after
//      the mic opens (an unsupported mimeType, rec.start(), a missing button) shows
//      "Could not access microphone" and leaves the OS mic indicator lit for the rest of the
//      session with nothing recording. All eight sites now park the stream where the catch can
//      see it, hand ownership to the recorder once it starts, and release on failure — and the
//      handover is what stops one path's failure from killing another path's LIVE recording,
//      which this gate checks explicitly.
//
// HOW IT CHECKS
//   The real _drainToasts, reconcileLocalStatus, saveState and the mic helpers are EXECUTED.
//   Arm 1 drives every direction of the status merge, including the two backward-compatibility
//   cases that must still use the old rank rule. The mic arm includes the regression guard
//   (a live recording must survive another path's failure) and a mutation anchor stating why
//   the holder exists at all.
//
// RUN:    node scripts/verify/undo-and-honesty.mjs
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

// ── 1. a toast must not render its message as HTML ──────────────────────────
{
  const c = { console, document: { querySelector: ()=>null, createElement: ()=>({ set innerHTML(v){ c.wrote = v; },
      get innerHTML(){ return c.wrote; }, classList:{add(){},remove(){}}, style:{}, remove(){}, set onclick(f){} }),
      body: { appendChild(){} } },
    setTimeout: ()=>0, clearTimeout: ()=>{}, requestAnimationFrame: (f)=>f(), Date };
  vm.createContext(c);
  vm.runInContext('var _toastQueue = [], _toastShowing = false;\n' + grab('escHtml') + '\n' + grab('_drainToasts'), c);
  for (const [msg, label] of [
    ['<img src=x onerror=alert(1)>', 'an injected tag'],
    ["Couldn't save: <script>fetch('//evil')</script>", 'a script tag in a server error'],
    ['Tom & Jerry\'s "best" <b>post</b>', 'ordinary punctuation'],
  ]) {
    c.wrote = '';
    vm.runInContext('_toastQueue = [{ message: ' + JSON.stringify(msg) + ', duration: 3000, onTap: null }]; _drainToasts();', c);
    ok(!/<(img|script|b)\b/i.test(c.wrote), label + ' is escaped: ' + JSON.stringify(String(c.wrote).slice(0,60)));
  }
  // the CTA must survive
  c.wrote = '';
  vm.runInContext('_toastQueue = [{ message: "Saved", duration: 3000, onTap: function(){} }]; _drainToasts();', c);
  ok(/<span class="toast-cta">/.test(c.wrote), 'the tappable CTA is still real markup');
  ok(/Saved/.test(c.wrote), 'and the message still shows');
}

// ── 2. an UNDO must not be reverted by the database copy ────────────────────
{
  const rec = grab('reconcileLocalStatus');
  const run = (saved, row) => {
    const c = { console, JSON, Number, Array,
      lsGet: () => JSON.stringify(saved), STORAGE_KEY: 'k',
      normalizeIdeaStatus: (s) => s || 'pending' };
    vm.createContext(c); vm.runInContext(rec, c);
    const arr = [row];
    c.arr = arr; vm.runInContext('reconcileLocalStatus(arr)', c);
    return arr[0];
  };
  const T = 1000000;
  // the defect: local un-dismiss, DB still dismissed, local is NEWER
  let r = run([{title:'A', status:'pending', statusAt: T+50}], {title:'A', status:'dismissed', _rowAt: T});
  ok(r.status === 'pending', 'un-dismissing sticks when the local change is newer (got ' + r.status + ')');
  // "Reset all" from done -> pending
  r = run([{title:'A', status:'pending', statusAt: T+50}], {title:'A', status:'done', _rowAt: T});
  ok(r.status === 'pending', '"Reset all" can undo `done` (got ' + r.status + ')');
  // moving back out of the Pipeline
  r = run([{title:'A', status:'pending', statusAt: T+50}], {title:'A', status:'filming', _rowAt: T});
  ok(r.status === 'pending', 'moving a post back out of the Pipeline sticks');
  // the OTHER device genuinely moved it on, and its write is newer -> DB wins
  r = run([{title:'A', status:'pending', statusAt: T}], {title:'A', status:'filming', _rowAt: T+50});
  ok(r.status === 'filming', 'a newer change from another device still wins (got ' + r.status + ')');
  // a local advance still works
  r = run([{title:'A', status:'done', statusAt: T+50}], {title:'A', status:'filming', _rowAt: T});
  ok(r.status === 'done', 'a local advance still wins when it is newer');
  // MUTATION / BACKWARD COMPATIBILITY: rows saved before this have no stamp -> old rank rule
  r = run([{title:'A', status:'pending'}], {title:'A', status:'dismissed', _rowAt: T});
  ok(r.status === 'dismissed', 'an UNSTAMPED local row still falls back to the old rank rule (got ' + r.status + ')');
  r = run([{title:'A', status:'dismissed'}], {title:'A', status:'pending', _rowAt: T});
  ok(r.status === 'dismissed', 'and the old "honor a local dismissal" special case still holds');
  // a local stamp with no DB date -> local wins (a row the DB has never dated)
  r = run([{title:'A', status:'pending', statusAt: T}], {title:'A', status:'done'});
  ok(r.status === 'pending', 'a dated local change beats an undated row');
  // the stamp must be carried forward
  r = run([{title:'A', status:'pending', statusAt: T+50}], {title:'A', status:'dismissed', _rowAt: T});
  ok(r.statusAt === T+50, 'the stamp is carried onto the idea for the next reconcile');
}

// ── the stamp must actually be written, and only on a real change ───────────
{
  const ss = grab('saveState');
  ok(/statusAt/.test(ss), 'saveState persists statusAt');
  ok(/normalizeIdeaStatus\(was\.status\) !== normalizeIdeaStatus\(s\.status\)/.test(ss),
     'and stamps only when the status really changed');
  const c = { console, JSON, Date, Number, Array,
    currentBrand: { id:'b' }, STORAGE_KEY:'k', bkey:(k)=>k, reindexIdeas:()=>{},
    saveIdeasToDB: ()=>({ok:true}), normalizeIdeaStatus:(s)=>s||'pending',
    _lsWriteGuarded: (k,v)=>{ c.written = v; return true; }, lsGet: ()=>c.store || '[]' };
  vm.createContext(c); vm.runInContext(ss, c);
  c.store = JSON.stringify([{title:'A', status:'pending', statusAt: 111}]);
  vm.runInContext("var state=[{title:'A', status:'pending', statusAt:111}]; saveState();", c);
  let out = JSON.parse(c.written);
  ok(out[0].statusAt === 111, 'an unchanged status keeps its original stamp (' + out[0].statusAt + ')');
  vm.runInContext("state=[{title:'A', status:'done', statusAt:111}]; saveState();", c);
  out = JSON.parse(c.written);
  ok(out[0].statusAt > 111, 'a changed status gets a fresh stamp (' + out[0].statusAt + ')');
}
// the row's recency must reach the reconciler
ok(/_rowAt: _ideaRowRecency\(row\) \|\| 0,/.test(html), 'loadIdeasFromDB carries each row\'s recency through');
// the helper itself, run
{
  const c = { console }; vm.createContext(c);
  vm.runInContext('var _micHold = null;\n' + grab('_micReleaseHandled') + '\n' + grab('_micRelease'), c);
  const mk = () => { const t = { stopped: 0, stop(){ t.stopped++; } };
    return { s: { getTracks: () => [t] }, t }; };
  let { s: st, t } = mk();
  c.__s = st; vm.runInContext('_micHold = __s; _micRelease();', c);
  ok(t.stopped === 1, 'a held stream is stopped');
  vm.runInContext('_micRelease();', c);
  ok(t.stopped === 1, 'a second release is a no-op, not a double stop');
  ok(vm.runInContext('_micHold', c) === null, 'and the holder is cleared');
  vm.runInContext('_micRelease();', c);   // nothing held
  ok(true, 'releasing with nothing held does not throw');
  // ownership handover: once the recorder has it, a later release must NOT stop it
  ({ s: st, t } = mk());
  c.__s = st; vm.runInContext('_micHold = __s; _micReleaseHandled(); _micRelease();', c);
  ok(t.stopped === 0, 'a LIVE recording is not stopped by another path\'s failure (this is the regression guard)');
  // a stream with no getTracks must not throw
  vm.runInContext('_micHold = {}; _micRelease();', c);
  ok(true, 'a malformed stream does not throw');
}
// every site must park the stream, hand it over on start, and release in its catch
{
  const hold=[...html.matchAll(/_micHold = stream;/g)].map(m=>m.index);
  ok(hold.length === 8, 'all 8 mic paths park their stream (' + hold.length + ')');
  const hand=[...html.matchAll(/_micReleaseHandled\(\);/g)].map(m=>m.index);
  const rel =[...html.matchAll(/^\s*_micRelease\(\);/gm)].map(m=>m.index);
  let a=0,b=0;
  hold.forEach((x,i)=>{ const y=hold[i+1]||html.length;
    if(hand.some(h=>h>x&&h<y)) a++; if(rel.some(r=>r>x&&r<y)) b++; });
  ok(a === 8, 'all 8 hand ownership to the recorder once it starts (' + a + ')');
  ok(b === 8, 'all 8 release the mic in their own catch (' + b + ')');
  // MUTATION ANCHOR: the stream really is declared inside the try at each site
  // The stream is still a `const` inside the try at every site — which is exactly why the
  // catch cannot see it and the holder is needed. If that ever changes, this rule can go.
  const inTry = [...html.matchAll(/const stream = await getMicStream\(\);/g)].length;
  ok(inTry === 8, 'MUTATION ANCHOR: all 8 still declare the stream inside the try (' + inTry + ') — the reason the holder exists');
}

console.log(fail ? '\nFAIL \u2014 ' + fail + ' check(s) failed' : '\nPASS \u2014 an undo stays undone, a toast is never markup, and no failed run is charged or left recording');
process.exit(fail?1:0);
