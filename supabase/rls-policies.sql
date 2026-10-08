-- Row-level security for the shift bidding app.
-- Run once: Supabase Dashboard > SQL Editor > New query > paste this whole file > Run.
-- Safe to re-run. Runs as one transaction: if anything errors, nothing is changed.
-- Verify afterwards with: npm run check:rls
--
-- Who can do what after this runs:
--   Admins (emails in public.admins) can read every table. What they can change depends on the
--           permissions on their admins row (see section 2), set on the app's Admins screen:
--             roster  - Agents tab: sync, ranks, remove/restore, accommodation, logins
--             shells  - Shift shells tab
--             windows - Bid window tab and trade windows
--             assign  - Auto assign
--             swaps   - approve or reject shift trades and day swaps
--             push    - Apply to Assembled
--             manual  - manual shift assignments
--             admins  - add and remove admins and change their permissions
--   Agents: read their own agent row, their LOB's shift shells (through my_shift_shells(), without
--           admin-only set names), their bid window and their own bids. They save bids only
--           through replace_my_bids() while their LOB's window is open.
--   Everyone else (including brand new sign-ups): nothing.
--   The /api/* server functions use the service key and are not affected.

begin;

-- Needed by the helper functions below (see schema.sql).
alter table public.agents add column if not exists excluded boolean not null default false;

-- ---------------------------------------------------------------------
-- 1. Keep a copy of the policies that existed before the first run.
-- ---------------------------------------------------------------------
create table if not exists public.policy_backup as
  select now() as saved_at, tablename, policyname, cmd, roles, qual, with_check
  from pg_policies
  where schemaname = 'public';
alter table public.policy_backup enable row level security;

-- ---------------------------------------------------------------------
-- 2. Admin list and helper functions.
-- Keep this list in sync with ADMIN_EMAILS (.env.local and Vercel).
-- ---------------------------------------------------------------------
create table if not exists public.admins (
  email text primary key
);

-- What each admin may change. Existing admins keep everything they could do before (all of it
-- except managing admins and manual assignments); new admins get what the Admins screen sets.
alter table public.admins add column if not exists permissions text[] not null
  default array['roster', 'shells', 'windows', 'assign', 'swaps', 'push']::text[];
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.admins'::regclass and conname = 'admins_known_permissions') then
    alter table public.admins add constraint admins_known_permissions
      check (permissions <@ array['roster', 'shells', 'windows', 'assign', 'swaps', 'push', 'manual', 'admins']::text[]);
  end if;
  -- Whoever could already set manual assignments keeps that as a permission.
  if to_regclass('public.manual_assigners') is not null then
    update public.admins a set permissions = a.permissions || array['manual']
     where a.email in (select email from public.manual_assigners) and not ('manual' = any (a.permissions));
  end if;
end $$;

insert into public.admins (email, permissions) values
  ('owner@example.com', array['roster', 'shells', 'windows', 'assign', 'swaps', 'push', 'manual', 'admins'])
on conflict (email) do nothing;
-- The owner can always manage admins, so nobody can be locked out of the Admins screen.
update public.admins set permissions = permissions || array['admins']
 where email = 'owner@example.com' and not ('admins' = any (permissions));

alter table public.admins enable row level security;

-- True when the signed-in user is an admin.
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from admins where email = lower(auth.jwt() ->> 'email')
  );
$$;

-- True when the signed-in admin has this permission (see the list at the top).
create or replace function public.has_perm(p_permission text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from admins where email = lower(auth.jwt() ->> 'email') and p_permission = any (permissions)
  );
$$;

-- The signed-in admin's permissions, for the app to show or hide controls. Null for non-admins.
create or replace function public.my_permissions() returns text[]
language sql stable security definer set search_path = public as $$
  select permissions from admins where email = lower(auth.jwt() ->> 'email');
$$;

-- Admins can see the admin list; only those with the "admins" permission can change it.
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'admins'
  loop
    execute format('drop policy %I on public.admins', p.policyname);
  end loop;
end $$;
create policy "admins read the admin list" on public.admins
  for select to authenticated using (is_admin());
create policy "admin managers add admins" on public.admins
  for insert to authenticated with check (has_perm('admins'));
create policy "admin managers change admins" on public.admins
  for update to authenticated using (has_perm('admins')) with check (has_perm('admins'));
create policy "admin managers remove admins" on public.admins
  for delete to authenticated using (has_perm('admins'));

-- Emails are stored lowercase, and nobody can remove themselves or their own right to manage
-- admins from the app (so the last manager cannot lock everyone out).
create or replace function public.check_admin_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_me text := lower(auth.jwt() ->> 'email');
begin
  if tg_op in ('INSERT', 'UPDATE') then
    new.email := lower(trim(new.email));
    if new.email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'That is not a valid email address.'; end if;
  end if;
  if v_me is not null and tg_op = 'DELETE' and old.email = v_me then
    raise exception 'You cannot remove yourself as an admin.';
  end if;
  if v_me is not null and tg_op = 'UPDATE' and old.email = v_me and not ('admins' = any (new.permissions)) then
    raise exception 'You cannot take away your own right to manage admins.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists check_admin_change on public.admins;
create trigger check_admin_change before insert or update or delete on public.admins
  for each row execute function public.check_admin_change();

-- The signed-in agent's LOB, or null if they are not an agent or were removed from bidding.
create or replace function public.my_lob() returns text
language sql stable security definer set search_path = public as $$
  select lob from agents where email = lower(auth.jwt() ->> 'email') and not excluded limit 1;
$$;

-- True while the signed-in agent's LOB bid window is open (never for removed agents).
create or replace function public.my_bidding_open() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from bid_windows w
    join agents a on a.lob = w.lob
    where a.email = lower(auth.jwt() ->> 'email')
      and not a.excluded
      and now() between w.opens_at and w.closes_at
  );
$$;

-- The signed-in agent's LOB shift shells, without set_name: sets (e.g. Set A / Set B) are for
-- admins only, so agents do not read shift_shells directly.
create or replace function public.my_shift_shells() returns setof jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(s) - 'set_name' from shift_shells s where s.lob = my_lob() order by s.id;
$$;

revoke execute on function public.is_admin(), public.has_perm(text), public.my_permissions(),
  public.my_lob(), public.my_bidding_open(), public.my_shift_shells() from anon;

-- ---------------------------------------------------------------------
-- 3. Turn on RLS and replace all policies on the app tables.
-- ---------------------------------------------------------------------
alter table public.agents       enable row level security;
alter table public.shift_shells enable row level security;
alter table public.bid_windows  enable row level security;
alter table public.bids2        enable row level security;
alter table public.assignments  enable row level security;
alter table public.app_settings enable row level security;

do $$
declare p record;
begin
  for p in
    select policyname, tablename from pg_policies
    where schemaname = 'public'
      and tablename in ('agents', 'shift_shells', 'bid_windows', 'bids2', 'assignments', 'app_settings')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

-- Every table: all admins can read; changing needs the matching permission (see the top).
-- agents
create policy "admins read agents" on public.agents
  for select to authenticated using (is_admin());
create policy "roster editors add agents" on public.agents
  for insert to authenticated with check (has_perm('roster'));
create policy "roster editors change agents" on public.agents
  for update to authenticated using (has_perm('roster')) with check (has_perm('roster'));
create policy "roster editors remove agents" on public.agents
  for delete to authenticated using (has_perm('roster'));
create policy "agents read own row" on public.agents
  for select to authenticated using (email = lower(auth.jwt() ->> 'email'));

-- shift_shells
create policy "admins read shift shells" on public.shift_shells
  for select to authenticated using (is_admin());
create policy "shell editors add shift shells" on public.shift_shells
  for insert to authenticated with check (has_perm('shells'));
create policy "shell editors change shift shells" on public.shift_shells
  for update to authenticated using (has_perm('shells')) with check (has_perm('shells'));
create policy "shell editors remove shift shells" on public.shift_shells
  for delete to authenticated using (has_perm('shells'));
-- Agents read their LOB's shells through my_shift_shells() (above), which leaves out set_name.

-- bid_windows
create policy "admins read bid windows" on public.bid_windows
  for select to authenticated using (is_admin());
create policy "window editors add bid windows" on public.bid_windows
  for insert to authenticated with check (has_perm('windows'));
create policy "window editors change bid windows" on public.bid_windows
  for update to authenticated using (has_perm('windows')) with check (has_perm('windows'));
create policy "window editors remove bid windows" on public.bid_windows
  for delete to authenticated using (has_perm('windows'));
create policy "agents read own lob window" on public.bid_windows
  for select to authenticated using (lob = my_lob());

-- bids2: admins only ever delete bids (cancelling a window, or removing shells with their rankings).
create policy "admins read bids" on public.bids2
  for select to authenticated using (is_admin());
create policy "window or shell editors remove bids" on public.bids2
  for delete to authenticated using (has_perm('windows') or has_perm('shells'));
create policy "agents read own bids" on public.bids2
  for select to authenticated
  using (agent_id in (select id from public.agents where email = lower(auth.jwt() ->> 'email')));
-- Agents have no insert/update/delete policy on bids2: they change bids only through
-- replace_my_bids() (save-functions.sql), which checks the window, their LOB and full ranking.

-- assignments (agents never read these in the app)
create policy "admins read assignments" on public.assignments
  for select to authenticated using (is_admin());
create policy "auto assigners add assignments" on public.assignments
  for insert to authenticated with check (has_perm('assign'));
create policy "auto assigners change assignments" on public.assignments
  for update to authenticated using (has_perm('assign')) with check (has_perm('assign'));
create policy "auto assigners remove assignments" on public.assignments
  for delete to authenticated using (has_perm('assign'));

-- app_settings (not used by the app yet; admins only)
create policy "admins read app settings" on public.app_settings
  for select to authenticated using (is_admin());
create policy "admin managers change app settings" on public.app_settings
  for all to authenticated using (has_perm('admins')) with check (has_perm('admins'));

commit;


-- =====================================================================
-- EMERGENCY ONLY: undo if the app breaks. This reopens the tables to any
-- signed-in user, so re-run this file once the problem is fixed.
-- Remove the leading "-- " from these lines and run them on their own.
-- =====================================================================

-- alter table public.agents       disable row level security;
-- alter table public.shift_shells disable row level security;
-- alter table public.bid_windows  disable row level security;
-- alter table public.bids2        disable row level security;
-- alter table public.assignments  disable row level security;
-- alter table public.app_settings disable row level security;
