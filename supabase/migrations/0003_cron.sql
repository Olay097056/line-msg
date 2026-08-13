-- line-msg-v2 — the real minute-tick.
-- Idempotent: unschedules any existing job of the same name before creating it,
-- so re-running this file (e.g. to rotate the secret) is safe.
--
-- Design (ticket 03 หมวด E / ticket 07): a single job runs every minute and
-- calls /api/tick, which reads send times from the `schedules` table itself.
-- Editing a schedule from the web UI therefore takes effect on the very next
-- tick with no cron reschedule.
--
-- CRON_SECRET must match the Vercel env var of the same name (ticket 05). It is
-- substituted by supabase/set-cron-secret.sh — never commit the real value.

select cron.unschedule(jobid)
from cron.job
where jobname = 'line-msg-v2-tick';

select cron.schedule(
  'line-msg-v2-tick',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://line-msg-v2.vercel.app/api/tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '__CRON_SECRET__'
    ),
    body := '{}'::jsonb
  ) as request_id
  $$
);
