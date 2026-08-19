-- Historical note: this migration originally carried a one-time export of
-- real production send_logs (LINE message IDs, quote tokens, timestamps)
-- copied from the live Supabase instance during the D1 cutover. That data
-- has been removed — it was operational data from the real deployment, not
-- something a public repo should hold, and it has been scrubbed from git
-- history as well (see AGENTS.md).
--
-- The migration's actual job — moving from seed-prefixed demo IDs to UUID
-- ids matching the Supabase schema — is preserved below with placeholder
-- values instead of the real production ones.

delete from groups where id like 'seed-%';
delete from message_templates where id like 'seed-%';
delete from schedules where id like 'seed-%';

insert into groups (id, line_group_id, name, status, member_count, member_count_checked_at, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000001', 'Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'CU Test Group', 'active', '7', '2026-01-01T00:00:00.00000+00:00', '2026-01-01T00:00:00.00000+00:00', '2026-01-01T00:00:00.00000+00:00');

insert into message_templates (id, name, body, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000002', 'default', 'Send TIME', '2026-01-01T00:00:00.00000+00:00', '2026-01-01T00:00:00.00000+00:00');

insert into schedules (id, group_id, message_id, send_at_local, weekdays_only, enabled, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', '17:15:00', 1, 1, '2026-01-01T00:00:00.00000+00:00', '2026-01-01T00:00:00.00000+00:00');

insert into schedules (id, group_id, message_id, send_at_local, weekdays_only, enabled, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', '07:15:00', 1, 1, '2026-01-01T00:00:00.00000+00:00', '2026-01-01T00:00:00.00000+00:00');

-- Real send_logs rows removed (see note above). Nothing to seed here — the
-- table starts empty; production logs accumulate from real sends only.
