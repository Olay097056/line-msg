// POST /api/tick — called every minute by Supabase pg_cron via pg_net.
//
// Guarded by CRON_SECRET, not by the password: this endpoint is public because
// Vercel Deployment Protection blocks pg_net entirely (ticket 02).

import { deps, json, requireCronSecret } from '../lib/http.js';
import { runTick } from '../lib/send.js';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (!requireCronSecret(req, res)) return;

  const { db, line } = deps();
  try {
    const result = await runTick({ db, line });
    if (result.due > 0) await db.log('info', 'tick_fired', result);
    return json(res, 200, result);
  } catch (err) {
    await db.log('error', 'tick_crashed', { message: String(err) });
    return json(res, 500, { error: String(err) });
  }
}
