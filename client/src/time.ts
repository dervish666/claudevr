// The local clock as both HUDs show it: 24-hour HH:MM.

export function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Milliseconds from `now` to the start of the next minute, at least 1. */
export function msToNextMinute(now: number): number {
  return Math.max(1, 60_000 - (now % 60_000))
}
