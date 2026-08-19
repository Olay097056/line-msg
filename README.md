# line-msg

*[ภาษาไทย](README.th.md)*

A reminder system for **recurring routine work that people forget** — the
daily and weekly tasks that nobody schedules because "we do that every day
anyway", right up until the day nobody does. It pushes the reminder into the
LINE group the team already lives in, at the time the task is actually due.

Built as a web dashboard, a D1-backed scheduler, and a LINE Messaging
API integration — running entirely on Cloudflare's free tier.

**[Try the demo](https://line-msg.pages.dev/demo)** — no login, fully
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
every part of it observable and adjustable without touching code. (An
earlier version of this ran on Vercel + Supabase — same design, different
host; see "History" below.)

## Architecture

```
Cloudflare Worker Cron Trigger (00:15 & 10:15 UTC = 07:15 & 17:15 Bangkok)
        │  fires scheduled(), which calls the same runTick() as every HTTP tick
        ▼
Worker fetch() handler  /api/*
        │  reads D1, only acts when a schedule is actually due
        ▼
LINE Messaging API  (push, quota, group member count)
        │
Cloudflare D1  (schedules, groups, message templates, send/system logs)
        ▲
Static frontend (vanilla JS) served by the same Worker's [assets] binding
        ▲
LINE webhook  →  /api/webhook  (group join/leave/member-count events,
                  HMAC-verified against the raw request body)
```

No framework, no build step, no ORM:

- **Backend**: a single Cloudflare Worker (`src/worker.ts`) — every route
  handler lives in `api/*.ts`, written once, and is reused unchanged by both
  the Worker's `fetch()` and (for local dev / a fallback deployment) a
  Cloudflare Pages Functions build (`functions/`). Only the transport adapter
  differs between the two; the actual logic never does.
- **Frontend**: static HTML + vanilla JS under `public/`, served from the
  same Worker via its `[assets]` binding — no CORS, no `API_BASE_URL`.
- **Database**: Cloudflare D1 (SQLite), migrations under `d1/migrations/`,
  applied with `wrangler d1 execute --remote`.
- **Scheduler**: a Worker Cron Trigger, declared in `wrangler.worker.toml`
  and applied automatically by `wrangler deploy` — no dashboard step. (This
  is *why* it's a Worker and not Pages: Cloudflare Pages Cron Triggers have
  no API or CLI, dashboard-only; Workers cron triggers are plain config.)

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
  the scheduler's own callback (`/api/tick`) is authorized separately with a
  shared secret header, since Cloudflare's cron trigger calls it the same way
  any client would — there's no private network path to put it behind.

## Design notes worth reading

- **Claim-then-send**: a `sent` row is written to the database *before* the
  LINE API is called, so a database uniqueness constraint (one send per
  schedule per day) is what actually prevents duplicate messages — not
  application-level locking. If the LINE call then fails, the row is
  downgraded to `failed`, which frees the slot for a retry.
- **Quota is per recipient, not per push**: a message to a 7-person group
  costs 7 messages against the monthly allowance. The quota guard multiplies
  by live group membership, not a cached constant.
- **A quiet minute costs nothing**: a tick only calls LINE's API when a
  schedule is actually due — an every-minute poller (the original design)
  would otherwise burn a quota-check call on every idle minute for no reason.
- **Webhook signature verification uses the raw request body**: the
  platform's automatic JSON body parsing is bypassed for the webhook route,
  because re-serializing a parsed body produces different bytes than what
  LINE signed, silently breaking HMAC verification.
- **Theme is a HyperUI token set, light-first with a dark mode**: the UI
  uses a `data-theme` contract (light by default, `[data-theme='dark']`
  override, persisted in `localStorage['linemsg_theme']` with a no-FOUC
  inline head script and an in-header toggle). Colors derive exclusively
  from the semantic token block in `public/app.css` — surfaces use
  `--bg-*`, status colors use `--success/--warning/--danger` soft+text
  pairs — so a theme change is one `data-theme` attribute away, not a
  per-class edit.

## Local development

```bash
npm install
npm test            # tsc typecheck + node:test suite (LINE and D1 are
                     # fully stubbed — nothing here touches the network)
```

To deploy your own copy: create a LINE Messaging API channel and a
Cloudflare account, fill in `.env.example` → `.dev.vars`, then:

```bash
npx wrangler d1 create line-msg                         # note the database_id it prints
npx wrangler d1 execute line-msg --remote --file=./d1/migrations/0001_init.sql
for k in LINE_CHANNEL_ACCESS_TOKEN LINE_CHANNEL_SECRET CRON_SECRET SESSION_SECRET; do
  npx wrangler secret put "$k" --config wrangler.worker.toml
done
npx wrangler deploy --config wrangler.worker.toml         # ships the app *and* registers the cron triggers
```

## History

This started as a single Google Apps Script trigger, was rewritten onto
Vercel + Supabase Postgres (a fully working version of the same design —
serverless functions, `pg_cron`, PostgREST), then migrated again onto
Cloudflare Workers + D1 for a single-vendor, CLI-deployable stack. The
Vercel/Supabase version is retired but the code path (`lib/db.ts`, the
PostgREST client) is still in the repo alongside the D1 client
(`lib/d1.ts`) — `lib/http.ts` picks whichever one matches the runtime it's
given.

## Stack

Node.js · TypeScript · Cloudflare Workers · D1 (SQLite) · LINE Messaging API
· vanilla HTML/CSS/JS
