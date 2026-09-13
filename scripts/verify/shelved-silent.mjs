// Shelved features must generate no background noise: no cron may fire for them and no route serve them.
import fs from 'fs'; import path from 'path';
const v = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'vercel.json'), 'utf8'));
const dead = ['cs-blog-cron', 'auto-publish'];
const err = [];
for (const c of v.crons || []) for (const d of dead) if ((c.path || '').includes(d)) err.push(`cron still scheduled: ${c.path}`);
for (const r of v.rewrites || []) if (/blog/.test(JSON.stringify(r))) err.push(`blog route still served: ${r.source}`);
if (!(v.crons || []).length) err.push('no crons at all — the live ones were removed by mistake');
for (const want of ['send-daily', 'pull-trends-cron'])
  if (!(v.crons || []).some(c => (c.path || '').includes(want))) err.push(`REGRESSION: live cron ${want} is missing`);
if (err.length) { console.error(err.join('\n')); process.exit(1); }
console.log(`${v.crons.length} crons scheduled (send-daily, pull-trends-cron); no shelved crons or blog routes`);
console.log('shelved silence verification passed');
