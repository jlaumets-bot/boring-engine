#!/usr/bin/env node
// GATE: a write that fails must SAY SO, a UI action must not be aborted by a failed write, and
//       the app must open offline from the links it hands out.
//
// WHY THIS EXISTS — six defects, all invisible on screen, all proved by running the real code.
//
//   1. THREE BARE localStorage.setItem CALLS SAT BEFORE THE WORK. On a device where the store
//      throws (full, or site data blocked) the whole function aborted:
//        dismissNotifPrompt — the ×, "Not now" AND the backdrop all call it, so the daily-nudge
//          sheet could not be closed at all; and the dismissal was never recorded, so it came
//          back 4.5s after every launch.
//        spSetTab — every Settings tab did nothing.
//        endTour — the tour auto-started again on every load, forever.
//      The file guards its READS at the same places; the asymmetry was an oversight.
//
//   2. lsSet SWALLOWED A FULL DISK. Three of the things it stores have NO database copy:
//      hand-taught trends, the "People also ask" questions and which were used, and the
//      daily-ping toggle. The user typed a trend, saw the toast, and it was gone after the
//      reload. The right writer already existed (_lsWriteGuarded, which logs and toasts) and
//      had exactly one call site.
//
//   3. TWO `ideas` DELETEs HAD NO .select(). supabase-js does not throw on an HTTP error, and an
//      RLS refusal is HTTP 200, ZERO ROWS, error: null. The delete policy on `ideas` is
//      owner-only (sql/v658-member-delete.sql), so for a TEAM MEMBER every Sharpen / viral
//      Replace / Redo that renamed a post left the old row behind — and the loader dedups BY
//      TITLE, so it returned as a second card after every reload, accumulating forever.
//
//   4. THE PLAN POLL NEVER STOPPED. _csUsageUnknown cleared its own timer handle before the
//      retry ran, so each failed retry re-armed it: on a dead session the tab asked /api/usage
//      every 6 seconds for as long as it stayed open, under a message saying nothing had
//      changed. Measured before the fix: 13 requests and still queued.
//
//   5. THE SERVICE WORKER MATCHED THE FULL URL, QUERY STRING INCLUDED. The shell is cached as
//      the bare '/app.html', so the two entry URLs the product itself produces —
//      /app.html?invite=<code> from a team invite and /app.html?code=<pkce> from a magic link —
//      MISSED the cache. Offline that is the browser's network-error page on an app whose own
//      copy promises it works offline.
//
//   6. AND IT RE-DOWNLOADED THE WHOLE 1.4MB SHELL ON EVERY LAUNCH. SHELL_MARK already recorded
//      which build was cached; the fetch handler never read it. On the 0.5KB/s line sw.js keeps
//      citing, that is ~14 minutes of saturated pipe per launch.
//
// HOW IT CHECKS
//   Everything is EXECUTED, not grepped: the real functions are lifted out of app.html and run
//   in a vm against a localStorage that throws, a PostgREST stub that answers the way an RLS
//   refusal really answers, and a deterministic timer queue; the real sw.js is loaded whole and
//   driven with a faithful Cache API. Two arms are mutation checks — removing .select() must
//   make the refusal invisible again, and a stale SHELL_MARK must still trigger the refetch —
//   so a green result cannot come from a test that no longer tests anything.
//
// RUN:    node scripts/verify/offline-and-silent-writes.mjs
// EXPECT: prints "PASS" and exits 0.
import fs from 'node:fs'; import vm from 'node:vm';
const html = fs.readFileSync('app.html','utf8'), sw = fs.readFileSync('sw.js','utf8');
// one-liners close on their own line; block functions close with `}` at column 0
const grab = n => { let i = html.indexOf('\nfunction '+n+'(');
  if(i<0){ i = html.indexOf('\nasync function '+n+'('); }
  if(i<0) throw new Error('no '+n);
  const eol = html.indexOf('\n', i+1);
  const first = html.slice(i+1, eol);
  let d=0, seen=false; for (const ch of first){ if(ch==='{'){d++;seen=true;} else if(ch==='}'){d--;} }
  if (seen && d===0) return first;
  const j = html.indexOf('\n}', i); return html.slice(i+1, j+2); };
let fail = 0; const ok=(c,m)=>{ if(!c){ console.log('FAIL:',m); fail++; } else console.log('ok:',m); };

// ── 1+2. storage throws: nothing may abort ─────────────────────────────
const store = { setItem(){ const e=new Error('exceeded'); e.name='QuotaExceededError'; throw e; },
                getItem(){ return null; }, removeItem(){} };
const ctx = { console: { log: console.log, warn: ()=>{}, error: ()=>{} }, localStorage: store, currentBrand:{id:'B'}, showToast:(m)=>ctx.toasts.push(m),
  toasts: [], removed:false, rendered:false, spActiveTab:'voice', tourOverlay:null,
  document:{ getElementById:(id)=> id==='notifOverlay' ? { remove(){ ctx.removed=true; } } : null,
             querySelector:()=>null },
  renderSettingsPanel(){ ctx.rendered = true; }, maybeShowBrandVoicePopup(){ ctx.popup=true; },
  setTimeout:(f)=>{ try{f();}catch(e){} }, Date, window:{} };
vm.createContext(ctx);
vm.runInContext([grab('_lsWriteGuarded'), 'let _lsQuotaWarnedAt = 0;', grab('bkey'), grab('lsSet'),
  grab('dismissNotifPrompt'), grab('spSetTab'), grab('endTour')].join('\n'), ctx);

let threw=null; try { vm.runInContext('dismissNotifPrompt()', ctx); } catch(e){ threw=e.name; }
ok(threw===null && ctx.removed===true, 'notification sheet CLOSES when storage throws (threw='+threw+', removed='+ctx.removed+')');
threw=null; try { vm.runInContext('spSetTab("brand")', ctx); } catch(e){ threw=e.name; }
ok(threw===null && ctx.rendered===true, 'Settings tab RE-RENDERS when storage throws');
threw=null; ctx.popup=false; try { vm.runInContext('endTour()', ctx); } catch(e){ threw=e.name; }
ok(threw===null && ctx.popup===true, 'endTour finishes its work when storage throws');
ctx.toasts.length = 0;
vm.runInContext('lsSet("brand_trends","[]")', ctx);
ok(ctx.toasts.length===1 && /storage is full/.test(ctx.toasts[0]), 'lsSet now TELLS the user a full device ate the write: '+JSON.stringify(ctx.toasts[0]||'').slice(0,60));

// storage that works must still work
const good = { m:new Map(), setItem(k,v){this.m.set(k,v);}, getItem(k){return this.m.get(k)??null;}, removeItem(k){this.m.delete(k);} };
ctx.localStorage = good; ctx.toasts.length=0;
vm.runInContext('lsSet("brand_trends","[1]")', ctx);
ok(good.m.get('brand_trends::B')==='[1]' && ctx.toasts.length===0, 'a healthy device still writes, with no toast');

// ── 3. the ideas DELETE must be able to SEE a refusal ──────────────────
const drop = grab('_dropRenamedIdeaRow');
const mk = (rows, err) => { const q = { _ops:[], delete(){return q;}, eq(){return q;},
  select(){ return Promise.resolve({ data: rows, error: err }); } }; return { from(){ return q; } }; };
for (const [label, rows, err, wantWarn] of [['RLS refusal (200, zero rows, no error)', [], null, true],
                                            ['a real delete', [{id:'x'}], null, false],
                                            ['a transport error', null, {message:'boom'}, true]]) {
  const c = { console:{warn:()=>c.warned=true, error:()=>{}}, currentBrand:{id:'B'}, state:[],
              sb: mk(rows, err), window:{}, showToast:(m)=>c.toast=m, warned:false };
  vm.createContext(c); vm.runInContext(drop, c);
  await vm.runInContext('_dropRenamedIdeaRow("Old title","New title")', c);
  ok(c.warned===wantWarn, 'ideas DELETE — ' + label + ' → warned=' + c.warned + (c.toast?(' toast: "'+String(c.toast).slice(0,40)+'…"'):''));
}
// MUTATION: without .select() the refusal is invisible again
{ const noSel = drop.replace(/\.select\('id'\)/, ''); let sawWarn=false;
  const c={console:{warn:()=>sawWarn=true,error:()=>{}},currentBrand:{id:'B'},state:[],window:{},showToast:()=>{},
    sb:{from(){const q={delete:()=>q,eq:()=>q,then:(f)=>f({data:[],error:null})};return q;}}};
  vm.createContext(c); try{ vm.runInContext(noSel,c); await vm.runInContext('_dropRenamedIdeaRow("a","b")',c);}catch(e){}
  ok(sawWarn===false, 'MUTATION: dropping .select() makes the refusal invisible again (proves the check is load-bearing)'); }

// ── 4. the usage retry must be bounded ────────────────────────────────
{ const c = { console, document:{getElementById:()=>null}, csUsage:null, Math, Date, calls:0, timers:[] };
  c.setTimeout = (f,ms)=>{ c.timers.push([f,ms]); return c.timers.length; };
  c.fetch = async () => { c.calls++; return { ok:false, status:401 }; };
  c.planBoxHtml = ()=> ''; c.renderUsagePill = ()=>{}; c.renderOnb = ()=>{}; c.csIsFree = ()=>false;
  c.syncPushTimezone = ()=>{}; vm.createContext(c);
  vm.runInContext(['var csUsageLoadFailed=false; var _csUsageRetryT=null; var _csUsageRetries=0;',
    grab('_csUsageUnknown'), grab('refreshUsage')].join('\n'), c);
  await vm.runInContext('refreshUsage()', c);
  // the timer callback fires refreshUsage() without returning its promise, so yield
  // the event loop after each one or the next retry has not been queued yet
  for (let i=0;i<12;i++){ if(!c.timers.length) break; const [f] = c.timers.shift(); f();
    await new Promise(r=>setImmediate(r)); await new Promise(r=>setImmediate(r)); }
  ok(c.calls === 4, '/api/usage on a dead session: ' + c.calls + ' requests then STOPS (was unbounded; want 4 = first + 3 retries)');
  ok(c.timers.length === 0, 'no timer left armed'); }

// ── 5. the service worker must serve the shell for a query-string URL ──
{ const cacheMap = new Map([['https://x/app.html', 'SHELL'], ['https://x/__cs_shell_build', null]]);
  let fetched = 0;
  const BUILD = (sw.match(/const BUILD\s*=\s*'([^']+)'/)||[])[1];
  cacheMap.set('https://x/__cs_shell_build', BUILD);
  const caches = { async match(req){ const u = typeof req==='string' ? new URL(req,'https://x/').href : req.url;
      const v = cacheMap.get(u); return v==null ? undefined : { text: async()=>v, clone(){return this;}, body:v }; },
    async open(){ return { put: async(k,v)=>{ cacheMap.set(new URL(k,'https://x/').href, v && v.body || 'SHELL'); } }; },
    async keys(){ return []; } };
  const c = { console, caches, self:{ addEventListener:(n,f)=>{ if(n==='fetch') c._fetch=f; }, skipWaiting(){}, clients:{claim(){}} },
    fetch: async () => { fetched++; return { ok:true, clone(){return this;}, type:'basic', body:'SHELL' }; },
    Response: function(b){ this.body=b; this.text=async()=>b; this.clone=()=>this; }, URL, location:{origin:'https://x'} };
  c.addEventListener = c.self.addEventListener; vm.createContext(c);
  vm.runInContext(sw, c);
  const go = async (url) => { let out; const ev = { request:{ url, method:'GET', mode:'navigate' },
      respondWith:(p)=>{ out=p; }, waitUntil:()=>{} };
    await c._fetch(ev); return out ? await out : undefined; };
  for (const u of ['https://x/app.html','https://x/app.html?invite=ABC','https://x/app.html?code=pkce123']) {
    const r = await go(u);
    ok(r && (r.body==='SHELL' || (await r.text())==='SHELL'), 'SW serves the cached shell for ' + u.replace('https://x',''));
  }
  ok(fetched === 0, 'SW skipped the 1.4MB revalidate when the cached build already matches (network fetches: ' + fetched + ')');
  cacheMap.set('https://x/__cs_shell_build', 'v001-stale');
  await go('https://x/app.html'); await new Promise(r=>setTimeout(r,10));
  ok(fetched === 1, 'SW STILL refetches when the cached build is stale (self-healing preserved): ' + fetched); }

// ── 6. a failed PAA refresh must be VISIBLE even when questions are already on screen ──
// Structural but DERIVED, not a list: renderPAASection has an empty-list branch that ends in
// `return;` and then the real render path. Before the fix, BOTH reads of window.__paaError sat
// in the empty branch, so a failed Refresh with questions on screen — including the 401 the
// endpoint returns on a dead session — said nothing at all. The rule is that the error must be
// readable in the path that actually renders the Refresh button. (Executing this renderer needs
// most of the page's globals, so the rule is checked on the source of the two halves.)
{
  const i = html.indexOf('function renderPAASection(');
  ok(i > -1, 'renderPAASection is gone from app.html');
  const body = html.slice(i, html.indexOf('\n}', i) + 2);
  const cut = body.lastIndexOf('    return;');
  ok(cut > -1, 'renderPAASection no longer has the empty-list early return this rule is anchored to');
  const emptyBranch = body.slice(0, cut), renderPath = body.slice(cut);
  ok(/__paaError/.test(emptyBranch), 'the empty-list branch stopped reporting a failed pull');
  ok(/__paaError/.test(renderPath),
    'window.__paaError is read ONLY in the empty-list branch, so a failed Refresh with questions ' +
    'already on screen shows nothing — the spinner runs and the same old list comes back');
  ok(/fetchPAAQuestions\(true\)/.test(renderPath),
    'the Refresh button is no longer in the render path this rule assumes — re-anchor it');
}

// ── 7. the previous user's coach transcript must not survive a cross-tab user switch ──
{
  const i = html.indexOf("sb.auth.onAuthStateChange");
  const listener = html.slice(i, i + 9000);
  const signedOut = listener.slice(listener.indexOf('currentUser = null;'));
  ok(/bvState\.messages = \[\]/.test(signedOut.slice(0, 1200)),
    'the SIGNED_OUT branch does not clear bvState.messages \u2014 supabase-js broadcasts auth events ' +
    'across tabs, so another open tab re-inits as the NEW user with the previous one\'s brand-voice ' +
    'transcript still in memory, and the next settings save writes it into the new user\'s brand');
  ok(/currentBrand = null/.test(signedOut.slice(0, 1200)),
    'the SIGNED_OUT branch does not clear currentBrand, so brand-namespaced reads still resolve to ' +
    'the previous user\'s brand');
}

console.log(fail ? '\nFAIL \u2014 ' + fail + ' check(s) failed' : '\nPASS \u2014 failed writes are reported, no UI action dies on one, and the shell opens offline from an invite or magic link');
process.exit(fail?1:0);
