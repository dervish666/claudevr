import type { Capabilities, Fleet, Need, Operation, SessionTranscript } from '../../../shared/protocol.ts'

export type FleetUpdate = { ok: true; fleet: Fleet } | { ok: false; error: string; at: number }

export interface SendResult {
  ok: true
  /** What the backend said back, clipped, for the log. */
  said: string
}

/**
 * The seam every session source sits behind. An adapter declares what it can
 * do in `capabilities`; calling something it declares unsupported throws an
 * UnsupportedError rather than pretending.
 */
export interface SessionBackend {
  readonly name: string
  readonly capabilities: Capabilities
  /** Read the fleet now. Rejects when the source cannot be read. */
  list(): Promise<Fleet>
  /** Updates until the returned function is called. The first arrives soon after subscribing. */
  subscribe(listener: (update: FleetUpdate) => void): () => void
  /**
   * `requestId`, when the HUD gave one, names this send for its whole life:
   * a backend that can pass an idempotency key on (T3's clientRequestId)
   * passes one made from it, so a retry is the same request there too.
   */
  send(id: string, text: string, requestId?: string): Promise<SendResult>
  interrupt(id: string): Promise<void>
  pending(): Promise<Need[]>
  respond(reqId: string, answer: string): Promise<void>
  approve(reqId: string): Promise<void>
  /** The last `limit` turns of a session in full, oldest first. */
  transcript(id: string, limit: number): Promise<SessionTranscript>
  close(): void
}

export class UnsupportedError extends Error {
  readonly op: Operation
  constructor(backend: string, op: Operation) {
    super(`${backend} does not support ${op}`)
    this.name = 'UnsupportedError'
    this.op = op
  }
}

/** A send or a transcript read the backend refuses on its own terms: unknown session, no route to it. */
export class SendRefused extends Error {
  readonly status: number
  constructor(message: string, status = 404) {
    super(message)
    this.name = 'SendRefused'
    this.status = status
  }
}

export function capabilities(supported: Operation[]): Capabilities {
  return {
    list: supported.includes('list'),
    subscribe: supported.includes('subscribe'),
    send: supported.includes('send'),
    interrupt: supported.includes('interrupt'),
    pending: supported.includes('pending'),
    respond: supported.includes('respond'),
    approve: supported.includes('approve'),
    transcript: supported.includes('transcript'),
  }
}

/**
 * Polls `read` every `everyMs` while anyone is subscribed, and hands each
 * result to every listener. Shared by adapters whose source has no push.
 */
export class Poller {
  private listeners = new Set<(u: FleetUpdate) => void>()
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private readonly read: () => Promise<Fleet>
  private readonly everyMs: number
  private readonly log: (...a: unknown[]) => void
  private lastError: string | null = null

  constructor(read: () => Promise<Fleet>, everyMs: number, log: (...a: unknown[]) => void) {
    this.read = read
    this.everyMs = everyMs
    this.log = log
  }

  subscribe(listener: (u: FleetUpdate) => void): () => void {
    this.listeners.add(listener)
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), this.everyMs)
      setImmediate(() => void this.tick())
    }
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) this.stop()
    }
  }

  private async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    let update: FleetUpdate
    try {
      update = { ok: true, fleet: await this.read() }
      if (this.lastError) this.log('backend readable again after:', this.lastError)
      this.lastError = null
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      if (error !== this.lastError) this.log('backend read failed:', error)
      this.lastError = error
      update = { ok: false, error, at: Date.now() }
    } finally {
      this.busy = false
    }
    for (const l of this.listeners) l(update)
  }

  /** True while anyone is subscribed. */
  get active(): boolean {
    return this.listeners.size > 0
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
