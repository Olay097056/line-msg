// GET /api/logs?kind=send|system&limit=50&level=error
//
// Two separate logs by design (ticket 03 หมวด D): `send` is the per-push
// history, `system` is the background/error trail.

import { deps, json, requireSession } from '../lib/http.js';

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') return json(res, 405, { error: 'GET only' });
  const { db } = deps();
  if (!(await requireSession(req, res, db))) return;

  const kind = String(req.query?.kind ?? 'send');
  const limit = Math.min(Number(req.query?.limit ?? 50) || 50, 200);

  if (kind === 'system') {
    const level = req.query?.level ? `&level=eq.${req.query.level}` : '';
    return json(
      res,
      200,
      await db.select('system_logs', `select=*&order=created_at.desc&limit=${limit}${level}`),
    );
  }

  const status = req.query?.status ? `&status=eq.${req.query.status}` : '';
  const group = req.query?.groupId ? `&group_id=eq.${req.query.groupId}` : '';
  return json(
    res,
    200,
    await db.select('send_logs', `select=*&order=created_at.desc&limit=${limit}${status}${group}`),
  );
}
