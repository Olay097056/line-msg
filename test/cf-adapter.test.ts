// Tests for the Cloudflare Pages Functions adapter (functions/api/[[path]].ts).
//
// Proves the onRequest -> Vercel-style (req,res) -> handler shim works: CF
// context (Request + env bindings) is translated into the shape api/*.ts
// handlers expect, deps()/env() route to D1 via the cf-env seam, and the
// handler's res.json() returns a real Response.
//
// Uses an isolated import because the adapter has side effects (cf-env set).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setCfEnv } from '../lib/cf-env.js';
import { Db } from '../lib/d1.js';
import type { D1Binding } from '../lib/d1.js';
import { onRequest } from '../functions/api/[[path]].js';

// ------------------------------------------------------------------ fake D1
// A D1Database-shaped object backed by in-memory tables (prepared-statements
// → all/run). Reuses the same evaluator idea as test/d1.test.ts but minimal.
type Row = Record<string, unknown>;

function fakeD1(seed: Record<string, Row[]> = {}): { binding: D1Binding; tables: Record<string, Row[]> } {
  const tables: Record<string, Row[]> = {
    app_settings: seed.app_settings ?? [],
    groups: seed.groups ?? [],
    send_logs: seed.send_logs ?? [],
    system_logs: [],
    message_templates: seed.message_templates ?? [],
    schedules: seed.schedules ?? [],
    quota_snapshots: [],
    ...seed,
  };
  let sequences: Record<string, number> = {};

  const run = (sql: string, params: unknown[]) => {
    const ins = sql.match(/INSERT INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)$/);
    if (ins) {
      const [, table, colsStr] = ins;
      const cols = colsStr.split(',').map((s) => s.trim());
      const row: Row = {};
      cols.forEach((c, i) => (row[c] = params[i]));
      tables[table]!.push(row);
      sequences[table] = (sequences[table] ?? 0) + 1;
      return { meta: { last_row_id: sequences[table], changes: 1 } };
    }
    const sel = sql.match(/SELECT ([^ ]+) FROM (\w+)(?: WHERE (.*))?/);
    if (sel) {
      const [, colsStr, table, where] = sel;
      let rows = tables[table]!.slice();
      if (where) {
        const m = where.match(/^(\w+) = \?$/);
        if (m) {
          const val = String(params[0]);
          rows = rows.filter((r) => String(r[m[1]]) === val);
        }
      }
      if (colsStr !== '*') {
        const cols = colsStr.split(',');
        rows = rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
      }
      return { results: rows };
    }
    if (sql.startsWith('UPDATE')) {
      const m = sql.match(/UPDATE (\w+) SET (.+) WHERE (\w+) = \?$/);
      if (m) {
        const [, table, setStr, wc] = m;
        const setCols = setStr.split(',').map((s) => s.trim().split(' = ')[0]);
        const setVals = setCols.map(() => params.shift());
        const id = String(params[0]);
        for (const r of tables[table]!) if (String(r[wc]) === id) setCols.forEach((c, i) => (r[c] = setVals[i]));
      }
      return { meta: { changes: 1, last_row_id: 0 } };
    }
    throw new Error(`fakeD1 unhandled: ${sql}`);
  };

  const binding = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async all() { return run(sql, params) as { results: Row[] }; },
            async run() { return run(sql, params) as { meta: { last_row_id: number; changes: number } }; },
          };
        },
      };
    },
  } as unknown as D1Binding;
  return { binding, tables };
}

// -------------------------------------------------------------------- tests

test('adapter: CF context -> Vercel handler (login with missing password -> 400)', async () => {
  const { binding } = fakeD1();
  const cfEnv = {
    DB: binding,
    LINE_CHANNEL_ACCESS_TOKEN: 'tok',
    LINE_CHANNEL_SECRET: 'sec',
    CRON_SECRET: 'cron',
    SESSION_SECRET: 'sess',
  };
  setCfEnv(cfEnv); // ensure deps() knows we're on CF
  try {
    const res = await onRequest({
      request: new Request('http://line-msg.pages.dev/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      env: cfEnv,
      params: { path: ['login'] },
    });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.error, 'ต้องใส่รหัสผ่าน');
  } finally {
    setCfEnv(null);
  }
});

test('adapter: unknown route -> 404 JSON', async () => {
  const cfEnv = {
    DB: fakeD1().binding,
    LINE_CHANNEL_ACCESS_TOKEN: 'tok',
    LINE_CHANNEL_SECRET: 'sec',
    CRON_SECRET: 'cron',
    SESSION_SECRET: 'sess',
  };
  setCfEnv(cfEnv);
  try {
    const res = await onRequest({
      request: new Request('http://x.pages.dev/api/nope', { method: 'GET' }),
      env: cfEnv,
      params: { path: ['nope'] },
    });
    assert.equal(res.status, 404);
    const body: any = await res.json();
    assert.match(body.error ?? '', /no route/);
  } finally {
    setCfEnv(null);
  }
});

test('adapter: webhook uses raw body + bad signature -> 401 (no signature header)', async () => {
  const { binding } = fakeD1();
  const cfEnv = {
    DB: binding,
    LINE_CHANNEL_ACCESS_TOKEN: 'tok',
    LINE_CHANNEL_SECRET: 'sec',
    CRON_SECRET: 'cron',
    SESSION_SECRET: 'sess',
  };
  setCfEnv(cfEnv);
  try {
    const res = await onRequest({
      request: new Request('http://x.pages.dev/api/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }, // no x-line-signature
        body: JSON.stringify({ events: [] }),
      }),
      env: cfEnv,
      params: { path: ['webhook'] },
    });
    // verifySignature(raw, undefined, 'sec') -> false -> 401
    assert.equal(res.status, 401);
    const body: any = await res.json();
    assert.equal(body.error, 'bad signature');
  } finally {
    setCfEnv(null);
  }
});

test('adapter: env seam routes deps()/env() to D1 (cf-env set used by login verify)', async () => {
  // verifyPassword reads app_settings via Db(DbLike) → D1 binding; prove the
  // D1 path is taken (not PostgREST) by seeding admin_password_hash and using
  // an unknown password → 401 (still D1, not network).
  const { binding } = fakeD1({
    app_settings: [{ key: 'admin_password_hash', value: 'whatever-hash' }],
  });
  const cfEnv = {
    DB: binding,
    LINE_CHANNEL_ACCESS_TOKEN: 'tok',
    LINE_CHANNEL_SECRET: 'sec',
    CRON_SECRET: 'cron',
    SESSION_SECRET: 'sess',
  };
  setCfEnv(cfEnv);
  try {
    const res = await onRequest({
      request: new Request('http://x.pages.dev/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'wrong' }),
      }),
      env: cfEnv,
      params: { path: ['login'] },
    });
    // bcrypt.compare('wrong', 'whatever-hash') is false → 401 (no network needed)
    assert.equal(res.status, 401);
    const body: any = await res.json();
    assert.equal(body.error, 'รหัสผ่านไม่ถูกต้อง');
  } finally {
    setCfEnv(null);
  }
});
