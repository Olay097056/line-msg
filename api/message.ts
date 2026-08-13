// /api/message — the text that gets sent.
//   GET                            list templates
//   POST  { name, body }           create a new template (ticket 10: lets
//                                  different schedules send different text)
//   PATCH { id, body?, name? }     edit
//   DELETE ?id=...                 remove (blocked if a schedule still uses it —
//                                  schedules.message_id is ON DELETE RESTRICT)
//
// Editing does not rewrite history: send_logs stores its own copy of the body.

import { deps, json, requireSession } from '../lib/http.js';

const MAX_LEN = 5000; // LINE text message limit, mirrored by a CHECK constraint

function validateBody(body: unknown): string | { error: string } {
  const text = String(body ?? '').trim().length === 0 ? '' : String(body);
  if (text.trim().length === 0) return { error: 'ข้อความว่างไม่ได้' };
  if (text.length > MAX_LEN) return { error: `ข้อความยาวเกิน ${MAX_LEN} ตัวอักษร` };
  return text;
}

export default async function handler(req: any, res: any) {
  const { db } = deps();
  if (!(await requireSession(req, res, db))) return;

  if (req.method === 'GET') {
    return json(res, 200, await db.select('message_templates', 'select=*&order=created_at.asc'));
  }

  if (req.method === 'POST') {
    const { name, body } = req.body ?? {};
    if (!String(name ?? '').trim()) return json(res, 400, { error: 'ต้องระบุชื่อข้อความ' });
    const validated = validateBody(body);
    if (typeof validated !== 'string') return json(res, 400, validated);

    const [row] = await db.insert('message_templates', { name: String(name).trim(), body: validated });
    await db.log('info', 'message_created', { id: row.id, name: row.name });
    return json(res, 201, row);
  }

  if (req.method === 'PATCH') {
    const { id, body, name } = req.body ?? {};
    if (!id) return json(res, 400, { error: 'ต้องระบุ id' });

    const patch: Record<string, unknown> = {};
    if (body !== undefined) {
      const validated = validateBody(body);
      if (typeof validated !== 'string') return json(res, 400, validated);
      patch.body = validated;
    }
    if (name !== undefined) {
      if (!String(name).trim()) return json(res, 400, { error: 'ชื่อข้อความห้ามว่าง' });
      patch.name = String(name).trim();
    }
    if (Object.keys(patch).length === 0) return json(res, 400, { error: 'ไม่มีอะไรให้แก้' });

    const rows = await db.update('message_templates', `id=eq.${id}`, patch);
    if (rows.length === 0) return json(res, 404, { error: 'ไม่พบข้อความนี้' });
    await db.log('info', 'message_updated', { id, length: String(patch.body ?? '').length });
    return json(res, 200, rows[0]);
  }

  if (req.method === 'DELETE') {
    const id = req.query?.id;
    if (!id) return json(res, 400, { error: 'ต้องระบุ id' });
    try {
      const rows = await db.delete('message_templates', `id=eq.${id}`);
      if (rows.length === 0) return json(res, 404, { error: 'ไม่พบข้อความนี้' });
      await db.log('info', 'message_deleted', { id });
      return json(res, 200, { ok: true });
    } catch (err) {
      if (String(err).includes('23503')) {
        return json(res, 409, { error: 'ลบไม่ได้ — มีตารางเวลากำลังใช้ข้อความนี้อยู่' });
      }
      throw err;
    }
  }

  return json(res, 405, { error: 'GET/POST/PATCH/DELETE' });
}
