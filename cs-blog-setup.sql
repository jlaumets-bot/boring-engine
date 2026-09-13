-- ─────────────────────────────────────────────────────────────────────────────
-- Content Shrimp marketing blog — one-time Supabase setup.
-- Run this ONCE in the Supabase SQL editor (Dashboard → SQL → New query → Run).
-- Powers contentshrimp.com/blog. No new env vars needed; the blog reuses the
-- existing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / CRON_SECRET / XAI_API_KEY.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.cs_blog_posts (
  id               uuid primary key default gen_random_uuid(),
  slug             text unique not null,
  title            text not null,
  meta_description text,
  keyword          text,
  category         text,
  tldr             text,
  body_html        text,
  faq              jsonb not null default '[]'::jsonb,
  speakable        text,
  read_minutes     int not null default 4,
  status           text not null default 'published',
  published_at     timestamptz not null default now(),
  created_at       timestamptz not null default now()
);

create index if not exists cs_blog_posts_pub_idx
  on public.cs_blog_posts (status, published_at desc);

-- Keep RLS ON. The blog is served ONLY by our serverless functions using the
-- service-role key (which bypasses RLS), and the public never queries this table
-- directly — so no public SELECT policy is required.
alter table public.cs_blog_posts enable row level security;
