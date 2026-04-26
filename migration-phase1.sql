-- =====================================================
-- MW — Phase 1 Migration
-- Adds: balance categories, vault plans, tasks, SACCO
-- Run in Supabase SQL Editor
-- =====================================================

-- ── 1. Extend profiles with new balance categories and plan info ──
alter table public.profiles
  add column if not exists task_earnings         bigint not null default 0 check (task_earnings >= 0),
  add column if not exists referral_earnings     bigint not null default 0 check (referral_earnings >= 0),
  add column if not exists sacco_earnings        bigint not null default 0 check (sacco_earnings >= 0),
  add column if not exists vault_plan_id         text,
  add column if not exists vault_activated_at    timestamptz,
  add column if not exists early_bird_expires_at timestamptz;

-- Note: the existing `balance` column becomes the "deposit wallet" (funds from deposits, spent on vault/SACCO)
-- Existing `balance` renamed conceptually as "deposit balance" — we keep the column name for backward compat.

-- ── 2. Extend transactions: new types + category + fee tracking ──
-- Drop old check constraint, add wider one
alter table public.transactions drop constraint if exists transactions_type_check;
alter table public.transactions add constraint transactions_type_check check (
  type in (
    'registration',
    'referral_bonus',
    'withdrawal',
    'deposit',
    'vault_purchase',
    'task_reward',
    'sacco_deposit',
    'sacco_maturity',
    'referral_level_2'
  )
);

alter table public.transactions
  add column if not exists category  text,  -- 'balance'|'task_earnings'|'referral_earnings'|'sacco_earnings'
  add column if not exists fee       bigint not null default 0;

-- ── 3. Vault plans catalog ──
create table if not exists public.vault_plans (
  id              text primary key,  -- e.g. 'beginner','seed','rising',...
  display_name    text not null,
  emoji           text,
  price           bigint not null,
  tasks_per_day   int not null,
  ugx_per_task    int not null,
  monthly_est     bigint not null,
  sort_order      int not null,
  is_active       boolean not null default true
);

-- Seed with VaultPro tiers + our Early Bird
insert into public.vault_plans (id, display_name, emoji, price, tasks_per_day, ugx_per_task, monthly_est, sort_order) values
  ('early_bird',  'Early Bird',        '🐣',          0, 1,   450,    13500, 0),
  ('beginner',    'Beginner',          '🌱',      45000, 1,   450,    13500, 1),
  ('seed',        'Seed',              '🌱',     180000, 3,   600,    54000, 2),
  ('rising',      'Rising',            '🌅',     600000, 6,  3333,   180000, 3),
  ('nova',        'Nova',              '💡',    1350000, 11, 4091,   405000, 4),
  ('mastermind',  'Mastermind',        '🧠',    4050000, 18, 7500,  1215000, 5),
  ('titan',       'Titan',             '💪',    8775000, 25, 11700, 2632500, 6),
  ('king',        'King',              '👑',   16650000, 34, 16307, 4995000, 7),
  ('emperor',     'Emperor',           '🦅',   29700000, 44, 22500, 8910000, 8),
  ('icon',        'Icon',              '⭐',   48600000, 55, 29455, 14580000, 9),
  ('supreme',     'Supreme',           '👑',   74250000, 66, 37502, 22275000, 10),
  ('legendary',   'Legendary',         '🏆',  110000000, 75, 48888, 33000000, 11)
on conflict (id) do update set
  display_name  = excluded.display_name,
  emoji         = excluded.emoji,
  price         = excluded.price,
  tasks_per_day = excluded.tasks_per_day,
  ugx_per_task  = excluded.ugx_per_task,
  monthly_est   = excluded.monthly_est,
  sort_order    = excluded.sort_order;

-- ── 4. Tasks catalog (admin-managed) ──
create table if not exists public.tasks (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  description     text,
  task_type       text not null check (task_type in ('youtube','read','tiktok','subscribe')),
  url             text,
  duration_sec    int not null default 30,
  reward          int not null,
  min_plan_order  int not null default 0,  -- which plan tier unlocks (0 = early bird)
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);

-- ── 5. Task completion log ──
create table if not exists public.task_completions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references public.profiles(id) on delete cascade not null,
  task_id       uuid references public.tasks(id) on delete cascade not null,
  reward        int not null,
  completed_at  timestamptz not null default now(),
  unique (user_id, task_id, completed_at)  -- soft guard; real daily-unique logic in edge fn
);

create index if not exists idx_task_completions_user_date on public.task_completions(user_id, completed_at);

-- ── 6. SACCO plans catalog ──
create table if not exists public.sacco_plans (
  id            text primary key,
  display_name  text not null,
  min_amount    bigint not null,
  max_amount    bigint not null,
  duration_days int not null,
  return_rate   numeric(5,4) not null,  -- e.g. 0.1500 = 15%
  sort_order    int not null,
  is_active     boolean not null default true
);

-- Seed with reasonable defaults (adjust prices later)
insert into public.sacco_plans (id, display_name, min_amount, max_amount, duration_days, return_rate, sort_order) values
  ('sacco_t1', 'Starter',    10000,   100000, 7,  0.05,  1),
  ('sacco_t2', 'Bronze',    100000,   500000, 14, 0.08,  2),
  ('sacco_t3', 'Silver',    500000,  2000000, 21, 0.12,  3),
  ('sacco_t4', 'Gold',     2000000,  5000000, 30, 0.18,  4),
  ('sacco_t5', 'Platinum', 5000000, 20000000, 60, 0.28,  5),
  ('sacco_t6', 'Diamond', 20000000,100000000, 90, 0.45,  6)
on conflict (id) do update set
  display_name  = excluded.display_name,
  min_amount    = excluded.min_amount,
  max_amount    = excluded.max_amount,
  duration_days = excluded.duration_days,
  return_rate   = excluded.return_rate;

-- ── 7. SACCO investments ──
create table if not exists public.sacco_investments (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references public.profiles(id) on delete cascade not null,
  plan_id      text references public.sacco_plans(id) not null,
  amount       bigint not null,
  profit       bigint not null,   -- pre-calculated at time of purchase
  matures_at   timestamptz not null,
  status       text not null default 'active' check (status in ('active','matured','withdrawn')),
  created_at   timestamptz not null default now(),
  matured_at   timestamptz
);

create index if not exists idx_sacco_investments_user on public.sacco_investments(user_id, status);

-- ── 8. RLS on new tables ──
alter table public.vault_plans        enable row level security;
alter table public.tasks              enable row level security;
alter table public.task_completions   enable row level security;
alter table public.sacco_plans        enable row level security;
alter table public.sacco_investments  enable row level security;

-- Public read for plan/task catalogs
drop policy if exists "vault_plans_public_read" on public.vault_plans;
create policy "vault_plans_public_read" on public.vault_plans
  for select using (true);

drop policy if exists "tasks_public_read" on public.tasks;
create policy "tasks_public_read" on public.tasks
  for select using (is_active = true);

drop policy if exists "sacco_plans_public_read" on public.sacco_plans;
create policy "sacco_plans_public_read" on public.sacco_plans
  for select using (true);

-- Users see only their own completions & investments
drop policy if exists "task_completions_own" on public.task_completions;
create policy "task_completions_own" on public.task_completions
  for select using (auth.uid() = user_id);

drop policy if exists "sacco_investments_own" on public.sacco_investments;
create policy "sacco_investments_own" on public.sacco_investments
  for select using (auth.uid() = user_id);

-- ── 9. Balance manipulation helpers (atomic, security-definer) ──
create or replace function increment_category(
  p_user_id  uuid,
  p_category text,    -- 'balance' | 'task_earnings' | 'referral_earnings' | 'sacco_earnings'
  p_amount   bigint
) returns void as $$
begin
  if p_category = 'balance' then
    update public.profiles set balance = balance + p_amount, updated_at = now() where id = p_user_id;
  elsif p_category = 'task_earnings' then
    update public.profiles set task_earnings = task_earnings + p_amount, updated_at = now() where id = p_user_id;
  elsif p_category = 'referral_earnings' then
    update public.profiles set referral_earnings = referral_earnings + p_amount, updated_at = now() where id = p_user_id;
  elsif p_category = 'sacco_earnings' then
    update public.profiles set sacco_earnings = sacco_earnings + p_amount, updated_at = now() where id = p_user_id;
  else
    raise exception 'Unknown category: %', p_category;
  end if;
end;
$$ language plpgsql security definer;

-- Keep the old increment_balance for backward compat (used by existing webhook)
create or replace function increment_balance(p_user_id uuid, p_amount bigint)
returns void as $$
begin
  perform increment_category(p_user_id, 'balance', p_amount);
end;
$$ language plpgsql security definer;

-- ── 10. Set early_bird_expires_at on activation ──
-- We don't use a trigger here because the webhook sets it directly.
-- But let's backfill any currently-active users who don't have it set.
update public.profiles
set early_bird_expires_at = coalesce(early_bird_expires_at, now() + interval '30 days'),
    vault_plan_id         = coalesce(vault_plan_id, 'early_bird')
where is_active = true and early_bird_expires_at is null;
