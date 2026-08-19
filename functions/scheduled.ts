import type { CfEnv } from '../lib/cf-env.js';
import { setCfEnv } from '../lib/cf-env.js';
import { deps } from '../lib/http.js';
import { runTick } from '../lib/send.js';

/**
 * Pages Scheduled Function. Cloudflare Pages runs this file's `scheduled`
 * export on the cron trigger configured in the Pages dashboard
 * (Settings → Cron Triggers). It must live in its own top-level functions
 * file (not inside a `[[path]]` catch-all router) so the Pages build picks it
 * up as a scheduled event handler rather than a route.
 *
 * Mirrors the old Vercel /api/tick behavior, but invoked without an HTTP
 * request — it drives runTick directly against D1.
 */
export async function scheduled(
  _event: unknown,
  env: Record<string, unknown>,
  _ctx: unknown,
): Promise<void> {
  setCfEnv({ ...env } as CfEnv);
  try {
    const { db, line } = deps();
    const result = await runTick({ db, line });
    if (result.due > 0) await db.log('info', 'tick_fired', result);
  } catch (err) {
    const { db } = deps();
    await db.log('error', 'tick_crashed', { message: String(err) }).catch(() => {});
  } finally {
    setCfEnv(null);
  }
}
