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

## ✅ Cron Triggers — solved via a Worker, not the Pages dashboard

Pages Cron Triggers genuinely have no API/CLI (confirmed by probing the CF
API directly — unknown sub-paths silently return the parent project resource
instead of a distinct endpoint or a 404). Rather than requiring a manual
dashboard click, the app was repackaged as a plain Cloudflare **Worker**
(`src/worker.ts` + `wrangler.worker.toml`, deployed as a *separate* project
`line-msg-worker` so the working Pages deployment stays untouched) — Workers
support `[triggers].crons` in `wrangler.toml`, applied automatically by
`wrangler deploy`, no dashboard needed.

- **Live**: `https://line-msg-worker.olay097056.workers.dev`
- **Cron triggers confirmed via the Workers schedules API** (not just the
  deploy log): `15 0 * * *` and `15 10 * * *`, both persisted.
- **Full verify checklist re-run on this URL — all green**: static assets,
  login (right/wrong password), state (real data), tick (auth gate + due
  logic), webhook (real HMAC signature check). Identical results to the
  Pages deployment.
- Same D1 database (`line-msg`) as the Pages project — single source of
  truth, not forked data.

### 1. Verify a real send happens
After the next 00:15 or 10:15 UTC passes, check D1:
```bash
npx wrangler d1 execute line-msg --remote --command \
  "select created_at, trigger_source, status from send_logs order by created_at desc limit 3"
```
Expect a fresh `trigger_source='cron'`, `status='sent'` row within a minute or
two of the trigger time.

### 2. ~~Re-pause Vercel's pg_cron~~ — done (2026-08-19, ahead of the first real fire)
`cron.unschedule('line-msg-v2-tick')` run again; `cron.job` confirmed empty.
This was done on the user's explicit call **before** the Worker's cron had
fired for real even once (the recommendation at the time was to wait for that
confirmation first — the user chose to proceed anyway, fully aware of the
tradeoff). As of this edit, **`line-msg-worker` is the only system that can
send the 07:15 Bangkok reminder tomorrow.** If it doesn't fire correctly,
nothing else will catch it — check `send_logs` after 00:15 UTC / 07:15
Bangkok to confirm, and be ready to `supabase/set-cron-secret.sh` Vercel's job
back on if it didn't.

### 3. Cutover (ticket 05 — destructive, requires explicit user approval)
Only after: 04-pages-and-cron closed (done) + this doc's remaining items done
+ at least one real CF-originated send confirmed in D1 + Vercel's cron paused
again. Then, and only with the user's explicit go-ahead on that specific
step: archive Vercel, delete Supabase (`CUTOVER_SCRIPT.md`).

## 📁 Files

- `d1/migrations/0001_init.sql`, `0003_seed.sql`, `0004_migrate_full.sql`
- `functions/api/[[path]].ts`, `functions/scheduled.ts` — Pages Functions
  (kept; `line-msg.pages.dev` still works, just has no cron trigger set)
- `src/worker.ts`, `wrangler.worker.toml` — the Worker deployment that
  actually owns the cron triggers now (`line-msg-worker.olay097056.workers.dev`)
- `lib/cf-env.ts`, `lib/d1.ts` — shared by both deployments
- `test/cf-adapter.test.ts`, `test/d1.test.ts`

**Two live Cloudflare deployments exist** — this is intentional during the
trial, not a mistake: Pages (`line-msg.pages.dev`, no cron, everything else
verified) and Worker (`line-msg-worker.olay097056.workers.dev`, cron +
everything else verified). Once the Worker's cron is proven with a real fire,
decide whether to keep both, or drop the Pages one — no rush either way,
neither costs anything extra and only the Worker's cron triggers ever fire.

## Progress

Infra: **fully deployed and verified working**, cron triggers included —
solved via a Worker instead of the (nonexistent) Pages Cron Trigger API.
Only remaining gap: an actual cron-triggered send has not fired yet (next one
is 00:15 UTC / 07:15 Bangkok). Vercel's `pg_cron` stays enabled until that's
confirmed in D1, then gets paused again. Cutover (destructive) has not
started — Vercel and Supabase are both still fully intact.
