// Which of a session's sub-agents the HUD shows, for both views. Running
// agents always show; a finished one shows, dimmed, for a couple of minutes
// after it ends, so a quick agent is not gone before anyone sees it.

import type { AgentInfo, AgentState, Session } from './protocol.ts'

/** A finished agent stays on screen this long after it ends. */
export const FINISHED_SHOWN_MS = 120_000

/** The agents worth showing now, in the bridge's order, and the running ones the bridge's cap left out. */
export function shownAgents(s: Pick<Session, 'agents' | 'moreRunning'>, now: number): { agents: AgentInfo[]; hiddenRunning: number } {
  const agents = (s.agents ?? []).filter(a => {
    if (a.state === 'running') return true
    // No end seen: the start is the best guess at when it last did anything.
    const at = a.endedAt ?? a.startedAt
    return at !== null && now - at < FINISHED_SHOWN_MS
  })
  return { agents, hiddenRunning: Math.max(0, s.moreRunning ?? 0) }
}

/** The state as a short word for a box. */
export const AGENT_WORDS: Record<AgentState, string> = { running: 'RUNNING', done: 'DONE', failed: 'FAILED', unknown: 'UNKNOWN' }

/** "4m 10s", "35s": how long it has run, or ran. */
export function runTime(a: Pick<AgentInfo, 'startedAt' | 'endedAt'>, now: number): string | null {
  if (a.startedAt === null) return null
  const s = Math.max(0, Math.round(((a.endedAt ?? now) - a.startedAt) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
