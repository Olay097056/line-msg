-- line-msg — D1 (SQLite) seed, mirror of supabase/migrations/0002_seed.sql
-- Creates the one group + one template + two schedules (07:15 / 17:15 Bangkok)
-- that exist in production today. Uses fixed TEXT ids so re-running is idempotent.
-- Translated from the Postgres seed: time 'HH:MM' -> TEXT 'HH:MM:SS',
-- now() -> current ISO string, on conflict do nothing -> insert or ignore.

insert or ignore into groups (id, line_group_id, name, status, member_count, member_count_checked_at, created_at, updated_at)
values (
  'seed-group-demo',
  'Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  'CU REDACTED',
  'active',
  7,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
);

insert or ignore into message_templates (id, name, body, created_at, updated_at)
values (
  'seed-msg-default',
  'default',
  'Send TIME',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
);

-- Two schedules for the seeded group: 07:15 and 17:15 Bangkok (weekdays only, enabled).
insert or ignore into schedules (id, group_id, message_id, send_at_local, weekdays_only, enabled, created_at, updated_at)
values
  ('seed-sched-0715', 'seed-group-demo', 'seed-msg-default', '07:15:00', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('seed-sched-1715', 'seed-group-demo', 'seed-msg-default', '17:15:00', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
