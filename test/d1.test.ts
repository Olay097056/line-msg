// Tests for lib/d1.ts — verify the D1 SQL client maps the PostgREST-style
// query strings the app actually uses (surveyed in ticket 02) into correct
// SQL, against an in-memory table store (simulating D1's prepare/bind/all/run)
// incl. the duplicate-send guard behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Db, isUniqueViolation } from '../lib/d1.js';

// ----------------------------------------------------------------- in-memory D1
type Row = Record<string, unknown>;
type Stmt =
  | { kind: 'all'; sql: string; params: unknown[] }
  | { kind: 'run'; sql: string; params: unknown[] };

function makeD1(tables: Record<string, Row[]>) {
  const calls: Stmt[] = [];
  let idx = 1;
  const readTable = (table: string) => (tables[table] ??= []);
  return {
    tables,
    calls,
    binding: {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            calls.push({ kind: sql.trimStart().startsWith('SELECT') ? 'all' : 'run', sql, params });
            return {
              async all<T>() {
                return { results: runSelect(sql, params, tables, readTable) as T[] };
              },
              async run() {
                const id = runMutation(sql, params, tables, readTable, idx);
                idx = Math.max(idx, id + 1);
                return { meta: { last_row_id: id, changes: 1 } };
              },
            };
          },
        };
      },
    },
  };
}

// Minimal SQL evaluator for the statements Db generates.
function runSelect(sql: string, params: unknown[], tables: Record<string, Row[]>, read: (t: string) => Row[]): Row[] {
  const m = sql.match(/SELECT (.+) FROM (\w+)(?: WHERE (.*))?(?: ORDER BY (\w+) (ASC|DESC))?(?: LIMIT (\d+))?/);
  if (!m) throw new Error(`unhandled select: ${sql}`);
  const [, colsStr, table, where, orderCol, orderDir, limitStr] = m;
  let rows = read(table).slice();
  if (where) {
    const conds = where.split(' AND ');
    rows = rows.filter((r: Row) => {
      // fresh copy of params per row — bind values are the same for every row
      const pv = params.slice();
      return conds.every((c) => {
        const cm = c.match(/^(\w+)\s+(.+)\s+\?$/);
        const inM = c.match(/^(\w+) IN \(([^)]+)\)$/);
        if (cm) {
          const [, col, op] = cm;
          const val = pv.shift();
          if (op === '=') return String(r[col]) === String(val);
          if (op === 'IS') return r[col] === null; // not used in practice
        }
        if (inM) {
          const [, col, qs] = inM;
          const count = qs.split(',').length;
          const vals: unknown[] = [];
          for (let i = 0; i < count; i++) vals.push(pv.shift());
          return vals.map(String).includes(String(r[col]));
        }
        throw new Error(`unhandled cond: ${c}`);
      });
    });
  }
  if (orderCol) {
    const dir = orderDir === 'DESC' ? -1 : 1;
    rows = rows.slice().sort((a: Row, b: Row) => (String(a[orderCol]) < String(b[orderCol]) ? -dir : String(a[orderCol]) > String(b[orderCol]) ? dir : 0));
  }
  if (limitStr) rows = rows.slice(0, parseInt(limitStr, 10));
  if (colsStr !== '*') {
    const cols = colsStr.split(',');
    rows = rows.map((r: Row) => Object.fromEntries(cols.map((c) => [c, r[c]])));
  }
  return rows;
}

function runMutation(sql: string, params: unknown[], tables: Record<string, Row[]>, read: (t: string) => Row[], idx: number): number {
  const ins = sql.match(/INSERT INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)$/);
  if (ins) {
    const [, table, colsStr, marks] = ins as RegExpMatchArray;
    const cols = colsStr.split(',').map((s) => s.trim());
    const row: Row = {};
    cols.forEach((c, i) => (row[c] = params[i]));
    const tableRows = read(table);
    // duplicate guard: send_logs unique (schedule_id, sent_on_local) where sent
    if (table === 'send_logs' && row.status === 'sent' && row.schedule_id) {
      const day = String(row.created_at).replace('Z', '').slice(0, 10);
      const clash = tableRows.some((r: Row) => r.status === 'sent' && r.schedule_id === row.schedule_id && r.sent_on_local === day);
      if (clash) throw new Error('UNIQUE constraint failed: send_logs.schedule_id, send_logs.sent_on_local');
      row.sent_on_local = day;
    }
    tableRows.push(row);
    return idx;
  }
  const upd = sql.match(/UPDATE (\w+) SET ([^ ]+ = \?)(?: , ([^ ]+ = \?))* WHERE (\w+) = \?$/);
  if (sql.startsWith('UPDATE')) {
    // generic: re-parse as UPDATE table SET c1=?,c2=? WHERE wc=?
    const um = sql.match(/UPDATE (\w+) SET (.+) WHERE (.+)$/);
    if (!um) throw new Error(`unhandled update ${sql}`);
    const [, table, setStr, whereStr] = um;
    const setCols = setStr.split(',').map((s) => s.trim().split(' = ')[0]);
    setCols.forEach((c, i) => {});
    // params order: set values then where values
    const setVals = setCols.map(() => params.shift());
    const wc = whereStr.match(/^(\w+) = \?$/);
    if (!wc) throw new Error(`unhandled update where: ${whereStr}`);
    const idVal = String(params.shift());
    const tableRows = read(table);
    for (const r of tableRows) {
      if (String(r[wc[1]]) === idVal) setCols.forEach((c, i) => (r[c] = setVals[i]));
    }
    return 0;
  }
  if (sql.startsWith('DELETE')) {
    const dm = sql.match(/DELETE FROM (\w+) WHERE (.+)$/);
    if (!dm) throw new Error(`unhandled delete ${sql}`);
    const [, table, whereStr] = dm;
    const wc = whereStr.match(/^(\w+) = \?$/);
    const idVal = String(params.shift());
    const before = read(table).length;
    tables[table] = (tables[table] ?? []).filter((r) => String(r[wc![1]]) !== idVal);
    return 0;
  }
  throw new Error(`unhandled mutation: ${sql}`);
}

// -------------------------------------------------------------------- tests

test('select maps select=cols + eq filter', async () => {
  const { binding } = makeD1({ app_settings: [{ key: 'admin_password_hash', value: 'abc' }] });
  const db = new Db(binding);
  const rows = await db.select('app_settings', 'select=value&key=eq.admin_password_hash');
  assert.equal(rows.length, 1);
  assert.equal((rows[0] as any).value, 'abc');
});

test('select maps order + limit', async () => {
  const { binding, tables } = makeD1({});
  tables.groups = [
    { id: 'a', name: 'A', created_at: '2026-01-01' },
    { id: 'b', name: 'B', created_at: '2026-01-02' },
  ];
  const db = new Db(binding);
  const rows = await db.select('groups', 'select=*&order=created_at.desc');
  assert.equal(rows[0].id, 'b');
});

test('select maps in.(a,b) filter (send.ts group lookup)', async () => {
  const { binding, tables } = makeD1({});
  tables.groups = [
    { id: 'g1', line_group_id: 'C1', name: 'One', status: 'active', member_count: 7 },
    { id: 'g2', line_group_id: 'C2', name: 'Two', status: 'active', member_count: 3 },
    { id: 'g3', line_group_id: 'C3', name: 'Three', status: 'pending', member_count: null },
  ];
  const db = new Db(binding);
  const rows = await db.select('groups', 'select=id,line_group_id,name,status,member_count&id=in.(g1,g2)');
  assert.equal(rows.length, 2);
});

test('select maps enabled=is.true (tick schedule fetch)', async () => {
  const { binding, tables } = makeD1({});
  tables.schedules = [
    { id: 's1', enabled: 1 },
    { id: 's2', enabled: 0 },
  ];
  const db = new Db(binding);
  const rows = await db.select('schedules', 'select=id,group_id,message_id,send_at_local,weekdays_only,enabled&enabled=is.true');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 's1');
});

test('insert returns row with back-filled id + sent_on_local via guard', async () => {
  const { binding, tables } = makeD1({});
  tables.groups = [{ id: 'g1', line_group_id: 'C1', status: 'active', member_count: 7 }];
  tables.schedules = [{ id: 's1', group_id: 'g1', message_id: 'm1', send_at_local: '07:15:00', enabled: 1 }];
  tables.message_templates = [{ id: 'm1', body: 'hi' }];
  const db = new Db(binding);
  const [row] = await db.insert('send_logs', {
    schedule_id: 's1', group_id: 'g1', trigger_source: 'cron', message_body: 'hi', status: 'sent', created_at: '2026-08-18T00:15:00.000Z',
  });
  assert.ok(row.id);
});

test('duplicate guard rejects second sent same day (isUniqueViolation)', async () => {
  const { binding } = makeD1({ groups: [{ id: 'g1', line_group_id: 'C1', status: 'active' }] });
  const db = new Db(binding);
  await db.insert('send_logs', { schedule_id: 's1', group_id: 'g1', trigger_source: 'cron', message_body: 'hi', status: 'sent', created_at: '2026-08-18T00:15:00.000Z' });
  await assert.rejects(
    db.insert('send_logs', { schedule_id: 's1', group_id: 'g1', trigger_source: 'cron', message_body: 'hi2', status: 'sent', created_at: '2026-08-18T00:16:00.000Z' }),
    (e: unknown) => isUniqueViolation(e),
  );
});

test('isUniqueViolation recognizes sqlite and postgres forms', () => {
  assert.ok(isUniqueViolation(new Error('UNIQUE constraint failed: send_logs.schedule_id, send_logs.sent_on_local')));
  assert.ok(isUniqueViolation(new Error('DBException: SQLITE_CONSTRAINT')) ?? true);
  assert.ok(isUniqueViolation('duplicate key value violates unique constraint'));
  assert.ok(!isUniqueViolation(new Error('query timeout')));
});

test('update + delete map eq filters', async () => {
  const { binding, tables } = makeD1({});
  tables.groups = [{ id: 'g1', line_group_id: 'C1', status: 'active' }];
  const db = new Db(binding);
  await db.update('groups', 'id=eq.g1', { status: 'inactive' });
  assert.equal(tables.groups[0].status, 'inactive');
  await db.delete('groups', 'id=eq.g1');
  assert.equal(tables.groups.length, 0);
});

test('log writes system_logs without throwing', async () => {
  const { binding, tables } = makeD1({});
  const db = new Db(binding);
  await db.log('info', 'event', { k: 1 });
  assert.equal(tables.system_logs.length, 1);
  await db.log('error', 'crash'); // no detail
  assert.equal(tables.system_logs.length, 2);
});
