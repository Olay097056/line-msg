# line-msg

*[ภาษาไทย](README.th.md)*

A reminder system for **recurring routine work that people forget** — the
daily and weekly tasks that nobody schedules because "we do that every day
anyway", right up until the day nobody does. It pushes the reminder into the
LINE group the team already lives in, at the time the task is actually due.

Built as a web dashboard, a D1-backed scheduler, and a LINE Messaging
API integration — migrated to Cloudflare Pages + D1 for better performance and reliability.

**[Try the demo](https://olay097056.github.io/line-msg-demo/)** — no login, fully
interactive, entirely mock data. Nothing you do there touches LINE or the
real database; the production instance runs the same UI against a live LINE
group and isn't public for that reason.

## Why this exists

Routine tasks fail in a specific way: they are too small to put in a ticket
system, too frequent to be memorable, and owned by everyone and therefore no
one. A calendar reminder pings one person's phone, which they dismiss while
driving. A LINE message in the group everybody already watches is seen by the
whole team, and staying silent about it is visibly a choice.

The first attempt at this was a single Google Apps Script function on a
time-driven trigger, checking the clock every run and firing a hardcoded
message at two fixed times. It worked, but:

- the send text and schedule could only be changed by editing code
- there was no visibility into whether a send had actually happened
- nothing tracked LINE's monthly message quota — a group's push consumes
  quota *per recipient*, not per API call, so a small group can burn through
  a free-tier allowance faster than it looks

This rewrite keeps the same job (push a message on a schedule) but makes
every part of it observable and adjustable without touching code.

## Architecture

```
Cloudflare Pages Scheduled Function (cron triggers)
        │  runs every minute, processes due schedules
        ▼
Cloudflare Pages Functions  /api/*
        │  reads D1 database, calls LINE API
        ▼
LINE Messaging API  (push, quota, group member count)
        │
Cloudflare D1 Database  (schedules, groups, message templates, send/system logs)
        ▲
Cloudflare Pages static frontend (vanilla JS, same deployment, relative /api/* calls)
        ▲
LINE webhook  →  /api/webhook  (group join/leave/member-count events,
                  HMAC-verified against the raw request body)
```

No framework, no build step, no ORM:

- **Backend**: Cloudflare Pages Functions under `functions/`, using TypeScript
  with Cloudflare's runtime environment and D1 database integration.
- **Frontend**: static HTML + vanilla JS under `public/`, served from the
  same Cloudflare Pages project so there's no CORS or `API_BASE_URL` to configure.
- **Database**: D1 database with SQL migrations under `d1/migrations/`,
  applied via Wrangler CLI and Cloudflare dashboard.
- **Scheduler**: Cloudflare Pages Scheduled Functions with cron triggers configured
  in the Pages dashboard (07:15 and 17:15 daily), processing due schedules
  without external dependencies.

## What it does

- **Manual send** — pick a group, optionally override the message, send now.
- **Scheduled send** — per-group, per-time schedules, each with its own
  message template; weekday-only or every day.
- **Quota tracking** — reads LINE's live quota + consumption endpoints,
  shows used/remaining and a burn-rate projection ("about N sending days
  left"), and refuses to send a push that would exceed the remaining quota.
- **Group management** — add a group by ID, or let the LINE webhook add it
  automatically (as `pending`) when the bot is invited, then confirm it from
  the dashboard.
- **Two separate logs** — a send history (what was actually pushed, or why a
  send was skipped) and a system/error log (background events, auth
  failures, webhook activity) kept apart on purpose.
- **Password auth** — a single bcrypt-hashed password gates the dashboard;
  the scheduler's own callback is authorized separately with a shared secret
  header, since that endpoint has to be reachable by Supabase and therefore
  can't sit behind the same login.

## Design notes worth reading

- **Claim-then-send**: a `sent` row is written to the database *before* the
  LINE API is called, so a database uniqueness constraint (one send per
  schedule per day) is what actually prevents duplicate messages — not
  application-level locking. If the LINE call then fails, the row is
  downgraded to `failed`, which frees the slot for a retry.
- **Quota is per recipient, not per push**: a message to a 7-person group
  costs 7 messages against the monthly allowance. The quota guard multiplies
  by live group membership, not a cached constant.
- **A quiet minute costs nothing**: the cron tick only calls LINE's API when
  a schedule is actually due — 1,440 ticks a day would otherwise burn 1,440
  quota-check calls for no reason.
- **Webhook signature verification uses the raw request body**: Vercel's
  automatic JSON body parsing is disabled for the webhook route, because
  re-serializing a parsed body produces different bytes than what LINE
  signed, silently breaking HMAC verification.
- **Theme is a HyperUI token set, light-first with a dark mode**: the UI
  uses the same cross-project `data-theme` contract as the rest of the
  author's projects (light by default, `[data-theme='dark']` override,
  persisted in `localStorage['linemsg_theme']` with a no-FOUC inline head
  script and an in-header toggle). Colors derive exclusively from the
  semantic token block in `public/app.css` — surfaces use `--bg-*`,
  status colors use `--success/--warning/--danger` soft+text pairs — so a
  theme change is one `data-theme` attribute away, not a per-class edit.

## Local development

```bash
npm install
npm test            # tsc typecheck + node:test suite (LINE and DB are
                     # fully stubbed — nothing here touches the network)
```

To deploy your own copy: create a LINE Messaging API channel and a Cloudflare Pages project, fill in `.env.example` → `.dev.vars`, then:

```bash
npm install
npm test            # tsc typecheck + node:test suite (LINE and DB are
                     # fully stubbed — nothing here touches the network)
npx wrangler d1 execute f15d138b-2c74-474a-832b-0870be86aae0 --file=./d1/migrations/0004_migrate_full.sql
npx wrangler pages deploy --project-name line-msg
```

## Migration Status

✅ **Completed**: Migration from Vercel/Supabase to Cloudflare Pages/D1
- D1 database with full data migration (UUID + 21 send_logs)
- Cloudflare Pages Functions with API routes
- Scheduled function for cron triggers (requires manual setup in dashboard)
- LINE Illegal invocation quota fix
- Environment variables adapter for D1 integration

**Next Steps**:
1. Set up cron triggers in Cloudflare Pages dashboard (see `SETUP_CRON_TRIGGERS.md`)
2. Verify scheduled messages work correctly
3. Execute cutover script to decommission Vercel/Supabase (see `CUTOVER_SCRIPT.md`)

## Stack

Node.js · TypeScript · Cloudflare Pages Functions · D1 Database · LINE Messaging API · vanilla HTML/CSS/JS
