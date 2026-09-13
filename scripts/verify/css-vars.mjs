// A var(--x) that is declared nowhere is invisible dead code: with a fallback it silently hardcodes
// that fallback (permanent light island in dark mode); without one the property does not apply at all.
import fs from 'fs'; import path from 'path';
const s = fs.readFileSync(path.join(process.cwd(), 'app.html'), 'utf8');
const declared = new Set([...s.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
const used = new Set([...s.matchAll(/var\((--[\w-]+)[,)]/g)].map(m => m[1]));
const missing = [...used].filter(v => !declared.has(v));
if (missing.length) { console.error('undeclared CSS vars still in use: ' + missing.join(', ')); process.exit(1); }
if (used.size < 10) { console.error('suspiciously few vars found — the scanner is not exercising anything'); process.exit(1); }
console.log(`${used.size} CSS custom properties used, all declared`);
console.log('css var verification passed');
