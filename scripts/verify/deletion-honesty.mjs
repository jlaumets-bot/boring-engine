#!/usr/bin/env node
// GATE: /api/delete-account can never report success it did not achieve.
//
// WHY THIS EXISTS
//   The endpoint used to `.catch(()=>{})` every delete and then `return {ok:true}`
//   unconditionally. Worse, its `sb()` helper resolved on ANY HTTP status, so the
//   .catch() never fired — a 409 foreign-key violation on the auth.users delete left
//   the account alive while the UI said "Account deleted." (GDPR Art. 17.)
//
// HOW IT CHECKS
//   Behaviourally, not by grepping. It stubs Node's https layer, drives the REAL
//   exported handler through scripted upstream responses, and asserts on the status
//   code + JSON body the frontend would actually receive.
//
//   app.html deleteAccount() does:  if (!resp.ok || !data.ok) throw new Error(data.error)
//   so "honest" means: a failed delete MUST produce non-2xx AND ok!==true AND a
//   human-readable `error` string.
//
// RUN:    node scripts/verify/deletion-honesty.mjs
// EXPECT: prints "PASS" and exits 0. Any dishonest path exits 1 with the reason.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HANDLER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../api/delete-account.js');

process.env.SUPABASE_URL = 'https://stub.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'stub-service-key';

const USER_ID = 'user-1';
const https = require('node:https');
const realRequest = https.request;

// ── the stub transport ────────────────────────────────────────────────────────
// `route(method, path)` returns { status, body } or { socketError: true }.
let route = null;
let seen = [];

https.request = function stubRequest(options, cb) {
  const method = options.method;
  const p = options.path;
  seen.push(method + ' ' + p);
  const outcome = route(method, p);
  const handlers = {};
  const req = {
    setTimeout: () => req,
    on: (ev, fn) => { handlers[ev] = fn; return req; },
    write: () => true,
    end: () => {
      setImmediate(() => {
        if (outcome && outcome.socketError) {
          if (handlers.error) handlers.error(new Error('socket hang up'));
          return;
        }
        const respHandlers = {};
        const resp = {
          statusCode: outcome.status,
          on: (ev, fn) => { respHandlers[ev] = fn; return resp; },
        };
        cb(resp);
        if (outcome.body && respHandlers.data) respHandlers.data(outcome.body);
        if (respHandlers.end) respHandlers.end();
      });
    },
  };
  return req;
};

// ── a happy-path router, with per-scenario overrides ──────────────────────────
function baseRoute(method, p) {
  if (p === '/auth/v1/user') return { status: 200, body: JSON.stringify({ id: USER_ID, email: 'x@y.z' }) };
  if (method === 'GET' && p.startsWith('/rest/v1/brands?')) return { status: 200, body: JSON.stringify([{ id: 'brand-1' }]) };
  if (method === 'GET' && p.startsWith('/rest/v1/user_plans?')) return { status: 200, body: '[]' };
  if (method === 'DELETE' && p.startsWith('/rest/v1/')) return { status: 204, body: '' };
  if (method === 'DELETE' && p.startsWith('/auth/v1/admin/users/')) return { status: 200, body: '{}' };
  return { status: 500, body: JSON.stringify({ msg: 'unrouted: ' + method + ' ' + p }) };
}

function makeRes() {
  const out = { status: null, body: null, ended: false };
  const res = {
    setHeader: () => res,
    status(c) { out.status = c; return res; },
    json(b) { out.body = b; out.ended = true; return res; },
    end() { out.ended = true; return res; },
  };
  return { res, out };
}

async function run(override) {
  delete require.cache[require.resolve(HANDLER)];
  const handler = require(HANDLER);
  route = (m, p) => override(m, p) ?? baseRoute(m, p);
  seen = [];
  const { res, out } = makeRes();
  await handler({ method: 'POST', headers: { authorization: 'Bearer tok', origin: 'https://contentshrimp.com' } }, res);
  return { ...out, seen };
}

// ── assertions ────────────────────────────────────────────────────────────────
const fails = [];
const check = (name, cond, detail) => { if (!cond) fails.push(name + (detail ? ' — ' + detail : '')); };

// The exact predicate app.html applies. If this is true, the user is told
// "Account deleted." and is signed out.
const uiSaysDeleted = r => r.status >= 200 && r.status < 300 && r.body && r.body.ok === true;
const usableError = r => typeof (r.body && r.body.error) === 'string' && r.body.error.trim().length > 10;

const scenarios = [
  {
    name: 'auth-user delete fails (FK violation) must NOT report success',
    override: (m, p) => (m === 'DELETE' && p.startsWith('/auth/v1/admin/users/'))
      ? { status: 500, body: JSON.stringify({ error_code: 'unexpected_failure', msg: 'Database error deleting user' }) } : null,
    assert: r => {
      check('auth-fail: reported success', !uiSaysDeleted(r), 'status=' + r.status + ' ok=' + (r.body && r.body.ok));
      check('auth-fail: no usable error message', usableError(r));
      check('auth-fail: not flagged partial', r.body && r.body.partial === true, 'data was destroyed, so this must be distinct from a total failure');
      check('auth-fail: no stage for the caller', r.body && r.body.stage === 'auth_user');
    },
  },
  {
    name: 'auth-user delete dies at the socket must NOT report success',
    override: (m, p) => (m === 'DELETE' && p.startsWith('/auth/v1/admin/users/')) ? { socketError: true } : null,
    assert: r => {
      check('socket-fail: reported success', !uiSaysDeleted(r), 'status=' + r.status);
      check('socket-fail: no usable error message', usableError(r));
    },
  },
  {
    name: 'brands delete fails must NOT report success and must NOT delete the login',
    override: (m, p) => (m === 'DELETE' && p.startsWith('/rest/v1/brands?'))
      ? { status: 409, body: JSON.stringify({ code: '23503', message: 'violates foreign key constraint' }) } : null,
    assert: r => {
      check('brands-fail: reported success', !uiSaysDeleted(r), 'status=' + r.status);
      check('brands-fail: no usable error message', usableError(r));
      check('brands-fail: deleted the login anyway',
        !r.seen.some(s => s.includes('/auth/v1/admin/users/')),
        'data survived, so removing the login would strand it with no owner');
    },
  },
  {
    name: 'unreadable brand list must NOT report success (nothing deleted blind)',
    override: (m, p) => (m === 'GET' && p.startsWith('/rest/v1/brands?')) ? { status: 503, body: '' } : null,
    assert: r => {
      check('list-fail: reported success', !uiSaysDeleted(r), 'status=' + r.status);
      check('list-fail: ran destructive deletes anyway',
        !r.seen.some(s => s.startsWith('DELETE ')),
        'it must not delete when it cannot enumerate what to delete');
    },
  },
  {
    name: 'a per-table failure must NOT be swallowed into a clean success',
    override: (m, p) => (m === 'DELETE' && p.startsWith('/rest/v1/ideas?'))
      ? { status: 403, body: JSON.stringify({ message: 'permission denied' }) } : null,
    assert: r => {
      check('table-fail: not surfaced', r.body && Array.isArray(r.body.incomplete) && r.body.incomplete.length > 0,
        'the account did get deleted, but the failed table must still be reported');
    },
  },
  {
    name: 'a table that does not exist (404) must NOT block deletion',
    override: (m, p) => (m === 'DELETE' && p.startsWith('/rest/v1/dfy_requests?'))
      ? { status: 404, body: JSON.stringify({ code: 'PGRST205', message: 'Could not find the table' }) } : null,
    assert: r => {
      check('missing-table: blocked a valid deletion', uiSaysDeleted(r), 'status=' + r.status);
      check('missing-table: not recorded as skipped', r.body && Array.isArray(r.body.skipped) && r.body.skipped.includes('dfy_requests'));
    },
  },
  {
    // Control. Without this the oracle could "pass" by rejecting everything.
    name: 'CONTROL: everything succeeds must report success',
    override: () => null,
    assert: r => {
      check('happy-path: did NOT report success', uiSaysDeleted(r), 'status=' + r.status + ' body=' + JSON.stringify(r.body));
      check('happy-path: never deleted the login', r.seen.some(s => s.includes('/auth/v1/admin/users/')));
      check('happy-path: never deleted the brands', r.seen.some(s => s.startsWith('DELETE /rest/v1/brands?')));
    },
  },
];

try {
  for (const s of scenarios) {
    const r = await run(s.override);
    if (r.status == null) { fails.push(s.name + ' — handler never answered'); continue; }
    s.assert(r);
  }
} finally {
  https.request = realRequest;
}

if (fails.length) {
  console.error('FAIL — /api/delete-account can report a success it did not achieve:');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('PASS — delete-account checks every delete status and only reports ok:true when the account is actually gone (' + scenarios.length + ' scenarios).');
