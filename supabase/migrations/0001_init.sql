-- line-msg-v2 — initial schema
-- Target: Supabase Postgres 17 (project eapfzpscuxqsdrwctwbp)
-- Idempotent: safe to run repeatedly.
--
-- Design decisions this encodes (from .scratch/line-msg-v2/issues/03-...):
--   * quota is consumed per RECIPIENT, so member_count is the multiplier
--   * guard cuts only when "sending would exceed", no reserve buffer
--   * scheduler = pg_cron every minute reading send times from this DB
--   * two separate logs: send_logs (per push) and system_logs (background/errors)
--   * all times stored UTC; business logic uses Asia/Bangkok

create extension if not exists pgcrypto;   -- gen_random_uuid(), crypt(), gen_salt()
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- ---------------------------------------------------------------- app_settings
-- Single-row-per-key store. Holds the web login password hash so the password
-- can be changed from the UI without a redeploy (ticket 03, หมวด C).
-- NOTE: the pg_cron shared secret and LINE tokens live in Vercel env vars,
-- NOT here.
create table if not exists app_settings (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------- groups
-- line_group_id comes from a LINE webhook `join` event (ticket 09) or is typed
-- in by hand. status starts as 'pending' until a human confirms in the UI.
create table if not exists groups (
  id                       uuid primary key default gen_random_uuid(),
  line_group_id            text not null unique,
  name                     text,
  status                   text not null default 'pending',
  member_count             integer,
  member_count_checked_at  timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint groups_status_check
    check (status in ('pending', 'active', 'inactive')),
  constraint groups_member_count_check
    check (member_count is null or member_count >= 0)
);

create index if not exists groups_status_idx on groups (status);

-- ------------------------------------------------------------ message_template
-- ticket 03 หมวด F: one message body shared by both send times, editable later
-- from the web UI. Kept as its own table so send_logs can reference which
-- version was actually sent.
create table if not exists message_templates (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  body        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint message_templates_body_check
    check (length(btrim(body)) > 0),
  -- LINE text message hard limit
  constraint message_templates_body_len_check
    check (length(body) <= 5000)
);

-- ------------------------------------------------------------------- schedules
-- send_at_local is Asia/Bangkok wall-clock. The every-minute tick compares it
-- against now() in Asia/Bangkok, so editing this row takes effect immediately
-- with no cron reschedule (ticket 03 หมวด E).
create table if not exists schedules (
  id             uuid primary key default gen_random_uuid(),
  group_id       uuid not null references groups (id) on delete cascade,
  message_id     uuid not null references message_templates (id) on delete restrict,
  send_at_local  time not null,
  weekdays_only  boolean not null default true,
  enabled        boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint schedules_group_time_unique unique (group_id, send_at_local)
);

create index if not exists schedules_enabled_idx on schedules (enabled) where enabled;

-- ------------------------------------------------------------------- send_logs
-- One row per send ATTEMPT, including the ones we deliberately skip. status
-- must always be written so the UI can explain silence (ticket 03 หมวด D).
--
-- schedule_id is null for manual sends from the control panel.
-- message_body is a snapshot: editing the template must not rewrite history.
create table if not exists send_logs (
  id                  bigint generated always as identity primary key,
  schedule_id         uuid references schedules (id) on delete set null,
  group_id            uuid not null references groups (id) on delete cascade,
  trigger_source      text not null,
  message_body        text not null,
  status              text not null,
  recipients_count    integer,
  quota_limit         integer,
  quota_used_before   integer,
  line_status_code    integer,
  line_request_id     text,
  retry_key           uuid,
  error_detail        text,
  response_raw        jsonb,
  created_at          timestamptz not null default now(),
  -- Bangkok calendar day of the attempt, used for the once-per-day guard below.
  sent_on_local date generated always as
    (((created_at at time zone 'Asia/Bangkok'))::date) stored,
  constraint send_logs_status_check check (status in (
    'sent',
    'skipped_quota',
    'skipped_weekend',
    'skipped_disabled',
    'skipped_duplicate',
    'failed'
  )),
  constraint send_logs_trigger_source_check
    check (trigger_source in ('cron', 'manual')),
  constraint send_logs_recipients_check
    check (recipients_count is null or recipients_count >= 0)
);

-- Double-send guard: a given schedule may succeed at most once per Bangkok day.
-- Partial index so retries after a skip/failure are still allowed.
create unique index if not exists send_logs_schedule_day_unique
  on send_logs (schedule_id, sent_on_local)
  where status = 'sent' and schedule_id is not null;

create index if not exists send_logs_created_at_idx on send_logs (created_at desc);
create index if not exists send_logs_group_idx on send_logs (group_id, created_at desc);

-- ----------------------------------------------------------------- system_logs
-- Background/diagnostic events, separate from send_logs (user's addition in
-- ticket 03 หมวด D): cron ticks, LINE API failures, webhook events, auth events.
create table if not exists system_logs (
  id          bigint generated always as identity primary key,
  level       text not null,
  event       text not null,
  detail      jsonb,
  created_at  timestamptz not null default now(),
  constraint system_logs_level_check check (level in ('debug', 'info', 'warn', 'error'))
);

create index if not exists system_logs_created_at_idx on system_logs (created_at desc);
create index if not exists system_logs_level_idx on system_logs (level, created_at desc);

-- ------------------------------------------------------------ quota_snapshots
-- History of GET /message/quota + /quota/consumption so the UI can draw a burn
-- rate and project the exhaustion date without re-hitting LINE on every render.
-- quota_limit is null when quota_type = 'none' (unlimited) — ticket 01 says
-- `value` is optional.
create table if not exists quota_snapshots (
  id           bigint generated always as identity primary key,
  quota_type   text not null,
  quota_limit  integer,
  total_usage  integer not null,
  checked_at   timestamptz not null default now(),
  constraint quota_snapshots_usage_check check (total_usage >= 0)
);

create index if not exists quota_snapshots_checked_at_idx
  on quota_snapshots (checked_at desc);

-- ------------------------------------------------------------------ updated_at
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['app_settings', 'groups', 'message_templates', 'schedules']
  loop
    execute format('drop trigger if exists %I on %I', t || '_set_updated_at', t);
    execute format(
      'create trigger %I before update on %I
         for each row execute function set_updated_at()',
      t || '_set_updated_at', t
    );
  end loop;
end;
$$;

-- ------------------------------------------------------------------------- RLS
-- Every table is RLS-enabled with NO policies. That denies anon and
-- authenticated outright; only the service_role key (used server-side by the
-- Vercel API) bypasses RLS. The browser never talks to Postgres directly.
do $$
declare
  t text;
begin
  foreach t in array array[
    'app_settings', 'groups', 'message_templates', 'schedules',
    'send_logs', 'system_logs', 'quota_snapshots'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
  end loop;
end;
$$;
