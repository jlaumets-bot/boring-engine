#!/usr/bin/env node
// GATE: a write the database REFUSES is never reported as a success, and nothing is deleted before
//       its replacement is safely written.
//
// THE FACT EVERYTHING HERE TURNS ON
//   supabase-js does NOT throw on an HTTP error unless `throwOnError` is set, and a row-level
//   security refusal is not an error at all — PostgREST simply matches zero rows. So
//   `const { error } = await sb.from(t).update(...)` CANNOT SEE the one failure that matters.
//   The only way to know is `.select()` and count the rows that came back.
//
// WHAT WENT WRONG
//   1. `saveBrandToDB` was the one write in app.html checking only `error`. The brands UPDATE policy
//      stops matching the moment the owner removes you or the brand is deleted elsewhere — with the
//      tab open and the person still typing. `settings` is rebuilt FROM THE DATABASE on every load,
//      so the whole brand voice was on screen for an hour and gone on reload, having never been
//      saved and never said so. `_brandSaveOk` also stayed true, which keeps the lean generation
//      path on — so every post in between was written against the STALE row.
//   2. Sharpen / Viral rewrite delete the superseded row when a post is renamed, and that DELETE was
//      issued BEFORE the save that writes the replacement, never sequenced with it. A dropped
//      connection in between destroyed the post: old row gone, new row never written, and the
//      localStorage snapshot holds only status fields, no content.
//   3. `deleteBrand` deleted the `brands` row FIRST. Every child policy reads through that row, so
//      afterwards every child delete matched zero rows — and there is no ON DELETE CASCADE for these
//      tables (api/delete-account.js says so and gets the order right). The confirm promises "and
//      everything in it"; in fact all of it stayed in the database, unreachable by any account.
//   4. The ideas cleanup set `window._ideasCleanupSilentFail` and NOTHING read it. For a team member
//      the DELETE policy is owner-only, so the refusal is not a glitch — it is every single save.
//
// HOW IT CHECKS
//   Runs the real functions, lifted from app.html, against a fake supabase-js whose refusals behave
//   like RLS: resolve, no error, zero rows.
//
// RUN:    node scripts/verify/write-refusal-honesty.mjs
// EXPECT: prints "PASS" and exits 0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const fails = [];
const bad = m => fails.push(m);
const fn = n => { const s = html.indexOf('function ' + n + '('); if (s < 0) throw new Error(n + ' missing from app.html');
  const from = html.slice(Math.max(0, s - 6), s) === 'async ' ? s - 6 : s;
  return html.slice(from, html.indexOf('\n}', s) + 2); };

// ── 1. saveBrandToDB must not claim success on a refused UPDATE ─────────────────────────────
{
  // v681: the body moved into _saveBrandToDBInner when saveBrandToDB became a thin wrapper
  // that REPORTS the outcome (brand-brain-writes.mjs owns that rule). The checks below are
  // about the body, so read the body wherever it lives.
  const src = fn('_saveBrandToDBInner') || fn('saveBrandToDB');
  if (!/\.update\([\s\S]{0,80}\)\.eq\([^)]*\)\.select\(/.test(src)) {
    bad('saveBrandToDB does not .select() its UPDATE, so an RLS refusal (resolves, no error, zero ' +
        'rows) is indistinguishable from a successful save. The entire brand voice is lost on the ' +
        'next reload with nothing ever said.');
  }
  // It must react to zero rows: not claim success, and not leave the lean path armed.
  const zeroRowBranch = /!_wrote \|\| !_wrote\.length|_wrote && _wrote\.length|\(data \|\| \[\]\)\.length/.test(src);
  if (!zeroRowBranch) bad('saveBrandToDB never tests how many rows the UPDATE actually matched.');
  const i = src.search(/!_wrote \|\| !_wrote\.length/);
  if (i > 0) {
    // Cut the branch at its own `return;`. A first version took a flat 900 chars, which ran past the
    // end and swallowed the `if (error)` block below — that block ALSO clears _brandSaveOk, so
    // deleting the line from the refusal branch escaped the check entirely.
    const rest = src.slice(i);
    const end = rest.indexOf('\n      }');
    const branch = end > 0 ? rest.slice(0, end) : rest.slice(0, 900);
    if (!/_brandSaveOk\s*=\s*false/.test(branch)) {
      bad('on a refused brand save `_brandSaveOk` is not cleared, so the lean path stays on and ' +
          'every generation is served from the stale brand row while the screen shows the new one.');
    }
    // Not `/showToast/` — that is a PRESENCE check, and one passed a mutation that replaced the
    // guard with `if (false) showToast(...)` while leaving the name in place. FIFTH time that shape
    // has escaped in this project. Require the call to be reachable.
    if (!/if \(typeof showToast === 'function'\) showToast\(/.test(branch)) {
      bad('a refused brand save tells the person nothing (no reachable showToast in the branch).');
    }
    if (!/return/.test(branch)) bad('a refused brand save falls through to the success path.');
  }
}

// ── 2. the superseded row is dropped only AFTER the replacement is written ──────────────────
{
  if (/_dropRenamedIdeaRow\(_titleBefore[\s\S]{0,120}saveIdeasToDB\(\)/.test(html)) {
    bad('a call site still deletes the renamed post\'s old row BEFORE saving the new one. A dropped ' +
        'connection in between destroys the post outright — and the localStorage snapshot holds no ' +
        'content, so nothing can bring it back.');
  }
  const src = fn('_saveThenDropRenamedRow');
  if (!src) bad('_saveThenDropRenamedRow is gone.');
  else {
    // Execute it: the drop must not fire until the save resolves, and must not fire at all on failure.
    const order = [];
    const run = (saveResult) => {
      // v679: the function now pins currentBrand at queue time (brand-isolation-and-first-run.mjs
      // owns that rule), so the harness has to supply it or the body throws before the save.
      const api = new Function('saveIdeasToDB', '_dropRenamedIdeaRow', 'console', 'Promise', 'currentBrand',
        src + '\nreturn _saveThenDropRenamedRow;')(
        () => { order.push('save'); return Promise.resolve(saveResult); },
        (o, n, pinned) => { order.push('drop' + (pinned ? ':pinned' : ':UNPINNED')); return Promise.resolve(); },
        { error() {}, log() {} }, Promise, { id: 'BRAND-A' });
      api('old', 'new');
      return new Promise(r => setTimeout(() => r(order.slice()), 10));
    };
    const ok = await run({ ok: true });
    if (ok.join(',') !== 'save,drop:pinned') bad('the old row is not dropped strictly after the save, with the brand pinned: ' + ok.join(','));
    order.length = 0;
    const refused = await run({ ok: false });
    if (refused.includes('drop')) {
      bad('a REFUSED save still drops the old row, which is the destroy-both case: ' + refused.join(','));
    }
  }
}
{
  // ── 3. deleteBrand sweeps the children BEFORE the parent ──────────────────────────────────
  const del = fn('deleteBrand');
  const childSweep = del.search(/for \(const t of tables\)/);
  const parentDel = del.search(/from\('brands'\)\.delete\(\)/);
  if (childSweep < 0 || parentDel < 0) {
    bad('deleteBrand no longer has the shape this gate checks — re-point it.');
  } else if (childSweep > parentDel) {
    bad('deleteBrand deletes the `brands` row BEFORE sweeping its children. Every child policy reads ' +
        'through that row, so afterwards every child delete matches zero rows and there is no ON ' +
        'DELETE CASCADE — the ideas, notes, remixes and brand voice stay in the database forever, ' +
        'unreachable by any account, while the confirm promised "and everything in it".');
  }
  if (!/if \(leftover\)[\s\S]{0,200}throw/.test(del)) {
    bad('deleteBrand does not refuse to delete the parent when a child table could not be cleared, ' +
        'so a partial failure still strands the rest permanently.');
  }
  if (/may remain on the server/.test(del)) {
    bad('deleteBrand still warns that content may remain server-side. With children-first that is no ' +
        'longer true, and an untrue caveat is its own bug.');
  }

  // ── 4. a silently refused ideas cleanup must reach the person ─────────────────────────────
  const save = fn('_saveIdeasToDBNow');
  // Search from the ASSIGNMENT forward, with a generous window — the explaining comment above it is
  // itself ~700 chars, and a first version of this check used a 900-char window and failed on its
  // own documentation rather than on the code.
  const i = save.lastIndexOf('_ideasCleanupSilentFail = true');
  if (i < 0) bad('_saveIdeasToDBNow no longer detects a silent cleanup refusal at all.');
  else if (!/showToast/.test(save.slice(i, i + 1400))) {
    bad('the ideas cleanup detects a silent RLS refusal and tells the person nothing — the flag it ' +
        'sets is read nowhere. For a team member the DELETE policy is owner-only, so this is not a ' +
        'glitch, it is every save, and the table grows until the read cap truncates the library.');
  }
  // The guard must GATE the toast, not merely be mentioned. A presence check on the name passed a
  // mutation that replaced the condition with `if (false)` and left the assignment in place — the
  // fourth time that shape has escaped in this project.
  if (!/if \(!window\._ideasDupWarned\)/.test(save)) {
    bad('the duplicate warning has no once-per-session guard gating it, so it would fire on every ' +
        'approve and train the person to ignore it — or has been disabled outright.');
  }

  if (fails.length) {
    console.error('FAIL:');
    fails.forEach(f => console.error('  - ' + f));
    process.exit(1);
  }
  console.log('write-refusal honesty verified: a refused brand save is reported and disarms the lean ' +
              'path, the superseded row is dropped only after the replacement is written, deleteBrand ' +
              'clears children before the parent, and a silently refused cleanup reaches the person.');
  console.log('PASS');
}
