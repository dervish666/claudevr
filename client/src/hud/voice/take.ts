// One clip's recording, from start to the recorder's stop event, kept free
// of the DOM so the tests can drive it with a fake recorder. recorder.ts
// owns one of these and hands it a MediaRecorder per clip.
//
// A MediaRecorder hands its audio over asynchronously: stop() asks, and the
// clip arrives with the stop event some milliseconds later. A press in that
// gap must not start another recorder, which would take the first clip's
// audio, so the take stays busy until its own stop or error event (or a
// grace period, so a lost event cannot leave the button dead). Each take
// keeps its own chunks, and only ever clears itself.

/** A recording handed over: the audio, and how long the press lasted. */
export interface Clip {
  blob: Blob
  ms: number
}

/** A handler slot that takes the DOM's own handlers, whose events are wider than what is read here. */
type Slot<E> = { bivarianceHack(ev: E): void }['bivarianceHack'] | null

/** The least of a MediaRecorder a take needs. */
export interface TakeRecorder {
  readonly state: 'inactive' | 'recording' | 'paused'
  readonly mimeType: string
  ondataavailable: Slot<{ data: Blob }>
  onstop: Slot<unknown>
  onerror: Slot<unknown>
  start(): void
  stop(): void
}

export interface TakeDeps {
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

/** How long a stopped recorder may take to hand over its clip before it is given up on. */
export const STOP_GRACE_MS = 3_000

interface Take {
  rec: TakeRecorder
  chunks: Blob[]
  startedAt: number
  aborted: boolean
  grace: unknown
  ended: Promise<Clip | null>
  settle(c: Clip | null): void
}

export class Takes {
  private readonly d: TakeDeps
  private take: Take | null = null

  constructor(deps: TakeDeps) {
    this.d = deps
  }

  /** True from start() until that recorder's stop or error event. */
  get busy(): boolean {
    return this.take !== null
  }

  get recording(): boolean {
    return this.take?.rec.state === 'recording'
  }

  /** Starts recording on `rec`. Throws while the last take is still busy. */
  start(rec: TakeRecorder): void {
    if (this.take) throw new Error('the last clip is still being finished')
    let settle!: (c: Clip | null) => void
    const ended = new Promise<Clip | null>(ok => (settle = ok))
    const take: Take = { rec, chunks: [], startedAt: 0, aborted: false, grace: null, ended, settle }
    const slots: TakeRecorder = rec
    slots.ondataavailable = e => {
      if (e.data.size) take.chunks.push(e.data)
    }
    // Set from the start, so an error before stop() still ends the take.
    slots.onstop = () => this.finish(take, false)
    slots.onerror = ev => {
      console.error('voice: MediaRecorder error:', ev)
      this.finish(take, true)
    }
    take.startedAt = this.d.now()
    rec.start()
    this.take = take
  }

  /** Ends the clip and hands it over once the recorder has finished; null if it was aborted or there is none. */
  stop(): Promise<Clip | null> {
    const take = this.take
    if (!take) return Promise.resolve(null)
    if (take.rec.state !== 'inactive') {
      try {
        take.rec.stop()
      } catch (err) {
        console.error('voice: MediaRecorder would not stop:', err)
        this.finish(take, true)
      }
    }
    if (this.take === take && take.grace === null) {
      take.grace = this.d.setTimer(() => {
        take.grace = null
        if (this.take !== take) return
        console.error(`voice: the recorder sent no stop event in ${STOP_GRACE_MS} ms; using what it captured`)
        this.finish(take, false)
      }, STOP_GRACE_MS)
    }
    return take.ended
  }

  /** Stops the clip and drops it. */
  abort(): void {
    if (this.take) this.take.aborted = true
    void this.stop()
  }

  /** The take is over: clears it if it is still the current one, never a newer one. An error hands over an empty clip, as before. */
  private finish(take: Take, errored: boolean): void {
    if (this.take === take) this.take = null
    if (take.grace !== null) this.d.clearTimer(take.grace)
    take.grace = null
    take.settle(take.aborted ? null : { blob: new Blob(errored ? [] : take.chunks, { type: take.rec.mimeType || 'audio/webm' }), ms: Math.round(this.d.now() - take.startedAt) })
  }
}
