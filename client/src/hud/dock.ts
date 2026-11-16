// Pure rules for the voice dock (Voice.tsx), kept out of the component so
// bridge/test/client-dock.test.ts can run them under node.

import type { Reply } from './voice/useVoice.ts'

/**
 * True when `next` is `prev` with the character's line added, not a new
 * answer. useVoice adds the line to the reply it belongs to as a copy with
 * `spoken` set, keeping `say` and the same `lines` array; a new answer always
 * starts with no line. A dismissed reply stays dismissed while its line lands.
 */
export function replyIsUpdate(prev: Reply | null, next: Reply): boolean {
  return prev !== null && prev.spoken === null && next.spoken !== null && prev.say === next.say && prev.lines === next.lines
}

/**
 * Whether the character's line shows beside the answer. Beside a list (status,
 * limits) a plain line is the list read out again, so it is left out; a line
 * the character wrote is kept.
 */
export function showSpoken(r: Reply): boolean {
  return r.spoken !== null && !(r.lines !== null && r.spoken.plain)
}

/**
 * What the typed field holds once a submission is answered: cleared only when
 * it was used and the field still holds exactly what was sent, so a draft
 * typed while it was being read is kept.
 */
export function afterTyped(current: string, submitted: string, used: boolean): string {
  return used && current === submitted ? '' : current
}
