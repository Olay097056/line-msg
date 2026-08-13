// In-memory stand-ins for LINE and PostgREST so the send logic can be tested
// without a network. The DB stub reproduces the one behaviour the real schema
// enforces and the code depends on: the partial unique index on
// (schedule_id, sent_on_local) where status = 'sent'.

import { Db } from '../../lib/db.js';
import { LineClient } from '../../lib/line.js';

export type LineStubOptions = {
  quota?: { type: string; value?: number };
  consumption?: { totalUsage: number };
  memberCount?: number;
  /** HTTP status for push; 200 unless overridden. */
  pushStatus?: number;
  /** status for the member-count call; 200 unless overridden */
  memberCountStatus?: number;
};

export type LineStub = {
  client: LineClient;
  pushes: Array<{ to: string; text: string; retryKey: string | null }>;
  calls: string[];
};

export function lineStub(opts: LineStubOptions = {}): LineStub {
  const pushes: LineStub['pushes'] = [];
  const calls: string[] = [];

  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const href = String(url);
    calls.push(href);
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

    if (href.endsWith('/message/quota')) {
      return reply(200, opts.quota ?? { type: 'limited', value: 300 });
    }
    if (href.endsWith('/quota/consumption')) {
      return reply(200, opts.consumption ?? { totalUsage: 0 });
    }
    if (href.endsWith('/members/count')) {
      const status = opts.memberCountStatus ?? 200;
      return status === 200 ? reply(200, { count: opts.memberCount ?? 7 }) : reply(status, { message: 'nope' });
    }
    if (href.endsWith('/message/push')) {
      const parsed = JSON.parse(String(init.body));
      const headers = new Headers(init.headers as HeadersInit);
      pushes.push({
        to: parsed.to,
        text: parsed.messages[0].text,
        retryKey: headers.get('X-Line-Retry-Key'),
      });
      const status = opts.pushStatus ?? 200;
      return status === 200
        ? reply(200, { sentMessages: [{ id: 'msg-1', quotaType: 'free' }] })
        : reply(status, { message: 'boom' });
    }
    return reply(404, { message: `unstubbed ${href}` });
  }) as typeof fetch;

  return { client: new LineClient('test-token', fetchImpl), pushes, calls };
}

type Row = Record<string, any>;

export type DbStub = {
  db: Db;
  tables: Record<string, Row[]>;
};

export function dbStub(seed: Record<string, Row[]> = {}): DbStub {
  const tables: Record<string, Row[]> = {
    groups: [],
    schedules: [],
    message_templates: [],
    send_logs: [],
    system_logs: [],
    quota_snapshots: [],
    app_settings: [],
    ...seed,
  };
  let nextId = 1;

  const parseFilters = (qs: string) => {
    const params = new URLSearchParams(qs);
    const filters: Array<[string, string, string]> = [];
    for (const [key, value] of params) {
      if (key === 'select' || key === 'order' || key === 'limit' || key === 'offset') continue;
      const [op, ...rest] = value.split('.');
      filters.push([key, op, rest.join('.')]);
    }
    return filters;
  };

  const matches = (row: Row, filters: Array<[string, string, string]>) =>
    filters.every(([col, op, val]) => {
      if (op === 'eq') return String(row[col]) === val;
      if (op === 'is') return val === 'true' ? row[col] === true : row[col] === null;
      if (op === 'in') return val.replace(/[()]/g, '').split(',').includes(String(row[col]));
      throw new Error(`stub does not implement filter op ${op}`);
    });

  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    const href = String(url);
    const [, tail] = href.split('/rest/v1/');
    const [table, qs = ''] = tail.split('?');
    const rows = (tables[table] ??= []);
    const method = init.method ?? 'GET';
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

    if (method === 'GET') return json(200, rows.filter((r) => matches(r, parseFilters(qs))));

    if (method === 'POST') {
      const payload = JSON.parse(String(init.body));
      const incoming: Row[] = Array.isArray(payload) ? payload : [payload];
      const created: Row[] = [];
      for (const row of incoming) {
        if (table === 'groups' && row.line_group_id) {
          const clash = rows.some((r) => r.line_group_id === row.line_group_id);
          if (clash) {
            return json(409, {
              code: '23505',
              message: 'duplicate key value violates unique constraint "groups_line_group_id_key"',
            });
          }
        }
        if (table === 'send_logs' && row.status === 'sent' && row.schedule_id) {
          const day = new Date().toISOString().slice(0, 10);
          const clash = rows.some(
            (r) => r.status === 'sent' && r.schedule_id === row.schedule_id && r.sent_on_local === day,
          );
          if (clash) {
            return json(
              409,
              { code: '23505', message: 'duplicate key value violates unique constraint "send_logs_schedule_day_unique"' },
            );
          }
          row.sent_on_local = day;
        }
        const stored = { id: nextId++, created_at: new Date().toISOString(), ...row };
        rows.push(stored);
        created.push(stored);
      }
      return json(201, created);
    }

    if (method === 'PATCH') {
      const patch = JSON.parse(String(init.body));
      const filters = parseFilters(qs);
      const hit = rows.filter((r) => matches(r, filters));
      hit.forEach((r) => Object.assign(r, patch));
      return json(200, hit);
    }

    if (method === 'DELETE') {
      const filters = parseFilters(qs);
      const hit = rows.filter((r) => matches(r, filters));
      tables[table] = rows.filter((r) => !matches(r, filters));
      return json(200, hit);
    }

    return json(405, { message: method });
  }) as typeof fetch;

  return { db: new Db('https://stub.supabase.co', 'service-key', fetchImpl), tables };
}
