// POST /api/login   { password }   -> sets the session cookie
// DELETE /api/login                 -> logs out

import {
  clearSessionCookie,
  deps,
  json,
  sessionValue,
  setSessionCookie,
  verifyPassword,
} from '../lib/http.js';

export default async function handler(req: any, res: any) {
  const { db } = deps();

  if (req.method === 'DELETE') {
    clearSessionCookie(res);
    return json(res, 200, { ok: true });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'POST or DELETE' });

  const password = String(req.body?.password ?? '');
  if (!password) return json(res, 400, { error: 'ต้องใส่รหัสผ่าน' });

  const hash = await verifyPassword(db, password);
  if (!hash) {
    await db.log('warn', 'login_failed', { ip: req.headers?.['x-forwarded-for'] ?? null });
    return json(res, 401, { error: 'รหัสผ่านไม่ถูกต้อง' });
  }

  setSessionCookie(res, sessionValue(hash));
  await db.log('info', 'login_ok', null);
  return json(res, 200, { ok: true });
}
