// A brand-scoped UPDATE policy must not leave the NEW row's brand unconstrained.
//
// THE DEFECT THIS GATE ENCODES. Every brand-scoped UPDATE policy in this schema omits
// WITH CHECK — sql/team-tables.sql:101-108 for ideas, and the FOR ALL policy built by
// the DO-loop at :136-147 for remixes, product_refs, competitors, prompt_history.
// When an UPDATE policy has no WITH CHECK, Postgres REUSES USING as the check on the
// new row. USING says "brand_id is one of my brands", and the new row satisfies that
// if its brand_id is one of MY brands. So a member can run
//     update ideas set brand_id = '<a brand I own>' where brand_id = '<the owner's>'
// and the owner's library is permanently re-parented into the member's workspace —
// still theirs after they are removed from the team.
//
// WHY IT IS NOT "ADD A WITH CHECK". The rule needed is "the new brand_id must equal
// the OLD brand_id", and a WITH CHECK expression cannot reference OLD. A BEFORE UPDATE
// trigger is the only tool that can express it — the same conclusion, for the same
// reason, as sql/security-fixes-batch2.sql:38-43 reached for brands.user_id.
//
// So this gate does not demand a WITH CHECK. It demands that every brand-scoped
// UPDATE/ALL policy is backed by EITHER a real WITH CHECK or a BEFORE UPDATE trigger
// that pins brand_id — and that the trigger actually pins it, rather than merely
// existing. See sql/v657-brand-pinning.sql.
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
const src = new Map();
for (const f of files) src.set(f, stripSqlComments(fs.readFileSync(path.join(sqlDir, f), 'utf8')));
const allSql = [...src.values()].join('\n');

// ── Is there a catalog-driven pin covering EVERY brand-scoped table? ────────────────────────────
// v657-brand-pinning attaches by looping over pg_attribute for a brand_id column, so it covers
// tables that do not exist yet. That is stronger than a per-table list and is accepted as such —
// but only if the loop really is driven off the brand_id column AND really creates a BEFORE
// UPDATE trigger, so a loop that was edited to attach nothing cannot pass.
const UNIVERSAL_PIN = /attname\s*=\s*'brand_id'/i.test(allSql) &&
                      /create\s+trigger\s+pin_brand_id_trg\s+before\s+update/i.test(allSql);

// Tables named by an explicit per-table BEFORE UPDATE trigger (any name).
const explicitPin = new Set();
{
  const re = /create\s+trigger\s+[a-z0-9_]+\s+before\s+update\s+on\s+(?:public\s*\.\s*)?([a-z0-9_]+)/gi;
  let m;
  while ((m = re.exec(allSql))) explicitPin.add(m[1].toLowerCase());
}

// ── The trigger function must actually pin the column ───────────────────────────────────────────
// A trigger that returns NEW unchanged satisfies "a trigger exists" and closes nothing.
if (UNIVERSAL_PIN) {
  const fnAt = allSql.search(/create\s+or\s+replace\s+function\s+(?:public\s*\.\s*)?pin_brand_id\s*\(/i);
  if (fnAt === -1) {
    fail('a pin_brand_id_trg trigger is created but public.pin_brand_id() is never defined');
  } else {
    const fn = allSql.slice(fnAt, fnAt + 2500);
    if (!/new\.brand_id\s*:=\s*old\.brand_id/i.test(fn)) {
      fail('pin_brand_id() never assigns new.brand_id := old.brand_id — the trigger exists but pins nothing');
    }
    if (!/auth\.uid\(\)/.test(fn) || !/is\s+null/i.test(fn)) {
      fail('pin_brand_id() has no service-role exemption (auth.uid() is null) — backend jobs and api/*.js would be constrained too');
    }
    if (!/before\s+update/i.test(allSql.slice(fnAt))) {
      fail('pin_brand_id() is not attached as a BEFORE UPDATE trigger — an AFTER trigger cannot change the row');
    }
  }
}

// ── Every brand-scoped UPDATE/ALL policy must be backed ─────────────────────────────────────────
// Policies are matched inside string literals too: team-tables.sql:144 creates its FOR ALL policy
// through EXECUTE format('CREATE POLICY … %1$s …'), so the table name there is a format specifier
// rather than an identifier. Such a policy is treated as applying to EVERY brand-scoped table,
// which is what the surrounding loop makes it do.
// A first version of this scanner used one regex with a lookahead terminator. The lookahead could
// not be satisfied inside the EXECUTE format(...) call, so the TEMPLATED policy — the single most
// important one, the FOR ALL that covers remixes, product_refs, competitors and prompt_history —
// matched nothing and the gate reported only two risky policies instead of three. Statement
// boundaries are found explicitly now: the next CREATE POLICY, a semicolon, or the end of the
// string literal that carries the statement.
const heads = [];
{
  const re = /create\s+policy\s+("[^"]*"|'[^']*'|[a-z0-9_]+)\s+on\s+((?:public\s*\.\s*)?(?:%\d*\$?s|[a-z0-9_]+))/gi;
  let m;
  while ((m = re.exec(allSql))) heads.push({ idx: m.index, end: re.lastIndex, name: m[1], tbl: m[2] });
}

let scanned = 0, risky = 0;
const riskyNames = [];
for (let i = 0; i < heads.length; i++) {
  scanned++;
  const h = heads[i];
  const hardStop = Math.min(h.end + 900, i + 1 < heads.length ? heads[i + 1].idx : allSql.length);
  let rest = allSql.slice(h.end, hardStop);
  const cut = rest.search(/;|'\s*[,)]|\bdrop\s+policy\b/i);   // ; ends a statement; ', or ') ends a format() literal
  if (cut !== -1) rest = rest.slice(0, cut);

  const rawTbl = h.tbl.replace(/^public\s*\.\s*/i, '').toLowerCase();
  const cmdM = /\bfor\s+(all|update|select|insert|delete)\b/i.exec(rest);
  const cmd = cmdM ? cmdM[1].toLowerCase() : 'all';       // no FOR clause means FOR ALL
  if (cmd !== 'all' && cmd !== 'update') continue;        // only UPDATE-capable policies re-parent rows
  if (!/\bbrand_id\b/i.test(rest)) continue;             // not brand-scoped
  if (/\bwith\s+check\b/i.test(rest)) continue;          // the new row is constrained explicitly
  risky++;
  riskyNames.push(`${rawTbl} ${h.name}`);
  const templated = /%/.test(rawTbl);
  // `brands` has no brand_id column, so the catalog-driven pin never attaches to it — it must be
  // carried by its own trigger (brands_pin_ownership, security-fixes-batch2.sql:96-99). Letting
  // UNIVERSAL_PIN cover it would be a pass this gate has not actually earned.
  if (UNIVERSAL_PIN && (templated || rawTbl !== 'brands')) continue;
  if (templated) {
    fail(`a templated FOR ${cmd.toUpperCase()} policy (EXECUTE format) on brand-scoped tables has no WITH CHECK, ` +
         `and there is no catalog-driven brand_id pin to back it — a member can move those rows into their own brand`);
  } else if (!explicitPin.has(rawTbl)) {
    fail(`${rawTbl}: FOR ${cmd.toUpperCase()} policy with no WITH CHECK and no BEFORE UPDATE trigger — ` +
         `USING is reused as the check, so a member can set brand_id to a brand they own and take the rows`);
  }
}
if (!scanned) fail('no CREATE POLICY found anywhere in sql/** — the scanner is broken, not the schema');
// This repo contains THREE such policies (ideas, brands, and the templated FOR ALL). A scanner
// that finds fewer has stopped seeing one of them — which is exactly how the templated policy was
// missed once already — so the floor is asserted, not just "at least one".
if (risky < 3) fail(`only ${risky} brand-scoped UPDATE/ALL policies without WITH CHECK found (expected at least 3: ideas, brands, and the templated FOR ALL) — the scanner is under-reporting`);

// ── The live audit must see this class too ──────────────────────────────────────────────────────
// A static gate only covers what is IN the repo. Someone editing a policy in the Supabase
// dashboard is caught by security_health(), so it must carry the same test.
const hc = src.get('health-check.sql') || '';
if (!hc) {
  fail('sql/health-check.sql is missing — nothing would catch a policy edited straight in the dashboard');
} else {
  if (!/update_unpinned/i.test(hc)) {
    fail('health-check.sql has no update_unpinned check — an UPDATE policy with no WITH CHECK is still invisible to the live audit');
  }
  const wp = /write_permissive\s+as\s*\(([\s\S]{0,400}?)\)/i.exec(hc);
  if (!wp) fail('health-check.sql: write_permissive not found');
  else if (!/'UPDATE'/.test(wp[1])) {
    fail("health-check.sql: write_permissive still omits 'UPDATE' — an UPDATE policy with a true predicate is in neither " +
         'write_permissive nor read_permissive');
  }
}

// ── Report ──────────────────────────────────────────────────────────────────────────────────────
if (fails.length) {
  for (const f of fails) console.error(`FAIL: ${f}`);
  process.exit(1);
}
console.log(`${scanned} policies scanned; ${risky} brand-scoped UPDATE/ALL policies with no WITH CHECK ` +
            `(${riskyNames.join('; ')}) — all backed by a BEFORE UPDATE brand_id pin` +
            `${UNIVERSAL_PIN ? ' (catalog-driven, covers future tables)' : ''}`);
console.log('health-check.sql reports update_unpinned_policies and counts UPDATE as a write');
console.log('update pinning verification passed');
