// ============================================================================
// v658 gate — three defects, one gate. Run: node scripts/verify/invite-link-owner-delete.mjs
//
//  1. EVERY INVITE LINK WAS BROKEN. app.html builds invite links as
//     `origin + '/?invite=' + code` — pointed at the LANDING page — and index.html's
//     forwarding script only forwarded `access_token`, `type=magiclink` and `code=`.
//     vercel.json rewrites only /auth/confirm. So an invited person landed on the
//     marketing page, the code was discarded, and they signed up as a brand-new user
//     with an empty brand while the invite expired unused.
//     This part does not grep for the fix. It EXECUTES the real script out of
//     index.html against a table of URLs, so it fails if the condition forwards the
//     wrong things, and equally if the destination it builds loses the query string
//     (the old code concatenated hash + search, which buries `?invite=` inside the
//     fragment where URLSearchParams can never see it).
//
//  2. security_health() WAS WORLD-CALLABLE. A GRANT does not narrow anything:
//     PostgreSQL grants EXECUTE to PUBLIC by default and anon/authenticated are
//     members of PUBLIC. sql/v658-revoke-security-health.sql closes it. This gate
//     requires EVERY function defined anywhere in sql/** to be named in that file's
//     grant table — so the next function added with no REVOKE fails here rather than
//     being noticed a year later.
//
//  3. A TEAM MEMBER COULD DELETE THE OWNER'S LIBRARY. team-tables.sql:156 grants
//     FOR ALL (which includes DELETE) on brand_id IN (SELECT user_brand_ids()), and
//     user_brand_ids() returns brands you merely belong to. sql/v658-member-delete.sql
//     narrows DELETE to the owner while leaving read/insert/update alone. This gate
//     checks both halves: that no member-scoped DELETE-capable policy is left
//     un-retired, AND that members did not lose the three commands they keep, AND
//     that an owner-bound DELETE still exists (or the owner's "Start over" is broken).
//
// House rules this gate also enforces on both new SQL files: idempotent DDL, and a
// trailing read-only verify whose EMPTY RESULT means pass.
// ============================================================================
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { stripSqlComments, selfTest } from './_sqlscan.mjs';

selfTest();

const root = process.cwd();
const fails = [];
const notes = [];
const fail = m => fails.push(m);

// ─────────────────────────────────────────────────────────────────────────────
// PART 1 — the invite link actually reaches the app. Executed, not grepped.
// ─────────────────────────────────────────────────────────────────────────────
const indexPath = path.join(root, 'index.html');
if (!fs.existsSync(indexPath)) {
  fail('index.html not found — wrong cwd?');
} else {
  const html = fs.readFileSync(indexPath, 'utf8');

  // The forwarding script is the head script that replaces the location with /app.html.
  let code = null;
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const body = m[1];
    if (/location\s*\.\s*replace\s*\(/.test(body) && /app\.html/.test(body)) { code = body; break; }
  }

  if (!code) {
    fail('index.html has no inline script that replaces the location with /app.html — ' +
         'the landing page no longer forwards magic links or invites at all');
  } else {
    // Execute it with a fake window. Anything it touches beyond window.location is a
    // sign the script grew a dependency this harness cannot model, and throws below.
    const run = (href) => {
      const u = new URL(href);
      let dest = null;
      const win = {
        location: {
          href: u.href, origin: u.origin, protocol: u.protocol, host: u.host,
          hostname: u.hostname, pathname: u.pathname, search: u.search, hash: u.hash,
          replace(to) { dest = String(to); },
          assign(to)  { dest = String(to); }
        }
      };
      const ctx = vm.createContext({ window: win, location: win.location, document: undefined });
      vm.runInContext(code, ctx, { timeout: 2000, filename: 'index.html#forwarding' });
      return dest;
    };

    const O = 'https://contentshrimp.com';
    const cases = [
      // [label,                       url,                                              expected destination]
      ['invite link (the broken one)', `${O}/?invite=a1b2c3d4e5f6`,                        '/app.html?invite=a1b2c3d4e5f6'],
      ['invite + magic-link hash',     `${O}/?invite=a1b2c3d4e5f6#access_token=tok&type=magiclink`,
                                                                                          '/app.html?invite=a1b2c3d4e5f6#access_token=tok&type=magiclink'],
      ['magic link (access_token)',    `${O}/#access_token=tok&refresh_token=r&type=magiclink`,
                                                                                          '/app.html#access_token=tok&refresh_token=r&type=magiclink'],
      ['magic link (type=magiclink)',  `${O}/#type=magiclink&foo=1`,                       '/app.html#type=magiclink&foo=1'],
      ['pkce code=',                   `${O}/?code=pkce-xyz`,                              '/app.html?code=pkce-xyz'],
      ['ordinary visit',               `${O}/`,                                            null],
      ['ordinary visit with utm',      `${O}/?utm_source=twitter&utm_campaign=launch`,     null],
      ['ordinary visit with anchor',   `${O}/#pricing`,                                    null],
      ['empty ?invite= (no code)',     `${O}/?invite=`,                                    null],
    ];

    let ran = 0;
    for (const [label, url, expected] of cases) {
      let got;
      try { got = run(url); }
      catch (e) {
        fail(`forwarding script threw on ${label} (${url}): ${e && e.message}`);
        continue;
      }
      ran++;
      if (expected === null) {
        if (got !== null) fail(`${label}: ${url} must STAY on the landing page, but it forwarded to ${got}`);
      } else if (got === null) {
        fail(`${label}: ${url} was NOT forwarded — it should have gone to ${expected}`);
      } else if (got !== expected) {
        fail(`${label}: ${url} forwarded to ${got} — expected ${expected}`);
      }
      // A destination that carries both parts must put the query string BEFORE the
      // fragment. '#…?invite=' is syntactically a fragment containing a '?', and
      // URLSearchParams(window.location.search) reads nothing from it.
      if (got && got.includes('#') && got.includes('?') && got.indexOf('?') > got.indexOf('#')) {
        fail(`${label}: forwarded to ${got} — the query string is INSIDE the fragment, so app.html cannot read it`);
      }
    }
    if (ran !== cases.length) fail(`only ${ran}/${cases.length} forwarding cases executed`);
    else notes.push(`index.html forwarding script executed against ${cases.length} URLs (invite, invite+hash, magiclink x2, code=, and 4 that must not forward)`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Load sql/** once, comments stripped (a REVOKE in a comment is not a REVOKE).
// ─────────────────────────────────────────────────────────────────────────────
const sqlDir = path.join(root, 'sql');
const files = fs.existsSync(sqlDir) ? fs.readdirSync(sqlDir).filter(f => f.endsWith('.sql')).sort() : [];
if (!files.length) fail('no .sql files under sql/ — wrong cwd?');
const src = new Map();
for (const f of files) src.set(f, stripSqlComments(fs.readFileSync(path.join(sqlDir, f), 'utf8')));
const allSql = [...src.values()].join('\n');

const REVOKE_FILE = 'v658-revoke-security-health.sql';
const DELETE_FILE = 'v658-member-delete.sql';
const revokeSql = src.get(REVOKE_FILE) || '';
const deleteSql = src.get(DELETE_FILE) || '';

// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — nothing untrusted may execute security_health(), and no function in
// sql/** may be left on PostgreSQL's default PUBLIC EXECUTE grant.
// ─────────────────────────────────────────────────────────────────────────────
if (!revokeSql) {
  fail(`sql/${REVOKE_FILE} is missing — security_health() is still callable by any signed-in user ` +
       `(and plausibly by anon), returning the list of tables with RLS off`);
} else {
  if (!/revoke\s+(all|execute)[\s\S]{0,80}?\bfrom\s+public\b/i.test(revokeSql)) {
    fail(`sql/${REVOKE_FILE} never revokes from PUBLIC — a GRANT alone narrows nothing, ` +
         `PUBLIC keeps the default EXECUTE and anon/authenticated are members of it`);
  }
  for (const role of ['anon', 'authenticated']) {
    if (!new RegExp(`revoke[\\s\\S]{0,120}?from\\s+%?I?['"\`]?\\s*$|['"]${role}['"]`, 'i').test(revokeSql) &&
        !new RegExp(`\\b${role}\\b`).test(revokeSql)) {
      fail(`sql/${REVOKE_FILE} never mentions ${role} — a direct grant to that role survives a REVOKE FROM PUBLIC`);
    }
  }
  if (!/grant\s+execute[\s\S]{0,80}?service_role/i.test(revokeSql)) {
    fail(`sql/${REVOKE_FILE} does not re-grant service_role — revoking PUBLIC takes EXECUTE away from ` +
         `service_role too, and api/health.js:122 calls security_health() with the service key`);
  }

  // Every function defined anywhere in sql/** must appear in the revoke file's table.
  const defined = new Set();
  {
    const fre = /create\s+(?:or\s+replace\s+)?function\s+(?:public\s*\.\s*)?([a-z0-9_]+)\s*\(/gi;
    let mm;
    while ((mm = fre.exec(allSql))) defined.add(mm[1].toLowerCase());
  }
  if (!defined.size) fail('no CREATE FUNCTION found anywhere in sql/** — the scanner is broken, not the schema');
  if (!defined.has('security_health')) fail('security_health() is not defined anywhere in sql/** — the scanner is broken');
  const missing = [...defined].filter(fn => !new RegExp(`['"]${fn}['"]`, 'i').test(revokeSql));
  if (missing.length) {
    fail(`function(s) defined in sql/** but never named in sql/${REVOKE_FILE}: ${missing.join(', ')} — ` +
         `each is still on PostgreSQL's default PUBLIC EXECUTE grant`);
  } else {
    notes.push(`all ${defined.size} functions defined in sql/** (${[...defined].sort().join(', ')}) are named in ${REVOKE_FILE}`);
  }

  // Do not weaken what is already there: health-check.sql must keep the service_role grant.
  const hc = src.get('health-check.sql') || '';
  if (hc && !/grant\s+execute\s+on\s+function\s+security_health\(\)\s+to\s+service_role/i.test(hc)) {
    fail('sql/health-check.sql no longer grants security_health() to service_role — /api/health would go dark');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 3 — DELETE on the content library is owner-only; members keep the rest.
// ─────────────────────────────────────────────────────────────────────────────
const WIPE = ['ideas', 'remixes', 'product_refs', 'competitors', 'prompt_history', 'notebook_notes', 'edit_signals'];
const FOR_ALL_TBLS = ['remixes', 'product_refs', 'competitors', 'prompt_history'];

if (!deleteSql) {
  fail(`sql/${DELETE_FILE} is missing — team-tables.sql:156 still grants members FOR ALL (which includes DELETE) ` +
       `on remixes, product_refs, competitors and prompt_history`);
} else {
  // Every CREATE POLICY in the repo, sliced to its own statement. Policies created through
  // EXECUTE format(...) are matched too — the FOR ALL that started all this exists only as
  // the contents of a string literal (team-tables.sql:156), so a scanner that skipped string
  // bodies would miss the single most important policy in the schema.
  const heads = [];
  {
    const pre = /create\s+policy\s+("[^"]*"|[a-z0-9_]+)\s+on\s+((?:public\s*\.\s*)?(?:%\d*\$?[sI]|[a-z0-9_]+))/gi;
    let mm;
    while ((mm = pre.exec(allSql))) heads.push({ idx: mm.index, end: pre.lastIndex, name: mm[1], tbl: mm[2] });
  }
  if (heads.length < 10) fail(`only ${heads.length} CREATE POLICY statements found in sql/** — the scanner is under-reporting`);

  const dropped = deleteSql.toLowerCase();
  let memberDeletes = 0;
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    const hardStop = Math.min(h.end + 900, i + 1 < heads.length ? heads[i + 1].idx : allSql.length);
    let rest = allSql.slice(h.end, hardStop);
    const cut = rest.search(/;|'\s*[,)]|\bdrop\s+policy\b/i);
    if (cut !== -1) rest = rest.slice(0, cut);

    const cmdM = /\bfor\s+(all|update|select|insert|delete)\b/i.exec(rest);
    const cmd = cmdM ? cmdM[1].toLowerCase() : 'all';        // no FOR clause means FOR ALL
    if (cmd !== 'all' && cmd !== 'delete') continue;         // only DELETE-capable policies destroy rows
    if (!/user_brand_ids|brand_members/i.test(rest)) continue; // owner-bound already

    memberDeletes++;
    const bare = h.name.replace(/^"|"$/g, '').toLowerCase();
    // The retiring file must name it in a DROP POLICY. Templated names keep their %1$s.
    if (!new RegExp(`drop\\s+policy\\s+if\\s+exists\\s+"${bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'i').test(dropped)) {
      fail(`policy "${bare}" (FOR ${cmd.toUpperCase()}, predicate admits brand MEMBERS) is never dropped by ` +
           `sql/${DELETE_FILE} — a member can still delete the owner's rows`);
    }
  }
  if (memberDeletes < 4) {
    fail(`only ${memberDeletes} member-scoped DELETE-capable policies found in sql/** ` +
         `(expected at least 4: the templated FOR ALL, ideas, notebook_notes, edit_signals) — the scanner is under-reporting`);
  } else {
    notes.push(`${memberDeletes} member-scoped DELETE-capable policies found in sql/**, all retired by ${DELETE_FILE}`);
  }

  // The replacement must be owner-bound, and must exist for all seven tables.
  const OWNER_PRED = /brand_id\s+in\s*\(\s*select\s+id\s+from\s+brands\s+where\s+user_id\s*=\s*auth\.uid\(\)\s*\)/i;
  for (const tbl of WIPE) {
    const templated = FOR_ALL_TBLS.includes(tbl);
    const re = new RegExp(
      `create\\s+policy\\s+"[^"]*"\\s+on\\s+(?:public\\s*\\.\\s*)?${templated ? '(?:%1\\$[sI]|' + tbl + ')' : tbl}\\b` +
      `[\\s\\S]{0,400}?for\\s+delete[\\s\\S]{0,400}?auth\\.uid`, 'i');
    if (!re.test(deleteSql)) {
      fail(`sql/${DELETE_FILE} creates no owner-bound DELETE policy for ${tbl} — ` +
           `the BRAND OWNER's "Start over" (app.html:14893) would silently clear nothing on that table`);
    }
  }
  if (!OWNER_PRED.test(deleteSql)) {
    fail(`sql/${DELETE_FILE}'s DELETE predicate is not "brand_id in (select id from brands where user_id = auth.uid())" — ` +
         `anything routed back through user_brand_ids() re-admits members`);
  }
  if (/for\s+delete[\s\S]{0,200}?user_brand_ids/i.test(deleteSql)) {
    fail(`sql/${DELETE_FILE} still writes a FOR DELETE policy in terms of user_brand_ids() — ` +
         `that function returns brands you merely BELONG to, which is the whole defect`);
  }

  // Members must keep read/insert/update on the four tables whose FOR ALL is being split.
  for (const cmd of ['select', 'insert', 'update']) {
    const re = new RegExp(`create\\s+policy\\s+"[^"]*"\\s+on\\s+(?:public\\s*\\.\\s*)?%1\\$[sI][\\s\\S]{0,200}?for\\s+${cmd}[\\s\\S]{0,200}?user_brand_ids`, 'i');
    if (!re.test(deleteSql)) {
      fail(`sql/${DELETE_FILE} drops the FOR ALL policy on ${FOR_ALL_TBLS.join(', ')} but creates no member-scoped ` +
           `FOR ${cmd.toUpperCase()} replacement — members would lose ${cmd} entirely, not just delete`);
    }
  }
  const loopTbls = /foreach\s+tbl\s+in\s+array\s+array\[([^\]]+)\]/i.exec(deleteSql);
  if (!loopTbls) fail(`sql/${DELETE_FILE} has no table loop — cannot confirm which tables it covers`);
  else for (const t of FOR_ALL_TBLS) {
    if (!new RegExp(`'${t}'`, 'i').test(loopTbls[1])) fail(`sql/${DELETE_FILE}'s loop omits ${t} — its FOR ALL policy survives`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 4 — house rules on both new files: idempotent, and ending in a read-only
// verify shaped so that an EMPTY RESULT means pass.
// ─────────────────────────────────────────────────────────────────────────────
for (const [name, body] of [[REVOKE_FILE, revokeSql], [DELETE_FILE, deleteSql]]) {
  if (!body) continue;
  const raw = fs.readFileSync(path.join(sqlDir, name), 'utf8');
  if (!/EMPTY RESULT/i.test(raw)) {
    fail(`sql/${name} does not state what an empty result proves — every SQL file here ends with a verify that says so`);
  }
  // String literals are blanked first: the verify itself SAYS the words "revoke" and
  // "grant" inside its detail strings, and a positional scan that counted those would
  // conclude the file ends with a mutation.
  // v660: strip -- line comments BEFORE blanking string literals. A lone apostrophe in an
  // English comment ("PostgreSQL's default grant") makes the literal-blanking regex pair the
  // wrong quotes, which shifts every offset after it and reports a read-only verify as a
  // mutation. The gate then fails on prose rather than on SQL, which teaches people to ignore it.
  const scan = body.toLowerCase()
    .replace(/--[^\n]*/g, m => ' '.repeat(m.length))
    .replace(/'[^']*'/g, m => ' '.repeat(m.length));
  const lastSelect = scan.lastIndexOf('select');
  const lastDdl = Math.max(
    scan.lastIndexOf('create policy'),
    scan.lastIndexOf('do $'),
    scan.lastIndexOf('grant '),
    scan.lastIndexOf('revoke ')
  );
  if (lastSelect < lastDdl) {
    fail(`sql/${name} does not END with a read-only verify query — the last statement mutates`);
  }
  const tail = scan.slice(lastSelect);
  if (/\b(insert|update|delete|drop|alter|grant|revoke|create)\b/i.test(tail.replace(/'[^']*'/g, ''))) {
    fail(`sql/${name}'s trailing verify is not read-only — it contains a mutating keyword`);
  }
  if (!/if\s+exists|to_regclass|or\s+replace|pg_proc|pg_roles/i.test(body)) {
    fail(`sql/${name} has no existence guards — it is not safe to run twice`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
if (fails.length) {
  for (const f of fails) console.error(`FAIL: ${f}`);
  process.exit(1);
}
for (const n of notes) console.log(n);
console.log('invite forwarding, security_health lockdown and owner-only delete verification passed');
