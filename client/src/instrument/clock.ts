// Time for the scene without re-rendering it. `second` ticks once a second
// for ages and countdown-style readouts; `clock` is the local HH:MM and
// changes once a minute, on the minute. uikit Text takes a signal as its
// child and updates just that text, so nothing above it renders again, and
// a computed string that comes out the same does not even relayout.

import { signal } from '@preact/signals-core'
import { hhmm, msToNextMinute } from '../time.ts'

export const second = signal(Date.now())
export const clock = signal(hhmm(new Date()))

setInterval(() => void (second.value = Date.now()), 1000)

function onTheMinute(): void {
  clock.value = hhmm(new Date())
  setTimeout(onTheMinute, msToNextMinute(Date.now()) + 20)
}
setTimeout(onTheMinute, msToNextMinute(Date.now()) + 20)
