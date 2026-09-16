-- ============================================================================
-- v658 — security_health() stops being callable by the public.
-- Run in the Supabase SQL editor. Changes PRIVILEGES only. No function body, no
-- policy and no row is touched. Safe to run twice. Safe on a live database.
--
-- ---------------------------------------------------------------------------
-- THE HOLE
-- ---------------------------------------------------------------------------
-- sql/health-check.sql:189 ends with
--     grant execute on function security_health() to service_role;
-- and there is no REVOKE anywhere in sql/ (grep confirms: the only other lines
-- matching /revoke/ are two prose comments in security-fixes-batch2.sql).
--
-- A GRANT does not narrow anything. PostgreSQL grants EXECUTE to PUBLIC by default
-- on CREATE FUNCTION, and in Supabase both `anon` and `authenticated` are members of
-- PUBLIC. So that line did not restrict security_health() to the backend — it merely
-- named service_role alongside everybody else. Any signed-in user, and (because the
-- anon key is shipped in app.html and is meant to be public) plausibly any anonymous
-- caller at all, can run
--     sb.rpc('security_health')
-- and get back the machine-readable audit: which tables have RLS off, which carry
-- permissive policies, which brand-scoped tables are not bound to the caller, and
-- whether the membership function is SECURITY DEFINER with a pinned search_path.
--
-- That is a map of where to attack, handed to the attacker. /api/health was
-- deliberately built to expose booleans only (api/health.js:126-139 reduces every
-- array to `length === 0` before adding a check) — the RPC behind it leaks exactly
-- the detail that endpoint withholds.
--
-- ---------------------------------------------------------------------------
-- EVERY OTHER FUNCTION IN sql/** — THE SAME OMISSION, AUDITED
-- ---------------------------------------------------------------------------
-- Not one function in sql/** has ever been REVOKEd from PUBLIC, so all of them carry
-- the default PUBLIC EXECUTE grant. Each was assessed on what that actually allows,
-- and each is given an explicit grant list here. Where a role is re-granted below,
-- its effective access is UNCHANGED — the grant simply stops being implicit.
--
--   security_health()            -> service_role ONLY.  The leak above.
--                                   Called by api/health.js:122 through store.rest(),
--                                   which authenticates with SUPABASE_SERVICE_ROLE_KEY
--                                   (api/_publish/store.js:6,131-132). Nothing in the
--                                   browser calls it.
--
--   user_brand_ids()             -> anon + authenticated + service_role.  MUST KEEP.
--                                   Every brand-scoped RLS policy in the schema calls
--                                   it (team-tables.sql:144, security-fixes-batch1.sql:14-34,
--                                   and the policies in v658-member-delete.sql). An RLS
--                                   policy expression is evaluated AS THE QUERYING ROLE
--                                   and EXECUTE *is* checked there, so revoking this from
--                                   `authenticated` without re-granting would take the
--                                   whole application down with "permission denied for
--                                   function user_brand_ids". It is re-granted in the same
--                                   statement that revokes PUBLIC. It leaks nothing on its
--                                   own: it returns the CALLER's own brand ids.
--
--   lookup_invite(text)          -> anon + authenticated + service_role.  MUST KEEP.
--                                   Deliberately reachable before sign-in so the invite
--                                   banner can say which brand you were invited to
--                                   (app.html:6684). Already granted explicitly at
--                                   security-fixes-batch1b.sql:33 and v634-hardening.sql:176.
--
--   redeem_invite(text)          -> authenticated + service_role.  MUST KEEP.
--                                   app.html:7263. Already granted explicitly at
--                                   v655-invite-email-check.sql:76. anon is NOT granted:
--                                   the function's first act is to reject a null auth.uid().
--
--   pin_brand_id()               -> nobody. Trigger functions.
--   brands_pin_ownership()          A trigger function called directly fails with
--                                   "trigger functions can only be called as triggers", so
--                                   PUBLIC EXECUTE here leaks nothing — but it is the same
--                                   omission and costs nothing to close. PostgreSQL checks
--                                   EXECUTE on a trigger function when the TRIGGER IS
--                                   CREATED, not each time it fires, so pin_brand_id_trg
--                                   (v657-brand-pinning.sql) and brands_pin_ownership
--                                   (security-fixes-batch2.sql) keep firing for every role
--                                   exactly as they do today.
--                                   If you would rather not touch these two, the undo is:
--                                     grant execute on function public.pin_brand_id() to public;
--                                     grant execute on function public.brands_pin_ownership() to public;
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS SAFE WITH USERS ON THE SITE
-- ---------------------------------------------------------------------------
-- * It is one statement (a DO block), so it is atomic: no caller can observe a moment
--   where PUBLIC has been revoked but anon/authenticated have not yet been re-granted.
-- * It never runs CREATE OR REPLACE, so a live function body that is newer than this
--   repo (see the warning in v657-brand-pinning.sql) cannot be reverted by it.
-- * Functions that do not exist in this database are skipped — the loop is driven off
--   pg_proc, so an overload or a missing function changes nothing.
-- * Roles that do not exist are skipped, so it also runs on a non-Supabase Postgres.
-- * The function OWNER keeps EXECUTE regardless (REVOKE … FROM PUBLIC does not touch
--   the owner's own privileges), so the SQL editor and migrations are unaffected.
-- ============================================================================
do $$
declare
  r        record;
  v_sig    text;
  v_role   text;
begin
  for r in
    select * from (values
      -- function name          roles that must KEEP execute (besides service_role)
      ('security_health',       array[]::text[]),
      ('user_brand_ids',        array['anon','authenticated']),
      ('lookup_invite',         array['anon','authenticated']),
      ('redeem_invite',         array['authenticated']),
      ('pin_brand_id',          array[]::text[]),
      ('brands_pin_ownership',  array[]::text[]),
      -- v659: added by sql/v659-brand-limit.sql. brands_enforce_limit is a trigger function
      -- (callable only as a trigger); brand_limit_for is a pure lookup that leaks nothing, but
      -- both arrive on the PostgreSQL default PUBLIC EXECUTE grant like everything else here, and
      -- scripts/verify/invite-link-owner-delete.mjs fails until every function in sql/** is named
      -- in this file. RE-RUN THIS FILE after running sql/v659-brand-limit.sql.
      ('brand_limit_for',       array[]::text[]),
      ('brands_enforce_limit',  array[]::text[])
    ) as t(fn, keep)
  loop
    -- Overloads are handled by looping over pg_proc rather than typing a signature:
    -- redeem_invite(text) is the only one today, but a second overload would otherwise
    -- be silently left wide open.
    for v_sig in
      select p.oid::regprocedure::text
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = r.fn
      order by 1
    loop
      -- 1. Close the default. This is the line that was missing everywhere.
      execute format('revoke all on function %s from public', v_sig);

      -- 2. Close any DIRECT grant to an untrusted role. Revoking PUBLIC does not
      --    remove a grant made to anon/authenticated by name, and two of these
      --    functions have exactly such grants on record.
      foreach v_role in array array['anon','authenticated'] loop
        if exists (select 1 from pg_roles where rolname = v_role) then
          execute format('revoke all on function %s from %I', v_sig, v_role);
        end if;
      end loop;

      -- 3. Hand back only what is actually used. service_role first: it reached every
      --    one of these through PUBLIC, so without this the backend loses them.
      if exists (select 1 from pg_roles where rolname = 'service_role') then
        execute format('grant execute on function %s to service_role', v_sig);
      end if;
      foreach v_role in array r.keep loop
        if exists (select 1 from pg_roles where rolname = v_role) then
          execute format('grant execute on function %s to %I', v_sig, v_role);
        end if;
      end loop;

      raise notice 'v658: % — execute restricted to service_role%', v_sig,
        case when array_length(r.keep, 1) is null then '' else ' + ' || array_to_string(r.keep, ', ') end;
    end loop;
  end loop;
end $$;


-- ============================================================================
-- VERIFY — read-only. EMPTY RESULT = no untrusted role can execute any of these
-- functions, and every role that legitimately needs one still has it.
--
-- Two arms, because a REVOKE has two ways to be wrong:
--   * a row from the first arm  = the lockdown did not take (still reachable);
--   * a row from the second arm = the lockdown went too far (something that must
--     work no longer can — e.g. /api/health's isolation audit going dark, or every
--     brand-scoped RLS policy failing because user_brand_ids() became unreachable).
--
-- PUBLIC is checked through the ACL, not has_function_privilege(): PUBLIC is not a
-- role and that function rejects it. proacl being NULL is the dangerous case — NULL
-- means "defaults still apply", which for a function INCLUDES execute for PUBLIC — so
-- it is expanded with acldefault() rather than treated as empty.
--
-- Scope is the six functions this file locks down. A NEW function added to sql/**
-- with no revoke is caught statically by scripts/verify/invite-link-owner-delete.mjs,
-- which reads every `create function` in sql/** and requires it to be named here.
-- ============================================================================
with expected(fn, allowed) as (
  values ('security_health',      array['service_role']),
         ('user_brand_ids',       array['anon','authenticated','service_role']),
         ('lookup_invite',        array['anon','authenticated','service_role']),
         ('redeem_invite',        array['authenticated','service_role']),
         ('pin_brand_id',         array['service_role']),
         ('brands_pin_ownership', array['service_role']),
         ('brand_limit_for',      array['service_role']),
         ('brands_enforce_limit', array['service_role'])
),
fns as (
  select p.oid, p.proname, p.proowner,
         coalesce(p.proacl, acldefault('f', p.proowner)) as acl
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (select fn from expected)
)
select f.proname as problem,
       'EXECUTE is still held by ' ||
       case when a.grantee = 0 then 'PUBLIC (anon and authenticated are members of it)'
            else coalesce(r.rolname, a.grantee::text) end ||
       ' — this function is not locked down' as detail
from fns f
cross join lateral aclexplode(f.acl) a
left join pg_roles r on r.oid = a.grantee
join expected e on e.fn = f.proname
where a.privilege_type = 'EXECUTE'
  and a.grantee <> f.proowner                                  -- the owner's own grant is not a leak
  and coalesce(r.rolname, 'PUBLIC') <> all (e.allowed)

union all

select e.fn as problem,
       'required grantee ' || r.rolname ||
       ' can NO LONGER execute it — this revoke went too far' as detail
from expected e
cross join lateral unnest(e.allowed) as u(rolname)
join pg_roles r on r.rolname = u.rolname
join fns f on f.proname = e.fn
where not has_function_privilege(r.oid, f.oid, 'EXECUTE')
  -- pin_brand_id / brands_pin_ownership fire as triggers, not as calls; service_role is
  -- granted them for symmetry only, so do not fail if that grant is absent.
  and not (e.fn in ('pin_brand_id','brands_pin_ownership','brand_limit_for','brands_enforce_limit'))

order by 1, 2;
