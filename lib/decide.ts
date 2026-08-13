// Pure decision logic for "should this schedule fire right now, and are we
// allowed to spend the quota?" Kept free of I/O so it can be tested exhaustively
// without touching LINE or Postgres.

import { bangkokClock, isWeekend, timeToMinutes, type BangkokClock } from './time.js';

export type Schedule = {
  id: string;
  group_id: string;
  message_id: string;
  send_at_local: string;
  weekdays_only: boolean;
  enabled: boolean;
};

export type DueReason = 'due' | 'skipped_weekend';

export type DueSchedule = {
  schedule: Schedule;
  reason: DueReason;
};

/**
 * A tick can arrive late (cron jitter, a slow cold start, a Vercel retry), so
 * a schedule stays eligible for CATCH_UP_MINUTES after its time. Sending twice
 * is prevented by the partial unique index on send_logs, not by this window.
 */
export const CATCH_UP_MINUTES = 2;

export function findDue(
  schedules: Schedule[],
  now: Date,
  clock: BangkokClock = bangkokClock(now),
): DueSchedule[] {
  const due: DueSchedule[] = [];
  for (const schedule of schedules) {
    if (!schedule.enabled) continue;

    const target = timeToMinutes(schedule.send_at_local);
    const lag = clock.minutes - target;
    if (lag < 0 || lag > CATCH_UP_MINUTES) continue;

    // Weekend is decided only once the time matches. Deciding it earlier would
    // write a skipped_weekend row on all 1,440 ticks of a Saturday.
    due.push({
      schedule,
      reason: schedule.weekdays_only && isWeekend(clock) ? 'skipped_weekend' : 'due',
    });
  }
  return due;
}

export type QuotaState = {
  /** 'none' means unlimited — LINE omits `value` in that case (ticket 01). */
  type: string;
  limit: number | null;
  totalUsage: number;
};

export type QuotaVerdict =
  | { allowed: true; remaining: number | null }
  | { allowed: false; reason: string; remaining: number };

/**
 * ticket 03 หมวด B: cut only when the send itself would exceed the quota. No
 * reserve buffer — the last messages of the month are usable.
 *
 * A group push costs one message PER RECIPIENT (ticket 01), which is why
 * recipients is the multiplier and not 1.
 */
export function checkQuota(state: QuotaState, recipients: number): QuotaVerdict {
  if (state.type === 'none' || state.limit === null) {
    return { allowed: true, remaining: null };
  }
  const remaining = state.limit - state.totalUsage;
  if (recipients > remaining) {
    return {
      allowed: false,
      reason: `ต้องใช้ ${recipients} ข้อความ แต่เหลือ ${remaining} จาก ${state.limit}`,
      remaining,
    };
  }
  return { allowed: true, remaining };
}

/**
 * Days of quota left at the current burn rate, for the dashboard. Returns null
 * when the quota is unlimited or nothing has been sent yet.
 */
export function projectExhaustion(
  state: QuotaState,
  perSendingDay: number,
): { remaining: number; sendingDaysLeft: number } | null {
  if (state.limit === null || state.type === 'none' || perSendingDay <= 0) return null;
  const remaining = Math.max(0, state.limit - state.totalUsage);
  return { remaining, sendingDaysLeft: Math.floor(remaining / perSendingDay) };
}
