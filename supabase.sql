create table if not exists bot_state (
  key text primary key,
  value text not null,
  updated_at timestamptz default now()
);

insert into bot_state (key, value)
values
  ('last_seen_tweet_id', '0'),
  ('last_public_price_post_at', '0'),
  ('last_significant_pulse_price', '0')
on conflict (key) do nothing;

create table if not exists processed_tweets (
  tweet_id text primary key,
  processed_at timestamptz default now()
);

create table if not exists alerts (
  id uuid primary key default gen_random_uuid(),
  x_user_id text not null,
  x_username text not null,
  source_tweet_id text not null,
  alert_metric text not null default 'price',
  direction text not null check (direction in ('above', 'below')),
  target_price numeric not null,
  triggered boolean default false,
  trigger_claimed_at timestamptz,
  created_at timestamptz default now(),
  triggered_at timestamptz
);

alter table alerts
add column if not exists trigger_claimed_at timestamptz;

alter table alerts
add column if not exists alert_metric text not null default 'price';

drop index if exists alerts_active_idx;

create index alerts_active_idx
on alerts (triggered, alert_metric, direction, target_price);

create index if not exists alerts_user_active_idx
on alerts (x_user_id, triggered, created_at desc);

drop index if exists alerts_no_duplicate_active_idx;

create unique index alerts_no_duplicate_active_idx
on alerts (x_user_id, alert_metric, direction, target_price)
where triggered = false;
