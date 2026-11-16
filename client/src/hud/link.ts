// The HUD's WebSocket to the bridge, as a policy that can be tested with a
// fake clock and a fake socket: connect, reconnect with backoff, and give up
// on a socket that has gone quiet.
//
// The bridge pushes the fleet, or its status, on every backend poll (every
// 2 s by default, and a read gives up after 5 s), and pings every 15 s. So
// an open socket that has carried nothing for 15 s is dead in all but name:
// the headset slept, or roamed to another access point, and the TCP
// connection is half open. Its close event can take minutes to come, and
// until then the page would show a stale fleet as live. Instead the socket
// is dropped at once and a new one started.

/** An open socket with no message for this long is given up on. */
export const SILENCE_MS = 15_000

/** The wait before reconnect attempt `n` (from 0): 0.5 s, doubling, at most 10 s. */
export const backoffMs = (n: number): number => Math.min(10_000, 500 * 2 ** n)

/**
 * A handler slot that takes the DOM's own handlers, whose events are wider
 * than what the link reads. Checked as a method is, so a WebSocket fits.
 */
export type Slot<E> = { bivarianceHack(ev: E): void }['bivarianceHack'] | null

/** The least of a WebSocket the link needs. */
export interface LinkSocket {
  onopen: Slot<unknown>
  onmessage: Slot<{ data: unknown }>
  onclose: Slot<{ code: number }>
  close(code?: number, reason?: string): void
}

/** Why a socket is no more. `unstarted`: it could not be made. `silent`: it was open but quiet for SILENCE_MS. */
export type Down = { kind: 'unstarted'; error: string } | { kind: 'closed'; opened: boolean; code: number } | { kind: 'silent'; quietMs: number }

export interface LinkDeps<S extends LinkSocket> {
  /** Makes a new socket. May throw. */
  open(): S
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  /** A new socket is being made. */
  onConnecting?(): void
  onOpen(ws: S): void
  onMessage(data: unknown): void
  /** The socket is gone. 'stop' ends the retries (a refused token); otherwise the next attempt waits out the backoff. */
  onDown(d: Down): 'retry' | 'stop' | Promise<'retry' | 'stop'>
}

/** The close code sent on a socket given up on for silence (4000 to 4999 are the application's own). */
export const SILENT_CLOSE = 4000

export class BridgeLink<S extends LinkSocket> {
  private readonly d: LinkDeps<S>
  private ws: S | null = null
  private attempt = 0
  private retryTimer: unknown = null
  private quietTimer: unknown = null
  private heardAt = 0
  private stopped = false

  constructor(deps: LinkDeps<S>) {
    this.d = deps
  }

  /** The socket now open or opening, or null between attempts. */
  get socket(): S | null {
    return this.ws
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  /** For unmount: no more attempts, and the socket closed without a word to onDown. */
  stop(): void {
    this.stopped = true
    if (this.retryTimer !== null) this.d.clearTimer(this.retryTimer)
    this.retryTimer = null
    this.stopQuiet()
    const ws = this.ws
    this.ws = null
    if (ws) {
      detach(ws)
      closeQuietly(ws)
    }
  }

  private connect(): void {
    if (this.stopped) return
    this.d.onConnecting?.()
    let ws: S
    try {
      ws = this.d.open()
    } catch (err) {
      console.error('hud: WebSocket failed to start:', err)
      void this.down(null, { kind: 'unstarted', error: String(err) })
      return
    }
    this.ws = ws
    let opened = false
    const slots: LinkSocket = ws
    slots.onopen = () => {
      opened = true
      this.attempt = 0
      this.heard()
      this.d.onOpen(ws)
    }
    slots.onmessage = ev => {
      this.heard()
      this.d.onMessage(ev.data)
    }
    slots.onclose = ev => void this.down(ws, { kind: 'closed', opened, code: ev.code })
  }

  /** Something came in: the silence clock starts again. */
  private heard(): void {
    this.heardAt = this.d.now()
    this.armQuiet(SILENCE_MS)
  }

  private armQuiet(ms: number): void {
    this.stopQuiet()
    this.quietTimer = this.d.setTimer(() => this.checkQuiet(), Math.max(1, ms))
  }

  private stopQuiet(): void {
    if (this.quietTimer !== null) this.d.clearTimer(this.quietTimer)
    this.quietTimer = null
  }

  /** The silence timer: gives up on the socket only once SILENCE_MS has really passed with nothing heard. */
  private checkQuiet(): void {
    this.quietTimer = null
    const ws = this.ws
    if (!ws || this.stopped) return
    const quietMs = this.d.now() - this.heardAt
    if (quietMs < SILENCE_MS) return this.armQuiet(SILENCE_MS - quietMs)
    // Its handlers go first, so whatever it does from here (a close event
    // minutes later, a message stuck in a buffer) reaches nothing.
    detach(ws)
    closeQuietly(ws, SILENT_CLOSE, 'silent')
    void this.down(ws, { kind: 'silent', quietMs })
  }

  private async down(ws: S | null, d: Down): Promise<void> {
    if (this.stopped) return
    // A socket already given up on has nothing more to say.
    if (ws && this.ws !== ws) return
    if (ws) detach(ws)
    this.ws = null
    this.stopQuiet()
    let next: 'retry' | 'stop'
    try {
      next = await this.d.onDown(d)
    } catch (err) {
      console.error('hud: deciding whether to reconnect failed, reconnecting:', err)
      next = 'retry'
    }
    if (this.stopped || next === 'stop') return
    const ms = backoffMs(this.attempt++)
    this.retryTimer = this.d.setTimer(() => {
      this.retryTimer = null
      this.connect()
    }, ms)
  }
}

function detach(ws: LinkSocket): void {
  ws.onopen = null
  ws.onmessage = null
  ws.onclose = null
}

function closeQuietly(ws: LinkSocket, code?: number, reason?: string): void {
  try {
    if (code === undefined) ws.close()
    else ws.close(code, reason)
  } catch (err) {
    console.error('hud: closing the WebSocket failed:', err)
  }
}
