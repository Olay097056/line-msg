# line-msg Cloudflare Migration - Status Summary

**Updated 2026-08-19 (evening)** — corrected against live verification, not
assumptions. See `.scratch/line-msg-v2/cloudflare-migration/issues/05-cutover-and-delete.md`
for the full evidence trail.

## ✅ Verified working right now

Tested directly against the **real** production URL (see correction below) with
raw curl output, not assumed from the deploy step succeeding:

| Check | Result |
|---|---|
| `GET /api/state` (no login) | 401 `ต้องเข้าสู่ระบบก่อน` — correct |
| `POST /api/login` (real password) | 200 `{"ok":true}` |
| `GET /api/state` (logged in) | 200, real data: quota 245/300, group CU REDACTED (7 members), 2 schedules, 1 template |
| `POST /api/tick` (no secret) | 401 `bad cron secret` — correct |
| `POST /api/tick` (real `CRON_SECRET`) | 200 `{"due":0,...}` — correct, not at 07:15/17:15 |
| `POST /api/webhook` (no/bad signature) | 401 `bad signature` — correct |
| `POST /api/webhook` (real HMAC signature) | 200 `{"handled":0}` — correct |
| D1 `app_settings.admin_password_hash` | present, 60 chars (bcrypt) — migrated correctly |

**Not yet verified**: an actual outbound LINE push fired *from Cloudflare*.
Every `tick` call so far landed on `due:0` because it wasn't the exact
scheduled minute — the send path (`sendOne()` → LINE API) has never actually
executed on this deployment. This is the one real gap left before ticket 05
can close. (Skipped intentionally on 2026-08-19 rather than burn quota + ping
the real group during infra verification — will be proven for free by the
first real cron trigger fire instead.)

## 🔧 Corrected mistakes (previous version of this doc had these wrong)

1. **Wrong production URL.** `https://production.line-msg.pages.dev` is a
   Cloudflare Pages *branch alias* — it resolves against the **preview**
   deployment config, which has zero secrets bound (confirmed via the
   Cloudflare API: `deployment_configs.preview.env_vars` is `{}`). That's why
   it returned `missing env LINE_CHANNEL_ACCESS_TOKEN`. The real production
   URL, with all 4 secrets correctly attached, is **`https://line-msg.pages.dev`**
   (no `production.` prefix). All docs and this file now use the correct URL.
2. **Wrong cron expression.** `0 15 7 * * *` is 6-field (seconds-first), a
   format Cloudflare Cron Triggers do not accept — and it wasn't converted to
   UTC. Cloudflare Cron Triggers run in **UTC only** on standard 5-field
   unix-cron. Correct values (Bangkok is UTC+7, no DST):
   - 07:15 Bangkok → `15 0 * * *`
   - 17:15 Bangkok → `15 10 * * *`

## ⚠️ Live production risk found and handled this session

Both the old Supabase `pg_cron` job and (once configured) the new Cloudflare
Cron Trigger point at the **same real LINE group**. They write to two
*different* databases (Supabase Postgres vs. D1), so the duplicate-send guard
(a unique index per database) does **not** protect across systems — if both
were active at once, the group would get every reminder twice.

- Vercel's `pg_cron` was paused mid-session to eliminate that risk, confirmed
  today's 17:15 send had already gone out before the pause (no gap).
- It was then **re-enabled** on user's explicit call, to avoid missing
  tomorrow's 07:15 Bangkok send while the Cloudflare cron trigger isn't set up
  yet.
- **Action required**: once the Cloudflare Cron Triggers below are added and
  confirmed to fire correctly for at least one real cycle, Vercel's `pg_cron`
  must be paused again before both are left running unattended. Do not skip
  this — re-run:
  ```bash
  # from Line_auto_msg/, with .scratch/line-msg-v2/prototype-02/.env.local sourced
  # select cron.unschedule('line-msg-v2-tick')
  ```

## 🔄 Remaining tasks

### 1. Cron Triggers Setup (manual, dashboard only — no CLI/API exists)
See `SETUP_CRON_TRIGGERS.md` (corrected). Cloudflare Pages has no REST API or
`wrangler` command for Pages Cron Triggers — confirmed by probing the API
directly (unknown sub-paths silently return the parent project resource
instead of a distinct endpoint or a 404).

1. Cloudflare dashboard → Pages → `line-msg` → Settings → Cron Triggers
2. Add `15 0 * * *` → `scheduled.ts`
3. Add `15 10 * * *` → `scheduled.ts`

### 2. Verify a real send happens
After the next 00:15 or 10:15 UTC passes, check D1:
```bash
npx wrangler d1 execute line-msg --remote --command \
  "select created_at, trigger_source, status from send_logs order by created_at desc limit 3"
```
Expect a fresh `trigger_source='cron'`, `status='sent'` row within a minute or
two of the trigger time.

### 3. Re-pause Vercel's pg_cron
Once step 2 confirms a real CF send, unschedule Vercel's job (see script
above) so only one system is live before extending the trial further.

### 4. Cutover (ticket 05 — destructive, requires explicit user approval)
Only after: 04-pages-and-cron closed (done) + this doc's remaining items done
+ at least one real CF-originated send confirmed in D1 + Vercel's cron paused
again. Then, and only with the user's explicit go-ahead on that specific
step: archive Vercel, delete Supabase (`CUTOVER_SCRIPT.md`).

## 📁 Files (unchanged from the original migration)

- `d1/migrations/0001_init.sql`, `0003_seed.sql`, `0004_migrate_full.sql`
- `functions/api/[[path]].ts`, `functions/scheduled.ts`
- `lib/cf-env.ts`, `lib/d1.ts`
- `wrangler.toml`
- `test/cf-adapter.test.ts`, `test/d1.test.ts`

## Progress

Infra: deployed and verified working (login/state/tick-auth/webhook all
correct on the real URL). Blocked only on a manual dashboard step (cron
triggers) that no agent or script can perform, plus proving one real send.
Cutover (destructive) has not started — Vercel and Supabase are both still
fully intact.
