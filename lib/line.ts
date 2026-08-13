// LINE Messaging API client.
//
// Endpoints and their semantics were verified against the official docs in
// ticket 01 and against the live account in ticket 02:
//   POST /v2/bot/message/push                 push (max 5 message objects)
//   GET  /v2/bot/message/quota                {"type":"limited","value":300}
//   GET  /v2/bot/message/quota/consumption    {"totalUsage":175}
//   GET  /v2/bot/group/{id}/summary           {"groupName": ...}
//   GET  /v2/bot/group/{id}/members/count     {"count":7}

const BASE = 'https://api.line.me';

export type Fetcher = typeof fetch;

export type LineResult<T> = {
  ok: boolean;
  status: number;
  body: T | null;
  raw: string;
};

export class LineClient {
  #token: string;
  #fetch: Fetcher;

  constructor(token: string, fetchImpl: Fetcher = fetch) {
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  async #call<T>(path: string, init: RequestInit = {}): Promise<LineResult<T>> {
    const res = await this.#fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
    const raw = await res.text();
    let body: T | null = null;
    try {
      body = raw ? (JSON.parse(raw) as T) : null;
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body, raw };
  }

  quota() {
    return this.#call<{ type: string; value?: number }>('/v2/bot/message/quota');
  }

  consumption() {
    return this.#call<{ totalUsage: number }>('/v2/bot/message/quota/consumption');
  }

  groupSummary(groupId: string) {
    return this.#call<{ groupId: string; groupName: string; pictureUrl?: string }>(
      `/v2/bot/group/${encodeURIComponent(groupId)}/summary`,
    );
  }

  memberCount(groupId: string) {
    return this.#call<{ count: number }>(
      `/v2/bot/group/${encodeURIComponent(groupId)}/members/count`,
    );
  }

  /**
   * `retryKey` must be a UUID. Reusing it makes LINE treat a repeated call as
   * the same send instead of a second one (ticket 01), which protects against
   * a retry that lands after our own write succeeded.
   */
  push(to: string, text: string, retryKey?: string) {
    return this.#call<Record<string, unknown>>('/v2/bot/message/push', {
      method: 'POST',
      headers: retryKey ? { 'X-Line-Retry-Key': retryKey } : {},
      body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
    });
  }
}
