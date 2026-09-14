// Shared SQL-scanning helper for the verify gates. The SQL sibling of _srcscan.mjs,
// and it exists for the same reason: a bare regex over sql/*.sql matches the word
// inside a comment as happily as a real statement.
//
// That failure mode is NOT hypothetical here. sql/v657-ideas-dedupe.sql deliberately
// ships a `create unique index` that is COMMENTED OUT — it is correct but cannot be
// applied until app.html stops inserting over existing rows. A gate that greps for
// "create unique index" would read that held-back statement as applied and certify a
// pairing that does not exist. So: strip the comments first, then match.
//
// stripSqlComments() removes `-- to end of line` and `/* nested blocks */`, replacing
// them with spaces so offsets and line numbers survive.
//
// STRINGS ARE KEPT, unlike _srcscan's default. SQL in this repo generates SQL:
// sql/team-tables.sql:144 creates its FOR ALL policy through
// `EXECUTE format('CREATE POLICY ... FOR ALL USING (...)')` — the policy exists only
// as the contents of a string literal. Stripping string contents would make the single
// most important policy in the schema invisible to every gate. Strings are therefore
// tracked (so a `--` inside one is not mistaken for a comment, and a quote inside a
// comment is not mistaken for a string) but preserved.
//
// Dollar-quoted bodies ($$ … $$, $tag$ … $tag$) are tracked for the same reason.

export function stripSqlComments(src) {
  const n = src.length;
  let out = '';
  let i = 0;
  while (i < n) {
    const c = src[i];

    // -- line comment
    if (c === '-' && src[i + 1] === '-') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    // /* block comment */ — Postgres nests these, so count depth
    if (c === '/' && src[i + 1] === '*') {
      let depth = 0;
      while (i < n) {
        if (src[i] === '/' && src[i + 1] === '*') { depth++; out += '  '; i += 2; continue; }
        if (src[i] === '*' && src[i + 1] === '/') { depth--; out += '  '; i += 2; if (depth === 0) break; continue; }
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }
    // '…' string, '' is an escaped quote
    if (c === "'") {
      out += c; i++;
      while (i < n) {
        if (src[i] === "'" && src[i + 1] === "'") { out += "''"; i += 2; continue; }
        out += src[i];
        if (src[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }
    // "…" quoted identifier
    if (c === '"') {
      out += c; i++;
      while (i < n) { out += src[i]; if (src[i] === '"') { i++; break; } i++; }
      continue;
    }
    // $tag$ … $tag$
    const dq = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(src.slice(i, i + 40));
    if (dq) {
      const tag = dq[0];
      const end = src.indexOf(tag, i + tag.length);
      const stop = end === -1 ? n : end + tag.length;
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    out += c; i++;
  }
  return out;
}

// Prove the stripper on the exact cases that would otherwise silently under- or
// over-report. Every consumer calls this before trusting a result.
export function selfTest() {
  const cases = [
    ['line comment removed',
     "select 1; -- create unique index on ideas\nselect 2;",
     /select 1;/, /create unique index/],
    ['block comment removed',
     "a /* create unique index */ b",
     /a\s+b/, /create unique index/],
    ['nested block comment removed',
     "a /* x /* y */ z */ b",
     /a\s+b/, /[xyz]/],
    ['string CONTENTS kept',
     "execute format('CREATE POLICY p ON t FOR ALL USING (x)');",
     /CREATE POLICY p ON t FOR ALL USING/, null],
    ['-- inside a string is not a comment',
     "select 'a -- b', 2;",
     /'a -- b', 2;/, null],
    ['quote inside a comment does not open a string',
     "-- it's fine\nselect 3;",
     /select 3;/, /it's fine/],
    ['dollar-quoted body kept',
     "create function f() as $$ begin return 1; end $$;",
     /begin return 1; end/, null],
    ['-- inside a dollar-quoted body IS kept (it is part of the stored body)',
     "as $fn$ x -- y\n$fn$",
     /x -- y/, null],
    ['line numbers survive',
     "a\n-- comment\nb",
     /^a\n\s*\nb$/, null],
  ];
  for (const [label, src, must, mustNot] of cases) {
    const got = stripSqlComments(src);
    if (must && !must.test(got)) throw new Error(`_sqlscan self-test failed (${label}): ${JSON.stringify(got)}`);
    if (mustNot && mustNot.test(got)) throw new Error(`_sqlscan self-test failed (${label}, leaked): ${JSON.stringify(got)}`);
  }
  return true;
}
