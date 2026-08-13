// POST /api/send  { groupId?, body? } — manual send from the control panel.
//
// Manual sends still pass the quota guard: burning the month's last messages by
// hand is exactly what the guard exists to prevent.

import { deps, json, requireSession } from '../lib/http.js';
import { readQuota, resolveRecipients, sendOne, type Group } from '../lib/send.js';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  const { db, line } = deps();
  if (!(await requireSession(req, res, db))) return;

  const groupId = req.body?.groupId ? String(req.body.groupId) : null;
  const groups = (await db.select(
    'groups',
    groupId
      ? `select=id,line_group_id,name,status,member_count&id=eq.${groupId}`
      : 'select=id,line_group_id,name,status,member_count&status=eq.active',
  )) as Group[];

  if (groups.length === 0) return json(res, 404, { error: 'ไม่พบกลุ่มที่ใช้ส่งได้' });

  let body = req.body?.body ? String(req.body.body).trim() : '';
  if (!body) {
    const [template] = await db.select('message_templates', 'select=body&order=created_at.asc&limit=1');
    body = template?.body ?? '';
  }
  if (!body) return json(res, 400, { error: 'ไม่มีข้อความให้ส่ง' });

  const quota = await readQuota({ db, line });
  const results = [];
  for (const group of groups) {
    if (group.status !== 'active') {
      results.push({ group: group.line_group_id, status: 'skipped_disabled' });
      continue;
    }
    const recipients = await resolveRecipients({ db, line }, group);
    const outcome = await sendOne(
      { db, line },
      { group, body, triggerSource: 'manual', scheduleId: null, quota, recipients },
    );
    results.push({ group: group.line_group_id, ...outcome });
  }

  return json(res, 200, { body, quota, results });
}
