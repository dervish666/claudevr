// Who may talk to the bridge. It listens on the LAN and its send path types
// into agents with full access to this machine, so every request passes:
//   1. the address check: loopback, or an IP on the configured list;
//   2. a token, on every API call and WebSocket (static files and the
//      pairing handshake excepted, so a browser with no token can pair): a
//      paired device's own token or the legacy one (pairing.ts);
//   3. for sends, a rate limit across all clients;
//   4. for everything, a request budget per client, and for the routes that
//      start real work (a CLI, ffmpeg, speech) a tighter one plus a bounded
//      number of runs at once (KeyedBudget, Pool).

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { IncomingMessage } from 'node:http'

const LOOPBACK = new Set(['127.0.0.1', '::1'])

/** "::ffff:10.0.0.9" -> "10.0.0.9". */
export function normaliseIp(ip: string | undefined): string {
  const s = (ip ?? '').trim()
  return s.startsWith('::ffff:') ? s.slice(7) : s
}

export function ipAllowed(remote: string | undefined, allow: readonly string[]): boolean {
  const ip = normaliseIp(remote)
  if (!ip) return false
  if (isLoopback(ip)) return true
  return allow.some(a => normaliseIp(a) === ip)
}

/** A connection from this machine itself. The headset, even when allowed, is never this. */
export function isLoopback(remote: string | undefined): boolean {
  const ip = normaliseIp(remote)
  return LOOPBACK.has(ip) || ip.startsWith('127.')
}

/**
 * The request was addressed to this machine by a loopback name. With the
 * loopback address check it keeps the approval page off any other name, so a
 * page on another site whose name points at 127.0.0.1 does not count as the
 * bridge's own origin.
 */
export function loopbackHost(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (!host) return false
  try {
    const name = new URL(`https://${host}`).hostname
    return name === 'localhost' || name === '[::1]' || /^127(\.\d{1,3}){3}$/.test(name)
  } catch (err) {
    console.error('gate: unreadable Host header:', (err as Error).message)
    return false
  }
}

/** The pairing token, made on first run. Kept in the state directory (gitignored), mode 600. */
export function loadOrCreateToken(path: string, log: (...a: unknown[]) => void): { token: string; created: boolean } {
  try {
    const t = readFileSync(path, 'utf8').trim()
    if (/^[0-9a-f]{32,}$/.test(t)) return { token: t, created: false }
    throw new Error(`${path} does not hold a token; delete it to make a new one`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  // 16 bytes is plenty against guessing and still short enough to type on a
  // headset keyboard once.
  const token = randomBytes(16).toString('hex')
  writeFileSync(path, `${token}\n`, { mode: 0o600, flag: 'wx' })
  chmodSync(path, 0o600)
  log('made a new pairing token at', path)
  return { token, created: true }
}

export function tokenMatches(given: string | null | undefined, token: string): boolean {
  if (typeof given !== 'string' || !given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

export const WS_PROTOCOL = 'claudevr'
const WS_TOKEN_PREFIX = 'token.'

/**
 * The token a request carries: "Authorization: Bearer <t>" for HTTP; for a
 * WebSocket, whose browser API cannot set headers, a second subprotocol
 * "token.<t>" beside "claudevr". Never a query string, which lands in logs.
 */
export function tokenOf(req: IncomingMessage): string | null {
  const auth = req.headers.authorization
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim()
  const protos = String(req.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map(s => s.trim())
  const p = protos.find(s => s.startsWith(WS_TOKEN_PREFIX))
  return p ? p.slice(WS_TOKEN_PREFIX.length) : null
}

/**
 * A request from a page on another origin is refused, token or not. The
 * bridge only serves HTTPS, so the one origin it accepts is https:// and the
 * Host the request was sent to; "http://<same host>" is another origin.
 */
export function originOk(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  const host = req.headers.host
  if (!host) return false
  try {
    // Both through URL, so case and a spelled-out :443 compare as the browser means them.
    return new URL(origin).origin === new URL(`https://${host}`).origin
  } catch (err) {
    console.error('gate: unreadable Origin or Host header:', (err as Error).message)
    return false
  }
}

/**
 * Sliding-window budgets per key (a client address): at most `max` units in
 * any `windowMs`. A unit is a request, or a byte for the log routes.
 */
export class KeyedBudget {
  private readonly used = new Map<string, { at: number; n: number }[]>()
  private readonly max: number
  private readonly windowMs: number
  constructor(max: number, windowMs: number) {
    this.max = max
    this.windowMs = windowMs
  }

  /** Takes `n` units and returns null, or returns how many seconds until that many are free. */
  take(key: string, n = 1, now = Date.now()): { retryAfterS: number } | null {
    const live = (this.used.get(key) ?? []).filter(e => now - e.at < this.windowMs)
    let sum = live.reduce((a, e) => a + e.n, 0)
    if (sum + n > this.max) {
      this.used.set(key, live)
      // The oldest entries free up first; wait for enough of them.
      let at = now + this.windowMs
      for (const e of live) {
        sum -= e.n
        if (sum + n <= this.max) {
          at = e.at + this.windowMs
          break
        }
      }
      return { retryAfterS: Math.max(1, Math.ceil((at - now) / 1000)) }
    }
    live.push({ at: now, n })
    this.used.set(key, live)
    // Addresses that went quiet are forgotten, so the map stays the size of the clients in use.
    if (this.used.size > 256) for (const [k, v] of this.used) if (!v.some(e => now - e.at < this.windowMs)) this.used.delete(k)
    return null
  }
}

/** Every slot of a bounded operation is taken and its queue is full. */
export class Busy extends Error {
  constructor(what: string, running: number, waiting: number) {
    super(`busy: ${running} ${what} running and ${waiting} waiting; try again in a moment`)
    this.name = 'Busy'
  }
}

/**
 * At most `concurrency` runs of an expensive operation at once (a CLI
 * process, an ffmpeg decode, a paid speech request), and at most `queue`
 * more waiting. Past that a run is refused at once with Busy.
 */
export class Pool {
  private running = 0
  private readonly waiting: (() => void)[] = []
  private readonly what: string
  private readonly concurrency: number
  private readonly queue: number
  constructor(what: string, concurrency: number, queue: number) {
    this.what = what
    this.concurrency = Math.max(1, concurrency)
    this.queue = Math.max(0, queue)
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrency && this.waiting.length >= this.queue) return Promise.reject(new Busy(this.what, this.running, this.waiting.length))
    return new Promise<T>((ok, fail) => {
      const go = () => {
        this.running++
        let p: Promise<T>
        try {
          p = fn()
        } catch (err) {
          p = Promise.reject(err)
        }
        // then(ok, fail) handles the outcome, so the finally chain never rejects unhandled.
        p.then(ok, fail).finally(() => {
          this.running--
          this.waiting.shift()?.()
        })
      }
      if (this.running < this.concurrency) go()
      else this.waiting.push(go)
    })
  }

  /** How many run now and how many wait, for tests and the log. */
  load(): { running: number; waiting: number } {
    return { running: this.running, waiting: this.waiting.length }
  }
}

/** Sliding-window limits on sends, across every client. */
export class RateLimiter {
  private readonly at: number[] = []
  private readonly perMinute: number
  private readonly perHour: number
  constructor(perMinute: number, perHour: number) {
    this.perMinute = perMinute
    this.perHour = perHour
  }

  /** Takes a slot and returns null, or returns how many seconds until one frees up. */
  take(now = Date.now()): { retryAfterS: number } | null {
    while (this.at.length && now - this.at[0]! >= 3_600_000) this.at.shift()
    const lastMinute = this.at.filter(t => now - t < 60_000)
    if (lastMinute.length >= this.perMinute) return { retryAfterS: Math.ceil((60_000 - (now - lastMinute[0]!)) / 1000) }
    if (this.at.length >= this.perHour) return { retryAfterS: Math.ceil((3_600_000 - (now - this.at[0]!)) / 1000) }
    this.at.push(now)
    return null
  }

  /**
   * Gives back the slot taken at `at`, for a send the backend refused before
   * anything went out. Never for one whose outcome is unknown: that may have
   * been delivered, and it counts.
   */
  refund(at: number): void {
    const i = this.at.lastIndexOf(at)
    if (i >= 0) this.at.splice(i, 1)
  }
}
