-- ============================================================
-- v634 hardening — DID IT EVER RUN? Read-only. Changes nothing.
--
-- EMPTY RESULT ("No rows returned") = the hardening IS applied. Nothing to do.
-- ANY ROWS = it is NOT applied, and each row names exactly what is missing.
--   Fix: open sql/v634-hardening.sql and run STEP 1, then STEP 2, then STEP 3.
-- ============================================================
select c.relname as problem,
       'brand-scoped table has no foreign key to brands (delete orphans its rows)' as detail
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid
                   and a.attname  = 'brand_id'
                   and a.attnum   > 0
                   and not a.attisdropped
where n.nspname = 'public'
  and c.relkind = 'r'
  and c.relname <> 'brands'
  and not exists (
    select 1 from pg_constraint k
     where k.conrelid  = c.oid
       and k.contype   = 'f'
       and k.confrelid = 'public.brands'::regclass
  )
union all
select p.proname,
       'invite function has no 14-day expiry (a leaked code is valid forever)'
from pg_proc p
join pg_namespace n2 on n2.oid = p.pronamespace
where n2.nspname = 'public'
  and p.proname in ('lookup_invite', 'redeem_invite')
  and pg_get_functiondef(p.oid) not like '%14 days%'
order by 1;
