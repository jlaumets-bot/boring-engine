// v693 — brand memory: the founder's stories, beliefs and speech samples (content-v2, C-API-3).
//
// POST /api/brand-memory
//   {brandId, action:'list', kind?}                 -> 200 {items:[{id, kind, text, tags, created_at}]}
//   {brandId, action:'add', kind, text, tags?}      -> 200 {item} (belief already held: {item, duplicate:true};
//                                                      bank full: 409 memory_full {max})
//   {brandId, action:'delete', id}                  -> 200 {ok:true}
//     delete: the brand OWNER may delete any item; a member only items they added themselves
//     (created_by), else 403 owner_only — the same rule sql/v658-member-delete.sql and the
//     owner-only DELETE policy in sql/brand-memory.sql hold for direct client access.
//
// No credits: this stores the user's own words, it never calls a model. Access is the same
// decision every brand endpoint makes (owner or member, store.userCanAccessBrand).
//
// A FAILED READ IS NOT AN ANSWER. store.rest RESOLVES on every HTTP status and a PostgREST error
// body is a plain object, so "no rows" and "the database refused" look alike unless every read
// checks the status AND the array. Anything that could not be read or written answers 503 with
// what actually happened — never an empty list that reads as "you have no stories", never an
// {item} for a row that was not saved. A table the SQL has not created yet answers 503
// memory_not_ready, so the app can say "not set up yet" instead of "you have nothing".
const store = require('./_publish/store');
const requireUser = require('./_requireUser');

const CAPS = { story: 600, belief: 140, speech: 800 };
const TAGS_MAX = 5, TAG_CAP = 30;
const SPEECH_KEEP = 20;          // newest 20 per person per brand; their older ones are pruned after each add
// v693 — how many a brand may HOLD. Speech is pruned instead (a sample is replaceable); a story or
// a belief is the founder's own and is never silently dropped, so a full bank refuses the add
// (409 memory_full) and the user decides what to remove.
const KIND_MAX = { story: 200, belief: 50 };
const LIST_LIMIT = 200;          // per request — a whole story bank fits in one list
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLS = 'id,kind,text,tags,created_at';

const enc = encodeURIComponent;
const okRows = r => !!r && r.status >= 200 && r.status < 300 && Array.isArray(r.data);
const okWrite = r => !!r && r.status >= 200 && r.status < 300;
// PGRST205 = PostgREST cannot find the table in its schema cache; 42P01 = Postgres "relation
// does not exist". Either way the SQL has not been run (or the schema was not reloaded).
const missingTable = r => !!(r && r.data && typeof r.data === 'object' &&
  (r.data.code === 'PGRST205' || r.data.code === '42P01'));

const item = r => ({ id: r.id, kind: r.kind, text: r.text, tags: Array.isArray(r.tags) ? r.tags : [], created_at: r.created_at });
const oneLine = s => String(s).replace(/\s+/g, ' ').trim();

function tagsFrom(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  const out = [], seen = new Set();
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const v = oneLine(t).slice(0, TAG_CAP);
    const k = v.toLowerCase();
    if (!v || seen.has(k)) continue;
    seen.add(k); out.push(v);
    if (out.length >= TAGS_MAX) break;
  }
  return out;
}

// A take transcript is often longer than 800 chars. It is still the founder's speech, so it is
// cut at a word boundary (and says so) rather than refused — a refused sample is simply lost.
function clipWords(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).trim();
}

function unavailable(res, r, what) {
  const verb = what === 'read' ? 'loaded' : what === 'delete' ? 'deleted' : 'saved';
  if (missingTable(r)) {
    return res.status(503).json({ code: 'memory_not_ready',
      error: "Brand memory isn't set up on the server yet, so nothing was " + verb + '.' });
  }
  return res.status(503).json({ code: what === 'read' ? 'memory_read_failed' : 'memory_write_failed',
    error: what === 'read'
      ? "Couldn't load your brand memory right now. Nothing is lost — try again in a moment."
      : what === 'delete'
        ? "Couldn't delete that from your brand memory right now, so it is still there. Try again in a moment."
        : "Couldn't save that to your brand memory right now, so nothing was changed. Try again in a moment." });
}

// Mutable so the gate can shrink them; production uses these values. maxDuration is 60 s in
// vercel.json: 50 s of work, and no call starts with less than store.js's 8 s timeout + 1 s left.
const TIMING = { deadlineMs: 50000, minCallMs: 9000 };

// v693 — A WRITE WHOSE OUTCOME WE CANNOT KNOW. store.rest resolves on every status, so a gateway
// page in front of PostgREST (502/503/504, or any 5xx whose body is not PostgREST's JSON error) looks
// like an ordinary failure — yet the insert or delete may already have committed behind it. Those
// are treated exactly like no reply at all. A genuine PostgREST error (a JSON body with a `code`,
// e.g. P0001 from the cap trigger or 23505 duplicate) is a real answer and is handled as one.
function outcomeUnknown(r) {
  if (!r || r.status == null) return true;
  if (r.status === 502 || r.status === 503 || r.status === 504) return true;
  return r.status >= 500 && !(r.data && typeof r.data === 'object' && r.data.code);
}
function writeUnknown(res, what) {
  return res.status(503).json({ code: 'memory_write_unknown',
    error: what === 'delete'
      ? "We couldn't confirm whether that was deleted. Refresh the list to see."
      : "We couldn't confirm whether that was saved. Refresh the list before adding it again." });
}

function timedOut(res, action) {
  return res.status(503).json({ code: 'timeout',
    error: action === 'list'
      ? 'Loading your brand memory took too long. Try again in a moment.'
      : 'That took too long, so nothing was changed. Try again in a moment.' });
}

module.exports = async function handler(req, res) {
  const allowed = ['https://contentshrimp.com', 'https://bettercontent.app', 'https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // v693 — A REQUEST-LEVEL DEADLINE. One request can chain up to seven database calls, each allowed
  // store.js's 8 s of silence. No call STARTS unless TIMING.minCallMs is left, so the function answers
  // honestly before the platform kills it mid-way. After the insert, the save is reported as saved
  // even if the tidy-up (speech prune) has to be skipped for time.
  const endAt = Date.now() + TIMING.deadlineMs;
  const tooLate = () => endAt - Date.now() < TIMING.minCallMs;
  const db = (method, path, opts) => {
    if (tooLate()) { const e = new Error('brand-memory deadline: not starting ' + method + ' ' + path.split('?')[0]); e.deadline = true; throw e; }
    return store.rest(method, path, opts);
  };
  let phase = 'before';   // 'before' the write, 'writing' while it is in flight, 'after' it is known

  const user = await requireUser(req);
  if (!user) return res.status(401).json({ error: 'Please sign in again.' });

  const body = req.body || {};
  const brandId = String(body.brandId || '');
  const action = String(body.action || '');
  const kind = body.kind == null || body.kind === '' ? '' : String(body.kind);
  if (!UUID.test(brandId)) return res.status(400).json({ code: 'bad_input', error: 'Missing or invalid brandId.' });
  if (!['list', 'add', 'delete'].includes(action)) return res.status(400).json({ code: 'bad_input', error: 'action must be list, add or delete.' });
  if (kind && !CAPS[kind]) return res.status(400).json({ code: 'bad_input', error: 'kind must be story, belief or speech.' });

  if (tooLate()) return timedOut(res, action);
  let allowedBrand = false;
  try { allowedBrand = await store.userCanAccessBrand(user.id, brandId); }
  catch (e) {
    return res.status(503).json({ code: 'access_check_failed',
      error: "Couldn't confirm your access to this brand right now, so nothing was read or changed. Try again in a moment." });
  }
  if (!allowedBrand) return res.status(403).json({ code: 'forbidden', error: "You don't have access to this brand." });

  const B = '/brand_memory?brand_id=eq.' + enc(brandId);
  try {
    if (action === 'list') {
      const r = await db('GET', B + (kind ? '&kind=eq.' + enc(kind) : '') +
        '&select=' + COLS + '&order=created_at.desc,id.desc&limit=' + LIST_LIMIT);
      if (!okRows(r)) return unavailable(res, r, 'read');
      return res.status(200).json({ items: r.data.map(item) });
    }

    if (action === 'delete') {
      const id = String(body.id || '');
      if (!UUID.test(id)) return res.status(400).json({ code: 'bad_input', error: 'Missing or invalid id.' });
      // Scoped to THIS brand on both the lookup and the delete: an id from a brand the caller
      // cannot access is "not found" here, never deleted.
      const where = B + '&id=eq.' + enc(id);
      const found = await db('GET', where + '&select=id,created_by');
      if (!okRows(found)) return unavailable(res, found, 'read');
      if (!found.data.length) return res.status(404).json({ code: 'not_found', error: 'That item is not in this brand’s memory.' });
      // v693 — A MEMBER MUST NEVER DESTROY THE OWNER'S ROWS. userCanAccessBrand says "owner OR
      // member" and this deletes with the service role, so without this check the endpoint would
      // walk straight past the owner-only DELETE policy the SQL puts on the table. Owner: anything.
      // Member: only what they added themselves (created_by is set here, server-side, on add).
      if (found.data[0].created_by !== user.id) {
        const own = await db('GET', '/brands?id=eq.' + enc(brandId) + '&select=user_id');
        if (!okRows(own) || !own.data.length) return unavailable(res, own, 'read');
        if (own.data[0].user_id !== user.id) {
          return res.status(403).json({ code: 'owner_only',
            error: 'Only the brand owner can delete this \u2014 it was added by someone else.' });
        }
      }
      phase = 'deleting';
      const d = await db('DELETE', where);
      phase = 'after';
      if (outcomeUnknown(d)) return writeUnknown(res, 'delete');
      if (!okWrite(d)) return unavailable(res, d, 'delete');
      return res.status(200).json({ ok: true });
    }

    // add
    if (!kind) return res.status(400).json({ code: 'bad_input', error: 'kind is required to add.' });
    if (typeof body.text !== 'string') return res.status(400).json({ code: 'bad_input', error: 'text is required.' });
    // A belief is one line (it is compared and de-duplicated as one); a story or a speech sample
    // keeps its own line breaks.
    let text = kind === 'belief' ? oneLine(body.text) : body.text.trim();
    if (!text) return res.status(400).json({ code: 'empty', error: 'Nothing to save — the text is empty.' });
    let clipped = false;
    if (text.length > CAPS[kind]) {
      if (kind !== 'speech') {
        return res.status(400).json({ code: 'too_long', max: CAPS[kind],
          error: 'Too long to save — a ' + kind + ' can be at most ' + CAPS[kind] + ' characters (this one is ' + text.length + ').' });
      }
      text = clipWords(text, CAPS.speech); clipped = true;
    }
    const tags = tagsFrom(body.tags);
    if (tags == null) return res.status(400).json({ code: 'bad_input', error: 'tags must be a list of short words.' });

    const full = (n) => res.status(409).json({ code: 'memory_full', max: KIND_MAX[kind],
      error: 'Your ' + kind + ' list is full (' + (n == null ? 'max ' + KIND_MAX[kind] : n + ' of ' + KIND_MAX[kind]) +
        '). Delete one you no longer need, then save this again \u2014 nothing was saved.' });
    if (kind === 'belief') {
      const have = await db('GET', B + '&kind=eq.belief&select=' + COLS + '&order=created_at.desc&limit=1000');
      if (!okRows(have)) return unavailable(res, have, 'read');
      const key = text.toLowerCase();
      const dup = have.data.find(r => oneLine(r && r.text).toLowerCase() === key);
      // A belief already held is an answer even when the list is full — nothing new is stored.
      if (dup) return res.status(200).json({ item: item(dup), duplicate: true });
      if (have.data.length >= KIND_MAX.belief) return full(have.data.length);
    } else if (kind === 'story') {
      const have = await db('GET', B + '&kind=eq.story&select=id&limit=' + KIND_MAX.story);
      if (!okRows(have)) return unavailable(res, have, 'read');
      if (have.data.length >= KIND_MAX.story) return full(have.data.length);
    }

    phase = 'writing';
    const ins = await db('POST', '/brand_memory', {
      body: { brand_id: brandId, kind, text, tags, created_by: user.id },
    });
    phase = 'after';
    if (outcomeUnknown(ins)) return writeUnknown(res, 'add');
    const row = okRows(ins) ? ins.data[0] : null;
    if (!row || !row.id) {
      // The database's own count cap (the trigger in sql/brand-memory.sql, which locks per brand and
      // kind before counting) is the one that holds under simultaneous adds; the count above is the
      // friendly early answer. Either way: full, nothing saved.
      if (ins && ins.data && ins.data.code === 'P0001' && /brand_memory_full/.test(String(ins.data.message || ''))) {
        return full(null);
      }
      // Lost the race to an identical belief saved a moment ago (the unique index in
      // sql/brand-memory.sql): the belief IS held, so answer with the held row.
      if (kind === 'belief' && ins && ins.data && ins.data.code === '23505') {
        const again = await db('GET', B + '&kind=eq.belief&select=' + COLS + '&order=created_at.desc&limit=1000');
        const held = okRows(again) && again.data.find(r => oneLine(r && r.text).toLowerCase() === text.toLowerCase());
        if (held) return res.status(200).json({ item: item(held), duplicate: true });
      }
      return unavailable(res, ins, 'write');
    }

    const out = { item: item(row) };
    if (clipped) out.clipped = true;
    if (kind === 'speech') {
      // Keep the newest SPEECH_KEEP PER PERSON (v693): pruning by brand let a member's takes push
      // the owner's samples out. Only the caller's own samples are ever pruned here. The save above
      // already happened and is reported as saved; a prune that fails only leaves a few extra old
      // samples, which the next add cleans up.
      let pruned = false;
      const mine = B + '&kind=eq.speech&created_by=eq.' + enc(user.id);
      try {
        // db() refuses to start a call when too little time is left; that lands in the catch below
        // and the saved sample is still reported as saved, flagged pruneFailed.
        const old = await db('GET', mine + '&select=id&order=created_at.desc,id.desc&offset=' +
          SPEECH_KEEP + '&limit=500');
        if (okRows(old)) {
          const ids = old.data.map(r => r && r.id).filter(id => UUID.test(String(id)));
          if (!ids.length) pruned = true;
          else {
            const d = await db('DELETE', mine + '&id=in.(' + ids.map(enc).join(',') + ')');
            pruned = okWrite(d);
          }
        }
      } catch (e) { pruned = false; }
      if (!pruned) {
        console.error('brand-memory: speech prune failed for brand ' + brandId + ' (the new sample was saved)');
        out.pruneFailed = true;
      }
    }
    return res.status(200).json(out);
  } catch (e) {
    console.error('brand-memory: ' + action + ' failed (' + phase + '):', (e && e.message) || e);
    // A deadline refusal means the call was never sent, so nothing changed.
    if (e && e.deadline) return timedOut(res, action);
    // The insert was sent and no answer came back: it may or may not have been saved. Say exactly
    // that — "nothing was saved" could be false, and a blind retry of a story would duplicate it.
    if (phase === 'writing') return writeUnknown(res, 'add');
    if (phase === 'deleting') return writeUnknown(res, 'delete');
    return unavailable(res, null, action === 'list' ? 'read' : action === 'delete' ? 'delete' : 'write');
  }
};

module.exports.CAPS = CAPS;
module.exports.SPEECH_KEEP = SPEECH_KEEP;
module.exports.KIND_MAX = KIND_MAX;
module.exports.TIMING = TIMING;
