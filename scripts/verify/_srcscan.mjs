// Shared source-scanning helper for the verify gates.
//
// WHY IT EXISTS: several gates used to decide "does this file call guard()?" / "is this
// endpoint authenticated?" with a bare regex over the raw file text. A bare regex matches
// the word inside a comment or inside a string just as happily as a real call, so a file
// whose only mention of `guard(` is the sentence "guard() only CHECKS the allowance" read
// as gated. That is a scanner that cannot fail. Strip the non-code first, then match.
//
// stripCode() removes, replacing them with same-length-ish whitespace so offsets stay usable:
//   • // line comments and /* block */ comments
//   • the CONTENTS of '…' "…" and `…` literals (the `${ }` holes are kept — they are code)
//   • the body of a /regex/ literal (so /"/g cannot open a phantom string)
// Newlines are preserved throughout so line numbers survive.
//
// Regex-vs-division is decided by the previous significant token, the standard heuristic.
// selfTest() proves the stripper on the exact cases that broke the naive version; every
// consumer calls it before trusting the result, so a broken stripper fails loudly instead
// of silently under-reporting.

const RE_ALLOWED_BEFORE = /[=(,:;[!&|?{}+\-*%~^<>]$/;
const KEYWORD_BEFORE = /\b(return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/;

export function stripCode(src, opts = {}) {
  const keepStrings = !!opts.keepStrings;
  const n = src.length;
  let out = '';
  let i = 0;
  const lastSig = () => {
    let j = out.length - 1;
    while (j >= 0 && /\s/.test(out[j])) j--;
    return j >= 0 ? out.slice(0, j + 1) : '';
  };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    // comments
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      for (; i < stop; i++) out += src[i] === '\n' ? '\n' : ' ';
      continue;
    }
    // regex literal
    if (c === '/') {
      const prev = lastSig();
      if (prev === '' || RE_ALLOWED_BEFORE.test(prev) || KEYWORD_BEFORE.test(prev)) {
        let j = i + 1, inClass = false, closed = false;
        for (; j < n; j++) {
          const ch = src[j];
          if (ch === '\\') { j++; continue; }
          if (ch === '\n') break;                 // unterminated -> it was division after all
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) { closed = true; break; }
        }
        if (closed) {
          out += '/';
          for (let k = i + 1; k < j; k++) out += ' ';
          out += '/';
          i = j + 1;
          while (i < n && /[a-z]/.test(src[i])) { out += src[i]; i++; }   // flags
          continue;
        }
      }
      out += c; i++; continue;
    }
    // string / template literal
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += q; i++;
      while (i < n) {
        const ch = src[i];
        if (ch === '\\') { out += keepStrings ? src.slice(i, i + 2) : '  '; i += 2; continue; }
        if (ch === q) { out += q; i++; break; }
        if (q === '`' && ch === '$' && src[i + 1] === '{') {
          // keep the interpolated expression: it is real code
          let depth = 1; out += '${'; i += 2;
          const start = i;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') { depth--; if (depth === 0) break; }
            i++;
          }
          out += stripCode(src.slice(start, i), opts) + '}';
          i++;
          continue;
        }
        if (q !== '`' && ch === '\n') { out += '\n'; i++; break; }  // unterminated single-line string
        out += keepStrings ? ch : (ch === '\n' ? '\n' : ' ');
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

// Prove the stripper before any gate trusts it. Throws with the failing case.
export function selfTest() {
  const cases = [
    // [input, must NOT contain after stripping, label]
    ["// guard(req, 'x')\nconst a = 1;", /guard\(/, 'line comment'],
    ['/* calls guard(req) */ const a = 1;', /guard\(/, 'block comment'],
    ["const s = 'guard(req)';", /guard\(/, 'single-quoted string'],
    ['const s = "CRON_SECRET";', /CRON_SECRET/, 'double-quoted string'],
    ['const s = `logUsage(x)`;', /logUsage\(/, 'template literal text'],
    ["const r = /\"/g; const t = 'guard(';", /guard\(/, 'regex holding a quote must not open a string'],
    ['const r = /[/]/; const t = "CRON_SECRET";', /CRON_SECRET/, 'regex with a slash char class'],
  ];
  for (const [input, mustNot, label] of cases) {
    const got = stripCode(input);
    if (mustNot.test(got)) throw new Error(`_srcscan self-test failed (${label}): ${JSON.stringify(got)}`);
  }
  const keep = [
    ["const _g = await require('./_usage').guard(req, 'viral');", /\.guard\(\s*req/, 'a real guard call survives'],
    ['if (_g.over) return;', /_g\.over/, 'a real .over check survives'],
    ['await logUsage({ userId: u });', /logUsage\(/, 'a real logUsage call survives'],
    ['const s = `x ${guard(req)} y`;', /guard\(\s*req/, 'code inside ${} survives'],
    ['const a = b / c; const d = e / f;', /b \/ c/, 'division is not eaten as a regex'],
  ];
  for (const [input, must, label] of keep) {
    const got = stripCode(input);
    if (!must.test(got)) throw new Error(`_srcscan self-test failed (${label}): ${JSON.stringify(got)}`);
  }
  return cases.length + keep.length;
}

// Comments removed, string/regex CONTENTS kept. Use this when the evidence you are looking for
// legitimately lives inside a string literal — a require() path, a header name, an env var name —
// but you still must not be fooled by a mention of it in a comment.
export function stripComments(src) { return stripCode(src, { keepStrings: true }); }
