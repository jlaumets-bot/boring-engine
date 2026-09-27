// content-v3 F1 — the daily question: the app interviews the founder, one short question a day.
//
// POST /api/daily-question   (Supabase bearer, owner or member of the brand)
//   {action:'get', brandId}
//     -> 200 {question:{id, text, kind}, date, answeredToday}
//   {action:'answer', brandId, questionId, text}
//     -> 200 {ok:true, storyId, date}  (+ clipped:true when the text was cut to 600 characters,
//                                        + duplicate:true when this exact answer was already saved today)
//   Errors: 401 not signed in · 403 forbidden · 400 bad_input / empty · 409 memory_full {max} ·
//           503 access_check_failed / memory_not_ready / memory_read_failed / memory_write_failed /
//               memory_write_unknown / timeout
//
// The answer is the founder's own story, saved to brand_memory as kind 'story' with
// tags ['daily-question'] and meta {source:'daily_question', questionId, date}, created_by = the caller.
// NO AI call and NO credits: nothing here calls a model.
//
// "Today" is the UTC date (api/_questions.js utcDate). answeredToday = a daily-question story whose
// meta.date is today. The question is picked by _questions.questionFor from the brand's newest 200
// daily-question stories — the exact read and pick api/send-daily.js uses for the morning push.
//
// Same honesty rules as api/brand-memory.js: a failed read is never "nothing answered"; a write
// whose outcome cannot be known (no reply, or a gateway 5xx) is 503 memory_write_unknown, never
// "not saved"; the DB cap trigger's P0001 brand_memory_full is 409 memory_full.
const store = require('./_publish/store');
const requireUser = require('./_requireUser');
const Q = require('./_questions');

const STORY_MAX = 600;          // the DB length CHECK on brand_memory: a story is 1..600 characters
const STORY_KIND_MAX = 200;     // the cap trigger in sql/brand-memory.sql
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const okRows = r => !!r && r.status >= 200 && r.status < 300 && Array.isArray(r.data);
const missingTable = r => !!(r && r.data && typeof r.data === 'object' &&
  (r.data.code === 'PGRST205' || r.data.code === '42P01'));
function outcomeUnknown(r) {
  if (!r || r.status == null) return true;
  if (r.status === 502 || r.status === 503 || r.status === 504) return true;
  return r.status >= 500 && !(r.data && typeof r.data === 'object' && r.data.code);
}

// Cut to at most n CHARACTERS (code points, as Postgres char_length counts them — never half an
// emoji), at a word boundary when one is reasonably close.
function clipChars(s, n) {
  const cps = Array.from(s);
  if (cps.length <= n) return s;
  const cut = cps.slice(0, n).join('');
  const sp = cut.lastIndexOf(' ');
  return (sp > cut.length * 0.6 ? cut.slice(0, sp) : cut).trim();
}

function unavailable(res, r, what) {
  if (missingTable(r)) {
    return res.status(503).json({ code: 'memory_not_ready',
      error: "Brand memory isn't set up on the server yet, so " + (what === 'read' ? "today's question can't be loaded." : 'your answer was not saved.') });
  }
  return res.status(503).json({ code: what === 'read' ? 'memory_read_failed' : 'memory_write_failed',
    error: what === 'read'
      ? "Couldn't load today's question right now. Try again in a moment."
      : "Couldn't save your answer right now, so nothing was saved. Try again in a moment." });
}
const writeUnknown = (res) => res.status(503).json({ code: 'memory_write_unknown',
  error: "We couldn't confirm whether your answer was saved. Check your stories before saving it again." });
const timedOut = (res, action) => res.status(503).json({ code: 'timeout',
  error: action === 'get' ? "Loading today's question took too long. Try again in a moment."
                          : 'That took too long, so nothing was saved. Try again in a moment.' });

/* THE REQUEST DEADLINE. maxDuration is 30 s in vercel.json. store.js lets ONE database call sit
   silent for 8 s. No call STARTS unless minCallMs (8 s + 1 s) is left before deadlineMs, and the
   access check — TWO sequential calls — needs twice that. Worst case, from the request start:
     getUser 0..8 s · access check starts by 25-18 = 7 s, ends by 7+16 = 23 s ·
     the answered read / the insert start by 25-9 = 16 s, end by 16+8 = 24 s.
   Every path ends by 24 s < 30 s, so the function answers before the platform kills it.
   Mutable so the gate can shrink them; production uses these values. */
const TIMING = { deadlineMs: 25000, minCallMs: 9000 };

module.exports = async function handler(req, res) {
  const allowed = ['https://contentshrimp.com', 'https://bettercontent.app', 'https://boring-engine.vercel.app'];
  const origin = req.headers.origin || '';
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : allowed[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const endAt = Date.now() + TIMING.deadlineMs;
  const tooLate = (calls) => endAt - Date.now() < TIMING.minCallMs * (calls || 1);
  const db = (method, path, opts) => {
    if (tooLate(1)) { const e = new Error('daily-question deadline: not starting ' + method + ' ' + path.split('?')[0]); e.deadline = true; throw e; }
    return store.rest(method, path, opts);
  };
  let phase = 'before';

  const user = await requireUser(req);
  if (!user) return res.status(401).json({ error: 'Please sign in again.' });

  const body = req.body || {};
  const brandId = String(body.brandId || '');
  const action = String(body.action || '');
  if (!UUID.test(brandId)) return res.status(400).json({ code: 'bad_input', error: 'Missing or invalid brandId.' });
  if (action !== 'get' && action !== 'answer') return res.status(400).json({ code: 'bad_input', error: 'action must be get or answer.' });

  let questionId = '', text = '', clipped = false;
  if (action === 'answer') {
    questionId = String(body.questionId || '');
    if (!Q.BY_ID.has(questionId)) return res.status(400).json({ code: 'bad_input', error: 'Unknown questionId.' });
    if (typeof body.text !== 'string') return res.status(400).json({ code: 'bad_input', error: 'text is required.' });
    text = body.text.trim();
    if (!text) return res.status(400).json({ code: 'empty', error: 'Nothing to save — the answer is empty.' });
    const cut = clipChars(text, STORY_MAX);
    if (cut !== text) { text = cut; clipped = true; }
  }

  if (tooLate(2)) return timedOut(res, action);   // the access check makes two sequential calls
  let allowedBrand = false;
  try { allowedBrand = await store.userCanAccessBrand(user.id, brandId); }
  catch (e) {
    return res.status(503).json({ code: 'access_check_failed',
      error: "Couldn't confirm your access to this brand right now, so nothing was read or saved. Try again in a moment." });
  }
  if (!allowedBrand) return res.status(403).json({ code: 'forbidden', error: "You don't have access to this brand." });

  try {
    const date = Q.utcDate(new Date());
    const r = await db('GET', Q.answeredPath(brandId));
    if (!okRows(r)) return unavailable(res, r, 'read');

    if (action === 'get') {
      const st = Q.questionFor(brandId, date, r.data);
      const q = st.question;
      return res.status(200).json({ question: { id: q.id, text: q.text, kind: q.kind }, date, answeredToday: !!st.answeredToday });
    }

    // A retry of an answer that DID land (e.g. after memory_write_unknown) must not become a second
    // copy of the same story: the same question, today, with the same words, is answered with that row.
    const same = r.data.find(row => row && row.meta && row.meta.source === 'daily_question' &&
      row.meta.date === date && row.meta.questionId === questionId && row.text === text);
    if (same && same.id) {
      const out = { ok: true, storyId: same.id, date, duplicate: true };
      if (clipped) out.clipped = true;
      return res.status(200).json(out);
    }

    phase = 'writing';
    const ins = await db('POST', '/brand_memory', {
      body: { brand_id: brandId, kind: 'story', text, tags: ['daily-question'],
              meta: { source: 'daily_question', questionId, date }, created_by: user.id },
    });
    phase = 'after';
    if (outcomeUnknown(ins)) return writeUnknown(res);
    const row = okRows(ins) ? ins.data[0] : null;
    if (!row || !row.id) {
      const d = ins && ins.data;
      if (d && d.code === 'P0001' && /brand_memory_full/.test(String(d.message || ''))) {
        return res.status(409).json({ code: 'memory_full', max: STORY_KIND_MAX,
          error: 'Your story list is full (max ' + STORY_KIND_MAX + '). Delete one you no longer need, then save this again — nothing was saved.' });
      }
      if (d && d.code === '23514') {
        return res.status(400).json({ code: 'too_long', max: STORY_MAX,
          error: 'That answer is too long to save (max ' + STORY_MAX + ' characters). Nothing was saved.' });
      }
      return unavailable(res, ins, 'write');
    }
    const out = { ok: true, storyId: row.id, date };
    if (clipped) out.clipped = true;
    return res.status(200).json(out);
  } catch (e) {
    console.error('daily-question: ' + action + ' failed (' + phase + '):', (e && e.message) || e);
    if (e && e.deadline) return timedOut(res, action);
    if (phase === 'writing') return writeUnknown(res);
    return unavailable(res, null, action === 'get' ? 'read' : 'write');
  }
};

module.exports.TIMING = TIMING;
module.exports.STORY_MAX = STORY_MAX;
module.exports.clipChars = clipChars;
