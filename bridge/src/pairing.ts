// Pairing a browser without typing a token, by a two-way handshake.
//
// A browser with no token asks for a pairing request and shows its short
// code. The person types that code into the approval page on this machine
// (/pair, loopback only), and the browser's next poll collects a token of its
// own, once. Each device's token is kept only as a sha256 hash in
// <state>/devices.json, so reading that file gives nobody a way in. The single
// token from before (<state>/pairing-token) stays valid as the "legacy token"
// until it is revoked on the approval page, so browsers paired with it keep
// working.
//
// Never log a code or a token. The log is read in a terminal and kept.

import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { KeyedBudget, tokenMatches } from './gate.ts'

type Log = (...a: unknown[]) => void

/** Letters and digits nobody misreads for another: no 0/O, 1/I/L, 2/Z, 5/S, 8/B. */
export const PAIR_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679'
export const CODE_LENGTH = 6

export interface PairLimits {
  /** How long a code waits for approval, and how long an approved request waits for its poll. */
  ttlMs: number
  /** Codes waiting at once from one address, and in all. */
  perIp: number
  total: number
  /** New codes one address may ask for in a minute. */
  requestsPerMinute: number
  /** Wrong codes typed on the approval page in a minute, from anywhere. */
  approveFailsPerMinute: number
  /** A device's "last seen" is written at most this often. */
  seenEveryMs: number
}

export const PAIR_LIMITS: PairLimits = {
  ttlMs: 120_000,
  perIp: 3,
  total: 20,
  requestsPerMinute: 6,
  approveFailsPerMinute: 10,
  seenEveryMs: 60_000,
}

/** "ACDEFG" -> "ACD-EFG", the way the headset shows it. */
export function formatCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3)}`
}

/** What a person typed, as a code: case, spaces and dashes do not matter. */
export function normaliseCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function makeCode(): string {
  let s = ''
  for (let i = 0; i < CODE_LENGTH; i++) s += PAIR_ALPHABET[randomInt(PAIR_ALPHABET.length)]
  return s
}

/**
 * A name for the device from its User-Agent: "Quest browser", "Chrome on
 * Mac". The header is the sender's to choose, so the result is printable
 * ASCII only and clipped; it goes into the log, a notification and a page.
 */
export function deviceLabel(ua: string | undefined): string {
  const s = (ua ?? '').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim()
  if (!s) return 'Unknown browser'
  if (/OculusBrowser/i.test(s)) return 'Quest browser'
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android' : /Macintosh|Mac OS X/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows' : /CrOS/.test(s) ? 'ChromeOS' : /Linux/.test(s) ? 'Linux' : null
  const browser = /Edg(A|iOS)?\//.test(s) ? 'Edge' : /Firefox\/|FxiOS\//.test(s) ? 'Firefox' : /OPR\//.test(s) ? 'Opera' : /Chrome\/|CriOS\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : null
  if (browser && os) return `${browser} on ${os}`
  return s.length > 60 ? `${s.slice(0, 57)}...` : s
}

const sha256 = (s: string) => createHash('sha256').update(s).digest()

// ------------------------------------------------------------------ devices

/** A paired device as the approval page lists it. Times are epoch ms. */
export interface Device {
  id: string
  label: string
  /** The address it paired from. */
  ip: string
  pairedAt: number
  lastSeen: number | null
}

interface StoredDevice extends Device {
  /** sha256 of the device's token, hex. */
  hash: string
}

/** Which credential a request carried. */
export type Credential = { kind: 'device'; id: string } | { kind: 'legacy' }

export const sameCredential = (a: Credential, b: Credential) => a.kind === b.kind && (a.kind === 'legacy' || a.id === (b as { id: string }).id)

export interface DeviceStoreOptions {
  /** devices.json; null keeps devices in memory only. */
  file: string | null
  /** The legacy token's file; null when the legacy token lives in memory only. */
  legacyFile?: string | null
  /** The legacy token when there is no file (tests, older callers), or null for none. */
  legacyToken?: string | null
  log?: Log
  now?: () => number
  seenEveryMs?: number
}

const DEVICE_ID = /^[0-9a-f]{16}$/
const HASH = /^[0-9a-f]{64}$/

function readDevices(file: string, log: Log): StoredDevice[] {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (err) {
    throw new Error(`${file} is not JSON (${(err as Error).message}); fix it, or delete it to unpair every device`)
  }
  const list = (data as { devices?: unknown } | null)?.devices
  if (!Array.isArray(list)) throw new Error(`${file} holds no "devices" list; fix it, or delete it to unpair every device`)
  const out: StoredDevice[] = []
  for (const d of list as Record<string, unknown>[]) {
    const ok =
      d && typeof d.id === 'string' && DEVICE_ID.test(d.id) && typeof d.hash === 'string' && HASH.test(d.hash) && typeof d.label === 'string' && typeof d.ip === 'string' && typeof d.pairedAt === 'number' && (d.lastSeen === null || typeof d.lastSeen === 'number')
    if (!ok) {
      log(`pair: ${file}: skipped an entry that is not a device`)
      continue
    }
    out.push({ id: d.id as string, hash: d.hash as string, label: String(d.label).slice(0, 80), ip: String(d.ip).slice(0, 64), pairedAt: d.pairedAt as number, lastSeen: d.lastSeen as number | null })
  }
  // Hashes are no use to a reader, but the file is still nobody else's business.
  if (statSync(file).mode & 0o077) {
    chmodSync(file, 0o600)
    log(`pair: ${file} was readable by others; set it to 600`)
  }
  return out
}

/** The legacy token from its file, or null when there is none. A file that holds something else is an error, as before. */
function readLegacy(file: string): string | null {
  try {
    const t = readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{32,}$/.test(t)) return t
    throw new Error(`${file} does not hold a token; delete it to make a new one`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * The paired devices and the legacy token: who may use the bridge. Each
 * device token is checked by hash against every device, compared in
 * constant time, and the legacy token the same way.
 */
export class DeviceStore {
  private devices: StoredDevice[]
  private hashes = new Map<string, Buffer>()
  private legacy: string | null
  private readonly file: string | null
  private readonly legacyFile: string | null
  private readonly log: Log
  private readonly now: () => number
  private readonly seenEveryMs: number
  private readonly revokeListeners = new Set<(c: Credential) => void>()

  constructor(o: DeviceStoreOptions) {
    this.file = o.file
    this.legacyFile = o.legacyFile ?? null
    this.log = o.log ?? (() => {})
    this.now = o.now ?? Date.now
    this.seenEveryMs = o.seenEveryMs ?? PAIR_LIMITS.seenEveryMs
    this.devices = this.file ? readDevices(this.file, this.log) : []
    for (const d of this.devices) this.hashes.set(d.id, Buffer.from(d.hash, 'hex'))
    this.legacy = this.legacyFile ? readLegacy(this.legacyFile) : (o.legacyToken ?? null)
  }

  /** The credential a token stands for, or null. */
  match(given: string | null | undefined): Credential | null {
    if (typeof given !== 'string' || !given || given.length > 512) return null
    const h = sha256(given)
    let found: Credential | null = null
    // Every candidate is compared, so how long this takes says nothing about which one matched.
    for (const d of this.devices) if (timingSafeEqual(h, this.hashes.get(d.id)!) && !found) found = { kind: 'device', id: d.id }
    if (this.legacy !== null && tokenMatches(given, this.legacy) && !found) found = { kind: 'legacy' }
    return found
  }

  /** Whether a credential matched earlier is still good (it may have been revoked since). */
  valid(c: Credential): boolean {
    return c.kind === 'legacy' ? this.legacy !== null : this.devices.some(d => d.id === c.id)
  }

  /** Notes that a device was used. Written at most once a minute per device, not on every request. */
  seen(c: Credential): void {
    if (c.kind !== 'device') return
    const d = this.devices.find(x => x.id === c.id)
    if (!d) return
    const now = this.now()
    if (d.lastSeen !== null && now - d.lastSeen < this.seenEveryMs) return
    d.lastSeen = now
    try {
      this.save()
    } catch (err) {
      // Last seen is for the person reading the list; a failed write must not refuse the request.
      this.log(`pair: could not write ${this.file}: ${(err as Error).message}`)
    }
  }

  /** Pairs a new device. The token is returned here once and kept only as a hash. */
  add(label: string, ip: string): { device: Device; token: string } {
    const token = randomBytes(32).toString('base64url')
    const d: StoredDevice = { id: randomBytes(8).toString('hex'), hash: sha256(token).toString('hex'), label, ip, pairedAt: this.now(), lastSeen: null }
    this.devices.push(d)
    this.hashes.set(d.id, Buffer.from(d.hash, 'hex'))
    try {
      this.save()
    } catch (err) {
      // Not written means not paired. A device that vanished on the next restart would be a surprise.
      this.devices.pop()
      this.hashes.delete(d.id)
      throw err
    }
    return { device: publicDevice(d), token }
  }

  /** Unpairs a device at once. Its token stops working and its open sockets are closed. */
  revoke(id: string): Device | null {
    const d = this.devices.find(x => x.id === id)
    if (!d) return null
    this.devices = this.devices.filter(x => x !== d)
    this.hashes.delete(id)
    this.emitRevoke({ kind: 'device', id })
    // Revoked in memory before the write, so a failed write still shuts the device out until a restart.
    this.save()
    return publicDevice(d)
  }

  legacyActive(): boolean {
    return this.legacy !== null
  }

  /** Stops accepting the legacy token and deletes its file. */
  revokeLegacy(): boolean {
    if (this.legacy === null) return false
    this.legacy = null
    this.emitRevoke({ kind: 'legacy' })
    if (this.legacyFile) rmSync(this.legacyFile, { force: true })
    return true
  }

  list(): Device[] {
    return this.devices.map(publicDevice)
  }

  onRevoke(fn: (c: Credential) => void): () => void {
    this.revokeListeners.add(fn)
    return () => this.revokeListeners.delete(fn)
  }

  private emitRevoke(c: Credential): void {
    for (const fn of this.revokeListeners) {
      try {
        fn(c)
      } catch (err) {
        this.log('pair: a revoke listener failed:', (err as Error).message)
      }
    }
  }

  /** Written whole to a temporary file and renamed over the old one, so a crash mid-write never leaves half a list. */
  private save(): void {
    if (!this.file) return
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`
    const body = `${JSON.stringify({ version: 1, devices: this.devices }, null, 2)}\n`
    try {
      writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' })
      renameSync(tmp, this.file)
    } catch (err) {
      rmSync(tmp, { force: true })
      throw err
    }
  }
}

const publicDevice = (d: StoredDevice): Device => ({ id: d.id, label: d.label, ip: d.ip, pairedAt: d.pairedAt, lastSeen: d.lastSeen })

// ------------------------------------------------------------------ requests

interface PendingRequest {
  id: string
  secretHash: Buffer
  code: string
  ip: string
  label: string
  expiresAt: number
  /** Set on approval; the next good poll takes the token and the request is forgotten. */
  approved: { deviceId: string; token: string } | null
}

export type CreateResult =
  | { ok: true; id: string; secret: string; code: string; label: string; expiresInMs: number }
  | { ok: false; status: 429 | 503; error: string; retryAfterS: number }

export type PollResult = { state: 'pending'; expiresInMs: number } | { state: 'approved'; token: string; device: Device } | { state: 'gone' }

export type ApproveResult = { ok: true; device: Device } | { ok: false; status: 400 | 404 | 429; error: string; retryAfterS?: number }

export interface PairingOptions {
  devices: DeviceStore
  log?: Log
  limits?: Partial<PairLimits>
  now?: () => number
}

/** Pairing requests waiting for a code to be typed on this machine. In memory only, so a restart forgets them. */
export class PairingRequests {
  readonly limits: PairLimits
  private readonly requests = new Map<string, PendingRequest>()
  private readonly devices: DeviceStore
  private readonly log: Log
  private readonly now: () => number
  private readonly perIpBudget: KeyedBudget
  /** When recent wrong codes were typed, oldest first; never longer than the limit. */
  private fails: number[] = []

  constructor(o: PairingOptions) {
    this.devices = o.devices
    this.log = o.log ?? (() => {})
    this.now = o.now ?? Date.now
    this.limits = { ...PAIR_LIMITS, ...o.limits }
    this.perIpBudget = new KeyedBudget(this.limits.requestsPerMinute, 60_000)
  }

  /**
   * A new code for the device at `ip`. `replaces` names the caller's own
   * earlier request (its id and poll secret), which is dropped first, so
   * "New code" works even with the address at its cap.
   */
  create(ip: string, userAgent: string | undefined, replaces?: { id: string; secret: string } | null): CreateResult {
    const now = this.now()
    this.sweep(now)
    const over = this.perIpBudget.take(ip, 1, now)
    if (over) return { ok: false, status: 429, error: `over ${this.limits.requestsPerMinute} new codes a minute from this address; try again in ${over.retryAfterS} s`, retryAfterS: over.retryAfterS }
    if (replaces) {
      const old = this.requests.get(replaces.id)
      if (old && !old.approved && old.ip === ip && this.secretOk(old, replaces.secret)) this.requests.delete(old.id)
    }
    const waitingHere = [...this.requests.values()].filter(r => r.ip === ip && !r.approved)
    if (waitingHere.length >= this.limits.perIp) {
      const soonest = Math.min(...waitingHere.map(r => r.expiresAt))
      const retryAfterS = Math.max(1, Math.ceil((soonest - now) / 1000))
      return { ok: false, status: 429, error: `${waitingHere.length} codes are already waiting from this address; use one, or try again in ${retryAfterS} s`, retryAfterS }
    }
    if (this.requests.size >= this.limits.total) return { ok: false, status: 503, error: `${this.requests.size} devices are already waiting to pair, the most the bridge holds; try again in a minute`, retryAfterS: 30 }
    const taken = new Set([...this.requests.values()].map(r => r.code))
    let code = makeCode()
    while (taken.has(code)) code = makeCode()
    const secret = randomBytes(32).toString('base64url')
    const r: PendingRequest = { id: randomBytes(16).toString('hex'), secretHash: sha256(secret), code, ip, label: deviceLabel(userAgent), expiresAt: now + this.limits.ttlMs, approved: null }
    this.requests.set(r.id, r)
    return { ok: true, id: r.id, secret, code: formatCode(code), label: r.label, expiresInMs: this.limits.ttlMs }
  }

  /**
   * The device's poll, from the address that asked. A wrong secret or
   * address gets the same answer as an unknown id, so an id seen in a URL is
   * no use alone. An approved request hands over its token once and is then
   * forgotten.
   */
  poll(id: string, secret: string | null | undefined, ip: string): PollResult {
    const now = this.now()
    this.sweep(now)
    const r = this.requests.get(id)
    if (!r || typeof secret !== 'string' || !this.secretOk(r, secret) || r.ip !== ip) return { state: 'gone' }
    if (!r.approved) return { state: 'pending', expiresInMs: r.expiresAt - now }
    this.requests.delete(id)
    const device = this.devices.list().find(d => d.id === r.approved!.deviceId)
    // Revoked between approval and this poll. The token would not work, so it is not handed over.
    if (!device) return { state: 'gone' }
    return { state: 'approved', token: r.approved.token, device }
  }

  /** The code typed on the approval page. Wrong codes are limited across all callers, so they cannot be tried by the thousand. */
  approve(input: string): ApproveResult {
    const now = this.now()
    this.sweep(now)
    this.fails = this.fails.filter(t => now - t < 60_000)
    if (this.fails.length >= this.limits.approveFailsPerMinute) {
      const retryAfterS = Math.max(1, Math.ceil((this.fails[0]! + 60_000 - now) / 1000))
      return { ok: false, status: 429, error: `${this.fails.length} wrong codes in the last minute; try again in ${retryAfterS} s`, retryAfterS }
    }
    const code = normaliseCode(input)
    if (code.length !== CODE_LENGTH) return { ok: false, status: 400, error: `a code is ${CODE_LENGTH} letters and digits, like ACD-347` }
    const want = Buffer.from(code)
    let hit: PendingRequest | null = null
    for (const r of this.requests.values()) if (!r.approved && timingSafeEqual(Buffer.from(r.code), want) && !hit) hit = r
    if (!hit) {
      this.fails.push(now)
      const left = this.limits.approveFailsPerMinute - this.fails.length
      return { ok: false, status: 404, error: `No device is waiting with that code. Check the code on the headset; it may have expired. ${left} more ${left === 1 ? 'try' : 'tries'} this minute.` }
    }
    const { device, token } = this.devices.add(hit.label, hit.ip)
    hit.approved = { deviceId: device.id, token }
    // The device now has a fresh window to collect its token.
    hit.expiresAt = now + this.limits.ttlMs
    return { ok: true, device }
  }

  /** Requests still waiting for their code, for the approval page. No codes, no ids. */
  waiting(): { label: string; ip: string; expiresInMs: number }[] {
    const now = this.now()
    this.sweep(now)
    return [...this.requests.values()].filter(r => !r.approved).map(r => ({ label: r.label, ip: r.ip, expiresInMs: r.expiresAt - now }))
  }

  private secretOk(r: PendingRequest, secret: string): boolean {
    return timingSafeEqual(sha256(secret), r.secretHash)
  }

  /** Forgets expired requests. One approved but never collected is unpaired, since nobody holds its token. */
  private sweep(now: number): void {
    for (const r of this.requests.values()) {
      if (r.expiresAt > now) continue
      this.requests.delete(r.id)
      if (!r.approved) continue
      try {
        if (this.devices.revoke(r.approved.deviceId)) this.log(`pair: ${r.label} at ${r.ip} was approved but never collected its token; unpaired it`)
      } catch (err) {
        this.log(`pair: could not unpair ${r.label} at ${r.ip}, which never collected its token: ${(err as Error).message}`)
      }
    }
  }
}

// ------------------------------------------------------------------ notification

/** Text as an AppleScript string literal's contents: backslashes and quotes escaped, control characters gone. */
export function appleScriptString(s: string): string {
  return s.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/[\\"]/g, c => `\\${c}`)
}

type Runner = (file: string, args: string[], opts: { timeout: number }, done: (err: Error | null) => void) => unknown

/**
 * A macOS notification with the same words as the log line. osascript gets
 * the script as one argument, with no shell between, and the text inside it
 * is escaped, since the device label comes from the request.
 */
export function notifyMac(text: string, log: Log, run: Runner = execFile as unknown as Runner): void {
  const script = `display notification "${appleScriptString(text)}" with title "ClaudeVR"`
  try {
    run('osascript', ['-e', script], { timeout: 5000 }, err => {
      if (err) log(`pair: could not post a notification: ${err.message}`)
    })
  } catch (err) {
    log(`pair: could not post a notification: ${(err as Error).message}`)
  }
}
