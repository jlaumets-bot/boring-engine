#!/usr/bin/env node
// GATE: the brand brain must know which posts the FOUNDER rewrote, on every surface and every
//       device — and must never count the model's own rewrite as the founder's writing.
//
// WHY THIS EXISTS
//   "A post the user rewrote" is the only real evidence of voice this app holds. Everything else
//   in the winners block is text the app generated and the user tapped once to approve. api/_brain.js
//   has two headings for that block, and picks the WEAKER one — the one telling the model these
//   posts were machine-written and the brand description is the stronger signal — whenever no
//   rewritten post survives selection. So getting provenance wrong does not merely lose a signal;
//   it actively instructs the model to discount the voice.
//
//   Two ways it was wrong, both measured in the source before this gate existed:
//
//   1. DEVICE-LOCAL. The rewritten-post list reached the server only as `humanEditedTitles` in a
//      request body, derived from the caller's localStorage. api/send-daily.js has no client, so it
//      could never send it — and that is the one post the app pushes unprompted every day. A second
//      device knew nothing about rewrites made on the first.
//
//   2. LAUNDERED. Sharpen and Viral twist write a taste signal whose `after` is the MODEL's rewrite.
//      getApprovedExamples matched that text back against the approved post and marked the post
//      human-rewritten — handing the model its own output under "THE BRAND'S OWN WORDS — beats every
//      description of the voice above", at the strongest position in the prompt, getting worse every
//      time someone tapped Sharpen. Three writers produce those signals; the first pass tagged two.
//
// HOW IT CHECKS
//   The server half RUNS the real loadBrandContext against a stubbed PostgREST, so a rewrite that
//   keeps the comments but loses the query fails here. The client half is structural, because these
//   writers cannot be executed out of app.html — so it is written as a DERIVED rule (every call site
//   that hands the model's own rewrite to saveEditSignals must tag it) rather than a list, so a
//   fourth writer added tomorrow shows up by itself.
//
// RUN:    node scripts/verify/brain-provenance.mjs
// EXPECT: prints "PASS" and exits 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(ROOT, 'x.js'));
const fails = [];
const bad = m => fails.push(m);

// ── SERVER: the rewritten-post list is derived from the database when no client sent one ──────
// loadBrandContext fails closed with no Supabase credentials. These are placeholders for the
// stubbed transport below — every request is answered by stubRest and none leaves this process.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://gate.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'gate-stub-not-a-key';

const storePath = require.resolve(path.join(ROOT, 'api/_publish/store.js'));
const store = require(storePath);
const realRest = store.rest;
const calls = [];
function stubRest(brandRow, tables) {
  return async (method, p) => {
    calls.push(String(p));
    const table = String(p).split('?')[0];
    if (table === '/brands') return { status: 200, data: [brandRow] };
    const rows = tables[table];
    if (typeof rows === 'function') return rows(String(p));
    return { status: 200, data: rows || [] };
  };
}
const BRAND_ROW = { id: 'b1', brand_name: 'Acme', tones: 'plain', voice_extra: {} };

const load = async (tables, opts) => {
  calls.length = 0;
  store.rest = stubRest(BRAND_ROW, tables);
  try { return await require(path.join(ROOT, 'api/_brandctx.js')).loadBrandContext('b1', opts, ''); }
  finally { store.rest = realRest; }
};

const sigRows = p => {
  // The stub models the two shapes the loader can ask for. `authored_by=is.null` is the filtered
  // read; without it the column does not exist yet and every row comes back.
  const all = [
    { title: 'The rewritten one', authored_by: null },
    { title: 'A sharpened one',   authored_by: 'ai' },
  ];
  const rows = /authored_by=is\.null/.test(p) ? all.filter(r => r.authored_by === null) : all;
  return { status: 200, data: rows };
};

let r = await load({ '/edit_signals': sigRows, '/ideas': [] }, { trusted: true });
if (!r || !r.ok) bad('loadBrandContext failed outright against the stub: ' + JSON.stringify(r && r.reason));
const asked = calls.filter(c => c.startsWith('/edit_signals'));
if (!asked.length) {
  bad('a caller with no client (trusted: true, as api/send-daily.js is) never reads edit_signals, ' +
      'so the daily push still cannot know which posts the founder rewrote.');
}
if (asked.length && !/authored_by=is\.null/.test(asked[0])) {
  bad('the edit_signals read does not exclude signals the MODEL wrote (authored_by=is.null). ' +
      'Sharpen and Viral twist would be counted as the founder\'s own writing: ' + asked[0]);
}
// It must ask for the rewritten posts BY NAME — that is the whole point of storing the title.
if (!calls.some(c => c.startsWith('/ideas') && /title=in\./.test(c))) {
  bad('the titles read out of edit_signals are never used to fetch those posts, so provenance ' +
      'ranking still sees only the recency window. Calls: ' + JSON.stringify(calls));
}
if (calls.some(c => /title=in\./.test(c) && /A%20sharpened%20one|A sharpened one/.test(c))) {
  bad('a MODEL-written signal reached the rewritten-post lookup.');
}

// A column that does not exist yet must degrade to the old behaviour, never to an error.
r = await load({ '/edit_signals': p => (/authored_by/.test(p) ? { status: 400, data: null } : sigRows(p)), '/ideas': [] }, { trusted: true });
if (!r || !r.ok) bad('when edit_signals.authored_by is missing the loader errors instead of falling back. ' +
                     'The SQL is optional by design; this is what makes it optional.');
if (r && r.ok && !calls.some(c => c.startsWith('/ideas') && /title=in\./.test(c))) {
  bad('with the column missing the loader gives up on provenance entirely instead of using the unfiltered read.');
}

// A caller that DID send the client's list must behave exactly as before — no extra query.
r = await load({ '/edit_signals': sigRows, '/ideas': [] }, { trusted: true, humanEdited: ['Client sent this'] });
if (calls.some(c => c.startsWith('/edit_signals'))) {
  bad('a caller that already sent humanEditedTitles now pays an extra database round-trip it does not need.');
}

// ── CLIENT: every signal whose `after` is the model's rewrite must be tagged ───────────────────
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
// DERIVED, not a list: find every object literal pushed as a taste signal whose `after` comes from
// a model rewrite variable (nw.* = viral twist's rewrite, _a = sharpen's rewritten value).
const sigLit = /\{\s*ts\s*:\s*Date\.now\(\)[^}]*\}/g;
let m, untagged = [];
while ((m = sigLit.exec(html))) {
  const lit = m[0];
  const aiAuthored = /after\s*:\s*(nw\.|String\(_a\)|_a\b)/.test(lit);
  if (aiAuthored && !/\bby\s*:\s*'ai'/.test(lit)) {
    const line = html.slice(0, m.index).split('\n').length;
    untagged.push('app.html:' + line + '  ' + lit.replace(/\s+/g, ' ').slice(0, 120));
  }
}
if (untagged.length) {
  bad('taste signals carrying the MODEL\'s own rewrite are not tagged by:\'ai\', so getApprovedExamples ' +
      'will match that text back and present it to the model as the brand\'s own words:\n      ' +
      untagged.join('\n      '));
}
// And the consumer must actually filter on the tag.
const consumer = html.slice(html.indexOf('function getApprovedExamples('), html.indexOf('function getApprovedExamples(') + 4000);
if (!/\.filter\(s\s*=>\s*!s\s*\|\|\s*s\.by\s*!==\s*'ai'\)/.test(consumer)) {
  bad("getApprovedExamples no longer excludes by:'ai' signals, so tagging them achieves nothing.");
}
// The durable copy must carry both columns, and must survive a database that lacks them.
const saver = html.slice(html.indexOf('function saveEditSignals('), html.indexOf('function saveEditSignals(') + 2500);
if (!/authored_by\s*:/.test(saver) || !/title\s*:/.test(saver)) {
  bad('saveEditSignals does not persist authored_by/title, so the server can only ever see this device\'s knowledge.');
}
if (!/insert\(newOnes\.map\(_base\)\)/.test(saver)) {
  bad('saveEditSignals has no fallback insert. If sql/v665-edit-signal-provenance.sql has not been run, ' +
      'PostgREST rejects the unknown columns and taste signals stop being saved durably at all.');
}
if (!fs.existsSync(path.join(ROOT, 'sql/v665-edit-signal-provenance.sql'))) {
  bad('sql/v665-edit-signal-provenance.sql is missing — the columns the code writes have nothing defining them.');
}

if (fails.length) {
  console.error('FAIL:');
  fails.forEach(f => console.error('  - ' + f));
  process.exit(1);
}
console.log('brand-brain provenance verified: rewritten posts are read from the database (so the daily push ' +
            'and a second device both see them), model-written signals are excluded on both sides, and a ' +
            'database without the new columns degrades to the old behaviour rather than erroring.');
console.log('PASS');
