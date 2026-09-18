#!/usr/bin/env node
// GATE: what the app says about someone's plan must be something it actually knows, and a
//       refusal must name the real reason.
//
// WHY THIS EXISTS — three defects, one of which locked paying customers out of their billing.
//
//   1. A 200 IS NOT THE SAME AS AN ANSWER. api/_usage.js getStatus() fails OPEN: when the usage
//      read throws — and it issues up to 25 paged PostgREST queries, any of which can stall on
//      the 8s timeout — it returns HTTP 200 with { unknown: true, plan: 'trial', used: 0,
//      limit: 150 }. The client read the 200 and took the plan at face value. A Pro or Agency
//      subscriber then saw "Trial plan · 0 / 150 posts", no "Active" tag, an Upgrade button,
//      and the onboarding checklist back on screen — their subscription looked gone. Worse,
//      openBillingPortal is reachable from exactly three places, and all three need either
//      csUsage === null or a paid plan name, so A PAYING CUSTOMER HAD NO WAY TO UPDATE A CARD
//      OR CANCEL until the call happened to succeed. planBoxHtml's own comment says this bug
//      was fixed; the fix only ever covered csUsage === null, never the fail-open half.
//
//   2. "REBUILD THE SIDEBAR ONCE" REBUILT IT AFTER EVERY ACTION. The guard asked whether a
//      `.ds-lock` pill was missing. _dsItem only renders that pill for 'blog' and 'meme', and
//      both are shelved (CS_SHELVED), so the sidebar can never contain one — the condition was
//      permanently true. refreshUsage runs 1.2s after every successful /api/ call, so for every
//      free-plan user the whole left sidebar was destroyed and re-created a second after each
//      generation, remix or trend pull: flicker, lost hover, lost scroll, forever.
//
//   3. A BURST TRIP READ AS AN EMPTY WALLET. checkLimit's `reason` gained a 'rate' value (the
//      60/min limiter, which applies to every plan and costs nobody any allowance). Four
//      endpoints branched on it; TWENTY-TWO returned a flat 402 limit_reached, and app.html's
//      fetch wrapper turns any limit_reached 402 into the upgrade modal. So a user who simply
//      went too fast was told "Your free posts are used up — Upgrade to Pro" with their
//      allowance barely touched, and a paying customer got a billing modal instead of "try
//      again in a moment". There was no Retry-After either, so nothing said to just wait.
//      The fix is ONE helper — denyResponse — so the next `reason` value cannot leave
//      twenty-two endpoints behind again; this gate pins that rule, not a list of files.
//
// HOW IT CHECKS
//   It RUNS the real code: denyResponse is imported from api/_usage.js and driven through every
//   reason; refreshUsage, planBoxHtml and planLabel are lifted out of app.html and run against
//   the LITERAL fail-open body api/_usage.js builds; the sidebar rebuild is counted across eight
//   simulated actions. One arm is a mutation check — feeding the pre-fix path the same body
//   MUST still produce "Trial plan" + Upgrade with no billing route — so a green result here
//   cannot come from a test that no longer tests anything.
//
// RUN:    node scripts/verify/plan-honesty.mjs
// EXPECT: prints "PASS" and exits 0.
import fs from 'node:fs'; import vm from 'node:vm'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
let fail=0; const ok=(c,m)=>{ if(!c){console.log('FAIL:',m);fail++;} else console.log('ok:',m); };
const grab = n => { let i = html.indexOf('\nfunction '+n+'('); if(i<0) i = html.indexOf('\nasync function '+n+'(');
  if(i<0) throw new Error('no '+n);
  const eol = html.indexOf('\n', i+1), first = html.slice(i+1, eol);
  let d=0,seen=false; for(const ch of first){ if(ch==='{'){d++;seen=true;} else if(ch==='}')d--; }
  if(seen && d===0) return first;
  return html.slice(i+1, html.indexOf('\n}', i)+2); };

// ── 1. the exact body the server sends when the usage read fails open ─────────
const usage = require(path.join(ROOT, 'api', '_usage.js'));
ok(typeof usage.denyResponse === 'function', 'api/_usage.js exports denyResponse');

const c = { console, document:{ getElementById:()=>null, querySelector:()=>null }, window:{},
  csUsage:null, csUsageLoadFailed:false, _csUsageRetries:0, _csUsageRetryT:null,
  renderUsagePill:()=>{}, renderOnb:()=>{}, csIsFree:()=>false, syncPushTimezone:()=>{},
  planBoxHtml:()=>'', Math, Date, setTimeout:()=>{} };
// the literal shape api/_usage.js:754 builds, plus the brands rider api/usage.js adds
const FAILOPEN = { ok:true, unknown:true, plan:'trial', used:0, limit:150, remaining:150,
  cost:0, costCap:5, recent:0, trialEndsAt:null, trialDaysLeft:null,
  brands:{ canCreate:true, count:null, limit:null, reason:'unknown', unknown:true } };
c.fetch = async () => ({ ok:true, json: async () => FAILOPEN });
vm.createContext(c);
vm.runInContext('var csUsage=null, csUsageLoadFailed=false, _csUsageRetries=0, _csUsageRetryT=null;\n' + grab('refreshUsage'), c);
await vm.runInContext('refreshUsage()', c);
ok(vm.runInContext('csUsage', c) === null, 'a fail-open 200 is NOT taken as the plan (csUsage stays null)');
ok(vm.runInContext('csUsageLoadFailed', c) === true, 'and is recorded as "we could not check"');
ok(c.window._csBrandLimit && c.window._csBrandLimit.unknown === true, 'the brand-limit rider is kept for the brand guard');
// a REAL answer must still land
c.fetch = async () => ({ ok:true, json: async () => ({ ok:true, plan:'pro', used:12, limit:1000, brands:{canCreate:true} }) });
await vm.runInContext('refreshUsage()', c);
ok(vm.runInContext('csUsage && csUsage.plan', c) === 'pro', 'a real answer still lands (plan=pro)');
ok(vm.runInContext('csUsageLoadFailed', c) === false, 'and clears the failure flag');

// ── what the paying subscriber actually SEES in each state ───────────────────
{
  const p = { console, csUsage:null, csUsageLoadFailed:true };
  vm.createContext(p);
  vm.runInContext([grab('planLabel'), grab('planBoxHtml')].join('\n'), p);
  const box = vm.runInContext('planBoxHtml()', p);
  ok(!/Trial plan/.test(box), 'the Plan box no longer says "Trial plan" when the read failed');
  ok(/Manage billing/.test(box), 'and it still offers a route to billing: ' + (box.match(/>([^<]*billing[^<]*)</i)||[])[1]);
  ok(!/Upgrade/.test(box), 'and does not push an Upgrade button at a paying subscriber');
  // MUTATION: the pre-fix path really did show "Trial plan" + Upgrade
  p.csUsage = FAILOPEN; p.csUsageLoadFailed = false;
  const pre = vm.runInContext('planBoxHtml()', p);
  ok(/Trial plan/.test(pre) && /Upgrade/.test(pre) && !/Manage plan/.test(pre),
    'MUTATION CHECK: accepting the fail-open body DOES produce "Trial plan" + Upgrade with no billing route');
}

// ── 2. the sidebar rebuild must happen at most once ──────────────────────────
{
  let builds = 0;
  const q = { console, window:{}, csIsFree:()=>true, buildDesktopSidebar:()=>{ builds++; },
    syncDesktopNav:()=>{}, renderUsagePill:()=>{}, renderOnb:()=>{}, syncPushTimezone:()=>{},
    document:{ getElementById:(id)=> id==='desktopSidebar' ? { remove(){} } : null, querySelector:()=>null },
    Math, Date, setTimeout:()=>{} };
  q.fetch = async () => ({ ok:true, json: async () => ({ ok:true, plan:'free', used:1, limit:40 }) });
  vm.createContext(q);
  vm.runInContext('var csUsage=null, csUsageLoadFailed=false, _csUsageRetries=0, _csUsageRetryT=null;\n' + grab('refreshUsage'), q);
  for (let i=0;i<8;i++) await vm.runInContext('refreshUsage()', q);
  ok(builds === 1, 'the desktop sidebar is rebuilt ONCE across 8 actions, not 8 times (got ' + builds + ')');
}

// ── 3. a burst trip must never read as an empty wallet ───────────────────────
{
  const mk = () => { const r = { code:0, body:null, headers:{} };
    return { res: { status(c2){ r.code=c2; return this; }, json(b){ r.body=b; return b; },
                    setHeader(k,v){ r.headers[k]=v; } }, r }; };
  let m = mk(); usage.denyResponse(m.res, { reason:'rate', retryAfter:60, plan:'free', used:3, limit:40 });
  ok(m.r.code === 429, 'a rate trip answers 429, not 402 (got ' + m.r.code + ')');
  ok(m.r.body.error === 'rate_limited', 'and says rate_limited, not limit_reached');
  ok(m.r.headers['Retry-After'] === '60', 'and sets Retry-After: ' + m.r.headers['Retry-After']);
  m = mk(); usage.denyResponse(m.res, { reason:'limit', plan:'free', used:40, limit:40, trialEndsAt:null });
  ok(m.r.code === 402 && m.r.body.error === 'limit_reached', 'a real limit still answers 402 limit_reached');
  ok(m.r.body.used === 40 && m.r.body.limit === 40, 'and still carries the numbers the upgrade modal shows');
  m = mk(); usage.denyResponse(m.res, { reason:'feature', feature:'meme', plan:'free' });
  ok(m.r.code === 402 && m.r.body.error === 'feature_locked' && m.r.body.feature === 'meme', 'a feature lock still answers feature_locked');
  m = mk(); usage.denyResponse(m.res, { reason:'cost_cap', plan:'trial', used:5, limit:150 });
  ok(m.r.code === 402 && m.r.body.error === 'limit_reached', 'a cost-cap trip still blocks the request');
}

// ── every gated endpoint must go through the one helper ──────────────────────
{
  const files = fs.readdirSync(path.join(ROOT,'api')).filter(f=>f.endsWith('.js') && f !== '_usage.js');
  const handRolled = [];
  for (const f of files) {
    const t = fs.readFileSync(path.join(ROOT,'api',f),'utf8');
    const code = t.split('\n').filter(l=>!/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    if (/status\(402\)\.json\(\{\s*error:\s*(['"]limit_reached|_gate\.reason)/.test(code)) handRolled.push(f);
  }
  ok(handRolled.length === 0, 'endpoints still writing the refusal by hand instead of denyResponse: ' + handRolled.join(', '));
  let n = 0; for (const f of files) if (/denyResponse\(res/.test(fs.readFileSync(path.join(ROOT,'api',f),'utf8'))) n++;
  ok(n >= 24, n + ' endpoints route their refusal through denyResponse');
}

// the client must not open the billing modal on a burst trip
{
  const w = html.slice(html.indexOf('const _resp = await _origFetch'), html.indexOf('} else if (_resp && _resp.ok'));
  ok(/_resp\.status === 429/.test(w), 'the fetch wrapper inspects 429 at all');
  const burst = w.indexOf('const _burst');
  const up = w.indexOf("showUpgrade(d)");
  ok(burst > -1 && burst < up, 'the burst branch is decided BEFORE showUpgrade can fire');
  ok(/_burst\s*$|\?\s*'Going a bit fast/.test(w) || /_burst/.test(w.slice(0, w.indexOf('_tpBlobInHand') + 400)),
    'the held-take guard also checks for a burst before claiming "out of posts"');
}

console.log(fail ? '\nFAIL — ' + fail + ' check(s) failed' : '\nPASS');
process.exit(fail?1:0);
