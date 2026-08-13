import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { verifySignature, handleWebhook } from '../lib/webhook.js';
import { dbStub, lineStub } from './helpers/stubs.js';

const SECRET = 'test-channel-secret';
const sign = (body: string) => crypto.createHmac('sha256', SECRET).update(body).digest('base64');

// --------------------------------------------------------- verifySignature
test('accepts a signature computed the same way LINE computes it', () => {
  const body = '{"events":[]}';
  assert.equal(verifySignature(body, sign(body), SECRET), true);
});

test('rejects a signature for a different body (tamper detection)', () => {
  const body = '{"events":[]}';
  const tampered = '{"events":[{"type":"join"}]}';
  assert.equal(verifySignature(tampered, sign(body), SECRET), false);
});

test('rejects when the secret does not match', () => {
  const body = '{"events":[]}';
  assert.equal(verifySignature(body, sign(body), 'wrong-secret'), false);
});

test('rejects a missing signature header outright', () => {
  assert.equal(verifySignature('{}', undefined, SECRET), false);
});

test('does not throw on a signature of different length than expected', () => {
  // A naive Buffer.from(a).equals(b) would throw on length mismatch inside
  // timingSafeEqual; the length check must happen first.
  assert.equal(verifySignature('{}', 'short', SECRET), false);
});

// -------------------------------------------------------------- join event
test('join records the group as pending with live name and member count', async () => {
  const { db, tables } = dbStub();
  const line = lineStub({ memberCount: 5 });
  const res = await handleWebhook(
    { db, line: line.client },
    { events: [{ type: 'join', source: { type: 'group', groupId: 'Cnew' } }] },
  );

  assert.equal(res.handled, 1);
  assert.equal(tables.groups.length, 1);
  assert.equal(tables.groups[0].line_group_id, 'Cnew');
  assert.equal(tables.groups[0].status, 'pending');
  assert.equal(tables.groups[0].member_count, 5);
  assert.equal(tables.system_logs.at(-1)?.event, 'webhook_group_joined');
});

test('join for an already-known group logs instead of duplicating', async () => {
  const { db, tables } = dbStub({ groups: [{ id: 'g1', line_group_id: 'Cdup', status: 'inactive' }] });
  const line = lineStub();
  await handleWebhook({ db, line: line.client }, { events: [{ type: 'join', source: { type: 'group', groupId: 'Cdup' } }] });

  assert.equal(tables.groups.length, 1, 'must not create a second row');
  assert.equal(tables.groups[0].status, 'inactive', 're-join must not silently reactivate it');
  assert.equal(tables.system_logs.at(-1)?.event, 'webhook_group_join_existing');
});

// ------------------------------------------------------------- leave event
test('leave marks the group inactive without deleting history', async () => {
  const { db, tables } = dbStub({ groups: [{ id: 'g1', line_group_id: 'Cleft', status: 'active' }] });
  const line = lineStub();
  await handleWebhook({ db, line: line.client }, { events: [{ type: 'leave', source: { type: 'group', groupId: 'Cleft' } }] });

  assert.equal(tables.groups[0].status, 'inactive');
  assert.equal(tables.groups.length, 1);
  assert.equal(tables.system_logs.at(-1)?.event, 'webhook_group_left');
});

// ------------------------------------------------------ membership events
test('memberJoined refreshes the cached member_count, the quota multiplier', async () => {
  const { db, tables } = dbStub({ groups: [{ id: 'g1', line_group_id: 'Cg', member_count: 7 }] });
  const line = lineStub({ memberCount: 8 });
  await handleWebhook({ db, line: line.client }, { events: [{ type: 'memberJoined', source: { type: 'group', groupId: 'Cg' } }] });

  assert.equal(tables.groups[0].member_count, 8);
});

test('memberLeft refreshes downward too', async () => {
  const { db, tables } = dbStub({ groups: [{ id: 'g1', line_group_id: 'Cg', member_count: 7 }] });
  const line = lineStub({ memberCount: 6 });
  await handleWebhook({ db, line: line.client }, { events: [{ type: 'memberLeft', source: { type: 'group', groupId: 'Cg' } }] });

  assert.equal(tables.groups[0].member_count, 6);
});

test('a failed member-count lookup leaves the cached value untouched', async () => {
  const { db, tables } = dbStub({ groups: [{ id: 'g1', line_group_id: 'Cg', member_count: 7 }] });
  const line = lineStub({ memberCountStatus: 500 });
  await handleWebhook({ db, line: line.client }, { events: [{ type: 'memberJoined', source: { type: 'group', groupId: 'Cg' } }] });

  assert.equal(tables.groups[0].member_count, 7);
  assert.equal(tables.system_logs.at(-1)?.event, 'webhook_member_count_lookup_failed');
});

// ------------------------------------------------------------- other events
test('an unrelated event type (e.g. a text message) is logged and ignored', async () => {
  const { db, tables } = dbStub();
  const line = lineStub();
  const res = await handleWebhook({ db, line: line.client }, { events: [{ type: 'message' }] });

  assert.equal(res.handled, 1); // handled = "processed without crashing", not "acted on"
  assert.equal(tables.groups.length, 0);
  assert.equal(tables.system_logs.at(-1)?.event, 'webhook_event_ignored');
});

// ---------------------------------------------------------------- batching
test('multiple events in one payload are all processed independently', async () => {
  const { db, tables } = dbStub({ groups: [{ id: 'g1', line_group_id: 'Ca', member_count: 3 }] });
  const line = lineStub({ memberCount: 4 });
  const res = await handleWebhook(
    { db, line: line.client },
    {
      events: [
        { type: 'memberJoined', source: { type: 'group', groupId: 'Ca' } },
        { type: 'join', source: { type: 'group', groupId: 'Cb' } },
      ],
    },
  );

  assert.equal(res.handled, 2);
  assert.equal(tables.groups.find((g: any) => g.line_group_id === 'Ca')?.member_count, 4);
  assert.equal(tables.groups.find((g: any) => g.line_group_id === 'Cb')?.status, 'pending');
});

test('an empty events array is a no-op, not an error', async () => {
  const { db } = dbStub();
  const line = lineStub();
  assert.deepEqual(await handleWebhook({ db, line: line.client }, {}), { handled: 0 });
});
