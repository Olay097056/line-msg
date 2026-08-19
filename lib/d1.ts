// D1 (SQLite) data access — Cloudflare migration port of lib/db.ts.
//
// Keeps the SAME async surface the app uses (select/insert/update/delete/log)
// so lib/send.ts, lib/http.ts and api/* need no changes, but executes prepared
// SQL against Cloudflare D1 instead of PostgREST.
//
// PostgREST query-string -> SQL mapping (the subset actually used, surveyed
// 2026-08-18 across lib/ + api/):
//   select=<cols>                    -> SELECT <cols>
//   <col>=eq.<v>                     -> WHERE col = ?
//   <col>=in.(a,b)                   -> WHERE col IN (?,?)
//   <col>=is.true                    -> WHERE col IS NOT NULL/TRUE (enabled=1)
//   order=<col>.asc|.desc            -> ORDER BY col ASC|DESC
//   limit=N                          -> LIMIT N
// insert returns created rows (id + defaults back-filled).
// update/delete accept a query string of eq filters + a patch object.

import type { DbLike } from './db.js';

export type D1Row = Record<string, unknown>;

/** Minimal D1 binding surface we rely on (Cloudflare's D1Database). */
export interface D1Binding {
  prepare(sql: string): {
    bind(...params: unknown[]): unknown;
  };
  // We keep exec for the few statements without params (e.g. logging inserts
  // already bound); all our calls go through prepare().bind().run().
  exec?(sql: string): Promise<unknown>;
}

type D1Datum = string | number | boolean | Uint8Array | null;

/**
 * True when a SQLite error (from the D1 binding) is a UNIQUE violation.
 * SQLite reports this as code SQLITE_CONSTRAINT / message "UNIQUE constraint
 * failed: <table>.<col>". The previous PostgREST path checked Postgres code
 * '23505'; D1 exposes SQLite semantics instead.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (!err) return false;
  const s = String(err);
  return (
    /SQLITE_CONSTRAINT|UNIQUE constraint failed/i.test(s) ||
    /23505|duplicate/i.test(s) // tolerate both for safety
  );
}

export class Db implements DbLike {
  #d1: D1Binding;

  constructor(d1: D1Binding) {
    this.#d1 = d1;
  }

  // ------------------------------------------------------------------ helpers

  /** Parse a PostgREST-style query string into {cols, where, order, limit}. */
  #parse(qs = ''): { cols: string[]; where: string[]; params: D1Datum[]; order: string; limit: number | null } {
    const cols = ['*'];
    const where: string[] = [];
    const params: D1Datum[] = [];
    let order = '';
    let limit: number | null = null;

    for (const pair of qs.split('&')) {
      if (!pair) continue;
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) continue;
      const key = pair.slice(0, eqIdx);
      const value = pair.slice(eqIdx + 1);

      if (key === 'select') {
        cols.length = 0;
        cols.push(...value.split(',').map((c) => c.trim()));
      } else if (key === 'order') {
        order = value
          .split(',')
          .map((o) => {
            const [col, dir] = o.split('.');
            return `${col} ${dir === 'desc' ? 'DESC' : 'ASC'}`;
          })
          .join(', ');
      } else if (key === 'limit') {
        limit = parseInt(value, 10) || null;
      } else {
        // filter: <col>=<op>.<val>
        const dot = value.indexOf('.');
        if (dot === -1) continue;
        const op = value.slice(0, dot);
        const val = value.slice(dot + 1);
        if (op === 'eq') {
          where.push(`${key} = ?`);
          params.push(val);
        } else if (op === 'in') {
          const items = val.replace(/[()]/g, '').split(',');
          where.push(`${key} IN (${items.map(() => '?').join(',')})`);
          params.push(...items);
        } else if (op === 'is') {
          // PostgREST is.true / is.null; we only use enabled=is.true => 1
          if (val === 'true') {
            where.push(`${key} = ?`);
            params.push(1);
          } else if (val === 'null') {
            where.push(`${key} IS NULL`);
          } else {
            where.push(`${key} = ?`);
            params.push(val === 'false' ? 0 : val);
          }
        }
        // unsupported ops are ignored like the stub throws; keep surface small
      }
    }
    return { cols, where, params, order, limit };
  }

  // ------------------------------------------------------------------- select

  async select(table: string, query = ''): Promise<any[]> {
    const { cols, where, params, order, limit } = this.#parse(query);
    let sql = `SELECT ${cols.join(', ')} FROM ${table}`;
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    if (order) sql += ` ORDER BY ${order}`;
    if (limit !== null) sql += ` LIMIT ${limit}`;
    const stmt = this.#d1.prepare(sql).bind(...params) as { all<T>(): Promise<{ results: T[] }> };
    const { results } = await stmt.all<any>();
    return results;
  }

  // ------------------------------------------------------------------- insert

  async insert(table: string, rows: unknown, opts: { returning?: boolean } = {}): Promise<any[]> {
    const list: Array<Record<string, unknown>> = Array.isArray(rows) ? rows : [rows];
    const out: any[] = [];
    for (const row of list) {
      const cols = Object.keys(row);
      const qmarks = cols.map(() => '?').join(', ');
      const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${qmarks})`;
      const params = cols.map((c) => row[c]);
      const stmt = this.#d1.prepare(sql).bind(...params) as {
        run(): Promise<{ meta: { last_row_id: number; changes: number } }>;
      };
      const res = await stmt.run();
      // Back-fill row id + defaults so callers (e.g. sendOne's claim.id) work.
      const created = { ...row, id: res.meta.last_row_id };
      if (opts.returning === false) continue; // fire-and-forget (log)
      out.push(created);
    }
    return out;
  }

  // ------------------------------------------------------------------- update

  async update(table: string, query: string, patch: unknown): Promise<any[]> {
    const { where, params } = this.#parse(query);
    const cols = Object.keys(patch as Record<string, unknown>);
    if (!cols.length || !where.length) return [];
    const setSql = cols.map((c) => `${c} = ?`).join(', ');
    const setParams = cols.map((c) => (patch as Record<string, unknown>)[c]);
    const sql = `UPDATE ${table} SET ${setSql} WHERE ${where.join(' AND ')}`;
    const stmt = this.#d1.prepare(sql).bind(...setParams, ...params) as { run(): Promise<unknown> };
    await stmt.run();
    // return representation of touched rows via a follow-up select on same filters
    return this.select(table, query);
  }

  // ------------------------------------------------------------------- delete

  async delete(table: string, query: string): Promise<any[]> {
    const { where, params } = this.#parse(query);
    if (!where.length) return [];
    const sql = `DELETE FROM ${table} WHERE ${where.join(' AND ')}`;
    const stmt = this.#d1.prepare(sql).bind(...params) as { run(): Promise<unknown> };
    await stmt.run();
    return [];
  }

  // --------------------------------------------------------------------- log

  /** Best-effort diagnostic write. Never throws. */
  async log(level: string, event: string, detail?: unknown): Promise<void> {
    try {
      await this.insert(
        'system_logs',
        { level, event, detail: detail != null ? JSON.stringify(detail) : null },
        { returning: false },
      );
    } catch {
      // swallowed on purpose — a broken logger must not fail a send
    }
  }
}
