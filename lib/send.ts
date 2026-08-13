// Send orchestration: the one place that decides whether a push happens and
// guarantees a send_logs row exists either way.

import { Db, isUniqueViolation } from './db.js';
import { LineClient } from './line.js';
import { checkQuota, findDue, type QuotaState, type Schedule } from './decide.js';
import { bangkokClock } from './time.js';

export type Group = {
  id: string;
  line_group_id: string;
  name: string | null;
  status: string;
  member_count: number | null;
};

export type SendOutcome = {
  status:
    | 'sent'
    | 'skipped_quota'
    | 'skipped_weekend'
    | 'skipped_disabled'
    | 'skipped_duplicate'
    | 'failed';
  logId: number | null;
  detail?: string;
  recipients?: number;
};

export type Deps = { db: Db; line: LineClient };

/** Live quota state, refreshed from LINE and mirrored into quota_snapshots. */
export async function readQuota({ db, line }: Deps): Promise<QuotaState> {
  const [quota, consumption] = await Promise.all([line.quota(), line.consumption()]);
  if (!quota.ok || !consumption.ok) {
    throw new Error(`quota lookup failed: ${quota.status}/${consumption.status}`);
  }
  const state: QuotaState = {
    type: quota.body?.type ?? 'unknown',
    limit: quota.body?.value ?? null,
    totalUsage: consumption.body?.totalUsage ?? 0,
  };
  // Never cache an empty reading — a zeroed snapshot would make the dashboard
  // claim the quota is untouched.
  if (consumption.body && typeof consumption.body.totalUsage === 'number') {
    await db
      .insert(
        'quota_snapshots',
        { quota_type: state.type, quota_limit: state.limit, total_usage: state.totalUsage },
        { returning: false },
      )
      .catch(() => {});
  }
  return state;
}

/**
 * Resolve how many messages one push to this group costs. Falls back to the
 * stored member_count when LINE is unreachable, and refreshes the stored value
 * whenever it changes — member_count is the quota multiplier, so a stale one
 * silently breaks the guard.
 */
export async function resolveRecipients({ db, line }: Deps, group: Group): Promise<number> {
  const res = await line.memberCount(group.line_group_id);
  if (res.ok && typeof res.body?.count === 'number') {
    if (res.body.count !== group.member_count) {
      await db
        .update('groups', `id=eq.${group.id}`, {
          member_count: res.body.count,
          member_count_checked_at: new Date().toISOString(),
        })
        .catch(() => {});
      await db.log('info', 'member_count_changed', {
        group: group.line_group_id,
        from: group.member_count,
        to: res.body.count,
      });
    }
    return res.body.count;
  }
  await db.log('warn', 'member_count_lookup_failed', {
    group: group.line_group_id,
    status: res.status,
    fallback: group.member_count,
  });
  if (typeof group.member_count === 'number') return group.member_count;
  throw new Error(`ไม่ทราบจำนวนสมาชิกของกลุ่ม ${group.line_group_id}`);
}

/**
 * Claim-then-send. The 'sent' row is written BEFORE calling LINE so that the
 * partial unique index (schedule_id, sent_on_local) rejects a concurrent or
 * repeated tick before it can produce a second real message. If LINE then
 * fails, the row is downgraded to 'failed', which releases the claim and lets a
 * later tick retry.
 */
export async function sendOne(
  deps: Deps,
  args: {
    group: Group;
    body: string;
    triggerSource: 'cron' | 'manual';
    scheduleId?: string | null;
    quota: QuotaState;
    recipients: number;
  },
): Promise<SendOutcome> {
  const { db, line } = deps;
  const { group, body, triggerSource, scheduleId = null, quota, recipients } = args;

  const verdict = checkQuota(quota, recipients);
  if (!verdict.allowed) {
    const [row] = await db.insert('send_logs', {
      schedule_id: scheduleId,
      group_id: group.id,
      trigger_source: triggerSource,
      message_body: body,
      status: 'skipped_quota',
      recipients_count: recipients,
      quota_limit: quota.limit,
      quota_used_before: quota.totalUsage,
      error_detail: verdict.reason,
    });
    await db.log('warn', 'send_skipped_quota', { group: group.line_group_id, reason: verdict.reason });
    return { status: 'skipped_quota', logId: row?.id ?? null, detail: verdict.reason, recipients };
  }

  const retryKey = crypto.randomUUID();
  let claim: any;
  try {
    [claim] = await db.insert('send_logs', {
      schedule_id: scheduleId,
      group_id: group.id,
      trigger_source: triggerSource,
      message_body: body,
      status: 'sent',
      recipients_count: recipients,
      quota_limit: quota.limit,
      quota_used_before: quota.totalUsage,
      retry_key: retryKey,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      await db.log('info', 'send_skipped_duplicate', {
        group: group.line_group_id,
        schedule_id: scheduleId,
      });
      return { status: 'skipped_duplicate', logId: null, recipients };
    }
    throw err;
  }

  const res = await line.push(group.line_group_id, body, retryKey);

  if (!res.ok) {
    await db.update('send_logs', `id=eq.${claim.id}`, {
      status: 'failed',
      line_status_code: res.status,
      error_detail: res.raw.slice(0, 2000),
    });
    await db.log('error', 'line_push_failed', {
      group: group.line_group_id,
      status: res.status,
      body: res.raw.slice(0, 500),
    });
    return { status: 'failed', logId: claim.id, detail: `LINE ${res.status}`, recipients };
  }

  await db.update('send_logs', `id=eq.${claim.id}`, {
    line_status_code: res.status,
    line_request_id: (res.body as any)?.sentMessages?.[0]?.id ?? null,
    response_raw: res.body ?? null,
  });
  return { status: 'sent', logId: claim.id, recipients };
}

export type TickResult = {
  checkedAt: string;
  bangkok: string;
  due: number;
  outcomes: Array<{ scheduleId: string; group: string } & SendOutcome>;
};

/** One minute-tick. Called by pg_cron via the shared-secret endpoint. */
export async function runTick(deps: Deps, now: Date = new Date()): Promise<TickResult> {
  const { db } = deps;
  const clock = bangkokClock(now);

  const schedules = (await db.select(
    'schedules',
    'select=id,group_id,message_id,send_at_local,weekdays_only,enabled&enabled=is.true',
  )) as Schedule[];

  const due = findDue(schedules, now, clock);
  const result: TickResult = {
    checkedAt: now.toISOString(),
    bangkok: `${clock.date} ${clock.hhmm}`,
    due: due.length,
    outcomes: [],
  };
  if (due.length === 0) return result;

  const groupIds = [...new Set(due.map((d) => d.schedule.group_id))];
  const messageIds = [...new Set(due.map((d) => d.schedule.message_id))];
  const [groups, messages] = await Promise.all([
    db.select('groups', `select=id,line_group_id,name,status,member_count&id=in.(${groupIds.join(',')})`),
    db.select('message_templates', `select=id,body&id=in.(${messageIds.join(',')})`),
  ]);
  const groupById = new Map<string, Group>(groups.map((g: Group) => [g.id, g]));
  const bodyById = new Map<string, string>(messages.map((m: any) => [m.id, m.body]));

  // Read the quota once for the whole tick — two schedules rarely coincide, and
  // when they do the second guard would still see the pre-tick usage anyway
  // because LINE's consumption number is approximate (ticket 01).
  let quota: QuotaState | null = null;

  for (const item of due) {
    const group = groupById.get(item.schedule.group_id);
    const body = bodyById.get(item.schedule.message_id);
    if (!group || !body) {
      await db.log('error', 'tick_missing_refs', { schedule_id: item.schedule.id });
      continue;
    }

    if (item.reason === 'skipped_weekend') {
      const [row] = await db.insert('send_logs', {
        schedule_id: item.schedule.id,
        group_id: group.id,
        trigger_source: 'cron',
        message_body: body,
        status: 'skipped_weekend',
      });
      result.outcomes.push({
        scheduleId: item.schedule.id,
        group: group.line_group_id,
        status: 'skipped_weekend',
        logId: row?.id ?? null,
      });
      continue;
    }

    if (group.status !== 'active') {
      const [row] = await db.insert('send_logs', {
        schedule_id: item.schedule.id,
        group_id: group.id,
        trigger_source: 'cron',
        message_body: body,
        status: 'skipped_disabled',
        error_detail: `group status = ${group.status}`,
      });
      result.outcomes.push({
        scheduleId: item.schedule.id,
        group: group.line_group_id,
        status: 'skipped_disabled',
        logId: row?.id ?? null,
      });
      continue;
    }

    quota ??= await readQuota(deps);
    const recipients = await resolveRecipients(deps, group);
    const outcome = await sendOne(deps, {
      group,
      body,
      triggerSource: 'cron',
      scheduleId: item.schedule.id,
      quota,
      recipients,
    });
    result.outcomes.push({ ...outcome, scheduleId: item.schedule.id, group: group.line_group_id });
  }

  return result;
}
