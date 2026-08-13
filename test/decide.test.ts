import test from 'node:test';
import assert from 'node:assert/strict';

import { bangkokClock, isWeekend, timeToMinutes } from '../lib/time.js';
import { findDue, checkQuota, projectExhaustion, type Schedule } from '../lib/decide.js';

const schedule = (over: Partial<Schedule> = {}): Schedule => ({
  id: 's1',
  group_id: 'g1',
  message_id: 'm1',
  send_at_local: '07:15',
  weekdays_only: true,
  enabled: true,
  ...over,
});

// ---------------------------------------------------------------- time
test('bangkok clock shifts UTC by +7 with no DST', () => {
  // 2026-08-13T00:15:00Z is 07:15 Bangkok the same day — the real 07:15 slot.
  const c = bangkokClock(new Date('2026-08-13T00:15:00Z'));
  assert.equal(c.hhmm, '07:15');
  assert.equal(c.date, '2026-08-13');
  assert.equal(c.minutes, 7 * 60 + 15);
  assert.equal(c.weekday, 4); // Thursday
});

test('bangkok clock rolls to the next day for late-UTC times', () => {
  // 17:15 Bangkok is 10:15 UTC the SAME day (matters for the cron expression).
  assert.equal(bangkokClock(new Date('2026-08-13T10:15:00Z')).hhmm, '17:15');
  // But 22:00 UTC is already tomorrow in Bangkok.
  const c = bangkokClock(new Date('2026-08-13T22:00:00Z'));
  assert.equal(c.date, '2026-08-14');
  assert.equal(c.hhmm, '05:00');
});

test('weekend detection uses Bangkok day, not UTC day', () => {
  // Friday 22:00 UTC = Saturday 05:00 Bangkok.
  const c = bangkokClock(new Date('2026-08-14T22:00:00Z'));
  assert.equal(c.weekday, 6);
  assert.equal(isWeekend(c), true);
});

test('timeToMinutes accepts postgres time output and rejects junk', () => {
  assert.equal(timeToMinutes('07:15:00'), 435);
  assert.equal(timeToMinutes('17:15'), 1035);
  assert.equal(timeToMinutes('00:00:00'), 0);
  assert.throws(() => timeToMinutes('25:00'));
  assert.throws(() => timeToMinutes('nope'));
});

// ---------------------------------------------------------------- findDue
test('fires exactly at the scheduled minute', () => {
  const due = findDue([schedule()], new Date('2026-08-13T00:15:00Z'));
  assert.equal(due.length, 1);
  assert.equal(due[0].reason, 'due');
});

test('does not fire before the scheduled minute', () => {
  assert.equal(findDue([schedule()], new Date('2026-08-13T00:14:59Z')).length, 0);
});

test('catches up a late tick but gives up after the window', () => {
  assert.equal(findDue([schedule()], new Date('2026-08-13T00:17:00Z')).length, 1);
  assert.equal(findDue([schedule()], new Date('2026-08-13T00:18:00Z')).length, 0);
});

test('disabled schedules never fire', () => {
  const due = findDue([schedule({ enabled: false })], new Date('2026-08-13T00:15:00Z'));
  assert.equal(due.length, 0);
});

test('weekend is reported only when the time matches, so ticks do not flood', () => {
  // Saturday 2026-08-15, 07:15 Bangkok = 2026-08-15T00:15Z
  const atTime = findDue([schedule()], new Date('2026-08-15T00:15:00Z'));
  assert.equal(atTime.length, 1);
  assert.equal(atTime[0].reason, 'skipped_weekend');

  // Same Saturday, 09:00 Bangkok — no row at all.
  assert.equal(findDue([schedule()], new Date('2026-08-15T02:00:00Z')).length, 0);
});

test('weekdays_only=false still fires on a weekend', () => {
  const due = findDue([schedule({ weekdays_only: false })], new Date('2026-08-15T00:15:00Z'));
  assert.equal(due[0].reason, 'due');
});

test('only the matching schedule of several fires', () => {
  const due = findDue(
    [schedule({ id: 'morning' }), schedule({ id: 'evening', send_at_local: '17:15' })],
    new Date('2026-08-13T10:15:00Z'),
  );
  assert.deepEqual(due.map((d) => d.schedule.id), ['evening']);
});

// ---------------------------------------------------------------- checkQuota
test('allows a send that exactly consumes the last of the quota', () => {
  const v = checkQuota({ type: 'limited', limit: 300, totalUsage: 293 }, 7);
  assert.equal(v.allowed, true);
  assert.equal(v.remaining, 7);
});

test('blocks a send that would exceed by one', () => {
  const v = checkQuota({ type: 'limited', limit: 300, totalUsage: 294 }, 7);
  assert.equal(v.allowed, false);
  assert.equal(v.allowed === false && v.remaining, 6);
});

test('quota is counted per recipient, not per push', () => {
  const state = { type: 'limited', limit: 300, totalUsage: 295 };
  assert.equal(checkQuota(state, 1).allowed, true); // 1 recipient would fit
  assert.equal(checkQuota(state, 7).allowed, false); // the real 7-person group does not
});

test('unlimited quota always allows', () => {
  assert.equal(checkQuota({ type: 'none', limit: null, totalUsage: 999_999 }, 7).allowed, true);
  // limited-but-no-value should not hard-block either (ticket 01: value optional)
  assert.equal(checkQuota({ type: 'limited', limit: null, totalUsage: 999 }, 7).allowed, true);
});

// ------------------------------------------------------------ projection
test('projects remaining sending days at the current burn rate', () => {
  // The real numbers on 2026-08-13: 300 limit, 175 used, 14 per weekday.
  const p = projectExhaustion({ type: 'limited', limit: 300, totalUsage: 175 }, 14);
  assert.deepEqual(p, { remaining: 125, sendingDaysLeft: 8 });
});

test('projection is null when the quota is unlimited', () => {
  assert.equal(projectExhaustion({ type: 'none', limit: null, totalUsage: 5 }, 14), null);
});

test('projection clamps at zero rather than going negative', () => {
  const p = projectExhaustion({ type: 'limited', limit: 300, totalUsage: 340 }, 14);
  assert.deepEqual(p, { remaining: 0, sendingDaysLeft: 0 });
});
