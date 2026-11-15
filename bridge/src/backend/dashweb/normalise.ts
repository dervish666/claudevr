// dashweb's GET /api/board and GET /api/t3, folded into the HUD's Fleet.
// Pure: the adapter fetches, this reads. Field names follow dashweb's
// server.mjs (buildBoard, sessionView, t3Report) and board.mjs (kanbanOf).
//
// The board's fleet is three lists: `dispatcher` (one session view or null),
// `tasks[].session` (the live session a ledger row matched, or null) and
// `other` (every other live session, T3-only Codex threads among them).

import type { AgentActivity, AgentInfo, AgentState, Ask, Figure, Fleet, Ledger, LedgerRow, Message, Need, NeedKind, Session, SessionState } from '../../../../shared/protocol.ts'
import { assignCallsigns } from '../callsign.ts'
import { readOffice } from './usage.ts'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const obj = (v: unknown): Obj => (isObj(v) ? v : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

const LINE_MAX = 240
const MESSAGE_MAX = 1200
const MESSAGES_KEPT = 6

/** One line, clipped at a word where it can be. */
export function clip(text: string, max = LINE_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.lastIndexOf(' ', max - 1)
  return `${t.slice(0, cut > max * 0.6 ? cut : max - 1)}…`
}

/** "2026-11-09 12:55" or "2026-11-09", the ledger's local time, to epoch ms; null if it isn't one. */
export function parseLocalStamp(s: string | null): number | null {
  // A date with no time counts from that midnight: an age in days is still right.
  const m = s ? /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?(?!\d)/.exec(s.trim()) : null
  if (!m) return null
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)).getTime()
  return Number.isFinite(t) ? t : null
}

const STATES: Record<string, SessionState> = {
  working: 'working',
  thinking: 'thinking',
  idle: 'idle',
  failed: 'failed',
  done: 'done',
}

function stateOf(view: Obj, asking: Ask | null): SessionState {
  if (asking) return 'asking'
  const s = str(view.state)
  if (s && STATES[s]) return STATES[s]
  const now = str(obj(view.now).state)
  if (now && STATES[now]) return STATES[now]
  if (view.status === 'busy') return 'working'
  if (view.status === 'idle') return 'idle'
  return 'unknown'
}

function actionOf(view: Obj, state: SessionState): string | null {
  if (state !== 'working' && state !== 'thinking') return null
  const now = obj(view.now)
  const tool = str(now.tool)
  const detail = str(now.detail)
  if (detail) return clip(tool ? `${tool}: ${detail}` : detail)
  const status = str(now.status)
  return status ? clip(status) : null
}

/** session.asking[]: status-dash's AskUserQuestion dialogs and T3's own requests. */
function askOf(view: Obj): Ask | null {
  const first = obj(arr(view.asking)[0])
  if (!Object.keys(first).length) return null
  const q = obj(arr(first.questions)[0])
  const text = str(q.question) ?? str(q.header) ?? 'A question is waiting'
  const options = arr(q.options)
    .map(o => (typeof o === 'string' ? o : str(obj(o).label)))
    .filter((o): o is string => Boolean(o))
  return { text: clip(text, MESSAGE_MAX), options, answerAt: str(first.link) }
}

function messagesOf(view: Obj): Message[] {
  const says = arr(view.recent)
    .map(obj)
    .filter(r => r.kind === 'say' && str(r.text))
    .map(r => ({ at: num(r.at), text: clip(String(r.text), MESSAGE_MAX) }))
  const say = obj(view.say)
  const sayText = str(say.text)
  if (sayText && !says.some(m => m.at === num(say.at))) says.push({ at: num(say.at), text: clip(sayText, MESSAGE_MAX) })
  return says.slice(-MESSAGES_KEPT)
}

// ---------------------------------------------------------------- sub-agents

/** Sub-agents kept per session; the rest are only counted. */
export const AGENTS_KEPT = 6
const AGENT_LINE_MAX = 100
const AGENT_BRIEF_MAX = 240
const AGENT_RECENT_KEPT = 3
/** A finished agent older than this keeps its line on the card but loses its brief and recent list: the HUD no longer shows it, and every fleet push carries them. */
const AGENT_DETAIL_MS = 150_000
const AGENT_ID_MAX = 80

/**
 * dashweb's agent `status`, from status-dash. Seen on the live board:
 * "running" and "completed". dashweb's own pages also handle "failed",
 * "killed", "interrupted" and "quiet" (no end seen), so those are mapped
 * too; anything else is unknown.
 */
const AGENT_STATES: Record<string, AgentState> = {
  running: 'running',
  completed: 'done',
  failed: 'failed',
  killed: 'failed',
  interrupted: 'failed',
}

/** One activity line: "Bash: npm test", or what it said. Null when there is no text. */
function activityText(r: Obj): string | null {
  const text = str(r.text)
  const tool = str(r.tool)
  if (text) return clip(tool ? `${tool}: ${text}` : text, AGENT_LINE_MAX)
  return tool ? clip(tool, AGENT_LINE_MAX) : null
}

function agentOf(raw: unknown): AgentInfo | null {
  if (!isObj(raw)) return null
  const id = str(raw.id)
  if (!id) return null
  const status = str(raw.status)
  const state = (status && AGENT_STATES[status]) || 'unknown'
  const recent = arr(raw.recent)
    .map(obj)
    .map(r => ({ at: num(r.at), text: activityText(r) }))
    .filter((r): r is AgentActivity => r.text !== null)
    .slice(-AGENT_RECENT_KEPT)
  const nowObj = obj(raw.now)
  const nowTool = str(nowObj.tool)
  const nowDetail = str(nowObj.detail)
  const nowLine = nowDetail ? (nowTool ? `${nowTool}: ${nowDetail}` : nowDetail) : (str(nowObj.status) ?? nowTool)
  const depth = num(raw.depth)
  return {
    id: id.slice(0, AGENT_ID_MAX),
    type: clip(str(raw.type) ?? 'agent', 40),
    description: clip(str(raw.description) ?? 'no description', AGENT_LINE_MAX),
    state,
    model: str(raw.model) ? clip(String(raw.model), 40) : null,
    startedAt: num(raw.startedAt),
    endedAt: num(raw.endedAt),
    // What it is doing now; failing that, the newest thing it did.
    now: nowLine ? clip(nowLine, AGENT_LINE_MAX) : (recent.at(-1)?.text ?? null),
    depth: depth !== null && depth >= 1 ? Math.min(9, Math.floor(depth)) : 1,
    brief: str(raw.brief) ? clip(String(raw.brief), AGENT_BRIEF_MAX) : null,
    recent,
  }
}

/** Running first (newest start first), then finished, most recently ended first. */
export function byAgentOrder(a: AgentInfo, b: AgentInfo): number {
  const run = (x: AgentInfo) => (x.state === 'running' ? 0 : 1)
  if (run(a) !== run(b)) return run(a) - run(b)
  const t = (x: AgentInfo) => (x.state === 'running' ? x.startedAt : (x.endedAt ?? x.startedAt)) ?? 0
  return t(b) - t(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** A session's (or the dispatcher's) `agents` list, trimmed, ordered and capped, with what the cap left out counted. */
export function agentsOf(view: Obj, now: number): { agents: AgentInfo[]; moreAgents: number; moreRunning: number } {
  const seen = new Set<string>()
  const all: AgentInfo[] = []
  for (const raw of arr(view.agents)) {
    const a = agentOf(raw)
    if (!a || seen.has(a.id)) continue
    seen.add(a.id)
    all.push(a)
  }
  all.sort(byAgentOrder)
  const rest = all.slice(AGENTS_KEPT)
  // dashweb caps its own list and counts the rest in `more`; those never reach us, so they count as left out too.
  const boardMore = Math.max(0, Math.floor(num(view.more) ?? 0))
  const kept = all.slice(0, AGENTS_KEPT).map(a => {
    const ended = a.state === 'running' ? null : (a.endedAt ?? a.startedAt)
    return ended !== null && now - ended > AGENT_DETAIL_MS ? { ...a, brief: null, recent: [] } : a
  })
  return { agents: kept, moreAgents: rest.length + boardMore, moreRunning: rest.filter(a => a.state === 'running').length }
}

export interface T3Thread {
  threadId: string
  title: string
  project: string | null
  run: string | null
  pending: number
  native: boolean
  triaged: boolean
}

export interface T3Read {
  ok: boolean
  reason: string | null
  threads: Map<string, T3Thread>
}

/** GET /api/t3. `state` is "ok" when T3's store was read; anything else says why not. */
export function readT3(raw: unknown): T3Read {
  const d = obj(raw)
  const threads = new Map<string, T3Thread>()
  for (const t of arr(d.list).map(obj)) {
    const threadId = str(t.threadId)
    if (!threadId) continue
    threads.set(threadId, {
      threadId,
      title: str(t.title) ?? 'untitled thread',
      project: str(t.project),
      run: str(t.run),
      pending: num(t.pending) ?? 0,
      native: t.native === true,
      triaged: t.triaged === true,
    })
  }
  const ok = d.state === 'ok'
  return { ok, reason: ok ? null : (str(d.reason) ?? `T3 state is ${String(d.state ?? 'missing')}`), threads }
}

export interface Normalised {
  fleet: Fleet
  /** Session id -> T3 thread id, for the sessions `send` may reach. */
  routes: Map<string, string>
}

const FAILED_RUNS = new Set(['failed', 'interrupted'])

/** What the adapter read besides the board: the office snapshot (or why not) and the stream's spend. */
export interface UsageInput {
  /** GET /api/state/office, or the Error that read ended in; undefined when it was not read. */
  office?: unknown
  spend?: Figure<number>
  /**
   * Sessions working in these directories are left out. The bridge's own
   * front-man processes are Claude sessions too, and dashweb lists them.
   */
  hideCwds?: readonly string[]
}

/**
 * Board + T3 -> Fleet. Throws when the board is not a board at all, so the
 * caller reports the backend as unreadable instead of showing an empty fleet.
 * `t3` may be an Error: the fleet still shows, with sends switched off.
 */
export function normalise(boardRaw: unknown, t3Raw: unknown, now = Date.now(), extra: UsageInput = {}): Normalised {
  if (!isObj(boardRaw) || !Array.isArray(boardRaw.other) || !Array.isArray(boardRaw.tasks)) {
    throw new Error('dashweb /api/board did not return a board (no `other` or `tasks` list)')
  }
  const board = boardRaw
  const warnings: string[] = []

  const t3: T3Read = t3Raw instanceof Error ? { ok: false, reason: t3Raw.message, threads: new Map() } : readT3(t3Raw)
  if (!t3.ok) warnings.push(`T3 not readable, sending is off: ${t3.reason}`)

  const office = extra.office === undefined ? null : readOffice(extra.office, now)

  const sessionsInfo = obj(board.sessions)
  if (str(sessionsInfo.error)) warnings.push(`dashweb cannot list live sessions: ${String(sessionsInfo.error)}`)
  if (board.warming === true) warnings.push('dashweb is warming up: action lines may be empty for a few seconds')

  // The fleet, deduplicated by session id, dispatcher first.
  const views: { view: Obj; role: string | null }[] = []
  const seen = new Set<string>()
  const take = (v: unknown, role: string | null) => {
    if (!isObj(v)) return
    const id = str(v.sessionId)
    if (!id || seen.has(id)) return
    const cwd = str(v.cwd)
    if (cwd && extra.hideCwds?.some(d => cwd === d || cwd.startsWith(d + '/'))) return
    seen.add(id)
    views.push({ view: v, role: role ?? str(v.role) })
  }
  take(board.dispatcher, 'dispatcher')
  for (const t of arr(board.tasks)) take(obj(t).session, null)
  for (const o of arr(board.other)) take(o, null)

  const callsigns = assignCallsigns(
    views.map(({ view, role }) => ({
      id: String(view.sessionId),
      project: str(view.project),
      title: str(view.title) ?? str(view.name) ?? '',
      startedAt: num(view.startedAt),
      role: role === 'dispatcher' ? 'dispatcher' : null,
    })),
  )

  const routes = new Map<string, string>()
  const sessions: Session[] = views.map(({ view, role }) => {
    const id = String(view.sessionId)
    const threadId = str(obj(view.t3).threadId)
    const thread = threadId ? t3.threads.get(threadId) : undefined
    // dashweb sends only to a thread T3 lists that is not a mirror of a
    // Claude session started elsewhere; the same rule here.
    const canSend = Boolean(t3.ok && threadId && thread && !thread.native)
    if (canSend && threadId) routes.set(id, threadId)
    const asking = askOf(view)
    const state = stateOf(view, asking)
    const messages = messagesOf(view)
    return {
      id,
      callsign: callsigns.get(id)!,
      title: str(view.title) ?? str(view.name) ?? id.slice(0, 8),
      project: str(view.project),
      kind: role === 'dispatcher' ? 'dispatcher' : (str(view.kind) ?? 'session'),
      state,
      action: actionOf(view, state),
      lastLine: messages.length ? clip(messages[messages.length - 1]!.text) : null,
      activeAt: num(view.activeAt) ?? num(view.updatedAt) ?? num(view.startedAt),
      startedAt: num(view.startedAt),
      asking,
      messages,
      canSend,
      context: office?.contexts.get(id) ?? null,
      ...agentsOf(view, num(board.at) ?? now),
    }
  })
  const byId = new Map(sessions.map(s => [s.id, s]))
  const threadToSession = new Map<string, string>()
  for (const { view } of views) {
    const th = str(obj(view.t3).threadId)
    if (th) threadToSession.set(th, String(view.sessionId))
  }

  const needs: Need[] = []
  const needFor = new Set<string>()
  const kanban = obj(board.kanban)
  for (const card of arr(kanban.cards).map(obj)) {
    if (card.column !== 'needs') continue
    const cardSession = obj(card.session)
    const sid = str(cardSession.sessionId)
    const session = sid ? byId.get(sid) : undefined
    const label = str(card.label) ?? str(card.key) ?? 'needs you'
    const key = str(card.key) ?? label
    const base = { sessionId: session?.id ?? null, callsign: session?.callsign ?? null, label: str(card.repo) ? `${label} ${String(card.repo)}` : label }
    const failed = obj(card.failed)
    if (Object.keys(failed).length) {
      needs.push({ ...base, id: `${key}:failed`, kind: 'failed', text: clip(str(failed.text) ?? 'reported FAILED', MESSAGE_MAX), options: [], since: num(failed.at), source: str(failed.source) ?? 'board' })
      if (session) needFor.add(session.id)
      continue
    }
    const qs = arr(card.questions)
      .map(obj)
      .filter(q => (str(q.state) ?? 'open') === 'open')
    // The board can carry one question twice: from the ledger's Questions
    // table and again from the row's own status. The first one stands.
    const taken = new Set<string>()
    for (const [i, q] of qs.entries()) {
      const qid = `${key}:${str(q.q) ?? i}`
      if (taken.has(qid)) continue
      taken.add(qid)
      const source = str(q.source) ?? 'board'
      const kind: NeedKind = source === 'dialog' || source === 't3' ? 'question' : 'needs-sam'
      const options = arr(q.options)
        .map(o => (typeof o === 'string' ? o : str(obj(o).label)))
        .filter((o): o is string => Boolean(o))
      needs.push({
        ...base,
        id: qid,
        kind,
        text: clip(str(q.text) ?? str(q.question) ?? str(card.status) ?? 'waiting on you', MESSAGE_MAX),
        options,
        since: num(q.askedAt) ?? parseLocalStamp(str(q.asked)),
        source,
      })
    }
    if (session && qs.length) needFor.add(session.id)
  }

  // A session asking or failed that no card carries yet.
  for (const s of sessions) {
    if (needFor.has(s.id)) continue
    if (s.asking) {
      needs.push({ id: `ask:${s.id}`, kind: 'question', sessionId: s.id, callsign: s.callsign, label: s.title, text: s.asking.text, options: s.asking.options, since: s.activeAt, source: 'session' })
      needFor.add(s.id)
    } else if (s.state === 'failed') {
      needs.push({ id: `failed:${s.id}`, kind: 'failed', sessionId: s.id, callsign: s.callsign, label: s.title, text: s.lastLine ?? 'its last run failed', options: [], since: s.activeAt, source: 'session' })
      needFor.add(s.id)
    }
  }

  // T3 threads the board does not carry: requests waiting, runs that failed
  // and nobody has settled.
  for (const th of t3.threads.values()) {
    const sid = threadToSession.get(th.threadId)
    if (sid && needFor.has(sid)) continue
    const session = sid ? byId.get(sid) : undefined
    const base = { sessionId: session?.id ?? null, callsign: session?.callsign ?? null, label: th.title, options: [], since: null, source: 'T3' }
    if (th.pending > 0) needs.push({ ...base, id: `t3:${th.threadId}:pending`, kind: 'approval', text: `${th.pending} request${th.pending > 1 ? 's' : ''} waiting in T3` })
    else if (th.run && FAILED_RUNS.has(th.run) && !th.triaged && !th.native) needs.push({ ...base, id: `t3:${th.threadId}:${th.run}`, kind: 'failed', text: `T3 run ${th.run}` })
  }

  needs.sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity))

  return {
    fleet: { at: num(board.at) ?? now, sessions, needs, ledger: ledgerOf(board), usage: {
        todayUsd: extra.spend ?? { value: null, at: null, stale: false, note: 'spend was not read' },
        limits: office?.limits ?? { value: null, at: null, stale: false, note: "dashweb's office was not read" },
      }, warnings: [...warnings, ...ledgerWarnings(board)] },
    routes,
  }
}

const VERDICTS = new Set(['DONE', 'NEEDS SAM', 'FAILED'])

function ledgerOf(board: Obj): Ledger | null {
  const led = obj(board.ledger)
  if (!Object.keys(led).length) return null
  const ok = led.ok === true
  const rows: LedgerRow[] = arr(board.tasks)
    .map(obj)
    .map(t => {
      const v = str(t.verdict)
      return {
        task: str(t.task) ?? '?',
        repo: str(t.repoName) ?? str(t.repo) ?? '',
        status: clip(str(t.status) ?? ''),
        lastReport: clip(str(t.lastReport) ?? ''),
        verdict: v && VERDICTS.has(v) ? (v as LedgerRow['verdict']) : null,
        opened: str(t.opened) ?? '',
      }
    })
  const closed = arr(led.closed)
    .map(c => str(obj(c).text))
    .filter((t): t is string => Boolean(t))
    .map(t => clip(t, 160))
  return { ok, error: ok ? null : (str(led.error) ?? 'ledger unreadable'), changedAt: num(led.mtime) ?? num(led.lastGoodAt), rows, closed }
}

function ledgerWarnings(board: Obj): string[] {
  const reports = obj(obj(board.kanban).reports)
  const out: string[] = []
  if (!board.dispatcher) out.push('no dispatcher session is live')
  else if (str(reports.error)) out.push(`dispatcher reports: ${String(reports.error)}`)
  return out
}
