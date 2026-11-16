// What each send came to, by its requestId. A send whose answer was lost is
// retried by the HUD with the same id; the first outcome is kept here, so the
// retry gets that answer instead of a second delivery. In memory only: across
// a restart the dashweb adapter still gives T3 the same clientRequestId.

import { createHash } from 'node:crypto'

/** What a send came to, kept under its requestId so a repeat gets the same answer. */
export interface SendOutcome {
  status: number
  body: Record<string, unknown>
  headers: Record<string, string>
  /** False for a refusal that went nowhere: forgotten, so a retry of the card may try again. */
  remember: boolean
}

/** The same session and the same words: what a repeat must match. */
export const sendKey = (sessionId: string, text: string) => createHash('sha256').update(sessionId).update('\0').update(text).digest('hex')

/** A send with no id, or an id not seen: go ahead. A repeat: its first outcome. A reused id for other words: refuse. */
export type LedgerCheck = { kind: 'new'; key: string } | { kind: 'repeat'; outcome: Promise<SendOutcome> } | { kind: 'conflict' }

export class SendLedger {
  private readonly ids = new Map<string, { at: number; key: string; outcome: Promise<SendOutcome> }>()
  private readonly ttlMs: number
  private readonly max: number

  /** Ids are kept for `ttlMs`, and at most `max` of them. */
  constructor(ttlMs: number, max: number) {
    this.ttlMs = ttlMs
    this.max = max
  }

  /** Forgets ids past their time, and the oldest past the cap, then says what a send with this id is. */
  check(requestId: string | undefined, sessionId: string, text: string, now: number): LedgerCheck {
    this.prune(now)
    const key = sendKey(sessionId, text)
    const seen = requestId ? this.ids.get(requestId) : undefined
    if (!seen) return { kind: 'new', key }
    return seen.key === key ? { kind: 'repeat', outcome: seen.outcome } : { kind: 'conflict' }
  }

  /** Keeps a send's outcome under its id from the moment it starts, so a repeat that arrives meanwhile waits for it. */
  remember(requestId: string, key: string, outcome: Promise<SendOutcome>, now: number): void {
    this.ids.set(requestId, { at: now, key, outcome })
  }

  forget(requestId: string): void {
    this.ids.delete(requestId)
  }

  get size(): number {
    return this.ids.size
  }

  private prune(now: number): void {
    // Insertion order is age order: stop at the first one still young.
    for (const [id, e] of this.ids) {
      if (now - e.at <= this.ttlMs) break
      this.ids.delete(id)
    }
    while (this.ids.size >= this.max) this.ids.delete(this.ids.keys().next().value!)
  }
}
