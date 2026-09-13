-- Team collaboration tables for Content Engine
-- Run this in Supabase SQL Editor

-- 1. Brand members — who has access to which brand
CREATE TABLE brand_members (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  brand_id uuid REFERENCES brands(id) ON DELETE CASCADE NOT NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  user_email text,
  invited_by uuid REFERENCES auth.users(id),
  joined_at timestamptz DEFAULT now(),
  UNIQUE(brand_id, user_id)
);

-- 2. Brand invites — pending invitations
CREATE TABLE brand_invites (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  brand_id uuid REFERENCES brands(id) ON DELETE CASCADE NOT NULL,
  invite_code text UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(12), 'hex'),
  email text,
  created_by uuid REFERENCES auth.users(id) NOT NULL,
  created_at timestamptz DEFAULT now(),
  used_by uuid REFERENCES auth.users(id),
  used_at timestamptz
);

-- 3. RLS policies for brand_members
ALTER TABLE brand_members ENABLE ROW LEVEL SECURITY;

-- Members can see other members of brands they belong to
CREATE POLICY "Members can view brand members" ON brand_members FOR SELECT USING (
  brand_id IN (
    SELECT brand_id FROM brand_members WHERE user_id = auth.uid()
    UNION
    SELECT id FROM brands WHERE user_id = auth.uid()
  )
);

-- Brand owner can insert members
CREATE POLICY "Brand owner or self can insert members" ON brand_members FOR INSERT WITH CHECK (
  brand_id IN (SELECT id FROM brands WHERE user_id = auth.uid())
  OR user_id = auth.uid()
);

-- Brand owner can delete members
CREATE POLICY "Brand owner can delete members" ON brand_members FOR DELETE USING (
  brand_id IN (SELECT id FROM brands WHERE user_id = auth.uid())
);

-- 4. RLS policies for brand_invites
ALTER TABLE brand_invites ENABLE ROW LEVEL SECURITY;

-- Anyone can read an invite by code (needed for joining)
CREATE POLICY "Anyone can read invites by code" ON brand_invites FOR SELECT USING (true);

-- Brand owner or member can create invites
CREATE POLICY "Brand access can create invites" ON brand_invites FOR INSERT WITH CHECK (
  brand_id IN (
    SELECT id FROM brands WHERE user_id = auth.uid()
    UNION
    SELECT brand_id FROM brand_members WHERE user_id = auth.uid()
  )
);

-- Brand owner can delete invites
CREATE POLICY "Brand owner can delete invites" ON brand_invites FOR DELETE USING (
  brand_id IN (SELECT id FROM brands WHERE user_id = auth.uid())
);

-- Creator can update their own invites (mark as used)
CREATE POLICY "Anyone can mark invite as used" ON brand_invites FOR UPDATE USING (true) WITH CHECK (true);

-- 5. Update brands RLS — members can also read brands they belong to
-- First drop existing select policy if it only checks user_id
-- (Check your existing policy name — adjust if different)
DROP POLICY IF EXISTS "Users can view own brands" ON brands;
CREATE POLICY "Users can view own or member brands" ON brands FOR SELECT USING (
  user_id = auth.uid()
  OR id IN (SELECT brand_id FROM brand_members WHERE user_id = auth.uid())
);

-- 6. Update ideas RLS — members can also access ideas
DROP POLICY IF EXISTS "Users can view own ideas" ON ideas;
CREATE POLICY "Users can view own or member ideas" ON ideas FOR SELECT USING (
  brand_id IN (
    SELECT id FROM brands WHERE user_id = auth.uid()
    UNION
    SELECT brand_id FROM brand_members WHERE user_id = auth.uid()
  )
);

DROP POLICY IF EXISTS "Users can insert own ideas" ON ideas;
CREATE POLICY "Users can insert own or member ideas" ON ideas FOR INSERT WITH CHECK (
  brand_id IN (
    SELECT id FROM brands WHERE user_id = auth.uid()
    UNION
    SELECT brand_id FROM brand_members WHERE user_id = auth.uid()
  )
);

DROP POLICY IF EXISTS "Users can update own ideas" ON ideas;
CREATE POLICY "Users can update own or member ideas" ON ideas FOR UPDATE USING (
  brand_id IN (
    SELECT id FROM brands WHERE user_id = auth.uid()
    UNION
    SELECT brand_id FROM brand_members WHERE user_id = auth.uid()
  )
);

DROP POLICY IF EXISTS "Users can delete own ideas" ON ideas;
CREATE POLICY "Users can delete own or member ideas" ON ideas FOR DELETE USING (
  brand_id IN (
    SELECT id FROM brands WHERE user_id = auth.uid()
    UNION
    SELECT brand_id FROM brand_members WHERE user_id = auth.uid()
  )
);

-- Also update brands UPDATE policy for members
DROP POLICY IF EXISTS "Users can update own brands" ON brands;
CREATE POLICY "Users can update own or member brands" ON brands FOR UPDATE USING (
  user_id = auth.uid()
  OR id IN (SELECT brand_id FROM brand_members WHERE user_id = auth.uid())
);

-- Helper function to check brand access (own or member)
CREATE OR REPLACE FUNCTION user_brand_ids() RETURNS SETOF uuid AS $$
  SELECT id FROM brands WHERE user_id = auth.uid()
  UNION
  SELECT brand_id FROM brand_members WHERE user_id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Update RLS for all other brand-scoped tables (remixes, product_refs, competitors, prompt_history)
-- Run these for each table that has brand_id and RLS:

DO $$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY['remixes', 'product_refs', 'competitors', 'prompt_history']) LOOP
    -- Only update if table exists
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = tbl AND table_schema = 'public') THEN
      EXECUTE format('DROP POLICY IF EXISTS "Users can view own %1$s" ON %1$s', tbl);
      EXECUTE format('CREATE POLICY "Users can access %1$s" ON %1$s FOR ALL USING (brand_id IN (SELECT user_brand_ids()))', tbl);
    END IF;
  END LOOP;
END $$;
