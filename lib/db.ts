// Thin PostgREST client for Supabase (Vercel path).
//
// The service_role key bypasses RLS, which is the whole access model: every
// table has RLS on with zero policies (migration 0001), so anon/authenticated
// can read nothing and only this server-side path works.
//
// DbLike is the shared structural interface both the PostgREST Db and the D1
// Db (lib/d1.ts) implement, so http/send/webhook can accept either without
// depending on private fields.

export type Fetcher = typeof fetch;
export type DbRow = Record<string, unknown>;
export type Row = DbRow;

export interface DbLike {
  select(table: string, query?: string): Promise<any[]>;
  insert(table: string, rows: unknown, opts?: { returning?: boolean }): Promise<any[]>;
  update(table: string, query: string, patch: unknown): Promise<any[]>;
  delete(table: string, query: string): Promise<any[]>;
  log(level: string, event: string, detail?: unknown): Promise<void>;
}

export class Db implements DbLike {
  #url: string;
  #key: string;
  #fetch: Fetcher;

  constructor(url: string, serviceKey: string, fetchImpl: Fetcher = fetch) {
    this.#url = url.replace(/\/$/, '');
    this.#key = serviceKey;
    this.#fetch = fetchImpl;
  }

  async #call(path: string, init: RequestInit = {}): Promise<any> {
    const res = await this.#fetch(`${this.#url}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: this.#key,
        Authorization: `Bearer ${this.#key}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`db ${init.method ?? 'GET'} ${path} -> ${res.status} ${text}`);
    }
    return text ? JSON.parse(text) : null;
  }

  select(table: string, query = ''): Promise<any[]> {
    return this.#call(`${table}${query ? `?${query}` : ''}`);
  }

  async insert(table: string, rows: unknown, opts: { returning?: boolean } = {}): Promise<any[]> {
    return this.#call(table, {
      method: 'POST',
      headers: { Prefer: opts.returning === false ? 'return=minimal' : 'return=representation' },
      body: JSON.stringify(rows),
    });
  }

  update(table: string, query: string, patch: unknown): Promise<any[]> {
    return this.#call(`${table}?${query}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    });
  }

  delete(table: string, query: string): Promise<any[]> {
    return this.#call(`${table}?${query}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=representation' },
    });
  }

  /**
   * Best-effort diagnostic write. Never throws: a broken logger must not be the
   * reason a send fails.
   */
  async log(level: 'debug' | 'info' | 'warn' | 'error', event: string, detail?: unknown) {
    try {
      await this.insert('system_logs', { level, event, detail: detail ?? null }, { returning: false });
    } catch {
      // swallowed on purpose
    }
  }
}

/** true when a Postgres unique-violation (23505) caused the error. */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && err.message.includes('23505');
}
