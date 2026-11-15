// The logic behind the needs-you rail and the reply cards, kept free of
// three.js and React so the bridge's test runner can import it.

import type { Need, Session, SessionState } from '../../../shared/protocol.ts'

// ---------------------------------------------------------------- needs-you rail

/** Cards the rail has room for, the "+N more" marker included. */
export const RAIL_MAX = 4

/**
 * The needs to show, oldest first, and how many did not fit. Items whose
 * age is unknown go after the dated ones. When there are more than fit, the
 * last place goes to a "+N more" marker, so the count is always on screen.
 */
export function railItems(needs: Need[], max = RAIL_MAX): { shown: Need[]; more: number } {
  const sorted = needs
    .map((n, i) => ({ n, i }))
    .sort((a, b) => (a.n.since ?? Infinity) - (b.n.since ?? Infinity) || a.i - b.i)
    .map(x => x.n)
  if (sorted.length <= max) return { shown: sorted, more: 0 }
  const keep = Math.max(0, max - 1)
  return { shown: sorted.slice(0, keep), more: sorted.length - keep }
}

// ---------------------------------------------------------------- reply cards

/** How long a reply card stays up once shown. */
export const REPLY_TTL_MS = 8000
/** Reply cards on screen at once; the rest wait their turn. */
export const REPLY_MAX = 3

export type ReplyWhy = 'said' | 'finished' | 'asking' | 'failed'

export interface ReplyCard {
  /** The session's id: one card per session at a time. */
  id: string
  callsign: string
  why: ReplyWhy
  /** The first few lines of what it said. */
  lines: string[]
  /** Epoch ms the card went on screen; null while it waits. */
  shownAt: number | null
}

export interface Seen {
  lastLine: string | null
  state: SessionState
}

export type Snapshot = Map<string, Seen>

export function snapshot(sessions: Session[]): Snapshot {
  return new Map(sessions.map(s => [s.id, { lastLine: s.lastLine, state: s.state }]))
}

const BUSY = new Set<SessionState>(['working', 'thinking'])
const SETTLED = new Set<SessionState>(['idle', 'done', 'asking', 'failed'])

/** The first `max` non-empty lines of `text`, each cut to `width` characters. */
export function firstLines(text: string, max = 3, width = 90): string[] {
  const out: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    out.push(line.length > width ? `${line.slice(0, width - 1).trimEnd()}…` : line)
    if (out.length === max) break
  }
  return out
}

/**
 * Cards for what changed between two looks at the fleet: a session that is
 * not the Core's target said something new, or stopped working (went idle,
 * finished, asked, or failed). A session first seen in `sessions` fires
 * nothing, and with no earlier look (the first fleet after entry) nothing
 * fires at all.
 */
export function replyTriggers(prev: Snapshot | null, sessions: Session[], targetId: string | null): ReplyCard[] {
  if (!prev) return []
  const out: ReplyCard[] = []
  for (const s of sessions) {
    if (s.id === targetId) continue
    const p = prev.get(s.id)
    if (!p) continue
    const said = !!s.lastLine && s.lastLine !== p.lastLine
    const settled = BUSY.has(p.state) && SETTLED.has(s.state)
    if (!said && !settled) continue
    const why: ReplyWhy = s.state === 'asking' ? 'asking' : s.state === 'failed' ? 'failed' : said ? 'said' : 'finished'
    const text = s.state === 'asking' && s.asking ? s.asking.text : (s.messages.at(-1)?.text ?? s.lastLine ?? '')
    const lines = firstLines(text)
    out.push({ id: s.id, callsign: s.callsign, why, lines: lines.length ? lines : [why === 'finished' ? 'Stopped working; it said nothing new.' : 'Nothing said.'], shownAt: null })
  }
  return out
}

export interface ReplyQueue {
  shown: ReplyCard[]
  waiting: ReplyCard[]
}

export const EMPTY_QUEUE: ReplyQueue = { shown: [], waiting: [] }

function promote(shown: ReplyCard[], waiting: ReplyCard[], now: number, max: number): ReplyQueue {
  const s = shown.slice()
  const w = waiting.slice()
  while (s.length < max && w.length) s.push({ ...w.shift()!, shownAt: now })
  return { shown: s, waiting: w }
}

/**
 * New cards join the queue. A session that already has a card on screen
 * gets it updated in place, its timer restarted; one waiting is updated
 * where it waits. Otherwise it shows if there is room, else waits.
 */
export function pushReplies(q: ReplyQueue, cards: ReplyCard[], now: number, max = REPLY_MAX): ReplyQueue {
  if (!cards.length) return q
  let shown = q.shown.slice()
  let waiting = q.waiting.slice()
  for (const c of cards) {
    const si = shown.findIndex(x => x.id === c.id)
    if (si >= 0) {
      shown[si] = { ...c, shownAt: now }
      continue
    }
    const wi = waiting.findIndex(x => x.id === c.id)
    if (wi >= 0) waiting[wi] = { ...c, shownAt: null }
    else waiting.push({ ...c, shownAt: null })
  }
  ;({ shown, waiting } = promote(shown, waiting, now, max))
  return { shown, waiting }
}

/** Cards whose time is up go; waiting ones take their places. The same object back when nothing changed. */
export function expireReplies(q: ReplyQueue, now: number, ttl = REPLY_TTL_MS, max = REPLY_MAX): ReplyQueue {
  const keep = q.shown.filter(c => c.shownAt !== null && now - c.shownAt < ttl)
  if (keep.length === q.shown.length) return q
  return promote(keep, q.waiting, now, max)
}

/** A card picked, or its session selected: gone from screen and queue. */
export function dismissReply(q: ReplyQueue, id: string, now: number, max = REPLY_MAX): ReplyQueue {
  if (!q.shown.some(c => c.id === id) && !q.waiting.some(c => c.id === id)) return q
  return promote(
    q.shown.filter(c => c.id !== id),
    q.waiting.filter(c => c.id !== id),
    now,
    max,
  )
}

/** When the next shown card expires, or null with none showing. */
export function nextExpiry(q: ReplyQueue, ttl = REPLY_TTL_MS): number | null {
  let t: number | null = null
  for (const c of q.shown) if (c.shownAt !== null) t = Math.min(t ?? Infinity, c.shownAt + ttl)
  return t
}
