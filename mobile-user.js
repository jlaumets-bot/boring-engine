// mobile-user.js — an AI QA ENGINEER that tests Content Shrimp end-to-end on mobile.
//
// A language model (your app's own — Anthropic / Groq / OpenAI, auto-detected) drives
// a real iPhone-emulated browser and runs a structured QA pass, feature by feature:
//
//   EXPLORE  → see what's on the screen
//   DESIGN   → decide the realistic user flow that tests this feature
//   EXECUTE  → do it like a user, providing inputs, triggering the action,
//              and WAITING for the app's network calls to finish (real generations
//              complete before it judges them — it does not race ahead)
//   VERIFY   → check the result is correct / non-empty / usable, try a follow-up
//              (approve / redo / copy / save), then give a PASS / FAIL / BLOCKED verdict
//   REPORT   → a QA report with a per-feature result table + captured errors
//
// It covers EVERY feature (Quick Post, Ideas, Pipeline, Remix, Idea Catcher,
// Questions, Notebook, Blog, Viral Lab, Meme/Image, Settings, Brain), not a wander.
//
// Alongside the vision-judged features there is a family of `proof-*` features that judge
// NOTHING by eye: their taps call the app's own functions and MEASURE its own state, and the
// driver's only job is to transcribe the result. Use that pattern for anything the vision
// model cannot settle (counts, filters, layering, "did that markup execute?", "did the camera
// actually get released?"). What this harness deliberately CANNOT reach is written down at the
// bottom of this file under UNTESTABLE FLOWS — read it before assuming something is untested
// by accident.
//
// Every probe here is checked by `node scripts/verify/harness-coverage.mjs`, which extracts
// each taps body, compiles it the way this file compiles it, runs it against the REAL shipped
// functions lifted out of app.html, and mutation-tests both directions.
//
//   • mobile-user-video.webm   ← watch the whole QA pass
//   • mobile-user-trace.zip    ← OFF by default (~700MB/run); enable with QA_TRACE=1 node mobile-user.js
//   • mobile-user-report.md    ← QA report: per-feature PASS/FAIL, expected vs observed, bugs
//
// ── Run (on your Mac) ─────────────────────────────────────────────────────────
//   cd ~/boring-content-engine-deploy && node mobile-user.js
//   ONLY="quick-post,ideas" node mobile-user.js     # test just some features (fast)
//   PER_FEATURE=8 node mobile-user.js               # more actions per feature (default 6)
//   MODEL=claude-haiku-4-5-20251001 node mobile-user.js   # cheaper/faster driver
//
// Needs ONE LLM key in env or ./.env : ANTHROPIC_API_KEY / GROQ_API_KEY / OPENAI_API_KEY / XAI_API_KEY.
// Force a specific one with QA_PROVIDER=xai|grok|groq|openai|anthropic (handy when one is out of credits).
// Reuses the login saved in ./mobile-test-shots/.auth.json (re-prompts if it expired).
// It WILL generate content (that's the test) but is blocked from Publish/Checkout/Buy/Delete/Log out.

const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const APP = process.env.APP_URL || 'https://contentshrimp.com/app.html';
const ORIGIN = (() => { try { return new URL(APP).origin; } catch (e) { return ''; } })();
const OUT = path.join(__dirname, 'mobile-test-shots');
const AUTH = path.join(OUT, '.auth.json');
const DESKTOP = /^(1|true|yes)$/i.test(process.env.DESKTOP || '');   // DESKTOP=1 → 1440px desktop viewport (else iPhone 390px)
const REPORT = path.join(__dirname, DESKTOP ? 'desktop-user-report.md' : 'mobile-user-report.md');
const TRACE = path.join(__dirname, 'mobile-user-trace.zip');
const VIDEO = path.join(__dirname, 'mobile-user-video.webm');
const PER_FEATURE = parseInt(process.env.PER_FEATURE || '8', 10);   // max actions to test one feature
const FLOW_BUDGET = parseInt(process.env.FLOW_BUDGET || '14', 10);  // flow-* features span 3 screens + 2 generations — they need more actions
const CI = process.argv.includes('--ci') || process.env.SCHEDULED === '1';   // unattended (cron) mode: headless, no login prompt
fs.mkdirSync(OUT, { recursive: true });

// every feature + how to reach it (real taps) + what a QA engineer should verify
let DRIVER_DEAD = null;        // set when the QA driver's own LLM dies — invalidates the run
const PREFLIGHT = [];          // infrastructure checks — a red one invalidates the whole run
let CONTENT_REPORT = null;     // deterministic measurements + the verbatim scripts from content-quality
let LIVE_VERSION = 'unknown';   // the APP_VERSION actually served by the live site this run
let USAGE_BEFORE = null;        // /api/usage at the start — the run's own generations are the probe
const ALL_FEATURES = [
  { id: 'quick-post',   taps: ["switchView('today')"],                     test: 'v442 SHAZAM-STYLE HOME: the screen is a single BIG circular lavender button with the shrimp mascot inside, caption \"Today\u2019s post, one tap\". Tap the BIG CIRCLE to generate (witty lines cycle under it, 15-40s). Verify a real post card appears BELOW the circle with Approve/Sharpen/Try Another and a \"Redo as\" format chip row. Also tap \"or pick the angle myself\" once — a bottom sheet with format chips + Face-on/Faceless toggle should open (close it after). FAIL only if the circle is missing or no post appears.' },
  { id: 'ideas',        taps: ["switchView('ideas')"], test: `v455 QUICK LANE + STATUS FILTER: the screen leads with a white "Plan my week" card (sub "Seven days of posts in your voice") with a big "Plan my week" button and an "or tweak the plan" link. Tap "or tweak the plan" once — the classic module (idea count select, Face-on/Faceless toggle, "Generate Ideas" button) should unfold below the card; tap the link again to fold it back. Then tap the big "Plan my week" button — it should generate a batch of new idea cards (15-60s, witty lines cycle on the button). ALSO (v458): the four stat boxes (Total, Pending, Approved, Dismissed) are FOLDED INSIDE the "Filters" collapsible now — tap the "Filters" header row to unfold it, then tap each stat box and confirm the tapped box highlights (lavender fill) AND the list filters to that status. Dismiss one idea. FAIL if the quick card is missing, tapping it generates nothing, the fold link does nothing, the stat boxes are missing after unfolding Filters, or a stat box does not filter.` },
  // THIS RUNS ON EVERY RUN (critical path) AGAINST A REAL BRAND, so it must leave no trace.
  // It used to grab the first idea of ANY status — including a DONE post — rewrite it to 'pending'
  // and approve it, with nothing putting it back: every run silently mangled one real post. Now it
  // only ever touches a genuinely PENDING idea, remembers its status, and `restore` puts it back.
  // With nothing safe to use it SKIPS (window._qaSkipFeature) instead of inventing a victim.
  { id: 'approve-jump',
    taps: ["switchView('ideas')", "try{document.querySelectorAll('.dp-backdrop').forEach(function(x){x.remove();});}catch(e){} var i=(typeof state!=='undefined'&&Array.isArray(state))?state.find(function(x){return x&&x.status==='pending';}):null; if(typeof state==='undefined'||!Array.isArray(state)){ window._qaSkipFeature='the app state array is not available'; } else if(!i){ window._qaSkipFeature='no PENDING idea exists on this brand — refusing to rewrite a real approved/done post just to have something to approve'; } else if(typeof quickApprove!=='function'){ window._qaSkipFeature='quickApprove is not defined'; } else { window._qaApproveJump={ id:i.id, prev:i.status }; quickApprove(i.id); if(typeof cancelApprovePopup==='function') cancelApprovePopup(); }"],
    restore: "try{ var s=window._qaApproveJump; if(s && typeof state!=='undefined' && Array.isArray(state)){ var it=state.find(function(x){return x && x.id===s.id;}); if(it && it.status!==s.prev){ it.status=s.prev; if(typeof saveState==='function') saveState(); if(typeof refreshCurrentView==='function') refreshCurrentView(); } } }catch(e){} try{ delete window._qaApproveJump; }catch(e){}",
    test: `NEW approve -> Pipeline jump (v356). The taps approve a PENDING idea and immediately close the learning popup, so the Pipeline-confirmation toast should already be on screen: a tappable toast reading approximately "added to your Pipeline — tap to see it". Verify that toast is visible. FAIL if no such toast appears. (The harness puts the idea back to pending afterwards, so do not be surprised if it reappears in Pending.)` },
  { id: 'batch-approve', taps: ["switchView('ideas')", "if(typeof setIdeaStatus==='function')setIdeaStatus('pending');"], test: `NEW batch-approve for volume. On the Ideas list with the Pending filter there should be a small underline link "approve several at once" (v457 demoted the old full-width button to a quiet link; it only shows when 2+ pending ideas exist — if there are fewer than 2, FIRST generate a batch of ideas, then continue). Tap it to enter select mode: each pending card shows a round checkbox and a sticky bar appears with Cancel, Select all, and "Approve N". Tick 2 cards (the button count should update to "Approve 2" and the cards get a lavender ring), then tap Approve. Verify: a SINGLE toast appears ("2 added to your Pipeline — tap to see them"), the two ideas leave the Pending list, and NO per-card 'what made this land?' popup appears (bulk approve deliberately skips it). FAIL if the select button is missing, ticking does nothing, Approve does not move them, or a per-card popup appears.` },
  { id: 'guardrail',     taps: ["switchView('ideas')", "try{document.querySelectorAll('.dp-backdrop').forEach(function(x){x.remove();});}catch(e){} if(!window._qaOrigBare)window._qaOrigBare=window.brandBrainBare; window.brandBrainBare=function(){return true;}; try{lsSet('brain_guard_dismissed','0');}catch(e){} if(typeof firstRunBrandGuard==='function') firstRunBrandGuard(function(){});"], test: `NEW first-run brand-voice guardrail. The taps force the empty-brand condition, so a nudge modal should already be open. Verify a centered modal titled "First, teach it your brand" is shown, with body text warning that an empty brand brain writes like generic AI, and TWO buttons: "Generate anyway" and a lavender primary "Set up my brand brain". Tapping "Set up my brand brain" should open the Brand Voice / brain settings. FAIL if no such modal appears. (This modal normally only fires for genuinely empty brands, so it is forced here for testing.)` },
  // LAST TEST ON PURPOSE — and `runLast: true` is what actually makes that true. It sits 6th in this
  // array and the critical-path re-sort below is STABLE, so it used to run 8th of ~30: it INSERTs and
  // DELETEs a real `brands` row in the live account and pushes into the in-memory brand list, and
  // `brand-switch` (which enumerates brands and asserts no cross-brand bleed) ran ~20 features later.
  // A half-failed delete therefore left a "QA TEMP BRAND" in the dropdown for the rest of the run,
  // to be reported as an app bug. Ranked last, its blast radius is the end of the run only.
  { id: 'proof-brand-delete', runLast: true, taps: ["toggleSettings()", `
    /* no top-level await — the harness runs taps inside a plain (non-async) function */
    window._qaProof = { brandDelete: 'running…' };
    (async function(){
      var out = {};
      var NAME = 'QA TEMP BRAND ' + Date.now().toString().slice(-5);
      try {
        if (typeof sb==='undefined' || typeof deleteBrand!=='function') { window._qaProof={ brandDelete:'sb/deleteBrand missing' }; return; }
        var u = (await sb.auth.getUser()).data.user;
        if (!u) { window._qaProof={ brandDelete:'not signed in' }; return; }
        // create a throwaway brand row directly (does not disturb the brand you are using)
        var ins = await sb.from('brands').insert({ user_id: u.id, brand_name: NAME }).select().single();
        if (ins.error || !ins.data) { window._qaProof={ brandCreate:'BROKEN ('+(ins.error&&ins.error.message)+')' }; return; }
        out.brandCreate = 'WORKS (created "'+NAME+'")';
        var id = ins.data.id;
        try { if (Array.isArray(allBrands)) allBrands.push(ins.data); } catch(e){}
        // SAFETY: only ever delete the throwaway we just made
        var row = await sb.from('brands').select('brand_name').eq('id', id).single();
        if (!row.data || String(row.data.brand_name).indexOf('QA TEMP BRAND') !== 0) { out.brandDelete='ABORTED — safety check failed, refused to delete'; window._qaProof=out; return; }
        await deleteBrand(id, NAME);
        var check = await sb.from('brands').select('id').eq('id', id);
        var gone = !check.data || check.data.length === 0;
        out.brandDelete = gone ? 'WORKS (brand row removed)' : 'BROKEN (brand still in the database)';
        // the brand you were using must be untouched
        out.activeBrandIntact = (typeof currentBrand!=='undefined' && currentBrand && currentBrand.id!==id) ? 'yes' : 'CHECK — active brand changed';
      } catch(e){ out.brandDelete='ERROR '+e.message; }
      window._qaProof = out;
    })();
  `], test: `PROOF RUN #3 — brand delete. The taps created a throwaway brand named "QA TEMP BRAND …", deleted it with the app's real deleteBrand function, then checked the database row is gone. It has a safety check so it can only ever delete that throwaway. Read facts.PROOF and report the key:value pairs VERBATIM: brandCreate, brandDelete, activeBrandIntact. status=pass only if brandDelete says WORKS and activeBrandIntact says yes. If facts.PROOF is missing, say so plainly — do not guess. Do NOT delete anything yourself by clicking.` },
  // PROOF TEST #2 — the small "add / save / delete" flows nobody was testing. This is the exact bug
  // class Jörgen hit by hand (added a bookmark, it never appeared in the Remix Borrow strip).
  { id: 'proof-data', taps: ["switchView('create')", `
    window._qaProof = (function(){
      var out = { __ran: 'started' };
      window._qaProof = out;   // publish NOW so a later throw can't discard earlier results
      // 1. BOOKMARK a creator by pasting a profile link — must save a LINK and appear in the strip
      try {
        if (typeof addBmEntry!=='function' || typeof bookmarkCategories==='undefined') out.bookmarkAdd='functions/state missing';
        else {
          if (!bookmarkCategories.length && typeof addBmCategory==='function') {
            var ci=document.getElementById('bmNewCatName'); if(ci){ ci.value='QA'; addBmCategory(); }
          }
          var cat = bookmarkCategories[0];
          if (!cat) out.bookmarkAdd='no category to add into';
          else {
            var before = (cat.entries||[]).length;
            var inp = document.getElementById('bmNewEntry_'+cat.id);
            if (!inp) { openBookmarks(); inp = document.getElementById('bmNewEntry_'+cat.id); }
            if (!inp) out.bookmarkAdd='entry input not rendered';
            else {
              inp.value='https://www.tiktok.com/@qa_probe_user';
              addBmEntry(cat.id);
              var ent=(bookmarkCategories[0].entries||[]).slice(-1)[0];
              var hasLink = !!(ent && ent.links && Object.keys(ent.links).length);
              var added=(bookmarkCategories[0].entries||[]).length===before+1;
              // does it actually reach the Remix "Borrow from" strip?
              try{ renderRemixBorrowStrip(); }catch(e){}
              var chip = Array.prototype.slice.call(document.querySelectorAll('.borrow-chip'))
                          .some(function(b){ return /qa_probe_user/i.test(b.textContent||''); });
              out.bookmarkAdd = (added?'added ':'NOT added ') + (hasLink?'/ link SAVED ':'/ NO LINK (BROKEN) ')
                              + (chip?'/ shows in Borrow strip':'/ MISSING from Borrow strip (BROKEN)');
              // clean up the probe entry
              if (added && typeof deleteBmEntry==='function') { deleteBmEntry(cat.id, ent.id);
                var gone=!(bookmarkCategories[0].entries||[]).some(function(e){return e.id===ent.id;});
                out.bookmarkDelete = gone ? 'WORKS (probe removed)' : 'BROKEN (probe still there)';
                try{ renderRemixBorrowStrip(); }catch(e){}
              }
            }
          }
        }
      } catch(e){ out.bookmarkAdd='ERROR '+e.message; }
      // 2. NOTEBOOK save + delete — does a typed note persist and then delete cleanly?
      // IDENTIFY THE PROBE BY ITS OWN ID, never by position. This used to delete notebookNotes[0] on
      // the ASSUMPTION the probe landed at index 0 (true only because nbSaveNote unshifts), and then
      // assert on array LENGTH — so if the app ever appends instead, it would delete the user's real
      // first note, leave the probe behind, and still report 'WORKS'. Both halves are now id-based.
      try {
        if (typeof nbSaveNote!=='function' || typeof notebookNotes==='undefined') out.notebookSave='functions/state missing';
        else {
          switchView('notebook');
          var ni=document.getElementById('nbInput');
          if(!ni) out.notebookSave='composer not rendered';
          else {
            var ids0={}; notebookNotes.forEach(function(n){ if(n&&n.id!=null) ids0[n.id]=1; });
            var n0=notebookNotes.length;
            ni.value='QA probe note — safe to delete.';
            nbSaveNote();
            var probe=null; for(var pi=0; pi<notebookNotes.length; pi++){ var pn=notebookNotes[pi]; if(pn && pn.id!=null && !ids0[pn.id]){ probe=pn; break; } }
            var saved=!!probe && notebookNotes.length===n0+1;
            var cleared=(document.getElementById('nbInput')||{}).value==='';
            out.notebookSave=(saved?'saved (probe id '+probe.id+') ':'NOT saved (BROKEN) ')+(cleared?'/ composer cleared':'/ composer NOT cleared (BROKEN)');
            function _probeGone(){ return !notebookNotes.some(function(n){ return n && n.id===probe.id; }); }
            if(saved && typeof nbDelete==='function'){ nbDelete(probe.id);
              out.notebookDelete = _probeGone()
                ? (notebookNotes.length===n0 ? 'WORKS (probe removed)' : 'BROKEN (probe gone but the list length is '+notebookNotes.length+', expected '+n0+' — something else was removed too)')
                : 'BROKEN (probe note still there)'; }
            else if(saved){ notebookNotes=notebookNotes.filter(function(n){ return !(n && n.id===probe.id); }); try{ saveNotebookToDB(); }catch(e){} out.notebookDelete='nbDelete missing — probe removed manually'; }
          }
        }
      } catch(e){ out.notebookSave='ERROR '+e.message; }
      // 5. REGRESSION GUARDS (v601) — these handlers used to do incidental work (stopPropagation,
      // exit animations) BEFORE the real action, so a missing/detached event threw and the action
      // silently never happened. Call them with NO event at all — the exact failing case — and the
      // real work must still complete.
      try {
        if (typeof removeBrandLogo!=='function' || typeof settings==='undefined') out.guardLogoRemove='function/state missing';
        else {
          var origLogo = settings.brandLogo;
          settings.brandLogo = 'data:image/png;base64,QA_PROBE';
          removeBrandLogo();                       // no event — used to throw before clearing
          out.guardLogoRemove = (settings.brandLogo === '') ? 'WORKS with no event' : 'BROKEN — logo not cleared (still set)';
          settings.brandLogo = origLogo; try { saveSettings(); } catch(e){}
        }
      } catch(e){ out.guardLogoRemove = 'THREW (guard failed): '+e.message; }
      try {
        var fq = state.find(function(i){ return i && i.status==='filming'; });
        if (typeof fqDone!=='function') out.guardFqDone='function missing';
        else if (!fq) out.guardFqDone='no filming idea to test';
        else {
          var fd0 = state.filter(function(i){return i && i.status==='done';}).length;
          fqDone(undefined, fq.id);                // no event — used to throw on stopPropagation
          setTimeout(function(){
            try {
              var fd1 = state.filter(function(i){return i && i.status==='done';}).length;
              window._qaProof.guardFqDone = (fd1 === fd0 + 1) ? 'WORKS with no event' : 'BROKEN — done stayed '+fd0;
              if (fd1 === fd0 + 1) { try { moveStage(fq.id,'filming'); } catch(e){} }
            } catch(e){ try { window._qaProof.guardFqDone='ERROR '+e.message; } catch(_){} }
          }, 700);
          out.guardFqDone = 'called, waiting for the deferred move...';
        }
      } catch(e){ out.guardFqDone = 'THREW (guard failed): '+e.message; }
      return out;
    })();
    try{ switchView('create'); }catch(e){}
  `], test: `PROOF RUN #2 — the taps already ran real add/save/delete checks by calling the app's own functions. Do NOT redo them by clicking. Read facts.PROOF and report every key:value pair VERBATIM in your "observed" field. Keys: bookmarkAdd, bookmarkDelete, notebookSave, notebookDelete, guardLogoRemove, guardFqDone. The two guard* keys call handlers with NO event on purpose (a v601 regression check) — they must say "WORKS with no event"; anything saying THREW or BROKEN is a real regression. bookmarkAdd is the important one — it pastes a TikTok profile link as a new bookmarked creator and checks three things: the entry was added, a LINK was saved on it, and it actually appears as a chip in the Remix "Borrow from" strip. status=pass only if nothing says BROKEN or "NOT". Put every BROKEN item in bugs. If facts.PROOF is missing, say so plainly — do not guess.` },
  // PROOF TEST — no clicking, no vision. Calls the real functions and measures the real state, so
  // "did Mark Done work?" becomes a fact instead of the driver's guess. Answers the 5 items that
  // repeatedly came back unverifiable (mark-done, batch approve, More sheet, settings toast, tour).
  { id: 'proof-actions', taps: ["switchView('pipeline')", `
    window._qaProof = (function(){
      var out = { __ran: 'started' };
      window._qaProof = out;   // publish NOW so a later throw can't discard earlier results
      function n(st){ try { return state.filter(function(i){return i && i.status===st;}).length; } catch(e){ return -1; } }
      // 1. MARK DONE — call moveStage on a real filming idea and see if done/filming actually move
      try {
        var f = state.find(function(i){ return i && i.status==='filming'; });
        if (!f) out.markDone = 'no filming idea to test';
        else { var d0=n('done'), f0=n('filming'); moveStage(f.id,'done');
               var d1=n('done'), f1=n('filming');
               out.markDone = (d1===d0+1 && f1===f0-1) ? 'WORKS ('+d0+'->'+d1+' done)' : 'BROKEN (done '+d0+'->'+d1+', filming '+f0+'->'+f1+')';
               if (d1===d0+1) moveStage(f.id,'filming'); }
      } catch(e){ out.markDone = 'ERROR '+e.message; }
      // 1b. MARK DONE *VIA THE REAL BUTTON* — the UI tests say tapping it does nothing while the
      // direct function call above works. The button calls pipeAdvance(), which defers moveStage by
      // ~200ms, so the result is filled in asynchronously; the driver reads it on its next turn.
      try {
        var btn = null, cards = document.querySelectorAll('.pipeline-card');
        for (var c = 0; c < cards.length && !btn; c++) {
          var bs = cards[c].querySelectorAll('button');
          for (var k = 0; k < bs.length; k++) {
            if (/mark done/i.test(bs[k].textContent || '')) { btn = bs[k]; break; }
          }
        }
        if (!btn) out.markDoneButton = 'no Mark Done button rendered on any pipeline card';
        else {
          var bd0 = n('done');
          var oc = btn.getAttribute('onclick') || '';
          var mm = oc.match(/pipeAdvance\\s*\\(\\s*event\\s*,\\s*(\\d+)/);   // \\ doubled: this lives in a template literal
          var bid = mm ? mm[1] : null;
          var r = btn.getBoundingClientRect();
          var topEl = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
          var covered = (topEl && topEl !== btn && !btn.contains(topEl) && !topEl.contains(btn))
            ? (topEl.className && typeof topEl.className === 'string' ? '.' + topEl.className.trim().split(/\\s+/).join('.') : topEl.tagName)
            : '';
          out.markDoneButton = 'clicked, waiting for the deferred move...';
          btn.click();
          setTimeout(function(){
            try {
              var bd1 = n('done');
              window._qaProof.markDoneButton = (bd1 === bd0 + 1)
                ? 'WORKS via real button click ('+bd0+'->'+bd1+' done)'
                : 'BROKEN via button (done stayed '+bd0+')' + (covered ? ' — COVERED BY ' + covered : ' — nothing covering it, so pipeAdvance/moveStage never ran');
              if (bd1 === bd0 + 1 && bid != null) { try { moveStage(Number(bid), 'filming'); } catch(e){} }
            } catch(e){ try { window._qaProof.markDoneButton = 'ERROR '+e.message; } catch(_){} }
          }, 700);
        }
      } catch(e){ out.markDoneButton = 'ERROR '+e.message; }
      // 2. BATCH APPROVE — pick 2 pending, run the real batch function, see if pending drops by 2
      try {
        var p = state.filter(function(i){ return i && i.status==='pending'; }).slice(0,2);
        if (p.length<2 || typeof toggleIdeaSelectMode!=='function' || typeof batchApprove!=='function') out.batchApprove = 'cannot test (need 2 pending + the functions)';
        else { var p0=n('pending'); toggleIdeaSelectMode(); p.forEach(function(i){ toggleIdeaPick(i.id); }); batchApprove();
               var p1=n('pending');
               out.batchApprove = (p1===p0-2) ? 'WORKS ('+p0+'->'+p1+' pending)' : 'BROKEN (pending '+p0+'->'+p1+', expected '+(p0-2)+')';
               p.forEach(function(i){ try{ state[i.id].status='pending'; }catch(e){} }); try{ saveState(); }catch(e){} }
      } catch(e){ out.batchApprove = 'ERROR '+e.message; }
      // 3. MORE SHEET — does calling it actually put an open sheet in the DOM?
      try {
        toggleMoreSheet();
        var ms = document.querySelector('.more-sheet, #moreSheet, .more-backdrop');
        out.moreSheet = ms ? 'WORKS (sheet present)' : 'BROKEN (no sheet element after toggleMoreSheet)';
        try{ closeMoreSheet(); }catch(e){}
      } catch(e){ out.moreSheet = 'ERROR '+e.message; }
      // 4. SETTINGS SAVE — call the real handler and check the value persisted + a toast appeared
      try {
        var k = Object.keys(settings.platforms||{})[0];
        if (!k) out.settingsSave = 'no platform to test';
        else { var was = settings.platforms[k]; var want = (was===3?2:3);
               updatePlatform(k, want);
               var saved = settings.platforms[k]===want;
               var toast = !!document.querySelector('.toast, #toast, [class*="toast"]');
               out.settingsSave = (saved?'value SAVED':'value NOT saved') + ' / ' + (toast?'toast SHOWN':'no toast element found');
               updatePlatform(k, was); }
      } catch(e){ out.settingsSave = 'ERROR '+e.message; }
      // 5. TOUR — does startTour put a visible tour overlay on screen?
      try {
        if (typeof startTour!=='function') out.tour = 'startTour is not defined';
        else { startTour();
               var t = document.querySelector('.tour-overlay, #tourOverlay, [class*="tour"]');
               var vis = t && getComputedStyle(t).display!=='none' && getComputedStyle(t).visibility!=='hidden';
               out.tour = vis ? 'WORKS (overlay visible)' : (t ? 'BROKEN (overlay exists but hidden)' : 'BROKEN (no overlay element)');
               try{ endTour(); }catch(e){} }
      } catch(e){ out.tour = 'ERROR '+e.message; }
      return out;
    })();
    try{ switchView('pipeline'); }catch(e){}
  `], test: `PROOF RUN — the taps ALREADY executed five real checks by calling the app's own functions and measuring its own state. Do NOT re-test them by clicking. Your ONLY job: read the results object and report it verbatim. Get it by scrolling/looking at the screen ONLY if needed — otherwise just report what you can. The results are in the screen JSON you already receive, under facts.PROOF, with keys: markDone, batchApprove, moreSheet, settingsSave, tour, markDoneButton. markDoneButton is the important one — it clicks the REAL rendered "Mark Done" button (not the function) and says either WORKS, or BROKEN naming the element covering it, or BROKEN because the handler never fired. Report it verbatim. Each value says WORKS or BROKEN with the actual before→after numbers. In your verdict's "observed" field, list ALL FIVE key:value pairs exactly as they read. Set status=pass if every value says WORKS/SAVED, else status=fail and put each BROKEN one in bugs. facts.PROOF now always contains __ran:'started' once the block begins, and each key is published as it is produced — so if __ran is present but a later key is MISSING, the probe block died at that point: report exactly which keys are present and which are missing, and set status=fail. If facts.PROOF is absent entirely, say so plainly — do not guess, and never report another feature's keys as if they were this one's.` },
  // ── v613 FILMING TEARDOWN ────────────────────────────────────────────────────────────────
  // DOM-MEASURED, not vision-judged, and it has to be: this harness runs headless Chromium with
  // no camera at all, so `getUserMedia` rejects and there is literally nothing to look at. What
  // IS observable is the thing that actually matters — whether committing a take ENDS the media
  // tracks and stops the blur pump. A canvas.captureStream() gives a real MediaStream with a real
  // track whose readyState we own, so the shipped tpEndTake() can be run against it for real.
  // Budget 3: zero interaction needed, the driver only transcribes facts.PROOF; 3 leaves room for
  // one retry without paying for a fourth turn.
  { id: 'proof-filming-teardown', budget: 3, taps: ["switchView('today')", `
    var out = { __ran: 'started' }; window._qaProof = out;
    try {
      if (typeof tpEndTake !== 'function') { out.tpEndTake = 'BROKEN — tpEndTake is not defined in the shipped build'; }
      else {
        out.tpEndTake = 'present';
        /* (A) WIRING, read off the LIVE shipped function rather than a local file — what the
           browser actually loaded is the only thing that matters. Keep it must end the take;
           Retake must NOT, because a retake still needs the camera. */
        try {
          var rv = (typeof tpReview === 'function') ? tpReview.toString() : '';
          var kAt = rv.indexOf("getElementById('tpRvKeep').onclick");
          var aAt = rv.indexOf("getElementById('tpRvAgain').onclick");
          if (!rv) { out.keepEndsTake = 'tpReview is not defined'; }
          else if (kAt < 0 || aAt < 0 || aAt < kAt) { out.keepEndsTake = 'CANNOT TELL — the Keep/Retake handlers were not found in tpReview (it was refactored); re-anchor this probe rather than trusting it'; }
          else {
            var keepHalf = rv.slice(kAt, aAt);
            var retakeHalf = rv.slice(aAt);
            out.keepEndsTake = (keepHalf.indexOf('tpEndTake') > -1)
              ? 'WORKS — the Keep-it handler calls tpEndTake()'
              : 'BROKEN — Keep it does NOT end the take, so the segmentation pump and camera survive the whole render';
            out.retakeKeepsCamera = (retakeHalf.indexOf('tpEndTake') === -1)
              ? 'WORKS — Retake deliberately does NOT end the take (it still needs the camera)'
              : 'BROKEN — Retake ends the take, so re-recording would have no camera';
          }
        } catch(e) { out.keepEndsTake = 'ERROR ' + e.message; }
        /* (B) RUNTIME: give tpEndTake a stream we fully control and see if it really releases it. */
        var cv = document.createElement('canvas'); cv.width = 8; cv.height = 8;
        var fake = (typeof cv.captureStream === 'function') ? cv.captureStream(0) : null;
        if (!fake) { out.tracksReleased = 'canvas.captureStream is unavailable in this browser — could not test the release'; }
        else runtime: {
          var vt = fake.getVideoTracks()[0];
          var prevCam = (typeof tpCameraStream !== 'undefined') ? tpCameraStream : null;
          var stopCalls = 0;
          var origStop = (typeof tpBlur !== 'undefined' && tpBlur) ? tpBlur.stop : null;
          if (typeof origStop === 'function') {
            window._qaOrigBlurStop = origStop;   /* clearLeftoverModals restores this even if we throw */
            tpBlur.stop = function(){ stopCalls++; return origStop.apply(tpBlur, arguments); };
          }
          tpCameraStream = fake;
          /* READ IT BACK. If the probe stream did not actually land in the app's own binding then
             tpEndTake would be tearing down nothing and we would report a FALSE "BROKEN". A check
             that cannot be installed must say "I could not test this", never accuse the app. */
          if (tpCameraStream !== fake) {
            out.tracksReleased = 'CANNOT TEST — the probe stream could not be installed into the app tpCameraStream binding, so a BROKEN result here would be meaningless';
            if (typeof origStop === 'function') { tpBlur.stop = origStop; try { delete window._qaOrigBlurStop; } catch(e){} }
            try { fake.getTracks().forEach(function(t){ t.stop(); }); } catch(e){}
            break runtime;   /* a labelled break, NOT return — the harness compiles this body as a
                                function and a bare return would also skip everything after it */
          }
          var feed = document.getElementById('tpCameraFeed');
          var hadSrc = false;
          try { if (feed) { feed.srcObject = fake; hadSrc = !!feed.srcObject; } } catch(e){}
          var ov = document.getElementById('teleprompterOverlay');
          var hadCamOn = ov ? ov.classList.contains('cam-on') : false;
          if (ov) ov.classList.add('cam-on');
          var before = vt ? vt.readyState : 'no-track';
          tpEndTake();
          var after = vt ? vt.readyState : 'no-track';
          out.tracksReleased = (before === 'live' && after === 'ended')
            ? 'WORKS — the camera track went live -> ended the moment the take was committed'
            : 'BROKEN — track readyState ' + before + ' -> ' + after + ' (expected live -> ended); the camera and mic stay lit through review, render and share';
          out.cameraHandleCleared = (typeof tpCameraStream === 'undefined' || tpCameraStream === null)
            ? 'WORKS — tpCameraStream nulled' : 'BROKEN — the app still holds a camera stream';
          out.blurPumpStopped = (typeof origStop === 'function')
            ? (stopCalls === 1 ? 'WORKS — tpBlur.stop() called exactly once (MediaPipe pump + blur pyramid off)' : 'BROKEN — tpBlur.stop() called ' + stopCalls + ' time(s), expected 1')
            : 'tpBlur.stop is not a function — cannot tell whether the segmentation pump stops';
          out.feedDetached = (!feed) ? 'no #tpCameraFeed element'
            : (feed.srcObject ? 'BROKEN — the video element still holds the stream'
              : (hadSrc ? 'WORKS — video srcObject cleared' : 'WORKS (headless never accepted the srcObject, nothing left attached)'));
          out.camOnCleared = (!ov) ? 'no #teleprompterOverlay'
            : (ov.classList.contains('cam-on') ? 'BROKEN — the cam-on class is still set' : 'WORKS — cam-on removed');
          /* NEGATIVE CONTROL — a stream nobody ended must still read "live", otherwise the
             readyState assertion above is incapable of failing and proves nothing. */
          try {
            var cv2 = document.createElement('canvas'); cv2.width = 8; cv2.height = 8;
            var ctrl = cv2.captureStream(0); var ct = ctrl.getVideoTracks()[0];
            out.controlUntouchedStreamStaysLive = (ct && ct.readyState === 'live')
              ? 'ok — an un-ended track still reads live, so the release check above CAN fail'
              : 'CHECK WORTHLESS — a brand-new track already reads ' + (ct && ct.readyState) + ', so "ended" proves nothing';
            ctrl.getTracks().forEach(function(t){ t.stop(); });
          } catch(e) { out.controlUntouchedStreamStaysLive = 'control ERROR ' + e.message; }
          /* RESTORE — put every borrowed handle back exactly as it was. */
          try { fake.getTracks().forEach(function(t){ t.stop(); }); } catch(e){}
          if (typeof origStop === 'function') { tpBlur.stop = origStop; try { delete window._qaOrigBlurStop; } catch(e){} }
          tpCameraStream = prevCam;
          if (ov && !hadCamOn) ov.classList.remove('cam-on');
          out.restored = 'blur.stop, tpCameraStream and the overlay class put back';
        }
      }
    } catch(e) { out.tpEndTake = 'ERROR ' + e.message; }
  `], test: `PROOF — FILMING TEARDOWN (v613). The taps ALREADY ran this by executing the app's own tpEndTake() against a stream the harness owns. Do NOT try to film anything: this browser is headless with no camera, so there is nothing to see and nothing to tap. Your ONLY job: read facts.PROOF and report every key:value pair VERBATIM in "observed". Keys: tpEndTake, keepEndsTake, retakeKeepsCamera, tracksReleased, cameraHandleCleared, blurPumpStopped, feedDetached, camOnCleared, controlUntouchedStreamStaysLive, restored. status=pass only if nothing says BROKEN and controlUntouchedStreamStaysLive says "ok". Put every BROKEN item in bugs — tracksReleased/blurPumpStopped failing means the MediaPipe segmentation pump and the camera keep running through the entire 2K render, which is the suspected cause of years of render stutter. If controlUntouchedStreamStaysLive says CHECK WORTHLESS, say so and set status=blocked: the probe could not have failed, so it proved nothing. If facts.PROOF is missing, say so plainly — do not guess.` },
  // ── v613 ONBOARDING HONESTY ──────────────────────────────────────────────────────────────
  // HONEST SCOPE, stated up front: the wizard's real first-run FLOW cannot be tested here — it
  // fires only for a brand-new account and the harness cannot do a magic-link signup (see
  // UNTESTABLE FLOWS at the bottom of this file). Faking a signup would be worse than not
  // testing it. What IS reachable is the defect itself: the onboarding markup is STATIC in
  // app.html (always in the DOM, just .hidden), so obNext(2) — the real step-2 gate — can be
  // driven directly, and the invariant it must satisfy is exact: anything the wizard ACCEPTS
  // must already satisfy isBrandMinimumMet(), or the wizard says "your brand brain is ready"
  // and the app then shows a LOCKED circle reading "Set up your brand first".
  // Budget 3: no interaction, the driver only transcribes facts.PROOF.
  { id: 'proof-onboarding-honesty', budget: 3, taps: ["switchView('today')", `
    var out = { __ran: 'started' }; window._qaProof = out;
    try {
      if (typeof obNext !== 'function' || typeof obGoToStep !== 'function' || typeof isBrandMinimumMet !== 'function') {
        out.wizard = 'CANNOT TEST — obNext / obGoToStep / isBrandMinimumMet are not all defined';
      } else {
        var ov = document.getElementById('onboardingOverlay');
        var wasHidden = ov ? ov.classList.contains('hidden') : true;
        var IDS = ['obBrandName','obAudience','obUsps'];
        var snap = { fields: {}, tones: [], comms: [], step: 1, wasHidden: wasHidden };
        IDS.forEach(function(id){ var e = document.getElementById(id); snap.fields[id] = e ? e.value : null; });
        snap.tones = (typeof obSelectedTones !== 'undefined' && obSelectedTones) ? obSelectedTones.slice() : [];
        snap.comms = (typeof obCommunities !== 'undefined' && obCommunities) ? obCommunities.slice() : [];
        snap.step = (typeof obCurrentStep !== 'undefined') ? obCurrentStep : 1;
        window._qaObSnap = snap;   /* clearLeftoverModals puts the wizard back even if we throw */
        var missing = IDS.filter(function(id){ return !document.getElementById(id); });
        if (missing.length) { out.wizard = 'CANNOT TEST — the wizard fields are not in the DOM: ' + missing.join(', '); }
        else {
          var setF = function(id, v){ var e = document.getElementById(id); if (e) e.value = v; };
          var fill = function(o){
            setF('obBrandName', o.name ? 'QA Probe Brand' : '');
            setF('obAudience', o.audience ? 'Founders who need reliable suppliers' : '');
            setF('obUsps', o.usps ? 'Vetted factories and a protected first order' : '');
            obSelectedTones = o.tones ? ['deadpan','witty'] : ['deadpan'];
            obCommunities = o.communities ? ['sourcing','logistics'] : ['sourcing'];
          };
          var installFailed = '';
          var gatePasses = function(o){
            fill(o);
            /* READ BACK what we just wrote. If the synthetic values did not land in the app's own
               bindings, every "the gate rejected it" below would be true for the wrong reason. */
            if (document.getElementById('obBrandName').value !== (o.name ? 'QA Probe Brand' : '')
                || obSelectedTones.length !== (o.tones ? 2 : 1)
                || obCommunities.length !== (o.communities ? 2 : 1)) {
              installFailed = 'CANNOT TEST — the synthetic wizard values could not be installed, so a rejection here would mean nothing';
              return false;
            }
            obGoToStep(2);
            obNext(2);
            return ((typeof obCurrentStep !== 'undefined') ? obCurrentStep : -1) === 3;
          };
          /* POSITIVE CONTROL FIRST. If a complete brand cannot get past step 2 then the gate is
             unreachable and every "it rejected" result below would be meaningless. */
          var accepted = gatePasses({ name:1, tones:1, audience:1, usps:1, communities:1 });
          out.gateAcceptsTheMinimum = installFailed ? installFailed
            : (accepted ? 'WORKS — a brand that satisfies everything the app requires is accepted'
                        : 'BROKEN — even a complete brand cannot pass step 2, so the rejections below prove NOTHING');
          /* Every field the APP later demands must also be demanded by the WIZARD. */
          out.gateDemandsBrandName = !gatePasses({ name:0, tones:1, audience:1, usps:1, communities:1 })
            ? 'WORKS — rejected without a brand name'
            : 'BROKEN — the wizard would say "your brand brain is ready" with no brand name, then lock the app';
          out.gateDemandsTwoTones = !gatePasses({ name:1, tones:0, audience:1, usps:1, communities:1 })
            ? 'WORKS — rejected with only 1 tone'
            : 'BROKEN — the wizard accepts 1 tone but isBrandMinimumMet() needs 2, so the circle locks straight after "ready"';
          out.gateDemandsAudience = !gatePasses({ name:1, tones:1, audience:0, usps:1, communities:1 })
            ? 'WORKS — rejected without an audience'
            : 'BROKEN — the wizard accepts no audience but isBrandMinimumMet() requires one';
          out.gateDemandsTwoTopics = !gatePasses({ name:1, tones:1, audience:1, usps:1, communities:0 })
            ? 'WORKS — rejected with only 1 topic'
            : 'BROKEN — the wizard accepts 1 topic but isBrandMinimumMet() needs 2';
          out.gateDemandsUsps = !gatePasses({ name:1, tones:1, audience:1, usps:0, communities:1 })
            ? 'WORKS — rejected without "what makes you different"'
            : 'BROKEN — without USPs getBrainStats().filled lands on exactly 2, so brandBrainBare() is true and the first-run guard calls the brain empty seconds after screen 3 said it was ready';
          /* RESTORE the wizard before anything else looks at it. */
          IDS.forEach(function(id){ if (snap.fields[id] !== null) setF(id, snap.fields[id]); });
          obSelectedTones = snap.tones; obCommunities = snap.comms;
          try { if (typeof obRenderToneCards === 'function') obRenderToneCards(); } catch(e){}
          try { if (typeof obRenderCommunityTags === 'function') obRenderCommunityTags(); } catch(e){}
          try { if (typeof obClearErr === 'function') obClearErr('obStep2Err'); } catch(e){}
          try { obGoToStep(snap.step); } catch(e){}
          if (ov && wasHidden) ov.classList.add('hidden');
          try { delete window._qaObSnap; } catch(e){}
          out.restored = 'wizard fields, tones, topics, step and hidden state put back';
        }
        /* LIVE CONTRADICTION CHECK on the real brand — read only, nothing mutated. The Quick Post
           caption is rendered as (isBrandMinimumMet() ? "Today's post, one tap" : "Set up your
           brand first"), so caption and lock state must always agree. */
        try {
          var met = !!isBrandMinimumMet();
          var cap = document.getElementById('tvShzCap');
          var capTxt = cap ? String(cap.textContent || '').trim() : '';
          var saysLocked = capTxt.toLowerCase().indexOf('set up your brand') > -1;
          out.liveCaptionMatchesLock = !capTxt
            ? 'no Quick Post caption on screen — could not check the live brand'
            : ((saysLocked === !met)
                ? 'WORKS — caption "' + capTxt + '" agrees with isBrandMinimumMet()=' + met
                : 'BROKEN — caption "' + capTxt + '" contradicts isBrandMinimumMet()=' + met + ' (the app is promising and locking at the same time)');
          out.liveBrandBare = (typeof brandBrainBare === 'function')
            ? (brandBrainBare() ? 'this brand IS bare (the first-run guard would fire)' : 'this brand is not bare')
            : 'brandBrainBare missing';
        } catch(e) { out.liveCaptionMatchesLock = 'ERROR ' + e.message; }
      }
    } catch(e) { out.wizard = 'ERROR ' + e.message; }
  `], test: `PROOF — ONBOARDING HONESTY (v613). The taps ALREADY drove the wizard's real step-2 gate (obNext(2)) directly and put every field back afterwards. Do NOT open or click through onboarding yourself — it is a hidden overlay and clicking it could create a brand. Read facts.PROOF and report every key:value pair VERBATIM. Keys: gateAcceptsTheMinimum, gateDemandsBrandName, gateDemandsTwoTones, gateDemandsAudience, gateDemandsTwoTopics, gateDemandsUsps, liveCaptionMatchesLock, liveBrandBare, restored. The point being tested: the wizard must never accept a brand that the app then LOCKS — "your brand brain is ready" followed by a circle reading "Set up your brand first". status=pass only if nothing says BROKEN. If gateAcceptsTheMinimum says BROKEN, set status=blocked and say so plainly: the gate was unreachable, so the other results prove nothing. SCOPE NOTE for your observed field: this checks the GATE LOGIC, not the first-run signup experience — that needs a real magic-link account and is deliberately not tested. If facts.PROOF is missing, say so plainly.` },
  // ── v614 ESCAPING ────────────────────────────────────────────────────────────────────────
  // DOM-MEASURED and it must be: "did that markup execute?" is a fact the browser answers and
  // vision cannot. nl2br used to look like an escaper and was not, feeding ~19 innerHTML sinks.
  // Checked BOTH directions — a payload must be inert, AND ordinary punctuation must still
  // round-trip readably (over-escaping would be just as much a bug). Every check is paired with
  // a negative control through a RAW sink, so a probe that cannot fail is caught here.
  // The end-to-end half goes through a real user sink (a notebook note, escHtml -> innerHTML)
  // and the probe note is removed BY ID afterwards — never by position (see proof-data).
  // Budget 3: no interaction; the driver only transcribes facts.PROOF.
  // ── v634/v635 DATA-SAFETY FIXES ──────────────────────────────────────────────────────────
  // Five fixes that are reachable from a browser but were untested. Each one is silent when it
  // regresses — the user loses data or gets wrong output and nothing errors — which is exactly
  // the class worth a probe. Where a fix can be exercised as a pure function it IS (bvFieldAllowed,
  // spBrandPalette); where it is a guard inside a bigger side-effecting function, the probe reads
  // the function's own source at runtime and says plainly that it verified WIRING, not behaviour.
  // NOTE ON THE SOURCE READS: assert the executable pattern, never a bare string. Three separate
  // times today a grep for `slice(-25)` "found" the removed truncation that was really just the
  // COMMENT describing its removal.
  { id: 'proof-data-safety', budget: 3, taps: ["switchView('today')", `
    var out = { __ran: 'started' }; window._qaProof = out;
    var src = function (f) { try { return (typeof f === 'function') ? Function.prototype.toString.call(f) : ''; } catch (e) { return ''; } };

    // 1. BEHAVIOURAL — the coach cannot "save" into a field the app does not store. Before v635
    //    a model typo (targetAudiance) updated the ring and said "Saved ✓" while settingsToBrand
    //    silently dropped it forever.
    try {
      if (typeof bvFieldAllowed !== 'function') out.applyWhitelist = 'BROKEN — bvFieldAllowed() is not defined, so the coach can write junk field names again';
      else {
        var good = bvFieldAllowed('targetAudience'), typo = bvFieldAllowed('targetAudiance'), junk = bvFieldAllowed('__nope__');
        out.applyWhitelist = (good && !typo && !junk)
          ? 'WORKS — real field accepted, typo and junk both refused'
          : 'BROKEN — targetAudience=' + good + ' targetAudiance=' + typo + ' __nope__=' + junk;
      }
    } catch (e) { out.applyWhitelist = 'ERROR ' + e.message; }

    // 2. BEHAVIOURAL — brand colours must reach the video renderer. They never did: spBrandPalette
    //    read them off getBrandContext(), which has never carried them, so every user's
    //    split-screen rendered in Content Shrimp's own cream/ink/lavender.
    try {
      if (typeof spBrandPalette !== 'function') out.brandColours = 'BROKEN — spBrandPalette() is not defined';
      else {
        var had = settings.brandColorPrimary, tmp = !had;
        if (tmp) settings.brandColorPrimary = '#123456';          // in-memory only; never saved
        var pal = spBrandPalette();
        var wired = String(pal && pal.accent || '').toLowerCase() !== '#e7dafa'
                 && String(pal && pal.accent || '').toLowerCase() !== '#e7daf9';
        out.brandColours = wired
          ? 'WORKS — palette accent ' + pal.accent + ' follows the brand colour' + (tmp ? ' (probe colour)' : ' (your real colour)')
          : 'BROKEN — palette still returns the default lavender, so the renderer ignores brand colours';
        if (tmp) delete settings.brandColorPrimary;               // restore
      }
    } catch (e) { out.brandColours = 'ERROR ' + e.message; }

    // 3. WIRING — a debounced Settings edit must be flushed before the brand switches, or the
    //    pending timer writes brand A's keystrokes into brand B's row.
    try {
      out.switchFlush = /flushBrandSave/.test(src(window.switchBrand))
        ? 'WORKS (wiring) — switchBrand flushes the pending save first'
        : 'BROKEN — switchBrand no longer flushes, so an in-flight edit can land on the WRONG brand';
    } catch (e) { out.switchFlush = 'ERROR ' + e.message; }

    // 4. WIRING — notebook was the last delete-before-write path: on a second device (no local
    //    cache) a failed load read as an empty list, and the next save deleted every note.
    try {
      var ns = src(window.saveNotebookToDB);
      out.notebookGuard = (/_listLoaded/.test(ns) && /_replaceBrandRows/.test(ns))
        ? 'WORKS (wiring) — refuses to save a list that never loaded, and writes before deleting'
        : 'BROKEN — notebook save lost its never-loaded guard or its write-before-delete';
    } catch (e) { out.notebookGuard = 'ERROR ' + e.message; }

    // 5. WIRING — "Pull customer reviews" used to overwrite hand-written brand text with no
    //    validation and no review sheet, while the copy above it promised the opposite.
    try {
      var rs = src(window.pullReviews);
      out.reviewsGuard = (/crawlValueOk/.test(rs) && /openBrainReview/.test(rs))
        ? 'WORKS (wiring) — crawled values are validated and shown for review before saving'
        : 'BROKEN — reviews pull can overwrite your brand text unreviewed again';
    } catch (e) { out.reviewsGuard = 'ERROR ' + e.message; }

    // 6. WIRING — keeping ONE voice rule must never delete another. The cap used to end with
    //    lines.slice(-25), silently evicting the oldest hand-written rules on a background timer.
    try {
      var bad = 0, checked = 0;
      ['bvAcceptSuggestion', 'brainKeepRule', 'nbSaveAsRule'].forEach(function (n) {
        var b = src(window[n]); if (!b) return; checked++;
        if (/coachNotes\\s*=\\s*[A-Za-z_$][\\w$]*\\s*\\.slice\\s*\\(/.test(b)) bad++;
      });
      out.voiceRuleCap = !checked ? 'could not read the rule-saving functions'
        : (bad === 0 ? 'WORKS (wiring) — ' + checked + ' rule-saving paths, none truncates coachNotes on save'
                     : 'BROKEN — ' + bad + ' of ' + checked + ' paths still truncate your voice rules on save');
    } catch (e) { out.voiceRuleCap = 'ERROR ' + e.message; }
    return out;
  `], test: `PROOF RUN — the taps ALREADY measured six data-safety fixes by calling the app's own functions and reading their source. Do NOT re-test by clicking. Report every key VERBATIM in "observed": applyWhitelist, brandColours, switchFlush, notebookGuard, reviewsGuard, voiceRuleCap. Two of them (applyWhitelist, brandColours) are true behavioural checks — they ran the real function and judged its output. The four marked "(wiring)" verified the guard is still present in the function, NOT that it behaves correctly end-to-end; say so plainly in your report rather than overclaiming. status=pass only if every key says WORKS. Any BROKEN is a silent data-loss or wrong-output regression — put it in bugs verbatim. If __ran is present but a later key is MISSING the block died there: name which keys are present and which are missing, and fail. If facts.PROOF is absent, say so rather than guessing, and never report another feature's keys as this one's.` },

  // ── v635/v636 BRAND-BRAIN COMPLETENESS ───────────────────────────────────────────────────
  // The most consequential product fix of the week, and one a vision driver CANNOT judge: the app
  // used to report "14 of 14 · 100% · your brand brain is full" while seven whole sections of the
  // model's brand profile were empty, so it stopped asking for exactly the fields that carry a
  // brand's specifics rather than its adjectives. "Is 70% the right number?" is not a thing you
  // can see — it has to be measured against the app's own field list. Read-only ON PURPOSE:
  // blanking a field to watch the meter drop would be stronger evidence, but a debounced brand
  // save could persist the blanked value, and destroying real brand data to test a meter is a
  // bad trade.
  { id: 'proof-brain-meters', budget: 3, taps: ["openBrain()", `
    var out = { __ran: 'started' }; window._qaProof = out;
    // 1. all three meters must derive from ONE list (they used to disagree: 13 vs 14 vs 11
    //    checks, against 23 fields actually rendered to the model).
    try {
      if (typeof brainFieldKeys !== 'function') {
        out.oneList = 'BROKEN — brainFieldKeys() is not defined, so the v635 single-source fix is not live';
      } else {
        var keys = brainFieldKeys();
        var st = (typeof getBrainStats === 'function') ? getBrainStats() : null;
        out.fieldCount = keys.length + ' brand fields tracked';
        out.oneList = (st && st.facets === keys.length)
          ? 'WORKS — the ring counts ' + st.facets + ' facets and the field list has ' + keys.length
          : 'BROKEN — ring says ' + (st ? st.facets : '?') + ' facets but the field list has ' + keys.length;
      }
    } catch (e) { out.oneList = 'ERROR ' + e.message; }

    // 2. the seven DEEP fields must be in the tracked list. Their absence WAS the bug.
    try {
      var DEEP = ['originStory','socialProof','channels','visualStyle','webMentions','categoryGripes','reviewInsights','voiceSample'/* v649 */];
      var keys2 = (typeof brainFieldKeys === 'function') ? brainFieldKeys() : [];
      var missing = DEEP.filter(function (k) { return keys2.indexOf(k) < 0; });
      out.deepTracked = missing.length === 0
        ? 'WORKS — all 7 deep fields are counted'
        : 'BROKEN — ' + missing.length + ' deep field(s) still uncounted: ' + missing.join(', ');
    } catch (e) { out.deepTracked = 'ERROR ' + e.message; }

    // 3. the chip list must no longer be a SECOND hand-maintained order (deleted in v635).
    try {
      out.noSecondList = (typeof BRAIN_CHIP_ORDER === 'undefined')
        ? 'WORKS — BRAIN_CHIP_ORDER is gone'
        : 'BROKEN — BRAIN_CHIP_ORDER still exists, so the chips can drift from the ring again';
    } catch (e) { out.noSecondList = 'WORKS — BRAIN_CHIP_ORDER is gone'; }

    // 4. the copy must not claim "full"/"complete" while fields are missing. This is the part the
    //    user actually reads, and it is what stopped them filling the brain in.
    try {
      var st3 = (typeof getBrainStats === 'function') ? getBrainStats() : null;
      var body = (document.getElementById('settingsOverlay') || document.body).innerText || '';
      var claimsDone = /brand brain is full|brain is complete|100%/i.test(body);
      if (!st3) out.honestCopy = 'could not read getBrainStats';
      else if (st3.filled >= st3.facets) out.honestCopy = 'N/A — this brand really is complete (' + st3.filled + '/' + st3.facets + ')';
      else out.honestCopy = claimsDone
        ? 'BROKEN — only ' + st3.filled + '/' + st3.facets + ' filled but the screen still claims full/100%'
        : 'WORKS — ' + st3.filled + '/' + st3.facets + ' filled and the copy does not claim full';
    } catch (e) { out.honestCopy = 'ERROR ' + e.message; }

    // 5. the Master Prompt doc (v636) must be gone: it was rendered LAST in the prompt, labelled
    //    "primary reference", so a stale linked Google Doc silently outranked the curated fields.
    try {
      var b2 = (document.getElementById('settingsOverlay') || document.body).innerText || '';
      var gone = !/master prompt|custom instructions/i.test(b2) && typeof syncMasterPrompt === 'undefined';
      out.masterPromptGone = gone
        ? 'WORKS — no Master Prompt / Custom Instructions anywhere in Settings'
        : 'BROKEN — Master Prompt / Custom Instructions is still present in the UI';
    } catch (e) { out.masterPromptGone = 'ERROR ' + e.message; }
    return out;
  `], test: `PROOF RUN — the taps ALREADY measured everything by calling the app's own functions. Do NOT re-test by clicking, and do NOT try to judge the percentage by eye. Your ONLY job: read facts.PROOF and report every key VERBATIM in "observed". Keys: fieldCount, oneList, deepTracked, noSecondList, honestCopy, masterPromptGone. Context so you can judge severity: the app used to tell users "14 of 14 · 100% · your brand brain is full" while SEVEN whole brand sections were empty — so it stopped asking for the fields that carry a brand's actual specifics, which is the most likely cause of generated output feeling generic. status=pass only if every key says WORKS (or N/A for honestCopy on a genuinely complete brand). Any BROKEN is a real regression of that fix — put it in bugs verbatim. If __ran is present but a later key is MISSING, the block died there: say exactly which keys are present and which are missing, and fail. If facts.PROOF is absent, say so plainly rather than guessing, and never report another feature's keys as this one's.` },

  { id: 'proof-escaping', budget: 3, taps: ["switchView('notebook')", `
    var out = { __ran: 'started' }; window._qaProof = out;
    window.__qaXssFired = 0; window.__qaCtrlFired = 0;
    var PAYLOAD = '<img src=qa-xss-probe onerror="window.__qaXssFired=1">';
    var CONTROL = '<img src=qa-xss-probe onerror="window.__qaCtrlFired=1">';
    /* 1. the helper itself, rendered into a REAL attached node (a detached node never loads). */
    try {
      if (typeof nl2br !== 'function') { out.nl2brInert = 'BROKEN — nl2br is not defined'; }
      else {
        var host = document.createElement('div');
        host.id = 'qaXssHost'; host.style.position = 'fixed'; host.style.left = '-9999px'; host.style.top = '0';
        document.body.appendChild(host);
        host.innerHTML = nl2br(PAYLOAD);
        out.nl2brInert = host.querySelector('img')
          ? 'BROKEN — nl2br produced a LIVE <img> element'
          : 'WORKS — the payload rendered as inert text';
        out.nl2brShowsText = (String(host.textContent || '').indexOf('onerror') > -1)
          ? 'WORKS — the payload is readable as plain text, not swallowed'
          : 'CHECK — the payload text did not survive at all';
        /* NEGATIVE CONTROL — the same markup through a RAW sink MUST come alive, or "inert" above
           means nothing. */
        var ctrl = document.createElement('div');
        ctrl.id = 'qaXssCtrl'; ctrl.style.position = 'fixed'; ctrl.style.left = '-9999px'; ctrl.style.top = '0';
        document.body.appendChild(ctrl);
        ctrl.innerHTML = CONTROL;
        out.controlRawSinkIsLive = ctrl.querySelector('img')
          ? 'ok — an unescaped sink DOES create a live <img>, so the inert check above CAN fail'
          : 'CHECK WORTHLESS — even a raw sink created no element here, so "inert" proves nothing';
        /* OVER-ESCAPING is a bug too: ordinary punctuation must still read normally. */
        var LF = String.fromCharCode(10);
        var friendly = nl2br('Tom & Jerry 5 < 10 "rule"' + LF + 'second line');
        var brCount = friendly.split('<br>').length - 1;
        out.nl2brNoDoubleEscape = (friendly.indexOf('&amp;amp;') === -1 && friendly.indexOf('&amp;') > -1 && brCount === 1)
          ? 'WORKS — & escaped exactly once and exactly one <br>'
          : 'BROKEN — over/under-escaped: ' + friendly;
      }
    } catch(e) { out.nl2brInert = 'ERROR ' + e.message; }
    /* 2. END TO END through a real user sink: a saved note goes escHtml -> innerHTML in #nbList. */
    try {
      if (typeof nbSaveNote !== 'function' || typeof notebookNotes === 'undefined') { out.notebookXss = 'notebook functions/state missing'; }
      else {
        var ni = document.getElementById('nbInput');
        if (!ni) { out.notebookXss = 'the notebook composer is not rendered'; }
        else {
          var ids0 = {}; notebookNotes.forEach(function(n){ if (n && n.id != null) ids0[n.id] = 1; });
          var n0 = notebookNotes.length;
          ni.value = 'QA XSS probe — safe to delete. ' + PAYLOAD;
          nbSaveNote();
          var probe = null;
          for (var i = 0; i < notebookNotes.length; i++) { var n = notebookNotes[i]; if (n && n.id != null && !ids0[n.id]) { probe = n; break; } }
          if (!probe) { out.notebookXss = 'UNTESTED — the probe note did not save, so nothing was rendered'; }
          else {
            try { if (typeof renderNotebook === 'function') renderNotebook(); } catch(e){}
            var list = document.getElementById('nbList');
            out.notebookXss = (list && list.querySelector('img'))
              ? 'BROKEN — a saved note containing markup rendered a LIVE <img> in the notebook list'
              : 'WORKS — the payload rendered as inert text in the real notebook sink';
            /* clean up BY ID. Position-based deletion once ate a real note; never do that. */
            if (typeof nbDelete === 'function') { nbDelete(probe.id); }
            else { notebookNotes = notebookNotes.filter(function(x){ return !(x && x.id === probe.id); }); try { saveNotebookToDB(); } catch(e){} }
            var gone = !notebookNotes.some(function(x){ return x && x.id === probe.id; });
            out.probeCleanedUp = (gone && notebookNotes.length === n0)
              ? 'WORKS (probe removed, the list is back to ' + n0 + ')'
              : 'BROKEN — the probe note is still there, or the list length is ' + notebookNotes.length + ' and should be ' + n0;
            try { if (typeof renderNotebook === 'function') renderNotebook(); } catch(e){}
          }
        }
      }
    } catch(e) { out.notebookXss = 'ERROR ' + e.message; }
    /* 3. the URL allowlist and the two attribute escapers. */
    try {
      if (typeof safeUrl !== 'function') { out.safeUrlBlocks = 'BROKEN — safeUrl is not defined'; }
      else {
        var TAB = String.fromCharCode(9);
        var bad = ['javascript:alert(1)', ' JaVaScRiPt:alert(1)', 'java' + TAB + 'script:alert(1)', 'vbscript:msgbox(1)', 'data:image/svg+xml;base64,AAAA'];
        var blocked = bad.filter(function(u){ return safeUrl(u) === ''; });
        out.safeUrlBlocks = (blocked.length === bad.length)
          ? 'WORKS — all ' + bad.length + ' dangerous URL forms blocked'
          : 'BROKEN — only ' + blocked.length + ' of ' + bad.length + ' blocked; these got through: ' + bad.filter(function(u){ return safeUrl(u) !== ''; }).join(' | ');
        var good = ['https://example.com/a', 'http://example.com', 'mailto:a@b.c', '/relative/path', 'relative.html'];
        var kept = good.filter(function(u){ return safeUrl(u) === u; });
        out.safeUrlKeepsReal = (kept.length === good.length)
          ? 'WORKS — all ' + good.length + ' legitimate URLs pass through unchanged'
          : 'BROKEN — over-blocking, only ' + kept.length + ' of ' + good.length + ' survived (real links would break)';
      }
    } catch(e) { out.safeUrlBlocks = 'ERROR ' + e.message; }
    try {
      out.escJsClosesAttr = (typeof escJs !== 'function') ? 'BROKEN — escJs is not defined'
        : ((escJs('a"b<c').indexOf('"') === -1 && escJs('a"b<c').indexOf('<') === -1)
            ? 'WORKS — a quote and a < can no longer close the onclick attribute'
            : 'BROKEN — escJs output still contains a raw quote or <: ' + escJs('a"b<c'));
      out.escAttrQuotes = (typeof escAttr !== 'function') ? 'BROKEN — escAttr is not defined'
        : ((escAttr("a'b" + '"c<d').indexOf("'") === -1 && escAttr("a'b" + '"c<d').indexOf('"') === -1)
            ? 'WORKS — single AND double quotes escaped'
            : 'BROKEN — escAttr leaves a quote raw: ' + escAttr("a'b" + '"c<d'));
    } catch(e) { out.escJsClosesAttr = 'ERROR ' + e.message; }
    /* 4. did anything actually RUN? onerror is asynchronous, so resolve it a beat later. */
    out.noScriptExecuted = 'checking (handlers fire asynchronously)...';
    setTimeout(function(){
      try {
        window._qaProof.noScriptExecuted = window.__qaXssFired
          ? 'BROKEN — the escaped payload EXECUTED (window.__qaXssFired was set)'
          : 'WORKS — nothing executed';
        window._qaProof.controlRawSinkExecuted = window.__qaCtrlFired
          ? 'ok — the RAW control payload did execute, so this browser really would run it'
          : 'note — the raw control did not fire either (headless may not load the bogus src); rely on controlRawSinkIsLive instead';
        ['qaXssHost','qaXssCtrl'].forEach(function(id){ var el = document.getElementById(id); if (el) el.remove(); });
      } catch(e){}
    }, 900);
  `], test: `PROOF — ESCAPING (v614). The taps ALREADY did this: they pushed an XSS payload through nl2br into a real attached node AND through a real user sink (a saved notebook note, which renders via escHtml into innerHTML), then deleted the probe note by id. Do NOT type payloads yourself. Read facts.PROOF and report every key:value pair VERBATIM. Keys: nl2brInert, nl2brShowsText, controlRawSinkIsLive, nl2brNoDoubleEscape, notebookXss, probeCleanedUp, safeUrlBlocks, safeUrlKeepsReal, escJsClosesAttr, escAttrQuotes, noScriptExecuted, controlRawSinkExecuted. status=pass only if nothing says BROKEN. Note that BOTH directions matter: a payload must be inert AND ordinary punctuation must still round-trip (nl2brNoDoubleEscape / safeUrlKeepsReal catch over-escaping, which breaks real links and real text). If controlRawSinkIsLive says CHECK WORTHLESS, set status=blocked and say so: the probe could not have failed, so it proved nothing. If probeCleanedUp says BROKEN, put it in bugs — the harness left junk in a real brand. If facts.PROOF is missing, say so plainly.` },
  { id: 'pipeline',     taps: ["switchView('pipeline')"],                  test: 'Review queued/approved posts, open or preview one, and mark one done. Verify the list and the state change work.' },
  { id: 'remix',        taps: ["switchView('create')"],                    test: 'v647 NOTE FIRST — if a "What they just posted" section appears under the "Borrow from" strip, just CONFIRM IT RENDERS (header + a "Show their latest"/"Refresh" button, or post cards with "Make it mine →"). DO NOT TAP its refresh button: every tap is a paid scraper run, and it is manual by design. Its absence is also fine (it only shows when creators are bookmarked). Then the main test — v466 QUICK LANE: the screen leads with a white card headlined "Seen something that works? Make it yours." — ONE textarea ("Paste a link or text") + a "Remix it" button + an "or set it up manually" link. NO "steal" wording anywhere on the screen (banner should say "Start from what is proven" phrasing). Type a short marketing tip TEXT into the box and tap Remix it — while generating, the button should show rotating witty lines AND a pulsing ring around it; it should then produce a remixed post card below (15-40s). Also tap "or set it up manually" once: the classic form (source tabs TikTok/YouTube/Article/Paste/File, description box) should unfold below the card. FAIL if the quick card is missing, "steal" copy remains, or nothing generates.' },
  { id: 'idea-catcher', taps: ["toggleMoreSheet()", "moreGo('idea')"],     test: 'Type a rough raw idea into the field, then develop it into something usable. Verify it produces a developed result.' },
  { id: 'questions',    taps: ["toggleMoreSheet()", "moreGo('questions')"],test: 'REAL search questions people ask (Google PAA + related), each with an "Answer this" button and an "or pick the format" fold. STEP 1: confirm the list loads with readable question cards, each showing its source tag ("Google PAA"/"Related") and the seed term. STEP 2: tap "or pick the format" on ONE card and confirm the format chips unfold. STEP 3: tap "Answer this" on ONE SINGLE card, wait for it, and confirm that card flips to a "✓ Idea Created" state and the ideas count in facts goes UP by one. STOP THERE — each "Answer this" is a paid generation, so do NOT tap it on any other card no matter how many are listed; a second one proves nothing and wastes credit. FAIL if questions never load, the fold does nothing, or "Answer this" produces no idea.' },
  { id: 'notebook',     taps: ["toggleMoreSheet()", "moreGo('notebook')"], test: 'Type a note and save it; develop it or save-as-rule if offered. Verify the note persists in the list.' },
  { id: 'viral-lab',    taps: ["toggleMoreSheet()", "moreGo('viral')", "vlTab('analyze')"],    test: 'v646: the analyzer is now the SECOND tab on Trends ("Analyze a video") — the taps already opened it for you, and "What\'s rising" being the default tab is CORRECT, not a bug. On that tab: the panel leads with a white card — ONE textarea (\"Paste the viral video link — or its transcript…\") + an \"Analyze it\" button + an \"or add details myself\" link. Paste a couple of sentences of TRANSCRIPT text and tap Analyze it — a breakdown (hook/structure/trigger + ideas) should appear below (15-40s). Also tap \"or add details myself\": the manual inputs (link field, transcript box, see&hear box with Dictate) should unfold. FAIL if the quick card is missing or no analysis appears.' },
  { id: 'brain',        taps: ["openBrain()", "var _bt=function(){ try{ if(typeof settings==='object' && settings && settings.openSections){ ['brand','deep','tone','mix','schedule'].forEach(function(k){ if(k in settings.openSections) settings.openSections[k]=true; }); if(typeof saveSettings==='function') saveSettings(); if(typeof renderSettingsPanel==='function') renderSettingsPanel(); } }catch(e){} try{ var t=document.querySelector('#settingsOverlay [data-sp-field=\"coachNotes\"]'); if(t){ t.scrollIntoView({block:'center'}); t.focus(); } }catch(e){} }; setTimeout(_bt,500); setTimeout(_bt,1600); setTimeout(_bt,3200);"], test: `The Brain button opens Settings on the Voice/Brand tab; the taps force the voice sections open and scroll+focus the "Voice Memory" field (retried 3x — do NOT rely on manual scrolling). (1) VOICE MEMORY EDITABILITY (v359): it is a large text box — type a few characters at the end and confirm it ACCEPTS typing; if the text is long, confirm you can scroll inside the box to the bottom (not clipped). (2) BUTTONS (v360/v363): each Brand-Voice field shows exactly TWO small action buttons "Make it better" and "Ask Assistant" on ONE line, labels NOT wrapping mid-word. There is deliberately NO completeness badge/dot near the buttons (removed by design in v363) — do NOT report its absence as a bug. FAIL only if the Voice Memory box cannot be typed into, or the buttons' text is wrapping to 2+ lines.` },
  { id: 'assistant',    taps: ["window._qaKeepAssistant=true; try{if(typeof openBrandVoice==='function')openBrandVoice(false);}catch(e){}"], test: `The AI coach ("Remy") chat overlay (titled "Brand Voice AI Assistant"). CURRENT layout (v588-591), judge against THIS, not older versions: (a) header = title + subtitle + "edit Voice Memory by hand" link + an X close. There is NO mic-avatar icon in the header any more — do NOT report its absence as a bug. (b) Directly below the header a PANEL shows a completeness RING with a % and "N of N pieces filled" — ring only, NO scan button in the panel. The TOTAL is computed from the brand field list (23 on the current build, was a hardcoded 14 before v635 — which is why it must NOT be judged against a fixed number; report whatever it says, and only fail if the two numbers are missing or obviously nonsense such as filled > total). (c) CONDITIONAL — read the ring % FIRST. If it is BELOW 100%, a white card slot at the top of the chat must present THREE real lavender buttons: "Go deeper: my website", "Go deeper: my socials", "Go deeper: customer reviews" (actual tappable buttons, not text). If the ring reads 100%, that slot is CORRECTLY hidden (the brand brain is full and there is nothing left to scan for) — its absence is then NOT a bug and must NOT be failed. (d) the bottom composer (text input + send + mic) is present and not overlapping or cut off. Verify a,b,c,d. THEN type one short message like "who are my competitors" and send it — a coherent coach reply must come back within ~30s (send only ONE message). FAIL if: the ring is missing, the composer is broken/overlapping, sending returns an error with no reply, or the ring is under 100% AND the three "Go deeper" buttons are absent.` },
  { id: 'dark-mode', budget: 26, needsVision: true, taps: ["switchView('today')", "try{toggleDarkMode(true);}catch(e){}"], test: `DARK MODE CONTRAST AUDIT — dark mode is ON. This is the app's weakest area: ~200 CSS rules hardcode ink (#16130F) as a text colour, which is correct on fills that stay light (lavender pills, white buttons) but INVISIBLE on anything that flips dark. Your job is to find every one a user would hit.
WALK THESE SCREENS, in this order, judging each before moving on: Quick Post → Ideas → Pipeline → Trends (More sheet) → Remix → Notebook → Questions → Settings. Scroll each one.
On EVERY screen look for: (a) text that is dark-on-dark or light-on-light and hard to read; (b) a card/panel/input/chip that stayed WHITE or CREAM while everything around it went dark (a light island); (c) a link or label that vanishes into its background — check "source" links, small captions, badges and counts especially; (d) buttons whose text disappears or whose fill matches the background; (e) icons or borders that disappear; (f) any toast or popup that is unreadable.
CRITICAL: for EACH problem name the SCREEN and the EXACT element and what is wrong with it, e.g. "Trends: the 'source' link on non-highlighted chips is dark on a dark card". A vague "contrast is poor" is useless — I need to find the rule. List every one you see in bugs, even small ones; do not stop at the first.
The harness restores light mode afterwards. FAIL if ANY text or control is unreadable. Say "clean" only for screens where everything is genuinely legible.` },

  { id: 'more-sheet',    taps: ["switchView('today')", "window._qaKeepMoreSheet=true; toggleMoreSheet();"], test: `THE MORE SHEET NAVIGATION — verify every row actually goes where it says. The More sheet should now be open, listing the extra tools (e.g. Remix, Idea Catcher, Trends, Notebook, What-people-search/Questions, Assistant, Settings-ish rows). STEP 1: list what rows you see and confirm each has a clear label + sub-line and none are visually broken/overlapping. STEP 2: tap ONE row, confirm the sheet closes and the CORRECT screen opens (heading matches the row you tapped). STEP 3: reopen the More sheet and tap a DIFFERENT row, confirm it too lands on the right screen. Then close the sheet with its × or backdrop and confirm it closes cleanly. FAIL if a row does nothing, lands on the WRONG screen, the sheet cannot be closed, or rows are visually broken. NOTE: rows for shelved features (Blog, Publishing, Meme) should NOT be present — if you see them, report it.` },
  { id: 'settings-deep', budget: 14, needsVision: true, taps: ["toggleSettings()"], test: `SETTINGS SUB-SECTIONS (only lightly poked before). Settings is an overlay with collapsible sections. Open and inspect AT LEAST FOUR of these, one at a time, tapping the section header to expand: Posting Schedule, Content Mix, Competitor Bookmarks, Brands/Accounts, Team, Account/plan. For EACH one verify: (a) it actually expands and its content renders (not empty, not cut off under the sticky header), (b) its controls look interactive and correctly sized/aligned, (c) nothing overlaps or is clipped. Then change ONE harmless value (e.g. a Content Mix number) and confirm a saved confirmation toast appears. FAIL if a section will not expand, renders empty/broken, is clipped under the header, or a change produces no save confirmation. KNOWN-CORRECT BEHAVIOUR, do NOT report these as bugs (folded in from the old separate 'settings' feature, which this one fully subsumed): the header gear FORCE-OPENS the overlay by design (v295) — tapping it again does NOT close it; use the ← Back button. And the AI Engine control only saves a preference + shows a toast; it does not navigate anywhere.` },
  // WRONG MECHANISM, VERIFIED AGAINST app.html: this used to set `settings.openSections.advanced`.
  // The real default openSections keys are brand/deep/tone/schedule/mix/bookmarks/api/team/brands —
  // `advanced` WAS the Custom Instructions accordion (deleted in v636 with the Master Prompt doc,
  // which outranked the curated brand fields), and the Daily Idea Ping is
  // in NO accordion at all: it lives in the Settings **Workspace TAB** (`spActiveTab==='workspace'`,
  // select #dailyPushHour). So the tap expanded the wrong thing (or nothing), the driver never found
  // the toggle, and the feature failed as an app bug. Correct mechanism = spSetTab('workspace').
  { id: 'notifications', taps: ["window._qaKeepNotif=true; toggleSettings();", "try{ if(typeof spSetTab==='function') spSetTab('workspace'); }catch(e){} setTimeout(function(){ try{ var h=document.getElementById('dailyPushHour'); if(h){ var row=(h.closest && h.closest('div')) || h; row.scrollIntoView({block:'center'}); } }catch(e){} }, 400);"], test: `DAILY PING / NOTIFICATIONS controls in Settings. Find the Daily Idea Ping (notification) setting. Verify: (a) the toggle is present and clearly labelled with what it does; (b) toggling it ON must produce SOME feedback — NOT silence. IMPORTANT: this is an automated browser, so the notification permission is normally DENIED, and the app then correctly shows a "notifications are blocked — here's how to turn them on" help panel. That panel IS the correct feedback: treat it as a PASS for (b), not a failure, and close it to carry on; (c) when the ping is OFF the posting-time dropdown should be DISABLED (this is intentional gating, correct behavior — do NOT report the disabled state as a bug when the toggle is off), and when ON the time select should become usable; (d) the section explains itself in plain language. Toggle it back to its original state when done. FAIL if the toggle does nothing at all, gives no feedback, or the time select stays dead even with the ping ON.` },
  { id: 'tour',          taps: ["switchView('today')", "window._qaKeepTour=true; try{startTour();}catch(e){}"], test: `THE GUIDED TOUR (never tested). A tour overlay should now be running — typically a highlighted spot on the screen plus a tooltip/card explaining a feature, with Next/Skip controls. Verify: (a) the tour actually starts and the first step's text is readable and not clipped; (b) the highlight/spotlight lines up with the thing it is describing (not pointing at empty space or the wrong element); (c) tapping "Next" advances to a new step with new copy; advance through at least 3 steps; (d) a "Skip"/× exists and ENDS the tour cleanly, returning to a normal usable screen with no leftover dark overlay or blocked taps. FAIL if the tour does not start, a step's highlight points at the wrong element, Next does not advance, or Skip leaves the screen stuck/dimmed.` },
  { id: 'reload-persistence', reloadAfterTaps: true,
    taps: ["switchView('ideas')", `
      try {
        var snap = { brand: (currentBrand && (currentBrand.brand_name || currentBrand.id)) || '?',
                     total: state.length,
                     pending: state.filter(function(i){return i && i.status==='pending';}).length,
                     filming: state.filter(function(i){return i && i.status==='filming';}).length,
                     done: state.filter(function(i){return i && i.status==='done';}).length,
                     notes: (typeof notebookNotes!=='undefined' && notebookNotes) ? notebookNotes.length : -1 };
        localStorage.setItem('__qa_reload_snap', JSON.stringify(snap));
      } catch(e) {}
    `],
    postReload: `
      var out = { __ran: 'started' }; window._qaProof = out;
      try {
        var before = JSON.parse(localStorage.getItem('__qa_reload_snap') || 'null');
        if (!before) { out.reload = 'no pre-reload snapshot'; }
        else {
          var nowBrand = (currentBrand && (currentBrand.brand_name || currentBrand.id)) || '?';
          out.brandKept = (nowBrand === before.brand) ? 'WORKS (still ' + nowBrand + ')'
                                                      : 'BROKEN — brand changed on reload: ' + before.brand + ' -> ' + nowBrand;
          var t = state.length,
              p = state.filter(function(i){return i && i.status==='pending';}).length,
              fl = state.filter(function(i){return i && i.status==='filming';}).length,
              d = state.filter(function(i){return i && i.status==='done';}).length;
          out.ideasKept  = (t === before.total) ? 'WORKS (' + t + ')' : 'BROKEN — total ' + before.total + ' -> ' + t;
          out.statusKept = (p === before.pending && fl === before.filming && d === before.done)
            ? 'WORKS (pending/filming/done unchanged)'
            : 'BROKEN — pending ' + before.pending + '->' + p + ', filming ' + before.filming + '->' + fl + ', done ' + before.done + '->' + d;
          var nn = (typeof notebookNotes!=='undefined' && notebookNotes) ? notebookNotes.length : -1;
          out.notesKept = (nn === before.notes) ? 'WORKS (' + nn + ')' : 'BROKEN — notes ' + before.notes + ' -> ' + nn;
          try { localStorage.removeItem('__qa_reload_snap'); } catch(e) {}
        }
      } catch(e) { out.reload = 'ERROR ' + e.message; }
    `,
    test: `RELOAD PERSISTENCE — never tested before, and it is the app's core promise: your approvals and content must survive a refresh. The harness has ALREADY captured the state, reloaded the page, and re-measured. Do NOT click anything to redo this. Read facts.PROOF and report every key:value pair VERBATIM. Keys: brandKept, ideasKept, statusKept, notesKept. Each says WORKS or BROKEN with the before->after numbers. status=pass only if ALL say WORKS. Any BROKEN is a SERIOUS bug — put it in bugs and fail: it means a user's approved posts, pipeline stages, notes, or even their active brand silently reset on refresh. If facts.PROOF is missing or only has __ran, say the probe died and fail.` },
  { id: 'remix-sources', budget: 16, waitMs: 120000, taps: ["switchView('create')", "window._qaKeepMoreSheet=false; try{remixToggleManual&&remixToggleManual();}catch(e){}"], test: `REMIX SOURCE LANES — Remix accepts five kinds of source (TikTok link, YouTube link, Article URL, pasted text, uploaded file) and EACH goes through a DIFFERENT backend fetcher. Only the pasted-text lane has ever been tested, so a broken YouTube or Article fetcher would be invisible. The manual panel should now be unfolded, showing source tabs.
Test the ARTICLE lane and the YOUTUBE lane (skip File — it needs a real upload):
STEP 1 — ARTICLE: tap the Article/URL source tab, paste this into its field: https://en.wikipedia.org/wiki/Electrolyte and tap its fetch/extract button. WAIT (this calls a real extractor). It must fill the description/transcript box with actual readable article text about electrolytes — not stay empty and not show a raw error.
STEP 2 — YOUTUBE: tap the YouTube source tab, paste https://www.youtube.com/watch?v=dQw4w9WgXcQ and tap Get Transcript. WAIT. Either real transcript text appears, OR a CLEAR, human error explaining it could not get a transcript for that video. A vague failure or silent nothing is a BUG.
For each lane say in "observed" which one you tried and exactly what came back. FAIL if a lane silently does nothing, leaves the box empty with no message, or shows a raw/technical error dump. If a fetch returns a clear "couldn't read that link" message, that is acceptable handling — note it and pass that lane.` },
  // waitMs 330s: /api/crawl-brand and /api/crawl-social have maxDuration 300 in vercel.json and this
  // test itself says the crawl "can take 1-2 MINUTES" — the 75s default gave up mid-request, the
  // driver's next turn saw a still-spinning button and reported "spins forever with no resolution".
  { id: 'settings-autofill', budget: 18, waitMs: 330000, taps: ["openBrain()"], test: `BRAND-BRAIN AUTO-FILL — three separate real crawlers ("Scan my whole site", "From my social posts", "Pull customer reviews"), NONE of which has ever been tested. Each hits its own backend and can take 1-2 MINUTES. The Brand Voice settings should now be open.
Find the auto-fill method buttons. Run ONE of them — prefer "Scan my whole site" — and WAIT patiently through the loading state (the harness waits for the network; do not give up early and do not tap it twice).
Verify: (a) the button shows a live working/progress state, not a frozen or silent button; (b) when it finishes you get either a REVIEW panel listing what it found for each field with keep/discard controls, OR filled fields, OR a CLEAR message saying it could not read the site; (c) nothing is left stuck on "scanning" forever. If a review panel appears, confirm the found values are real text about THIS brand and not empty or placeholder.
FAIL if the button does nothing, spins forever with no resolution, or errors with a raw/technical message. If it finishes with a clear explanation that it needs a website URL first, that is correct handling — note it and pass.` },
  { id: 'carousel-maker', budget: 16, taps: ["switchView('ideas')", "if(typeof setIdeaStatus==='function')setIdeaStatus('pending');"], test: `MAKE SLIDES / carousel maker — a whole feature that has never been exercised. Find a CAROUSEL idea in the list (the format tag says Carousel; its card also shows a small "Slides" capsule). If none is visible, use the format filter chips to show carousels. Open one and tap "Make Slides".
Verify: (a) a slide editor/preview opens showing MULTIPLE distinct slides built from the idea, not one blank canvas; (b) the slide text is the idea's real content, correctly split across slides, not truncated mid-word or overflowing its frame; (c) controls to move between slides work; (d) a download/export control exists. Tap through at least two slides.
FAIL if Make Slides does nothing, opens empty, renders text that overflows or is cut off, or the slides are all identical. Do NOT tap download repeatedly. If NO carousel idea exists on this brand at all, report blocked and say so.` },
  { id: 'proof-taptargets', taps: ["switchView('ideas')", `
    var out = { __ran: 'started' }; window._qaProof = out;
    // LAYERING CHECK — deterministic, no vision needed. Every "fix" for a covered button has so far
    // been a REASONED guess that only a later run could disprove. This walks the real controls and
    // asks the browser directly: at this button's own centre, is this button the topmost element?
    try {
      function topAt(el){
        var r = el.getBoundingClientRect();
        if (!r.width || !r.height) return 'ZERO-SIZE';
        if (r.bottom < 0 || r.top > innerHeight) return 'OFFSCREEN';
        var t = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
        if (!t) return 'NOTHING';
        if (t === el || el.contains(t) || t.contains(el)) return '';
        return (t.className && typeof t.className === 'string')
          ? '.' + t.className.trim().split(/\\s+/).slice(0,3).join('.')
          : t.tagName;
      }
      function check(label, el){
        if (!el) { out[label] = 'not rendered'; return; }
        var c = topAt(el);
        out[label] = c ? ('COVERED BY ' + c) : 'clear';
      }
      // visible, always-present controls
      check('navMoreTab', document.querySelector('.nav-tab.more-tab'));
      check('headerSettings', document.querySelector('.header-btn[title="Settings"]'));
      check('headerBookmarks', document.getElementById('bmBarToggle'));
      check('brandSwitcher', document.querySelector('.header-brand'));
      var firstCard = document.querySelector('.list-card');
      check('ideaApprove', firstCard && firstCard.querySelector('.action-circle'));
      // batch bar (needs select mode)
      try {
        if (typeof toggleIdeaSelectMode === 'function') {
          toggleIdeaSelectMode();
          check('batchSelectAll', document.querySelector('.batch-all'));
          check('batchApproveBtn', document.querySelector('.batch-go'));
          toggleIdeaSelectMode();
        }
      } catch(e) { out.batchSelectAll = 'ERROR ' + e.message; }
      // the two overlays whose close buttons keep getting reported as unreachable
      try {
        if (typeof openBrandVoice === 'function') {
          openBrandVoice(false);
          var _seen = [];
          [0, 150, 400, 900].forEach(function(d){
            setTimeout(function(){
              try { var c = topAt(document.querySelector('.bv-close')); _seen.push(d + 'ms:' + (c ? 'COVERED BY ' + c : 'clear')); } catch(_){}
            }, d);
          });
          setTimeout(function(){
            try {
              window._qaProof.assistantClose = _seen.join(' | ');
              // does a REAL click on the × actually close it?
              var x = document.querySelector('.bv-close');
              if (x) x.click();
              setTimeout(function(){
                try {
                  var ov = document.getElementById('bvOverlay');
                  var open = ov && ov.style.display !== 'none' && ov.offsetParent !== null;
                  window._qaProof.assistantCloseWorks = open ? 'BROKEN — clicked the x, overlay still open' : 'WORKS — x dismissed it';
                  if (open && typeof closeBrandVoice === 'function') closeBrandVoice();
                } catch(e) { window._qaProof.assistantCloseWorks = 'ERROR ' + e.message; }
              }, 500);
            } catch(e) { try { window._qaProof.assistantClose = 'ERROR ' + e.message; } catch(_){} }
          }, 1100);
          out.assistantClose = 'checking...';
          out.assistantCloseWorks = 'checking...';
        }
      } catch(e) { out.assistantClose = 'ERROR ' + e.message; }
    } catch(e) { out.tapTargets = 'ERROR ' + e.message; }
  `], test: `TAP-TARGET LAYERING PROOF — the taps already asked the browser, for each real control, whether that control is the topmost element at its own centre. No clicking needed; do NOT redo it by hand. Read facts.PROOF and report every key:value pair VERBATIM. Keys: navMoreTab, headerSettings, headerBookmarks, brandSwitcher, ideaApprove, batchSelectAll, batchApproveBtn, assistantClose. "clear" means the control is genuinely tappable; "COVERED BY .x" means something is painted over it and a real user's tap would hit .x instead — that is a REAL bug, put it in bugs and fail. "not rendered" is fine if that control legitimately isn't on this screen. If facts.PROOF has only __ran, say the probe died.` },
  { id: 'quick-post-formats', budget: 20, taps: ["switchView('today')", "window._tvSelectedFormat='video'; try{generateTodayTabPost();}catch(e){}"], test: `EACH FORMAT PRODUCES ITS OWN KIND OF POST — Quick Post renders a DIFFERENT result card per format, and a break in one would never show up if only one format is ever tested. A VIDEO post is generating now. Test EVERY format using the "Redo as" chips at the bottom of the result card to switch (each redo is a real generation — wait for each one). Cost is not a concern here; coverage is. Go through: VIDEO, STATEMENT, CAROUSEL, MICRO-LECTURE, Q&A, IMAGE/STATIC — six in total, in that order.
STEP 1 — VIDEO (already running): wait for the card, then verify it carries a SCRIPT (a spoken talk-track, not a caption) and a SHOT LIST, plus filming actions (Teleprompter, and B-roll if offered). FAIL if a video post has no script.
STEP 2 — STATEMENT: tap the "Statement" chip in the Redo as row, wait for the new card. A statement is a SHORT punchy line meant to be posted as text/image — verify it shows the statement text prominently and offers a text-post action (e.g. "Post it"). It should NOT be a long spoken script and should NOT show a shot list. FAIL if statement output is just a video script relabelled.
STEP 3 — CAROUSEL: tap the "Carousel" chip, wait. A carousel is MULTI-SLIDE — verify the card shows slide-by-slide content (several distinct slides/points, not one paragraph) and offers "Make Slides". FAIL if a carousel comes back as a single block with no slide structure.
STEP 4 — MICRO-LECTURE: must be a spoken teaching script (like video, but a single tight lesson) — verify it has a script. STEP 5 — Q&A: must clearly pose a question and answer it. STEP 6 — IMAGE/STATIC: must be short on-image text with a caption, NOT a long script.
For each format, note in "quality" whether the output genuinely SUITS that format. Judge shape and structure, not taste. If a generation errors, cite the captured API error and report blocked rather than fail.` },
  { id: 'repeat-output', taps: ["switchView('today')"], test: `OUTPUT VARIETY — does generating twice give genuinely different content, or the same post reworded? STEP 1: tap the big lavender circle, WAIT for the post card, and READ + remember its title/hook/topic. STEP 2: tap "Try Another" (or the circle again) to generate a SECOND post and wait. STEP 3: COMPARE the two. They must be genuinely different ideas — a different angle/topic, not the same idea with swapped words. Note both titles in your observed field. FAIL if the two posts are essentially the same idea (same topic AND same angle), which would mean the anti-repetition is broken. PASS if they are clearly distinct posts. If a generation errors, cite the captured API error and report blocked rather than fail.` },
  { id: 'idea-actions',  taps: ["switchView('ideas')", "if(typeof setIdeaStatus==='function')setIdeaStatus('pending');"], test: `THE IN-CARD ACTION BUTTONS on a PENDING idea (these are never otherwise tested). Tap a pending idea card's title to EXPAND it — a detail panel opens with action buttons. Verify the expanded panel shows the refine actions and then TEST TWO of them for real: (a) "Sharpen" — FIRST read and remember the card's hook/script text word-for-word, THEN tap Sharpen, wait, and read the new text. It rewrites in place (no popup) with a toast. Do not just check that it changed: note in "quality" how the sharpened version compares to what you memorised (tighter? blander? about the same?) — that note is for the owner to read, not a verdict. FAIL only if the text is IDENTICAL to before (nothing happened) or it dropped a concrete fact/number the original had; (b) "Viral Twist" (⚡) — tap it, wait, and confirm a panel of angle options appears below the card. Note in "quality" whether the angles read as genuinely different takes or the same idea relabelled. Then apply one via "Use this version" and confirm the card's content is REPLACED. FAIL only if no angles appear, the angles are word-for-word duplicates of each other, or applying one leaves the card unchanged — whether the new hook is "better" is the owner's call, not yours. ALSO confirm these buttons merely EXIST and are not dead: "Redo with notes" (opens a note box) and "Generate More". Note facts before/after. FAIL if the card will not expand, if Sharpen or Viral Twist does nothing at all (no toast, no change, no panel) after waiting, or if a button is visibly present but produces no reaction. If a generation errors, cite the captured API error.` },
  { id: 'pipeline-tools', taps: ["switchView('pipeline')"], test: `THE PIPELINE POST TOOLS (untested until now). Open an APPROVED post in Film & Post by tapping its title. In the expanded detail verify the work tools are present and REACT when tapped: (a) "Teleprompter" — tap it; a full-screen dark teleprompter overlay must open showing the script with a big Record button; verify the script text is readable and then CLOSE it (× / close) and confirm you return to Pipeline. Do NOT record. (b) If the post is a carousel, "Make Slides" should be present; if it is video/micro/qna, "B-roll" should be present — tap whichever exists and confirm it opens its panel/preview (B-roll may take 15-40s to generate a graphics track; if it errors, cite the captured API error). Also confirm "Sharpen" exists on approved posts. There is NO publish/share control in the app any more — posting is done by hand — so do not look for one. FAIL if the teleprompter will not open or will not close, or a present tool button does nothing at all.` },
  // waitMs 120s: /api/pull-trends has maxDuration 60 and the test tells the driver to wait "up to 60s".
  { id: 'trends', waitMs: 120000, taps: ["toggleMoreSheet()", "moreGo('viral')"], test: `THE TRENDS PULL + TEACH controls (the Trends screen's WATCH half — the analyzer is covered by viral-lab). v646 changed this screen's LAYOUT: it now has TWO TABS — "What's rising" (the default, correctly highlighted) and "Analyze a video" (secondary, covered by the viral-lab feature). So: (a) CONFIRM THE TABS FIRST — both tabs are present and "What's rising" is the active/highlighted one on arrival. Report a fail if the tabs are missing or if "Analyze a video" is the default. (b) A "Worth making yours" strip of real posts with @handles and like/repost numbers may appear at the top of this tab — if present, confirm each has a "Make it mine →" button; its ABSENCE IS FINE AND NOT A FAIL (it only fills once the nightly pull returns engagement data). (c) tap "Analyze a video" and confirm the panel SWITCHES to a paste box, then tap "What's rising" to come back — both directions must work. (d) back on "What's rising", an "Auto-pulled" panel lists trend chips (or, for a brand with no trends yet, an explanatory "No trends yet" message — that is CORRECT, just verify it explains itself) (each may have a source link and an × to dismiss); a window selector "Only the last: 24h / 48h / 1 week / 1 month" is present — tap a DIFFERENT window and confirm the selection visibly changes (lavender active state). (e) if a "Competitor moves" panel is present, confirm it renders readable bullets with source links, not raw unformatted text. (f) tap "Pull fresh trends" and WAIT (up to 60s) — it must either add trend chips and toast a count, or show a clear, specific message (a vague failure with no explanation is a UX bug). FAIL if the fold does not open, the pull button does nothing, the window chips do not respond, or the screen shows raw/garbled text.` },
  { id: 'brand-switch',  taps: ["switchView('today')"], test: `BRAND SWITCHING (multi-brand isolation — never tested before). Note the ACTIVE BRAND name in the header and facts.ideas.total. Tap the brand name/▾ chip in the top-left header — a dropdown of brands should open. If TWO OR MORE brands are listed: pick a DIFFERENT one and wait for the app to reload its data, then verify (i) the header now shows the new brand, (ii) facts.ideas.total CHANGED or the visible cards clearly belong to the other brand, and (iii) NO content from the previous brand is left on screen (that would be a data-bleed bug — report it loudly). Then switch BACK to the original brand and confirm it restores cleanly. If only ONE brand exists, verify the dropdown opens and lists it plus an add-brand option, then close it — report blocked (cannot test switching with one brand). FAIL if the dropdown will not open, the switch leaves mixed content from two brands, or the app errors during the switch.` },
  { id: 'flow-post-to-done', taps: ["switchView('today')"], test: `END-TO-END MONEY PATH — one post from birth to Done, across three screens. Note facts.ideas BEFORE starting. STEP 1: on the Quick Post home, tap the BIG lavender circle and WAIT for the post card (15-40s; witty lines cycle). STEP 2: on the result card tap Approve (if a "what made this one land?" popup opens, pick one tag and Save, or Skip). facts.ideas.filming should now be +1 vs before. STEP 3: switchView to Pipeline (bottom nav "Pipeline") — the new post should be findable in Film & Post. Open it, confirm it has real content (hook/script), then tap "Mark Done ✓". facts.ideas.done should be +1 and facts.ideas.filming back down. Give a verdict on the WHOLE journey: each handoff (generate→approve→pipeline→done) must work and be visually traceable. FAIL if generation never completes, approve doesn't move it (per facts), the post can't be found in Pipeline, or Mark Done doesn't move it to Done (per facts).` },
  { id: 'flow-question-to-idea', taps: ["toggleMoreSheet()", "moreGo('questions')"], test: `CROSS-FEATURE FLOW — a real search question becomes an idea in the library. Note facts.ideas.total BEFORE. STEP 1: on the Questions screen, questions should be loaded (if empty, tap the fetch/pull control and wait). STEP 2: pick ONE question and tap "Answer this" — wait for generation (15-40s). If it errors, retry ONCE; cite any captured API error in your verdict. STEP 3: on success facts.ideas.total should be +1. switchView to Ideas and confirm a new card matching that question's topic exists (it may be under "Just generated"). FAIL if questions never load, generation fails twice (name the API error from the captured-errors line if present), or the idea never appears in facts/the Ideas list.` },
  // CONTENT HARVEST — the feature that stops Jörgen being the screenshot pipeline.
  //
  // Every output defect found by hand on 2026-08-29/30 was MEASURABLE (verbless fragments, no
  // connectives, 44 words against a 90-word floor, three sentences opening the same way, a script
  // that toured the product). Each needed him to film a take and send a screenshot, and each time
  // I diagnosed from a single sample. This generates across brands AND formats, captures the real
  // script text, and hands back numbers plus the verbatim scripts.
  //
  // NO VISION: this is measurement, not judgement, so it sets its own verdict and never reaches the
  // vision driver — which has a track record of being confidently wrong about content (it once
  // decided Boring Electrolytes was a sourcing company). Taste stays with Jörgen; the report gives
  // him every script side by side instead of one screenshot at a time.
  //
  // Reads window._tvIdea (the structured idea generateTodayTabPost stores) rather than scraping the
  // DOM — same data, no selector drift. Top-level await is a SyntaxError inside new Function, so
  // all the awaiting happens in an async IIFE that flips _qaContent.status when it is finished.
  { id: 'content-quality', contentHarvest: true, harvestMs: 480000, taps: [`
    window._qaContent = { status: 'running', items: [], errors: [], startedAt: Date.now() };
    (async function () {
      var C = window._qaContent;
      var FMTS = (window._qaFormats || ['video', 'micro', 'qna']);
      function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
      try {
        var all = (window.allBrands || []);
        if (!all.length) { C.status = 'error'; C.errors.push('no brands loaded'); return; }
        var startBrand = (window.currentBrand || {}).id || null;
        var brands = all.slice(0, Number(window._qaBrandCount || 2));
        for (var b = 0; b < brands.length; b++) {
          var name = brands[b].brand_name || brands[b].id;
          try { await switchBrand(brands[b].id); await wait(2500); }
          catch (e) { C.errors.push('switchBrand ' + name + ': ' + (e && e.message)); continue; }
          try { switchView('today'); await wait(1200); } catch (e) {}
          // Capture this brand's OWN vocabulary while we are switched to it. Node then checks that
          // brand A's distinctive terms never surface in brand B's scripts — a cross-brand leak is
          // the one defect class here with real consequences (a customer reading another brand's
          // facts in their post), and this app has had several: blog/PAA bleeding through a shared
          // localStorage bucket, the coach fed the previous brand's post, switch races writing one
          // brand's library under another's id.
          try {
            var bc = (typeof getBrandContext === 'function') ? getBrandContext() : {};
            C.ctx = C.ctx || {};
            C.ctx[name] = [bc.brandName, bc.usps, bc.painPoints, bc.productDetails, bc.brandVocab,
                           bc.competitors, bc.tagline, bc.targetAudience].filter(Boolean).join(' ');
          } catch (e) {}
          for (var f = 0; f < FMTS.length; f++) {
            var fmt = FMTS[f];
            try {
              window._tvSelectedFormat = fmt;
              window._tvIdea = null; window._todayTabIdea = null;
              await generateTodayTabPost();
              var i = window._tvIdea || window._todayTabIdea || null;
              C.items.push({
                brand: name, format: fmt, got: !!i,
                // Which brand the APP thought it was on at the moment of generation. If this ever
                // differs from the brand we switched to, a switch race wrote to the wrong brand —
                // that is a hard bug, not a content opinion, and it is invisible from a screenshot.
                actualBrand: String(((window.currentBrand || {}).brand_name) || ''),
                title: i ? String(i.title || '') : '',
                hook: i ? String(i.hook || '') : '',
                script: i ? String(i.script || i.boldText || '') : '',
                caption: i ? String(i.caption || '') : ''
              });
            } catch (e) {
              C.items.push({ brand: name, format: fmt, got: false, error: String((e && e.message) || e).slice(0, 200) });
            }
            await wait(1200);
          }
        }
        if (startBrand) { try { await switchBrand(startBrand); } catch (e) {} }
        C.status = 'done';
      } catch (e) { C.status = 'error'; C.errors.push(String((e && e.message) || e).slice(0, 300)); }
    })();
  `], test: 'Deterministic content measurement — no vision verdict is produced for this feature.' },

  { id: 'shrimp', viewportShot: true, needsVision: true, taps: ["switchView('today')", "window._qaKeepMascot=true; try{if(typeof mascotDismiss==='function')mascotDismiss();}catch(e){} setTimeout(function(){ try{ if(typeof window.mascotTap==='function') window.mascotTap(); }catch(e){} }, 900);"], test: `Shrimp mascot bubble design + brain-fill flow (v581-586). The taps open the bubble by tapping the mascot (nothing is faked — judge the REAL state of this brand). A speech bubble must be OPEN above the shrimp (bottom-right). ALWAYS VERIFY THE CHROME (this is the v581 work): (i) a small round shrimp AVATAR plus a label starting "Shrimp" in the bubble header, (ii) a speech TAIL pointing down at the mascot, (iii) readable body text, (iv) tappable buttons — it must NOT look like a plain generic system box. THEN, whichever bubble you got, check it is coherent: if it is the SCAN bubble it says "Let me go deeper" about digging into the website/socials with "Go deeper →" + "I'll type it in" (tap "I'll type it in" — NEVER "Go deeper →", that starts a 2-minute crawl — and a QUESTION bubble should follow: header "Shrimp · brand brain N%", ONE bold brand-field name, a muted benefit line about posts getting sharper, and Answer + Later). If instead you get the QUESTION bubble directly, verify those same parts. If the brand brain is already FULL, the shrimp legitimately shows a general tip/coach bubble instead — that is CORRECT, not a failure; just verify the chrome and say which bubble appeared. Do NOT tap "Answer" (it opens the Assistant). FAIL ONLY IF: no bubble opens at all, the avatar or tail is missing, or a button you tap does nothing.` },
];
// ── THE CRITICAL PATH ───────────────────────────────────────────────────────────────────────
// Jörgen, 2026-08-26: "if there is one thing that doesnt work then the whole app seems not
// working as all is connected experience." He is right, and it means a "16 passed / 12 failed"
// scoreboard is a MEANINGLESS metric — the app is one chain (open → generate → approve → film →
// post) and a single break makes it unusable. So this is the headline verdict: the chain either
// completes or the app does not work today. Everything else is secondary detail.
const CRITICAL_PATH = ['quick-post', 'approve-jump', 'pipeline', 'flow-post-to-done'];

const ONLY = (process.env.ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
let FEATURES = ONLY.length ? ALL_FEATURES.filter(f => ONLY.includes(f.id)) : ALL_FEATURES;
// content-quality generates across brands × formats, so it costs real credits and several minutes.
// It runs by DEFAULT because the whole reason it exists is to stop content problems only surfacing
// when a human films a take. SKIP_CONTENT=1 drops it when the run is about a button, not the writing.
// Explicitly naming it in ONLY always wins over the skip.
if (process.env.SKIP_CONTENT === '1' && !ONLY.includes('content-quality')) {
  FEATURES = FEATURES.filter(f => f.id !== 'content-quality');
}
// How much to harvest, without editing the file: QA_BRANDS=3 QA_FORMATS=video,micro
const _cq = FEATURES.find(f => f.id === 'content-quality');
if (_cq) {
  const _b = Number(process.env.QA_BRANDS || 2);
  const _f = (process.env.QA_FORMATS || 'video,micro,qna').split(',').map(s => s.trim()).filter(Boolean);
  _cq.taps = [`window._qaBrandCount = ${JSON.stringify(_b)}; window._qaFormats = ${JSON.stringify(_f)};`, ..._cq.taps];
}
// Run order: the critical chain FIRST (the answer that matters arrives before the long tail of
// detail), then everything else in declaration order, then anything flagged `runLast`.
// `runLast` exists because the old comparator only knew about CRITICAL_PATH: a feature whose comment
// said "LAST TEST ON PURPOSE" was ranked 999 like every other ordinary feature and, because sort is
// stable, simply kept its declaration position — 8th of ~30, not last. Exported-style helper so the
// verification script can execute the real ordering instead of eyeballing it.
function featureRank(f) {
  if (f && f.runLast) return 2000;
  const i = CRITICAL_PATH.indexOf(f && f.id);
  return i === -1 ? 999 : i;
}
FEATURES = [...FEATURES].sort((a, b) => featureRank(a) - featureRank(b));

// realistic text the QA engineer can paste where a feature needs input (override with SAMPLE=...)
const SAMPLE = process.env.SAMPLE ||
  "We help small e-commerce brands source products from vetted overseas suppliers without getting burned. Most founders lose money on their first 2-3 orders because they don't vet factories, skip sample checks, and wire deposits with no protection. Our process: shortlist 3 verified suppliers, order samples, inspect quality, then place a protected first order with milestone payments.";

const BLOCK = /publish|post now|check\s?out|buy|upgrade|subscribe|pay\b|delete|remove account|cancel plan|log ?out|sign ?out|send magic|confirm payment/i;

const SNAPSHOT = `(() => {
  function vis(el){var r=el.getBoundingClientRect();var c=getComputedStyle(el);return r.width>2&&r.height>2&&c.visibility!=='hidden'&&c.display!=='none'&&parseFloat(c.opacity||'1')>0.05;}
  document.querySelectorAll('[data-ai]').forEach(e=>e.removeAttribute('data-ai'));
  /* modal/bubble controls FIRST — they sit at the END of the DOM, so on busy screens the 55-cap cut
     them out of the element tree and the driver literally could not tap Skip/Answer/Generate-anyway */
  var pri=[].slice.call(document.querySelectorAll('.dismiss-popup button,.dismiss-popup [onclick],.dp-backdrop [onclick],.mascot-bubble button,.brv-sheet button,.more-sheet [onclick],.angle-sheet [onclick],.angle-sheet button')).filter(vis);
  var rest=[].slice.call(document.querySelectorAll('button,a,input,textarea,select,[role=button],[onclick]')).filter(vis).filter(function(e){return pri.indexOf(e)<0;});
  var els=pri.concat(rest).slice(0,55);
  var out=[]; els.forEach(function(el,i){ el.setAttribute('data-ai',i);
    var t=(el.innerText||el.value||el.placeholder||el.getAttribute('aria-label')||el.title||'').replace(/\\s+/g,' ').trim().slice(0,48);
    out.push({i:i, tag:el.tagName.toLowerCase(), type:el.type||'', label:t, disabled:!!el.disabled}); });
  var av=document.querySelector('.view.active'); var active=av?(av.id||''):'';
  var head=''; var h=document.querySelector('.view.active h1,.view.active h2,h1,h2'); if(h)head=(h.innerText||'').trim().slice(0,80);
  var mainEl=document.querySelector('.view.active')||document.body; var mainText=(mainEl.innerText||'').replace(/\\s+/g,' ').trim().slice(0,1600);
  var busy=/generating|thinking|working|loading|writing|cooking|analyz|please wait/i.test(mainText);
  var toasts=[].slice.call(document.querySelectorAll('body *')).filter(function(e){try{var c=getComputedStyle(e);if(c.display==='none'||c.visibility==='hidden')return false;var s=(e.className||'')+' '+(e.id||'');return /toast|error|alert|notice|banner|empty/i.test(s);}catch(x){return false;}}).map(function(e){return (e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,300);}).filter(Boolean).slice(0,3);
  var brand=''; try{ var bb=document.querySelector('[onclick*="toggleBrandSwitcher"]'); if(bb) brand=(bb.innerText||'').replace(/\\s+/g,' ').replace(/[·▾▼|].*$/,'').trim().slice(0,40); }catch(x){}
  var modalTxt=''; try{ var ms=[].slice.call(document.querySelectorAll('body *')).filter(function(e){try{var c=getComputedStyle(e);if(c.position!=='fixed'&&c.position!=='absolute')return false;if(c.display==='none'||c.visibility==='hidden'||parseFloat(c.opacity||'1')<0.6)return false;var r=e.getBoundingClientRect();return r.width>innerWidth*0.6&&r.height>innerHeight*0.35&&(parseInt(c.zIndex)||0)>=10;}catch(x){return false;}}); if(ms.length){modalTxt=(ms[ms.length-1].innerText||'').replace(/\\s+/g,' ').trim().slice(0,90);} }catch(x){}
  /* GROUND-TRUTH facts from the app's real state — the driver must trust these over counting
     cards by eye (vision counting caused false "counts never changed" bugs). */
  var facts={}; try{
    if(window._qaProof) facts.PROOF=window._qaProof;   /* direct-call results — authoritative, not a guess */
    if(typeof state!=='undefined' && Array.isArray(state)){
      facts.ideas={ total:state.length,
        pending:state.filter(function(i){return i&&i.status==='pending';}).length,
        filming:state.filter(function(i){return i&&i.status==='filming';}).length,
        done:state.filter(function(i){return i&&i.status==='done';}).length,
        dismissed:state.filter(function(i){return i&&i.status==='dismissed';}).length };
    }
    facts.visibleCards=document.querySelectorAll('.list-card,.pipeline-card,.pipe-done-row').length;
    if(typeof ideaStatusFilter!=='undefined') facts.ideaStatusFilter=ideaStatusFilter;
    if(typeof notebookNotes!=='undefined'&&Array.isArray(notebookNotes)) facts.notebookNotes=notebookNotes.length;
    if(typeof getBrainStats==='function'){ var bs=getBrainStats(); facts.brain=bs.filled+'/'+(bs.facets||14); }
  }catch(x){}
  return {activeBrand:brand, active:active, heading:head, busy:busy, modalOpen:!!modalTxt, modalText:modalTxt, resultText:mainText, toasts:toasts, facts:facts, elements:out};
})()`;

function loadEnv() {
  for (const f of ['.env', '.env.local']) {
    const p = path.join(__dirname, f); if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '').split(/\s+/)[0];
    }
  }
}
loadEnv();

function pickLLM() {
  const M = process.env.MODEL;
  const A = { name: 'Anthropic', kind: 'anthropic', url: 'https://api.anthropic.com/v1/messages',           key: process.env.ANTHROPIC_API_KEY, model: M || 'claude-sonnet-4-6' };
  const G = { name: 'Groq',      kind: 'openai',    url: 'https://api.groq.com/openai/v1/chat/completions', key: process.env.GROQ_API_KEY,      model: M || 'llama-3.3-70b-versatile' };
  const O = { name: 'OpenAI',    kind: 'openai',    url: 'https://api.openai.com/v1/chat/completions',      key: process.env.OPENAI_API_KEY,    model: M || 'gpt-4o-mini' };
  const X = { name: 'xAI',       kind: 'openai',    url: 'https://api.x.ai/v1/chat/completions',            key: process.env.XAI_API_KEY,       model: M || 'grok-4.6' };
  // Explicit override so you can force a provider even when another key is present (e.g. Anthropic out of credits):
  //   QA_PROVIDER=xai node mobile-user.js   (accepts xai|grok|x|groq|openai|anthropic|claude)
  const P = (process.env.QA_PROVIDER || process.env.PROVIDER || '').toLowerCase().trim();
  if (P) {
    const forced = (P === 'xai' || P === 'grok' || P === 'x') ? X : (P === 'groq') ? G : (P === 'openai') ? O : (P === 'anthropic' || P === 'claude') ? A : null;
    if (forced && forced.key) return forced;
    if (forced && !forced.key) console.log(`\n✗ QA_PROVIDER=${P} but its API key is missing in env/.env — falling back to auto.\n`);
  }
  // Auto (priority): xAI/Grok → OpenAI → Anthropic → Groq.
  // Grok is preferred (Jörgen funds it); Groq is llama = TEXT-ONLY (no vision) so it goes LAST —
  // a vision run needs xAI/OpenAI/Anthropic. Override any of this with QA_PROVIDER / MODEL.
  if (X.key) return X;
  if (O.key) return O;
  if (A.key) return A;
  if (G.key) return G;
  return null;
}

// DOES THE DRIVER ACTUALLY RECEIVE THE SCREENSHOT? A screenshot is attached only when this is true.
// The system prompt nevertheless opened with "You are shown a SCREENSHOT ... USE YOUR EYES", and
// NOTHING told a text-only driver (a Groq/llama fallback, or any custom MODEL=) that it was blind —
// so it answered visual questions ("is the tail missing?", "is anything dark-on-dark?") from the DOM
// JSON alone and produced confident, fabricated verdicts. Extracted as a named function so the
// verification script can EXECUTE the real predicate rather than grep for it.
function hasVision(llm) {
  if (!llm) return false;
  return llm.kind === 'anthropic' || /gpt-4o|grok|vision/i.test(String(llm.model || ''));
}

// Appended to the system prompt (LAST, so it overrides the "use your eyes" opening) when blind.
const NO_VISION_NOTICE = `

⛔ NO SCREENSHOT THIS RUN — YOU ARE BLIND. This driver model cannot receive images, so NO screenshot is attached to any turn. Ignore every instruction above that tells you to look at a screenshot or "use your eyes": there is nothing to look at.
You may judge ONLY from the screen JSON (elements, resultText, toasts, facts, modalText). That is enough to test FUNCTION — does the control exist, does the action fire, do the facts change, is the output text present, coherent, complete and on-topic.
It is NOT enough to test APPEARANCE. You must NOT claim anything about colour, contrast, dark-on-dark text, spacing, alignment, overlap, clipping, image/avatar/tail presence, or whether something "looks" broken. If the feature asks you for a visual judgement you cannot make, say so plainly in "observed" and set status=blocked with the reason "driver has no vision" — never guess, and never report a visual bug you did not see. Leave "ux" and "separation" as 'clean' unless the DOM itself proves an issue (e.g. text truncated mid-word in resultText).`;

async function askLLM(llm, system, user, imgB64) {
  const headers = { 'content-type': 'application/json' };
  let body;
  if (llm.kind === 'anthropic') {
    headers['x-api-key'] = llm.key; headers['anthropic-version'] = '2023-06-01';
    const content = imgB64
      ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imgB64 } }, { type: 'text', text: user }]
      : user;
    body = { model: llm.model, max_tokens: 900, system, messages: [{ role: 'user', content }] };
  } else {
    headers['authorization'] = 'Bearer ' + llm.key;
    const content = imgB64
      ? [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + imgB64 } }]
      : user;
    body = { model: llm.model, temperature: 0.4, messages: [{ role: 'system', content: system }, { role: 'user', content }], response_format: { type: 'json_object' } };
  }
  let r = await fetch(llm.url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok && llm.kind === 'openai') { delete body.response_format; r = await fetch(llm.url, { method: 'POST', headers, body: JSON.stringify(body) }); }
  if (!r.ok) throw new Error('LLM ' + r.status + ' ' + (await r.text()).slice(0, 160));
  const j = await r.json();
  return llm.kind === 'anthropic' ? (j.content && j.content[0] && j.content[0].text) : (j.choices && j.choices[0] && j.choices[0].message.content);
}

// pull the FIRST complete JSON object out of a model reply, ignoring code fences
// and any prose the model adds before/after (fixes "non-whitespace after JSON" crashes)
function extractJSON(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/```json/gi, '```').replace(/```/g, '');
  const i = s.indexOf('{'); if (i < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
    else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return s.slice(i, j + 1); }
  }
  return null;
}

const QA_SYSTEM =
`You are a senior QA engineer testing ONE feature of a mobile content app, acting as a real user. You judge FUNCTION, OUTPUT QUALITY, and DESIGN/UX/UI. You are shown a SCREENSHOT of the phone each turn — USE YOUR EYES.
BRAND CONTEXT: the app is set to one specific brand (given as "activeBrand", also visible in the header). Test AS THAT BRAND — write inputs in its world, and judge whether outputs are on-brand FOR IT. NEVER assume a different brand or product than the active one.
Method:
(1) Read the screen JSON + look at the screenshot.
(2) If a popup/sheet covers the screen (modalOpen=true), handle it FIRST — either use it (it may be part of the flow, e.g. a "why did this land?" feedback tagger — pick a tag) or close it (×/close/skip/not now). NEVER click behind a covering popup.
(3) If the feature needs text, TYPE REAL, SUBSTANTIAL, ON-BRAND content (use the SAMPLE if it fits the active brand) — never "test"/gibberish.
(4) Trigger the main action and WAIT (the harness waits for network to finish before your next turn).
(5) SCROLL to read the FULL result before judging — long posts/blogs extend below the fold.
(6) VERIFY + CRITIQUE: is the output coherent, specific, ON-BRAND for the active brand, correct language, right length, free of placeholders/repetition/AI-hype? AND is the SCREEN visually sound — no overlapping or cut-off text, no unclosable/blocking popup, no broken layout, tiny tap targets, or confusing flow? Vague/unhelpful error messages are UX bugs.
(6b) SECTION SEPARATION — report this on EVERY screen. Look hard at whether distinct labelled sub-parts inside a card or panel are visually SEPARATED. When a card stacks several sub-sections (e.g. Statement / Shooting Tips / Tags; Script / Shot List / On-Screen / Tags / Preview; a long column of settings fields), each should be set apart by a THIN DIVIDER line, a cream/tinted sub-panel, or clear spacing. If two or more sub-sections run together into one undifferentiated block with NO line/panel/gap between them, that IS a design problem: put it in the "separation" field (name which sections blend) and add it to bugs. If they are cleanly separated, say so.
(7) If a feature needs a prerequisite you don't have (e.g. an image/API key) → status=blocked, note the missing prerequisite (and flag a vague error as a bug). Give a verdict.
Each turn you get JSON {activeBrand, active, heading, busy, modalOpen, modalText, resultText (READ+JUDGE), toasts, numbered elements} + the screenshot. Choose ONE action.
Reply ONLY JSON:
{"thought":"...","action":"click|type|scroll|verdict","target":<number|null>,"text":"<for type — real, on-brand content>","verdict":{"status":"pass|fail|blocked","expected":"...","observed":"paraphrase the actual output","quality":"editor's judgement of the output","ux":"design/UX/UI issues you SAW, or 'clean'","separation":"'clear' if sub-sections are cleanly separated, else 'BLENDED: <name the sub-sections that run together with no divider/panel/gap>'","bugs":["specific issue","..."]}}
GROUND TRUTH: the screen JSON includes a "facts" object with the app's REAL internal counts (ideas by status, visible cards, notebook notes, brain fill). For ANY claim about counts, filters, or state changes, use facts — compare facts BEFORE vs AFTER your action. NEVER report "the count didn't change" or "the list didn't filter" from looking at the screenshot alone; if facts confirm the change happened, it happened.
STYLED TOGGLES: switches in this app (Dark Mode, Daily Idea Ping, and similar) are a real <input type="checkbox"> that is visually HIDDEN behind a styled track/knob span. They therefore often do NOT appear as their own numbered element. If you can SEE a switch on screen next to its label, it exists and works — click its label/row, and do NOT report it as "no toggle present" or "not exposed as an interactive control".
AMBIENT SHRIMP: a small shrimp mascot sits bottom-right, and its speech bubble (with a shrimp avatar header + a brand-brain question and Answer/Later buttons) can POP UP ON ITS OWN once per launch. That is a DESIGNED feature, not a bug — do NOT report the bubble's appearance as an issue, and if it covers something you need, tap its × or "Later" and continue.
OUTPUT — YOU CHECK FOR BREAKAGE, THE HUMAN JUDGES TASTE. Two separate jobs, do not mix them.
(A) BROKEN OUTPUT = FAIL. These are objective and you must fail them: a placeholder or template marker left in ("[insert", "Lorem", "{{", "TODO", "as an AI"); text visibly cut off mid-sentence; the wrong language; an empty or near-empty result where content was promised; the same sentence or idea repeated twice in one output; content about a clearly different topic than what was asked for. State which in "quality" and set status=fail.
(B) VOICE AND TASTE = REPORT ONLY, NEVER FAIL. Whether it "sounds on-brand", is punchy enough, or is a hook you would have written differently is the OWNER's call, not yours — he reads the saved output sample himself. Describe what you see in "quality" in one plain sentence (e.g. "reads generic, no specific number or example" or "concrete and specific, uses the brand's own product detail"), but do NOT set status=fail for it and do NOT list it under bugs. A working feature with bland output is a PASS with a quality note.
TRANSFORM FEATURES (Sharpen, Viral Twist, Redo with notes, Remix) — read and remember the BEFORE text, then read the AFTER text. FAIL only on objective regressions: the after is IDENTICAL to the before (the action did nothing), or it dropped a concrete fact/number the before had, or it is off-topic. Whether the new wording is "stronger" is taste — put that in "quality" as a note and pass.
COST DISCIPLINE — each generate costs real money. On a LIST where every row has its own generate-style button ("Answer this", "Develop", "Use this", "+"), trigger it on EXACTLY ONE row, then judge from that one result. NEVER walk down the list firing it on row after row: the second tap proves nothing the first did not and just burns credit. One generate per feature is the default; only generate twice when the feature explicitly asks you to compare two outputs.
Rules: type only into real text fields. NEVER click Publish, Checkout, Buy, Upgrade, Subscribe, Delete, or Log out. Generating is expected. Be a TOUGH reviewer. Verdict within ~${PER_FEATURE} actions. Missing controls / can't start = blocked.`;

const SYS = QA_SYSTEM + (DESKTOP ? `

DESKTOP LAYOUT MODE — the viewport is 1440px WIDE, this is NOT a phone. Judge DESKTOP visual consistency HARD and put every inconsistency in bugs + the separation field:
- Button SIZES uniform within a tier: all card-action buttons the same height/padding; flag any button that is randomly tiny, oversized, or a different shape than its siblings.
- Boxes / inputs / cards must FILL the content column — flag anything stuck at a narrow mobile width sitting in a wide empty space, or a card noticeably narrower/wider than its neighbours.
- Consistent spacing + alignment; main content should sit centered in its column, not hug one edge or stretch full-bleed across 1440px while siblings are constrained.
- The left sidebar nav should look intentional and the main panel should not look like a phone screen floating in a desktop window.` : '');

const results = [];   // {feature, status, expected, observed, bugs[], errors[], actions}
const allErrors = []; // hard console/JS/HTTP errors, tagged with feature
const PREV_FILE = path.join(__dirname, DESKTOP ? 'desktop-user-prev.json' : 'mobile-user-prev.json');
// Previous run's per-feature verdict + bugs. Fed back into the driver so every run explicitly
// REGRESSION-CHECKS the last one instead of starting blind — without this, a fix is never
// confirmed and a returning bug looks brand new.
let prevRun = {};
try { prevRun = JSON.parse(fs.readFileSync(PREV_FILE, 'utf8')) || {}; } catch (e) { prevRun = {}; }
const visualPrev = {};   // previous run's screenshot size per feature
const visualDrift = [];  // features whose screenshot changed a lot vs the previous run (layout break OR fix — eyeball prev-qa-*.png)

(async () => {
  const llm = pickLLM();
  if (!llm) { console.log('\n✗ No LLM key found (ANTHROPIC_API_KEY / GROQ_API_KEY / OPENAI_API_KEY / XAI_API_KEY) in env or ./.env\n'); process.exit(2); }
  console.log(`\nQA driver: ${llm.name} (${llm.model}) · ${FEATURES.length} features · up to ${PER_FEATURE} actions each\n`);

  // Decide ONCE whether this run can see, and say so out loud. A blind run is still useful for
  // FUNCTION, but it must not be allowed to invent visual verdicts (see NO_VISION_NOTICE), and the
  // purely-visual features are skipped as `blocked` rather than guessed.
  const visionOK = hasVision(llm);
  const SYS_RUN = visionOK ? SYS : SYS + NO_VISION_NOTICE;
  const _visualFeatures = FEATURES.filter(f => f.needsVision).map(f => f.id);
  if (!visionOK) {
    PREFLIGHT.push(`⚠️ NO VISION — the driver (${llm.name} / ${llm.model}) cannot receive screenshots. This run judges FUNCTION only; it must not be read as a design/contrast review.` +
      (_visualFeatures.length ? ` Purely-visual features skipped as blocked: ${_visualFeatures.join(', ')}. Re-run with QA_PROVIDER=xai|openai|anthropic for those.` : ''));
    console.log(`  ⚠️ driver has NO VISION — screenshots are not sent to ${llm.model}. Visual features will report blocked, not a guess.\n`);
  }

  try { const ping = await askLLM(llm, 'Reply with JSON only.', 'Reply exactly {"ok":true}'); if (!ping) throw new Error('empty response'); }
  catch (e) { console.log(`✗ LLM check failed for ${llm.name} (${llm.model}):\n  ${e.message}`); console.log(`  → verify the key, or try MODEL=claude-haiku-4-5-20251001 node mobile-user.js\n`); process.exit(2); }

  const browser = await chromium.launch({ headless: CI });
  const haveAuth = fs.existsSync(AUTH);
  const context = await browser.newContext(DESKTOP
    ? { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, storageState: haveAuth ? AUTH : undefined, recordVideo: { dir: OUT, size: { width: 1440, height: 900 } } }
    : { ...devices['iPhone 13'], storageState: haveAuth ? AUTH : undefined, recordVideo: { dir: OUT, size: { width: 390, height: 844 } } });

  await context.addInitScript(() => {
    try { localStorage.setItem('bc_tour_done', '1'); localStorage.setItem('cs_onb_hidden', '1'); } catch (e) {}
    try { window.__onbDismissed = true; } catch (e) {}
    var KILL = /finish these last fields|Welcome to Content Shrimp|Quick tour|WHAT EACH FIELD POWERS|Getting started\s*·|Almost there/i, SEL = '.tour-overlay,#csOnbCard,.pwa-banner,#pwaGuideOverlay';
    function nuke(){try{document.querySelectorAll(SEL).forEach(function(e){e.remove();});document.querySelectorAll('div').forEach(function(e){var t=e.textContent||'';if(t.length<600&&KILL.test(t)){var n=e;for(var i=0;i<6&&n&&n.parentElement;i++){var p=n.parentElement,pos='';try{pos=getComputedStyle(p).position;}catch(x){}if(pos==='fixed'||(p.className||'').toString().match(/overlay|modal|backdrop|onb/i)){p.remove();return;}n=p;}e.remove();}});}catch(e){}}
    var s=function(){nuke();try{new MutationObserver(nuke).observe(document.body,{childList:true,subtree:true});}catch(e){}setInterval(nuke,900);};
    if(document.body)s();else document.addEventListener('DOMContentLoaded',s);
  });

  if (process.env.QA_TRACE) await context.tracing.start({ screenshots: true, snapshots: true, sources: true }).catch(() => {}); // trace is opt-in (QA_TRACE=1) — the zip is ~700MB/run and filled the disk
  const page = await context.newPage();
  const video = page.video();

  // DECLARED HERE, BEFORE THE LISTENERS THAT READ THEM. The `requestfailed` handler below closes
  // over `current` and `IGNORE`; both used to be declared several lines LOWER, so the handler was
  // only safe because nothing navigates in that window — any request firing there would have thrown
  // a TDZ ReferenceError inside a page event handler.
  let current = 'boot';
  const IGNORE = /favicon|\.woff|fonts\.g|google-analytics|googletagmanager|doubleclick|hotjar|sentry|posthog|stripe\.com\/v3/i;

  // ── network-in-flight tracking → the real "wait for generation" ──
  let inflight = 0;
  const track = r => { try { if (r.url().includes('/api/')) inflight++; } catch (e) {} };
  const untrack = r => { try { if (r.url().includes('/api/')) inflight = Math.max(0, inflight - 1); } catch (e) {} };
  page.on('request', track); page.on('requestfinished', untrack); page.on('requestfailed', untrack);
  // A request that dies at the NETWORK level (timeout / connection reset / aborted on a slow line)
  // produces NO response, so the response handler never sees it — it was completely invisible and
  // left "The AI is having a moment" looking like a server bug. Log it as the real cause.
  page.on('requestfailed', r => { try { const u = r.url(); if (IGNORE.test(u) || (ORIGIN && !u.startsWith(ORIGIN))) return; const why = (r.failure() && r.failure().errorText) || 'request failed'; allErrors.push({ feature: current, kind: 'NETWORK FAIL', detail: u.replace(/\?.*/, '').replace(ORIGIN, '') + ' — ' + why }); } catch (e) {} });
  // WAITS AS LONG AS THE APP IS ALLOWED TO TAKE, and SAYS SO when it gives up.
  // The flat 75s default was below the app's own budgets (crawl-brand/crawl-social run to 300s in
  // vercel.json, and settings-autofill's own instructions say "1-2 MINUTES"), so the harness stopped
  // waiting while the request was still in flight, the driver's next turn saw a still-spinning button,
  // and it concluded "spins forever with no resolution" — a harness artifact filed as an app bug.
  // Features now declare `waitMs`; and a timeout is no longer silent — it returns a string the caller
  // pushes into the flow log, which the driver reads, so it can never be mistaken for app behaviour.
  const WAIT_IDLE_MS = parseInt(process.env.WAIT_IDLE_MS || '75000', 10);
  const waitIdle = async (maxMs = WAIT_IDLE_MS) => {
    const t0 = Date.now(); let quiet = Date.now();
    while (Date.now() - t0 < maxMs) {
      if (inflight > 0) quiet = Date.now();
      else if (Date.now() - quiet > 1400) return 'idle';
      await page.waitForTimeout(200);
    }
    return `HARNESS WAIT TIMEOUT after ${Math.round(maxMs / 1000)}s — ${inflight} request(s) still in flight; the harness stopped waiting, the APP may still be working. Do NOT report this as the app hanging.`;
  };

  page.on('pageerror', e => allErrors.push({ feature: current, kind: 'JS error', detail: (e && e.message || String(e)).slice(0, 160) }));
  // 5xx anywhere same-origin + ANY 4xx/5xx on /api/ — a 400/402/429 from a generate endpoint IS the
  // root cause of a "Failed to generate" toast, and hiding it forced guessing at credits/timeouts.
  page.on('response', r => { try { const s = r.status(), u = r.url(); if (IGNORE.test(u) || (ORIGIN && !u.startsWith(ORIGIN))) return; const isApi = /\/api\//.test(u); if (s >= 500 || (isApi && s >= 400)) allErrors.push({ feature: current, kind: 'HTTP ' + s, detail: u.replace(/\?.*/, '').replace(ORIGIN, '') }); } catch (e) {} });

  await page.goto(APP, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const isLogin = () => page.evaluate(() => /Send Magic Link|Enter your email to start/i.test(document.body.innerText)).catch(() => false);
  const isApp = () => page.evaluate(() => (!!document.querySelector('.view,[onclick*="switchView"],#view-today')) && !/Send Magic Link|Enter your email to start/i.test(document.body.innerText)).catch(() => false);
  let ready = false;
  for (let i = 0; i < 10; i++) { await page.waitForTimeout(1200); if (await isApp()) { ready = true; break; } if (await isLogin()) break; }
  if (!ready && await isLogin() && CI) {
    // unattended run can't log in — write a note + notify instead of hanging
    fs.writeFileSync(REPORT, `# QA pass (scheduled) — ${new Date().toISOString().slice(0,16).replace('T',' ')}\n\n⚠️ Saved login expired — scheduled run skipped.\nRun \`node mobile-user.js\` once interactively to refresh the login, then scheduled runs resume automatically.\n`);
    try { require('child_process').execSync('osascript -e \'display notification "Login expired — run: node mobile-user.js" with title "Content Shrimp QA"\''); } catch (e) {}
    console.log('Scheduled run: session expired — refresh with one interactive run.');
    try { await context.close(); } catch (e) {} try { await browser.close(); } catch (e) {}
    process.exit(2);
  }
  if (!ready && await isLogin()) {
    console.log('\n============================================================');
    console.log(haveAuth ? ' Saved login expired — need a fresh magic link.' : ' Log in to start.');
    console.log(' Phone window: email → Send Magic Link → open email, COPY the link,');
    console.log(" PASTE it into that window's address bar + Enter. When you SEE the app,");
    console.log(' come back here and press ENTER.');
    console.log('============================================================\n');
    await new Promise(r => process.stdin.once('data', r));
    for (let i = 0; i < 8; i++) { await page.waitForTimeout(1200); if (await isApp()) { ready = true; break; } }
    try { await context.storageState({ path: AUTH }); console.log('(login saved)\n'); } catch (e) {}
  }

  // WHICH BUILD IS THIS RUN ACTUALLY TESTING? The sim always hits the LIVE site, so a run started
  // before deploying tests the PREVIOUS build — and every past report was silent about which one,
  // making "is this a real bug or one I already fixed?" unanswerable after the fact. Record it.
  //
  // THIS MUST RUN ON EVERY RUN. It used to live INSIDE the "saved login expired" branch above, so a
  // normal run with valid auth skipped it entirely: the report said "Live build tested: unknown" and
  // the stale-deploy / stale-backend guards — the whole point of preflight — never executed.
  if (ready) {
  try {
    LIVE_VERSION = await page.evaluate(() => window.APP_VERSION || 'unknown');
    console.log(`\n▶ TESTING LIVE BUILD: ${LIVE_VERSION}  —  if this is not the build you just deployed, STOP and deploy first.\n`);
  } catch (e) { LIVE_VERSION = 'unknown'; }

  // ── PREFLIGHT ──────────────────────────────────────────────────────────────────────────────
  // Every hour lost this session came from an INFRASTRUCTURE fault the run could not see, so it
  // reported app bugs that were nothing of the kind: a stale deploy (testing code already fixed),
  // a stale backend, a dead cron, or the AI provider being down (which turns every generate
  // feature into a false failure). The run now checks all of that FIRST and says so out loud.
  try {
    const localApp = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');
    const localVer = (localApp.match(/APP_VERSION = '(v\d+)'/) || [])[1] || 'unknown';
    let localBuild = 'unstamped';
    try { localBuild = require('./api/_build.js'); } catch (_) {}

    // what the SERVER is actually running (public, no auth needed)
    let liveBuild = 'unknown', cfg = {};
    try {
      const h = await page.evaluate(async () => {
        try { const r = await fetch('/api/health'); return await r.json(); } catch (e) { return null; }
      });
      if (h) { liveBuild = h.build || 'unstamped'; cfg = h; }
    } catch (_) {}

    if (localVer !== LIVE_VERSION)
      PREFLIGHT.push(`🔴 STALE DEPLOY — you built ${localVer} but the live site is serving ${LIVE_VERSION}. Every "fail" below may already be fixed on disk. Deploy, then re-run.`);
    else
      PREFLIGHT.push(`✅ Frontend current — live build ${LIVE_VERSION} matches local.`);

    if (liveBuild !== 'unknown' && localBuild !== 'unstamped' && liveBuild !== localBuild)
      PREFLIGHT.push(`🔴 STALE BACKEND — api/_build is ${liveBuild} live vs ${localBuild} local. API fixes (timeouts, prompts, logging) are NOT running.`);
    else if (liveBuild !== 'unknown')
      PREFLIGHT.push(`✅ Backend current — /api/health build ${liveBuild}.`);

    // /api/health already knows what is misconfigured or missing — surface ALL of it rather than
    // waiting for a feature to fail mysteriously downstream.
    const failing = (cfg && Array.isArray(cfg.failing)) ? cfg.failing : [];
    if (failing.includes('config_xai_key'))
      PREFLIGHT.push('🔴 NO XAI KEY on the server — every generate feature will fail. Not an app bug.');
    const others = failing.filter(f => f !== 'config_xai_key');
    if (others.length)
      PREFLIGHT.push(`⚠️ Server self-check reports ${others.length} problem(s): ${others.join(', ')} — features that depend on these will fail SILENTLY, not loudly.`);
    else if (cfg && cfg.failing)
      PREFLIGHT.push('✅ Server self-check clean — keys, tables and crons all present.');

    // ── STALE CDN EDGE — the failure NOTHING above can see ────────────────────────────────
    // Caught live on the v613 deploy: the deployment was correct (contentshrimp.com/CLAUDE.md
    // had correctly gone 404, so the build WAS live) and contentshrimp.com/sw.js still returned
    // BUILD 'v606', while contentshrimp.com/sw.js?cachebust=613 returned 'v613-f521aede'. Same
    // origin, same second — a shared CDN cache pinning a seven-version-old service worker.
    // The ENTIRE update mechanism is "the browser refetches /sw.js and sees different bytes", so
    // every phone would have kept the old app forever: the fix deployed and permanently invisible.
    // The STALE DEPLOY check above cannot see it — it reads the page THIS harness fetched, and a
    // fresh Playwright profile has no service worker, so the harness always gets the new code
    // while real devices get the old one. That is precisely the blind spot.
    // Done from Node, not from the page: an in-page fetch could itself be answered by the very
    // service-worker cache under test.
    if (ORIGIN) {
      const readSwBuild = async (u) => {
        try {
          const r = await fetch(u, { cache: 'no-store' });
          if (!r.ok) return { err: 'HTTP ' + r.status };
          const m = (await r.text()).match(/const BUILD = '([^']+)'/);
          return m ? { build: m[1] } : { err: 'no BUILD line in the response' };
        } catch (e) { return { err: String((e && e.message) || e).slice(0, 90) }; }
      };
      const edge = await readSwBuild(ORIGIN + '/sw.js');
      const fresh = await readSwBuild(ORIGIN + '/sw.js?cb=' + Date.now().toString(36) + Math.random().toString(36).slice(2));
      let localSw = null;
      try { localSw = (fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8').match(/const BUILD = '([^']+)'/) || [])[1] || null; } catch (_) {}
      // A check that could not run says "I don't know" — it never invents a red line.
      if (edge.err || fresh.err)
        PREFLIGHT.push(`⚠️ Edge-cache check could not run (${edge.err || fresh.err}) — cannot tell whether the CDN is serving a stale service worker.`);
      else if (edge.build !== fresh.build)
        PREFLIGHT.push(`🔴 STALE CDN EDGE — /sw.js serves BUILD ${edge.build} but /sw.js?cb=… serves ${fresh.build}. The deployment is correct and a shared cache is pinning the OLD service worker, so no phone is getting updates and this run is testing code nobody is running. Purge the CDN (Vercel → Deployment → Purge Cache) or redeploy with --force, then re-run.`);
      else if (localSw && edge.build !== localSw)
        PREFLIGHT.push(`🔴 STALE SERVICE WORKER — the edge and a cache-busted fetch agree on BUILD ${edge.build}, but local sw.js is ${localSw}. Devices are running an older app than you built. Deploy, then re-run.`);
      else
        PREFLIGHT.push(`✅ Service worker current at the edge — /sw.js and /sw.js?cb=… both serve BUILD ${edge.build}.`);
    }

    // ── SPEND METERING — measured for free, because this run is already paying ────────────
    // Thirteen endpoints were registered at 0 credits, so `used` could never move and no plan
    // limit could ever be reached. That is a SERVER fact and scripts/verify/spend-cap.mjs proves
    // it deterministically, offline, for every action — repeating it here by deliberately burning
    // credits would cost real money to prove strictly less. What that oracle CANNOT see is the
    // live account. This run already fires a dozen real metered generations, so reading `used`
    // before and after costs two authenticated GETs, zero LLM turns and zero extra generations —
    // and if `used` has not moved by the end, metering is dead in production.
    try {
      const u0 = await page.evaluate(async () => { try { const r = await fetch('/api/usage'); return await r.json(); } catch (e) { return null; } });
      if (u0 && typeof u0.used === 'number') {
        USAGE_BEFORE = u0;
        console.log(`   ℹ️ spend at start: ${u0.used}/${u0.limit} credits (plan ${u0.plan})`);
      }
    } catch (_) {}

    PREFLIGHT.forEach(l => console.log('   ' + l));
    if (PREFLIGHT.some(l => l.startsWith('🔴')) && !process.env.FORCE) {
      console.log('\n   Preflight failed. Fix the above, or re-run with FORCE=1 to test anyway.\n');
      await browser.close();
      process.exit(1);
    }
    console.log('');
  } catch (e) { PREFLIGHT.push('⚠️ preflight could not run: ' + e.message); }
  }   /* ← end of the always-runs `if (ready)` version-read + preflight block */

  // Dismiss AMBIENT overlays that aren't the feature under test (tour, onboarding, PWA banner,
  // notif prompt, and — new — the mascot nudge bubble + its "!" badge + mic tooltip) so they can't
  // sit on top of and corrupt a screenshot. Deliberately does NOT touch .dp-backdrop feature modals
  // (those are handled by dismissBlocking only when the driver is actually stuck).
  // The Brand Voice Assistant is now closed between actions unless the `assistant` feature asked
  // to keep it. WHY: the shrimp bubble auto-pops on launch (v582) and its "Answer" button opens
  // this overlay, and `.bv-overlay` is position:fixed while the evidence screenshot grows the page
  // to full content height — so the driver's coordinates for the × land OFF-SCREEN and it can
  // never dismiss it. The 2026-08-29 run proved the button itself is fine (proof-taptargets:
  // "assistantCloseWorks: WORKS — x dismissed it" alongside "assistantClose: COVERED BY OFFSCREEN")
  // yet the run still recorded 229 blocked taps and 17 blocked features, and declared the app
  // broken. A harness that cannot dismiss an overlay must not be allowed to report that as an app
  // failure — so close it here instead of asking the driver to click it.
  const killOverlays = async () => { await page.evaluate(`if(!window._qaKeepAssistant){ try{if(typeof closeBrandVoice==='function')closeBrandVoice();}catch(e){} } if(!window._qaKeepTour){ try{if(typeof endTour==='function')endTour();}catch(e){} } if(!window._qaKeepMoreSheet){ try{if(typeof closeMoreSheet==='function')closeMoreSheet();}catch(e){} } if(!window._qaKeepMascot){ try{if(typeof mascotDismiss==='function')mascotDismiss();}catch(e){} try{document.querySelectorAll('.mascot-wrap').forEach(function(w){w.classList.remove('active','has-tip');});}catch(e){} } try{document.querySelectorAll('#csOnbCard,.pwa-banner,#pwaGuideOverlay,.bv-mic-tooltip').forEach(x=>x.remove());}catch(e){} if(!window._qaKeepTour){ try{document.querySelectorAll('.tour-overlay').forEach(x=>x.remove());}catch(e){} } if(!window._qaKeepNotif){ try{document.querySelectorAll('#notifOverlay').forEach(x=>x.remove());}catch(e){} }`).catch(() => {}); };
  // used when the AI gets stuck behind a real modal (e.g. the feedback sheet): press Escape + click any safe close control
  const dismissBlocking = async () => {
    try { await page.keyboard.press('Escape'); } catch (e) {}   // app closes all sheets on Escape
    await page.evaluate(() => {
      // click only REAL close controls — never the idea "✗ Dismiss" action, which OPENS a feedback popup
      var closers = [].slice.call(document.querySelectorAll('.dp-x, .dp-cancel, .conn-x, .cm-close, [aria-label="Close"]'))
        .filter(function (e) { try { var c = getComputedStyle(e); return c.display !== 'none' && c.visibility !== 'hidden'; } catch (x) { return false; } });
      if (closers.length) closers.slice(0, 2).forEach(function (e) { try { e.click(); } catch (x) {} });
      else { var bd = document.querySelector('.dp-backdrop, .conn-backdrop'); if (bd) { try { bd.click(); } catch (x) {} } }
    }).catch(() => {});
    await page.waitForTimeout(400);
  };
  // At the START of each feature, hard-clear any modal the PREVIOUS feature left open (approve/learning
  // popup, brand-voice overlay, brain review). Safe here because THIS feature's
  // taps haven't run yet — so it can't block navigation or corrupt this feature's screenshot. This is the
  // fix for shots like "qa-blog" actually showing Settings + a stuck approve popup.
  const clearLeftoverModals = async () => { await page.evaluate(`
    try{if(typeof cancelApprovePopup==='function')cancelApprovePopup();}catch(e){}
    // closeAutopost/closeConnections belonged to the publishing feature, deleted in v633. The
    // typeof guard already made these no-ops; kept out entirely now so nobody re-adds a caller.
    try{if(typeof closeBrandVoice==='function')closeBrandVoice();}catch(e){}
    try{if(typeof closeBrainReview==='function')closeBrainReview();}catch(e){}
    try{if(typeof closeAngleSheet==='function')closeAngleSheet();}catch(e){}
    try{if(typeof closeMoreSheet==='function')closeMoreSheet();}catch(e){}   /* killOverlays no longer closes it mid-feature, so clean it up HERE at feature start */
    try{document.querySelectorAll('.dp-backdrop,.conn-backdrop,.brv-backdrop').forEach(function(x){x.remove();});}catch(e){}
    try{if(typeof endTour==='function')endTour();}catch(e){}   /* killOverlays no longer ends it mid-feature — clean up HERE instead */
    try{document.querySelectorAll('.tour-overlay').forEach(function(x){x.remove();});}catch(e){}
    window._qaKeepMascot = false; window._qaKeepMoreSheet = false; window._qaKeepTour = false; window._qaKeepNotif = false; window._qaKeepAssistant = false;
    try{document.querySelectorAll('#notifOverlay').forEach(function(x){x.remove();});}catch(e){}                                                            /* shrimp-test flag never leaks to the next feature */
    try{ delete window._qaProof; }catch(e){}                                                 /* proof results belong to their own feature only */
    try{ delete window._qaSkipFeature; }catch(e){}                                           /* a feature that skipped itself must not skip the NEXT one too */
    try{ delete window._qaApproveJump; }catch(e){}                                           /* approve-jump restore marker — cleared after its own restore ran */
    try{ delete window._qaContent; delete window._qaBrandCount; delete window._qaFormats; }catch(e){}  /* harvested scripts + its config belong to content-quality only; Node already has them by now */
    try{ if(typeof toggleDarkMode==='function' && localStorage.getItem('bn-dark-mode')==='1') toggleDarkMode(false); }catch(e){}  /* dark-mode test must not leak into every later feature's screenshots (it persists in localStorage) */
    try{if(window._qaOrigBare){window.brandBrainBare=window._qaOrigBare;delete window._qaOrigBare;}}catch(e){}  /* guardrail test stubbed brandBrainBare=true and never restored it — it leaked into EVERY later feature */
    /* proof-filming-teardown wraps tpBlur.stop with a spy. It unwraps it inline, but if that probe
       ever throws mid-way the spy would survive into pipeline-tools (which opens the teleprompter).
       Same belt-and-braces as _qaOrigBare above: a stub is never allowed to outlive its feature. */
    try{ if(window._qaOrigBlurStop && typeof tpBlur!=='undefined' && tpBlur){ tpBlur.stop=window._qaOrigBlurStop; delete window._qaOrigBlurStop; } }catch(e){}
    /* proof-onboarding-honesty drives the real step-2 gate with synthetic values. It restores them
       inline; this puts the wizard back even if it threw before getting there. */
    try{ var _os=window._qaObSnap; if(_os){
      Object.keys(_os.fields||{}).forEach(function(id){ var e=document.getElementById(id); if(e && _os.fields[id]!==null) e.value=_os.fields[id]; });
      if(typeof obSelectedTones!=='undefined') obSelectedTones=_os.tones||[];
      if(typeof obCommunities!=='undefined') obCommunities=_os.comms||[];
      try{ if(typeof obRenderToneCards==='function') obRenderToneCards(); }catch(e){}
      try{ if(typeof obRenderCommunityTags==='function') obRenderCommunityTags(); }catch(e){}
      try{ if(typeof obClearErr==='function') obClearErr('obStep2Err'); }catch(e){}
      try{ if(typeof obGoToStep==='function') obGoToStep(_os.step||1); }catch(e){}
      var _ob=document.getElementById('onboardingOverlay'); if(_ob && _os.wasHidden) _ob.classList.add('hidden');
      delete window._qaObSnap;
    } }catch(e){}
    /* proof-escaping parks two off-screen probe containers on <body> and removes them on a timer;
       if its verdict lands first, sweep them here so no probe markup survives into a screenshot. */
    try{ ['qaXssHost','qaXssCtrl'].forEach(function(id){ var el=document.getElementById(id); if(el) el.remove(); }); }catch(e){}
    try{ delete window.__qaXssFired; delete window.__qaCtrlFired; }catch(e){}
  `).catch(() => {}); };
  const tapOnclick = async (sub) => { const el = await page.$(`[onclick*=${JSON.stringify(sub)}]`); if (!el) return false; try { await el.scrollIntoViewIfNeeded({ timeout: 1000 }); } catch (e) {} try { await el.click({ timeout: 2500 }); return true; } catch (e) { return false; } };

  // EVERYTHING LOGGED BEFORE THIS LINE BELONGS TO NO FEATURE. The per-feature error slice starts at
  // each feature's own errAt, so boot/login/preflight errors were never rendered anywhere — yet they
  // still counted toward the "N hard error(s)" headline AND the process exit code. That is how a
  // report could say "1 hard error(s)" with no such error visible in the document. Now they get their
  // own `boot` section (see the report below).
  const BOOT_ERR_END = allErrors.length;

  if (ready) for (const f of FEATURES) {
    if (DRIVER_DEAD) break;
    current = f.id;
    const errAt = allErrors.length;
    // Declared BEFORE the taps: `flow` now also records harness-side waits, and `verdict` can be
    // pre-set to skip a feature we must not pretend to have tested.
    let verdict = null, actions = 0; const flow = []; let output = ''; let lastSig = '', sameCount = 0;
    const _waitMs = f.waitMs || WAIT_IDLE_MS;

    // A purely VISUAL feature judged by a driver that receives no screenshot is a fabricated verdict.
    // Refuse rather than guess: "I could not look" is a fact, "the tail is missing" would be a lie.
    let neverRan = false;
    if (f.needsVision && !visionOK) {
      neverRan = true;
      verdict = { status: 'blocked', expected: f.test,
        observed: `NOT TESTED — this feature is a purely VISUAL check and the driver model (${llm.name} / ${llm.model}) cannot receive screenshots, so there was nothing to look at. Skipped deliberately instead of guessed. Re-run with a vision model (QA_PROVIDER=xai|openai|anthropic) to test it.`,
        quality: '', ux: '', separation: '', bugs: [] };
      console.log(`  ⚠️ ${f.id}: blocked — driver has no vision; refusing to fake a visual verdict\n`);
    }

    if (!verdict) {
    // reach the feature via real taps (fallback to JS)
    await clearLeftoverModals(); await killOverlays();
    // Run each tap independently: click it if a real control has that onclick, otherwise evaluate
    // it directly. The old version was all-or-nothing (one joined evaluate, errors swallowed) —
    // when it failed, a whole probe block silently never ran and the driver then reported the
    // PREVIOUS feature's results as this one's. Any failure is now recorded, not hidden.
    for (const sub of f.taps) {
      if (!(await tapOnclick(sub))) {
        try { await page.evaluate(new Function(sub)); }
        catch (e) { allErrors.push({ kind: 'TAP FAILED', detail: f.id + ' — ' + String(e.message || e).slice(0, 140) }); }
      }
      await page.waitForTimeout(700);
    }
    if (f.reloadAfterTaps) {                       // reload-persistence: does the work survive a refresh?
      await page.waitForTimeout(1200);             // let the pre-reload state save
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (e) {}
      await page.waitForTimeout(6000);             // app boot + DB load
      if (f.postReload) { try { await page.evaluate(new Function(f.postReload)); } catch (e) {} }
    }
    const _tapWait = await waitIdle(_waitMs);
    if (_tapWait !== 'idle') flow.push('(' + _tapWait + ')');
    await killOverlays(); await page.waitForTimeout(600);

    // A feature's own taps can decide there is nothing SAFE to test (e.g. approve-jump with no
    // pending idea, which used to rewrite a real done post instead). Honour that as blocked.
    const _skip = await page.evaluate(() => { try { return window._qaSkipFeature || null; } catch (e) { return null; } }).catch(() => null);
    if (_skip) {
      verdict = { status: 'blocked', expected: f.test, observed: 'SKIPPED BY THE HARNESS — ' + String(_skip).slice(0, 240), quality: '', ux: '', separation: '', bugs: [] };
      console.log(`  ⚠️ ${f.id}: blocked — ${String(_skip).slice(0, 90)}\n`);
    }

    // CONTENT HARVEST: generations take 15-60s each and there are brands × formats of them, so the
    // normal idle wait is nowhere near enough — poll until the page says it has finished. Then
    // measure in Node and set the verdict here, so this feature never reaches the vision driver.
    if (!verdict && f.contentHarvest) {
      const maxMs = f.harvestMs || 480000;
      const t0 = Date.now();
      let data = null;
      process.stdout.write(`  ${f.id}: generating across brands and formats (this is slow by design)`);
      while (Date.now() - t0 < maxMs) {
        data = await page.evaluate(() => { try { return window._qaContent || null; } catch (e) { return null; } }).catch(() => null);
        if (data && (data.status === 'done' || data.status === 'error')) break;
        process.stdout.write('.');
        await page.waitForTimeout(5000);
      }
      process.stdout.write('\n');
      const items = (data && data.items) || [];
      const errs = (data && data.errors) || [];
      if (!items.length) {
        verdict = { status: 'blocked', expected: f.test, quality: '', ux: '', separation: '',
          observed: `No content harvested after ${Math.round((Date.now() - t0) / 1000)}s (status=${data ? data.status : 'no data'}). ${errs.join('; ')}`.slice(0, 400),
          bugs: [] };
        console.log(`  ⚠️ ${f.id}: blocked — nothing harvested\n`);
      } else {
        CONTENT_REPORT = require('./scripts/qa/content-checks.js').analyse(items, (data && data.ctx) || {});
        CONTENT_REPORT.errors = errs;
        const per = CONTENT_REPORT.per.filter(p => !p.skipped);
        const bad = [];
        // CROSS-BRAND LEAKS FIRST — these are not style opinions. One brand's facts inside another
        // brand's post, or the app being on a different brand than we asked for, is a hard bug with
        // a real customer consequence, so it leads the bug list rather than sitting among the nits.
        for (const m of CONTENT_REPORT.leak.mismatches) {
          bad.push(`🔴 BRAND MISMATCH — asked for ${m.intended}, app was on ${m.actual} when it generated (${m.format}). Switch race.`);
        }
        for (const l of CONTENT_REPORT.leak.leaks) {
          bad.push(`🔴 CROSS-BRAND LEAK — ${l.inBrand}/${l.format} contains ${l.fromBrand}'s terms: ${l.terms.join(', ')}`);
        }
        for (const p of per) {
          if (p.verbless.length) bad.push(`${p.brand}/${p.format}: ${p.verbless.length} verbless sentence(s)`);
          if (!p.length.ok) bad.push(`${p.brand}/${p.format}: ${p.length.words} words — ${p.length.note}`);
          if (p.open.monotone) bad.push(`${p.brand}/${p.format}: "${p.open.repeatedWord}" opens ${p.open.repeatedCount} sentences`);
          if (p.tour.tourSignal) bad.push(`${p.brand}/${p.format}: reads as a product walkthrough (${p.tour.mechanismVerbs} mechanism verbs, no lived experience)`);
        }
        for (const d of CONTENT_REPORT.run.identicalOpenings) bad.push(`identical opening across ${d[1].join(' + ')}`);
        const failed = items.filter(i => !i.got).length;
        if (failed) bad.push(`${failed} of ${items.length} generations produced nothing`);
        verdict = {
          status: bad.length ? 'fail' : 'pass',
          expected: 'scripts that read as speech: full sentences, connective tissue, in-range length, varied openings, about the audience not the product',
          observed: `Harvested ${items.length} scripts across ${new Set(items.map(i => i.brand)).size} brand(s). ` +
            (bad.length ? `${bad.length} measured issue(s) — see the Content quality section for the numbers AND the full scripts.` : 'All measured checks clean. Whether the writing is GOOD is still a human call — the scripts are in the report.'),
          quality: per.length ? `avg ${(per.reduce((a, p) => a + p.connect.per100, 0) / per.length).toFixed(1)} connectives/100w · ${per.filter(p => p.length.ok).length}/${per.length} in length range` : '',
          ux: '', separation: '', bugs: bad.slice(0, 12),
        };
        console.log(`  ${bad.length ? '❌' : '✅'} ${f.id}: ${items.length} scripts, ${bad.length} measured issue(s)\n`);
      }
    }
    }

    // QA inner loop for this feature
    // A feature can ask for more actions (f.budget) — a checklist test like settings-deep needs one
    // action per section PLUS a change PLUS a toast check, and was running out mid-checklist and
    // failing features that had actually worked.
    const _budget = f.budget || (f.id.startsWith('flow-') ? FLOW_BUDGET : PER_FEATURE);
    while (actions < _budget && !verdict) {
      actions++;
      let snap; try { snap = await page.evaluate(SNAPSHOT); } catch (e) { snap = { activeBrand: '', active: '', heading: '', busy: false, modalOpen: false, resultText: '', toasts: [], elements: [] }; }
      if (snap.resultText && snap.resultText.length > output.length) output = snap.resultText;   // keep the richest generated output seen
      const _errsSoFar = allErrors.slice(errAt).slice(-4).map(e => e.kind + ' ' + e.detail).join(' ; ');
      const _pv = prevRun[f.id];
      const _prevBlock = (_pv && (_pv.status === 'fail' || (_pv.bugs && _pv.bugs.length)))
        ? `\n\nLAST RUN this feature was ${String(_pv.status || '').toUpperCase()} and reported:\n- ${(_pv.bugs || []).slice(0, 5).join('\n- ')}\nCHECK EACH of those specifically. In "observed", start by saying FIXED or STILL PRESENT for each one by name. A fix that is confirmed is as valuable as a new bug found. Do not assume it is still broken — verify.`
        : '';
      const user = `FEATURE UNDER TEST: ${f.id}\nWHAT TO VERIFY: ${f.test}${_prevBlock}\nACTIVE BRAND: ${snap.activeBrand || '(see header/screenshot)'} — test as THIS brand, not any other.\n\nSAMPLE text you can adapt/paste where an input is needed:\n"${SAMPLE}"\n\nCurrent screen:\n${JSON.stringify(snap).slice(0, 6500)}\n${_errsSoFar ? '\nREAL API/JS ERRORS captured this feature (cite these as the CAUSE instead of guessing): ' + _errsSoFar + '\n' : ''}\nActions so far this feature: ${flow.slice(-5).join(' | ') || 'none'}\nYour next action (or a verdict if you've tested it):`;
      let shot = null; if (visionOK) { try { shot = (await page.screenshot({ type: 'jpeg', quality: 70 })).toString('base64'); } catch (e) {} }
      let act, lastErr;
      // Retry with a LONG backoff on 429 rate limits (a fresh/low-tier key throttles fast) so the
      // run completes instead of blocking every feature; short wait for other transient errors.
      for (let t = 0; t < 4 && !act; t++) { try { const raw = await askLLM(llm, SYS_RUN, user, shot); act = JSON.parse(extractJSON(raw) || raw); } catch (e) { lastErr = e; const is429 = /\b429\b|rate limit|too many requests/i.test(e.message || ''); if (is429) console.log(`   ⏳ rate-limited, waiting ${20 + t * 10}s…`); await page.waitForTimeout(is429 ? (20000 + t * 10000) : 800); } }
      // ALL 4 ATTEMPTS FAILED. The credit/403 check MUST live inside this branch: it used to sit
      // BELOW it, so `if (!act) … break` always fired first and DRIVER_DEAD was unreachable — and on
      // the one path that did reach it, it read `verdict.observed` while `verdict` was still null,
      // throwing a TypeError that killed the whole run (no report written).
      if (!act) {
        const _why = String((lastErr && lastErr.message) || '?');
        if (/403|used all available credits|permission-denied|quota|insufficient/i.test(_why)) {
          DRIVER_DEAD = 'The QA driver LLM ran out of credits mid-run — this is the TEST harness, not your app.';
          console.log(`\n  🛑 ${DRIVER_DEAD}\n     Stopping the run: every later feature would be "judged" by a dead model.\n     Top up the driver's account, then re-run.\n`);
          // 'unknown', NEVER 'fail' — a test that could not run must say "I don't know" about the app.
          // Built from a LOCAL object (no `verdict` deref); the single push below records it.
          verdict = { status: 'unknown', expected: f.test, observed: 'QA driver LLM died: ' + _why.slice(0, 240), bugs: [] };
        } else {
          verdict = { status: 'blocked', expected: f.test, observed: 'QA driver LLM failed: ' + _why.slice(0, 240), bugs: [] };
        }
        break;
      }

      if (act.action === 'verdict') { verdict = act.verdict || { status: 'blocked', observed: 'no verdict body' }; break; }

      const el = (act.target != null) ? snap.elements.find(e => e.i === act.target) : null;
      const label = el ? el.label : '';
      flow.push(`${act.action}${label ? ' "' + label + '"' : ''}${act.text ? '=' + act.text : ''}`);
      console.log(`  ${f.id} · ${act.action}${label ? ' "' + label + '"' : ''}${act.thought ? '  — ' + act.thought.slice(0, 55) : ''}`);

      // anti-stuck: if it repeats the same action, a popup is probably blocking — dismiss it and move on
      const sig = act.action + '|' + (act.target != null ? act.target : '') + '|' + label;
      if (sig === lastSig) sameCount++; else { sameCount = 0; lastSig = sig; }
      if (sameCount >= 2 && act.action !== 'verdict') { await dismissBlocking(); await killOverlays(); flow.push('(stuck → dismissed popup & retried)'); sameCount = 0; await page.waitForTimeout(500); continue; }

      if (el && act.action === 'click' && BLOCK.test(label)) { flow.push('(blocked ' + label + ')'); continue; }
      try {
        if (act.action === 'click' && el) {
          const h = await page.$(`[data-ai="${act.target}"]`);
          if (h) {
            await h.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
            // DIAGNOSTIC: is the thing we're aiming at actually the topmost element at that point?
            // "I tapped it and nothing happened" is otherwise unfalsifiable — this names the covering
            // element instead of guessing. Purely observational; never changes what we click.
            const cover = await page.evaluate(i => {
              const x = document.querySelector('[data-ai="' + i + '"]'); if (!x) return null;
              const r = x.getBoundingClientRect(); if (!r.width || !r.height) return 'ZERO-SIZE';
              const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
              if (!top) return 'NOTHING-AT-POINT';
              if (top === x || x.contains(top) || top.contains(x)) return null;   // fine
              const d = (top.className && typeof top.className === 'string' ? '.' + top.className.trim().split(/\s+/).join('.') : top.tagName);
              return d.slice(0, 80);
            }, act.target).catch(() => null);
            if (cover) { flow.push('(COVERED: ' + cover + ')'); allErrors.push({ kind: 'CLICK BLOCKED', detail: 'tap on "' + label.slice(0, 40) + '" lands on ' + cover + ' instead' }); }
            await h.click({ timeout: 3000 }).catch(async () => { await page.evaluate(i => { const x = document.querySelector('[data-ai="' + i + '"]'); x && x.click(); }, act.target); });
          }
        } else if (act.action === 'type' && el) {
          await page.fill(`[data-ai="${act.target}"]`, String(act.text || '')).catch(async () => { const h = await page.$(`[data-ai="${act.target}"]`); if (h) { await h.click().catch(() => {}); await page.keyboard.type(String(act.text || '')); } });
        } else if (act.action === 'scroll') { await page.mouse.wheel(0, 600); }
      } catch (e) { flow.push('(action error: ' + e.message.slice(0, 60) + ')'); }

      await page.waitForTimeout(500);
      // ← wait for any generation/API call to actually finish, for as long as THIS feature is allowed
      const _actWait = await waitIdle(_waitMs);
      if (_actWait !== 'idle') flow.push('(' + _actWait + ')');   // visible to the driver next turn
      await killOverlays();
    }
    if (!verdict) {   // out of actions → force a real conclusion instead of "ran out"
      try {
        let snap2; try { snap2 = await page.evaluate(SNAPSHOT); } catch (e) { snap2 = {}; }
        let shot2 = null; if (visionOK) { try { shot2 = (await page.screenshot({ type: 'jpeg', quality: 70 })).toString('base64'); } catch (e) {} }
        const raw = await askLLM(llm, SYS_RUN, `FEATURE: ${f.id}\nWHAT TO VERIFY: ${f.test}\nACTIVE BRAND: ${snap2.activeBrand || ''}\nYou are OUT OF ACTIONS. Based on what you did (${flow.join(' | ') || 'little'}) and the current screen:\n${JSON.stringify(snap2).slice(0, 4000)}\nOutput ONLY your final verdict JSON now: {"verdict":{"status":"pass|fail|blocked","expected":"...","observed":"...","quality":"...","ux":"...","bugs":[...]}}`, shot2);
        const v = JSON.parse(extractJSON(raw) || raw); verdict = v.verdict || v;
      } catch (e) {}
    }
    if (!verdict) verdict = { status: 'blocked', expected: f.test, observed: 'ran out of actions before a verdict', bugs: [] };

    const errs = allErrors.slice(errAt);
    // A HARD error during the flow = not a pass. But CLICK BLOCKED and NETWORK FAIL are purely
    // OBSERVATIONAL diagnostics (the click still went through; a failed request may be an aborted
    // poll), and this line used to silently flip a genuine PASS into a FAIL because of one. They are
    // still reported in `errors` below — they just no longer decide the verdict.
    const OBSERVATIONAL_KINDS = ['CLICK BLOCKED', 'NETWORK FAIL'];
    const hardErrs = errs.filter(e => !OBSERVATIONAL_KINDS.includes(e.kind));
    if (hardErrs.length && verdict.status === 'pass') verdict.status = 'fail';
    results.push({ feature: f.id, status: verdict.status || 'blocked', expected: verdict.expected || f.test, observed: verdict.observed || '', quality: verdict.quality || '', ux: (verdict.ux && !/^clean$/i.test(verdict.ux)) ? verdict.ux : '', separation: (verdict.separation && !/^clear$/i.test(verdict.separation)) ? verdict.separation : '', output: output || '', bugs: verdict.bugs || [], errors: errs, actions });
    const icon = verdict.status === 'pass' ? '✅' : verdict.status === 'fail' ? '❌' : '⚠️';
    console.log(`  ${icon} ${f.id}: ${verdict.status}${(verdict.bugs && verdict.bugs.length) ? ' — ' + verdict.bugs[0] : ''}\n`);
    // PUT THE APP BACK. A feature that mutates the owner's real data must undo it once judged —
    // otherwise every run leaves a mark on a live brand (approve-jump did exactly that, on every run).
    if (f.restore) { try { await page.evaluate(new Function(f.restore)); } catch (e) { allErrors.push({ kind: 'RESTORE FAILED', detail: f.id + ' — ' + String(e.message || e).slice(0, 140) }); } }
    try {
      // A feature that never ran must NOT overwrite its evidence screenshot: capturing whatever
      // screen happens to be showing would file a picture of an unrelated view under qa-<id>.png,
      // which is exactly the kind of misleading evidence this harness exists to avoid.
      if (neverRan) continue;
      // grow the viewport to the view's full content height so the saved evidence
      // shot captures the whole screen (inner scroll container would crop fullPage).
      // EXCEPTION (f.viewportShot): features whose subject is position:FIXED (the mascot bubble,
      // toasts, bottom nav) must be shot at real phone size — in a 8000px-tall full-page capture a
      // fixed element lands somewhere unusable and the driver reports it as "never appears".
      // DECLARED FIRST, on purpose: the viewportShot early-exit below uses _shotPath, and while these
      // consts lived further down it hit the temporal dead zone — a ReferenceError swallowed by the
      // surrounding catch, so viewportShot features (the shrimp) NEVER saved a screenshot at all.
      const _shotName = (DESKTOP ? 'qa-desktop-' : 'qa-') + f.id + '.png';
      const _shotPath = path.join(OUT, _shotName);
      if (f.viewportShot) { await page.screenshot({ path: _shotPath }); continue; }   // phone-sized shot; nothing runs after this block
      const full = await page.evaluate(() => {
        const sels = ['.view.active', '.main-views', '#app', '.app', 'main'];
        let h = (document.body && document.body.scrollHeight) || 0;
        sels.forEach(s => { const el = document.querySelector(s); if (el) h = Math.max(h, el.scrollHeight); });
        document.querySelectorAll('*').forEach(el => { const cs = getComputedStyle(el); if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 4) h = Math.max(h, el.scrollHeight); });
        return Math.max(h, 900);
      }).catch(() => 900);
      await page.setViewportSize({ width: DESKTOP ? 1440 : 390, height: Math.min(full + 160, 8000) });
      await page.waitForTimeout(350);
      // VISUAL REGRESSION: keep the PREVIOUS run's shot as qa-prev-* before overwriting, then compare
      // sizes. A big change in captured page height usually means a layout break (or a fix) — worth a look.
      try {
        if (fs.existsSync(_shotPath)) {
          const prevPath = path.join(OUT, 'prev-' + _shotName);
          const prevSize = fs.statSync(_shotPath).size;
          fs.copyFileSync(_shotPath, prevPath);
          visualPrev[f.id] = prevSize;
        }
      } catch (e) {}
      await page.screenshot({ path: _shotPath, fullPage: true });
      try {
        if (visualPrev[f.id]) {
          const now = fs.statSync(_shotPath).size, was = visualPrev[f.id];
          const drift = Math.abs(now - was) / Math.max(was, 1);
          if (drift > 0.25) visualDrift.push({ feature: f.id, pct: Math.round(drift * 100), was, now });
        }
      } catch (e) {}
      await page.setViewportSize({ width: DESKTOP ? 1440 : 390, height: DESKTOP ? 900 : 844 });
    } catch (e) {}
  }

  // ── DID THE RUN'S GENERATIONS ACTUALLY COST ANYTHING? ───────────────────────────────────
  // The other half of the spend check started in preflight. This costs one more authenticated
  // GET and no LLM turns. A zero delta after a run full of real generations is the live symptom
  // of the "registered at 0 credits, so `used` can never move" defect — the one thing the
  // offline oracle cannot observe. It is only meaningful when enough features actually ran, so
  // an `ONLY=pipeline` run reports the number without accusing anything.
  let spendLine = '';
  if (USAGE_BEFORE) {
    try {
      const u1 = await page.evaluate(async () => { try { const r = await fetch('/api/usage'); return await r.json(); } catch (e) { return null; } });
      if (u1 && typeof u1.used === 'number') {
        const d = u1.used - USAGE_BEFORE.used;
        const dc = (typeof u1.cost === 'number' && typeof USAGE_BEFORE.cost === 'number') ? (u1.cost - USAGE_BEFORE.cost) : null;
        spendLine = `**Spend this run:** ${USAGE_BEFORE.used} → ${u1.used} of ${u1.limit} credits (**${d >= 0 ? '+' : ''}${d}**${dc !== null ? `, €${dc.toFixed(3)}` : ''}) on plan \`${u1.plan}\`.`;
        if (d === 0 && results.length >= 5)
          spendLine += ` 🔴 **Metering looks DEAD** — ${results.length} features ran, several of them real generations, and \`used\` did not move by a single credit. That is the live symptom of an action registered at 0 credits: it can never increment \`used\`, so it can never trip its own plan limit and is unlimited on every plan. Check \`ACTION_CREDITS\` in \`api/_usage.js\` and run \`node scripts/verify/spend-cap.mjs\`.`;
        else if (d === 0)
          spendLine += ` (No change — but only ${results.length} feature(s) ran, so this says nothing either way.)`;
      }
    } catch (_) {}
  }

  // ── QA report ──
  const pass = results.filter(r => r.status === 'pass').length;
  const fail = results.filter(r => r.status === 'fail').length;
  const blk = results.filter(r => r.status === 'blocked').length;
  const hard = allErrors.filter(e => e.kind !== 'CLICK BLOCKED').length;
  const blockedTaps = allErrors.filter(e => e.kind === 'CLICK BLOCKED').length;

  let md = `# QA pass — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}\n\n**Live build tested: ${LIVE_VERSION}** — a failure here is only real if this is the build you meant to test.\n\n`;
  md += `Driver: ${llm.name} (${llm.model}) · ${DESKTOP ? 'Desktop (1440px)' : 'iPhone 13 (390px)'} · ${results.length} features\n\n`;
  // THE headline. One chain, one answer.
  const _cp = CRITICAL_PATH.map(id => ({ id, r: results.find(r => r.feature === id) }))
                           .filter(x => x.r);   // only judge steps this run actually covered
  const _broke = _cp.filter(x => x.r.status !== 'pass' && x.r.status !== 'unknown');
  const _unjudged = _cp.filter(x => x.r.status === 'unknown');
  if (DRIVER_DEAD || _unjudged.length) {
    md += `# ⚠️ RUN INVALID — COULD NOT JUDGE\n\n${DRIVER_DEAD || 'The QA driver could not produce a verdict.'} ` +
          `**This says nothing about whether your app works.** Re-run once the driver has credits.\n\n`;
  } else if (_cp.length) {
    md += _broke.length
      ? `# 🔴 THE APP DOES NOT WORK TODAY\n\nThe daily chain breaks at: **${_broke.map(x => x.id).join(' → ')}**. ` +
        `A user cannot get from opening the app to a posted post. Nothing else in this report matters until that is fixed.\n\n` +
        _broke.map(x => `- **${x.id}** (${x.r.status}): ${(x.r.observed || '').slice(0, 300)}`).join('\n') + `\n\n`
      : (_cp.length === CRITICAL_PATH.length
          ? `# ✅ THE DAILY CHAIN COMPLETES\n\nopen → generate → approve → pipeline → done all pass. ` +
            `Anything below is polish, not a blocker.\n\n`
          : `# ⚠️ CHAIN ONLY PARTLY TESTED\n\n${_cp.length} of ${CRITICAL_PATH.length} critical steps ran ` +
            `(${_cp.map(x => x.id).join(', ')}) and those passed — but this run does NOT tell you whether the app works end to end. ` +
            `Run without ONLY= to get the real verdict.\n\n`);
  }

  md += `**✅ ${pass} passed · ❌ ${fail} failed · ⚠️ ${blk} blocked · ${hard} hard error(s)${blockedTaps ? ` · 🎯 ${blockedTaps} blocked tap(s) — see CLICK BLOCKED lines, each names the covering element` : ''}**\n\n`;
  // Preflight first — a red line here means the run tested the WRONG CODE and the failures below
  // cannot be trusted. This has to be the first thing anyone reads.
  if (PREFLIGHT.length) md += `## Preflight\n${PREFLIGHT.map(l => '- ' + l).join('\n')}\n\n`;
  if (spendLine) md += spendLine + `\n\n`;

  // PROVIDER vs APP. A dead/flaky AI provider makes every generate feature "fail", which reads as
  // a dozen app bugs and sends us chasing code that is fine. Count it and say so once.
  // NOTE: results are pushed with the key `feature`, NOT `id` — this used to map to `r.id` and so
  // produced a list of `undefined`, making the whole section inert. Regex also has to cover 403 /
  // permission-denied, which is how a dead provider key actually presents.
  const _provider = results.filter(r =>
    (r.bugs || []).concat(r.observed ? [r.observed] : []).join(' ')
      .match(/having a moment|used all available credits|429|rate limit|\b403\b|permission-denied|quota|insufficient/i)).map(r => r.feature);
  if (_provider.length >= 2)
    md += `## ⚠️ Provider, not app\n${_provider.length} feature(s) failed on the AI provider itself (${_provider.join(', ')}). ` +
          `These are NOT app bugs — check xAI credits/status and the Vercel logs for \`xAI EMPTY 200\` / \`xAI FAILED\` lines before changing any code.\n\n`;

  // Cross-run delta: what got fixed, and what broke that was previously fine.
  const _fixed = [], _regressed = [];
  for (const r of results) {
    const pv = prevRun[r.feature]; if (!pv) continue;
    if (pv.status === 'fail' && r.status === 'pass') _fixed.push(r.feature);
    if (pv.status === 'pass' && r.status === 'fail') _regressed.push(r.feature);
  }
  if (_fixed.length || _regressed.length) {
    md += `**vs previous run:**`;
    if (_fixed.length) md += ` ✅ fixed: ${_fixed.join(', ')}.`;
    if (_regressed.length) md += ` 🔻 REGRESSED (was passing): ${_regressed.join(', ')}.`;
    md += `\n\n`;
  }
  // CONTENT QUALITY — numbers first so a regression is obvious, then every script verbatim so the
  // taste call can be made without filming anything. This section is the point of the run.
  if (CONTENT_REPORT && CONTENT_REPORT.per) {
    const per = CONTENT_REPORT.per.filter(p => !p.skipped);
    md += `## Content quality — measured\n\n`;
    md += `Deterministic checks only. **These numbers say whether a script is built like speech, not whether it is any good** — that judgement is still yours, which is why every script is printed in full below.\n\n`;
    // Isolation first: a leak is a hard bug with a customer consequence, not a style note.
    const lk = CONTENT_REPORT.leak || { leaks: [], mismatches: [], checked: 0 };
    if (lk.leaks.length || lk.mismatches.length) {
      md += `### 🔴 Brand isolation — FAILED\n\n`;
      for (const m of lk.mismatches) md += `- **Brand mismatch:** asked for ${m.intended}, the app was on **${m.actual}** when it generated (${m.format}). That is a switch race — the generation was written against the wrong brand.\n`;
      for (const l of lk.leaks) md += `- **Leak:** ${l.inBrand}/${l.format} contains terms distinctive to **${l.fromBrand}**: \`${l.terms.join('`, `')}\`\n`;
      md += `\nThese are not taste issues. One brand's facts inside another brand's post is the class this app has hit before (shared localStorage buckets, the coach fed the previous brand's post, switch races writing under the wrong id).\n\n`;
    } else if (lk.checked > 1) {
      md += `**Brand isolation: clean** — ${lk.checked} brands compared, no brand's distinctive terms appeared in another's scripts, and the app was on the expected brand for every generation.\n\n`;
    }
    md += `| Brand | Format | Words | Verbless | Connectives/100w | Repeated opener | Product tour? |\n|---|---|---|---|---|---|---|\n`;
    for (const p of per) {
      md += `| ${p.brand} | ${p.format} | ${p.length.words}${p.length.ok ? '' : ' ⚠️'} | ${p.verbless.length || '—'} | ${p.connect.per100} | ${p.open.monotone ? `"${p.open.repeatedWord}" ×${p.open.repeatedCount} ⚠️` : '—'} | ${p.tour.tourSignal ? 'yes ⚠️' : 'no'} |\n`;
    }
    md += `\n`;
    const r = CONTENT_REPORT.run;
    md += `**Across the run:** ${r.sameFirstWordShare}% of scripts open with the same first word ("${r.topFirstWord}")`;
    md += r.identicalOpenings.length ? `; ${r.identicalOpenings.length} pair(s) open identically — that is the convergence risk the worked example was designed against.\n\n` : `; no two scripts open identically.\n\n`;
    if (CONTENT_REPORT.errors && CONTENT_REPORT.errors.length) md += `Harvest errors: ${CONTENT_REPORT.errors.join('; ')}\n\n`;
    const flagged = per.filter(p => p.verbless.length);
    if (flagged.length) {
      md += `**Verbless-sentence candidates** (heuristic — read them, a short valid line can be flagged):\n`;
      for (const p of flagged) for (const s of p.verbless) md += `- ${p.brand}/${p.format}: "${s}"\n`;
      md += `\n`;
    }
    md += `### The scripts\n\n`;
    for (const p of per) {
      md += `**${p.brand} · ${p.format}** — ${p.title || '(no title)'}\n\n`;
      if (p.hook) md += `> HOOK: ${p.hook}\n\n`;
      md += `> ${String(p.script || '(empty)').replace(/\n+/g, '\n> ')}\n\n`;
    }
    const dead = CONTENT_REPORT.per.filter(p => p.skipped || p.got === false);
    if (dead.length) md += `Failed to generate: ${dead.map(d => `${d.brand}/${d.format}${d.error ? ' (' + d.error + ')' : ''}`).join(', ')}\n\n`;
  }

  md += `Watch: \`mobile-user-video.webm\`${process.env.QA_TRACE ? ' · Scrub: `npx playwright show-trace mobile-user-trace.zip`' : ''}\n\n`;
  md += `| Feature | Result | Output quality | Notes |\n|---|---|---|---|\n`;
  for (const r of results) { const icon = r.status === 'pass' ? '✅ pass' : r.status === 'fail' ? '❌ fail' : '⚠️ blocked'; const note = (r.bugs && r.bugs.length ? r.bugs.join('; ') : r.observed || '').replace(/\|/g, '/').slice(0, 110); const q = (r.quality || '—').replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 90); md += `| ${r.feature} | ${icon} | ${q} | ${note} |\n`; }
  md += `\n`;
  if (visualDrift.length) {
    md += `## ⚠️ Visual change vs previous run\nThese screens changed size a lot since the last run — could be a layout break OR an intended fix. Compare \`qa-<id>.png\` against \`prev-qa-<id>.png\`.\n\n`;
    for (const v of visualDrift) md += `- **${v.feature}** — captured page height changed ~${v.pct}%\n`;
    md += `\n`;
  }
  // Errors that happened before the first feature (page load, login, preflight). They belong to no
  // feature and were previously invisible while still inflating the hard-error count and exit code.
  const bootErrs = allErrors.slice(0, BOOT_ERR_END);
  if (bootErrs.length) {
    md += `## boot — before any feature ran\n`;
    md += `These ${bootErrs.length} error(s) happened during page load / login / preflight, so they belong to no feature. They are counted in the hard-error total above and in the exit code — this section exists so that total is never unexplained.\n`;
    for (const e of bootErrs) md += `- 🔴 ${e.kind} — ${e.detail}\n`;
    md += `\n`;
  }

  for (const r of results) {
    if (r.status === 'pass' && !r.bugs.length && !r.errors.length && !r.quality && !r.ux && !r.separation && !r.output) continue;
    md += `## ${r.feature} — ${r.status}\n`;
    if (r.expected) md += `- **Expected:** ${r.expected}\n`;
    if (r.observed) md += `- **Observed:** ${r.observed}\n`;
    if (r.quality) md += `- **Output quality:** ${r.quality}\n`;
    if (r.ux) md += `- **Design/UX:** ${r.ux}\n`;
    if (r.separation) md += `- 🔲 **Section separation:** ${r.separation}\n`;
    if (r.output) md += `- **Output sample:** ${r.output.replace(/\n/g, ' ').slice(0, 1200)}${r.output.length > 1200 ? '…' : ''}\n`;
    for (const b of (r.bugs || [])) md += `- 🐞 ${b}\n`;
    for (const e of (r.errors || [])) md += `- 🔴 ${e.kind} — ${e.detail}\n`;
    md += `\n`;
  }
  try {
    const snapshot = {};
    for (const r of results) snapshot[r.feature] = { status: r.status, bugs: (r.bugs || []).slice(0, 5) };
    fs.writeFileSync(PREV_FILE, JSON.stringify(snapshot, null, 1));
  } catch (e) {}
  fs.writeFileSync(REPORT, md);

  if (process.env.QA_TRACE) await context.tracing.stop({ path: TRACE }).catch(() => {});
  await context.close();
  if (video) { try { await video.saveAs(VIDEO); } catch (e) {} try { await video.delete(); } catch (e) {} }
  await browser.close();

  console.log(`────────────────────────────────────────`);
  console.log(`  ✅ ${pass} passed · ❌ ${fail} failed · ⚠️ ${blk} blocked · ${hard} hard error(s)`);
  if (DRIVER_DEAD || _unjudged.length) console.log(`\n  ⚠️ RUN INVALID — the QA driver died, not your app. Re-run with credits.\n`);
  else if (_cp.length) console.log(_broke.length
    ? `\n  🔴 THE APP DOES NOT WORK TODAY — daily chain breaks at: ${_broke.map(x => x.id).join(' → ')}\n`
    : (_cp.length === CRITICAL_PATH.length
        ? `\n  ✅ DAILY CHAIN COMPLETES — open → generate → approve → pipeline → done\n`
        : `\n  ⚠️ chain only partly tested (${_cp.length}/${CRITICAL_PATH.length} steps) — not an end-to-end verdict\n`));
  console.log(`  ▶ mobile-user-video.webm${process.env.QA_TRACE ? '   ⏱ npx playwright show-trace mobile-user-trace.zip' : ''}`);
  console.log(`  📄 ${path.basename(REPORT)}`);
  console.log(`────────────────────────────────────────\n`);
  if (CI) { try { require('child_process').execSync(`osascript -e 'display notification "${pass} pass · ${fail} fail · ${blk} blocked" with title "Content Shrimp QA (weekly)"'`); } catch (e) {} }
  process.exit(fail > 0 || hard > 0 ? 1 : 0);
})();

/* ═══════════════════════════════════════════════════════════════════════════════════════════
   UNTESTABLE FLOWS — written down on purpose, because a harness that quietly omits something
   is worse than one that names what it cannot reach. Nothing below is "not done yet"; each is
   a considered decision with the reason attached. A test that pretends to cover one of these
   would be a fabricated verdict, which is the exact failure mode this file exists to prevent.

   1. THE ONBOARDING WIZARD'S FIRST-RUN EXPERIENCE. It fires only for a brand-new account and
      the only way in is a magic-link email the harness cannot read. Faking a signup (stubbing
      currentUser, forcing the overlay open, calling obFinish) would CREATE A REAL BRAND on the
      owner's live account on every run and still would not reproduce the first-run state.
      COVERED INSTEAD, and it is the actual defect: `proof-onboarding-honesty` drives the real
      step-2 gate (obNext) directly — the wizard markup is static and always in the DOM — and
      proves the gate can never accept a brand the app then LOCKS. The GATE LOGIC is tested;
      the first-run FEEL is not, and only Jörgen can judge that on a throwaway account.

   2. REAL PUBLISHING. Would post AI content to a live channel. Blocked by BLOCK/ and by policy.

   3. MIC DICTATION / WHISPER / TTS SPEAK-BACK. Needs real device media capture; headless
      Chromium has no microphone, so a "failure" here would only ever be the harness's own.

   4. THE CAMERA HALF OF FILMING. Same reason — getUserMedia rejects with no camera present, so
      framing, blur quality, lip-sync and the teleprompter's on-screen readability are all
      device-only judgements. `proof-filming-teardown` covers the part that IS observable
      without a camera: whether committing a take actually releases the tracks and stops the
      blur pump, tested against a canvas.captureStream() the harness owns.

   5. PWA INSTALL / PUSH NOTIFICATION DELIVERY. Browser- and OS-level, outside the page.

   6. SPEND GATING AS A DEDICATED FEATURE — deliberately NOT one, and this is a judgement call
      worth stating. The thirteen endpoints that could never hit their own limit are a SERVER
      fact: `scripts/verify/spend-cap.mjs` already proves every action's credit weight offline,
      deterministically, for free, with negative controls. A sim feature that fired those
      endpoints to watch a number move would cost real money every run, be non-deterministic
      (the delta depends on plan, period and whatever else ran), and prove strictly less. So the
      offline oracle owns the rule, and this harness owns the one thing it cannot see: the LIVE
      account. `used` is read before and after the run — two authenticated GETs, no LLM turns,
      no extra generations — and if a run full of real generations moves it by zero credits, the
      report says metering looks dead. That is the live symptom, measured for free.
   ═══════════════════════════════════════════════════════════════════════════════════════════ */
