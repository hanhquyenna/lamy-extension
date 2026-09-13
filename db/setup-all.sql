-- Lamy: the career agent's vertical slice.
-- Prefixed lamy_ and kept in the marketing project on purpose: this is a
-- prototype meant to prove five mechanics, not a production tenant boundary.
-- Multi-tenancy is present as user_id so the shape is honest from day one.

create table if not exists public.lamy_bank (
  id          bigserial primary key,
  user_id     text not null,
  claim       text not null,
  metric      text,
  tags        text[] not null default '{}',
  -- confirmed: the human said it. inferred: extracted or guessed, may be
  -- drafted with but NEVER submitted. stale: the world moved.
  state       text not null default 'inferred'
              check (state in ('confirmed','inferred','stale')),
  source      text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.lamy_roles (
  id          bigserial primary key,
  user_id     text not null,
  title       text not null,
  company     text not null,
  archetype   text not null default 'quantified_operator',
  must_haves  text[] not null default '{}',
  jd          text,
  created_at  timestamptz not null default now()
);

-- Open questions the agent wants answered. Skipping is first class and
-- remembered, so the agent never nags.
create table if not exists public.lamy_asks (
  id          bigserial primary key,
  user_id     text not null,
  question    text not null,
  unlocks     text not null,
  status      text not null default 'open'
              check (status in ('open','answered','skipped','never')),
  created_at  timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists public.lamy_events (
  id          bigserial primary key,
  user_id     text not null,
  kind        text not null,
  detail      text not null,
  at          timestamptz not null default now()
);

create index if not exists lamy_bank_user  on public.lamy_bank (user_id);
create index if not exists lamy_roles_user on public.lamy_roles (user_id);
create index if not exists lamy_asks_user  on public.lamy_asks (user_id, status);

-- Demo persona. Deliberately NOT Keith's real history: this is synthetic so
-- the slice can be tested and reset without touching anyone's actual data.
delete from public.lamy_bank  where user_id = 'demo';
delete from public.lamy_roles where user_id = 'demo';
delete from public.lamy_asks  where user_id = 'demo';

insert into public.lamy_bank (user_id, claim, metric, tags, state, source) values
  ('demo','Rebuilt the onboarding email sequence end to end; activation rose 18% over six weeks','18%','{growth,lifecycle,email}','confirmed','user:interview 2026-09-01'),
  ('demo','Ran paid social for a D2C brand and cut CAC from EUR 42 to EUR 27','EUR 42 to 27','{paid,growth,d2c}','confirmed','user:interview 2026-09-01'),
  ('demo','Built an internal reporting dashboard in Next.js reading Postgres directly',null,'{engineering,analytics}','confirmed','user:interview 2026-09-01'),
  ('demo','Led a team of four marketers',null,'{leadership}','inferred','cv-extract:2026-09-01');

insert into public.lamy_roles (user_id, title, company, archetype, must_haves, jd) values
  ('demo','Growth Marketer','Amsterdam D2C','quantified_operator',
   '{CAC reduction,lifecycle email,team leadership,SQL}',
   'Own paid and lifecycle for a fast growing D2C brand. You will be accountable for CAC, run the email programme, and lead a small team. Comfortable in SQL.');

-- Lamy multi-user identity slice (2026-09-04).
-- lamy_users: one row per human. lamy_identities: how a channel's sender id
-- (Slack user U..., later Telegram chat id) maps to that human. The mapping is
-- written by CODE (auto-provision on first contact), never chosen by the model.
create table if not exists lamy_users (
  id text primary key,
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists lamy_identities (
  channel text not null,            -- 'slack' | 'telegram' | ...
  channel_user_id text not null,    -- e.g. Slack U0BDT8HUSC9
  user_id text not null references lamy_users(id),
  created_at timestamptz not null default now(),
  primary key (channel, channel_user_id)
);

-- The synthetic terminal persona keeps working unchanged.
insert into lamy_users (id, display_name)
  values ('demo', 'Demo persona (synthetic)')
  on conflict (id) do nothing;

-- Per-user Google linkage (2026-09-04): remember each user's Google email and
-- their sheet/folder ids so the agent never re-asks, and the background sheet
-- sync knows what to reconcile. Set through lamy__me / recorded at creation.
alter table lamy_users add column if not exists google_email text;
alter table lamy_users add column if not exists sheet_id text;
alter table lamy_users add column if not exists folder_id text;

-- Interview mode (2026-09-04): a bank entry can carry a full STAR story.
-- The bank stays the ONE product — a story is not a separate object, it is a
-- bank entry with context (situation/task/action/result), so the integrity
-- gate, confirmation discipline, and fit scoring apply to stories unchanged.
alter table lamy_bank add column if not exists story jsonb;

-- What was actually SENT, frozen at the moment of sending.
-- The bank keeps changing; an application must not. Without this, editing a
-- bullet next week silently rewrites the history of what an employer already
-- read, and the outcome label can never be tied back to a real decision.
create table if not exists public.lamy_applications (
  id             bigserial primary key,
  user_id        text not null,
  role_id        bigint not null references public.lamy_roles(id) on delete cascade,
  -- the exact bullets sent, and the bank rows they came from, as they read
  -- THEN. jsonb, not a join, precisely so later edits cannot rewrite history.
  bullets        jsonb not null default '[]'::jsonb,
  bank_ids       bigint[] not null default '{}',
  fit_at_submit  integer,
  status         text not null default 'prepared'
                 check (status in ('prepared','submitted','replied','interview','offer','rejected','silence')),
  outcome_note   text,
  created_at     timestamptz not null default now(),
  submitted_at   timestamptz
);

create index if not exists lamy_apps_user on public.lamy_applications (user_id, status);
create index if not exists lamy_apps_role on public.lamy_applications (role_id);

-- Where a role came from, so sourcing provenance survives too.
alter table public.lamy_roles add column if not exists source_url text;
alter table public.lamy_roles add column if not exists sourced_via text;

-- Outreach quota ledger (2026-09-04). One row per outreach action actually
-- taken (connect request or message), written by lamy__outreach log in code.
-- The adaptive daily cap is COMPUTED from this history at ask time — never
-- stored — inside a hard ceiling of 10/day that no signal can raise.
create table if not exists lamy_outreach (
  id bigint generated always as identity primary key,
  user_id text not null,
  kind text not null check (kind in ('connect','message')),
  target text not null,
  at timestamptz not null default now()
);
create index if not exists lamy_outreach_user_day on lamy_outreach (user_id, at);

-- Set true the moment a LinkedIn warning/restriction is ever seen on the
-- account; the cap logic then stays conservative until a human clears it.
alter table lamy_users add column if not exists linkedin_restricted boolean not null default false;

-- Atomic outreach gate (2026-09-04). The first TS implementation counted then
-- inserted in two steps; a model firing tool calls in PARALLEL raced straight
-- past the cap (4 inserts in 600ms against a cap of 3, observed live). The
-- count+insert now happens inside one transaction under a per-user advisory
-- lock, so concurrency cannot breach the ceiling no matter how calls arrive.
create or replace function lamy_outreach_log(
  p_user text, p_kind text, p_target text, p_cap int
) returns jsonb language plpgsql as $$
declare v_used int;
begin
  perform pg_advisory_xact_lock(hashtext('lamy_outreach_' || p_user));
  select count(*) into v_used from lamy_outreach
    where user_id = p_user and at >= date_trunc('day', now());
  if v_used >= p_cap then
    return jsonb_build_object('allowed', false, 'used', v_used);
  end if;
  insert into lamy_outreach (user_id, kind, target)
    values (p_user, p_kind, p_target);
  return jsonb_build_object('allowed', true, 'used', v_used + 1);
end $$;

-- Extension-worker slice (2026-09-04). The browser extension is HANDS ONLY:
-- Lamy queues actions here, the extension leases them one at a time and
-- reports results. All decisions (caps, gating, what to queue) stay server
-- side; the extension executes and observes.
create table if not exists lamy_worker_queue (
  id bigint generated always as identity primary key,
  user_id text not null references lamy_users(id),
  kind text not null,               -- fetch_job | connect | message
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued',
  -- queued | leased | done | failed | processed
  result jsonb,
  created_at timestamptz not null default now(),
  leased_at timestamptz,
  finished_at timestamptz
);
create index if not exists lamy_worker_queue_user_status
  on lamy_worker_queue (user_id, status);

-- Long-lived pairing token for the extension (per user, revocable by
-- overwriting). NOT the magic link: links expire in two weeks, a worker
-- should not.
alter table lamy_users add column if not exists worker_token text;

-- Atomic lease: exactly one queued item flips to leased, oldest first.
-- Guarded-write pattern as a function because PostgREST PATCH cannot
-- order/limit. A leased item older than 10 minutes is considered abandoned
-- and re-leasable (extension died mid-action).
create or replace function lamy_worker_lease(p_user text)
returns setof lamy_worker_queue language plpgsql as $$
begin
  return query
  update lamy_worker_queue q
     set status = 'leased', leased_at = now()
   where q.id = (
     select id from lamy_worker_queue
      where user_id = p_user
        and (status = 'queued'
             or (status = 'leased' and leased_at < now() - interval '10 minutes'))
      order by id
      limit 1
      for update skip locked
   )
  returning *;
end $$;

-- v2 (same day): the extension declares which kinds it can execute at lease
-- time, so an outreach action is never leased (and the cap never spent) by a
-- worker version that cannot perform it.
drop function if exists lamy_worker_lease(text);
create or replace function lamy_worker_lease(p_user text, p_kinds text[])
returns setof lamy_worker_queue language plpgsql as $$
begin
  return query
  update lamy_worker_queue q
     set status = 'leased', leased_at = now()
   where q.id = (
     select id from lamy_worker_queue
      where user_id = p_user
        and kind = any(p_kinds)
        and (status = 'queued'
             or (status = 'leased' and leased_at < now() - interval '10 minutes'))
      order by id
      limit 1
      for update skip locked
   )
  returning *;
end $$;

