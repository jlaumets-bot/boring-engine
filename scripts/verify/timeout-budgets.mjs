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
  const tos = [...s.matchAll(/timeoutMs\s*:\s*(\d+)/g)].map(m => +m[1]);
  // A self-imposed total budget (e.g. FN_BUDGET_MS) bounds every leg, so it IS the worst case.
  const budgetConst = s.match(/(?:FN_BUDGET_MS|TOTAL_BUDGET_MS|BUDGET_MS)\s*=\s*(\d+)/);
  let worst = llmCalls ? (budgetConst ? +budgetConst[1] : (tos.length ? Math.max(...tos) * llmCalls : 240000)) : 0;
  if (grok) { const race = s.match(/setTimeout\(\(\)\s*=>\s*r\(null\),\s*(\d+)\)/); worst += race ? +race[1] : 90000; }
  const budget = md[name] ?? 10, internal = Math.floor(worst / 1000);
  judged++;
  if (internal > budget) bad.push(`${name}: ${internal}s internal vs ${budget}s budget`);
}
if (!judged) { console.error('no LLM endpoints found — check is not exercising anything'); process.exit(1); }
if (bad.length) { console.error('MISMATCHED:\n  ' + bad.join('\n  ')); process.exit(1); }
console.log(`judged ${judged} LLM endpoints, all internal timeouts fit their budget`);

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
