import test from 'node:test';
import assert from 'node:assert/strict';

import { runTick, sendOne, readQuota, resolveRecipients, type Group } from '../lib/send.js';
import { dbStub, lineStub } from './helpers/stubs.js';

const GROUP: Group = {
  id: 'g1',
  line_group_id: 'Cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  name: 'CU Test Group',
  status: 'active',
  member_count: 7,
};

const seeded = () =>
  dbStub({
    groups: [{ ...GROUP }],
    message_templates: [{ id: 'm1', body: 'Send TIME' }],
    schedules: [
      {
        id: 's-morning',
        group_id: 'g1',
        message_id: 'm1',
        send_at_local: '07:15:00',
        weekdays_only: true,
        enabled: true,
      },
    ],
  });

// Thursday 2026-08-13, 07:15 Bangkok
const AT_0715 = new Date('2026-08-13T00:15:00Z');
// Saturday 2026-08-15, 07:15 Bangkok
const SATURDAY_0715 = new Date('2026-08-15T00:15:00Z');

// ------------------------------------------------------------------ quota
test('readQuota reads live values and snapshots them', async () => {
  const { db, tables } = seeded();
  const line = lineStub({ quota: { type: 'limited', value: 300 }, consumption: { totalUsage: 175 } });
  const state = await readQuota({ db, line: line.client });

  assert.deepEqual(state, { type: 'limited', limit: 300, totalUsage: 175 });
  assert.equal(tables.quota_snapshots.length, 1);
  assert.equal(tables.quota_snapshots[0].total_usage, 175);
});

test('readQuota keeps limit null when the plan is unlimited', async () => {
  const { db } = seeded();
  const line = lineStub({ quota: { type: 'none' }, consumption: { totalUsage: 4 } });
  assert.deepEqual(await readQuota({ db, line: line.client }), {
    type: 'none',
    limit: null,
    totalUsage: 4,
  });
});

// ------------------------------------------------------------- recipients
test('member count refreshes the stored value when the group grows', async () => {
  const { db, tables } = seeded();
  const line = lineStub({ memberCount: 9 });
  assert.equal(await resolveRecipients({ db, line: line.client }, GROUP), 9);
  assert.equal(tables.groups[0].member_count, 9);
  assert.equal(tables.system_logs.at(-1)?.event, 'member_count_changed');
});

test('member count falls back to the stored value when LINE errors', async () => {
  const { db, tables } = seeded();
  const line = lineStub({ memberCountStatus: 500 });
  assert.equal(await resolveRecipients({ db, line: line.client }, GROUP), 7);
  assert.equal(tables.system_logs.at(-1)?.event, 'member_count_lookup_failed');
});

test('member count with no fallback is an error, not a guess', async () => {
  const { db } = seeded();
  const line = lineStub({ memberCountStatus: 500 });
  await assert.rejects(
    () => resolveRecipients({ db, line: line.client }, { ...GROUP, member_count: null }),
    /ไม่ทราบจำนวนสมาชิก/,
  );
});

// ---------------------------------------------------------------- sendOne
test('a successful send pushes once and records the LINE response', async () => {
  const { db, tables } = seeded();
  const line = lineStub();
  const out = await sendOne(
    { db, line: line.client },
    {
      group: GROUP,
      body: 'Send TIME',
      triggerSource: 'cron',
      scheduleId: 's-morning',
      quota: { type: 'limited', limit: 300, totalUsage: 175 },
      recipients: 7,
    },
  );

  assert.equal(out.status, 'sent');
  assert.equal(line.pushes.length, 1);
  assert.equal(line.pushes[0].to, GROUP.line_group_id);
  assert.equal(line.pushes[0].text, 'Send TIME');
  assert.match(line.pushes[0].retryKey ?? '', /^[0-9a-f-]{36}$/);

  const log = tables.send_logs[0];
  assert.equal(log.status, 'sent');
  assert.equal(log.recipients_count, 7);
  assert.equal(log.quota_used_before, 175);
  assert.equal(log.line_status_code, 200);
  assert.equal(log.line_request_id, 'msg-1');
});

test('quota guard blocks the push and still writes a log row', async () => {
  const { db, tables } = seeded();
  const line = lineStub();
  const out = await sendOne(
    { db, line: line.client },
    {
      group: GROUP,
      body: 'Send TIME',
      triggerSource: 'cron',
      scheduleId: 's-morning',
      quota: { type: 'limited', limit: 300, totalUsage: 294 }, // only 6 left, need 7
      recipients: 7,
    },
  );

  assert.equal(out.status, 'skipped_quota');
  assert.equal(line.pushes.length, 0, 'must not call LINE at all');
  assert.equal(tables.send_logs[0].status, 'skipped_quota');
  assert.match(tables.send_logs[0].error_detail, /เหลือ 6 จาก 300/);
});

test('a LINE failure downgrades the claim to failed, releasing the day slot', async () => {
  const { db, tables } = seeded();
  const line = lineStub({ pushStatus: 500 });
  const out = await sendOne(
    { db, line: line.client },
    {
      group: GROUP,
      body: 'Send TIME',
      triggerSource: 'cron',
      scheduleId: 's-morning',
      quota: { type: 'limited', limit: 300, totalUsage: 0 },
      recipients: 7,
    },
  );

  assert.equal(out.status, 'failed');
  assert.equal(tables.send_logs[0].status, 'failed');
  assert.equal(tables.send_logs[0].line_status_code, 500);
  assert.equal(tables.system_logs.at(-1)?.event, 'line_push_failed');
});

test('a second send for the same schedule and day never reaches LINE', async () => {
  const { db, tables } = seeded();
  const line = lineStub();
  const args = {
    group: GROUP,
    body: 'Send TIME',
    triggerSource: 'cron' as const,
    scheduleId: 's-morning',
    quota: { type: 'limited', limit: 300, totalUsage: 0 },
    recipients: 7,
  };

  assert.equal((await sendOne({ db, line: line.client }, args)).status, 'sent');
  assert.equal((await sendOne({ db, line: line.client }, args)).status, 'skipped_duplicate');
  assert.equal(line.pushes.length, 1, 'the duplicate must not produce a second message');
  assert.equal(tables.send_logs.filter((r) => r.status === 'sent').length, 1);
});

test('manual sends are not limited to once per day', async () => {
  const { db } = seeded();
  const line = lineStub();
  const args = {
    group: GROUP,
    body: 'ทดสอบ',
    triggerSource: 'manual' as const,
    scheduleId: null,
    quota: { type: 'limited', limit: 300, totalUsage: 0 },
    recipients: 7,
  };
  assert.equal((await sendOne({ db, line: line.client }, args)).status, 'sent');
  assert.equal((await sendOne({ db, line: line.client }, args)).status, 'sent');
  assert.equal(line.pushes.length, 2);
});

// ---------------------------------------------------------------- runTick
test('a tick at a non-scheduled minute does nothing at all', async () => {
  const { db, tables } = seeded();
  const line = lineStub();
  const res = await runTick({ db, line: line.client }, new Date('2026-08-13T03:00:00Z'));

  assert.equal(res.due, 0);
  assert.equal(line.pushes.length, 0);
  assert.equal(tables.send_logs.length, 0);
  assert.equal(line.calls.length, 0, 'a quiet tick must not spend a LINE API call');
});

test('a tick at the scheduled minute sends', async () => {
  const { db, tables } = seeded();
  const line = lineStub({ consumption: { totalUsage: 175 } });
  const res = await runTick({ db, line: line.client }, AT_0715);

  assert.equal(res.due, 1);
  assert.equal(res.bangkok, '2026-08-13 07:15');
  assert.equal(res.outcomes[0].status, 'sent');
  assert.equal(line.pushes.length, 1);
  assert.equal(tables.send_logs[0].status, 'sent');
});

test('a weekend tick logs the skip without calling LINE', async () => {
  const { db, tables } = seeded();
  const line = lineStub();
  const res = await runTick({ db, line: line.client }, SATURDAY_0715);

  assert.equal(res.outcomes[0].status, 'skipped_weekend');
  assert.equal(line.pushes.length, 0);
  assert.equal(line.calls.length, 0, 'weekend must not even read the quota');
  assert.equal(tables.send_logs[0].status, 'skipped_weekend');
});

test('an inactive group is skipped rather than sent to', async () => {
  const { db, tables } = seeded();
  tables.groups[0].status = 'pending';
  const line = lineStub();
  const res = await runTick({ db, line: line.client }, AT_0715);

  assert.equal(res.outcomes[0].status, 'skipped_disabled');
  assert.equal(line.pushes.length, 0);
  assert.match(tables.send_logs[0].error_detail, /pending/);
});

test('a disabled schedule produces no row on its own minute', async () => {
  const { db, tables } = seeded();
  tables.schedules[0].enabled = false;
  const line = lineStub();
  const res = await runTick({ db, line: line.client }, AT_0715);

  assert.equal(res.due, 0);
  assert.equal(tables.send_logs.length, 0);
});

test('a repeated tick in the catch-up window sends only once', async () => {
  const { db, tables } = seeded();
  const line = lineStub();
  await runTick({ db, line: line.client }, AT_0715);
  await runTick({ db, line: line.client }, new Date('2026-08-13T00:16:00Z'));
  await runTick({ db, line: line.client }, new Date('2026-08-13T00:17:00Z'));

  assert.equal(line.pushes.length, 1);
  assert.equal(tables.send_logs.filter((r) => r.status === 'sent').length, 1);
});
