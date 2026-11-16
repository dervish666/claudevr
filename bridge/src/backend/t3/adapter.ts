// A SessionBackend over T3 Code alone: no dashweb, no CLI. It reads the
// fleet with T3's own MCP tools (t3_thread_list, t3_project_list and, for a
// few live threads, t3_thread_read) on a poll, and sends with t3_thread_send
// in "auto" mode, all through the link `npm run t3-link` makes.
//
// T3 reports no spend, no usage limits and no context use, so those read as
// unavailable. Answering a request, approving and interrupting are left out.

import type { Fleet, Need, SessionTranscript } from '../../../../shared/protocol.ts'
import type { T3Config } from '../../config.ts'
import { capabilities, Poller, SendRefused, UnsupportedError, type FleetUpdate, type SendResult, type SessionBackend } from '../types.ts'
import { DELIVERY_SAID, ROUTES_FRESH_MS, SEND_MAX, THREAD_ID, TURN_MAX, TURNS_MAX, t3RequestId } from '../dashweb/adapter.ts'
import { readT3Origin, T3Mcp, T3McpError, type ReadCall } from '../t3mcp.ts'
import { LIVE_STATUSES, normaliseT3, projectPage, tailOf, threadPage, turnsOf, type T3ThreadRow, type ThreadTail } from './normalise.ts'

/** The part of T3Mcp the adapter uses, so a test can stand in for it. */
export type T3Client = Pick<T3Mcp, 'send' | 'reads' | 'linkState'>

const FIX_LINK = 'Run npm run t3-link.'
const PAGE = 100
/** Pages of the thread list read per poll at most; the list is newest first, so this only bites on a very busy day. */
const PAGES_MAX = 5
const PROJECTS_TTL_MS = 60_000
const PROJECT_PAGES_MAX = 5
/** Live threads whose latest messages are read per poll, and how often one is read again while it keeps changing. */
const TAILS_PER_POLL = 4
const TAIL_EVERY_MS = 10_000
/** Timeline positions a tail read looks back over. Tool calls take positions too, so a few messages need a few dozen. */
const TAIL_WINDOW = 40
const TAIL_CHARS = 400
/** A transcript read starts this many positions before the end and pages forward. */
const TRANSCRIPT_WINDOW = 200
const TRANSCRIPT_PAGE = 50
const TRANSCRIPT_PAGES_MAX = 6

/** Why T3 cannot be used, in words for the HUD, with the fix when there is one. */
export function linkProblem(err: T3McpError): string {
  switch (err.kind) {
    case 'not-linked':
      return `Not linked to T3 (${err.message}). ${FIX_LINK}`
    case 'expired':
      return `T3 link expired or refused (${err.message}). ${FIX_LINK}`
    case 'denied':
      return `T3 link cannot reach that thread, probably approved below Full access. ${FIX_LINK}`
    default:
      return `T3 did not answer: ${err.message}`
  }
}

export interface T3Deps {
  /** Reads and sends over T3's MCP endpoint; by default built from cfg.t3LinkFile. */
  t3mcp?: T3Client
  log?: (...a: unknown[]) => void
  /** The clock, for the route freshness check and the activity window. */
  now?: () => number
}

export class T3Adapter implements SessionBackend {
  readonly name = 't3'
  readonly capabilities = capabilities(['list', 'subscribe', 'send', 'pending', 'transcript'])
  private readonly cfg: T3Config
  private readonly t3: T3Client
  private readonly log: (...a: unknown[]) => void
  private readonly now: () => number
  private readonly poller: Poller
  private routes = new Map<string, string>()
  private itemCounts = new Map<string, number>()
  private routesAt: number | null = null
  private readFailed: string | null = null
  private projects = new Map<string, string>()
  private projectsAt: number | null = null
  private tails = new Map<string, { tail: ThreadTail; updatedAt: number | null; readAt: number }>()
  /** Why the last send was refused by the link; on the fleet until a send works. */
  private sendWarning: string | null = null
  private lastCount: string | null = null

  constructor(cfg: T3Config, deps: T3Deps = {}) {
    this.cfg = cfg
    this.log = deps.log ?? ((...a) => console.log('[t3]', ...a))
    this.now = deps.now ?? Date.now
    this.t3 = deps.t3mcp ?? new T3Mcp({ linkFile: cfg.t3LinkFile, origin: () => readT3Origin(cfg.t3BaseDir), log: (...a) => this.log('[t3mcp]', ...a) })
    this.poller = new Poller(() => this.list(), cfg.pollMs, this.log)
  }

  async list(): Promise<Fleet> {
    let read: ReturnType<typeof normaliseT3>
    try {
      read = await this.t3.reads(call => this.readFleet(call))
    } catch (err) {
      // The routes from the last good read stay, but sends refuse them until a read works again.
      const msg = err instanceof T3McpError ? linkProblem(err) : err instanceof Error ? err.message : String(err)
      this.readFailed = msg
      throw new Error(msg)
    }
    this.routes = read.routes
    this.itemCounts = read.itemCounts
    this.routesAt = this.now()
    this.readFailed = null
    if (this.sendWarning) read.fleet.warnings.push(this.sendWarning)
    const count = `${read.fleet.sessions.length} sessions, ${read.fleet.needs.length} needs`
    if (count !== this.lastCount) this.log('fleet:', count)
    this.lastCount = count
    return read.fleet
  }

  private async readFleet(call: ReadCall): Promise<ReturnType<typeof normaliseT3>> {
    const now = this.now()
    const activeSince = now - this.cfg.activeHours * 3_600_000
    const warnings: string[] = []

    // Newest first; stop at the first page that ends before the window.
    const threads: T3ThreadRow[] = []
    let cursor: number | null = 0
    for (let page = 0; cursor !== null && page < PAGES_MAX; page++) {
      const p = threadPage(await call('t3_thread_list', { allProjects: true, includeSubagents: true, settled: false, limit: PAGE, ...(cursor ? { cursor } : {}) }))
      threads.push(...p.threads)
      cursor = p.nextCursor
      const last = p.threads.at(-1)
      if (!last || (last.updatedAt ?? 0) < activeSince) cursor = null
      else if (page === PAGES_MAX - 1 && cursor !== null) warnings.push(`T3 has more than ${PAGES_MAX * PAGE} threads changed in the last ${this.cfg.activeHours} h; the oldest are not shown`)
    }
    // A thread waiting on the person, or running, for longer than the window still shows.
    const live = threadPage(await call('t3_thread_list', { allProjects: true, includeSubagents: false, settled: false, limit: PAGE, statuses: [...LIVE_STATUSES] }))
    threads.push(...live.threads)

    await this.readProjects(call, now, warnings)
    await this.readTails(call, threads, now, activeSince)

    return normaliseT3({ threads, projects: this.projects, tails: new Map([...this.tails].map(([k, v]) => [k, v.tail])), canSend: true, activeSince, warnings }, now)
  }

  /** Project names, kept for a minute. A failed read keeps the old names and says so. */
  private async readProjects(call: ReadCall, now: number, warnings: string[]): Promise<void> {
    if (this.projectsAt !== null && now - this.projectsAt < PROJECTS_TTL_MS) return
    try {
      const names = new Map<string, string>()
      let cursor: number | null = 0
      for (let page = 0; cursor !== null && page < PROJECT_PAGES_MAX; page++) {
        const p = projectPage(await call('t3_project_list', { limit: PAGE, ...(cursor ? { cursor } : {}) }))
        for (const [k, v] of p.names) names.set(k, v)
        cursor = p.nextCursor
      }
      this.projects = names
      this.projectsAt = now
    } catch (err) {
      // An unreachable T3 fails the whole read, as it should; only a bad answer to this one call is let through.
      if (err instanceof T3McpError && err.kind !== 'tool') throw err
      warnings.push(`T3 project names not readable: ${(err as Error).message.slice(0, 160)}`)
    }
  }

  /** The latest messages of a few live top-level threads, re-read only when they changed and not more than every TAIL_EVERY_MS. */
  private async readTails(call: ReadCall, threads: T3ThreadRow[], now: number, activeSince: number): Promise<void> {
    const wanted = new Map<string, T3ThreadRow>()
    for (const t of threads) if (!t.subagent && !t.snoozed && (LIVE_STATUSES.has(t.status) || (t.updatedAt ?? 0) >= activeSince)) wanted.set(t.threadId, t)
    // Forget threads that left the fleet.
    for (const id of this.tails.keys()) if (!wanted.has(id)) this.tails.delete(id)
    const due = [...wanted.values()]
      .filter(t => LIVE_STATUSES.has(t.status))
      .filter(t => {
        const kept = this.tails.get(t.threadId)
        return !kept || (kept.updatedAt !== t.updatedAt && now - kept.readAt >= TAIL_EVERY_MS)
      })
      .sort((a, b) => (this.tails.get(a.threadId)?.readAt ?? 0) - (this.tails.get(b.threadId)?.readAt ?? 0))
      .slice(0, TAILS_PER_POLL)
    for (const t of due) {
      try {
        const raw = await call('t3_thread_read', { threadId: t.threadId, view: 'messages', afterPosition: Math.max(0, t.itemCount - TAIL_WINDOW), limit: TAIL_WINDOW, maxCharsPerItem: TAIL_CHARS, runLimit: 1 })
        this.tails.set(t.threadId, { tail: tailOf(raw), updatedAt: t.updatedAt, readAt: now })
      } catch (err) {
        if (err instanceof T3McpError && err.kind !== 'tool') throw err
        // One thread T3 will not read leaves that card without a last line; the rest of the fleet still loads.
        this.log('could not read the latest messages of', t.threadId.slice(0, 60), (err as Error).message)
        this.tails.set(t.threadId, { tail: { messages: [] }, updatedAt: t.updatedAt, readAt: now })
      }
    }
  }

  /** Why the routes cannot be trusted right now, or null when a recent read confirmed them. */
  private routesDoubt(): string | null {
    if (this.readFailed) return `the last fleet read failed (${this.readFailed.slice(0, 160)})`
    if (this.routesAt === null) return 'the fleet has not been read yet'
    const age = this.now() - this.routesAt
    if (age > Math.max(ROUTES_FRESH_MS, 3 * this.cfg.pollMs)) return `the last good fleet read is ${Math.round(age / 1000)} s old`
    return null
  }

  private setSendWarning(w: string | null): void {
    if (w === this.sendWarning) return
    this.log(w ? `sends refused: ${w}` : 'T3 sends working again')
    this.sendWarning = w
  }

  subscribe(listener: (u: FleetUpdate) => void): () => void {
    return this.poller.subscribe(listener)
  }

  /**
   * Delivers `text` with t3_thread_send in "auto" mode. Only a session the
   * last read listed can be sent to, and only while that read is recent and
   * the latest one worked. A send that may have reached T3 is reported as
   * unknown and never retried here.
   */
  async send(id: string, text: string, requestId?: string): Promise<SendResult> {
    if (typeof text !== 'string' || !text.trim()) throw new SendRefused('nothing to send', 400)
    if (text.length > SEND_MAX) throw new SendRefused(`at most ${SEND_MAX} characters`, 400)
    const threadId = this.routes.get(id)
    if (!threadId) throw new SendRefused(`no T3 thread to send to for session ${id.slice(0, 40)}`)
    const doubt = this.routesDoubt()
    // 409, not a 5xx: the HUD reads a 5xx other than 501 and 502 as "may have been delivered", and this one surely was not.
    if (doubt) throw new SendRefused(`cannot confirm the session is still there: ${doubt}. Nothing was sent.`, 409)
    if (!THREAD_ID.test(threadId)) throw new SendRefused('thread id is not one T3 can take', 400)
    try {
      const r = await this.t3.send(threadId, text, t3RequestId(requestId))
      this.setSendWarning(null)
      this.log('sent', text.length, 'chars to thread', threadId, 'over T3 MCP:', r.delivery)
      return { ok: true, said: DELIVERY_SAID[r.delivery] }
    } catch (err) {
      if (!(err instanceof T3McpError) || err.maybeDelivered) {
        const why = err instanceof Error ? err.message : String(err)
        throw new Error(`not known whether T3 got the message (${why}). Check the thread before sending again.`)
      }
      if (err.kind === 'not-linked' || err.kind === 'expired' || err.kind === 'denied') {
        const w = linkProblem(err)
        this.setSendWarning(w)
        throw new SendRefused(`${w} Nothing was sent.`, 502)
      }
      // T3 read the send and refused it, or could not be reached before it went out: nothing was sent.
      throw new SendRefused(err.kind === 'tool' ? err.message : `${linkProblem(err)} Nothing was sent.`, 502)
    }
  }

  /** The thread's last turns, from t3_thread_read's messages view, read from near the end forward. */
  async transcript(id: string, limit: number): Promise<SessionTranscript> {
    const threadId = this.routes.get(id) ?? (this.itemCounts.has(id) ? id : null)
    if (!threadId) throw new SendRefused(`no T3 thread behind session ${id.slice(0, 40)}, so no full transcript`)
    if (!THREAD_ID.test(threadId)) throw new SendRefused('thread id is not one T3 can take', 400)
    const n = Math.min(TURNS_MAX, Math.max(1, Math.floor(limit) || 1))
    const itemCount = this.itemCounts.get(id) ?? 0
    let turns: ReturnType<typeof turnsOf> = []
    try {
      turns = await this.t3.reads(async call => {
        const out: ReturnType<typeof turnsOf> = []
        let after = Math.max(0, itemCount - TRANSCRIPT_WINDOW)
        for (let page = 0; page < TRANSCRIPT_PAGES_MAX; page++) {
          const raw = await call('t3_thread_read', { threadId, view: 'messages', ...(after > 0 ? { afterPosition: after } : {}), limit: TRANSCRIPT_PAGE, maxCharsPerItem: TURN_MAX, runLimit: 1 })
          out.push(...turnsOf(raw))
          const next = typeof raw.nextPosition === 'number' ? raw.nextPosition : null
          if (raw.hasMore !== true || next === null || next <= after) break
          after = next
          // Only the last n are kept, so a long page run holds no more than that.
          if (out.length > n) out.splice(0, out.length - n)
        }
        return out
      })
    } catch (err) {
      if (err instanceof T3McpError) throw new Error(linkProblem(err))
      throw err
    }
    return { sessionId: id, at: this.now(), turns: turns.slice(-n) }
  }

  async pending(): Promise<Need[]> {
    return (await this.list()).needs
  }

  interrupt(): Promise<void> {
    return Promise.reject(new UnsupportedError(this.name, 'interrupt'))
  }
  respond(): Promise<void> {
    return Promise.reject(new UnsupportedError(this.name, 'respond'))
  }
  approve(): Promise<void> {
    return Promise.reject(new UnsupportedError(this.name, 'approve'))
  }

  close(): void {
    this.poller.stop()
  }
}
