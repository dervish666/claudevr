// The mods' reports folded into the HUD's Fleet. Pure: the hub holds the
// reports, this reads them.

import type { AgentInfo, Figure, Fleet, LimitWindow, Need, Session, Usage } from '../../../../shared/protocol.ts'
import { assignCallsigns, type CallsignOverride } from '../callsign.ts'
import { AGENTS_KEPT, byAgentOrder, clip } from '../dashweb/normalise.ts'
import { LIMITS_STALE_MS } from '../dashweb/usage.ts'
import type { LiveSession, Reading } from './hub.ts'

const LABELS: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly' }
const ORDER = ['five_hour', 'seven_day']
const labelOf = (kind: string) => LABELS[kind] ?? kind.replace(/_/g, ' ')
const rank = (k: string) => (ORDER.includes(k) ? ORDER.indexOf(k) : ORDER.length)

const SPEND_NOTE = 'Summed from each session\'s /cost at API rates; on a subscription this measures use, not a bill'

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000)
  return m < 120 ? `${m} min` : `${Math.round(m / 60)} h`
}

/**
 * The freshest reading of each window. A window whose reset has passed says
 * nothing about now and is dropped. The figure's age is that of the oldest
 * window shown, so one fresh window never hides a stale one.
 */
export function limitsOf(readings: readonly Reading[], now: number): Figure<LimitWindow[]> {
  if (!readings.length) return { value: null, at: null, stale: false, note: 'no Claude Code session has reported usage limits yet (none do off a subscription)' }
  const shown = readings.filter(r => r.resetsAt === null || r.resetsAt > now).sort((a, b) => rank(a.kind) - rank(b.kind) || a.kind.localeCompare(b.kind))
  const rolled = readings.filter(r => !shown.includes(r)).map(r => `${labelOf(r.kind)} window reset since the last reading`)
  if (!shown.length) return { value: null, at: null, stale: false, note: rolled.join('; ') }
  const at = Math.min(...shown.map(r => r.at))
  const stale = now - at > LIMITS_STALE_MS
  const notes = [...(stale ? [`last reading ${minutes(now - at)} ago: no session has refreshed it since`] : []), ...rolled]
  return {
    value: shown.map(r => ({ kind: r.kind, label: labelOf(r.kind), usedPct: r.usedPct, resetsAt: r.resetsAt })),
    at,
    stale,
    note: notes.length ? notes.join('; ') : null,
  }
}

const dayOf = (t: number) => new Date(t).toDateString()

/** The sum of the latest cost of every session seen today, local time. */
export function spendOf(spent: readonly { usd: number; at: number }[], now: number): Figure<number> {
  const today = spent.filter(s => dayOf(s.at) === dayOf(now))
  if (!today.length) return { value: null, at: null, stale: false, note: 'no Claude Code session has reported its cost today' }
  return { value: Math.round(today.reduce((a, s) => a + s.usd, 0) * 100) / 100, at: Math.max(...today.map(s => s.at)), stale: false, note: SPEND_NOTE }
}

export function usageOf(readings: readonly Reading[], spent: readonly { usd: number; at: number }[], now: number): Usage {
  return { todayUsd: spendOf(spent, now), limits: limitsOf(readings, now) }
}

export interface ClaudeInput {
  sessions: readonly LiveSession[]
  readings: readonly Reading[]
  spent: readonly { usd: number; at: number }[]
  callsigns?: readonly CallsignOverride[]
  warnings?: string[]
}

export function normaliseClaude(input: ClaudeInput, now = Date.now()): Fleet {
  const callsigns = assignCallsigns(
    input.sessions.map(s => ({ id: s.report.sessionId, project: s.report.project || null, title: s.report.title, startedAt: s.report.startedAt })),
    input.callsigns ?? [],
  )
  const needs: Need[] = []
  const sessions: Session[] = input.sessions.map(({ report: r, reportedAt }) => {
    const id = r.sessionId
    const state = r.asking ? 'asking' : r.state
    const messages = r.messages.filter(m => m.role === 'session').map(m => ({ at: m.at, text: m.text }))
    const lastLine = r.lastLine ?? (messages.length ? clip(messages[messages.length - 1]!.text) : null)
    const agents: AgentInfo[] = r.agents
      .map(a => ({ ...a, depth: 1, brief: null, recent: [] }))
      .sort(byAgentOrder)
    const rest = agents.slice(AGENTS_KEPT)
    const title = r.title || r.project || id.slice(0, 8)
    const s: Session = {
      id,
      callsign: callsigns.get(id)!,
      title,
      project: r.project || null,
      kind: 'Claude Code',
      state,
      action: state === 'working' || state === 'thinking' ? r.action : null,
      lastLine,
      activeAt: r.activeAt,
      startedAt: r.startedAt,
      asking: r.asking ? { text: r.asking.text, options: r.asking.options, answerAt: null } : null,
      messages,
      canSend: true,
      context: r.context ? { ...r.context, at: reportedAt } : null,
      agents: agents.slice(0, AGENTS_KEPT),
      moreAgents: rest.length,
      moreRunning: rest.filter(a => a.state === 'running').length,
    }
    if (s.asking) needs.push({ id: `claude:${id}:asking`, kind: 'question', sessionId: id, callsign: s.callsign, label: title, text: s.asking.text, options: s.asking.options, since: r.activeAt, source: 'Claude Code' })
    else if (state === 'failed') needs.push({ id: `claude:${id}:failed`, kind: 'failed', sessionId: id, callsign: s.callsign, label: title, text: lastLine ?? 'its last turn failed', options: [], since: r.activeAt, source: 'Claude Code' })
    return s
  })
  sessions.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id.localeCompare(b.id))
  needs.sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity))
  return { at: now, sessions, needs, ledger: null, usage: usageOf(input.readings, input.spent, now), warnings: [...(input.warnings ?? [])] }
}
