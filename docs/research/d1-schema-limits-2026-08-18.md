# D1 (Cloudflare) schema research — line-msg migration

Date: 2026-08-18
Wayfinder: `.scratch/line-msg-v2/cloudflare-migration/issues/01-d1-schema-and-limits.md`

## Sources (primary, official Cloudflare docs)

- D1 overview: https://developers.cloudflare.com/d1/index.md (fetched 2026-08-18)
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/index.md
- D1 Worker binding API index: https://developers.cloudflare.com/d1/llms.txt
- D1 full docs: https://developers.cloudflare.com/d1/llms-full.txt (ed2005201)
- Workers platform limits: https://developers.cloudflare.com/workers/platform/limits/index.md

Local fetches used for grep evidence: `.scratch/line-msg-v2/cloudflare-migration/_d1_index.md`,
`_d1_limits.md`, `_llms_d1_full.txt`.

## Findings

### 1. Partial indexes — SUPPORTED (critical for the duplicate-send guard)

The existing Postgres anti-duplicate guard uses a partial unique index:

```sql
create unique index send_logs_schedule_day_unique
  on send_logs (schedule_id, sent_on_local) where status = 'sent' and schedule_id is not null;
```

D1 (SQLite) supports partial indexes natively. From the docs:

> Partial indexes are indexes over a subset of rows in a table. Partial indexes
> are defined by the use of a `WHERE` clause when creating the index.

```sql
CREATE INDEX idx_order_status_not_complete ON orders(order_status) WHERE order_status != 6
```

Conclusion: the partial unique index can be migrated to D1 as-is. The duplicate
guard stays a DB-enforced constraint, not an app lock. No redesign needed.

### 2. Generated columns — SUPPORTED (STORED)

The existing `send_logs.sent_on_local` is a generated column:

```sql
sent_on_local date generated always as (((created_at at time zone 'Asia/Bangkok'))::date) stored
```

D1 supports both `VIRTUAL` and `STORED` generated columns. Docs example:

```sql
location AS (json_extract(raw_data, '$.measurement.location')) STORED
```

Caveat: the Postgres expression uses `at time zone 'Asia/Bangkok'` and `::date`.
SQLite has no `TIMESTAMPTZ` or `AT TIME ZONE`. Need to compute the Bangkok date
in the expression differently (see schema ticket). Options:
- store `created_at` as integer/ISO text UTC, and compute a separate
  `sent_on_local` column via SQLite `datetime(created_at, '+7 hours')` / `date()` —
  needs verification of exact SQLite date function syntax for +7h.

### 3. Foreign keys — SUPPORTED (with PRAGMA)

D1 enforces foreign keys; `PRAGMA defer_foreign_keys = true` is available for
postponing checks (docs `d1/sql-api/foreign-keys/`). The existing schema has
FKs on schedules/send_logs. Migration must ensure FKs work in D1 (default on
for D1; use explicit `FOREIGN KEY` clauses; note `ON DELETE` behavior).

### 4. Limit / Free plan facts (verified, D1 limits page)

| Feature | Workers Paid | **Free** |
|---|---|---|
| Databases per account | 50,000 | **10** |
| Max database size | 10 GB | **500 MB** |
| Max storage per account | 1 TB | **5 GB** |
| Time Travel (PITR) | 30 days | **7 days** |
| Queries per Worker invocation | 1000 | **50** |
| Max columns per table | 100 | 100 |
| Max row/string size | 2 MB | 2 MB |
| Max SQL stmt length | 100 KB | 100 KB |
| Max bound params/query | 100 | 100 |
| Max SQL query duration | 30 s | 30 s |

line-msg fits comfortably in Free: small tables, a few queries per tick.

### 5. Concurrency / throughput (verified)

> Each individual D1 database is inherently single-threaded, and processes
> queries one at a time.

> You can open up to six connections (to D1) simultaneously for each invocation
> of your Worker.

line-msg's tick runs a handful of sequential queries — single-threaded per-DB
is ample. `db.batch()` statements run as SQL transactions (all-or-nothing).

### 6. Import / Wrangler (verified)

- Migration files are SQL executed via `wrangler d1 execute`.
- Read replication exists (adds read-only replicas) — NOT needed here.
- D1 is available on Free; no paid gate found for basic usage.

## Design decisions derived (feed into schema ticket)

1. Keep the partial unique index for the duplicate guard — works in D1.
2. Rework `sent_on_local`: no Postgres `AT TIME ZONE`; use SQLite date
   functions with a `+7` offset, or compute Bangkok-day in application code and
   store explicitly. Must verify exact SQLite expression before finalizing.
3. Types mapping: Postgres `timestamptz` → D1 `TEXT` (ISO 8601 UTC) or INTEGER
   epoch; `time` → `TEXT 'HH:MM:SS'`; `jsonb` → `TEXT` (JSON string);
   `bigint identity` → `INTEGER PRIMARY KEY AUTOINCREMENT`;
   `bytea/none`. Numeric sizes are fine.
4. RLS is NOT needed (D1 has no RLS): access is only via the Worker/Pages
   binding. Drop the `enable row level security` statements.
5. `uuid + gen_random_uuid()`: SQLite has no `gen_random_uuid()` builtin by
   default; use application-generated UUID strings (Node `crypto.randomUUID()`)
   or an explicit default. Existing ids are UUID strings in Supabase — keep
   TEXT PK storing UUIDs; decide whether to generate in app code.

## What still needs verification (open for next tickets)

- Exact SQLite expression for `sent_on_local` Bangkok-day (date + 7h). Must
  test in a real D1/miniflare before landing schema.
- D1 `CHECK` constraints + `AUTOINCREMENT` + partial index + generated column
  all validated together in one migration (spend a local run).
- Whether app generates UUIDs (removes need for a default).

## Not found / could not confirm

- Did not find an explicit "D1 supports partial UNIQUE index" example, but the
  docs confirm partial indexes generally and SQLite supports partial unique
  indexes — treated as supported; will be proven by a real D1 schema run in
  ticket 02/03.
