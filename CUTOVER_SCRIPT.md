# Cutover Script - Vercel/Supabase Decommission

## Overview
This script provides step-by-step instructions for safely cutting over from Vercel/Supabase to Cloudflare Pages/D1 after confirming the Cloudflare migration is working correctly.

## Prerequisites
✅ Cloudflare Pages cron triggers are active and working  
✅ Scheduled messages are processing correctly for 24-48 hours  
✅ All API endpoints are functioning on Pages  
✅ Data migration is complete and verified  

## Step-by-Step Cutover

### Phase 1: Verification (DO NOT SKIP)

#### 1.1 Verify Cloudflare Pages is Working
```bash
# Test all critical endpoints
curl -s "https://line-msg.pages.dev/api/state" | jq '.quota'
curl -s "https://line-msg.pages.dev/api/login" | jq '.success'
curl -s "https://line-msg.pages.dev/api/tick" | jq '.due'
curl -s "https://line-msg.pages.dev/api/logs" | jq '.total'
```

#### 1.2 Verify Scheduled Function
```bash
# Manual test of scheduled function
curl -X POST "https://line-msg.pages.dev/api/tick"

# Check D1 database for recent activity
# (Requires direct D1 access or database viewer)
```

#### 1.3 Verify Data Integrity
- Confirm all groups, schedules, and templates are accessible via Pages API
- Verify send_logs table has recent entries
- Confirm LINE API quota is being used correctly

### Phase 2: Backup (Safety Net)

#### 2.1 Backup Vercel Project
```bash
# Download Vercel deployment logs and environment
# Take screenshots of current dashboard state
```

#### 2.2 Backup Supabase Database
```bash
# Export the current Supabase database
# Use Supabase dashboard → Settings → Database → Export
```

#### 2.3 Document Current State
- Record current URL: line-msg-v2.vercel.app
- Record current database schema and data
- Take screenshots of working system

### Phase 3: Decommission Vercel

#### 3.1 Suspend Vercel Project (First Step)
1. Go to Vercel dashboard → line-msg-v2 project
2. Go to Settings → General
3. Toggle "Framework Detection" to OFF
4. Go to Settings → Git → Repository
5. Disconnect the repository (this stops auto-deploys)

#### 3.2 Verify Vercel is Suspended
- Confirm line-msg-v2.vercel.app returns 404 or service unavailable
- Check that no new deployments are happening

#### 3.3 Archive Vercel Project
1. Go to Vercel dashboard → line-msg-v2 project
2. Click "Archive Project"
3. Confirm archive (this is reversible for 30 days)

### Phase 4: Decommission Supabase

#### 4.1 Backup Final State
```bash
# Final export of Supabase database
# Take screenshots of remaining data
```

#### 4.2 Delete Supabase Project
1. Go to Supabase dashboard → time-etwin project
2. Go to Settings → General
3. Scroll to bottom and click "Delete Project"
4. Enter project name: time-etwin
5. Confirm deletion (this is PERMANENT)

### Phase 5: Final Verification

#### 5.1 Confirm Cloudflare Pages is Primary
- Verify line-msg.pages.dev is working
- Test all endpoints again
- Confirm scheduled messages are still working

#### 5.2 Update Documentation
- Update README.md to reflect new Cloudflare deployment
- Remove any Vercel-specific references
- Update any external documentation

#### 5.3 Monitor for Issues
- Monitor for 24 hours after cutover
- Check for any errors in logs
- Verify scheduled messages continue to work

## Emergency Rollback Plan

If issues arise after cutover:

### Rollback to Vercel
1. Unarchive Vercel project
2. Reconnect repository if needed
3. Restore environment variables
4. Verify Vercel deployment

### Rollback to Supabase
1. Contact Supabase support for emergency restoration
2. Restore from backup export
3. Update Vercel environment variables

## Post-Cutover Checklist

- [ ] Cloudflare Pages is the primary deployment
- [ ] All API endpoints work correctly
- [ ] Scheduled messages process on time
- [ ] LINE API quota is being used properly
- [ ] No data loss occurred
- [ ] Vercel project is archived
- [ ] Supabase project is deleted
- [ ] Documentation is updated
- [ ] Monitoring is active

## Important Notes

⚠️ **DESTRUCTIVE ACTIONS**: Steps 3.3 and 4.2 are irreversible  
⚠️ **DATA LOSS**: Supabase deletion PERMANENTLY deletes all data  
⚠️ **DOWNTIME**: Expected downtime should be minimal (< 5 minutes)  
⚠️ **TESTING**: Only proceed after thorough verification  

---

**Final Confirmation**: Before executing any destructive steps, ensure you have:
- ✅ Completed all verification steps
- ✅ Created backups of both projects
- ✅ Documented the current state
- ✅ Informed all stakeholders of the maintenance window