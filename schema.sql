-- =====================================================
-- MW App - Supabase Database Schema
-- Run this in the Supabase SQL Editor
-- =====================================================

-- Profiles table (extends auth.users)
create table if not exists public.profiles (
  id              uuid references auth.users(id) on delete cascade primary key,
  full_name       text not null,
  email           text not null,
  phone_number    text unique not null,
  network         text not null check (network in ('MTN', 'AIRTEL')),
  referral_code   text unique,
  referred_by     uuid references public.profiles(id) on delete set null,
  balance         bigint not null default 0 check (balance >= 0),
  is_active       boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Transactions table
create table if not exists public.transactions (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid references public.profiles(id) on delete cascade not null,
  type                  text not null check (type in ('registration', 'referral_bonus', 'withdrawal')),
  amount                bigint not null,
  status                text not null default 'pending' check (status in ('pending', 'completed', 'failed')),
  reference             text unique not null,
  livepay_transaction_id text,
  description           text,
  created_at            timestamptz not null default now()
);

-- =====================================================
-- Auto-generate referral code on profile insert
-- =====================================================

create or replace function generate_referral_code()
returns text as $$
declare
  chars  text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  result text := 'MW';
  i      int;
begin
  for i in 1..6 loop
    result := result || substr(chars, floor(random() * length(chars) + 1)::int, 1);
  end loop;
  return result;
end;
$$ language plpgsql;

create or replace function set_referral_code()
returns trigger as $$
declare
  new_code    text;
  code_exists boolean;
begin
  if new.referral_code is null or new.referral_code = '' then
    loop
      new_code := generate_referral_code();
      select exists(select 1 from public.profiles where referral_code = new_code) into code_exists;
      exit when not code_exists;
    end loop;
    new.referral_code := new_code;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists before_profile_insert on public.profiles;
create trigger before_profile_insert
  before insert on public.profiles
  for each row
  execute function set_referral_code();

-- =====================================================
-- Increment balance function (used by webhook)
-- =====================================================

create or replace function increment_balance(p_user_id uuid, p_amount bigint)
returns void as $$
begin
  update public.profiles
  set balance = balance + p_amount, updated_at = now()
  where id = p_user_id;
end;
$$ language plpgsql security definer;

-- =====================================================
-- Row Level Security
-- =====================================================

alter table public.profiles enable row level security;
alter table public.transactions enable row level security;

-- Profiles: users can only view and update their own record
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- Transactions: users can only view their own
drop policy if exists "transactions_select_own" on public.transactions;
create policy "transactions_select_own" on public.transactions
  for select using (auth.uid() = user_id);

-- =====================================================
-- Allow looking up referral codes publicly (for validation)
-- =====================================================
drop policy if exists "referral_code_lookup" on public.profiles;
create policy "referral_code_lookup" on public.profiles
  for select using (true);  -- we expose only referral_code via a view below

-- Drop overly-broad policy and replace with restricted view
drop policy if exists "referral_code_lookup" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

-- Public referral code check via a function (RPC) - bypasses RLS
create or replace function check_referral_code(p_code text)
returns boolean as $$
begin
  return exists(
    select 1 from public.profiles
    where upper(referral_code) = upper(p_code) and is_active = true
  );
end;
$$ language plpgsql security definer;

-- =====================================================
-- Enable Realtime (run in Supabase Dashboard > Realtime)
-- Or uncomment below:
-- =====================================================
-- alter publication supabase_realtime add table public.transactions;
-- alter publication supabase_realtime add table public.profiles;
