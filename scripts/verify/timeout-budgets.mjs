// Every endpoint's worst-case INTERNAL timeout must sit UNDER its platform maxDuration, or Vercel
// kills it with a raw 504 instead of our retryable error. Measured from source, not from a claim.
import fs from 'fs'; import path from 'path';
const root = process.cwd();
const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
const md = {}; for (const [k, v] of Object.entries(vercel.functions || {})) md[k.replace('api/','').replace('.js','')] = v.maxDuration;
const bad = []; let judged = 0;
for (const f of fs.readdirSync(path.join(root, 'api')).filter(f => f.endsWith('.js'))) {
  const name = f.slice(0, -3); if (name.startsWith('_')) continue;
  const s = fs.readFileSync(path.join(root, 'api', f), 'utf8');
  const llmCalls = (s.match(/callLLM\(/g) || []).length;
  const grok = s.includes('callGrokSearch(');
  if (!llmCalls && !grok) continue;
  /* v689 — THIS CHECK PASSED THREE ENDPOINTS THAT WERE OVER BUDGET.
     The old model was max(timeoutMs) * (count of callLLM), and it was blind to two things:
       • EVERY NON-LLM TIMEOUT. api/meme.js awaits a 45s callLLM and then a 50s image call whose
         timeout is written `timeout: 50000`; api/hook-frame.js fetches a thumbnail twice at 12s
         each before its 45s callLLM. Neither cost was counted, so 95s and 69s of sequential work
         both "fit" a 60s budget.
       • THE RETRY LOOP. callXAI retried while `(Date.now() - t0) < 150000` — a test of whether an
         attempt may START. The attempt then ran its full timeoutMs on top, so the real worst case
         per callLLM was 150s + timeoutMs. api/video-beats.js at timeoutMs 285000 could therefore
         reach 436s against a 300s budget.
     When the platform kills a function the caller never sees our JSON: it gets Vercel's own 504
     page, and the app prints the parse error verbatim ("Unexpected token 'A'...").
     The model now counts what the code actually waits on, and credits deadlineMs — which bounds
     a whole call including its retries — where an endpoint declares one. */
  const num = (re) => [...s.matchAll(re)].map(m => +m[1]);
  const deadlines = num(/deadlineMs\s*:\s*(\d+)/g);
  const tos = num(/timeoutMs\s*:\s*(\d+)/g);
  // Non-LLM waits: plain `timeout: N` options, socket setTimeout, and AbortSignal.timeout.
  const otherTos = [
    ...num(/[^a-zA-Z]timeout\s*:\s*(\d+)/g),
    ...num(/\.setTimeout\(\s*(\d+)/g),
    ...num(/AbortSignal\.timeout\(\s*(\d+)\s*\)/g),
    ...num(/opts\.timeout\s*\|\|\s*(\d+)/g),
  ];
  const budgetConst = s.match(/(?:FN_BUDGET_MS|TOTAL_BUDGET_MS|BUDGET_MS)\s*=\s*(\d+)/);
  let worst = 0;
  if (llmCalls) {
    if (budgetConst) worst = +budgetConst[1];                 // a self-imposed total bounds every leg
    else if (deadlines.length) worst = Math.max(...deadlines) * llmCalls;
    else if (tos.length) worst = (150000 + Math.max(...tos)) * llmCalls;   // the retry loop, honestly
    else worst = 240000 * llmCalls;
  }
  // Sequential by default: an endpoint that awaits an image call after an LLM call pays for both.
  if (!budgetConst && otherTos.length) worst += Math.max(...otherTos);
  /* callGrokSearch honours opts.timeoutMs since v686 — it bounds the socket AND the one retry —
     so an explicit timeoutMs at the call site is the real cost. A race wrapper still counts, and
     with neither we assume the function's own 90s default. */
  if (grok) {
    const gto = [...s.matchAll(/callGrokSearch\([\s\S]{0,900}?timeoutMs:\s*(\d+)/g)].map(m => +m[1]);
    const race = s.match(/setTimeout\(\(\)\s*=>\s*r\(null\),\s*(\d+)\)/);
    worst += gto.length ? Math.max(...gto) : (race ? +race[1] : 90000);
  }
  const budget = md[name] ?? 10, internal = Math.floor(worst / 1000);
  judged++;
  if (internal > budget) bad.push(`${name}: ${internal}s internal vs ${budget}s budget`);
}
if (!judged) { console.error('no LLM endpoints found — check is not exercising anything'); process.exit(1); }
if (bad.length) { console.error('MISMATCHED:\n  ' + bad.join('\n  ')); process.exit(1); }
console.log(`judged ${judged} LLM endpoints, all internal timeouts fit their budget`);

/* ── the retry loop itself, RUN ─────────────────────────────────────────────────────────────
   Everything above is arithmetic over the source. It is only true if _roomFor actually honours
   deadlineMs at runtime — and the bug it replaces was exactly a condition that looked right and
   asked the wrong question: `(Date.now() - t0) < 150000` tests whether an attempt may START,
   while the attempt then runs its full timeoutMs on top. So lift the real function and run it. */
{
  const llmSrc = fs.readFileSync(path.join(root, 'api', '_llm.js'), 'utf8');
  const i = llmSrc.indexOf('  const _roomFor = (attempt) => {');
  if (i < 0) { console.error('RETRY BOUND: _roomFor is gone from api/_llm.js — re-anchor this check'); process.exit(1); }
  const body = llmSrc.slice(i, llmSrc.indexOf('\n  };', i) + 5);
  const mk = (deadlineMs, timeoutMs, elapsed) => {
    const t0 = Date.now() - elapsed;
    const backoff = () => 1000;                       // fixed, so the assertion is deterministic
    // eslint-disable-next-line no-new-func
    const f = new Function('t0', 'deadlineMs', 'timeoutMs', 'backoff',
      body + '\nreturn _roomFor;')(t0, deadlineMs, timeoutMs, backoff);
    return f(0);
  };
  const problems = [];
  // With a deadline, a retry may only start if it can FINISH inside it.
  if (mk(50000, 45000, 10000) !== false)
    problems.push('with a 50s deadline, 45s per attempt and 10s already gone, another attempt is ' +
      'allowed to start — it cannot finish, so the platform kills the function instead');
  if (mk(250000, 45000, 10000) !== true)
    problems.push('with a 250s deadline and plenty of room, a retry is refused — that removes the ' +
      'resilience the retry loop exists for');
  if (mk(50000, 45000, 0) !== true)
    problems.push('a FIRST retry with a full deadline available is refused');
  // Without a deadline the old behaviour must be untouched, or every caller changes at once.
  if (mk(0, 45000, 10000) !== true || mk(0, 45000, 200000) !== false)
    problems.push('the no-deadline path no longer behaves as it did (elapsed < 150000)');
  if (problems.length) {
    console.error('RETRY BOUND BROKEN:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  console.log('retry bound: a retry starts only when it can finish inside the deadline; callers without one are unchanged');
}

// ── the Supabase floor ──────────────────────────────────────────────────────────────────────
// The Supabase helpers share ONE default timeout while every endpoint has its OWN budget, so the
// default is only safe if it fits the TIGHTEST endpoint that can reach it. That floor has now
// been worked out by hand four separate times (v606 and v627 both missed it and shipped an
// endpoint on the ~10s platform default; v628 computed it; v637 had to recompute it after v629
// deleted two of the endpoints that set it). Recomputing it by hand is exactly the step that
// keeps getting skipped, so it is computed here instead.
//
// An endpoint reaches Supabase directly via _usage/_publish/store, or transitively through
// _requireUser / _brandctx. Its budget is its declared maxDuration, or Vercel's ~10s default when
// it is absent from the functions map — that absence is the trap, and it is what this catches.
const apiDir = path.join(root, 'api');
const readApi = f => fs.readFileSync(path.join(apiDir, f), 'utf8');
const REACHES = /require\(['"]\.\/(?:_usage|_brandctx|_requireUser|_publish\/store)['"]\)/;

// _requireUser and _brandctx are themselves helpers; anything requiring them inherits the reach.
let floor = Infinity, floorBy = null, reaching = 0;
for (const f of fs.readdirSync(apiDir).filter(f => f.endsWith('.js') && !f.startsWith('_'))) {
  if (!REACHES.test(readApi(f))) continue;
  reaching++;
  const budget = md[f.slice(0, -3)] ?? 10;      // undeclared => platform default
  if (budget < floor) { floor = budget; floorBy = f; }
}

// The worst realistic chain is two sequential Supabase calls (auth healthy, PostgREST stalled:
// getUser answers, then userCanAccessBrand stalls), plus ~1s to actually write a response. If
// that does not fit the floor, the endpoint dies on the platform with no body and no log — which
// is strictly worse than the logged timeout this default exists to produce.
const SB_DEFAULT = (() => {
  const a = readApi('_usage.js').match(/let\s+SB_TIMEOUT_MS\s*=\s*(\d+)/);
  const b = fs.readFileSync(path.join(apiDir, '_publish/store.js'), 'utf8')
              .match(/let\s+REQ_TIMEOUT_MS\s*=\s*(\d+)/);
  if (!a || !b) return null;
  return Math.max(+a[1], +b[1]);
})();

if (SB_DEFAULT === null) {
  console.error('could not read the shared Supabase timeout defaults — this check cannot run, ' +
                'so it fails rather than passing vacuously (both must be `let NAME = <number>`)');
  process.exit(1);
}
if (!reaching) { console.error('no endpoint reaches Supabase — check is not exercising anything'); process.exit(1); }

const needed = SB_DEFAULT * 2 + 1000;
if (needed > floor * 1000) {
  console.error(
    `SUPABASE DEFAULT TOO HIGH FOR THE FLOOR:\n` +
    `  shared default ${SB_DEFAULT}ms x2 sequential calls +1s to respond = ${needed}ms\n` +
    `  tightest endpoint that can reach Supabase: ${floorBy} at ${floor}s` +
    (md[floorBy.slice(0, -3)] === undefined ? ' (UNDECLARED — running on the platform default)' : '') +
    `\n  Either lower the default, or give ${floorBy} an explicit maxDuration in vercel.json.\n` +
    `  A long-budget caller should raise it for itself with setRequestBudget(), not globally.`
  );
  process.exit(1);
}
console.log(`supabase floor: ${reaching} endpoints reach it, tightest is ${floorBy} at ${floor}s; ` +
            `shared default ${SB_DEFAULT}ms fits (needs ${needed}ms)`);
console.log('timeout budget verification passed');
