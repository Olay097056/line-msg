// /api/schedules — CRUD for send times.
//   GET                                  list
//   POST   { groupId, messageId, sendAtLocal, weekdaysOnly?, enabled? }
//   PATCH  { id, ...fields }
//   DELETE ?id=...
//
// Editing takes effect on the very next minute-tick: the tick reads these rows
// live, so nothing needs rescheduling in pg_cron (ticket 03 หมวด E).

import { deps, json, requireSession } from '../lib/http.js';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export default async function handler(req: any, res: any) {
  const { db } = deps();
  if (!(await requireSession(req, res, db))) return;

  if (req.method === 'GET') {
    return json(res, 200, await db.select('schedules', 'select=*&order=send_at_local.asc'));
  }

  if (req.method === 'POST') {
    const { groupId, messageId, sendAtLocal, weekdaysOnly = true, enabled = true } = req.body ?? {};
    if (!groupId || !messageId) return json(res, 400, { error: 'ต้องระบุ groupId และ messageId' });
    if (!HHMM.test(String(sendAtLocal))) return json(res, 400, { error: 'เวลาต้องเป็นรูปแบบ HH:MM' });
    try {
      const [row] = await db.insert('schedules', {
        group_id: groupId,
        message_id: messageId,
        send_at_local: sendAtLocal,
        weekdays_only: !!weekdaysOnly,
        enabled: !!enabled,
      });
      await db.log('info', 'schedule_created', row);
      return json(res, 201, row);
    } catch (err) {
      if (String(err).includes('23505')) {
        return json(res, 409, { error: 'กลุ่มนี้มีเวลานี้อยู่แล้ว' });
      }
      throw err;
    }
  }

  if (req.method === 'PATCH') {
    const { id, sendAtLocal, weekdaysOnly, enabled, messageId } = req.body ?? {};
    if (!id) return json(res, 400, { error: 'ต้องระบุ id' });
    if (sendAtLocal !== undefined && !HHMM.test(String(sendAtLocal))) {
      return json(res, 400, { error: 'เวลาต้องเป็นรูปแบบ HH:MM' });
    }
    const patch: Record<string, unknown> = {};
    if (sendAtLocal !== undefined) patch.send_at_local = sendAtLocal;
    if (weekdaysOnly !== undefined) patch.weekdays_only = !!weekdaysOnly;
    if (enabled !== undefined) patch.enabled = !!enabled;
    if (messageId !== undefined) patch.message_id = messageId;
    if (Object.keys(patch).length === 0) return json(res, 400, { error: 'ไม่มีอะไรให้แก้' });

    const rows = await db.update('schedules', `id=eq.${id}`, patch);
    if (rows.length === 0) return json(res, 404, { error: 'ไม่พบตารางเวลานี้' });
    await db.log('info', 'schedule_updated', { id, patch });
    return json(res, 200, rows[0]);
  }

  if (req.method === 'DELETE') {
    const id = req.query?.id;
    if (!id) return json(res, 400, { error: 'ต้องระบุ id' });
    const rows = await db.delete('schedules', `id=eq.${id}`);
    if (rows.length === 0) return json(res, 404, { error: 'ไม่พบตารางเวลานี้' });
    await db.log('info', 'schedule_deleted', { id });
    return json(res, 200, { ok: true });
  }

  return json(res, 405, { error: 'GET/POST/PATCH/DELETE' });
}
