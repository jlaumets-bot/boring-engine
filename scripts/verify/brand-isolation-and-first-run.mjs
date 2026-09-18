#!/usr/bin/env node
// GATE: one brand's brain never reaches another, an access check that could not run never
//       destroys anything, and a new signup is never trapped on a dead screen.
//
// WHY THIS EXISTS — seven defects from two audits. Three could not be undone by the user.
//
//   1. "DEEP SCAN MY SITE" AND "READ MY CUSTOMER REVIEWS" WROTE ONE BRAND'S BRAIN INTO ANOTHER.
//      openBrainReview armed its brand gate when the SHEET OPENED — after the 1-4 minute scan.
//      So: start the scan, carry on working, switch brand, the scan lands. The sheet opens
//      listing brand A's tagline, USPs, audience, pain points, origin story and competitors
//      under the heading "Saving into <brand B>'s brand brain", with the "you switched brand"
//      refusal unable to fire, because the gate was armed on brand B. Save wrote all of it into
//      brand B permanently — and renamed brand B too, if its name was empty. Every post, coach
//      reply and daily push for brand B came out of that brain afterwards. A gate captured
//      BEFORE the fetch is the only one that can see the switch.
//
//   2. A TRANSIENT DATABASE ERROR PERMANENTLY DELETED THE OWNER'S OWN PUSH SUBSCRIPTION.
//      store._req RESOLVES on every HTTP status, so a PostgREST 500, a 503 HTML page or the
//      socket timeout all reached userCanAccessBrand as `data: null` and came back as a flat
//      `false` — indistinguishable from a real refusal. send-daily reads that as "this user
//      has no access to the brand they claim" and DELETES their subscription with the service
//      role. A brand owner silently stopped receiving their daily ping forever, on one blip,
//      while the Settings toggle still read ON (it is drawn from device-local storage). The
//      only trace was a log line accusing them of a security anomaly. `false` now means
//      denied; a check that could not run throws, and the caller that deletes must not act
//      on it. Every other caller already degrades safely — this gate does not re-check those,
//      but api/meme.js was given an explicit 503 branch rather than a misleading 403.
//
//   3. RE-OPENING THE ONBOARDING WIZARD LEFT A DEAD SCREEN WITH NO WAY OUT. A successful crawl
//      hides #obStep1Form and shows #obCrawlAnimation; obShowWizard restored the finish button
//      but never those, so the obFinish save-failure retry — or simply "+ Add new brand" after
//      onboarding via the crawl — showed a frozen "Building your brand brain ✓" card as the
//      entire first screen. The URL box, the submit button and the "Set it up by hand" escape
//      link all live in that one div; "Try again" and "Skip" live in the hidden error div. The
//      overlay is fixed and full-screen with no close button and no backdrop handler, so the
//      only exit was a reload — which throws away every answer, since nothing is persisted
//      until obFinish.
//
//   4. A CRAWL THAT FOUND NOTHING STILL SAID "YOUR BRAND BRAIN IS READY ✓" and dropped the user
//      on a blank form captioned "Here's what I found". 3 credits, a minute of "Finding your
//      competitors / Scanning reviews & press", and a green tick over nothing.
//
//   5. THE IDEAS EMPTY STATE PROMISED WORK THAT WAS NOT HAPPENING. "Your week of ideas is on
//      the way" — nothing generates on tab entry, and onboarding only makes one Quick Post.
//      The same sentence also showed for an empty FILTER, because the real filter message
//      below it could never be reached.
//
//   6. THE IDEAS MULTI-SELECT SURVIVED A BRAND SWITCH, and it holds array indexes — so ticking
//      three cards, switching brand and tapping "Approve 3 →" moved three of the NEW brand's
//      posts into the Pipeline and wrote it to that brand's database.
//
//   7. THE RENAME CLEANUP RESOLVED currentBrand AFTER ITS SAVE AWAIT, so a switch mid-save
//      aimed the delete at the wrong brand: it matched nothing, the superseded row stayed
//      forever, and the user was told "only the brand owner can remove it" — being the owner.
//
// HOW IT CHECKS
//   The real userCanAccessBrand and authorizedBrandId are RUN against healthy, denied and 5xx
//   responses. The real closeBrainReview is RUN with a gate reporting a switch, and must write
//   nothing. The real _dropRenamedIdeaRow is RUN with a mismatched pin, and must issue no
//   delete at all. The rest are derived structural rules anchored on ORDER — the gate before
//   the fetch, the selection cleared before `state` is rebuilt, the pin taken before the save —
//   because order is the whole defect in each case.
//
// RUN:    node scripts/verify/brand-isolation-and-first-run.mjs
// EXPECT: prints "PASS" and exits 0.
import fs from 'node:fs'; import vm from 'node:vm'; import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(ROOT+'/app.html','utf8');
const sd = fs.readFileSync(ROOT+'/api/send-daily.js','utf8');
const st = fs.readFileSync(ROOT+'/api/_publish/store.js','utf8');
let fail=0; const ok=(c,m)=>{ if(!c){console.log('FAIL:',m);fail++;} else console.log('ok:',m); };
const grab = n => { let i = html.indexOf('\nfunction '+n+'('); if(i<0) i = html.indexOf('\nasync function '+n+'(');
  if(i<0) throw new Error('no '+n);
  const eol = html.indexOf('\n', i+1), first = html.slice(i+1, eol);
  let d=0,seen=false; for(const ch of first){ if(ch==='{'){d++;seen=true;} else if(ch==='}')d--; }
  if(seen && d===0) return first;
  return html.slice(i+1, html.indexOf('\n}', i)+2); };

// ── 1. an access check that could not run must not read as "denied" ─────────
{
  const a = st.indexOf('async function userCanAccessBrand');
  const seg = st.slice(a, st.indexOf('\n}', a)+2);
  const run = async (ownedRes, memRes) => {
    const c = { console, encodeURIComponent, Error,
      _req: async (m,p) => p.includes('brand_members') ? memRes : ownedRes };
    vm.createContext(c); vm.runInContext(seg, c);
    try { return { v: await vm.runInContext("userCanAccessBrand('U1','B1')", c) }; }
    catch (e) { return { threw: e }; }
  };
  let r = await run({status:200, data:[{id:'B1', user_id:'U1'}]}, {status:200, data:[]});
  ok(r.v === true, 'the owner is allowed');
  r = await run({status:200, data:[{id:'B1', user_id:'OTHER'}]}, {status:200, data:[{brand_id:'B1'}]});
  ok(r.v === true, 'a member is allowed');
  r = await run({status:200, data:[{id:'B1', user_id:'OTHER'}]}, {status:200, data:[]});
  ok(r.v === false, 'a genuine stranger is DENIED (false), and that still means denied');
  r = await run({status:500, data:null}, {status:500, data:null});
  ok(!!r.threw && r.threw.accessCheckFailed, 'a PostgREST 500 THROWS instead of reading as denied');
  r = await run({status:200, data:[{id:'B1', user_id:'OTHER'}]}, {status:503, data:null});
  ok(!!r.threw, 'a 503 on the membership read throws too');
  r = await run({status:200, data:[]}, {status:200, data:[]});
  ok(r.v === false, 'a brand that does not exist is denied, not an error');
}
// ── and the caller that DELETES must not act on an unknown ──────────────────
{
  const a = sd.indexOf('async function authorizedBrandId');
  const seg = sd.slice(a, sd.indexOf('\n}', a)+2);
  const run = async (impl) => {
    const c = { console: { error(){}, log(){} }, store: { userCanAccessBrand: impl } };
    vm.createContext(c); vm.runInContext(seg, c);
    return vm.runInContext("authorizedBrandId({ id:'s1', user_id:'U1', brand_id:'B1' })", c);
  };
  ok(await run(async()=>true) === 'B1', 'a verified brand comes back as its id');
  ok(await run(async()=>false) === null, 'a genuinely denied brand comes back as a flat null (deletable)');
  const unk = await run(async()=>{ const e=new Error('down'); e.accessCheckFailed=true; throw e; });
  ok(unk && unk.unknown === true, 'a check that could NOT run comes back as { unknown: true }');
  // the delete branch must require BOTH not-verified and not-unknown
  ok(/if \(sub\.brand_id && !brandId && !_accessUnknown\) \{/.test(sd),
     'the delete branch requires the check to have actually run');
  const delAt = sd.indexOf("sbDelete(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,\n              '/rest/v1/push_subscriptions");
  const guardAt = sd.indexOf('!brandId && !_accessUnknown');
  ok(guardAt > -1 && delAt > guardAt, 'and the guard is before the delete');
}
// ── 2. the brain-review sheet must inherit a gate armed BEFORE the fetch ────
{
  ok(/_brainReviewGate = \(opts && typeof opts\.gate === 'function'\) \? opts\.gate/.test(html),
    'openBrainReview uses a caller-supplied gate when it has one');
  for (const [fn, label] of [['spDraftFromCrawl','Deep scan my site'], ['pullReviews','Read my customer reviews']]) {
    const body = grab(fn);
    const gateAt = body.indexOf('brandGate()');
    const fetchAt = body.indexOf('await fetch');
    ok(gateAt > -1 && gateAt < fetchAt, label + ': the brand gate is captured BEFORE the fetch');
    ok(/openBrainReview\([^)]*\{ gate: _sameBrand/.test(body) || /gate: _sameBrand/.test(body),
       label + ': and handed to the review sheet');
  }
  // run the real refusal with a gate that reports a switch
  const c = { console, settings: { brandName: 'Beta Ltd' }, showToast: (m)=>c.toasts.push(m), toasts: [],
    saveSettings: ()=>{ c.saved = true; }, document: { getElementById: ()=>null },
    renderSettingsPanel: ()=>{}, bvRenderHome: ()=>{}, requestAnimationFrame: (f)=>f(),
    _brainFills: null, _brainReviewOpts: null, _brainReviewGate: null, _brainReviewBrandName: '' };
  vm.createContext(c);
  vm.runInContext('var _brainFills=null,_brainReviewOpts=null,_brainReviewGate=null,_brainReviewBrandName="";\n' + grab('closeBrainReview'), c);
  vm.runInContext(`
    _brainFills = [{key:'tagline', value:'Hot yoga for tired parents', keep:true}];
    _brainReviewGate = function(){ return false; };   // the user switched brand
    _brainReviewBrandName = 'Alpha Yoga';
  `, c);
  vm.runInContext('closeBrainReview(true)', c);
  ok(!c.saved, "a switch mid-scan writes NOTHING (saveSettings not called)");
  ok(c.toasts.some(t=>/switched brand/.test(t)), 'and the user is told why: ' + JSON.stringify((c.toasts[0]||'').slice(0,70)));
}
// ── 3. the wizard must never re-open onto a dead screen ────────────────────
{
  const body = grab('obShowWizard');
  for (const id of ['obStep1Form', 'obCrawlAnimation', 'obCrawlError'])
    ok(body.includes(id), 'obShowWizard restores #' + id);
  ok(/obStep1Form[\s\S]{0,60}display = 'block'/.test(body), 'and puts the URL form back on screen');
  ok(/obCrawlAnimation[\s\S]{0,60}display = 'none'/.test(body), 'and hides the finished crawl card');
}
// ── 4. a crawl that found nothing must not claim a brand brain ─────────────
{
  const body = grab('obCompleteSteps');
  ok(/found === 0/.test(body), 'obCompleteSteps branches on how much was actually found');
  ok(/couldn't pull much from that site/i.test(body), 'and says so honestly when nothing landed');
  ok(/obCompleteSteps\(\(\) => obGoToStep\(2\), _got\)/.test(html), 'the crawl passes the real count');
  ok(html.includes('function obCrawlFilledCount()'), 'and the counter exists');
}
// ── 5. the Ideas empty state must not promise work that is not happening ───
{
  const body = grab('renderIdeas');
  // strip comments from the slice before looking for the old string — the new comment
  // quotes it to explain what was wrong, and a name in a COMMENT is not code
  const code = body.replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').filter(l=>!/^\s*\/\//.test(l)).join('\n');
  ok(!/Your week of ideas is on the way/.test(code), 'the "on the way" lie is gone from the code');
  ok(/Nothing matches those filters/.test(body) && /No ideas yet/.test(body),
     'and both real situations now have their own message');
  const anyAt = body.indexOf('_anyIdeas');
  const unreachable = body.indexOf("if(!html) html = renderEmptyState('', 'Nothing matches those filters'");
  ok(anyAt > -1, 'the branch is decided by whether any ideas exist at all');
}
// ── 6. the multi-select must not survive a brand switch ───────────────────
{
  const sw = grab('switchBrand');
  ok(/_ideaSelected[\s\S]{0,40}\.clear\(\)/.test(sw), 'switchBrand clears the idea selection');
  ok(/_ideaSelectMode = false/.test(sw), 'and leaves select mode');
  const clearAt = sw.indexOf('_ideaSelected');
  const stateAt = sw.indexOf('state = IDEAS.map');
  ok(clearAt > -1 && stateAt > -1 && clearAt < stateAt, 'before `state` is rebuilt with new ids');
}
// ── 7. the rename cleanup must be pinned to the brand it was queued in ────
{
  const q = grab('_saveThenDropRenamedRow'), d = grab('_dropRenamedIdeaRow');
  ok(/const _pinned = \(currentBrand && currentBrand\.id\) \|\| null;/.test(q), 'the brand is pinned at queue time');
  const pinAt = q.indexOf('_pinned ='), awaitAt = q.indexOf('saveIdeasToDB()');
  ok(pinAt > -1 && pinAt < awaitAt, 'and before the save is started');
  ok(/_dropRenamedIdeaRow\(oldTitle, newTitle, _pinned\)/.test(q), 'and handed to the cleanup');
  ok(!/\.eq\('brand_id', currentBrand\.id\)\.eq\('title', a\)/.test(d), 'the delete no longer reads the live global');
  ok(/const _bid = pinnedBrandId \|\| currentBrand\.id;/.test(d), 'it uses the pinned id');
  ok(/brand changed mid-save/.test(d), 'and skips rather than deleting in the wrong brand');
  // run it: a switch mid-save must delete NOTHING
  const c = { console: { warn(){ c.warned = true; }, error(){} }, currentBrand: { id: 'BRAND-B' }, state: [],
    window: {}, showToast: ()=>{}, sb: { from(){ return { delete(){ c.deleted = true; return this; },
      eq(){ return this; }, select(){ return Promise.resolve({data:[{id:'x'}], error:null}); } }; } } };
  vm.createContext(c); vm.runInContext(d, c);
  await vm.runInContext("_dropRenamedIdeaRow('Old','New','BRAND-A')", c);
  ok(!c.deleted && c.warned, 'a switch mid-save issues NO delete at all (deleted=' + !!c.deleted + ')');
  c.deleted = false; c.warned = false;
  await vm.runInContext("_dropRenamedIdeaRow('Old','New','BRAND-B')", c);
  ok(c.deleted && !c.warned, 'the same brand still cleans up normally');
}
console.log(fail ? '\nFAIL \u2014 ' + fail + ' check(s) failed' : '\nPASS \u2014 no brand can write into another, an unverifiable check destroys nothing, and the wizard always has a way out');
process.exit(fail?1:0);
