// The SW ships an update only when sw.js differs. Prove the stamp is a real content hash of
// app.html: it must CHANGE when app.html changes and RESTORE when the change is reverted.
// Tested against a positive control rather than trusting that the mechanism exists.
//
// v637: every failure now THROWS instead of calling process.exit() inside the try. process.exit
// does not run finally blocks, so a failing run used to leave its own positive-control comment
// appended to app.html — the gate corrupted the file it was testing, and the next stamp baked the
// corrupted hash in. Found by mutation-testing this very gate.
import fs from 'fs'; import path from 'path'; import { execFileSync } from 'child_process';
const root = process.cwd(), app = path.join(root, 'app.html'), sw = path.join(root, 'sw.js'), bf = path.join(root, 'api', '_build.js');
const stamp = () => (fs.readFileSync(sw, 'utf8').match(/BUILD = '([^']+)'/) || [])[1];
const backendStamp = () => (fs.readFileSync(bf, 'utf8').match(/'([^']+)'/) || [])[1];
const run = () => execFileSync(process.execPath, [path.join(root,'scripts','stamp-build.js')], { stdio: 'pipe' });
const fail = m => { throw new Error(m); };
const orig = fs.readFileSync(app);
try {
  run(); const before = stamp();
  if (!/^v\d+-[0-9a-f]{8}$/.test(before || '')) fail(`stamp is not <version>-<hash8>: ${before}`);
  fs.appendFileSync(app, '\n<!--unlazy-control-->');           // positive control: a real edit
  run(); const changed = stamp();
  if (changed === before) fail('stamp did NOT change after editing app.html — it is not a content hash');
  fs.writeFileSync(app, orig);                                  // revert
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
  const probe = path.join(root, 'api', '_build_probe_tmp.js');
  fs.writeFileSync(probe, '// temporary probe written by build-stamp.mjs\nmodule.exports = 1;\n');
  let probed;
  try { run(); probed = backendStamp(); }
  finally { fs.unlinkSync(probe); run(); }
  if (probed === backend)
    fail(`backend stamp did NOT change when an api file was added (${backend}) — the api hash is ` +
         `not a content hash, so /api/health cannot prove the backend is current`);
  const backAfter = backendStamp();
  if (backAfter !== backend) fail(`backend stamp did not restore after the probe: ${backend} -> ${backAfter}`);

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
  console.log('build stamp verification passed');
} catch (e) {
  console.error(e && e.message ? e.message : String(e));
  process.exitCode = 1;
} finally {
  // Runs on success AND failure now, so a red gate can never leave app.html holding its probe.
  fs.writeFileSync(app, orig);
  try { run(); } catch {}
}
