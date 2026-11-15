// The transcript polling the 2D reader and the instrument Stream share:
// a read repeated on an interval, with at most one request in flight. A
// tick that finds a read still running skips; a read made on demand aborts
// the one in flight; and only the newest read may land, so a slow old answer
// can never replace newer turns. Kept free of React and the DOM so the tests
// can drive it with fake timers; the hook is in transcript.ts.

import type { Turn } from '../../../shared/protocol.ts'

export interface PollDeps<T> {
  read(signal: AbortSignal): Promise<T>
  /** The newest read's answer. Never called after stop(). */
  onResult(value: T): void
  /** The newest read failed, or took longer than `timeoutMs` (then `timedOut` is true). */
  onError(err: unknown, timedOut: boolean): void
  everyMs: number
  timeoutMs: number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  setRepeat(fn: () => void, ms: number): unknown
  clearRepeat(handle: unknown): void
}

interface InFlight {
  seq: number
  ctl: AbortController
  timer: unknown
}

export class Poller<T> {
  private readonly d: PollDeps<T>
  private seq = 0
  private inflight: InFlight | null = null
  private repeat: unknown = null
  private stopped = false

  constructor(deps: PollDeps<T>) {
    this.d = deps
  }

  /** Reads now, then on every interval. */
  start(): void {
    this.readNow()
    this.repeat = this.d.setRepeat(() => this.tick(), this.d.everyMs)
  }

  /** The interval: skipped while a read is still running, so reads never pile up behind a slow backend. */
  tick(): void {
    if (this.stopped || this.inflight) return
    this.readNow()
  }

  /** Reads now, abandoning a read in flight: its answer is older than the one asked for. */
  readNow(): void {
    if (this.stopped) return
    this.abandon()
    const seq = ++this.seq
    const ctl = new AbortController()
    const timer = this.d.setTimer(() => {
      if (this.inflight?.seq !== seq) return
      this.finish(seq)
      ctl.abort()
      this.d.onError(new Error(`no answer in ${Math.round(this.d.timeoutMs / 1000)} s`), true)
    }, this.d.timeoutMs)
    this.inflight = { seq, ctl, timer }
    let p: Promise<T>
    try {
      p = this.d.read(ctl.signal)
    } catch (err) {
      p = Promise.reject(err)
    }
    p.then(
      v => {
        if (this.finish(seq)) this.d.onResult(v)
      },
      (err: unknown) => {
        if (this.finish(seq)) this.d.onError(err, false)
      },
    )
  }

  /** Stops the interval and abandons the read in flight; nothing lands afterwards. */
  stop(): void {
    this.stopped = true
    if (this.repeat !== null) this.d.clearRepeat(this.repeat)
    this.repeat = null
    this.abandon()
  }

  get busy(): boolean {
    return this.inflight !== null
  }

  /** Ends read `seq` if it is the one in flight. False for a read that was abandoned or already ended. */
  private finish(seq: number): boolean {
    const f = this.inflight
    if (this.stopped || f?.seq !== seq) return false
    this.d.clearTimer(f.timer)
    this.inflight = null
    return true
  }

  private abandon(): void {
    const f = this.inflight
    if (!f) return
    this.inflight = null
    this.d.clearTimer(f.timer)
    f.ctl.abort()
  }
}

// ---------------------------------------------------------------- a session's transcript

/** Why the full turns are not on screen. "none": this session has none to give. "failed": the read broke. */
export type TranscriptProblem = { kind: 'none' | 'failed'; why: string }

export interface TranscriptState {
  /** Which session the state is for: `s:<id>`, or `s:none`. */
  key: string
  turns: Turn[] | null
  problem: TranscriptProblem | null
  loaded: boolean
  /** Epoch ms the turns last changed. */
  at: number | null
}

export type TranscriptRead = { ok: true; turns: Turn[] } | { ok: false; problem: TranscriptProblem }

export const transcriptKey = (sessionId: string | null) => `s:${sessionId ?? 'none'}`

/** Nothing read yet. With no session there is nothing to read, so it counts as loaded. */
export const blankTranscript = (key: string, loaded: boolean): TranscriptState => ({ key, turns: null, problem: null, loaded, at: null })

export function sameTurns(a: Turn[], b: Turn[]): boolean {
  return a.length === b.length && a.every((t, i) => t.role === b[i]!.role && t.text === b[i]!.text && t.clipped === b[i]!.clipped)
}

/**
 * New turns in. A re-read that says the same thing keeps the same object (so
 * nothing that draws it renders again) or at least the same array (so the
 * instrument's uikit text is not laid out again every few seconds).
 */
export function landTurns(d: TranscriptState, key: string, next: Turn[], now: number): TranscriptState {
  const same = d.key === key && d.turns !== null && sameTurns(d.turns, next)
  if (same && d.loaded && !d.problem) return d
  return { key, turns: same ? d.turns : next, problem: null, loaded: true, at: now }
}

/** A read that failed keeps the turns already on screen, which may now be old, and says why. */
export function landProblem(d: TranscriptState, key: string, problem: TranscriptProblem): TranscriptState {
  if (d.key === key && d.loaded && d.problem?.kind === problem.kind && d.problem.why === problem.why) return d
  return { key, turns: d.key === key ? d.turns : null, problem, loaded: true, at: d.key === key ? d.at : null }
}
