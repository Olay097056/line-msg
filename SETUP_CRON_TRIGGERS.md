# Cloudflare Pages Cron Triggers Setup

## Overview
This document provides instructions for setting up the cron triggers in the Cloudflare Pages dashboard to activate the scheduled messaging functionality.

## Required Cron Triggers
The scheduled function in `functions/scheduled.ts` needs to be triggered twice daily.

⚠️ **Corrected 2026-08-19**: the expressions below were wrong in the original
version of this doc — 6-field (seconds-first) syntax, which Cloudflare does
NOT use, and the times were not converted to UTC. Cloudflare Cron Triggers
use standard **5-field unix-cron** (`minute hour day month weekday`), and the
worker/function always runs in UTC regardless of the project's timezone.
Bangkok is UTC+7 with no DST (verified fact from the original Vercel/pg_cron
setup — see `.scratch/line-msg-v2/issues/02-deployability-spike.md`), so:

1. **Morning**: 07:15 Bangkok = **00:15 UTC**
   - Cron expression: `15 0 * * *`
   - Purpose: Send morning scheduled messages

2. **Evening**: 17:15 Bangkok = **10:15 UTC**
   - Cron expression: `15 10 * * *`
   - Purpose: Send evening scheduled messages

**Known limitation of this fixed-trigger approach** (different from the old
Vercel/pg_cron design, which ticked every minute and read times live from the
database): editing a schedule's *time* from the dashboard no longer takes
effect automatically — the Cloudflare Cron Trigger is a fixed UTC time
configured here, separate from the `schedules.send_at_local` row in D1. If a
schedule's time is ever changed, this dashboard config must be updated to
match, or add a trigger. Editing the *message*, *enabled* flag, or adding a
new schedule at one of these two times still works with no redeploy, since
`runTick()` still reads those from D1 live.

## Setup Instructions

### Step 1: Access Cloudflare Pages Dashboard
1. Go to https://dash.cloudflare.com
2. Navigate to **Pages** → **Projects** → **line-msg**
3. Select your production deployment (line-msg.pages.dev)

### Step 2: Navigate to Cron Triggers
1. In the Pages project dashboard, go to **Settings**
2. Scroll down to **Cron Triggers** section
3. Click **Add Cron Trigger**

### Step 3: Add Morning Trigger (07:15 Bangkok = 00:15 UTC)
1. **Cron Expression**: `15 0 * * *`
2. **Function File**: `scheduled.ts` (this should be auto-detected)
3. Click **Save**

### Step 4: Add Evening Trigger (17:15 Bangkok = 10:15 UTC)
1. Click **Add Cron Trigger** again
2. **Cron Expression**: `15 10 * * *`
3. **Function File**: `scheduled.ts` (this should be auto-detected)
4. Click **Save**

### Step 5: Verify Triggers
1. Both triggers should appear in the list
2. Status should show as "Active"
3. Next run times should be calculated correctly

## Testing the Scheduled Function

### Manual Test via API
You can test the scheduled function manually by calling the tick endpoint:

```bash
curl -X POST -H "x-cron-secret: $CRON_SECRET" "https://line-msg.pages.dev/api/tick"
```

(the header is required — `/api/tick` is a public endpoint, gated only by
`CRON_SECRET`, since Cloudflare has no IP-allowlist mechanism for this; see
`lib/http.ts` `requireCronSecret`.) This exercises the same `runTick()` logic
the cron job calls, and is safe to run any time — it only sends a real LINE
message if a schedule is actually due (`due` in the response > 0) *and* that
schedule hasn't already fired for the current Bangkok day.

### Expected Behavior
- The scheduled function calls `runTick()` from `lib/send.ts`
- It processes due messages for the current time
- It logs results to the D1 database
- Error handling ensures crashes are logged

## Verification Steps

1. **After setting up cron triggers**, wait for the next scheduled time
2. Check the D1 database for log entries:
   ```sql
   SELECT * FROM send_logs ORDER BY created_at DESC LIMIT 5;
   ```
3. Verify messages are being sent as expected
4. Monitor the LINE API quota usage

## Troubleshooting

### If Cron Triggers Don't Work
1. Ensure the `scheduled.ts` file is in the correct location (`functions/`)
2. Check that the function exports a `scheduled` function
3. Verify the cron expressions are correctly formatted
4. Check Cloudflare Pages build logs for errors

### If Scheduled Function Fails
1. Check D1 database logs for error entries
2. Verify environment variables are correctly set
3. Test the tick endpoint manually
4. Check LINE API quota and authentication

## Next Steps
Once cron triggers are active and verified:
1. Monitor the system for 24-48 hours
2. Confirm all scheduled messages are working correctly
3. Proceed with cutover (deleting Vercel/Supabase)

---

**Note**: This setup must be done manually in the Cloudflare dashboard as there's no CLI or API for managing Pages cron triggers.