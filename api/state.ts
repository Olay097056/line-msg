// GET /api/state — everything the dashboard needs in one round trip:
// quota + burn projection, groups, schedules, the message template.

import { deps, json, requireSession } from '../lib/http.js';
import { readQuota } from '../lib/send.js';
import { projectExhaustion } from '../lib/decide.js';
import { bangkokClock } from '../lib/time.js';

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
  const { db, line } = deps();
  if (!(await requireSession(req, res, db))) return;

  const [groups, schedules, templates] = await Promise.all([
    db.select('groups', 'select=*&order=created_at.asc'),
    db.select('schedules', 'select=*&order=send_at_local.asc'),
    db.select('message_templates', 'select=*&order=created_at.asc'),
  ]);

  // Quota is a live LINE call and can fail independently; the rest of the page
  // should still render if it does.
  let quota = null;
  let quotaError: string | null = null;
  try {
    const state = await readQuota({ db, line });
    // One sending day costs (recipients × schedules) for every active group.
    const perDay = groups
      .filter((g: any) => g.status === 'active')
      .reduce(
        (sum: number, g: any) =>
          sum +
          (g.member_count ?? 0) *
            schedules.filter((s: any) => s.group_id === g.id && s.enabled).length,
        0,
      );
    quota = { ...state, perSendingDay: perDay, projection: projectExhaustion(state, perDay) };
  } catch (err) {
    quotaError = String(err);
    await db.log('warn', 'quota_read_failed', { message: quotaError });
  }

  return json(res, 200, {
    now: bangkokClock(new Date()),
    quota,
    quotaError,
    groups,
    schedules,
    templates,
  });
}
