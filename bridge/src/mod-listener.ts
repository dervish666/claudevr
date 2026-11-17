// The mod listener: plain HTTP on 127.0.0.1, separate from the HUD's HTTPS
// port, where each Claude Code session's claudevr mod reports itself and
// collects messages (docs/mod-protocol.md). Four routes and nothing else.
//
// Discovery: on start the bridge writes ~/.claudevr/bridge.json (or
// CLAUDEVR_BRIDGE_FILE) holding the URL and a token made fresh for this run.
// The file is 0600 in a 0700 folder and written by rename, so a mod never
// reads half of one. The token lives in memory and that file only; no log
// line carries it. On a clean stop the file is removed, but only while it
// still holds this bridge's token: a second bridge that has since written its
// own is left alone.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ModHub } from './backend/claude/hub.ts'
import { parseReport, ReportError, SRC } from './backend/claude/report.ts'

export const BODY_MAX = 64 * 1024
export const DEFAULT_BRIDGE_FILE = join(homedir(), '.claudevr', 'bridge.json')
/** Inbox polls held open at once, across all sessions. */
const POLLS_MAX = 128
const SWEEP_MS = 5_000

export interface ModListenerOptions {
  hub: ModHub
  port: number
  bridgeFile: string
  log?: (...a: unknown[]) => void
  /** Tests pass a token; a real bridge makes a fresh one. */
  token?: string
}

const digest = (s: string) => createHash('sha256').update(s).digest()

/** Constant-time: both sides are hashed to the same length first. */
export function tokenMatches(given: unknown, token: string): boolean {
  if (typeof given !== 'string' || !given) return false
  return timingSafeEqual(digest(given), digest(token))
}

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** A JSON body of at most BODY_MAX bytes, read to the end so the 413 reaches the client. */
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((ok, fail) => {
    const tooBig = () => new HttpError(413, `body over ${BODY_MAX} bytes`)
    if (Number(req.headers['content-length'] ?? NaN) > BODY_MAX) {
      fail(tooBig())
      req.resume()
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (c: Buffer) => {
      if (over) return
      size += c.length
      if (size <= BODY_MAX) return void chunks.push(c)
      over = true
      chunks.length = 0
    })
    req.on('end', () => {
      if (over) return fail(tooBig())
      try {
        ok(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (err) {
        fail(new HttpError(400, `not JSON: ${(err as Error).message}`))
      }
    })
    req.on('error', err => fail(err))
  })
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (res.headersSent || res.destroyed) return
  if (body === undefined) {
    res.writeHead(status, { 'cache-control': 'no-store' })
    res.end()
    return
  }
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/**
 * Writes the discovery file: a temp file made 0600 with O_EXCL beside it,
 * then renamed over. The default folder is made (or tightened to) 0700; a
 * folder named by CLAUDEVR_BRIDGE_FILE is made 0700 if missing but an
 * existing one is not touched, since it may be shared (/tmp).
 */
export function writeBridgeFile(file: string, data: { v: 1; url: string; token: string; pid: number; startedAt: number }, isDefault: boolean): void {
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (isDefault) chmodSync(dir, 0o700)
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(data) + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(tmp, file)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // The temp file was never made, or the rename took it.
    }
    throw err
  }
}

/** Removes the file only while it still holds `token`. */
export function removeBridgeFile(file: string, token: string): boolean {
  try {
    const d = JSON.parse(readFileSync(file, 'utf8')) as { token?: unknown }
    if (!tokenMatches(d.token, token)) return false
    unlinkSync(file)
    return true
  } catch {
    return false
  }
}

export class ModListener {
  readonly hub: ModHub
  readonly server: Server
  private readonly token: string
  private readonly port: number
  private readonly bridgeFile: string
  private readonly log: (...a: unknown[]) => void
  private polls = 0
  private sweeper: NodeJS.Timeout | null = null
  private wroteFile = false
  /** Why the listener is not serving, for the HUD; null while it is. */
  problem: string | null = 'the mod listener has not started yet'
  url: string | null = null

  constructor(o: ModListenerOptions) {
    this.hub = o.hub
    this.port = o.port
    this.bridgeFile = o.bridgeFile
    this.log = o.log ?? (() => {})
    this.token = o.token ?? randomBytes(32).toString('hex')
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(err => {
        const status = err instanceof HttpError ? err.status : 500
        if (status === 500) this.log('mod listener: request failed:', (err as Error).message)
        send(res, status, { error: (err as Error).message })
      })
    })
    this.server.headersTimeout = 10_000
    // An inbox poll is held up to the hub's hold time; give it room.
    this.server.requestTimeout = Math.max(60_000, this.hub.pollHoldMs + 10_000)
  }

  /** Listens on 127.0.0.1 and writes the discovery file. Resolves with the URL. */
  start(): Promise<string> {
    return new Promise((ok, fail) => {
      const onError = (err: Error) => {
        this.problem = `the mod listener could not start on 127.0.0.1:${this.port}: ${err.message}`
        fail(err)
      }
      this.server.once('error', onError)
      this.server.listen(this.port, '127.0.0.1', () => {
        this.server.off('error', onError)
        this.server.on('error', err => this.log('mod listener error:', err.message))
        const port = (this.server.address() as AddressInfo).port
        this.url = `http://127.0.0.1:${port}`
        try {
          writeBridgeFile(this.bridgeFile, { v: 1, url: this.url, token: this.token, pid: process.pid, startedAt: Date.now() }, this.bridgeFile === DEFAULT_BRIDGE_FILE)
          this.wroteFile = true
        } catch (err) {
          this.problem = `the mod listener is up but could not write ${this.bridgeFile}: ${(err as Error).message}`
          this.log(this.problem)
          return ok(this.url)
        }
        this.problem = null
        this.sweeper = setInterval(() => this.hub.sweep(), SWEEP_MS)
        this.sweeper.unref?.()
        this.log(`mod listener on ${this.url}; discovery file ${this.bridgeFile}`)
        ok(this.url)
      })
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The token before anything else: without it, a 401 and nothing more.
    if (!tokenMatches(req.headers['x-claudevr-token'], this.token)) {
      req.resume()
      return send(res, 401, { error: 'token missing or wrong' })
    }
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      return send(res, 400, { error: 'bad request target' })
    }
    const route = `${req.method} ${url.pathname}`
    const known = ['/mod/v1/session', '/mod/v1/inbox', '/mod/v1/ack']
    if (!known.includes(url.pathname)) {
      req.resume()
      return send(res, 404, { error: 'not found' })
    }
    const srcs = url.searchParams.getAll('src')
    const src = srcs.length === 1 ? srcs[0]! : ''
    if (!SRC.test(src)) {
      req.resume()
      return send(res, 400, { error: 'src: the session id, at most 128 of A-Z a-z 0-9 . _ : -' })
    }
    switch (route) {
      case 'POST /mod/v1/session': {
        const body = await readJson(req)
        let report
        try {
          report = parseReport(body, src)
        } catch (err) {
          if (err instanceof ReportError) return send(res, 400, { error: err.message })
          throw err
        }
        if (!this.hub.report(report)) return send(res, 503, { error: 'the bridge is following as many sessions as it will' })
        return send(res, 204)
      }
      case 'DELETE /mod/v1/session':
        req.resume()
        this.hub.end(src)
        return send(res, 204)
      case 'GET /mod/v1/inbox': {
        req.resume()
        if (this.polls >= POLLS_MAX) return send(res, 503, { error: 'too many inbox polls open' })
        this.polls++
        let done = false
        const finish = () => {
          if (done) return false
          done = true
          this.polls--
          return true
        }
        const withdraw = this.hub.poll(src, items => {
          if (!finish()) return
          if (items && items.length) send(res, 200, { items })
          else send(res, 204)
        })
        res.on('close', () => {
          if (finish()) withdraw()
        })
        return
      }
      case 'POST /mod/v1/ack': {
        const body = await readJson(req)
        if (typeof body !== 'object' || body === null || Array.isArray(body)) return send(res, 400, { error: 'an object: { id, ok, reason? }' })
        const b = body as Record<string, unknown>
        if (typeof b.id !== 'string' || !b.id || b.id.length > 128) return send(res, 400, { error: 'id: the message id' })
        if (typeof b.ok !== 'boolean') return send(res, 400, { error: 'ok: true or false' })
        if (b.reason !== undefined && b.reason !== null && typeof b.reason !== 'string') return send(res, 400, { error: 'reason: a string' })
        const reason = typeof b.reason === 'string' ? b.reason.replace(/\s+/g, ' ').trim().slice(0, 300) : null
        // Optional: how the session took it. Anything unknown reads as plain delivered.
        const delivery = b.delivery === 'started' || b.delivery === 'queued' ? b.delivery : null
        this.hub.ack(src, b.id, b.ok, reason, delivery)
        return send(res, 204)
      }
      default:
        req.resume()
        return send(res, 405, { error: `${req.method} is not allowed on ${url.pathname}` })
    }
  }

  /** Stops listening, answers held polls, settles open sends and removes the discovery file if it is still ours. */
  close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper)
    this.hub.close()
    if (this.wroteFile && removeBridgeFile(this.bridgeFile, this.token)) this.log(`mod listener: removed ${this.bridgeFile}`)
    this.wroteFile = false
    this.problem = 'the mod listener has stopped'
    return new Promise(ok => {
      this.server.close(() => ok())
      this.server.closeAllConnections()
    })
  }
}
