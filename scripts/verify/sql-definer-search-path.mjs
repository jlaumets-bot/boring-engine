// Every SECURITY DEFINER function in sql/** must have a pinned search_path, and the
// live health audit must REQUIRE that rather than reward the definer half alone.
//
// WHY THIS GATE EXISTS. user_brand_ids() (sql/team-tables.sql:127-131) is SECURITY
// DEFINER with no `SET search_path`. A definer function runs with the OWNER's
// privileges but resolves its unqualified names against the CALLER's search_path, so
// a role that can prepend a schema of its own gets this function reading ITS tables
// as the owner. Every brand-scoped RLS policy in the schema delegates its membership
// test to that one function — `USING (brand_id IN (SELECT user_brand_ids()))` — so it
// decides "which brands are mine" for the whole database at once.
//
// It went unnoticed for months because sql/health-check.sql:103-104 tested exactly one
// thing, `prosecdef`, and called it user_brand_ids_secure. That check reported GREEN
// *because* the function is SECURITY DEFINER — which is the half that creates the
// exposure, not the half that closes it. A green light pointing at the hole is worse
// than no light, so this gate asserts BOTH the SQL and the audit that watches it.
import fs from 'fs';
import path from 'path';
import { stripSqlComments, selfTest } from './_sqlscan.mjs';

selfTest();

const root = process.cwd();
const sqlDir = path.join(root, 'sql');
const fails = [];
const fail = m => fails.push(m);

const files = fs.readdirSync(sqlDir).filter(f => f.endsWith('.sql')).sort();
if (!files.length) { console.error('no .sql files found under sql/ — wrong cwd?'); process.exit(1); }

const src = new Map();          // file -> comment-stripped text
for (const f of files) src.set(f, stripSqlComments(fs.readFileSync(path.join(sqlDir, f), 'utf8')));
const allSql = [...src.values()].join('\n');

// ── Which functions are pinned by a later ALTER FUNCTION? ───────────────────────────────────────
// A historical CREATE cannot always be edited safely (re-declaring a body from a repo
// that is known to lag production would revert live fixes), so the pin is allowed to
// arrive as `alter function f(...) set search_path = ...` in any file.
const alterPinned = new Set();
{
  const re = /alter\s+function\s+(?:public\s*\.\s*)?([a-z0-9_]+)\s*\([^)]*\)[^;]*?set\s+search_path\s*=/gi;
  let r;
  while ((r = re.exec(allSql))) alterPinned.add(r[1].toLowerCase());
}

// ── Every SECURITY DEFINER declaration must be pinned ───────────────────────────────────────────
const DECL = /create\s+(?:or\s+replace\s+)?function\s+(?:public\s*\.\s*)?([a-z0-9_]+)\s*\(/gi;
let found = 0, definers = 0;
for (const [file, text] of src) {
  DECL.lastIndex = 0;
  let m;
  while ((m = DECL.exec(text))) {
    found++;
    const name = m[1].toLowerCase();
    // The attribute clauses are everything in the statement EXCEPT the body — and they may sit
    // on EITHER side of it. sql/team-tables.sql:127-131 puts them after:
    //   CREATE OR REPLACE FUNCTION user_brand_ids() RETURNS SETOF uuid AS $$ … $$
    //     LANGUAGE sql SECURITY DEFINER STABLE;
    // A first version of this gate read only the text BEFORE the body and therefore did not see
    // that SECURITY DEFINER at all — it passed the very function it was written for, and only the
    // by-name assertion below caught the mutation. Both sides are read now.
    const rest = text.slice(m.index);
    const bodyAt = rest.search(/\bas\s+(\$|')/i);
    let attrs;
    if (bodyAt === -1) {
      const end = rest.indexOf(';');
      attrs = rest.slice(0, end === -1 ? 1200 : end);
    } else {
      const after = rest.slice(bodyAt);
      const tag = (/^as\s+(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$|')/i.exec(after) || [])[1];
      let tail = '';
      if (tag) {
        const openEnd = after.indexOf(tag) + tag.length;
        const close = after.indexOf(tag, openEnd);
        const afterBody = close === -1 ? '' : after.slice(close + tag.length);
        const end = afterBody.indexOf(';');
        tail = end === -1 ? afterBody.slice(0, 400) : afterBody.slice(0, end);
      }
      attrs = rest.slice(0, bodyAt) + ' ' + tail;
    }
    if (!/security\s+definer/i.test(attrs)) continue;
    definers++;
    const pinnedHere = /set\s+search_path\s*=/i.test(attrs);
    if (pinnedHere || alterPinned.has(name)) continue;
    fail(`sql/${file}: ${name}() is SECURITY DEFINER with no pinned search_path (and nothing ALTERs one onto it) — ` +
         `it resolves its tables against the CALLER's search_path while running as the owner`);
  }
}
if (!found) fail('no CREATE FUNCTION found anywhere in sql/** — the scanner is broken, not the schema');
if (!definers) fail('no SECURITY DEFINER function found in sql/** — this gate would pass vacuously');

// ── The linchpin, named explicitly ──────────────────────────────────────────────────────────────
// Asserted by name as well as by the sweep above, because this is the one function whose
// compromise is total and the sweep could be passed by deleting the declaration.
if (!/\buser_brand_ids\b/.test(allSql)) {
  fail('user_brand_ids is not defined anywhere in sql/** — every brand-scoped policy depends on it');
} else if (!alterPinned.has('user_brand_ids') && !/create\s+(?:or\s+replace\s+)?function\s+(?:public\s*\.\s*)?user_brand_ids\s*\([^)]*\)[\s\S]{0,400}?set\s+search_path\s*=/i.test(allSql)) {
  fail('user_brand_ids() has no pinned search_path — see sql/v657-search-path.sql');
}

// ── The audit that certified the hole must no longer be able to ─────────────────────────────────
const hcPath = path.join(sqlDir, 'health-check.sql');
if (!fs.existsSync(hcPath)) {
  fail('sql/health-check.sql is gone — the live posture audit is what catches drift made in the dashboard');
} else {
  const hc = src.get('health-check.sql');
  // Bound the read to the BODY of security_health(). A fixed-size window from the key ran off the
  // end of the shrunken expression and into this file's own VERIFY block, whose text mentions
  // proconfig — so a reverted check read as fixed. The oracle must not be able to satisfy itself
  // out of the prose that describes it.
  const fnAt = hc.search(/create\s+or\s+replace\s+function\s+(?:public\s*\.\s*)?security_health\s*\(/i);
  const afterFn = fnAt === -1 ? '' : hc.slice(fnAt);
  const openTag = (/\bas\s+(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)/i.exec(afterFn) || [])[1];
  const bodyStart = openTag ? afterFn.indexOf(openTag) + openTag.length : -1;
  const bodyEnd = bodyStart === -1 ? -1 : afterFn.indexOf(openTag, bodyStart);
  const body = bodyStart === -1 || bodyEnd === -1 ? '' : afterFn.slice(bodyStart, bodyEnd);
  if (!body) fail('health-check.sql: could not read the body of security_health() — the audit cannot be verified');
  const key = body.indexOf("'user_brand_ids_secure'");
  if (key === -1) {
    fail('health-check.sql no longer reports user_brand_ids_secure — the live audit stopped watching the linchpin');
  } else {
    const expr = body.slice(key);
    if (!/prosecdef/.test(expr)) {
      fail('health-check.sql: user_brand_ids_secure no longer checks prosecdef — do not trade one half of the test for the other');
    }
    if (!/proconfig/.test(expr) || !/search_path/.test(expr)) {
      fail('health-check.sql: user_brand_ids_secure still passes on prosecdef alone — SECURITY DEFINER is the exposure, ' +
           'the pinned search_path is what makes it safe. It must require BOTH (check proconfig for search_path=).');
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────────────────────────────────
if (fails.length) {
  for (const f of fails) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log(`${definers} SECURITY DEFINER function(s) in sql/**, all with a pinned search_path`);
console.log('health-check.sql requires prosecdef AND a pinned search_path for user_brand_ids');
console.log('definer search_path verification passed');
