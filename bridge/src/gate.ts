// Who may talk to the bridge. It listens on the LAN and its send path types
// into agents with full access to this machine, so every request passes:
//   1. the address check: loopback, or an IP on the configured list;
//   2. the pairing token, on every API call and WebSocket (static files
//      excepted, so the page that asks for the token can load);
//   3. for sends, a rate limit across all clients.

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
  if (LOOPBACK.has(ip) || ip.startsWith('127.')) return true
  return allow.some(a => normaliseIp(a) === ip)
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

/** A request from a page on another origin is refused, token or not. */
export function originOk(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch (err) {
    console.error('gate: unreadable Origin header:', (err as Error).message)
    return false
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
}
