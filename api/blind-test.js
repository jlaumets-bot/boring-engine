// v693 — CONTENT LAB: the owner's blind test of three writers on the same inputs.
//
// WHY: content-v2 rebuilt how posts are written (beliefs first, spoken script, story slots). The only
// honest way to know it is better is to read the old and the new side by side WITHOUT knowing which
// is which. Arms (PLAN.md C-API-4):
//   baseline  — the old one-pass remix            (require('./remix')._legacyRemix)
//   grok-high — new flow on Grok                   (runAngles count 6, effort medium → top angle →
//                                                   runWrite effort high)
//   claude    — new flow on Claude                 (same, provider 'claude')
//   Both new-flow arms run inside _llm.withThinkingHeadroom, so they get the same max_tokens room
//   for reasoning; the baseline is exactly the production call.
//
// WHO: only user ids listed in env CONTENT_LAB_USER_IDS (comma list; empty or missing = nobody),
// and only on a brand that user can access. Everyone else gets 403 {code:'not_allowed'}.
//
// COST: no credits are charged — this is the owner's tool, and _usage.js deliberately has no
// zero-credit action (a 0 weight is an unmetered hole). Spend stays visible instead through one
// log line per cell (arm, status, ms) next to the provider's own "OK … tokens" line, and through
// the `ms` stored on every cell.
//
// BLIND: every input gets its own random label order (crypto), cells are numbered in LABEL order,
// and until every input has a pick nothing names the arm: no arm, model or timing; story slots shown
// as "[story]"; any error shown as 'not_available'; an input's outputs appear only once all of its
// cells have finished; runCell answers only "finished". Picks are final once complete — `reset`
// clears them all AND reshuffles the labels. Arms show only after the explicit `reveal` action. Only the test's creator (who still has brand access) can use it.
//
// ONE CELL PER REQUEST: runCell does one input × arm, so each fits the 300s function budget.
const crypto = require('crypto');
const store = require('./_publish/store');

const ARMS = ['baseline', 'grok-high', 'claude'];
const KINDS = ['remix', 'question', 'trend', 'note', 'idea'];
const LABELS = ['A', 'B', 'C', 'D', 'E', 'F'];
const MAX_INPUTS = 5;
const MAX_TEXT = 12000;
const MAX_OUT = 8000;
// The AI work of one cell must END by this point, counted from the start of the request. The rest of
// the 300s maxDuration (vercel.json) is left for saving the cell and answering — a cell that was
// written but never saved is the one outcome worse than a timeout.
const FN_BUDGET_MS = 260000;

function allowedIds() {
  return String(process.env.CONTENT_LAB_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
}
function labAllowed(userId) { return !!userId && allowedIds().indexOf(String(userId)) !== -1; }

// Fisher–Yates with crypto.randomInt: Math.random is predictable enough to guess an order from.
function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}

// Cells for every input × arm. The label order is random per input and cells are numbered in LABEL
// order, so neither the label nor the index says which arm wrote a cell.
function buildCells(inputCount, arms) {
  const cells = [];
  for (let i = 0; i < inputCount; i++) {
    const labels = shuffled(LABELS.slice(0, arms.length));
    const pairs = arms.map((arm, k) => ({ arm, label: labels[k] })).sort((x, y) => x.label.localeCompare(y.label));
    for (const p of pairs) cells.push({ index: cells.length, inputIndex: i, label: p.label, arm: p.arm, status: 'pending', text: null, ms: null, error: null, model: null });
  }
  return cells;
}

function allPicked(row) {
  const n = Array.isArray(row.inputs) ? row.inputs.length : 0;
  const picks = row.picks || {};
  for (let i = 0; i < n; i++) if (!picks[String(i)]) return false;
  return n > 0;
}

// v693 r3 — the arms become visible only after the explicit `reveal` action (revealed_at is set),
// never merely because every input has a pick.
const revealedOf = (row) => !!(row && row.revealed_at);

// v693 r3 — a new label order for every input, cells renumbered in the new label order. Used by
// `reset`, so what the reveal showed (label → writer, index → writer) is useless afterwards. Each
// cell keeps its identity (inputIndex + arm) and its output. A dead 'running' cell goes back to pending.
function relabelCells(cells) {
  const byInput = new Map();
  for (const c of (Array.isArray(cells) ? cells : [])) {
    if (!c) continue;
    if (!byInput.has(c.inputIndex)) byInput.set(c.inputIndex, []);
    byInput.get(c.inputIndex).push(c);
  }
  const out = [];
  for (const i of [...byInput.keys()].sort((a, b) => a - b)) {
    const cs = byInput.get(i);
    const labels = shuffled(LABELS.slice(0, cs.length));
    const next = cs.map((c, k) => Object.assign({}, c, { label: labels[k] })).sort((x, y) => x.label.localeCompare(y.label));
    for (const c of next) {
      c.index = out.length;
      if (c.status === 'running') { c.status = 'pending'; delete c.startedAt; }
      out.push(c);
    }
  }
  return out;
}

const FINISHED = ['done', 'error'];
const isFinished = (c) => !!c && FINISHED.indexOf(c.status) !== -1;

// v693 r2 — only the new flow writes story slots, so a raw "[your story: ...]" names the arm. Before
// the reveal every slot is shown the same way.
// v693 r3 — as "…", not "[story]": a bracketed marker could still only come from the new flow, while
// a spoken pause "…" is something any script (the old remix included) plausibly contains. Deleting the
// slot outright was rejected: it leaves a visibly broken sentence, which is its own tell.
const SLOT_RE = /\[\s*your story\s*:[^\]]*\]/gi;
const NEUTRAL_SLOT = '…';
function neutralText(t) { return t == null ? t : String(t).replace(SLOT_RE, NEUTRAL_SLOT); }

// What a reader may see.
// After the reveal: everything. Before it (v693 r2 — the test must stay blind):
//   • no arm, model, timing or start time;
//   • story slots rendered neutrally;
//   • any error is just 'not_available' (only the Claude arm could say 'arm_unavailable');
//   • nothing of an input — no text, no per-cell status — until EVERY cell of that input has
//     finished, so the order in which cells finish (Claude is slower) is never visible.
function publicCell(c, revealed, inputDone) {
  if (revealed) return { index: c.index, inputIndex: c.inputIndex, label: c.label, status: c.status, text: c.text, error: c.error, arm: c.arm, model: c.model, ms: c.ms };
  if (!inputDone) return { index: c.index, inputIndex: c.inputIndex, label: c.label, status: 'waiting', text: null, error: null };
  return { index: c.index, inputIndex: c.inputIndex, label: c.label, status: c.status, text: neutralText(c.text), error: c.error ? 'not_available' : null };
}
function inputsDone(row) {
  const cells = Array.isArray(row.cells) ? row.cells : [];
  return (row.inputs || []).map((_, i) => { const cs = cells.filter(c => c && c.inputIndex === i); return cs.length > 0 && cs.every(isFinished); });
}
function publicCells(row) {
  const revealed = revealedOf(row), done = inputsDone(row);
  return (Array.isArray(row.cells) ? row.cells : []).map(c => publicCell(c, revealed, !!done[c.inputIndex]));
}

function clip(s, n) { s = s == null ? '' : String(s); return s.length > n ? s.slice(0, n) : s; }

// Every arm is shown as the same kind of plain text (title, hook, script, caption), so the shape of
// the output does not give the writer away.
function readableText(o) {
  if (!o || typeof o !== 'object') return '';
  const src = (o.remix && typeof o.remix === 'object') ? o.remix : (o.idea && typeof o.idea === 'object') ? o.idea : o;
  const pick = (...keys) => { for (const k of keys) { const v = src[k]; if (v != null && String(Array.isArray(v) ? v.join('\n') : v).trim()) return String(Array.isArray(v) ? v.join('\n') : v).trim(); } return ''; };
  const parts = [];
  if (Array.isArray(src.seriesParts) && src.seriesParts.length) {
    for (const p of src.seriesParts) {
      if (!p) continue;
      const t = [p.remixTitle || p.title, p.remixHook || p.hook, p.remixScript || p.script].filter(x => x && String(x).trim()).join('\n\n');
      if (t) parts.push('Part ' + (p.partNumber || parts.length + 1) + ': ' + t);
    }
  } else {
    const title = pick('title', 'remixTitle');
    const hook = pick('hook', 'remixHook');
    const script = pick('script', 'remixScript');
    if (title) parts.push(title);
    if (hook) parts.push('Hook: ' + hook);
    if (script) parts.push(script);
  }
  const caption = pick('caption', 'remixCaption');
  if (caption) parts.push('Caption: ' + caption);
  return clip(parts.join('\n\n'), MAX_OUT);
}

const tableMissing = (r) => !!(r && r.status >= 400 && r.data && (r.data.code === 'PGRST205' || r.data.code === '42P01'));
const fnMissing = (r) => !!(r && r.status === 404 && (!r.data || r.data.code === 'PGRST202' || r.data.code === '42883'));
const okStatus = (r) => !!(r && r.status >= 200 && r.status < 300);
// A PATCH answered with return=representation lists the rows it changed; an empty list changed nothing.
const wrote = (r) => okStatus(r) && Array.isArray(r.data) && r.data.length > 0;

async function loadRow(id) {
  const r = await store.rest('GET', '/blind_tests?id=eq.' + encodeURIComponent(id) + '&select=*');
  if (tableMissing(r)) return { missing: 'table' };
  if (!okStatus(r)) return { error: true };
  const row = Array.isArray(r.data) ? r.data[0] : null;
  return row ? { row } : { missing: 'row' };
}

// Write ONE cell. The database function changes only that array element (jsonb_set), so two cells
// of the same test finishing together cannot overwrite each other. If sql/blind-tests.sql has not
// created the function yet, fall back to re-reading the row right before writing it.
// v693 r3 — a `reset` may renumber the cells while this one runs, so a write is identity-guarded: the
// function writes only if the cell at p_index is still this cell (same inputIndex and arm), and keeps
// the stored label and index. Otherwise it answers null and the caller reports save_failed — the
// output never lands in another writer's slot.
const identityOf = (c) => ({ inputIndex: c.inputIndex, arm: c.arm });
async function saveCell(id, cell) {
  const r = await store.rest('POST', '/rpc/blind_test_set_cell', { body: { p_id: id, p_index: cell.index, p_cell: cell } });
  if (okStatus(r)) return r.data === true;   // null = no row matched, nothing was written
  if (!fnMissing(r)) return false;
  const fresh = await loadRow(id);
  if (!fresh.row) return false;
  const cells = Array.isArray(fresh.row.cells) ? fresh.row.cells.slice() : [];
  const at = cells.findIndex(c => c && c.inputIndex === cell.inputIndex && c.arm === cell.arm);
  if (at < 0) return false;
  cells[at] = Object.assign({}, cell, { index: cells[at].index, label: cells[at].label });
  const w = await store.rest('PATCH', '/blind_tests?id=eq.' + encodeURIComponent(id), { body: { cells } });
  return wrote(w);
}

// v693 r2 — CLAIM A CELL BEFORE RUNNING IT. Only a pending or failed cell (or a finished one with
// force, or one stuck 'running' past the function limit) can be claimed, and the database function
// does the check and the write in one UPDATE, so two requests for the same cell run it once.
const STALE_RUNNING_MS = 330000;   // longer than the 300s maxDuration: a 'running' cell older than this died
function claimable(c, force, nowMs) {
  if (!c) return false;
  const st = c.status || 'pending';
  if (st === 'pending' || st === 'error') return true;
  if (st === 'done') return force === true;
  if (st === 'running') return !(Number(c.startedAt) > nowMs - STALE_RUNNING_MS);
  return false;
}
// → 'claimed' | 'taken' (someone else has it, it is finished, or it moved) | 'error' (could not ask)
async function claimCellOf(id, cell, force) {
  const index = cell.index;
  const r = await store.rest('POST', '/rpc/blind_test_set_cell', { body: { p_id: id, p_index: index, p_cell: identityOf(cell), p_claim: true, p_force: force === true } });
  if (okStatus(r)) return r.data === true ? 'claimed' : 'taken';
  if (!fnMissing(r)) return 'error';
  // Before sql/blind-tests.sql adds the function: check and write from a fresh read (not atomic).
  const fresh = await loadRow(id);
  if (!fresh.row) return 'error';
  const cells = Array.isArray(fresh.row.cells) ? fresh.row.cells.slice() : [];
  const cur = cells[index];
  if (!cur || cur.inputIndex !== cell.inputIndex || cur.arm !== cell.arm) return 'taken';
  if (!claimable(cur, force, Date.now())) return 'taken';
  cells[index] = Object.assign({}, cells[index], { status: 'running', startedAt: Date.now() });
  const w = await store.rest('PATCH', '/blind_tests?id=eq.' + encodeURIComponent(id), { body: { cells } });
  return wrote(w) ? 'claimed' : 'error';
}

// v693 r4 — THE LABEL GENERATION. `reset` reshuffles the letters and bumps blind_tests.generation in
// the same database step. A pick names a letter the user saw in ONE generation, so it carries that
// generation and the database stores it only if it still matches — a pick in flight during a reset
// can never land on the new letters. Same for reveal. These three writes have no read-then-write
// fallback: if the functions are missing they fail closed (lab_not_ready), never a blind overwrite.
const generationOf = (row) => Number(row && row.generation) || 0;

// → 'ok' | 'stale' (generation moved, or the test changed under us) | 'missing' | 'error'
async function rpcStep(fn, args) {
  const r = await store.rest('POST', '/rpc/' + fn, { body: args });
  if (okStatus(r)) return (r.data === true || (typeof r.data === 'number' && Number.isFinite(r.data))) ? 'ok' : 'stale';
  if (fnMissing(r)) return 'missing';
  return 'error';
}

// Runs one arm on one input. Returns { text, model } or throws.
async function runArm(arm, bc, source, deadlineMs) {
  if (arm === 'baseline') {
    const out = await require('./remix')._legacyRemix({ bc, source, deadlineMs });
    return { text: readableText(out), model: process.env.XAI_MODEL || 'grok-4.7' };
  }
  const provider = arm === 'claude' ? 'claude' : 'grok';
  if (provider === 'claude' && !require('./_llm').claudeConfigured()) {
    const e = new Error('Claude is not configured'); e.code = 'AI_UNAVAILABLE'; e.refused = 'no-key'; throw e;
  }
  const W = require('./_write');
  const llm = require('./_llm');
  // v693 r2 — fairness between the two new-flow arms: both run inside withThinkingHeadroom, so Grok
  // gets the same max_tokens room for reasoning that Claude always gets (baseline stays exactly the
  // production call). The angles step runs at 'medium' on both arms: it is a list of short beliefs,
  // and at 'high' Claude could spend its whole ~100s share thinking. The WRITE is effort 'high'.
  return llm.withThinkingHeadroom(async () => {
    const t0 = Date.now();
    // The angles call gets 40% of the time; the write gets whatever is left of the rest.
    const a = await W.runAngles({ bc, source, count: 6, provider, effort: 'medium', deadlineMs: Math.round(deadlineMs * 0.4) });
    const angle = a && Array.isArray(a.angles) ? a.angles[0] : null;
    if (!angle) throw new Error('the angles step returned no angle');
    const left = deadlineMs - (Date.now() - t0);
    if (left < 15000) throw new Error('no time left to write after the angles step');
    const w = await W.runWrite({ bc, source, angle, format: 'talking', provider, effort: 'high', deadlineMs: left });
    return {
      text: readableText(w),
      model: provider === 'claude' ? (process.env.ANTHROPIC_MODEL || llm.CLAUDE_DEFAULT_MODEL) : (process.env.XAI_MODEL || 'grok-4.7'),
    };
  });
}

function tally(row) {
  const wins = {};
  for (const a of (row.arms || [])) wins[a] = 0;
  wins.none = 0;
  const perInput = [];
  const picks = row.picks || {};
  const cells = Array.isArray(row.cells) ? row.cells : [];
  (row.inputs || []).forEach((_, i) => {
    const label = picks[String(i)] || null;
    const cell = label && label !== 'none' ? cells.find(c => c && c.inputIndex === i && c.label === label) : null;
    const arm = cell ? cell.arm : (label ? 'none' : null);
    if (arm) wins[arm] = (wins[arm] || 0) + 1;
    perInput.push({ inputIndex: i, pick: label, arm });
  });
  const avgMs = {};
  for (const a of (row.arms || [])) {
    const done = cells.filter(c => c && c.arm === a && c.status === 'done' && Number.isFinite(c.ms));
    avgMs[a] = done.length ? Math.round(done.reduce((s, c) => s + c.ms, 0) / done.length) : null;
  }
  return { wins, perInput, avgMs };
}

module.exports = async function handler(req, res) {
  const tStart = Date.now();
  const allowed = ['https://contentshrimp.com', 'https://bettercontent.app', 'https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await require('./_requireUser')(req);
  if (!user) return res.status(401).json({ error: 'Please sign in again.' });
  if (!labAllowed(user.id)) return res.status(403).json({ error: 'The Content Lab is not enabled for this account.', code: 'not_allowed' });

  const body = req.body || {};
  const action = String(body.action || '');
  const notReady = () => res.status(503).json({ error: 'The Content Lab table does not exist yet — run sql/blind-tests.sql.', code: 'lab_not_ready' });

  try {
    if (action === 'list') {
      const r = await store.rest('GET', '/blind_tests?created_by=eq.' + encodeURIComponent(user.id) +
        '&select=id,brand_id,inputs,cells,picks,created_at&order=created_at.desc&limit=20');
      if (tableMissing(r)) return notReady();
      if (!okStatus(r)) return res.status(503).json({ error: 'Could not read your tests — try again.' });
      const tests = (Array.isArray(r.data) ? r.data : []).map(t => ({
        id: t.id, brandId: t.brand_id, createdAt: t.created_at,
        inputs: Array.isArray(t.inputs) ? t.inputs.length : 0,
        cells: Array.isArray(t.cells) ? t.cells.length : 0,
        cellsDone: Array.isArray(t.cells) ? t.cells.filter(isFinished).length : 0,
        picks: Object.keys(t.picks || {}).length,
        complete: allPicked(t),
      }));
      return res.status(200).json({ allowed: true, tests });
    }

    if (action === 'create') {
      const brandId = String(body.brandId || '');
      if (!brandId) return res.status(400).json({ error: 'brandId is required' });
      const rawInputs = Array.isArray(body.inputs) ? body.inputs : [];
      const inputs = rawInputs.map(x => ({
        kind: KINDS.indexOf(x && x.kind) !== -1 ? x.kind : 'note',
        text: clip(String((x && x.text) || '').trim(), MAX_TEXT),
      })).filter(x => x.text);
      if (inputs.length < 1 || inputs.length > MAX_INPUTS || inputs.length !== rawInputs.length) {
        return res.status(400).json({ error: 'Give 1 to ' + MAX_INPUTS + ' inputs, each with text.' });
      }
      let arms = body.arms == null ? ARMS.slice() : body.arms;
      if (!Array.isArray(arms) || !arms.length || arms.some(a => ARMS.indexOf(a) === -1) || new Set(arms).size !== arms.length) {
        return res.status(400).json({ error: 'arms must be a list drawn from ' + ARMS.join(', ') });
      }
      // v693 r3 — refuse a writer that cannot run at all (no key). Its cells would all fail, and a
      // column of failures identifies the writer by elimination. The app offers "start without it".
      const llm = require('./_llm');
      const cannot = arms.filter(a => a === 'claude' && !llm.claudeConfigured());
      if (cannot.length) {
        return res.status(400).json({ error: 'This writer is not configured, so it cannot run: ' + cannot.join(', ') + '.', code: 'arm_unavailable', arm: cannot[0], arms: cannot });
      }
      let can = false;
      try { can = await store.userCanAccessBrand(user.id, brandId); }
      catch (e) { return res.status(503).json({ error: 'Could not check access to this brand — try again.' }); }
      if (!can) return res.status(403).json({ error: 'You do not have access to this brand.', code: 'forbidden' });
      const cells = buildCells(inputs.length, arms);
      const r = await store.rest('POST', '/blind_tests', { body: { created_by: user.id, brand_id: brandId, inputs, arms, cells, picks: {}, generation: 0 } });
      if (tableMissing(r)) return notReady();
      const row = Array.isArray(r.data) ? r.data[0] : r.data;
      if (!okStatus(r) || !row || !row.id) return res.status(503).json({ error: 'Could not save the test — try again.' });
      return res.status(200).json({ id: row.id, generation: 0, cells: cells.map(c => ({ index: c.index, inputIndex: c.inputIndex, label: c.label })) });
    }

    // Every other action works on one existing test.
    const id = String(body.id || '');
    if (!id) return res.status(400).json({ error: 'id is required' });
    const got = await loadRow(id);
    if (got.missing === 'table') return notReady();
    if (got.missing === 'row') return res.status(404).json({ error: 'Test not found' });
    if (!got.row) return res.status(503).json({ error: 'Could not read the test — try again.' });
    const row = got.row;
    let can = false;
    try { can = await store.userCanAccessBrand(user.id, row.brand_id); }
    catch (e) { return res.status(503).json({ error: 'Could not check access to this brand — try again.' }); }
    if (!can) return res.status(403).json({ error: 'You do not have access to this brand.', code: 'forbidden' });
    // v693 r2 — a test belongs to the person who made it: another lab user on the same brand must not
    // read its hidden arms, pick for it or spend on it.
    if (row.created_by !== user.id) return res.status(403).json({ error: 'This test belongs to someone else.', code: 'forbidden' });
    const cells = Array.isArray(row.cells) ? row.cells : [];

    if (action === 'get') {
      const done = inputsDone(row), now = Date.now();
      return res.status(200).json({
        id: row.id, brandId: row.brand_id, createdAt: row.created_at, inputs: row.inputs || [],
        cells: publicCells(row), picks: row.picks || {}, complete: allPicked(row), revealed: revealedOf(row),
        generation: generationOf(row),   // v693 r4 — every pick must send this back
        // v693 r3 — stale: a cell of this input has been 'running' longer than the function can live,
        // so its run died. Re-sending runCell for the input's cells reclaims it (finished ones answer 409).
        progress: done.map((d, i) => ({ inputIndex: i, finished: cells.filter(c => c && c.inputIndex === i && isFinished(c)).length, total: cells.filter(c => c && c.inputIndex === i).length, ready: d,
          stale: cells.some(c => c && c.inputIndex === i && c.status === 'running' && !(Number(c.startedAt) > now - STALE_RUNNING_MS)) })),
      });
    }

    // v693 r2 — picks are final once every input has one (the arms are then visible, so a change of
    // mind would no longer be blind). `reset` clears ALL picks, which hides the arms again.
    // v693 r3 — and it RESHUFFLES every input's labels (and renumbers the cells), so what a reveal
    // showed cannot be carried into the new picks. Refused while a cell is being written.
    // v693 r4 — ONE database step: blind_test_reset writes the reshuffled cells only if the cells are
    // exactly what this request read, no cell is being written (fresh 'running'), and the generation
    // is unchanged — and bumps the generation. A claim or a finished cell that lands in between makes
    // it refuse, so nothing is wiped and nothing is run (and paid for) twice.
    if (action === 'reset') {
      const now = Date.now();
      const busy = () => res.status(409).json({ error: 'A cell is still being written — reset when it has finished.', code: 'cells_running' });
      if (cells.some(c => c && c.status === 'running' && Number(c.startedAt) > now - STALE_RUNNING_MS)) return busy();
      const nextCells = relabelCells(cells);
      const gen = generationOf(row);
      const st = await rpcStep('blind_test_reset', { p_id: row.id, p_old_cells: cells, p_new_cells: nextCells, p_generation: gen });
      if (st === 'missing') return notReady();
      if (st === 'error') return res.status(503).json({ error: 'Could not reset the picks — try again.' });
      if (st === 'stale') return res.status(409).json({ error: 'The test changed while resetting (a cell started or finished) — try again.', code: 'test_changed' });
      const fresh = Object.assign({}, row, { picks: {}, cells: nextCells, revealed_at: null, generation: gen + 1 });
      return res.status(200).json({ ok: true, picks: {}, complete: false, revealed: false, labelsChanged: true, generation: gen + 1, cells: publicCells(fresh) });
    }

    if (action === 'pick') {
      const inputIndex = Number(body.inputIndex);
      const label = String(body.label || '');
      if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= (row.inputs || []).length) return res.status(400).json({ error: 'inputIndex is out of range' });
      // v693 r4 — the letters the user saw belong to one generation; a pick without it is refused.
      if (!Number.isInteger(body.generation)) return res.status(400).json({ error: 'generation is required (send the one from get).', code: 'generation_required' });
      if (body.generation !== generationOf(row)) return res.status(409).json({ error: 'The letters were reshuffled — reload the test and pick again.', code: 'labels_changed', generation: generationOf(row) });
      if (allPicked(row)) return res.status(409).json({ error: 'Every input already has a pick. Reset the picks to choose again.', code: 'picks_final' });
      // v693 r4 — no pick at all until EVERY cell of this input has finished. Answering per letter
      // (400 for an unfinished one, 200 for a finished one) would tell the finish order.
      if (!inputsDone(row)[inputIndex]) return res.status(409).json({ error: 'This input is still being written — pick when all its outputs are in.', code: 'input_not_ready' });
      const valid = cells.some(c => c && c.inputIndex === inputIndex && c.label === label && c.status === 'done');
      if (label !== 'none' && !valid) return res.status(400).json({ error: 'Pick a label that has a finished output for this input, or "none".' });
      const st = await rpcStep('blind_test_set_pick', { p_id: row.id, p_input: inputIndex, p_label: label, p_generation: body.generation });
      if (st === 'missing') return notReady();
      if (st === 'error') return res.status(503).json({ error: 'Could not save the pick — try again.' });
      if (st === 'stale') return res.status(409).json({ error: 'The letters were reshuffled or the picks are final — reload the test.', code: 'labels_changed' });
      const picks = Object.assign({}, row.picks || {}, { [String(inputIndex)]: label });
      return res.status(200).json({ ok: true, picks, complete: allPicked(Object.assign({}, row, { picks })) });
    }

    if (action === 'reveal') {
      if (!allPicked(row)) {
        const missing = (row.inputs || []).map((_, i) => i).filter(i => !(row.picks || {})[String(i)]);
        return res.status(409).json({ error: 'Pick a winner for every input first.', code: 'picks_incomplete', missing });
      }
      if (Number.isInteger(body.generation) && body.generation !== generationOf(row)) return res.status(409).json({ error: 'The letters were reshuffled — reload the test.', code: 'labels_changed', generation: generationOf(row) });
      // v693 r4 — one statement: reveal only if still unrevealed, every input picked, same generation.
      // A reset landing between our read and this write makes it refuse (409), so a fresh unpicked
      // round is never marked revealed.
      if (!row.revealed_at) {
        const st = await rpcStep('blind_test_reveal', { p_id: row.id, p_generation: generationOf(row) });
        if (st === 'missing') return notReady();
        if (st === 'error') return res.status(503).json({ error: 'Could not reveal — try again.' });
        if (st === 'stale') return res.status(409).json({ error: 'The test changed while revealing — reload it.', code: 'test_changed' });
      }
      return res.status(200).json({ id: row.id, arms: row.arms || [], cells: cells.map(c => publicCell(c, true, true)), picks: row.picks || {}, tally: tally(row) });
    }

    // v693 r5 — SKIP A CELL. A cell whose run could not even start stays 'pending', which kept its input
    // from ever being ready, so nothing could be picked or revealed. `skip` finishes it as an error
    // (error 'skipped') with no AI call and no charge. It claims the cell first (the same atomic step
    // runCell uses), so it can never overwrite a cell that is being written or already has an output,
    // and the write is identity-guarded like every cell write. The answer is as blind as runCell's.
    if (action === 'skip') {
      const index = Number(body.index);
      const cell = Number.isInteger(index) ? cells[index] : null;
      if (!cell || cell.index !== index) return res.status(400).json({ error: 'index is out of range' });
      if (!Number.isInteger(body.generation)) return res.status(400).json({ error: 'generation is required (send the one from get).', code: 'generation_required' });
      if (body.generation !== generationOf(row)) return res.status(409).json({ error: 'The letters were reshuffled — reload the test.', code: 'labels_changed', generation: generationOf(row) });
      if (!claimable(cell, false, Date.now())) {
        return res.status(409).json(cell.status === 'done'
          ? { error: 'This cell already has an output.', code: 'already_done' }
          : { error: 'This cell is being written right now.', code: 'already_running' });
      }
      const claim = await claimCellOf(row.id, cell, false);
      if (claim === 'error') return res.status(503).json({ error: 'Could not skip this cell — try again.' });
      if (claim !== 'claimed') return res.status(409).json({ error: 'This cell changed — reload the test.', code: 'already_running' });
      const skipped = Object.assign({}, cell, { status: 'error', error: 'skipped', text: null, ms: null });
      delete skipped.startedAt;
      if (!(await saveCell(row.id, skipped))) return res.status(503).json({ error: 'Could not skip this cell — try again.', code: 'save_failed' });
      console.log('blind-test cell ' + row.id + '#' + cell.index + ' skipped by the owner — no AI call, no credits');
      return res.status(200).json({ cell: { index: cell.index, inputIndex: cell.inputIndex, label: cell.label, status: 'finished' } });
    }

    if (action === 'runCell') {
      const index = Number(body.index);
      const cell = Number.isInteger(index) ? cells[index] : null;
      if (!cell || cell.index !== index) return res.status(400).json({ error: 'index is out of range' });
      // v693 r2 — a finished cell is never run (and paid for) again unless the caller says force.
      // v693 r4 — note: already_done / already_running are per-cell answers. They are acceptable only
      // because every action here is limited to the test's creator (checked above), who started those
      // runs; they are never shown to anyone else.
      if (!claimable(cell, body.force, Date.now())) {
        return res.status(409).json(cell.status === 'done'
          ? { error: 'This cell already has an output. Send force:true to write it again.', code: 'already_done' }
          : { error: 'This cell is already being written.', code: 'already_running' });
      }
      const input = (row.inputs || [])[cell.inputIndex] || {};
      const source = { kind: KINDS.indexOf(input.kind) !== -1 ? input.kind : 'note', text: clip(input.text, MAX_TEXT) };

      const hyd = await require('./_brandctx').loadBrandContext(row.brand_id, { userId: user.id }, '');
      if (!hyd.ok) return res.status(424).json({ error: 'brand_context_unavailable', reason: hyd.reason });

      // Claim it atomically; a second request for the same cell stops here without spending anything.
      const claim = await claimCellOf(row.id, cell, body.force === true);
      if (claim === 'error') return res.status(503).json({ error: 'Could not start this cell — try again.' });
      if (claim !== 'claimed') return res.status(409).json({ error: 'This cell is already being written.', code: 'already_running' });

      const deadlineMs = FN_BUDGET_MS - (Date.now() - tStart);
      const t0 = Date.now();
      const next = Object.assign({}, cell, { status: 'done', error: null, startedAt: t0 });
      try {
        if (deadlineMs < 30000) throw new Error('not enough time left in this request');
        const out = await runArm(cell.arm, hyd.bc, source, deadlineMs);
        next.model = out.model;
        next.text = out.text;
        if (!out.text) { next.status = 'error'; next.error = 'empty_output'; }
      } catch (e) {
        next.status = 'error';
        next.text = null;
        next.error = (e && e.code === 'AI_UNAVAILABLE') ? 'arm_unavailable' : ('failed: ' + clip((e && e.message) || e, 200));
      }
      next.ms = Date.now() - t0;
      console.log('blind-test cell ' + row.id + '#' + cell.index + ' arm=' + cell.arm + ' ' + next.status +
        (next.error ? ' (' + next.error.slice(0, 60) + ')' : '') + ' in ' + next.ms + 'ms — no credits charged');
      if (!(await saveCell(row.id, next))) return res.status(503).json({ error: 'The output was written but could not be saved — try again.', code: 'save_failed' });
      // Before the reveal the answer carries no text and no outcome: which cell finished when is
      // exactly what a blind test must not show. Read the outputs with `get`.
      if (!revealedOf(row)) return res.status(200).json({ cell: { index: next.index, inputIndex: next.inputIndex, label: next.label, status: 'finished' } });
      return res.status(200).json({ cell: publicCell(next, true, true) });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('blind-test error:', (err && err.message) || err);
    return res.status(500).json({ error: 'The Content Lab hit an error — try again.' });
  }
};

// Exported for scripts/verify/rv2-lab-1.mjs.
module.exports._internals = { buildCells, relabelCells, readableText, allowedIds, tally, publicCell, neutralText, claimable, ARMS };
