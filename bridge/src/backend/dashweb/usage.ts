// dashweb's GET /api/state/office, read for the account's usage windows and
// each session's context. Pure: the adapter fetches, this reads.
//
// Every Claude Code session running the status-dash mod posts its figures to
// dashweb's office channel (status-dash hooks/register.tsx, refreshUsage and
// publish), keyed by its session id, which is the board's sessionId too:
//
//   data.stats.usage      { measuredAt, context: { tokens?, window, percent? },
//                           rateLimits: [{ kind, percentUsed, resetsAt? }], costUsd? }
//                         from Claude Code's status line input
//   data.stats.breakdown  { totalTokens, rawMaxTokens, percentage, ... } or null,
//                         the /context breakdown, a local estimate
//
// The rate windows are the account's, so every session carries a copy; the
// freshest reading of each window that has not reset since wins, as dashweb's
// own pages pick it (src/hq/main.ts readFiveHour, src/hq/stats.ts limitsBar).
// Context prefers the breakdown's percentage over the status line's, as
// dashweb's session cards do (src/hq/stats.ts, `ctxPct`).

import type { ContextUse, Figure, LimitWindow } from '../../../../shared/protocol.ts'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const obj = (v: unknown): Obj => (isObj(v) ? v : {})
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const pct = (v: unknown): number | null => {
  const n = num(v)
  return n !== null && n >= 0 && n <= 1000 ? n : null
}

/** A limits reading older than this is shown with its age: no session has refreshed it. */
export const LIMITS_STALE_MS = 15 * 60_000

const LABELS: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly' }
const ORDER = ['five_hour', 'seven_day']
const labelOf = (kind: string) => LABELS[kind] ?? kind.replace(/_/g, ' ')

export interface OfficeRead {
  limits: Figure<LimitWindow[]>
  /** Session id -> its context, for the sessions that report one. */
  contexts: Map<string, ContextUse>
}

const none = (note: string): Figure<LimitWindow[]> => ({ value: null, at: null, stale: false, note })

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000)
  return m < 120 ? `${m} min` : `${Math.round(m / 60)} h`
}

function contextOf(usage: Obj, breakdown: Obj, at: number | null): ContextUse | null {
  const bdPct = pct(breakdown.percentage)
  if (bdPct !== null) return { usedPct: bdPct, tokens: num(breakdown.totalTokens), windowTokens: num(breakdown.rawMaxTokens), at }
  const c = obj(usage.context)
  const tokens = num(c.tokens)
  const window = num(c.window)
  const p = pct(c.percent) ?? (tokens !== null && window ? (100 * tokens) / window : null)
  return p === null ? null : { usedPct: p, tokens, windowTokens: window, at }
}

/**
 * The office snapshot -> limits and contexts. `raw` may be an Error (the
 * read failed): every figure is then unavailable, with the reason.
 */
export function readOffice(raw: unknown, now = Date.now()): OfficeRead {
  const contexts = new Map<string, ContextUse>()
  if (raw instanceof Error) return { limits: none(`cannot read dashweb's office: ${raw.message}`), contexts }
  if (!isObj(raw)) return { limits: none('dashweb /api/state/office did not return a snapshot'), contexts }

  // kind -> the freshest reading of it whose window has not rolled over.
  const best = new Map<string, { w: LimitWindow; at: number }>()
  const rolled = new Set<string>()
  let readings = 0
  for (const [src, entry] of Object.entries(raw)) {
    const stats = obj(obj(obj(entry).data).stats)
    const usage = obj(stats.usage)
    const at = num(usage.measuredAt)
    const ctx = contextOf(usage, obj(stats.breakdown), at)
    if (ctx) contexts.set(src, ctx)
    if (at === null || !Array.isArray(usage.rateLimits)) continue
    for (const l of usage.rateLimits.map(obj)) {
      const kind = typeof l.kind === 'string' && l.kind ? l.kind : null
      const used = pct(l.percentUsed)
      if (!kind || used === null) continue
      readings++
      const parsed = typeof l.resetsAt === 'string' ? Date.parse(l.resetsAt) : NaN
      const resetsAt = Number.isFinite(parsed) ? parsed : null
      // A reading of a window that has reset since says nothing about now.
      if (resetsAt !== null && resetsAt <= now) {
        rolled.add(kind)
        continue
      }
      const prev = best.get(kind)
      if (!prev || at > prev.at) best.set(kind, { w: { kind, label: labelOf(kind), usedPct: used, resetsAt }, at })
    }
  }

  if (!readings) return { limits: none('no session has reported the limits yet (they come from Claude Code status lines via status-dash)'), contexts }
  const rank = (k: string) => (ORDER.includes(k) ? ORDER.indexOf(k) : ORDER.length)
  const kinds = [...best.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  const resetNote = [...rolled].filter(k => !best.has(k)).map(k => `${labelOf(k)} window reset since the last reading`)
  if (!kinds.length) return { limits: none(resetNote.join('; ')), contexts }
  const at = Math.max(...kinds.map(k => best.get(k)!.at))
  const stale = now - at > LIMITS_STALE_MS
  const notes = [...(stale ? [`last reading ${minutes(now - at)} ago: no session has refreshed it since`] : []), ...resetNote]
  return { limits: { value: kinds.map(k => best.get(k)!.w), at, stale, note: notes.length ? notes.join('; ') : null }, contexts }
}
