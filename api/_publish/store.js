// Supabase access for the distribution layer (service-role; bypasses RLS).
// Mirrors the request style already used in api/delete-account.js / send-daily.js.
const https = require('https');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

// A STALL IS NOT AN ERROR. Every caller of _req below already handles a rejection —
// _requireUser catches it and returns null (401), _brandctx catches it, and every handler
// calls getUser/userCanAccessBrand/rest inside a try. None of that helps if the request
// never settles: with no timeout, a Supabase that accepts the socket and then goes quiet
// leaves getUser (i.e. auth on nearly every endpoint) waiting until the platform kills the
// function — no status, no body, no log line. This timeout turns that silence back into the
// ordinary rejection those catches were written for.
//
// WHY 8s, and why it is a DEFAULT rather than a fixed value: this timeout is SHARED while the
// budget is PER-ENDPOINT, so the value is only safe if it fits the tightest endpoint that can
// reach it. Do not change it by hand — scripts/verify/timeout-budgets.mjs computes that floor
// from vercel.json and fails if the default no longer fits. It has to, because the floor has
// been worked out by hand four times and missed twice.
//
// It was 4s, set by five endpoints (checkout-confirm, create-checkout, create-portal-session,
// stripe-webhook, usage) that reached Supabase while ABSENT from the functions map, so they ran
// on Vercel's ~10s platform default. Production then showed 4s cutting off work that had far
// more room: both crons (maxDuration 300) lost calls to it, and — the one a user actually felt —
// brand-voice-chat (maxDuration 90) had its `GET /auth/v1/user` cut at 4s, so someone asking the
// coach a question just got an error. v637 declared those five at 30s, which lifted the floor to
// 20s (health.js) and let this double. request.setTimeout is a socket INACTIVITY timer, so a
// slow-but-streaming response never trips it; 8s of total silence against a healthy ~100-300ms
// PostgREST round trip is only ever a stall.
//
// Callers with real headroom (the crons) raise it further for themselves via setRequestBudget().
let REQ_TIMEOUT_MS = 8000;

// Called once at the top of a handler that has real headroom (a cron). Module state in a Vercel
// function is per-function-instance — store.js inside send-daily's container is not the copy
// inside stripe-webhook's — so this cannot leak across endpoints. Clamped so a typo can never
// reintroduce the unbounded hang this timeout exists to prevent.
function setRequestBudget(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return REQ_TIMEOUT_MS;
  REQ_TIMEOUT_MS = Math.max(4000, Math.min(60000, Math.round(n)));
  return REQ_TIMEOUT_MS;
}

// Storage uploads get their own, larger budget: a multi-hundred-KB body to a different
// backend is a different workload from a PostgREST row read. NOTE: uploadPublic currently
// has NO callers — its only users were the publishing/rendering endpoints, which were
// removed. It is kept because store.js is required by 8 live modules and trimming an export
// buys nothing; wire a real budget check back in here if it is ever used again.
const UPLOAD_TIMEOUT_MS = 20000;

function _req(method, path, { body, token, headers, raw } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(SUPABASE_URL);
    const h = {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + (token || SERVICE_KEY),
      ...(raw ? {} : { 'Content-Type': 'application/json' }),
      ...(headers || {}),
    };
    if (method === 'DELETE') h.Prefer = 'return=minimal';
    const r = https.request({ hostname: u.hostname, path, method, headers: h }, resp => {
      let d = '';
      resp.on('data', c => (d += c));
      resp.on('end', () => {
        let j = null;
        try { j = d ? JSON.parse(d) : null; } catch (_) {}
        resolve({ status: resp.statusCode, data: j, raw: d });
      });
    });
    r.on('error', reject);
    // Same shape as httpsPost in api/_llm.js — destroy(err) makes the request emit 'error',
    // which the reject above already handles. Logged because a stall is otherwise invisible.
    r.setTimeout(REQ_TIMEOUT_MS, () => {
      console.error('store._req TIMEOUT after ' + REQ_TIMEOUT_MS + 'ms — ' + method + ' ' + path +
        ' (Supabase accepted the connection then went quiet)');
      r.destroy(new Error('Supabase request timed out after ' + REQ_TIMEOUT_MS + 'ms: ' + method + ' ' + path));
    });
    if (body) r.write(raw ? body : (typeof body === 'string' ? body : JSON.stringify(body)));
    r.end();
  });
}

// Auth: verify the caller's access token -> user object (so a user only touches their own brands).
async function getUser(token) {
  if (!token) return null;
  const r = await _req('GET', '/auth/v1/user', { token });
  if (r.status !== 200 || !r.data) return null;
  return r.data.id ? r.data : (r.data.user || null);
}

// NOTE FOR CALLERS: this is ACCESS, not OWNERSHIP — it returns true for a brand MEMBER as
// well as the owner. Anything that must be owner-only (e.g. writing brands.gemini_key_enc,
// which the database trigger in sql/security-fixes-batch2.sql guards against clients but
// deliberately exempts the service role from) has to compare brands.user_id itself.
async function userCanAccessBrand(userId, brandId) {
  if (!userId || !brandId) return false;
  // Both ids encoded. api/_usage.js and api/_brandctx.js already follow this convention
  // ("every value interpolated into a PostgREST path is encodeURIComponent'd"); this was the
  // only place left interpolating raw — and it was, of all functions, the one that MAKES the
  // access decision. No exploit was constructible (PostgREST ANDs repeated filters, so an
  // injected filter can only ever NARROW a result set, never widen it), so this is hardening,
  // not a closed hole. "The authorization query is the single unescaped one" is still not a
  // property worth keeping.
  const bid = encodeURIComponent(brandId);
  const uid = encodeURIComponent(userId);
  const owned = await _req('GET', `/rest/v1/brands?id=eq.${bid}&select=id,user_id`);
  const b = (owned.data || [])[0];
  if (b && b.user_id === userId) return true;
  const mem = await _req('GET', `/rest/v1/brand_members?brand_id=eq.${bid}&user_id=eq.${uid}&select=brand_id`);
  if (mem.data && mem.data.length) return true;
  /* v679 — "DENIED" AND "WE COULD NOT CHECK" WERE THE SAME ANSWER, AND ONE CALLER DELETES.
     _req RESOLVES on every HTTP status (it only rejects on a socket error), so a PostgREST 500,
     a 503 HTML error page or the 8s inactivity timeout all arrive here as `data: null` and left
     this function returning a flat `false` — indistinguishable from a real refusal. send-daily
     reads that false as "this user has no access to the brand they claim" and PERMANENTLY
     DELETES their push subscription with the service role. A brand OWNER, with the daily ping
     on, silently stops receiving it forever on one transient database blip, while the Settings
     toggle still reads ON (it is drawn from device-local storage). The only trace is a log line
     accusing them of a security anomaly.
     `false` now means denied. A check that could not run throws, so a caller has to decide. */
  const failed = (r) => !r || (r.status != null && (r.status < 200 || r.status >= 300));
  if (failed(owned) || failed(mem)) {
    const e = new Error('brand access check could not be completed (brands ' +
      ((owned && owned.status) || 'no response') + ', members ' + ((mem && mem.status) || 'no response') + ')');
    e.accessCheckFailed = true;
    throw e;
  }
  return false;
}

// Thin REST helpers (PostgREST)
function rest(method, path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (method === 'POST' || method === 'PATCH') headers.Prefer = headers.Prefer || 'return=representation';
  return _req(method, '/rest/v1' + path, { ...opts, headers });
}

// Upload a buffer to a PUBLIC Storage bucket; returns the public URL.
function uploadPublic(bucket, objectPath, buffer, contentType) {
  return new Promise((resolve, reject) => {
    const u = new URL(SUPABASE_URL);
    const r = https.request({
      hostname: u.hostname,
      path: `/storage/v1/object/${bucket}/${objectPath}`,
      method: 'POST',
      headers: {
        apikey: SERVICE_KEY,
        Authorization: 'Bearer ' + SERVICE_KEY,
        'Content-Type': contentType,
        'x-upsert': 'true',
        'Content-Length': buffer.length,
      },
    }, resp => {
      let d = '';
      resp.on('data', c => (d += c));
      resp.on('end', () => resolve({
        status: resp.statusCode,
        raw: d,
        publicUrl: `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${objectPath}`,
      }));
    });
    r.on('error', reject);
    // Third untimed https.request in this file — same hang, same fix. This one never
    // rejected on a bad upload either (it resolves on ANY status), so a rejection is new;
    // it is safe because all three call sites already `throw` on a non-2xx status from
    // inside a try, so a stall now lands in the exact catch a failed upload already used.
    r.setTimeout(UPLOAD_TIMEOUT_MS, () => {
      console.error('store.uploadPublic TIMEOUT after ' + UPLOAD_TIMEOUT_MS + 'ms — ' + bucket + '/' + objectPath +
        ' (Supabase Storage accepted the connection then went quiet)');
      r.destroy(new Error('Supabase Storage upload timed out after ' + UPLOAD_TIMEOUT_MS + 'ms: ' + bucket + '/' + objectPath));
    });
    r.write(buffer);
    r.end();
  });
}

// Cron liveness: upsert this job's last-success heartbeat. Best-effort — never
// let telemetry break a cron, so all errors are swallowed. Read by /api/health.
async function heartbeat(job, status = 'ok', detail = null) {
  try {
    return await rest('POST', '/job_heartbeats', {
      body: { job, last_success_at: new Date().toISOString(), last_status: status, detail },
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    });
  } catch (_) {
    return null;
  }
}

module.exports = { rest, getUser, userCanAccessBrand, uploadPublic, heartbeat, _req, setRequestBudget };
