// T3 Code's own thread list, folded into the HUD's Fleet. Pure: the adapter
// calls the MCP tools, this reads what they returned. Field names follow
// t3_thread_list, t3_thread_read and t3_project_list as T3 answers them.
//
// A top-level thread is a session. A thread whose relationshipToParent is
// "subagent" belongs to its parent (or its parent's parent) as one of that
// session's agents, and is never a session of its own.

import type { AgentInfo, AgentState, Fleet, Message, Need, Session, SessionState, Turn, Usage } from '../../../../shared/protocol.ts'
import { assignCallsigns } from '../callsign.ts'
import { AGENTS_KEPT, byAgentOrder, clip } from '../dashweb/normalise.ts'
import { THREAD_ID, TURN_MAX } from '../dashweb/adapter.ts'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const ms = (v: unknown): number | null => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : null
}

const MESSAGE_MAX = 1200
const MESSAGES_KEPT = 6
const AGENT_LINE_MAX = 100
const AGENT_ID_MAX = 80
/** How many ancestors a sub-agent is followed up before it counts as lost. */
const PARENT_HOPS = 8

/** One row of t3_thread_list, the fields this backend uses. */
export interface T3ThreadRow {
  threadId: string
  projectId: string | null
  title: string
  status: string
  provider: string | null
  model: string | null
  settled: boolean
  snoozed: boolean
  parentThreadId: string | null
  subagent: boolean
  itemCount: number
  createdAt: number | null
  updatedAt: number | null
  /** The t3-thread:// address T3 opens the thread at, when it gave one. */
  url: string | null
}

/** "[title](t3-thread://v2/...)" -> "t3-thread://v2/...". */
function urlOf(link: unknown): string | null {
  const m = typeof link === 'string' ? /\]\((t3-thread:\/\/[^)\s]+)\)\s*$/.exec(link) : null
  return m ? m[1]! : null
}

export function threadRow(raw: unknown): T3ThreadRow | null {
  if (!isObj(raw)) return null
  const threadId = str(raw.threadId)
  if (!threadId) return null
  return {
    threadId,
    projectId: str(raw.projectId),
    title: str(raw.title) ?? 'untitled thread',
    status: str(raw.status) ?? 'unknown',
    provider: str(raw.providerInstanceId),
    model: str(raw.model),
    settled: raw.settled === true,
    snoozed: raw.snoozed === true,
    parentThreadId: str(raw.parentThreadId),
    subagent: raw.relationshipToParent === 'subagent',
    itemCount: Math.max(0, Math.floor(num(raw.itemCount) ?? 0)),
    createdAt: ms(raw.createdAt),
    updatedAt: ms(raw.updatedAt),
    url: urlOf(raw.link),
  }
}

/** t3_thread_list's page: its threads and where the next page starts, or null at the end. */
export function threadPage(raw: unknown): { threads: T3ThreadRow[]; nextCursor: number | null } {
  if (!isObj(raw) || !Array.isArray(raw.threads)) throw new Error('t3_thread_list did not return a thread list')
  const threads = raw.threads.map(threadRow).filter((t): t is T3ThreadRow => t !== null)
  const c = num(raw.nextCursor)
  return { threads, nextCursor: c !== null && c >= 0 ? Math.floor(c) : null }
}

/** t3_project_list's page: project id -> name, and the next cursor. */
export function projectPage(raw: unknown): { names: Map<string, string>; nextCursor: number | null } {
  if (!isObj(raw) || !Array.isArray(raw.projects)) throw new Error('t3_project_list did not return a project list')
  const names = new Map<string, string>()
  for (const p of raw.projects) {
    if (!isObj(p)) continue
    const id = str(p.id)
    const name = str(p.title) ?? str(isObj(p.repositoryIdentity) ? p.repositoryIdentity.name : null)
    if (id && name) names.set(id, name)
  }
  const c = num(raw.nextCursor)
  return { names, nextCursor: c !== null && c >= 0 ? Math.floor(c) : null }
}

/**
 * T3's thread status as the HUD's state. "waiting" is a thread waiting on the
 * person, so it reads as asking. "interrupted" is most often someone pressing
 * stop, so it reads as idle; "failed" is the one that wants looking at.
 */
const STATES: Record<string, SessionState> = {
  idle: 'idle',
  preparing: 'thinking',
  queued: 'thinking',
  starting: 'thinking',
  running: 'working',
  waiting: 'asking',
  completed: 'done',
  interrupted: 'idle',
  failed: 'failed',
  cancelled: 'idle',
  rolled_back: 'idle',
}

/** Statuses that keep a thread on the HUD however long ago it last changed. */
export const LIVE_STATUSES: ReadonlySet<string> = new Set(['preparing', 'queued', 'starting', 'running', 'waiting'])

/** A sub-agent thread's status. A finished one sits at "idle" in T3. */
const AGENT_STATES: Record<string, AgentState> = {
  preparing: 'running',
  queued: 'running',
  starting: 'running',
  running: 'running',
  waiting: 'running',
  idle: 'done',
  completed: 'done',
  failed: 'failed',
  interrupted: 'failed',
  cancelled: 'failed',
  rolled_back: 'failed',
}

/** What the adapter read of one thread's latest messages, for the card's last line. */
export interface ThreadTail {
  messages: Message[]
}

/** t3_thread_read's items as messages: what the session said, newest last. */
export function tailOf(raw: unknown): ThreadTail {
  const items = isObj(raw) ? arr(raw.items) : []
  const messages = items
    .filter(isObj)
    .filter(i => i.type === 'assistant_message' && str(i.text))
    .map(i => ({ at: ms(i.updatedAt), text: clip(String(i.text), MESSAGE_MAX) }))
  return { messages: messages.slice(-MESSAGES_KEPT) }
}

/** t3_thread_read's items as turns, oldest first. */
export function turnsOf(raw: unknown): Turn[] {
  if (!isObj(raw) || !Array.isArray(raw.items)) throw new Error('t3_thread_read returned no items list')
  const turns: Turn[] = []
  for (const i of raw.items) {
    if (!isObj(i)) continue
    const text = typeof i.text === 'string' ? i.text.trim() : ''
    if (!text) continue
    const role: Turn['role'] = i.type === 'user_message' ? 'you' : i.type === 'assistant_message' ? 'session' : 'other'
    const cut = i.textTruncated === true || text.length > TURN_MAX
    turns.push({ role, text: text.length > TURN_MAX ? `${text.slice(0, TURN_MAX)}…` : cut ? `${text}…` : text, clipped: cut })
  }
  return turns
}

/** T3 keeps no spend or limits a client can read. */
export const NO_USAGE: Usage = {
  todayUsd: { value: null, at: null, stale: false, note: 'T3 does not report spend' },
  limits: { value: null, at: null, stale: false, note: 'T3 does not report usage limits' },
}

export interface T3Input {
  threads: readonly T3ThreadRow[]
  projects: ReadonlyMap<string, string>
  /** Latest messages read this poll or kept from an earlier one, by thread id. */
  tails?: ReadonlyMap<string, ThreadTail>
  /** Whether sends can go out at all (a usable link). */
  canSend: boolean
  /** A thread shows when it changed after this, or has a live status. */
  activeSince: number
  warnings?: string[]
}

export interface T3Normalised {
  fleet: Fleet
  /** Session id -> T3 thread id, for the sessions `send` may reach. */
  routes: Map<string, string>
  /** Session id -> its thread's itemCount, so a transcript read can start near the end. */
  itemCounts: Map<string, number>
}

function agentOf(t: T3ThreadRow, depth: number): AgentInfo {
  const state = AGENT_STATES[t.status] ?? 'unknown'
  return {
    id: t.threadId.slice(0, AGENT_ID_MAX),
    type: clip(t.provider ? `${t.provider} agent` : 'agent', 40),
    description: clip(t.title, AGENT_LINE_MAX),
    state,
    model: t.model ? clip(t.model, 40) : null,
    startedAt: t.createdAt,
    endedAt: state === 'running' ? null : t.updatedAt,
    now: state === 'running' ? clip(t.status, AGENT_LINE_MAX) : null,
    depth: Math.min(9, depth),
    brief: null,
    recent: [],
  }
}

export function normaliseT3(input: T3Input, now = Date.now()): T3Normalised {
  const all = new Map<string, T3ThreadRow>()
  for (const t of input.threads) if (!all.has(t.threadId)) all.set(t.threadId, t)

  const shown = (t: T3ThreadRow) => !t.snoozed && !t.settled && (LIVE_STATUSES.has(t.status) || (t.updatedAt ?? 0) >= input.activeSince)
  // A child thread T3 made some other way (a delegated task) is a thread of its own, so a session too.
  const top = [...all.values()].filter(t => !t.subagent && shown(t))
  const topIds = new Set(top.map(t => t.threadId))

  // Each sub-agent goes to the top-level thread above it, however deep.
  const agentsBy = new Map<string, AgentInfo[]>()
  for (const t of all.values()) {
    if (!t.subagent || t.snoozed) continue
    let parent = t.parentThreadId
    let depth = 1
    for (let hops = 0; parent && hops < PARENT_HOPS && !topIds.has(parent); hops++) {
      parent = all.get(parent)?.parentThreadId ?? null
      depth++
    }
    if (!parent || !topIds.has(parent)) continue
    const list = agentsBy.get(parent) ?? []
    list.push(agentOf(t, depth))
    agentsBy.set(parent, list)
  }

  const projectOf = (t: T3ThreadRow) => (t.projectId ? (input.projects.get(t.projectId) ?? null) : null)
  const callsigns = assignCallsigns(top.map(t => ({ id: t.threadId, project: projectOf(t), title: t.title, startedAt: t.createdAt })))

  const routes = new Map<string, string>()
  const itemCounts = new Map<string, number>()
  const needs: Need[] = []
  const sessions: Session[] = top.map(t => {
    const id = t.threadId
    const state = STATES[t.status] ?? 'unknown'
    const messages = input.tails?.get(id)?.messages ?? []
    const lastLine = messages.length ? clip(messages[messages.length - 1]!.text) : null
    // The id goes to T3 as a JSON string, but it is checked like the CLI's all the same.
    const canSend = input.canSend && THREAD_ID.test(id)
    if (canSend) routes.set(id, id)
    itemCounts.set(id, t.itemCount)
    const asking = state === 'asking' ? { text: lastLine ?? 'Waiting on you in T3', options: [], answerAt: t.url } : null
    const agents = (agentsBy.get(id) ?? []).sort(byAgentOrder)
    const rest = agents.slice(AGENTS_KEPT)
    const s: Session = {
      id,
      callsign: callsigns.get(id)!,
      title: t.title,
      project: projectOf(t),
      kind: t.provider ? `T3 ${t.provider}` : 'T3',
      state,
      action: state === 'working' || state === 'thinking' ? t.status : null,
      lastLine,
      activeAt: t.updatedAt,
      startedAt: t.createdAt,
      asking,
      messages,
      canSend,
      context: null,
      agents: agents.slice(0, AGENTS_KEPT),
      moreAgents: rest.length,
      moreRunning: rest.filter(a => a.state === 'running').length,
    }
    if (asking) needs.push({ id: `t3:${id}:waiting`, kind: 'question', sessionId: id, callsign: s.callsign, label: t.title, text: asking.text, options: [], since: t.updatedAt, source: 'T3' })
    else if (state === 'failed') needs.push({ id: `t3:${id}:failed`, kind: 'failed', sessionId: id, callsign: s.callsign, label: t.title, text: lastLine ?? 'its last run failed', options: [], since: t.updatedAt, source: 'T3' })
    return s
  })
  needs.sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity))

  return {
    fleet: { at: now, sessions, needs, ledger: null, usage: NO_USAGE, warnings: [...(input.warnings ?? [])] },
    routes,
    itemCounts,
  }
}
