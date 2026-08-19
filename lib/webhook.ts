// LINE webhook signature verification + event handling, kept pure so it can be
// unit-tested without a real Vercel request object.
//
// Signature scheme (LINE docs, ticket 09): X-Line-Signature is
// base64(HMAC-SHA256(channelSecret, rawRequestBody)). It MUST be computed over
// the exact raw bytes LINE sent — re-serializing parsed JSON can produce a
// different byte string (key order, whitespace) and break verification even
// when the payload is "the same".

import crypto from 'node:crypto';
import type { DbLike } from './db.js';
import type { LineClient } from './line.js';

export function verifySignature(rawBody: string, signatureHeader: string | undefined, channelSecret: string): boolean {
  if (!signatureHeader) return false;
  const expected = crypto.createHmac('sha256', channelSecret).update(rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export type LineEvent = {
  type: string;
  source?: { type: string; groupId?: string; userId?: string };
  timestamp?: number;
};

export type WebhookBody = { events?: LineEvent[] };

export type HandleDeps = { db: DbLike; line: LineClient };

/**
 * Processes one webhook payload. Never throws outward — LINE retries on
 * non-2xx, and a retry storm from one bad event is worse than losing it, so
 * each event is handled best-effort and logged.
 */
export async function handleWebhook(deps: HandleDeps, body: WebhookBody): Promise<{ handled: number }> {
  const { db } = deps;
  const events = body.events ?? [];
  let handled = 0;

  for (const event of events) {
    try {
      await handleOne(deps, event);
      handled++;
    } catch (err) {
      await db.log('error', 'webhook_event_failed', { type: event.type, message: String(err) });
    }
  }

  return { handled };
}

async function handleOne({ db, line }: HandleDeps, event: LineEvent): Promise<void> {
  const groupId = event.source?.groupId;

  if (event.type === 'join') {
    if (!groupId) return;
    const summary = await line.groupSummary(groupId);
    const count = await line.memberCount(groupId);
    try {
      const [row] = await db.insert('groups', {
        line_group_id: groupId,
        name: summary.ok ? summary.body?.groupName ?? null : null,
        status: 'pending',
        member_count: count.ok ? count.body?.count ?? null : null,
        member_count_checked_at: count.ok ? new Date().toISOString() : null,
      });
      await db.log('info', 'webhook_group_joined', row);
    } catch (err) {
      // Already known (bot re-invited to a group it left before) — just log,
      // do not resurrect it as active behind the user's back.
      await db.log('info', 'webhook_group_join_existing', { groupId, message: String(err) });
    }
    return;
  }

  if (event.type === 'leave') {
    if (!groupId) return;
    const rows = await db.update('groups', `line_group_id=eq.${groupId}`, { status: 'inactive' });
    await db.log('warn', 'webhook_group_left', { groupId, matched: rows.length });
    return;
  }

  if (event.type === 'memberJoined' || event.type === 'memberLeft') {
    if (!groupId) return;
    const count = await line.memberCount(groupId);
    if (!count.ok || typeof count.body?.count !== 'number') {
      await db.log('warn', 'webhook_member_count_lookup_failed', { groupId, status: count.status });
      return;
    }
    const rows = await db.update('groups', `line_group_id=eq.${groupId}`, {
      member_count: count.body.count,
      member_count_checked_at: new Date().toISOString(),
    });
    await db.log('info', 'webhook_member_count_updated', {
      groupId,
      type: event.type,
      newCount: count.body.count,
      matched: rows.length,
    });
    return;
  }

  // Any other event type (message, follow, postback, ...) is out of scope —
  // this deployment only pushes outbound, it never replies (ticket 03 หมวด F).
  await db.log('debug', 'webhook_event_ignored', { type: event.type });
}
