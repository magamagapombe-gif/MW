-- Phase 5: SACCO + referral tiers + weekly leaderboard

-- Referral career tiers (monthly salary based on active referrals)
create table if not exists public.referral_tiers (
  id              text primary key,
  display_name    text not null,
  emoji           text,
  min_referrals   int not null,
  monthly_salary  bigint not null,
  sort_order      int not null
);

insert into public.referral_tiers (id, display_name, emoji, min_referrals, monthly_salary, sort_order) values
  ('bronze',   'Bronze',   '🥉',  10,  50000, 1),
  ('silver',   'Silver',   '🥈',  25, 150000, 2),
  ('gold',     'Gold',     '🥇',  50, 350000, 3),
  ('platinum', 'Platinum', '💎', 100, 800000, 4),
  ('diamond',  'Diamond',  '💠', 250,2000000, 5)
on conflict (id) do update set
  display_name=excluded.display_name, emoji=excluded.emoji,
  min_referrals=excluded.min_referrals, monthly_salary=excluded.monthly_salary,
  sort_order=excluded.sort_order;

alter table public.referral_tiers enable row level security;
drop policy if exists "referral_tiers_public_read" on public.referral_tiers;
create policy "referral_tiers_public_read" on public.referral_tiers for select using (true);

-- RPC: count active referrals for current user
create or replace function my_active_referrals_count()
returns int as $$
declare c int;
begin
  select count(*) into c from public.profiles
  where referred_by = auth.uid() and is_active = true;
  return coalesce(c, 0);
end;
$$ language plpgsql security definer;

-- RPC: weekly leaderboard (top referrers this calendar week, Mon-Sun Kampala)
create or replace function weekly_leaderboard()
returns table(user_id uuid, full_name text, referrals int) as $$
begin
  return query
  select
    p.referred_by as user_id,
    pr.full_name,
    count(*)::int as referrals
  from public.profiles p
  join public.profiles pr on pr.id = p.referred_by
  where p.is_active = true
    and p.referred_by is not null
    and p.created_at >= date_trunc('week', now() at time zone 'Africa/Kampala') at time zone 'Africa/Kampala'
  group by p.referred_by, pr.full_name
  order by referrals desc
  limit 10;
end;
$$ language plpgsql security definer;

-- RPC: SACCO purchase (atomic: deduct balance, create investment)
create or replace function purchase_sacco(p_plan_id text, p_amount bigint)
returns json as $$
declare
  v_user uuid := auth.uid();
  v_profile record;
  v_plan record;
  v_profit bigint;
  v_matures_at timestamptz;
  v_inv_id uuid;
  v_ref text;
begin
  if v_user is null then return json_build_object('error', 'Unauthorized'); end if;

  select * into v_profile from public.profiles where id = v_user;
  if not found then return json_build_object('error', 'Profile not found'); end if;
  if not v_profile.is_active then return json_build_object('error', 'Activate your account first'); end if;

  select * into v_plan from public.sacco_plans where id = p_plan_id and is_active = true;
  if not found then return json_build_object('error', 'Plan not found'); end if;

  if p_amount < v_plan.min_amount or p_amount > v_plan.max_amount then
    return json_build_object('error', format('Amount must be between UGX %s and UGX %s', v_plan.min_amount, v_plan.max_amount));
  end if;

  if v_profile.balance < p_amount then
    return json_build_object('error', 'Insufficient deposit balance. Top up via Deposit.');
  end if;

  -- Only one active SACCO at a time
  if exists(select 1 from public.sacco_investments where user_id = v_user and status = 'active') then
    return json_build_object('error', 'You already have an active SACCO. Wait for it to mature.');
  end if;

  v_profit := round(p_amount * v_plan.return_rate);
  v_matures_at := now() + (v_plan.duration_days || ' days')::interval;
  v_ref := concat('MWSAC', replace(v_user::text, '-', ''), extract(epoch from now())::bigint);
  v_ref := substring(v_ref, 1, 30);

  -- Atomic: deduct + insert
  update public.profiles set balance = balance - p_amount, updated_at = now() where id = v_user;

  insert into public.sacco_investments (user_id, plan_id, amount, profit, matures_at)
  values (v_user, p_plan_id, p_amount, v_profit, v_matures_at)
  returning id into v_inv_id;

  insert into public.transactions (user_id, type, amount, category, status, reference, description)
  values (v_user, 'sacco_deposit', p_amount, 'balance', 'completed', v_ref,
          format('SACCO %s — matures in %s days', v_plan.display_name, v_plan.duration_days));

  return json_build_object(
    'success', true,
    'investment_id', v_inv_id,
    'amount', p_amount,
    'profit', v_profit,
    'matures_at', v_matures_at
  );
end;
$$ language plpgsql security definer;

-- RPC: SACCO withdraw on/after maturity (Mondays only, Kampala time)
create or replace function withdraw_sacco(p_investment_id uuid)
returns json as $$
declare
  v_user uuid := auth.uid();
  v_inv record;
  v_total bigint;
  v_dow int;
  v_ref text;
begin
  if v_user is null then return json_build_object('error', 'Unauthorized'); end if;

  select * into v_inv from public.sacco_investments
  where id = p_investment_id and user_id = v_user;
  if not found then return json_build_object('error', 'Investment not found'); end if;
  if v_inv.status <> 'active' then return json_build_object('error', 'Already withdrawn'); end if;
  if v_inv.matures_at > now() then return json_build_object('error', 'Not matured yet'); end if;

  v_dow := extract(dow from (now() at time zone 'Africa/Kampala'));
  if v_dow <> 1 then
    return json_build_object('error', 'SACCO withdrawals only allowed on Mondays (Kampala time)');
  end if;

  v_total := v_inv.amount + v_inv.profit;
  v_ref := concat('MWSACWD', replace(v_user::text, '-', ''), extract(epoch from now())::bigint);
  v_ref := substring(v_ref, 1, 30);

  update public.sacco_investments
  set status = 'matured', matured_at = now()
  where id = p_investment_id;

  update public.profiles
  set sacco_earnings = sacco_earnings + v_total, updated_at = now()
  where id = v_user;

  insert into public.transactions (user_id, type, amount, category, status, reference, description)
  values (v_user, 'sacco_maturity', v_total, 'sacco_earnings', 'completed', v_ref,
          format('SACCO matured: principal %s + profit %s', v_inv.amount, v_inv.profit));

  return json_build_object('success', true, 'credited', v_total);
end;
$$ language plpgsql security definer;
