-- Phase 4: Tasks engine schema additions

-- Remove wrong unique constraint from Phase 1 migration if present
alter table public.task_completions drop constraint if exists task_completions_user_id_task_id_completed_at_key;

-- Add admin flag to profiles (optional — for you to manage tasks)
alter table public.profiles
  add column if not exists is_admin boolean not null default false;

-- Seed 6 sample tasks so users can test (admin can add/edit more later)
insert into public.tasks (title, description, task_type, url, duration_sec, reward, min_plan_order, is_active) values
  ('Welcome video',       'Watch a short video about MW',           'youtube', 'https://www.youtube.com/embed/dQw4w9WgXcQ', 30,  450, 0, true),
  ('Read: Mobile money',  'Read this quick article',                'read',    null,                                        45,  600, 0, true),
  ('Follow on TikTok',    'Follow and watch 30s',                   'tiktok',  'https://www.tiktok.com',                    30,  800, 1, true),
  ('Subscribe channel',   'Subscribe to our YouTube',               'subscribe','https://www.youtube.com',                  20, 1000, 2, true),
  ('Intro video 2',       'Another video',                          'youtube', 'https://www.youtube.com/embed/dQw4w9WgXcQ', 30,  450, 0, true),
  ('Read: Vault plans',   'Learn about plan tiers',                 'read',    null,                                        60,  600, 0, true)
on conflict do nothing;

-- RPC: get today's completed count for this user (security definer so it works with RLS)
create or replace function my_today_task_count()
returns int as $$
declare c int;
begin
  select count(*) into c
  from public.task_completions
  where user_id = auth.uid()
    and completed_at >= date_trunc('day', now() at time zone 'Africa/Kampala') at time zone 'Africa/Kampala';
  return coalesce(c, 0);
end;
$$ language plpgsql security definer;
