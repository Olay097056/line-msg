// Bangkok wall-clock helpers.
//
// Thailand is UTC+7 year-round with no DST, so a fixed offset is exact — no
// Intl timezone database lookup needed. The DB agrees: send_logs.sent_on_local
// is generated with `at time zone 'Asia/Bangkok'`.

export const BANGKOK_OFFSET_MINUTES = 7 * 60;

export type BangkokClock = {
  /** 0 = Sunday … 6 = Saturday, in Bangkok */
  weekday: number;
  /** minutes since Bangkok midnight */
  minutes: number;
  /** YYYY-MM-DD in Bangkok */
  date: string;
  /** HH:MM in Bangkok */
  hhmm: string;
};

export function bangkokClock(now: Date): BangkokClock {
  const shifted = new Date(now.getTime() + BANGKOK_OFFSET_MINUTES * 60_000);
  const h = shifted.getUTCHours();
  const m = shifted.getUTCMinutes();
  return {
    weekday: shifted.getUTCDay(),
    minutes: h * 60 + m,
    date: shifted.toISOString().slice(0, 10),
    hhmm: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
  };
}

export function isWeekend(clock: BangkokClock): boolean {
  return clock.weekday === 0 || clock.weekday === 6;
}

/** Parse a Postgres `time` value ("07:15:00") into minutes since midnight. */
export function timeToMinutes(value: string): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!m) throw new Error(`bad time value: ${value}`);
  const hours = Number(m[1]);
  const mins = Number(m[2]);
  if (hours > 23 || mins > 59) throw new Error(`bad time value: ${value}`);
  return hours * 60 + mins;
}
