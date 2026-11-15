// A small client for T3 Code's own MCP endpoint (POST <origin>/mcp, Streamable
// HTTP: JSON-RPC over POST, each reply either JSON or a short event stream).
// It exists for one call: t3_thread_send with mode "auto", which starts an
// idle thread or goes straight into a running turn. The T3 CLI can only
// queue. Written on fetch, not the MCP SDK: the handshake is three POSTs and
// the bridge needs to know exactly when a request may have reached T3.
//
// The bearer token comes from <state dir>/t3-link.json, made by
// `npm run t3-link`. It goes in the Authorization header and nowhere else:
// no error message, log line or return value of this module carries it.

import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { THREAD_ID } from './dashweb/adapter.ts'

/** The MCP revision T3's own client speaks (AcpMcpStdioBridge in the app bundle). */
export const MCP_PROTOCOL_VERSION = '2025-06-18'
const INIT_TIMEOUT_MS = 5_000
const CALL_TIMEOUT_MS = 15_000
const END_TIMEOUT_MS = 2_000

export type Delivery = 'started' | 'queued' | 'steered' | 'restarted'
const DELIVERIES: readonly Delivery[] = ['started', 'queued', 'steered', 'restarted']

/**
 * - not-linked: no link file, or one the bridge cannot use
 * - expired: the link's expiry has passed, or T3 answered 401 or 403
 * - unreachable: T3 could not be reached before the send went out
 * - denied: T3 refused this link for this thread (approved below the thread's mode)
 * - tool: T3 refused the send itself, with its reason
 * - timeout: no answer in time
 * - unknown: the send went out and what happened to it is not known
 */
export type T3FailureKind = 'not-linked' | 'expired' | 'unreachable' | 'denied' | 'tool' | 'timeout' | 'unknown'

export class T3McpError extends Error {
  readonly kind: T3FailureKind
  /**
   * True once the tools/call request may have reached T3 without a clear
   * answer. A send that may have landed must not be retried another way, or
   * the message could arrive twice.
   */
  readonly maybeDelivered: boolean
  constructor(kind: T3FailureKind, message: string, maybeDelivered = false) {
    super(message)
    this.name = 'T3McpError'
    this.kind = kind
    this.maybeDelivered = maybeDelivered
  }
}

/** What <state dir>/t3-link.json holds. */
export interface T3Link {
  version: 1
  /** T3's origin when the link was made; the runtime file wins when it is readable. */
  origin: string
  clientId: string
  clientName: string
  accessToken: string
  scope: string
  /** ISO time. */
  linkedAt: string
  /** ISO time, or null when T3 gave no lifetime. */
  expiresAt: string | null
}

export const LINK_FILE = 't3-link.json'
export const linkFileIn = (stateDir: string) => join(stateDir, LINK_FILE)

/** The link in `file`, or null when there is none. A file that is there but unusable throws not-linked. */
export function readLink(file: string): T3Link | null {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new T3McpError('not-linked', `cannot read the T3 link file ${file}: ${(err as Error).message}`)
  }
  let d: Partial<T3Link>
  try {
    d = JSON.parse(raw) as Partial<T3Link>
  } catch (err) {
    // The parser's message can quote the file's text, which holds the token, so it is not passed on.
    throw new T3McpError('not-linked', `the T3 link file ${file} is not JSON (${(err as Error).name}); run npm run t3-link again`)
  }
  const ok =
    d?.version === 1 &&
    typeof d.origin === 'string' &&
    typeof d.clientId === 'string' &&
    typeof d.accessToken === 'string' &&
    d.accessToken.length > 0 &&
    typeof d.linkedAt === 'string' &&
    (d.expiresAt === null || typeof d.expiresAt === 'string')
  if (!ok) throw new T3McpError('not-linked', `the T3 link file ${file} is not one this bridge wrote; run npm run t3-link again`)
  return { version: 1, origin: d.origin!, clientId: d.clientId!, clientName: String(d.clientName ?? ''), accessToken: d.accessToken!, scope: String(d.scope ?? ''), linkedAt: d.linkedAt!, expiresAt: d.expiresAt ?? null }
}

/** Writes the link readable by the owner only, through a temporary file so a half-written token never sits under the real name. */
export function writeLink(file: string, link: T3Link): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(link, null, 2) + '\n', { mode: 0o600 })
  // The mode given to writeFileSync is masked by the umask and ignored for an existing file.
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
}

/** Deletes the link; false when there was none. */
export function removeLink(file: string): boolean {
  try {
    unlinkSync(file)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

export const linkExpired = (link: T3Link, now = Date.now()) => link.expiresAt !== null && Date.parse(link.expiresAt) <= now

/** T3's origin from <base dir>/userdata/server-runtime.json, the file the T3 CLI reads to find its server. */
export function readT3Origin(t3BaseDir: string): string {
  const file = join(t3BaseDir, 'userdata', 'server-runtime.json')
  let d: { origin?: unknown }
  try {
    d = JSON.parse(readFileSync(file, 'utf8')) as { origin?: unknown }
  } catch (err) {
    throw new Error(`cannot read T3's runtime file ${file}: ${(err as Error).message}. Is T3 Code running?`)
  }
  const origin = typeof d.origin === 'string' ? d.origin : ''
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    throw new Error(`${file} names no origin`)
  }
  // The token is only ever sent to T3 on this machine.
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error(`${file} names ${url.origin}, which is not a loopback address`)
  return url.origin
}

export type McpFetch = (url: string, init: RequestInit) => Promise<Response>

export interface T3McpOptions {
  /** <state dir>/t3-link.json. */
  linkFile: string
  /** T3's current origin; by default the link's own. */
  origin?: () => string
  fetch?: McpFetch
  log?: (...a: unknown[]) => void
  initTimeoutMs?: number
  callTimeoutMs?: number
}

export interface T3SendResult {
  delivery: Delivery
  runId: string
}

type Phase = 'initialize' | 'call'

/** Connection errors that mean the request never left this machine. */
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'UND_ERR_CONNECT_TIMEOUT'])
/** T3 failure codes that refuse the caller before anything is dispatched. */
const DENIED = new Set(['capability_denied', 'runtime_mode_escalation_denied', 'interaction_mode_escalation_denied'])

const causeCode = (err: unknown): string => {
  const c = (err as { cause?: { code?: unknown } } | null)?.cause?.code
  return typeof c === 'string' ? c : ''
}

export class T3Mcp {
  private readonly linkFile: string
  private readonly origin?: () => string
  private readonly fetch: McpFetch
  private readonly log: (...a: unknown[]) => void
  private readonly initTimeoutMs: number
  private readonly callTimeoutMs: number

  constructor(o: T3McpOptions) {
    this.linkFile = o.linkFile
    this.origin = o.origin
    this.fetch = o.fetch ?? ((url, init) => globalThis.fetch(url, init))
    this.log = o.log ?? ((...a) => console.log('[t3mcp]', ...a))
    this.initTimeoutMs = o.initTimeoutMs ?? INIT_TIMEOUT_MS
    this.callTimeoutMs = o.callTimeoutMs ?? CALL_TIMEOUT_MS
  }

  /** What a send would find right now, without asking T3. */
  linkState(now = Date.now()): 'none' | 'expired' | 'ok' | 'broken' {
    try {
      const link = readLink(this.linkFile)
      return link === null ? 'none' : linkExpired(link, now) ? 'expired' : 'ok'
    } catch (err) {
      this.log('T3 link unusable:', (err as Error).message)
      return 'broken'
    }
  }

  /**
   * Sends `text` to `threadId` with t3_thread_send, mode "auto", exactly as
   * given. This is the only tool and the only mode this client calls.
   */
  async send(threadId: string, text: string, clientRequestId: string): Promise<T3SendResult> {
    if (!THREAD_ID.test(threadId)) throw new T3McpError('tool', 'thread id is not one T3 can take')
    const link = readLink(this.linkFile)
    if (!link) throw new T3McpError('not-linked', 'not linked to T3')
    if (linkExpired(link)) throw new T3McpError('expired', `the T3 link expired at ${link.expiresAt}`)
    let origin = link.origin
    if (this.origin) {
      try {
        origin = this.origin()
      } catch (err) {
        // T3 writes the runtime file at start; without it the origin saved with the link is the best guess.
        this.log('using the origin saved with the link:', (err as Error).message)
      }
    }
    const session = new Session(`${origin}/mcp`, link.accessToken, this.fetch)
    try {
      await session.request('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'claudevr-bridge', version: '0.1.0' } }, 'initialize', this.initTimeoutMs)
      await session.notify('notifications/initialized', this.initTimeoutMs)
      const result = await session.request('tools/call', { name: 't3_thread_send', arguments: { threadId, message: text, mode: 'auto', clientRequestId } }, 'call', this.callTimeoutMs)
      return readSendResult(result)
    } finally {
      session.end(END_TIMEOUT_MS).catch(err => this.log('could not end the MCP session:', (err as Error).message))
    }
  }
}

/** One initialized MCP session: carries Mcp-Session-Id and the protocol version once T3 gives them. */
class Session {
  private sessionId: string | null = null
  private protocolVersion: string | null = null
  private nextId = 1
  private readonly endpoint: string
  private readonly token: string
  private readonly fetch: McpFetch

  constructor(endpoint: string, token: string, fetch: McpFetch) {
    this.endpoint = endpoint
    this.token = token
    this.fetch = fetch
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${this.token}`,
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      ...(this.protocolVersion ? { 'mcp-protocol-version': this.protocolVersion } : {}),
    }
  }

  /** POSTs one message. Every failure is a T3McpError that says whether the send may have landed. */
  private async post(body: unknown, phase: Phase, timeoutMs: number): Promise<{ res: Response; signal: AbortSignal }> {
    const signal = AbortSignal.timeout(timeoutMs)
    let res: Response
    try {
      res = await this.fetch(this.endpoint, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal })
    } catch (err) {
      const e = err as Error
      const code = causeCode(err)
      if (e.name === 'TimeoutError' || signal.aborted) throw new T3McpError('timeout', `T3 did not answer ${phase === 'call' ? 'the send' : 'the MCP handshake'} within ${timeoutMs / 1000} s`, phase === 'call')
      if (phase === 'initialize' || NOT_SENT.has(code)) throw new T3McpError('unreachable', `cannot reach T3 at ${this.endpoint}: ${code || e.message}`)
      // The connection broke after the request may have been written.
      throw new T3McpError('unknown', `the connection to T3 broke during the send: ${code || e.message}`, true)
    }
    this.sessionId = res.headers.get('mcp-session-id') ?? this.sessionId
    if (res.ok) return { res, signal }
    await res.body?.cancel().catch(() => undefined)
    if (res.status === 401 || res.status === 403) throw new T3McpError('expired', `T3 refused the link (HTTP ${res.status})`)
    // 404 on a request that names a session means T3 dropped the session before acting on it.
    if (res.status === 404 && this.sessionId) throw new T3McpError('unreachable', 'T3 no longer knows this MCP session')
    if (res.status >= 500 && phase === 'call') throw new T3McpError('unknown', `T3 answered the send with HTTP ${res.status}`, true)
    // Before the send goes out, any other refusal only means MCP is not usable now.
    if (phase === 'initialize') throw new T3McpError('unreachable', `T3's MCP endpoint answered HTTP ${res.status}`)
    throw new T3McpError('tool', `T3's MCP endpoint answered HTTP ${res.status}`)
  }

  async request(method: string, params: unknown, phase: Phase, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++
    const { res, signal } = await this.post({ jsonrpc: '2.0', id, method, params }, phase, timeoutMs)
    let envelope: Record<string, unknown> | null
    try {
      envelope = await readReply(res, id, signal)
    } catch (err) {
      const timedOut = (err as Error).name === 'TimeoutError' || signal.aborted
      if (phase === 'initialize') throw new T3McpError(timedOut ? 'timeout' : 'unreachable', `T3's MCP handshake failed: ${timedOut ? 'no answer in time' : (err as Error).message}`)
      throw new T3McpError(timedOut ? 'timeout' : 'unknown', `T3 took the send but its answer ${timedOut ? 'did not arrive in time' : `could not be read: ${(err as Error).message}`}`, true)
    }
    if (!envelope) {
      if (phase === 'initialize') throw new T3McpError('unreachable', 'T3 sent no answer to the MCP handshake')
      throw new T3McpError('unknown', 'T3 took the send but gave no answer to it', true)
    }
    if (envelope.error !== undefined) {
      const msg = (envelope.error as { message?: unknown } | null)?.message
      throw new T3McpError(phase === 'initialize' ? 'unreachable' : 'tool', `T3 ${method} failed: ${String(typeof msg === 'string' ? msg : 'no reason given').slice(0, 300)}`)
    }
    if (method === 'initialize') {
      const v = (envelope.result as { protocolVersion?: unknown } | null)?.protocolVersion
      if (typeof v === 'string' && v) this.protocolVersion = v
    }
    return envelope.result
  }

  async notify(method: string, timeoutMs: number): Promise<void> {
    const { res } = await this.post({ jsonrpc: '2.0', method }, 'initialize', timeoutMs)
    await res.body?.cancel().catch(() => undefined)
  }

  /** Ends the session on T3's side, as T3's own client does. */
  async end(timeoutMs: number): Promise<void> {
    if (!this.sessionId) return
    const res = await this.fetch(this.endpoint, { method: 'DELETE', headers: this.headers(), signal: AbortSignal.timeout(timeoutMs) })
    await res.body?.cancel().catch(() => undefined)
  }
}

/** The JSON-RPC reply with `id`, from a JSON body or an event stream; null when there is none. */
async function readReply(res: Response, id: number, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  const type = (res.headers.get('content-type') ?? '').toLowerCase()
  const pick = (v: unknown): Record<string, unknown> | null => {
    for (const m of Array.isArray(v) ? v : [v]) if (m && typeof m === 'object' && (m as { id?: unknown }).id === id) return m as Record<string, unknown>
    return null
  }
  if (type.includes('text/event-stream')) return readEventStream(res, pick, signal)
  const text = await res.text()
  if (!text.trim()) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`the reply is not JSON (${type || 'no content type'})`)
  }
  return pick(parsed)
}

/** Reads events until one carries the reply, then stops reading. */
async function readEventStream(res: Response, pick: (v: unknown) => Record<string, unknown> | null, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  if (!res.body) return null
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let data: string[] = []
  const onEvent = (): Record<string, unknown> | null => {
    if (!data.length) return null
    const joined = data.join('\n')
    data = []
    try {
      return pick(JSON.parse(joined))
    } catch {
      // An event that is not JSON-RPC (a comment, a keep-alive) is not the reply; keep reading.
      return null
    }
  }
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('timed out')
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (line === '') {
          const found = onEvent()
          if (found) return found
        } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
    }
    if (buf.startsWith('data:')) data.push(buf.slice(5).replace(/^ /, ''))
    return onEvent()
  } finally {
    reader.cancel().catch(() => undefined)
  }
}

/** t3_thread_send's result: structuredContent, or the same JSON as text. Its failure is JSON text with code and message. */
function readSendResult(result: unknown): T3SendResult {
  const r = (result ?? {}) as { isError?: unknown; structuredContent?: unknown; content?: unknown }
  const textPart = Array.isArray(r.content) ? (r.content as Array<{ text?: unknown }>).find(p => typeof p?.text === 'string')?.text : undefined
  const asJson = (s: unknown): Record<string, unknown> | null => {
    if (typeof s !== 'string') return null
    try {
      const v: unknown = JSON.parse(s)
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  if (r.isError === true) {
    const f = asJson(textPart)
    const code = typeof f?.code === 'string' ? f.code : ''
    const message = (typeof f?.message === 'string' ? f.message : typeof textPart === 'string' ? textPart : 'no reason given').slice(0, 400)
    throw new T3McpError(DENIED.has(code) ? 'denied' : 'tool', `T3 refused the send${code ? ` (${code})` : ''}: ${message}`)
  }
  const body = (r.structuredContent && typeof r.structuredContent === 'object' ? r.structuredContent : asJson(textPart)) as { delivery?: unknown; runId?: unknown } | null
  const delivery = body?.delivery
  if (typeof delivery !== 'string' || !DELIVERIES.includes(delivery as Delivery)) throw new T3McpError('unknown', 'T3 accepted the send but its answer does not say how it was delivered', true)
  return { delivery: delivery as Delivery, runId: typeof body?.runId === 'string' ? body.runId : '' }
}
