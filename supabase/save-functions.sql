-- All-or-nothing saves for the shift bidding app.
-- Run once after rls-policies.sql: Supabase Dashboard > SQL Editor > New query > paste this whole file > Run.
-- Safe to re-run.
--
-- Each function replaces a set of rows in one transaction, so a failure part way through
-- leaves the old rows in place instead of deleting them. The admin functions run as the
-- signed-in user (security invoker), so the row-level security policies still apply.
-- replace_my_bids runs as the owner (security definer) because agents have no write policy
-- on bids2; it does every check itself and only ever touches the caller's own bids.

begin;

-- Agents can share a rank; ties go to whoever submitted their bid first. This is the time of
-- their first submission (changing the bid later keeps it). Set only by replace_my_bids.
alter table public.agents add column if not exists bid_submitted_at timestamptz;

-- Per-LOB setting: agents must fill every pick before they can save (see schema.sql): all 20,
-- or every shell when the LOB has 20 or fewer.
alter table public.bid_windows add column if not exists require_full_ranking boolean not null default true;

-- Auto assign: replace the assignments for the given agents with the new results.
-- p_rows: [{"agent_id": 1, "shift_id": 2}, ...]
create or replace function public.replace_assignments(p_agent_ids bigint[], p_rows jsonb)
returns void
language plpgsql security invoker set search_path = public as $$
begin
  if not has_perm('assign') then
    raise exception 'You do not have permission to run auto assign.' using errcode = '42501';
  end if;

  delete from assignments where agent_id = any (p_agent_ids);

  insert into assignments (agent_id, shift_id)
  select (r ->> 'agent_id')::bigint, (r ->> 'shift_id')::bigint
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r;
end $$;

-- Bid window: keep exactly one window per LOB.
-- The old three-argument version is dropped so the API has a single function to call.
drop function if exists public.replace_bid_window(text, timestamptz, timestamptz);
create or replace function public.replace_bid_window(
  p_lob text, p_opens timestamptz, p_closes timestamptz, p_require_full_ranking boolean default true)
returns void
language plpgsql security invoker set search_path = public as $$
begin
  if not has_perm('windows') then
    raise exception 'You do not have permission to change bid windows.' using errcode = '42501';
  end if;
  if p_closes <= p_opens then
    raise exception 'The close time must be after the open time.';
  end if;

  delete from bid_windows where lob = p_lob;
  insert into bid_windows (lob, opens_at, closes_at, require_full_ranking)
  values (p_lob, p_opens, p_closes, coalesce(p_require_full_ranking, true));
end $$;

-- Agent bids: replace the signed-in agent's choices.
-- p_bids: [{"shift_id": 2, "priority": 1}, ...]
-- Shifts must be in the agent's LOB; each shift and each priority may appear once; priorities
-- start at 1. Agents pick at most 20 shells. When the LOB's window requires full ranking, they
-- must use every pick: 20 shells, or every shell when the LOB has fewer, ranked 1..N.
create or replace function public.replace_my_bids(p_bids jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_agent_id bigint;
  v_excluded boolean;
  v_lob text;
  v_required boolean;
  v_count int;
  v_shifts int;
  v_priorities int;
  v_min int;
  v_max int;
  v_total int;
  v_needed int;
  c_max_picks constant int := 20;   -- keep in step with MAX_PICKS in public/app.js
begin
  select id, excluded, lob into v_agent_id, v_excluded, v_lob
  from agents where email = lower(auth.jwt() ->> 'email') limit 1;
  if v_agent_id is null then
    raise exception 'Your login is not linked to an agent record.';
  end if;
  if v_excluded then
    raise exception 'You are not part of this shift bid.';
  end if;
  if not my_bidding_open() then
    raise exception 'Bidding is closed for your LOB.';
  end if;

  select count(*), count(distinct b ->> 'shift_id'), count(distinct b ->> 'priority'),
         min((b ->> 'priority')::int), max((b ->> 'priority')::int)
  into v_count, v_shifts, v_priorities, v_min, v_max
  from jsonb_array_elements(coalesce(p_bids, '[]'::jsonb)) b;
  if v_shifts <> v_count then
    raise exception 'Each shift can only be ranked once.';
  end if;
  if v_priorities <> v_count then
    raise exception 'Each rank number can only be used once.';
  end if;
  if v_count > 0 and v_min < 1 then
    raise exception 'Rank numbers start at 1.';
  end if;
  if v_count > c_max_picks then
    raise exception 'You can pick at most % shifts: % picked.', c_max_picks, v_count;
  end if;
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_bids, '[]'::jsonb)) b
    where not exists (select 1 from shift_shells s where s.id = (b ->> 'shift_id')::bigint and s.lob = v_lob)
  ) then
    raise exception 'You can only rank shifts in your own LOB.';
  end if;

  select coalesce(bool_or(require_full_ranking), false) into v_required from bid_windows where lob = v_lob;
  if v_required then
    select count(*) into v_total from shift_shells where lob = v_lob;
    v_needed := least(c_max_picks, v_total);
    if v_count <> v_needed or (v_count > 0 and (v_min <> 1 or v_max <> v_count)) then
      raise exception 'Pick and rank % shifts before saving: % picked.', v_needed, v_count;
    end if;
  end if;

  delete from bids2 where agent_id = v_agent_id;

  insert into bids2 (agent_id, shift_id, priority)
  select v_agent_id, (b ->> 'shift_id')::bigint, (b ->> 'priority')::integer
  from jsonb_array_elements(coalesce(p_bids, '[]'::jsonb)) b;

  -- Keep the time of the first submission; saving an empty list withdraws the bid.
  update agents
     set bid_submitted_at = case when v_count = 0 then null else coalesce(bid_submitted_at, now()) end
   where id = v_agent_id;
end $$;

revoke execute on function
  public.replace_assignments(bigint[], jsonb),
  public.replace_bid_window(text, timestamptz, timestamptz, boolean),
  public.replace_my_bids(jsonb)
from anon, public;

grant execute on function
  public.replace_assignments(bigint[], jsonb),
  public.replace_bid_window(text, timestamptz, timestamptz, boolean),
  public.replace_my_bids(jsonb)
to authenticated;

commit;
