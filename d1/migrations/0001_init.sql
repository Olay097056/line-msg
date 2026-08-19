-- line-msg — D1 (SQLite) schema
-- Target: Cloudflare D1 (SQLite). Translated from supabase/migrations/0001_init.sql
-- (Postgres) per .scratch/line-msg-v2/cloudflare-migration (research 2026-08-18).
--
-- Changes vs Postgres original:
--   * timestamptz -> TEXT (ISO 8601 UTC, e.g. 2026-08-18T07:15:00.000Z); business
--     logic computes Asia/Bangkok in app code (time.ts bangkokClock).
--   * uuid + gen_random_uuid() -> TEXT PK filled by app (crypto.randomUUID()).
--   * bigint generated identity -> INTEGER PRIMARY KEY AUTOINCREMENT.
--   * jsonb -> TEXT holding a JSON string (validated/parsed in app code).
--   * time -> TEXT 'HH:MM:SS' (send_at_local stays "wall-clock" Asia/Bangkok).
--   * RLS dropped (D1 has no row-level security; access only via binding).
--   * PLPGSQL updated_at trigger -> SQLite trigger using datetime('now').
--   * duplicate-send guard: partial unique index preserved (D1 supports
--     partial indexes) — the one behavior the code depends on.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- app_settings
-- Single-row-per-key store. Holds the web login password hash.
create table if not exists app_settings (
  key        text primary key,
  value      text not null,
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------- groups
create table if not exists groups (
  id                      text primary key,
  line_group_id           text not null unique,
  name                    text,
  status                  text not null default 'pending',
  member_count            integer,
  member_count_checked_at text,
  created_at              text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at              text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  constraint groups_status_check
    check (status in ('pending', 'active', 'inactive')),
  constraint groups_member_count_check
    check (member_count is null or member_count >= 0)
);
create index if not exists groups_status_idx on groups (status);

-- ------------------------------------------------------------ message_templates
create table if not exists message_templates (
  id         text primary key,
  name       text not null,
  body       text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  constraint message_templates_body_check check (length(trim(body)) > 0),
  constraint message_templates_body_len_check check (length(body) <= 5000)
);

-- ------------------------------------------------------------------- schedules
create table if not exists schedules (
  id            text primary key,
  group_id      text not null references groups (id) on delete cascade,
  message_id    text not null references message_templates (id) on delete restrict,
  send_at_local text not null,
  weekdays_only integer not null default 1,
  enabled       integer not null default 1,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  constraint schedules_group_time_unique unique (group_id, send_at_local)
);
create index if not exists schedules_enabled_idx on schedules (enabled) where enabled = 1;

-- ------------------------------------------------------------------- send_logs
-- schedule_id is null for manual sends. message_body is a snapshot.
create table if not exists send_logs (
  id                integer primary key autoincrement,
  schedule_id       text references schedules (id) on delete set null,
  group_id          text not null references groups (id) on delete cascade,
  trigger_source    text not null,
  message_body      text not null,
  status            text not null,
  recipients_count  integer,
  quota_limit       integer,
  quota_used_before integer,
  line_status_code  integer,
  line_request_id   text,
  retry_key         text,
  error_detail      text,
  response_raw      text,
  created_at        text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Bangkok calendar day of the attempt (UTC + 7h), for the once-per-day guard.
  sent_on_local text generated always as
    (date(datetime(created_at, '+7 hours'))) stored,
  constraint send_logs_status_check check (status in (
    'sent','skipped_quota','skipped_weekend','skipped_disabled','skipped_duplicate','failed'
  )),
  constraint send_logs_trigger_source_check check (trigger_source in ('cron','manual')),
  constraint send_logs_recipients_check check (recipients_count is null or recipients_count >= 0)
);

-- Double-send guard: a given schedule may succeed at most once per Bangkok day.
-- Partial index so retries after a skip/failure are still allowed.
create unique index if not exists send_logs_schedule_day_unique
  on send_logs (schedule_id, sent_on_local)
  where status = 'sent' and schedule_id is not null;

create index if not exists send_logs_created_at_idx on send_logs (created_at desc);
create index if not exists send_logs_group_idx on send_logs (group_id, created_at desc);

-- ----------------------------------------------------------------- system_logs
create table if not exists system_logs (
  id         integer primary key autoincrement,
  level      text not null,
  event      text not null,
  detail     text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  constraint system_logs_level_check check (level in ('debug','info','warn','error'))
);
create index if not exists system_logs_created_at_idx on system_logs (created_at desc);
create index if not exists system_logs_level_idx on system_logs (level, created_at desc);

-- ------------------------------------------------------------ quota_snapshots
create table if not exists quota_snapshots (
  id          integer primary key autoincrement,
  quota_type  text not null,
  quota_limit integer,
  total_usage integer not null,
  checked_at  text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  constraint quota_snapshots_usage_check check (total_usage >= 0)
);
create index if not exists quota_snapshots_checked_at_idx on quota_snapshots (checked_at desc);

-- ------------------------------------------------------------------ updated_at
create trigger if not exists groups_set_updated_at
  after update on groups
  for each row when new.updated_at = old.updated_at
  begin update groups set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = old.id; end;

create trigger if not exists message_templates_set_updated_at
  after update on message_templates
  for each row when new.updated_at = old.updated_at
  begin update message_templates set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = old.id; end;

create trigger if not exists schedules_set_updated_at
  after update on schedules
  for each row when new.updated_at = old.updated_at
  begin update schedules set updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') where id = old.id; end;
