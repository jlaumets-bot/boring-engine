// ON-SCREEN TEXT was consumed by nothing, so it was removed from the schema, the display block and
// both copy-alls — but the load/normalise paths MUST remain or every idea already saved breaks.
import fs from 'fs'; import path from 'path';
const root = process.cwd();
const app = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
const gen = fs.readFileSync(path.join(root, 'api', 'generate-ideas.js'), 'utf8');
const err = [];
if (/detail-label">On-Screen Text/.test(app)) err.push('display block still present in app.html');
if (app.includes('ON-SCREEN TEXT:\\n${i.screen}')) err.push('copy-all still emits ON-SCREEN TEXT');
if (app.includes('ON-SCREEN:\\n${i.screen}')) err.push('copy-all still emits ON-SCREEN');
if (gen.includes('"screen": "On-screen text overlays"')) err.push('screen still requested in the JSON schema');
if (/screen:\s*idea\.screen\s*\|\|/.test(gen)) err.push('screen still emitted by the output cleaner');
// load paths must SURVIVE so existing ideas still open
if (!app.includes('screen: asText(idea.screen)')) err.push('REGRESSION: normalise path removed — old ideas would break');
if (!app.includes('screen: row.screen')) err.push('REGRESSION: DB row map removed — old ideas would break');
if (err.length) { console.error(err.join('\n')); process.exit(1); }
console.log('generation + display + copy paths clean; both load paths intact');
console.log('onscreen removal verification passed');
