// The outages the HUD shouts about, kept free of React so the bridge's test
// runner can import it. Each alarm has a kind, which keys its node, and its
// words in two parts: what is wrong, which a screen reader announces when it
// appears or changes, and how long for, which ticks every second and is left
// out of the announcement so it is not read again each tick.

import type { BridgeState } from './useBridge.ts'
import { age } from './useBridge.ts'

/** No word from the bridge for this long and the HUD calls its data stale. */
export const STALE_MS = 10_000

export type AlarmKind = 'bridge-down' | 'reconnecting' | 'bridge-quiet' | 'backend-down'

export interface Alarm {
  kind: AlarmKind
  /** What is wrong. Changes only when the fault does. */
  text: string
  /** How long for, or null. Ticks. */
  age: string | null
}

/** The whole alarm as one line, for instrument mode, which has no screen reader to spare. */
export const alarmLine = (a: Alarm) => (a.age ? `${a.text} ${a.age}` : a.text)

export function alarmsOf(b: Pick<BridgeState, 'link' | 'linkError' | 'fleet' | 'status' | 'heardAt' | 'downSince'>, now: number): Alarm[] {
  const out: Alarm[] = []
  if (b.link === 'down') {
    const why = b.linkError ? `: ${b.linkError.replace(/^bridge unreachable: /, '')}` : ''
    out.push({ kind: 'bridge-down', text: `BRIDGE UNREACHABLE${why}. Showing the last fleet seen.`, age: `Down for ${age(b.downSince, now)}${b.fleet ? `, fleet ${age(b.fleet.at, now)} old` : ''}.` })
  } else if (b.link === 'connecting' && b.fleet) out.push({ kind: 'reconnecting', text: 'RECONNECTING to the bridge. The fleet below may be out of date.', age: null })
  else if (b.link === 'open' && b.heardAt && now - b.heardAt > STALE_MS) out.push({ kind: 'bridge-quiet', text: 'NO WORD FROM THE BRIDGE.', age: `Last heard ${age(b.heardAt, now)} ago.` })
  if (b.status && !b.status.ok) out.push({ kind: 'backend-down', text: `BACKEND UNREACHABLE (${b.status.name}): ${b.status.error ?? 'unknown error'}.`, age: b.status.lastOkAt ? `Last good read ${age(b.status.lastOkAt, now)} ago.` : 'No good read yet.' })
  return out
}
