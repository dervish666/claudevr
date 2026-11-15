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

  constructor(cfg: DashwebConfig, deps: DashwebDeps = {}) {
    this.cfg = cfg
    this.fetch = deps.fetch ?? (globalThis.fetch as unknown as Fetcher)
    this.run = deps.run ?? runCommand
    this.log = deps.log ?? ((...a) => console.log('[dashweb]', ...a))
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
    const [board, t3, office] = await Promise.all([this.getJson('/api/board'), this.getJson('/api/t3').catch(asError), this.getJson('/api/state/office').catch(asError)])
    const { fleet, routes } = normalise(board, t3, Date.now(), { office, spend: this.stream.spend(), hideCwds: this.cfg.hideCwds })
    this.routes = routes
    return fleet
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
   * Queues `text` as the thread's next turn. Only a session the last read
   * routed to a T3 thread can be sent to; anything else is refused before
   * the CLI runs.
   */
  async send(id: string, text: string): Promise<SendResult> {
    if (typeof text !== 'string' || !text.trim()) throw new SendRefused('nothing to send', 400)
    if (text.length > SEND_MAX) throw new SendRefused(`at most ${SEND_MAX} characters`, 400)
    const threadId = this.routes.get(id)
    if (!threadId) throw new SendRefused(`no T3 thread to send to for session ${id.slice(0, 40)}`)
    // The thread id goes on the command line; one that looked like a flag would be read as one.
    if (!THREAD_ID.test(threadId)) throw new SendRefused('thread id is not one the CLI can take', 400)
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
