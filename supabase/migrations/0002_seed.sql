-- line-msg-v2 — seed the one group and schedule that exist today.
-- Idempotent: re-running changes nothing.
--
-- Values verified against the live LINE API on 2026-08-13:
--   GET /v2/bot/group/Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/summary -> "CU REDACTED"
--   GET /v2/bot/group/Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/members/count -> 7
--
-- Message body stays "Send TIME" for now (ticket 03 หมวด F) so the cutover
-- changes only the delivery mechanism, not the output.

insert into groups (line_group_id, name, status, member_count, member_count_checked_at)
values ('Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'CU REDACTED', 'active', 7, now())
on conflict (line_group_id) do nothing;

insert into message_templates (name, body)
select 'default', 'Send TIME'
where not exists (select 1 from message_templates where name = 'default');

insert into schedules (group_id, message_id, send_at_local, weekdays_only, enabled)
select g.id, m.id, t.send_at, true, true
from groups g
cross join message_templates m
cross join (values (time '07:15'), (time '17:15')) as t(send_at)
where g.line_group_id = 'Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
  and m.name = 'default'
on conflict (group_id, send_at_local) do nothing;
