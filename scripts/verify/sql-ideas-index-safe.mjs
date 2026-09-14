// The UNIQUE index on ideas(brand_id, title) and app.html's ideas write path must agree.
// This gate exists because getting that pairing wrong is a full outage of the app's
// write path, not a hardening regression.
//
// THE PAIRING. _saveIdeasToDBNow (app.html:7584-7660) is WRITE-BEFORE-DELETE by design:
// it INSERTS the new copy of every row while the old row is still present, and removes
// the superseded copy only once the insert is confirmed. The previous order (delete
// everything, then insert) left a multi-second window in which the user's entire content
// library did not exist in the database, and a dropped connection in that window
// destroyed it permanently. That order is correct and must not be undone.
//
// Its cost is that a failed cleanup leaves a duplicate behind — the class
// sql/v657-ideas-dedupe.sql cleans up, and which a UNIQUE index on (brand_id, title)
// would make impossible. But a plain `.insert()` over an existing row under that index
// raises 23505 unique_violation. Every batch fails, the row-by-row retry fails, and
// saveIdeasToDB throws "N idea(s) failed to save" on every approve, mark-done and
// dismiss. NOTHING would persist.
//
// So the index is only safe once the insert becomes an upsert keyed on that same
// conflict target — which keeps the write-before-delete property exactly (the new
// content lands in one statement; the library is never absent) while satisfying the
// index. The index is therefore held back in sql/v657-ideas-dedupe.sql PART 2, and this
// gate fails if either half moves without the other.
import fs from 'fs';
import path from 'path';
import { stripSqlComments, selfTest as sqlSelfTest } from './_sqlscan.mjs';
import { stripComments, selfTest as jsSelfTest } from './_srcscan.mjs';

sqlSelfTest();
jsSelfTest();

const root = process.cwd();
const sqlDir = path.join(root, 'sql');
const fails = [];
const fail = m => fails.push(m);

const files = fs.readdirSync(sqlDir).filter(f => f.endsWith('.sql')).sort();
if (!files.length) { console.error('no .sql files found under sql/ — wrong cwd?'); process.exit(1); }
// Comments stripped: a held-back statement sitting in a comment block is NOT applied, and a gate
// that cannot tell the difference would certify a pairing that does not exist.
const allSql = files.map(f => stripSqlComments(fs.readFileSync(path.join(sqlDir, f), 'utf8'))).join('\n');

// ── Is the index live in the repo? ──────────────────────────────────────────────────────────────
const INDEX_LIVE = /create\s+unique\s+index[\s\S]{0,120}?\bon\s+(?:public\s*\.\s*)?ideas\s*\([^)]*\bbrand_id\b[^)]*\btitle\b[^)]*\)/i.test(allSql);

// ── What does app.html do on the ideas write path? ──────────────────────────────────────────────
const appPath = path.join(root, 'app.html');
if (!fs.existsSync(appPath)) { console.error('app.html not found — wrong cwd?'); process.exit(1); }
// keepStrings: the call we are looking for IS `from('ideas')`. Comments go, strings stay.
const app = stripComments(fs.readFileSync(appPath, 'utf8'));

const PLAIN_INSERT = /from\(\s*['"]ideas['"]\s*\)\s*\.\s*insert\s*\(/i.test(app);
const UPSERT = /from\(\s*['"]ideas['"]\s*\)\s*\.\s*upsert\s*\(/i.test(app);
const UPSERT_KEYED = /from\(\s*['"]ideas['"]\s*\)\s*\.\s*upsert\s*\([\s\S]{0,200}?onConflict[\s\S]{0,60}?brand_id\s*,\s*title/i.test(app);

// ── The rule ────────────────────────────────────────────────────────────────────────────────────
if (INDEX_LIVE && PLAIN_INSERT) {
  fail('a UNIQUE index on ideas(brand_id, title) is ENABLED in sql/** while app.html still does ' +
       "sb.from('ideas').insert(...) over rows that already exist (write-before-delete, app.html:7584-7660). " +
       'Every save of an existing idea would raise 23505 and saveIdeasToDB would throw "N idea(s) failed to save" ' +
       '— on every approve, mark-done and dismiss. Switch the insert to ' +
       ".upsert(batch, { onConflict: 'brand_id,title' }) FIRST, or comment the index back out.");
}
if (UPSERT && !UPSERT_KEYED) {
  fail("app.html upserts ideas but not with onConflict 'brand_id,title' — an upsert with no matching " +
       'unique index falls back to a plain insert and silently reintroduces duplicates');
}
if (UPSERT_KEYED && !INDEX_LIVE) {
  fail("app.html upserts ideas with onConflict 'brand_id,title' but no such UNIQUE index exists in sql/** — " +
       'PostgreSQL rejects an ON CONFLICT target with no matching unique index, so every ideas save fails. ' +
       'Enable PART 2 of sql/v657-ideas-dedupe.sql.');
}
if (!PLAIN_INSERT && !UPSERT) {
  fail("no ideas write found in app.html (neither .insert nor .upsert on from('ideas')) — the scanner is broken, " +
       'or the save path moved and this pairing must be re-derived before it is trusted');
}

// ── The cleanup script must stay archive-then-delete ─────────────────────────────────────────────
// The destructive half is only acceptable because every removed row is copied out first and left
// where it can be read back. Reordering those two, or dropping the archive, turns a reversible
// cleanup into an irreversible one.
const dedupePath = path.join(sqlDir, 'v657-ideas-dedupe.sql');
if (!fs.existsSync(dedupePath)) {
  fail('sql/v657-ideas-dedupe.sql is missing — five duplicate (brand_id, title) groups exist in production');
} else {
  const d = stripSqlComments(fs.readFileSync(dedupePath, 'utf8'));
  const archiveAt = d.search(/insert\s+into\s+archive\.[a-z0-9_]+/i);
  const deleteAt  = d.search(/delete\s+from\s+(?:public\s*\.\s*)?ideas\b/i);
  if (archiveAt === -1) fail('v657-ideas-dedupe.sql no longer archives the rows it deletes — the cleanup is not reversible');
  else if (deleteAt === -1) fail('v657-ideas-dedupe.sql no longer deletes anything — the duplicates stay');
  else if (archiveAt > deleteAt) fail('v657-ideas-dedupe.sql deletes BEFORE it archives — the rows are gone before the copy is made');
  if (!/create\s+schema\s+if\s+not\s+exists\s+archive/i.test(d)) {
    fail('v657-ideas-dedupe.sql no longer puts the archive in the `archive` schema — a backup table in `public` ' +
         'with no RLS is readable through PostgREST by any signed-in user');
  }
  if (!/\btitle\s+is\s+not\s+null\b/i.test(d) || !/title\s*<>\s*''/.test(d)) {
    fail('v657-ideas-dedupe.sql no longer excludes null/empty titles — untitled rows are not duplicates of each other');
  }
}

// ── Report ──────────────────────────────────────────────────────────────────────────────────────
if (fails.length) {
  for (const f of fails) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log(`ideas unique index ${INDEX_LIVE ? 'ENABLED' : 'held back'}; app.html write path: ` +
            `${UPSERT_KEYED ? "upsert onConflict 'brand_id,title'" : UPSERT ? 'upsert (unkeyed)' : 'plain insert'} — consistent`);
console.log('v657-ideas-dedupe.sql archives to the `archive` schema before it deletes');
console.log('ideas index safety verification passed');
