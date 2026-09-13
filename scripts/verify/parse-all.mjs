// Every JS the app ships must parse: app.html's inline <script> blocks, every api/*.js, sw.js, harness.
import fs from 'fs'; import path from 'path'; import os from 'os';
import { execFileSync } from 'child_process';
const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-'));
let checked = 0; const bad = [];
const html = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (blocks.length !== 5) { console.error(`expected 5 inline script blocks, found ${blocks.length}`); process.exit(1); }
blocks.forEach((b, i) => { const f = path.join(tmp, `inline${i}.js`); fs.writeFileSync(f, b);
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); checked++; } catch { bad.push(`app.html inline #${i}`); } });
for (const rel of [...fs.readdirSync(path.join(root,'api')).filter(f=>f.endsWith('.js')).map(f=>`api/${f}`), 'sw.js', 'mobile-user.js']) {
  try { execFileSync(process.execPath, ['--check', path.join(root, rel)], { stdio: 'pipe' }); checked++; } catch { bad.push(rel); } }
if (bad.length) { console.error('PARSE FAILURES: ' + bad.join(', ')); process.exit(1); }

// vercel.json must not point at files that no longer exist. Vercel HARD-FAILS the deploy with
// "The pattern <x> defined in `functions` doesn't match any Serverless Functions" — so a deleted
// endpoint whose config entry was left behind blocks every future deploy until someone notices.
// This actually happened on 2026-08-27: api/cs-blog-cron.js was deleted with the blog feature and
// its functions entry stayed, breaking the deploy. Cheap to check, expensive to hit.
{
  const v = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  const missingFn = Object.keys(v.functions || {}).filter(k => !fs.existsSync(path.join(root, k)));
  const missingCron = (v.crons || [])
    .map(c => 'api' + String(c.path).replace(/^\/api/, '') + '.js')
    .filter(f => !fs.existsSync(path.join(root, f)));
  const missingRw = (v.rewrites || [])
    .map(r => r.destination).filter(d => typeof d === 'string' && d.startsWith('/api/'))
    .map(d => d.slice(1) + '.js').filter(f => !fs.existsSync(path.join(root, f)));
  const cfg = [
    ...missingFn.map(f => `functions entry "${f}" — Vercel will REJECT the deploy`),
    ...missingCron.map(f => `cron points at missing ${f}`),
    ...missingRw.map(f => `rewrite points at missing ${f}`),
  ];
  if (cfg.length) { console.error('vercel.json references files that do not exist:\n  - ' + cfg.join('\n  - ')); process.exit(1); }
}
console.log(`parsed ${checked} files/blocks with no errors`);
console.log('parse verification passed');
