// What the claudevr mods have told the bridge, and what the bridge has queued
// for them (docs/mod-protocol.md). The mod listener feeds it; the claude
// backend reads it and sends through it. In memory only.
//
// A message's life: queued (waiting for the session's next inbox poll), then
// handed (written to a poll answer, waiting for the ack), then settled by the
// ack, by the ack timeout, or by the session going away. It is never queued
// again once handed: the bridge cannot tell whether the mod submitted it.

import { SendRefused } from '../types.ts'
import type { ModReport } from './report.ts'

/** A session not heard from in this long leaves the fleet. */
export const EXPIRE_MS = 30_000
/** How long a send waits for its ack. */
export const ACK_TIMEOUT_MS = 30_000
/** How long an inbox poll is held when nothing is waiting. */
export const POLL_HOLD_MS = 25_000
/** Live sessions at most; a report from one more is refused. */
export const SESSIONS_MAX = 64
/** Messages waiting per session at most. */
const QUEUE_MAX = 8
/** Sessions remembered for today's spend after they drop. */
const SPENT_MAX = 500

export interface LiveSession {
  report: ModReport
  /** When the bridge received the report, epoch ms. */
  reportedAt: number
  /** The last request of any kind from this session. */
  heardAt: number
  firstSeenAt: number
}

export interface Reading {
  kind: string
  usedPct: number
  resetsAt: number | null
  /** When the bridge received it. */
  at: number
}

export type SendSettle = { ok: true; delivery: 'started' | 'queued' | null } | { ok: false; refused: true; reason: string } | { ok: false; refused: false; reason: string }

interface Outgoing {
  id: string
  sessionId: string
  text: string
  handed: boolean
  timer: NodeJS.Timeout | null
  settle: (s: SendSettle) => void
  done: Promise<SendSettle>
}

interface Poll {
  answer: (items: { id: string; text: string }[] | null) => void
}

export interface HubOptions {
  now?: () => number
  log?: (...a: unknown[]) => void
  ackTimeoutMs?: number
  pollHoldMs?: number
  expireMs?: number
}

export class ModHub {
  readonly ackTimeoutMs: number
  readonly pollHoldMs: number
  readonly expireMs: number
  private readonly now: () => number
  private readonly log: (...a: unknown[]) => void
  private readonly sessions = new Map<string, LiveSession>()
  private readonly outgoing = new Map<string, Outgoing>()
  private readonly polls = new Map<string, Poll>()
  /** kind -> the freshest reading of that window from any session. */
  private readonly readings = new Map<string, Reading>()
  /** session id -> its latest cost and when it was last seen, for today's spend. */
  private readonly spent = new Map<string, { usd: number; at: number }>()
  private readonly listeners = new Set<() => void>()
  /** Whether any report has arrived since the bridge started. */
  everReported = false

  constructor(o: HubOptions = {}) {
    this.now = o.now ?? Date.now
    this.log = o.log ?? (() => {})
    this.ackTimeoutMs = o.ackTimeoutMs ?? ACK_TIMEOUT_MS
    this.pollHoldMs = o.pollHoldMs ?? POLL_HOLD_MS
    this.expireMs = o.expireMs ?? EXPIRE_MS
  }

  /** Called whenever the fleet may have changed. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private changed(): void {
    for (const fn of this.listeners) {
      try {
        fn()
      } catch (err) {
        this.log('mod hub listener failed:', (err as Error).message)
      }
    }
  }

  /** Takes a checked report. False when the fleet is full and this session is new. */
  report(r: ModReport): boolean {
    this.sweep()
    const at = this.now()
    const prev = this.sessions.get(r.sessionId)
    if (!prev && this.sessions.size >= SESSIONS_MAX) return false
    if (!prev) this.log(`mod: session ${r.sessionId.slice(0, 40)} (${r.project || 'no project'}) reporting`)
    this.sessions.set(r.sessionId, { report: r, reportedAt: at, heardAt: at, firstSeenAt: prev?.firstSeenAt ?? at })
    this.everReported = true
    for (const l of r.rateLimits) {
      const p = this.readings.get(l.kind)
      if (!p || at >= p.at) this.readings.set(l.kind, { ...l, at })
    }
    if (r.costUsd !== null) {
      this.spent.delete(r.sessionId)
      this.spent.set(r.sessionId, { usd: r.costUsd, at })
      while (this.spent.size > SPENT_MAX) this.spent.delete(this.spent.keys().next().value!)
    }
    this.changed()
    return true
  }

  /** Any request from a session the bridge knows keeps it alive. */
  heard(src: string): void {
    const s = this.sessions.get(src)
    if (s) s.heardAt = this.now()
  }

  /** The session said it ended. */
  end(src: string): void {
    if (!this.sessions.has(src)) return
    this.drop(src, 'ended')
    this.changed()
  }

  /** Drops sessions not heard from within expireMs. */
  sweep(): void {
    const now = this.now()
    let any = false
    for (const [id, s] of this.sessions) {
      if (now - s.heardAt > this.expireMs) {
        this.drop(id, `not heard from in ${Math.round((now - s.heardAt) / 1000)} s`)
        any = true
      }
    }
    if (any) this.changed()
  }

  private drop(id: string, why: string): void {
    this.sessions.delete(id)
    this.log(`mod: session ${id.slice(0, 40)} dropped: ${why}`)
    this.polls.get(id)?.answer(null)
    this.polls.delete(id)
    for (const m of [...this.outgoing.values()]) {
      if (m.sessionId !== id) continue
      if (m.handed) m.settle({ ok: false, refused: false, reason: `the session ${why} after it collected the message, before it confirmed it` })
      else m.settle({ ok: false, refused: true, reason: `the session ${why} before it collected the message` })
    }
  }

  live(): LiveSession[] {
    this.sweep()
    return [...this.sessions.values()]
  }

  get(id: string): LiveSession | undefined {
    this.sweep()
    return this.sessions.get(id)
  }

  limitReadings(): Reading[] {
    return [...this.readings.values()]
  }

  spend(): { usd: number; at: number }[] {
    return [...this.spent.values()]
  }

  /**
   * Queues a message for a live session and waits for it to settle. A second
   * send with the same id while the first is open shares its outcome.
   */
  send(sessionId: string, id: string, text: string): Promise<SendSettle> {
    const open = this.outgoing.get(id)
    if (open) {
      if (open.sessionId !== sessionId || open.text !== text) throw new SendRefused('that request id is already in use for another message. Nothing was sent.', 409)
      return open.done
    }
    if (!this.get(sessionId)) throw new SendRefused(`no live Claude Code session ${sessionId.slice(0, 40)}`)
    const queued = [...this.outgoing.values()].filter(m => m.sessionId === sessionId && !m.handed).length
    if (queued >= QUEUE_MAX) throw new SendRefused(`${queued} messages are already waiting for that session to collect them. Nothing was sent.`, 429)
    let settle!: (s: SendSettle) => void
    const done = new Promise<SendSettle>(ok => (settle = ok))
    const m: Outgoing = {
      id,
      sessionId,
      text,
      handed: false,
      timer: null,
      done,
      settle: s => {
        if (this.outgoing.get(id) !== m) return
        this.outgoing.delete(id)
        if (m.timer) clearTimeout(m.timer)
        settle(s)
      },
    }
    // From the moment it is queued. One never collected is withdrawn and
    // refused: it surely was not sent. One collected and not confirmed is unknown.
    m.timer = setTimeout(() => {
      const s = Math.round(this.ackTimeoutMs / 1000)
      if (m.handed) m.settle({ ok: false, refused: false, reason: `the session collected the message but did not confirm it within ${s} s` })
      else m.settle({ ok: false, refused: true, reason: `the session did not collect the message within ${s} s, so it was withdrawn` })
    }, this.ackTimeoutMs)
    m.timer.unref?.()
    this.outgoing.set(id, m)
    this.flush(sessionId)
    return done
  }

  private waiting(sessionId: string): Outgoing[] {
    return [...this.outgoing.values()].filter(m => m.sessionId === sessionId && !m.handed)
  }

  /** Answers an open poll for this session with what is waiting, if anything is. */
  private flush(sessionId: string): void {
    const poll = this.polls.get(sessionId)
    const items = this.waiting(sessionId)
    if (!poll || !items.length) return
    this.polls.delete(sessionId)
    for (const m of items) m.handed = true
    poll.answer(items.map(m => ({ id: m.id, text: m.text })))
  }

  /**
   * An inbox poll. `answer` is called once: with the waiting messages, or
   * null for nothing (held too long, replaced by a newer poll, the session
   * dropped). Returns a function that withdraws the poll when the request
   * closes first.
   */
  poll(src: string, answer: (items: { id: string; text: string }[] | null) => void): () => void {
    this.heard(src)
    const items = this.waiting(src)
    if (items.length) {
      for (const m of items) m.handed = true
      answer(items.map(m => ({ id: m.id, text: m.text })))
      return () => {}
    }
    // One poll per session: an older one is answered empty.
    this.polls.get(src)?.answer(null)
    let answered = false
    const timer = setTimeout(() => entry.answer(null), this.pollHoldMs)
    timer.unref?.()
    const entry: Poll = {
      answer: x => {
        if (answered) return
        answered = true
        clearTimeout(timer)
        if (this.polls.get(src) === entry) this.polls.delete(src)
        answer(x)
      },
    }
    this.polls.set(src, entry)
    return () => {
      if (answered) return
      answered = true
      clearTimeout(timer)
      if (this.polls.get(src) === entry) this.polls.delete(src)
    }
  }

  /** The mod's ack. Only the session the message was for can settle it. */
  ack(src: string, id: string, ok: boolean, reason: string | null, delivery: 'started' | 'queued' | null = null): void {
    this.heard(src)
    const m = this.outgoing.get(id)
    if (!m || m.sessionId !== src || !m.handed) {
      this.log(`mod: ack from ${src.slice(0, 40)} for a message it was not handed; ignored`)
      return
    }
    m.settle(ok ? { ok: true, delivery } : { ok: false, refused: true, reason: reason || 'the mod gave no reason' })
  }

  /** Answers every open poll and settles every open send, for shutdown. */
  close(): void {
    for (const p of [...this.polls.values()]) p.answer(null)
    this.polls.clear()
    for (const m of [...this.outgoing.values()]) {
      if (m.handed) m.settle({ ok: false, refused: false, reason: 'the bridge stopped before the session confirmed the message' })
      else m.settle({ ok: false, refused: true, reason: 'the bridge stopped before the session collected the message' })
    }
    this.listeners.clear()
  }
}
