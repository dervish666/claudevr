// One typed command's trip to the bridge, kept free of React so
// bridge/test/client-typed.test.ts can drive it with a real SendCards and a
// fake clock. useVoice.ts owns one of these.
//
// Typed words are a new intent, as a clip is, and an armed card waits while
// they are read, since they may be "cancel". That wait must end: on the
// bridge's answer, on a deadline, or on Cancel. A request that stalls would
// otherwise keep the field busy and leave the countdown paused for every card
// after it.

import type { SendCards } from './sendcard.ts'

/** How long the bridge has to read typed words. Its own work is the grammar plus, in character mode, the classifier (frontMan.classifyTimeoutMs, 3 s by default; set it near 10 s and typed reads in character mode fail safe as TYPED WORDS NOT READ). */
export const TYPED_TIMEOUT_MS = 10_000

export interface TypedDeps {
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

export type TypedRead<T> =
  /** `generation`: the intent the words were read under, for act(); stale once a clip or Cancel came since. */
  | { ok: true; value: T; generation: number }
  /** `abandoned`: Cancel stopped it. `error` carries the deadline's reason when that ran out. */
  | { ok: false; error: unknown; generation: number; abandoned: boolean }

/** The reason a read stops when Cancel gives up on it. */
class Abandoned extends Error {
  constructor() {
    super('abandoned by Cancel')
  }
}

export class TypedReader {
  private ctl: AbortController | null = null
  private readonly cards: Pick<SendCards, 'newIntent' | 'pause'>
  private readonly d: TypedDeps
  private readonly timeoutMs: number

  constructor(cards: Pick<SendCards, 'newIntent' | 'pause'>, d: TypedDeps, timeoutMs = TYPED_TIMEOUT_MS) {
    this.cards = cards
    this.d = d
    this.timeoutMs = timeoutMs
  }

  /** True while typed words are with the bridge; the field takes no more until then. */
  get busy(): boolean {
    return this.ctl !== null
  }

  /** Cancel: gives up on the words being read. True when there were some. */
  abandon(): boolean {
    if (!this.ctl) return false
    this.ctl.abort(new Abandoned())
    return true
  }

  /**
   * Reads typed words with `read`, which should pass the signal on to its
   * fetch. Null when a read is already under way. The card's pause lifts
   * however it ends, before this returns, so act() runs on a card that
   * counts down again.
   */
  async read<T>(read: (signal: AbortSignal) => Promise<T>): Promise<TypedRead<T> | null> {
    if (this.ctl) return null
    const ctl = new AbortController()
    this.ctl = ctl
    const generation = this.cards.newIntent()
    this.cards.pause('typing', true)
    const seconds = Math.round(this.timeoutMs / 1000)
    const timer = this.d.setTimer(() => ctl.abort(new Error(`no answer from the bridge in ${seconds} s`)), this.timeoutMs)
    // A fetch that ignores its signal part way through the body would leave
    // the read pending for ever; the abort settles it regardless.
    const stopped = new Promise<never>((_, reject) => ctl.signal.addEventListener('abort', () => reject(ctl.signal.reason), { once: true }))
    try {
      return { ok: true, value: await Promise.race([read(ctl.signal), stopped]), generation }
    } catch (err) {
      return { ok: false, error: ctl.signal.aborted ? ctl.signal.reason : err, generation, abandoned: ctl.signal.reason instanceof Abandoned }
    } finally {
      this.d.clearTimer(timer)
      if (this.ctl === ctl) {
        this.ctl = null
        this.cards.pause('typing', false)
      }
    }
  }
}

/**
 * Which character line the HUD is waiting for. A newer answer replaces it,
 * and an answer with no line, or a new hold, drops it; either way the waiting
 * mark goes with the old line, or announcements would wait behind a line that
 * will never be spoken.
 */
export class LineWait {
  private seq = 0
  private who: string | null = null
  private readonly onChange: (character: string | null) => void

  constructor(onChange: (character: string | null) => void) {
    this.onChange = onChange
  }

  /** The character whose line is awaited, or null. */
  get waiting(): string | null {
    return this.who
  }

  /** A line is on its way. The ticket to pass to land(). */
  start(character: string): number {
    this.set(character)
    return ++this.seq
  }

  /** The line arrived. True when it is still the one waited for (and the mark clears); false when it was overtaken. */
  land(ticket: number): boolean {
    if (ticket !== this.seq) return false
    this.set(null)
    return true
  }

  /** Whatever line was awaited will not be spoken. */
  drop(): void {
    this.seq++
    this.set(null)
  }

  private set(who: string | null): void {
    if (who === this.who) return
    this.who = who
    this.onChange(who)
  }
}
