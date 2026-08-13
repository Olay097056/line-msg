// /api/groups — manage target groups.
//   GET                              list
//   POST   { lineGroupId }           add by hand; the name and member count are
//                                    fetched from LINE so a typo fails loudly
//   PATCH  { id, status?, name? }    confirm a pending group, or retire one
//   DELETE ?id=...
//
// A group added via the webhook (ticket 09) lands here as status='pending' and
// is confirmed with PATCH.

import { deps, json, requireSession } from '../lib/http.js';

export default async function handler(req: any, res: any) {
  const { db, line } = deps();
  if (!(await requireSession(req, res, db))) return;

  if (req.method === 'GET') {
    return json(res, 200, await db.select('groups', 'select=*&order=created_at.asc'));
  }

  if (req.method === 'POST') {
    const lineGroupId = String(req.body?.lineGroupId ?? '').trim();
    if (!lineGroupId) return json(res, 400, { error: 'ต้องระบุ lineGroupId' });

    const summary = await line.groupSummary(lineGroupId);
    if (!summary.ok) {
      return json(res, 400, {
        error: 'LINE ไม่รู้จักกลุ่มนี้ หรือบอทไม่ได้อยู่ในกลุ่ม',
        lineStatus: summary.status,
      });
    }
    const count = await line.memberCount(lineGroupId);

    try {
      const [row] = await db.insert('groups', {
        line_group_id: lineGroupId,
        name: summary.body?.groupName ?? null,
        status: 'pending',
        member_count: count.ok ? count.body?.count ?? null : null,
        member_count_checked_at: count.ok ? new Date().toISOString() : null,
      });
      await db.log('info', 'group_added_manually', row);
      return json(res, 201, row);
    } catch (err) {
      if (String(err).includes('23505')) return json(res, 409, { error: 'มีกลุ่มนี้อยู่แล้ว' });
      throw err;
    }
  }

  if (req.method === 'PATCH') {
    const { id, status, name } = req.body ?? {};
    if (!id) return json(res, 400, { error: 'ต้องระบุ id' });
    if (status !== undefined && !['pending', 'active', 'inactive'].includes(status)) {
      return json(res, 400, { error: 'status ต้องเป็น pending/active/inactive' });
    }
    const patch: Record<string, unknown> = {};
    if (status !== undefined) patch.status = status;
    if (name !== undefined) patch.name = name;
    if (Object.keys(patch).length === 0) return json(res, 400, { error: 'ไม่มีอะไรให้แก้' });

    const rows = await db.update('groups', `id=eq.${id}`, patch);
    if (rows.length === 0) return json(res, 404, { error: 'ไม่พบกลุ่มนี้' });
    await db.log('info', 'group_updated', { id, patch });
    return json(res, 200, rows[0]);
  }

  if (req.method === 'DELETE') {
    const id = req.query?.id;
    if (!id) return json(res, 400, { error: 'ต้องระบุ id' });
    // Schedules cascade; send_logs cascade too, so deleting a group discards its
    // history. Retiring with status='inactive' is usually what you want.
    const rows = await db.delete('groups', `id=eq.${id}`);
    if (rows.length === 0) return json(res, 404, { error: 'ไม่พบกลุ่มนี้' });
    await db.log('warn', 'group_deleted', { id });
    return json(res, 200, { ok: true });
  }

  return json(res, 405, { error: 'GET/POST/PATCH/DELETE' });
}
