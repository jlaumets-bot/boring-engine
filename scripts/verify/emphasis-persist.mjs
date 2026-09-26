#!/usr/bin/env node
// GATE: the teleprompter's stress marks are saved with the idea and come back after a reload.
//
// WHY THIS EXISTS
//   The generator returns `emphasis` — short phrases copied verbatim from the script that the
//   teleprompter bolds while the person reads to camera. public.ideas had no column for it,
//   _buildIdeaRows never wrote it and the row mapper in loadIdeasFromDB never read it, so the marks
//   lived only in the tab that generated the idea: gone after a reload, never on another device.
//   v692 adds the column (sql/ideas-emphasis.sql), writes a CLEANED list with the row, reads it back,
//   and — because PostgREST rejects a whole insert naming a column it does not know (PGRST204) —
//   retries a save without the marks on exactly that error, so a missing column can never lose an idea.
//
// HOW IT CHECKS
//   It RUNS the real functions lifted from app.html (_buildIdeaRows, _saveIdeasToDBNow and its insert helper,
//   loadIdeasFromDB, tpCleanEmphasis, tpPruneEmphasis, tpFormatScript, tvApplyTwist, cmClose …) in a
//   node:vm context against an in-memory fake Supabase client that behaves like PostgREST: select *
//   returns only real columns, an unknown column fails the WHOLE insert with PGRST204. Every arm has
//   its opposite, so a gate that passes for the wrong reason fails.
//
// RUN:    node scripts/verify/emphasis-persist.mjs
// EXPECT: prints "EMPHASIS PERSISTS" and exits 0.
import fs from 'node:fs'; import vm from 'node:vm';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
setTimeout(() => { console.log('FAIL: wall clock (60s) exceeded'); process.exit(2); }, 60000).unref();
let fail = 0; const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fail++; } else console.log('ok:', m); };
const J = v => JSON.stringify(v);

// Top-level functions in app.html close with `}` at column 0.
const grab = n => {
  let i = html.indexOf('\nfunction ' + n + '('); if (i < 0) i = html.indexOf('\nasync function ' + n + '(');
  if (i < 0) throw new Error('no ' + n + ' in app.html');
  const eol = html.indexOf('\n', i + 1), first = html.slice(i + 1, eol);
  let d = 0, seen = false; for (const ch of first) { if (ch === '{') { d++; seen = true; } else if (ch === '}') d--; }
  if (seen && d === 0) return first;
  return html.slice(i + 1, html.indexOf('\n}', i) + 2);
};

// ── a fake Supabase client that behaves like PostgREST where it matters ────────────────────────
function makeDb(columns) {
  const cols = new Set(columns);
  const rows = []; let seq = 0; const inserts = [];
  const db = { rows, inserts, failInsert: null };
  db.from = (table) => {
    const q = { op: null, filters: [], payload: null, order: null, range: null };
    const run = () => {
      if (q.op === 'insert') {
        const list = Array.isArray(q.payload) ? q.payload : [q.payload];
        inserts.push(JSON.parse(JSON.stringify(list)));
        if (db.failInsert) { const e = db.failInsert(list); if (e) return { data: null, error: e }; }
        for (const r of list) for (const k of Object.keys(r)) if (!cols.has(k))
          return { data: null, error: { code: 'PGRST204', details: null, hint: null,
            message: `Could not find the '${k}' column of '${table}' in the schema cache` } };
        for (const r of list) {
          seq++;
          const stored = { id: 'id-' + seq, created_at: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString() };
          for (const c of cols) if (!(c in stored)) stored[c] = (c in r) ? JSON.parse(JSON.stringify(r[c])) : null;
          rows.push(stored);
        }
        return { data: null, error: null };
      }
      const hit = rows.filter(r => q.filters.every(f => f(r)));
      if (q.op === 'delete') {
        for (const r of hit) rows.splice(rows.indexOf(r), 1);
        return { data: hit.map(r => ({ id: r.id })), error: null };
      }
      let out = hit.slice();
      if (q.order) out.sort((a, b) => (a[q.order[0]] < b[q.order[0]] ? -1 : 1) * q.order[1]);
      if (q.range) out = out.slice(q.range[0], q.range[1] + 1);
      return { data: out.map(r => JSON.parse(JSON.stringify(r))), error: null };
    };
    const b = {
      select() { if (!q.op) q.op = 'select'; return b; },
      insert(p) { q.op = 'insert'; q.payload = p; return b; },
      delete() { q.op = 'delete'; return b; },
      eq(k, v) { q.filters.push(r => r[k] === v); return b; },
      in(k, vs) { q.filters.push(r => vs.includes(r[k])); return b; },
      order(k, o) { q.order = [k, o && o.ascending === false ? -1 : 1]; return b; },
      range(a, z) { q.range = [a, z]; return b; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
    };
    return b;
  };
  return db;
}
const ALL_COLS = ['id', 'brand_id', 'day', 'community', 'format', 'title', 'hook', 'script', 'shots', 'screen',
  'caption', 'reel_title', 'tags', 'bold_text', 'status', 'dismiss_reason', 'assignee', 'is_generated',
  'created_at', 'is_remix', 'original_creator'];

// ── the real app code, in a vm ─────────────────────────────────────────────────────────────────
const store = new Map();
const c = {
  console: { log() {}, warn() {}, error() {}, info() {} },
  window: {}, state: [], currentBrand: { id: 'brand-1' }, sb: null, cmState: null,
  lsSet: (k, v) => store.set(k, v), lsGet: k => (store.has(k) ? store.get(k) : null),
  showToast() {}, saveIdeasToDB() { c.__saved = (c.__saved || 0) + 1; },
  document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
};
vm.createContext(c);
const FNS = ['tpEscape', 'tpOutsideTags', 'tpSenseLines', 'tpStressRx', 'tpEmphasise', 'tpPruneEmphasis', 'tpCleanEmphasis',
  'tpFormatScript', 'asText', '_buildIdeaRows', '_saveIdeasToDBNow', 'normalizeIdeaStatus', '_ideaRowRecency', 'loadIdeasFromDB', 'tvActiveIdea', 'tvApplyTwist', 'cmClose'];
for (const n of FNS) vm.runInContext(grab(n), c);
for (const m of html.matchAll(/^const (TP_STRESS_[AB]) = .*$/gm)) vm.runInContext(m[0].replace(/^const /, 'var '), c);

const SCRIPT = 'We never raised our prices for 40 months and the business almost died last winter.';
const MARKS = ['almost died', 'last winter'];
const bolded = (text, emph) => (String(c.tpFormatScript(text, emph)).match(/<b class="tp-em">([^<]*)<\/b>/g) || [])
  .map(x => x.replace(/<[^>]*>/g, '').toLowerCase());
const idea = (over) => Object.assign({ day: 'Monday', format: 'video', title: 'Price', hook: 'Nobody tells you this.',
  script: SCRIPT, caption: 'cap', status: 'pending' }, over);
const save = async () => c._saveIdeasToDBNow('brand-1', c._buildIdeaRows('brand-1'));

(async () => {
  // ── 1. marks are written with the row and come back after a reload ──────────────────────────
  {
    const db = makeDb([...ALL_COLS, 'emphasis']); c.sb = db; c.window = {}; c._ideasNoEmphasisCol = false;
    c.state = [idea({ emphasis: MARKS.slice() })];
    const rows = c._buildIdeaRows('brand-1');
    ok(J(rows[0].emphasis) === J(MARKS), 'the row built for the database carries the marks (' + J(rows[0].emphasis) + ')');
    await c._saveIdeasToDBNow('brand-1', rows);
    ok(J(db.rows[0] && db.rows[0].emphasis) === J(MARKS), 'the stored row holds them (' + J(db.rows[0] && db.rows[0].emphasis) + ')');
    c.state = [];                                       // reload: memory is gone, only the database is left
    const loaded = await c.loadIdeasFromDB();
    ok(J(loaded[0] && loaded[0].emphasis) === J(MARKS), 'after a reload the idea has its marks back (' + J(loaded[0] && loaded[0].emphasis) + ')');
    const b = bolded(loaded[0].script, loaded[0].emphasis);
    ok(b.includes('almost died') && b.includes('last winter'), 'and the teleprompter bolds exactly those phrases (' + J(b) + ')');
    // opposite arm: the same row WITHOUT stored marks renders the heuristic, not these phrases —
    // so the bolding above really came from what was persisted.
    db.rows[0].emphasis = null;
    const bare = await c.loadIdeasFromDB();
    const b0 = bolded(bare[0].script, bare[0].emphasis);
    ok(!b0.includes('almost died') && b0.length > 0, 'opposite arm: with no stored marks the heuristic bolds something else (' + J(b0) + ')');
    // a second save round-trips unchanged (reload -> save -> reload keeps them)
    db.rows[0].emphasis = MARKS.slice();
    c.state = await c.loadIdeasFromDB(); await save();
    const again = await c.loadIdeasFromDB();
    ok(again.length === 1 && J(again[0].emphasis) === J(MARKS), 'saving a reloaded idea keeps the marks and does not duplicate it (' + again.length + ' row)');
  }

  // ── 2. junk is cleaned before it is written ──────────────────────────────────────────────────
  {
    c.state = [idea({ emphasis: ['almost died', null, { x: 1 }, '', '  ', 'x', 'y'.repeat(200), ' ALMOST DIED ', ['last winter'], { toString() { return 'last winter'; } }, 'not in this script', 40] })];
    // (the nested array and the object stringify to text that IS in the script — only a type check drops them)
    const e = c._buildIdeaRows('brand-1')[0].emphasis;
    ok(J(e) === J(['almost died', '40']), 'nulls, objects, nested arrays, blanks, 1-char, overlong, duplicate and absent marks are dropped (' + J(e) + ')');
    for (const junk of ['almost died', { 0: 'almost died' }, 42, null, undefined, true]) {
      c.state = [idea({ emphasis: junk })];
      const r = c._buildIdeaRows('brand-1')[0].emphasis;
      ok(Array.isArray(r) && r.length === 0, 'a non-array emphasis (' + J(junk) + ') is written as [] (' + J(r) + ')');
    }
    // opposite arms: good marks survive, and the list is capped
    const words = ['We never', 'raised our', 'prices for', '40 months', 'the business', 'almost died', 'last winter'];
    c.state = [idea({ emphasis: words })];
    const capped = c._buildIdeaRows('brand-1')[0].emphasis;
    ok(capped.length === 6 && J(capped) === J(words.slice(0, 6)), 'seven valid marks are capped at six, in order (' + capped.length + ')');
    c.state = [idea({ emphasis: ['almost died'] })];
    ok(J(c._buildIdeaRows('brand-1')[0].emphasis) === J(['almost died']), 'opposite arm: a clean mark is written untouched');
    // an overlong mark that IS verbatim in the script (a whole sentence) is still not a stress mark
    const LONG = 'We spent the first eighteen months of this business building features nobody asked for, and then we spent six more pretending otherwise';
    c.state = [idea({ script: LONG + '. Then we stopped.', emphasis: [LONG, 'we stopped'] })];
    const lo = c._buildIdeaRows('brand-1')[0].emphasis;
    ok(LONG.length > 120 && J(lo) === J(['we stopped']), 'a mark over 120 characters is dropped even though it appears in the script (' + J(lo) + ')');
    // and junk that is already IN the database is cleaned on the way out too
    const db = makeDb([...ALL_COLS, 'emphasis']); c.sb = db;
    c.state = [idea({})]; await save();
    db.rows[0].emphasis = [null, 'almost died', { a: 1 }, 'z'.repeat(500)];
    const l = await c.loadIdeasFromDB();
    ok(J(l[0].emphasis) === J(['almost died']), 'junk stored in the column is cleaned when it is read (' + J(l[0].emphasis) + ')');
    db.rows[0].emphasis = '["almost died"]';
    ok(J((await c.loadIdeasFromDB())[0].emphasis) === J(['almost died']), 'a JSON-string value is parsed');
    db.rows[0].emphasis = '{not json';
    ok(J((await c.loadIdeasFromDB())[0].emphasis) === J([]), 'an unparseable string reads as no marks');
  }

  // ── 3. a row with no emphasis field at all (column not added yet / old cache) loads fine ─────
  {
    const db = makeDb(ALL_COLS); c.sb = db; c.window = {}; c._ideasNoEmphasisCol = false;
    db.rows.push({ id: 'old-1', brand_id: 'brand-1', created_at: '2025-01-01T00:00:00Z', day: 'Monday', community: '',
      format: 'video', title: 'Old post', hook: 'h', script: SCRIPT, shots: '', screen: '', caption: '', reel_title: '',
      tags: '', bold_text: '', status: 'filming', dismiss_reason: null, assignee: '', is_generated: false, is_remix: false, original_creator: '' });
    let loaded = null, threw = null;
    try { loaded = await c.loadIdeasFromDB(); } catch (e) { threw = e; }
    ok(!threw && loaded && loaded.length === 1, 'a row with no emphasis field loads without throwing' + (threw ? ' (threw ' + threw.message + ')' : ''));
    ok(loaded && J(loaded[0].emphasis) === J([]) && loaded[0].title === 'Old post' && loaded[0].status === 'filming',
      'it reads as "no marks", with every other field intact');
    let html2 = ''; try { html2 = c.tpFormatScript(loaded[0].script, loaded[0].emphasis); } catch (e) { html2 = ''; }
    ok(/tp-em/.test(html2), 'and the teleprompter still renders it, falling back to the heuristic');
  }

  // ── 4. an edited script does not keep (or persist) stale marks ────────────────────────────────
  {
    const db = makeDb([...ALL_COLS, 'emphasis']); c.sb = db; c.window = {}; c._ideasNoEmphasisCol = false;
    const it = idea({ emphasis: ['almost died', 'last winter'] });
    c.state = [it];
    it.script = 'Most founders never check this, and it costs them 40% of their reach last winter.';  // edited, NOT pruned
    await save();
    c.state = [];
    const l = await c.loadIdeasFromDB();
    ok(J(l[0].emphasis) === J(['last winter']), 'a mark no longer in the edited script is not persisted; one still there is (' + J(l[0].emphasis) + ')');
    // Quick Post viral twist — the real tvApplyTwist
    const tv = idea({ emphasis: ['almost died'] });
    c.window = { _todayTabIdea: tv, _tvTwistIdea: { script: 'A brand new script with nothing from before, 12 times over.' } };
    c.tvApplyTwist();
    ok(J(tv.emphasis) === J([]), 'Quick Post viral twist drops marks for the script it replaced (' + J(tv.emphasis) + ')');
    const tv2 = idea({ emphasis: ['almost died'] });
    c.window = { _todayTabIdea: tv2, _tvTwistIdea: { script: 'It almost died twice, and then it did not.' } };
    c.tvApplyTwist();
    ok(J(tv2.emphasis) === J(['almost died']), 'opposite arm: a twist that kept the phrase keeps its mark');
    // statement editor — the real cmClose
    const st = idea({ format: 'statement', boldText: 'Nobody reads past the first line.', emphasis: ['Nobody reads', 'first line'] });
    c.state = [st]; c.cmState = { single: true, ideaId: 0, slides: [{ text: 'Nobody reads the caption.' }] };
    c.cmClose();
    ok(J(st.emphasis) === J(['Nobody reads']), 'the statement editor prunes marks that left the text (' + J(st.emphasis) + ')');
  }

  // ── 5. the column is missing: PGRST204 on write retries WITHOUT the marks, the idea is saved ──
  {
    const db = makeDb(ALL_COLS); c.sb = db; c.window = {}; c._ideasNoEmphasisCol = false;
    c.state = [idea({ title: 'Saved anyway', emphasis: MARKS.slice() })];
    let threw = null; try { await save(); } catch (e) { threw = e; }
    ok(!threw, 'a save against a database without the column does not fail' + (threw ? ' (threw ' + threw.message + ')' : ''));
    ok(db.rows.length === 1 && db.rows[0].title === 'Saved anyway', 'the idea IS in the database (' + db.rows.length + ' row)');
    ok(db.inserts.length === 2 && 'emphasis' in db.inserts[0][0] && !('emphasis' in db.inserts[1][0]),
      'it tried with the marks, got PGRST204, and wrote the same row without them (' + db.inserts.length + ' insert calls)');
    ok(c._ideasNoEmphasisCol === true, 'and remembers the column is missing for the rest of the session');
    c.state = [idea({ title: 'Second', emphasis: MARKS.slice() })];
    await save();
    ok(db.inserts.length === 3 && !('emphasis' in db.inserts[2][0]) && db.rows.some(r => r.title === 'Second'),
      'the next save skips the column straight away — no failed round trip each time');
    const l = await c.loadIdeasFromDB();
    ok(l.length === 2 && l.every(x => J(x.emphasis) === '[]'), 'and those rows load back as ideas with no marks');
  }
  // one bad row in a batch, on a database without the column: the row-by-row fallback must use the
  // same missing-column handling, or every good row in that batch is lost too
  {
    const db = makeDb(ALL_COLS); c.sb = db; c.window = {}; c._ideasNoEmphasisCol = false;
    db.failInsert = list => list.some(r => r.title === 'BAD') ? { code: '22001', message: 'value too long for type character varying' } : null;
    c.state = [idea({ title: 'Good one', emphasis: MARKS.slice() }), idea({ title: 'BAD', emphasis: MARKS.slice() })];
    let threw = null; try { await save(); } catch (e) { threw = e; }
    ok(db.rows.some(r => r.title === 'Good one'), 'when a batch fails for another reason, the row-by-row retry still saves the good idea without the column (' + db.rows.length + ' row)');
    ok(threw && !db.rows.some(r => r.title === 'BAD'), 'and the genuinely bad row is still reported as failed');
  }
  // opposite arms: any OTHER failure is not "fixed" by stripping the marks
  {
    const db = makeDb([...ALL_COLS, 'emphasis']); c.sb = db; c.window = {}; c._ideasNoEmphasisCol = false;
    db.failInsert = () => ({ code: '42501', message: 'new row violates row-level security policy for table "ideas"' });
    c.state = [idea({ emphasis: MARKS.slice() })];
    let threw = null; try { await save(); } catch (e) { threw = e; }
    ok(threw && db.rows.length === 0, 'an RLS refusal still fails the save loudly (nothing claims it was saved)');
    ok(db.inserts.every(b => b.every(r => 'emphasis' in r)) && !c._ideasNoEmphasisCol,
      'and is NOT treated as a missing column — the marks are never stripped for it');
    const db2 = makeDb(ALL_COLS.filter(x => x !== 'tags').concat('emphasis')); c.sb = db2; c.window = {}; c._ideasNoEmphasisCol = false;
    threw = null; try { await save(); } catch (e) { threw = e; }
    ok(threw && !c._ideasNoEmphasisCol, 'a PGRST204 about a DIFFERENT column is not mistaken for the emphasis one');
    const db3 = makeDb([...ALL_COLS, 'emphasis']); c.sb = db3; c.window = {}; c._ideasNoEmphasisCol = false;
    let first = true;
    db3.failInsert = list => (first && list.some(r => 'emphasis' in r)) ? (first = false,
      { code: '42703', message: 'column "emphasis" of relation "ideas" does not exist' }) : null;
    threw = null; try { await save(); } catch (e) { threw = e; }
    ok(!threw && db3.rows.length === 1 && c._ideasNoEmphasisCol === true, 'the Postgres form of the error (42703) is recognised too');
  }

  // ── 6. the migration the driver runs is idempotent and touches nothing else ──────────────────
  {
    const sql = fs.readFileSync(path.join(ROOT, 'sql', 'ideas-emphasis.sql'), 'utf8');
    const code = sql.replace(/--[^\n]*/g, ' ');
    ok(/alter\s+table\s+public\.ideas\s+add\s+column\s+if\s+not\s+exists\s+emphasis\s+jsonb\b/i.test(code),
       'sql/ideas-emphasis.sql adds public.ideas.emphasis jsonb with IF NOT EXISTS (safe to run twice)');
    ok(!/\b(drop|policy|trigger|grant|revoke|disable|update\s+public|delete\s+from|not\s+null)\b/i.test(code),
       'and changes nothing else — no drops, policies, triggers, grants, backfills or NOT NULL');
  }

  if (fail) { console.log('\n' + fail + ' check(s) failed'); process.exit(1); }
  console.log('\nEMPHASIS PERSISTS');
})().catch(e => { console.log('FAIL: gate crashed: ' + (e && e.stack || e)); process.exit(1); });
