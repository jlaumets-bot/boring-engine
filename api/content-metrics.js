// v693 — FILMED RATE PER WRITING FLOW (PLAN.md C-API-5).
//
// WHY: the only outcome that proves a script is good is that someone actually filmed it. content-v2
// stamps every idea it writes with ideas.gen_flow = 'v2'; everything older has no stamp and counts
// as 'v1'. This answers, per flow: how many AI ideas were generated, how many reached
// status filming/done, and the rate.
//
// ONE GROUPED QUERY: public.content_metrics() (sql/ideas-gen-flow.sql) groups in the database.
// Until that SQL has run, the same counts come from a paged read of just two columns. If the
// gen_flow column itself is missing, every idea is counted as 'v1' and the response says so
// (genFlowColumn:false plus a note) rather than pretending a comparison exists.
//
// Read-only, no AI, no credits. Signed-in user + userCanAccessBrand.
const store = require('./_publish/store');

const PAGE = 1000;
const MAX_PAGES = 5;         // 5,000 ideas in the window; past that the answer says partial:true
const DEFAULT_DAYS = 90;

const okStatus = (r) => !!(r && r.status >= 200 && r.status < 300);
const fnMissing = (r) => !!(r && r.status === 404 && (!r.data || r.data.code === 'PGRST202' || r.data.code === '42883'));
const columnMissing = (r) => !!(r && r.status >= 400 && r.data && (r.data.code === '42703' || r.data.code === 'PGRST204' ||
  /gen_flow/i.test(String(r.data.message || ''))));

function shape(counts) {
  const order = (f) => (f === 'v1' ? 0 : f === 'v2' ? 1 : 2);
  return Object.keys(counts).sort((a, b) => order(a) - order(b) || a.localeCompare(b)).map(flow => {
    const g = counts[flow].generated, f = counts[flow].filmed;
    return { flow, generated: g, filmed: f, rate: g ? Math.round((f / g) * 1000) / 1000 : null };
  });
}

// v693 r5 — A REQUEST DEADLINE. Each Supabase call has only an 8s SILENCE timeout, so a slow but
// talking database could keep this endpoint busy for ~80s (grouped function missing → up to 5 pages)
// and the platform would kill it at maxDuration with no answer. Every database call now runs inside
// one request budget; a call that cannot get at least LIMITS.minCallMs is not started, and one that
// overruns what is left is abandoned. The caller gets 503 {code:'timeout'} instead of a dead request.
// (Exported so the gate can shrink the numbers; nothing else changes them.)
const LIMITS = { budgetMs: 50000, minCallMs: 9000 };
function timeoutError() { const e = new Error('content-metrics ran out of time'); e.code = 'timeout'; return e; }
function makeClock(t0) {
  return async (fn) => {
    const left = LIMITS.budgetMs - (Date.now() - t0);
    if (left < LIMITS.minCallMs) throw timeoutError();
    let h = null;
    try { return await Promise.race([fn(), new Promise((_, rej) => { h = setTimeout(() => rej(timeoutError()), left); })]); }
    finally { if (h) clearTimeout(h); }
  };
}

// Fallback: page through (gen_flow,status) — or (status) alone when the column is missing.
async function countByRows(brandId, sinceIso, timed) {
  let withFlow = true;
  const counts = {};
  for (let page = 0; page < MAX_PAGES; page++) {
    const cols = withFlow ? 'gen_flow,status' : 'status';
    const path = '/ideas?brand_id=eq.' + encodeURIComponent(brandId) + '&is_generated=is.true' +
      '&created_at=gte.' + encodeURIComponent(sinceIso) + '&select=' + cols +
      '&order=created_at.desc&limit=' + PAGE + '&offset=' + (page * PAGE);
    const r = await timed(() => store.rest('GET', path));
    if (withFlow && columnMissing(r)) { withFlow = false; page = -1; for (const k of Object.keys(counts)) delete counts[k]; continue; }
    if (!okStatus(r)) return { error: true };
    const rows = Array.isArray(r.data) ? r.data : [];
    for (const row of rows) {
      const flow = (withFlow && row.gen_flow) ? String(row.gen_flow) : 'v1';
      const c = counts[flow] || (counts[flow] = { generated: 0, filmed: 0 });
      c.generated++;
      if (row.status === 'filming' || row.status === 'done') c.filmed++;
    }
    if (rows.length < PAGE) return { counts, genFlowColumn: withFlow, complete: true };
  }
  return { counts, genFlowColumn: withFlow, complete: false };
}

module.exports = async function handler(req, res) {
  const allowed = ['https://contentshrimp.com', 'https://bettercontent.app', 'https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const timed = makeClock(Date.now());
  const tooSlow = () => res.status(503).json({ error: 'The numbers took too long to read — try again.', code: 'timeout' });
  let user = null;
  try { user = await timed(() => require('./_requireUser')(req)); }
  catch (e) { if (e && e.code === 'timeout') return tooSlow(); throw e; }
  if (!user) return res.status(401).json({ error: 'Please sign in again.' });

  const body = req.body || {};
  const brandId = String(body.brandId || '');
  if (!brandId) return res.status(400).json({ error: 'brandId is required' });
  let can = false;
  try { can = await timed(() => store.userCanAccessBrand(user.id, brandId)); }
  catch (e) { if (e && e.code === 'timeout') return tooSlow(); return res.status(503).json({ error: 'Could not check access to this brand — try again.' }); }
  if (!can) return res.status(403).json({ error: 'You do not have access to this brand.', code: 'forbidden' });

  const d = Number(body.days);
  const days = Number.isFinite(d) ? Math.max(1, Math.min(365, Math.round(d))) : DEFAULT_DAYS;
  const since = new Date(Date.now() - days * 86400000).toISOString();

  try {
    const r = await timed(() => store.rest('POST', '/rpc/content_metrics', { body: { p_brand_id: brandId, p_since: since } }));
    if (okStatus(r) && Array.isArray(r.data)) {
      const counts = {};
      for (const row of r.data) {
        const flow = String((row && row.flow) || 'v1');
        const c = counts[flow] || (counts[flow] = { generated: 0, filmed: 0 });
        c.generated += Number(row.generated) || 0;
        c.filmed += Number(row.filmed) || 0;
      }
      return res.status(200).json({ flows: shape(counts), since, days, genFlowColumn: true });
    }
    if (!fnMissing(r)) {
      console.error('content-metrics: content_metrics() answered ' + (r && r.status) + ' — ' + String((r && r.raw) || '').slice(0, 200));
      return res.status(503).json({ error: 'Could not read the numbers — try again.' });
    }
    const alt = await countByRows(brandId, since, timed);
    if (alt.error) return res.status(503).json({ error: 'Could not read the numbers — try again.' });
    const out = { flows: shape(alt.counts), since, days, genFlowColumn: alt.genFlowColumn };
    if (!alt.genFlowColumn) out.note = 'The ideas table has no gen_flow column yet, so every idea is counted as v1. Run sql/ideas-gen-flow.sql.';
    if (!alt.complete) out.partial = true;
    return res.status(200).json(out);
  } catch (err) {
    if (err && err.code === 'timeout') { console.error('content-metrics: request budget of ' + LIMITS.budgetMs + 'ms used up'); return tooSlow(); }
    console.error('content-metrics error:', (err && err.message) || err);
    return res.status(503).json({ error: 'Could not read the numbers — try again.' });
  }
};

module.exports._limits = LIMITS;
