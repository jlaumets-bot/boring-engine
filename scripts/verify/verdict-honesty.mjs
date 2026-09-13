// The critical-path headline must never blame the APP when the QA DRIVER dies. It produced exactly
// that false negative once ("APP DOES NOT WORK" while quick-post had generated a full post).
import fs from 'fs'; import path from 'path';
const s = fs.readFileSync(path.join(process.cwd(), 'mobile-user.js'), 'utf8');
const err = [];
if (!/let DRIVER_DEAD = null/.test(s)) err.push('DRIVER_DEAD flag missing');
if (!/used all available credits\|permission-denied\|quota/.test(s)) err.push('driver-death detection missing');
if (!/if \(DRIVER_DEAD\) break;/.test(s)) err.push('run does not stop when the driver dies');
if (!/status !== 'pass' && x\.r\.status !== 'unknown'/.test(s)) err.push('unknown results still counted as an app break');
if (!/RUN INVALID — COULD NOT JUDGE/.test(s)) err.push('invalid-run headline missing');
if (!/CHAIN ONLY PARTLY TESTED/.test(s)) err.push('partial-run headline missing (would falsely claim the chain works)');
if (!/const CRITICAL_PATH = \[/.test(s)) err.push('CRITICAL_PATH not defined');
if (err.length) { console.error(err.join('\n')); process.exit(1); }
console.log('driver-death short-circuits, unknown never counts as fail, partial runs are labelled');
console.log('verdict honesty verification passed');
