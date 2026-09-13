// The SW ships an update only when sw.js differs. Prove the stamp is a real content hash of
// app.html: it must CHANGE when app.html changes and RESTORE when the change is reverted.
// Tested against a positive control rather than trusting that the mechanism exists.
//
// v637: every failure now THROWS instead of calling process.exit() inside the try. process.exit
// does not run finally blocks, so a failing run used to leave its own positive-control comment
// appended to app.html — the gate corrupted the file it was testing, and the next stamp baked the
// corrupted hash in. Found by mutation-testing this very gate.
//
// v656, two more self-inflicted defects in the api half of this gate:
//   1. the probe file was a FIXED name, api/_build_probe_tmp.js — and that exact file had been
//      COMMITTED to git with byte-identical content. "Add an api file" was therefore a no-op: the
//      api hash could not move, so the gate was permanently RED for a reason that had nothing to
//      do with the code under test. Worse, its cleanup `fs.unlinkSync(probe)` then DELETED a
//      tracked file from the working tree. The probe name is now randomised per run and the gate
//      refuses to start if anything matching it already exists, so it can never collide again.
//   2. a red run left api/_build.js holding the probe's stamp. This gate is a READ-ONLY oracle;
//      it must leave app.html, sw.js and api/_build.js byte-identical to how it found them, on
//      success AND on failure. It now snapshots all three up front and restores them in finally.
// The app.html restore is also concurrency-guarded: if app.html changed underneath this run
// (another process editing it), the gate reports that and does NOT overwrite the other change.
import fs from 'fs'; import path from 'path'; import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const app = path.join(root, 'app.html'), sw = path.join(root, 'sw.js'), bf = path.join(root, 'api', '_build.js');
const stamp = () => (fs.readFileSync(sw, 'utf8').match(/BUILD = '([^']+)'/) || [])[1];
const backendStamp = () => (fs.readFileSync(bf, 'utf8').match(/'([^']+)'/) || [])[1];
const run = () => execFileSync(process.execPath, [path.join(root, 'scripts', 'stamp-build.js')], { stdio: 'pipe' });
const fail = m => { throw new Error(m); };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

// ── snapshot every file this gate is allowed to touch, BEFORE touching anything ──
const orig = fs.readFileSync(app);
const origSw = fs.readFileSync(sw);
const origBf = fs.existsSync(bf) ? fs.readFileSync(bf) : null;
let lastWrittenByUs = orig;          // concurrency guard for app.html
const writeApp = buf => { fs.writeFileSync(app, buf); lastWrittenByUs = buf; };

// A uniquely named probe. A committed file can never collide with it, and a crashed earlier run
// leaves a name this run will not reuse (the stale-probe check below still catches it).
const probeName = `_build_probe_${crypto.randomBytes(8).toString('hex')}.tmp.js`;
const probe = path.join(root, 'api', probeName);

try {
  // The defect that made this gate red: a probe file living in api/ permanently.
  const stale = fs.readdirSync(path.join(root, 'api')).filter(f => /^_build_probe/.test(f));
  if (stale.length) {
    fail(`api/ contains ${stale.join(', ')} — a build-stamp probe file must never persist between ` +
         `runs (and must never be committed: a probe with fixed content makes "add an api file" a ` +
         `no-op, so the api hash cannot move and this gate can never pass). Delete it.`);
  }

  run(); const before = stamp();
  if (!/^v\d+-[0-9a-f]{8}$/.test(before || '')) fail(`stamp is not <version>-<hash8>: ${before}`);
  writeApp(Buffer.concat([orig, Buffer.from('\n<!--unlazy-control-->')]));   // positive control
  run(); const changed = stamp();
  if (changed === before) fail('stamp did NOT change after editing app.html — it is not a content hash');
  writeApp(orig);                                               // revert
  run(); const restored = stamp();
  if (restored !== before) fail(`stamp did not restore: ${before} -> ${restored}`);

  // The two stamps answer different questions and are deliberately NOT equal (v637).
  // sw.js BUILD = "does the phone need the new app?"        -> hash of app.html alone.
  // api/_build.js = "is the deployed BACKEND current?"      -> that, PLUS a hash of api/*.js.
  // Before v637 they were identical, which meant a backend-only deploy produced an identical
  // value and /api/health could not distinguish old backend code from new — the exact
  // "deployed but not live" blindness the stamp exists to remove, just moved to the server.
  // So the invariant is now: the backend stamp EXTENDS the frontend one.
  const backend = backendStamp();
  if (!backend.startsWith(restored + '+api.'))
    fail(`backend stamp ${backend} does not extend frontend stamp ${restored} (expected "${restored}+api.<hash>")`);
  if (!/\+api\.[0-9a-f]{8}$/.test(backend))
    fail(`backend stamp ${backend} has no api content hash — a backend-only deploy would be unverifiable`);

  // Well-formed is not the same as working: a hardcoded 8-hex literal satisfies the shape above
  // while never moving. The app half of this gate already proves responsiveness by editing
  // app.html; do exactly the same for the api half, or the check can be passed by a frozen value.
  if (fs.existsSync(probe)) fail(`probe name ${probeName} already exists — refusing to overwrite a real file`);
  fs.writeFileSync(probe, `// temporary probe written by build-stamp.mjs (${probeName})\nmodule.exports = 1;\n`);
  let probed;
  try { run(); probed = backendStamp(); }
  finally { if (fs.existsSync(probe)) fs.unlinkSync(probe); run(); }
  if (probed === backend)
    fail(`backend stamp did NOT change when an api file was added (${backend}) — the api hash is ` +
         `not a content hash, so /api/health cannot prove the backend is current`);
  const backAfter = backendStamp();
  if (backAfter !== backend) fail(`backend stamp did not restore after the probe: ${backend} -> ${backAfter}`);

  // The probe must also be unpublishable: api/ is served, so a probe that ever survived a run
  // would be a live endpoint. .vercelignore must exclude the whole probe name shape.
  const vi = fs.readFileSync(path.join(root, '.vercelignore'), 'utf8');
  if (!/^\s*api\/_build_probe_\*/m.test(vi))
    fail('.vercelignore has no "api/_build_probe_*" rule — a probe file left behind by a crashed ' +
         'run would be uploaded and served as a live endpoint');

  // A correct stamp is worthless if a CDN pins the old sw.js: the whole update mechanism is "the
  // browser refetches /sw.js and sees different bytes". Caught live on the v613 deploy — the origin
  // served v613 but the edge served v606, so the fix was deployed and permanently invisible.
  // `no-cache` PERMITS a shared cache to store and serve it; only `no-store` forbids that outright.
  const vj = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  const swHdr = (vj.headers || []).find(h => h.source === '/sw.js');
  if (!swHdr) fail('vercel.json has no /sw.js header rule — the edge may cache the service worker');
  const cc = (swHdr.headers || []).find(k => k.key.toLowerCase() === 'cache-control');
  if (!cc || !/no-store/i.test(cc.value))
    fail(`/sw.js Cache-Control is "${cc ? cc.value : '(none)'}" — must contain no-store, or a CDN ` +
         `can serve a stale worker and no device ever gets the update`);

  console.log(`stamp ${before} changed to ${changed} on edit and restored; backend extends it as ${backend}`);
  console.log(`probe used: api/${probeName} (unique per run, removed)`);
  console.log('build stamp verification passed');
} catch (e) {
  console.error(e && e.message ? e.message : String(e));
  process.exitCode = 1;
} finally {
  // Runs on success AND failure. This gate must leave NOTHING changed either way.
  try { if (fs.existsSync(probe)) fs.unlinkSync(probe); } catch {}
  try {
    const now = fs.readFileSync(app);
    if (now.equals(lastWrittenByUs)) {
      if (!now.equals(orig)) fs.writeFileSync(app, orig);
    } else {
      console.error('WARNING: app.html changed underneath this run — NOT restoring it, so the other ' +
                    'change is not clobbered. sw.js / api/_build.js are still restored below.');
      process.exitCode = 1;
    }
  } catch (e) { console.error('WARNING: could not restore app.html — ' + e.message); process.exitCode = 1; }
  // sw.js and api/_build.js are written by scripts/stamp-build.js, which this gate ran up to five
  // times. Put both back byte-for-byte: a verification gate that edits the build stamp is how
  // api/_build.js got left holding a probe hash.
  try { if (!fs.readFileSync(sw).equals(origSw)) fs.writeFileSync(sw, origSw); } catch {}
  try { if (origBf && !fs.readFileSync(bf).equals(origBf)) fs.writeFileSync(bf, origBf); } catch {}
}
