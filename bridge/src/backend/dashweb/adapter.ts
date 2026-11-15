// A SessionBackend over a dashweb install: reads its /api/board and /api/t3
// on a poll and sends through the T3 CLI, the way dashweb's own
// POST /api/t3/send does (`t3 thread send --base-dir <home> <threadId> -`,
// the text on stdin, execFile with arguments, never a shell).
//
// T3 CLI v0.1.9 has list, start, send and show. No interrupt, no approve, no
// way to answer a request, so those are declared unsupported. `show` gives
// a thread's latest messages in full, which is where transcripts come from;
// the board only carries short clips.
//
// Usage: the account's limits and each session's context come from
// GET /api/state/office, read with the board; today's spend only exists on
// dashweb's live stream, GET /api/sub/office, held open while anyone is
// subscribed (stream.ts).

import { execFile } from 'node:child_process'
import type { Fleet, Need, SessionTranscript, Turn } from '../../../../shared/protocol.ts'
import type { DashwebConfig } from '../../config.ts'
import { capabilities, Poller, SendRefused, UnsupportedError, type FleetUpdate, type SendResult, type SessionBackend } from '../types.ts'
import { normalise } from './normalise.ts'
import { OfficeStream, type StreamFetcher } from './stream.ts'
import { createHash, randomUUID } from 'node:crypto'
import { readT3Origin, T3Mcp, T3McpError, type Delivery } from '../t3mcp.ts'

/** The part of T3Mcp the adapter uses, so a test can stand in for it. */
export type T3Sender = Pick<T3Mcp, 'send' | 'linkState'>

/** What the HUD shows for each way T3 took a message. */
const DELIVERY_SAID: Record<Delivery, string> = {
  started: 'Started.',
  steered: 'Went straight in.',
  queued: 'Queued behind the current turn.',
  restarted: 'Restarted the turn with it.',
}

const FIX_LINK = 'Run npm run t3-link.'
/** The HUD warning for a send that fell back to the CLI, by why it fell back. */
function linkWarning(err: T3McpError): string {
  switch (err.kind) {
    case 'not-linked':
      return `Not linked to T3: messages will queue. ${FIX_LINK}`
    case 'expired':
      return `T3 link expired: messages will queue. ${FIX_LINK}`
    case 'denied':
      return `T3 link cannot send to that thread, probably approved below Full access: messages will queue. ${FIX_LINK}`
    default:
      return `T3's MCP endpoint did not answer (${err.message.slice(0, 120)}): messages will queue.`
  }
}

/** Runs a program with arguments and stdin; resolves stdout, rejects with stderr. */
export type CommandRunner = (file: string, args: string[], input: string, timeoutMs: number) => Promise<string>

export const runCommand: CommandRunner = (file, args, input, timeoutMs) =>
  new Promise((ok, fail) => {
    const child = execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return ok(String(stdout))
      const why = String(stderr || '').trim() || (err.killed ? `timed out after ${timeoutMs / 1000} s` : err.message)
      fail(new Error(why.slice(0, 400)))
    })
    // A CLI that exits before reading stdin breaks the pipe; its exit status says why.
    child.stdin?.on('error', err => console.error('send: stdin:', err.message))
    child.stdin?.end(input)
  })

export type Fetcher = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export interface DashwebDeps {
  fetch?: Fetcher
  /** For the live stream; the global fetch when not given. */
  streamFetch?: StreamFetcher
  run?: CommandRunner
  log?: (...a: unknown[]) => void
  /** Sends over T3's MCP endpoint; by default built from cfg.t3LinkFile. */
  t3mcp?: T3Sender
  /** The clock, for the route freshness check. */
  now?: () => number
}

export const SEND_MAX = 4000
const SEND_TIMEOUT_MS = 20_000
const FETCH_TIMEOUT_MS = 5_000
const SHOW_TIMEOUT_MS = 8_000
/** Characters kept per turn. A long reply is cut here and marked as cut. */
export const TURN_MAX = 12_000
export const TURNS_MAX = 20

/**
 * A thread id goes on the command line, so it must not start like a flag and
 * must hold nothing odd. T3 has more shapes than a bare UUID: a thread made
 * through its MCP tools is "mcp:<uuid>", and a delegated task's id carries
 * colons and percent signs.
 */
export const THREAD_ID = /^[0-9A-Za-z][\w:.%-]{0,199}$/

/**
 * A send needs a good fleet read at most this old (or three polls, if the
 * poll is slower). Past it, or after a failed read, the bridge cannot tell
 * whether the session behind a route is still there, so it does not send.
 */
export const ROUTES_FRESH_MS = 60_000

/**
 * T3's clientRequestId for a send. With the HUD's request id it is a UUID
 * made from it (the version 5 layout over SHA-1), so a retry of one card
 * reaches T3 under the same id even across a bridge restart; without one it
 * is a fresh random UUID, as before. Always UUID-shaped, the form T3 has
 * been given all along.
 */
export function t3RequestId(requestId?: string): string {
  if (!requestId) return randomUUID()
  const b = createHash('sha1').update(`claudevr send ${requestId}`).digest().subarray(0, 16)
  b[6] = (b[6]! & 0x0f) | 0x50
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export class DashwebAdapter implements SessionBackend {
  readonly name = 'dashweb'
  readonly capabilities = capabilities(['list', 'subscribe', 'send', 'pending', 'transcript'])
  private readonly cfg: DashwebConfig
  private readonly fetch: Fetcher
  private readonly run: CommandRunner
  private readonly log: (...a: unknown[]) => void
  private readonly poller: Poller
  private readonly stream: OfficeStream
  private routes = new Map<string, string>()
  /** When the routes were last confirmed by a good read, and why the latest read failed, if it did. */
  private routesAt: number | null = null
  private readFailed: string | null = null
  private readonly now: () => number
  /** Null when sends always go through the CLI (t3.delivery "queue", or no link file configured). */
  private readonly t3: T3Sender | null
  /** Why the last send fell back to the CLI; shown with the fleet until an MCP send works. */
  private t3Warning: string | null = null

  constructor(cfg: DashwebConfig, deps: DashwebDeps = {}) {
    this.cfg = cfg
    this.fetch = deps.fetch ?? (globalThis.fetch as unknown as Fetcher)
    this.run = deps.run ?? runCommand
    this.log = deps.log ?? ((...a) => console.log('[dashweb]', ...a))
    this.now = deps.now ?? Date.now
    const linkFile = cfg.t3LinkFile
    this.t3 =
      cfg.t3Delivery === 'queue'
        ? null
        : (deps.t3mcp ?? (linkFile ? new T3Mcp({ linkFile, origin: () => readT3Origin(cfg.t3BaseDir), log: (...a) => this.log('[t3mcp]', ...a) }) : null))
    if (this.t3?.linkState() === 'expired') this.setT3Warning(`T3 link expired: messages will queue. ${FIX_LINK}`)
    this.poller = new Poller(() => this.list(), cfg.pollMs, this.log)
    this.stream = new OfficeStream(`${cfg.url}/api/sub/office`, { fetch: deps.streamFetch ?? (globalThis.fetch as unknown as StreamFetcher), log: this.log })
  }

  private async getJson(path: string): Promise<unknown> {
    const url = `${this.cfg.url}${path}`
    let res
    try {
      res = await this.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    } catch (err) {
      throw new Error(`cannot reach dashweb at ${url}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok) throw new Error(`dashweb ${path} answered HTTP ${res.status}`)
    try {
      return await res.json()
    } catch (err) {
      throw new Error(`dashweb ${path} sent something that is not JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async list(): Promise<Fleet> {
    // The board is the fleet; without it there is nothing to show. T3 failing
    // only switches sends off, and the fleet says so.
    // The office only feeds usage figures: failing, they read as unavailable.
    const asError = (err: unknown) => (err instanceof Error ? err : new Error(String(err)))
    let read: ReturnType<typeof normalise>
    try {
      const [board, t3, office] = await Promise.all([this.getJson('/api/board'), this.getJson('/api/t3').catch(asError), this.getJson('/api/state/office').catch(asError)])
      read = normalise(board, t3, this.now(), { office, spend: this.stream.spend(), hideCwds: this.cfg.hideCwds })
    } catch (err) {
      // The routes from the last good read stay, but sends refuse them until a read works again.
      this.readFailed = asError(err).message
      throw err
    }
    const { fleet, routes } = read
    this.routes = routes
    this.routesAt = this.now()
    this.readFailed = null
    if (this.t3Warning) fleet.warnings.push(this.t3Warning)
    return fleet
  }

  /** Why the routes cannot be trusted right now, or null when a recent read confirmed them. */
  private routesDoubt(): string | null {
    if (this.readFailed) return `the last fleet read failed (${this.readFailed.slice(0, 160)})`
    if (this.routesAt === null) return 'the fleet has not been read yet'
    const age = this.now() - this.routesAt
    if (age > Math.max(ROUTES_FRESH_MS, 3 * this.cfg.pollMs)) return `the last good fleet read is ${Math.round(age / 1000)} s old`
    return null
  }

  /** Logs a change of warning once, not on every send. */
  private setT3Warning(w: string | null): void {
    if (w === this.t3Warning) return
    this.log(w ? `sends fall back to the T3 CLI: ${w}` : 'T3 link working again: sends go over MCP')
    this.t3Warning = w
  }

  subscribe(listener: (u: FleetUpdate) => void): () => void {
    this.stream.start()
    const off = this.poller.subscribe(listener)
    return () => {
      off()
      // The poller stops with its last listener; the stream goes with it.
      if (!this.poller.active) this.stream.stop()
    }
  }

  /**
   * Delivers `text` to the thread. With a T3 link it goes over MCP in "auto"
   * mode: an idle thread starts, a running turn takes it at once. Without a
   * usable link the CLI queues it as the next turn. Only a session the last
   * read routed to a T3 thread can be sent to, and only while that read is
   * recent and the latest one worked; anything else is refused before either
   * runs.
   */
  async send(id: string, text: string, requestId?: string): Promise<SendResult> {
    if (typeof text !== 'string' || !text.trim()) throw new SendRefused('nothing to send', 400)
    if (text.length > SEND_MAX) throw new SendRefused(`at most ${SEND_MAX} characters`, 400)
    const threadId = this.routes.get(id)
    if (!threadId) throw new SendRefused(`no T3 thread to send to for session ${id.slice(0, 40)}`)
    const doubt = this.routesDoubt()
    // 409, not a 5xx: the HUD reads a 5xx other than 501 and 502 as "may have been delivered", and this one surely was not.
    if (doubt) throw new SendRefused(`cannot confirm the session is still there: ${doubt}. Nothing was sent.`, 409)
    // The thread id goes on the command line; one that looked like a flag would be read as one.
    if (!THREAD_ID.test(threadId)) throw new SendRefused('thread id is not one the CLI can take', 400)
    if (this.t3) {
      try {
        const r = await this.t3.send(threadId, text, t3RequestId(requestId))
        this.setT3Warning(null)
        this.log('sent', text.length, 'chars to thread', threadId, 'over T3 MCP:', r.delivery)
        return { ok: true, said: DELIVERY_SAID[r.delivery] }
      } catch (err) {
        // A send that may have landed is never repeated through the CLI: the message could arrive twice.
        if (!(err instanceof T3McpError) || err.maybeDelivered) {
          const why = err instanceof Error ? err.message : String(err)
          throw new Error(`not known whether T3 got the message (${why}). Check the thread before sending again.`)
        }
        // T3 read the send and refused it; the CLI would be refused the same
        // way. A refusal, so nothing went out and a retry may try again.
        if (err.kind === 'tool') throw new SendRefused(err.message, 502)
        this.setT3Warning(linkWarning(err))
      }
    }
    const said = await this.run(this.cfg.t3Bin, ['thread', 'send', '--base-dir', this.cfg.t3BaseDir, threadId, '-'], text, SEND_TIMEOUT_MS)
    this.log('sent', text.length, 'chars to thread', threadId)
    return { ok: true, said: said.trim().slice(0, 500) }
  }

  /**
   * The thread's latest messages from `t3 thread show --json`. Only a session
   * the last read routed to a T3 thread has one; the caller falls back to the
   * board's short clips for the rest.
   */
  async transcript(id: string, limit: number): Promise<SessionTranscript> {
    const threadId = this.routes.get(id)
    if (!threadId) throw new SendRefused(`no T3 thread behind session ${id.slice(0, 40)}, so no full transcript`)
    if (!THREAD_ID.test(threadId)) throw new SendRefused('thread id is not one the CLI can take', 400)
    const n = Math.min(TURNS_MAX, Math.max(1, Math.floor(limit) || 1))
    const out = await this.run(this.cfg.t3Bin, ['thread', 'show', '--base-dir', this.cfg.t3BaseDir, '--json', '--messages', String(n), threadId], '', SHOW_TIMEOUT_MS)
    let parsed: unknown
    try {
      parsed = JSON.parse(out)
    } catch (err) {
      throw new Error(`t3 thread show did not print JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
    const messages = (parsed as { messages?: unknown } | null)?.messages
    if (!Array.isArray(messages)) throw new Error('t3 thread show printed no messages list')
    const turns: Turn[] = []
    for (const m of messages as Array<{ role?: unknown; text?: unknown }>) {
      const text = typeof m?.text === 'string' ? m.text.trim() : ''
      if (!text) continue
      const role: Turn['role'] = m.role === 'user' ? 'you' : m.role === 'assistant' ? 'session' : 'other'
      turns.push({ role, text: text.length > TURN_MAX ? `${text.slice(0, TURN_MAX)}…` : text, clipped: text.length > TURN_MAX })
    }
    return { sessionId: id, at: Date.now(), turns: turns.slice(-n) }
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
    this.stream.stop()
  }
}
