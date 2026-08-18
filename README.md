# line-msg

*[ภาษาไทย](README.th.md)*

A reminder system for **recurring routine work that people forget** — the
daily and weekly tasks that nobody schedules because "we do that every day
anyway", right up until the day nobody does. It pushes the reminder into the
LINE group the team already lives in, at the time the task is actually due.

Built as a web dashboard, a Postgres-backed scheduler, and a LINE Messaging
API integration — running entirely on Vercel + Supabase free tiers.

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
Supabase pg_cron (every minute)
        │  net.http_post, x-cron-secret header
        ▼
Vercel serverless function  /api/tick
        │  reads schedules table, only acts on exact-minute matches
        ▼
LINE Messaging API  (push, quota, group member count)
        │
Supabase Postgres  (schedules, groups, message templates, send/system logs)
        ▲
Vercel static frontend (vanilla JS, same deployment, relative /api/* calls)
        ▲
LINE webhook  →  /api/webhook  (group join/leave/member-count events,
                  HMAC-verified against the raw request body)
```

No framework, no build step, no ORM:

- **Backend**: plain Node/TypeScript serverless functions under `api/`,
  compiled with `tsc` and deployed by Vercel's zero-config Node runtime.
- **Frontend**: static HTML + vanilla JS under `public/`, served from the
  same Vercel project so there's no CORS or `API_BASE_URL` to configure.
- **Database**: hand-written SQL migrations under `supabase/migrations/`,
  applied via the Supabase Management API — no local Postgres, no
  SQLite-vs-Postgres dual support.
- **Scheduler**: a single `pg_cron` job ticks every minute and asks the
  database "is anything due right now?" — editing a schedule from the
  dashboard takes effect on the very next tick, no redeploy or cron
  reschedule needed.

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

To deploy your own copy: create a LINE Messaging API channel, a Supabase
project, and a Vercel project, fill in `.env.example` → `.env.local`, then:

```bash
SUPABASE_PROJECT_REF=<ref> supabase/apply.sh          # run the migrations
SUPABASE_PROJECT_REF=<ref> supabase/set-cron-secret.sh # schedule the tick job
node scripts/set-password.mjs                          # set the dashboard password
vercel deploy --prod                                    # ship it
```

## Stack

Node.js · TypeScript · Vercel Serverless Functions · Supabase (Postgres,
`pg_cron`, `pg_net`) · LINE Messaging API · vanilla HTML/CSS/JS
