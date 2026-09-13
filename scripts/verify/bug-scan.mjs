// Scanners for the bug CLASSES that have actually cost this project time (see CLAUDE.md).
// Each prints findings. Exit 1 if any class has findings, so it can be a gate.
import fs from 'fs'; import path from 'path';
const root = process.cwd();
const app = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
const findings = [];
const add = (cls, items) => { if (items.length) findings.push([cls, items]); };

// 1. DEAD HANDLERS — an inline onclick naming a function that does not exist.
const defined = new Set([...app.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
[...app.matchAll(/\b(?:window\.)?([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/g)].forEach(m => defined.add(m[1]));
const builtins = new Set(['event','this','window','document','console','setTimeout','JSON','Math','Object','Array','String','Number','alert','confirm','location','navigator','preventDefault','stopPropagation','getElementById','querySelector','close','open','focus','blur','reload','click','remove','push','forEach','map','filter']);
const called = new Set([...app.matchAll(/on(?:click|change|input|submit|toggle)="\s*([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]));
add('DEAD onclick handlers', [...called].filter(f => !defined.has(f) && !builtins.has(f)));

// 2. UNDEFINED CSS VAR with a fallback — silently hardcodes the fallback and can never theme.
//    This is what made the header brand pill a permanent white island in dark mode.
const declared = new Set([...app.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
const usedWithFallback = [...app.matchAll(/var\((--[\w-]+)\s*,\s*[^)]+\)/g)].map(m => m[1]);
add('var(--x, fallback) where --x is never declared', [...new Set(usedWithFallback.filter(v => !declared.has(v)))]);

// 3. INLINE hardcoded light backgrounds inside JS template literals — beat every stylesheet rule,
//    so they cannot be fixed by a dark-mode override. Two of these were found by hand today.
add('inline hardcoded light background in markup/JS', [...app.matchAll(/style="[^"]*background:\s*(#fff\b|#ffffff\b|white)[^"]*"/gi)].map(m => m[0].slice(0, 90)));

// 4. UNGUARDED JSON.parse — a corrupted stored value takes out the whole screen.
const lines = app.split('\n');
add('JSON.parse with no try/catch nearby', lines.map((l, i) => ({ l, i }))
  .filter(({ l, i }) => /JSON\.parse\(/.test(l) && !/try\s*\{/.test(lines.slice(Math.max(0,i-3), i+1).join(' ')))
  .map(({ i, l }) => `L${i+1}: ${l.trim().slice(0, 80)}`));

// 5. BRAND BLEED — per-brand cache written with a bare localStorage call instead of lsGet/lsSet,
//    which namespaces by brand. This leaked one brand's blog/questions into another (v385).
add('bare localStorage write bypassing lsSet (brand-bleed risk)',
  [...app.matchAll(/localStorage\.setItem\(\s*['"`]([\w-]+)['"`]/g)].map(m => m[1])
    .filter(k => !/^(cs_last_brand|bn-dark-mode|_ls_ns_migrated|tp_|mascot_|blog_started|home-brain-open|boring_pro_tools_open|tp_primer_v2|trend_window_hours)/.test(k)));

// 6. UNAUTHENTICATED endpoints — any api route that never calls guard/_requireUser/CRON_SECRET.
const skip = new Set(['health.js','push-key.js','blog-index.js','blog-post.js','sitemap-blog.js','_build.js']);
add('api endpoint with no auth or cron guard', fs.readdirSync(path.join(root,'api')).filter(f => f.endsWith('.js') && !f.startsWith('_') && !skip.has(f))
  .filter(f => { const s = fs.readFileSync(path.join(root,'api',f),'utf8');
    return !/guard\(|_requireUser|requireUser|CRON_SECRET|getUser\(/.test(s); }));

// 7. TEMPLATE-LITERAL REGEX with single backslashes in the harness taps — the escape is eaten on
//    evaluation, so the regex either throws or silently matches the wrong thing (cost 3 runs).
const harness = fs.readFileSync(path.join(root,'mobile-user.js'),'utf8');
add('single-backslash regex inside a taps template literal',
  [...harness.matchAll(/taps:\s*\[[\s\S]{0,4000}?\]/g)].flatMap(m =>
    [...m[0].matchAll(/(?<!\\)\\[sdwSDW(){}]/g)].map(x => `...${m[0].slice(Math.max(0,x.index-40), x.index+20).replace(/\n/g,' ')}...`)));

if (findings.length) {
  for (const [cls, items] of findings) { console.error(`\n■ ${cls} — ${items.length}`); items.slice(0,12).forEach(i => console.error('   ' + i)); if (items.length>12) console.error(`   ...and ${items.length-12} more`); }
  console.error(`\n${findings.length} bug class(es) with findings`);
  process.exit(1);
}
console.log('scanned 7 bug classes, no findings');
console.log('bug scan verification passed');
