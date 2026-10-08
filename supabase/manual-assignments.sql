-- Manual shift assignments: a chosen admin sets an agent's shift directly, before auto assign.
-- Run after rls-policies.sql: Supabase Dashboard > SQL Editor > New query > paste > Run.
-- Safe to re-run. Runs as one transaction: if anything errors, nothing is changed.
--
-- Auto assign places these agents first, ahead of accommodation tiers, then hands out the
-- seats left. Agents never see them: their bidding page and the seats they see are unchanged.
-- All admins can read them; only admins with the "manual" permission (set on the Admins screen,
-- see rls-policies.sql) can add, change or remove them. manual_assigners is the older list: the
-- people on it were given the "manual" permission when permissions were added.

begin;

create table if not exists public.manual_assigners (
  email text primary key
);
alter table public.manual_assigners enable row level security;
insert into public.manual_assigners (email) values ('owner@example.com')
on conflict (email) do nothing;

-- True when the signed-in user may set manual assignments.
create or replace function public.can_assign_manually() returns boolean
language sql stable security definer set search_path = public as $$
  select has_perm('manual');
$$;

create table if not exists public.manual_assignments (
  agent_id bigint primary key references public.agents (id) on delete cascade,
  shift_id bigint not null references public.shift_shells (id),   -- a shell with one cannot be deleted
  assigned_by text not null default lower(auth.jwt() ->> 'email'),
  assigned_at timestamptz not null default now()
);
alter table public.manual_assignments enable row level security;

do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'manual_assignments'
  loop
    execute format('drop policy %I on public.manual_assignments', p.policyname);
  end loop;
end $$;

create policy "admins read manual assignments" on public.manual_assignments
  for select to authenticated using (is_admin());
create policy "manual assigners add" on public.manual_assignments
  for insert to authenticated with check (can_assign_manually());
create policy "manual assigners change" on public.manual_assignments
  for update to authenticated using (can_assign_manually()) with check (can_assign_manually());
create policy "manual assigners remove" on public.manual_assignments
  for delete to authenticated using (can_assign_manually());

-- The shell must be in the agent's LOB, and a shell cannot have more manual assignments
-- than seats. Also records who made the change.
create or replace function public.check_manual_assignment() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_agent_lob text;
  v_shell_lob text;
  v_seats int;
  v_used int;
begin
  select lob into v_agent_lob from agents where id = new.agent_id;
  select lob, seats into v_shell_lob, v_seats from shift_shells where id = new.shift_id;
  if v_shell_lob is null then raise exception 'That shift shell does not exist.'; end if;
  if v_agent_lob is distinct from v_shell_lob then
    raise exception 'That shell is in %, but this agent is in %.', v_shell_lob, v_agent_lob;
  end if;
  select count(*) into v_used from manual_assignments where shift_id = new.shift_id and agent_id <> new.agent_id;
  if v_used >= v_seats then
    raise exception 'All % seat(s) on that shell are already manually assigned.', v_seats;
  end if;
  new.assigned_by := lower(coalesce(auth.jwt() ->> 'email', new.assigned_by));
  new.assigned_at := now();
  return new;
end $$;

drop trigger if exists check_manual_assignment on public.manual_assignments;
create trigger check_manual_assignment before insert or update on public.manual_assignments
  for each row execute function public.check_manual_assignment();

-- After auto assign: give an agent who has no shift yet (for example someone added later by a
-- sync) one of the LOB's open seats, without re-running auto assign. It is saved to the results
-- straight away, so once results are published the agent sees it, and it is also kept as a
-- manual assignment so a later auto assign run places them on the same shell.
create or replace function public.assign_open_seat(p_agent_id bigint, p_shift_id bigint)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_agent agents%rowtype;
  v_shell shift_shells%rowtype;
  v_taken int;
begin
  -- Runs as the owner (it writes assignments), so it checks the permission itself.
  if not has_perm('manual') then
    raise exception 'You do not have permission to assign shifts directly.' using errcode = '42501';
  end if;
  select * into v_agent from agents where id = p_agent_id;
  if v_agent.id is null or v_agent.excluded then raise exception 'That agent is not part of the shift bid.'; end if;
  -- Locks the shell so two admins cannot both take its last seat.
  select * into v_shell from shift_shells where id = p_shift_id for update;
  if v_shell.id is null then raise exception 'That shift shell does not exist.'; end if;
  if v_shell.lob is distinct from v_agent.lob then
    raise exception 'That shell is in %, but % is in %.', v_shell.lob, v_agent.name, v_agent.lob;
  end if;
  if exists (select 1 from assignments where agent_id = p_agent_id) then
    raise exception '% already has an assigned shift.', v_agent.name;
  end if;
  select count(*) into v_taken from assignments x join agents a on a.id = x.agent_id
   where x.shift_id = p_shift_id and not a.excluded;
  if v_taken >= v_shell.seats then raise exception 'That shell has no open seats left. Pick another.'; end if;

  insert into assignments (agent_id, shift_id) values (p_agent_id, p_shift_id);
  insert into manual_assignments (agent_id, shift_id) values (p_agent_id, p_shift_id)
  on conflict (agent_id) do update set shift_id = excluded.shift_id;
end $$;

-- After auto assign: move an agent who already has a shift to another shell that has an open
-- seat. Their old seat becomes open and nobody else changes. Not while they have a trade or day
-- swap waiting, or an approved day swap still to come (those were worked out from their current
-- shift). Moving here does not change Assembled: if their schedule is already there, the admin
-- deletes it in Assembled first and says so (p_pushed_ok), which clears pushed_at so they can be
-- pushed again; the push skips any day that still has something in Assembled. Also kept as a
-- manual assignment, so a later auto assign run keeps them on the new shell.
drop function if exists public.move_to_open_seat(bigint, bigint);
create or replace function public.move_to_open_seat(p_agent_id bigint, p_shift_id bigint, p_pushed_ok boolean default false)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_agent agents%rowtype;
  v_shell shift_shells%rowtype;
  v_current assignments%rowtype;
  v_taken int;
begin
  if not has_perm('manual') then
    raise exception 'You do not have permission to assign shifts directly.' using errcode = '42501';
  end if;
  select * into v_agent from agents where id = p_agent_id;
  if v_agent.id is null or v_agent.excluded then raise exception 'That agent is not part of the shift bid.'; end if;
  select * into v_shell from shift_shells where id = p_shift_id for update;
  if v_shell.id is null then raise exception 'That shift shell does not exist.'; end if;
  if v_shell.lob is distinct from v_agent.lob then
    raise exception 'That shell is in %, but % is in %.', v_shell.lob, v_agent.name, v_agent.lob;
  end if;
  select * into v_current from assignments where agent_id = p_agent_id limit 1 for update;
  if v_current.id is null then raise exception '% has no shift yet. Use Give open seat instead.', v_agent.name; end if;
  if v_current.shift_id = p_shift_id then raise exception '% is already on that shell.', v_agent.name; end if;
  if v_current.pushed_at is not null and not coalesce(p_pushed_ok, false) then
    raise exception '%''s schedule is already in Assembled. Delete their shifts there first, then move them and push again.', v_agent.name;
  end if;
  if exists (select 1 from shift_trades where status in ('pending_partner', 'pending_admin')
               and p_agent_id in (requester_id, partner_id))
     or exists (select 1 from swap_requests where status in ('pending_partner', 'pending_admin')
               and p_agent_id in (requester_id, partner_id)) then
    raise exception '% has a trade or day swap waiting. Reject it or have it cancelled first.', v_agent.name;
  end if;
  if exists (select 1 from swap_requests where status = 'approved' and p_agent_id in (requester_id, partner_id)
               and greatest(coalesce(give_date, end_date), coalesce(take_date, end_date)) >= current_date) then
    raise exception '% has an approved day swap still to come, set up from their current shift. Move them after it.', v_agent.name;
  end if;
  select count(*) into v_taken from assignments x join agents a on a.id = x.agent_id
   where x.shift_id = p_shift_id and not a.excluded;
  if v_taken >= v_shell.seats then raise exception 'That shell has no open seats left. Pick another.'; end if;

  update assignments set shift_id = p_shift_id, pushed_at = null, push_error = null where id = v_current.id;
  insert into manual_assignments (agent_id, shift_id) values (p_agent_id, p_shift_id)
  on conflict (agent_id) do update set shift_id = excluded.shift_id;
end $$;

revoke execute on function public.can_assign_manually() from anon, public;
grant execute on function public.can_assign_manually() to authenticated;
revoke execute on function public.assign_open_seat(bigint, bigint) from anon, public;
grant execute on function public.assign_open_seat(bigint, bigint) to authenticated;
revoke execute on function public.move_to_open_seat(bigint, bigint, boolean) from anon, public;
grant execute on function public.move_to_open_seat(bigint, bigint, boolean) to authenticated;

commit;
