// The bridge's HTTPS server: the built client, a small JSON API and the
// HUD's WebSocket, all behind the gate in gate.ts.
//
//   GET  /            the HUD                      address check only
//   GET  /probe       the headset probe page       address check only
//   GET  /pair        the approval page            this machine only: loopback address and a loopback Host
//
//   Pairing (pairing.ts), no token:
//   POST /api/pair/request  {} or { replaces } -> a code to show, an id and a poll secret   address check + origin
//   GET  /api/pair/status?id=<id>  with x-pair-secret: pending, or the device's own token, once   address check + origin
//   GET  /api/pair/devices  paired devices, the legacy token, codes waiting (never the codes)   this machine only + origin
//   POST /api/pair/approve  { code } -> pairs the device showing it; 10 wrong codes a minute    this machine only + Origin header required
//   POST /api/pair/revoke   { id } or { legacy: true } -> unpairs it and closes its sockets     this machine only + Origin header required
//   POST /api/pair    the legacy token, if autoPair is on (deprecated)   address check + origin
//
//   GET  /api/health  backend status               address check + token
//   GET  /api/fleet   the last fleet read          address check + token
//   POST /api/unpair  a paired device revokes its own token; the legacy token is revoked on /pair only
//   POST /api/probe   append probe results to the log
//   POST /api/probe?log=instrument  { events: [...] } -> one line each in instrument.log
//   POST /api/send    { sessionId, text, requestId? } -> backend.send, rate limited, a repeated requestId answered once
//   GET  /api/transcript?session=<id>  a session's last turns in full
//   POST /api/transcribe   a recorded clip -> transcript and what it means
//   POST /api/interpret    { text, context, focus } -> what it means (no audio)
//   POST /api/speak   { text } -> WebM/Opus speech
//   GET  /api/line?id=<id>  character mode: the spoken line for an answer, within the line timeout
//   GET  /api/voice   speech-to-text and text-to-speech status
//   GET  /api/conversation  character mode: the character's conversation (in memory only)
//   POST /api/character { name | null } -> select a character, or operator mode; answers like "be X"
//   GET  /api/themes  the valid theme packs, parsed, and the broken ones with why
//   GET  /themes/<name>/<file>  an image a pack's theme.json lists      address check + token + origin
//   WS   /ws          hello, fleet, status, voice, build, line and conversation pushes; the HUD sends presence
//                                                  address check + token + origin
//
// Every other /api/ route needs a token (a paired device's own, or the legacy
// one) and a same-origin request. Nothing under pairing touches the backend.
// Nothing on the voice routes sends anything: the HUD shows a card with a
// countdown, and calls /api/send when it ends or on "Send now", unless the
// person cancels first. Character mode adds words, never actions: its lines
// are spoken, and a classified command can at most arm the same card.
//
// Limits (LIMITS below): a request budget per client address on every API
// route, a tighter one on the routes that start work, a bounded number of
// transcript reads, clip decodes and speech requests at once with a short
// queue each, a byte budget and rotation for the two logs, and a cap on
// WebSockets with a send buffer budget per socket. Past any of them the
// answer is 429 (this client is too fast) or 503 (the bridge is busy), with
// the reason in words.

import { createHash } from 'node:crypto'
import { unwatchFile, watchFile } from 'node:fs'
import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, extname, join, normalize, sep } from 'node:path'
import type { BackendStatus, BuildInfo, CharacterReply, Conversation, Fleet, Interpretation, PairStatus, PairTicket, PendingLine, ServerMessage, SessionTranscript, Transcript, VoiceContext, VoiceReply, VoiceStatus } from '../../shared/protocol.ts'
import { Busy, ipAllowed, isLoopback, KeyedBudget, loopbackHost, normaliseIp, originOk, Pool, RateLimiter, tokenOf } from './gate.ts'
import { DeviceStore, PairingRequests, type Credential } from './pairing.ts'
import { SendRefused, UnsupportedError, type SessionBackend } from './backend/types.ts'
import { relabelFleet, type CallsignOverride } from './backend/callsign.ts'
import { SendLedger, type SendOutcome } from './send-ledger.ts'
import { WsHub } from './ws-hub.ts'
import { ClipError, decodeClip, levels, SILENCE_PEAK_DB } from './voice/audio.ts'
import { characterSwitch, interpret } from './voice/grammar.ts'
import { NoStt, SttBusy, SttUnavailable, type SttProvider } from './voice/stt.ts'
import { NoTts, TtsUnavailable, type TtsProvider } from './voice/tts.ts'
import type { Persona } from './persona/persona.ts'
import type { ThemeStore } from './themes.ts'

/** The bridge's own limits on work and traffic. Tests shrink them. */
export interface Limits {
  /** API requests per client address per minute, every route counted. */
  apiPerMinute: number
  /** Requests per client per minute to the routes that start work: transcript, transcribe, interpret, speak, character. */
  heavyPerMinute: number
  /** [at once, waiting] for transcript reads (each a CLI process), clip decodes with their transcription, and speech requests. */
  transcripts: [number, number]
  clips: [number, number]
  speech: [number, number]
  /** Probe and instrument log bytes taken per client per minute. */
  logBytesPerMinute: number
  /** A log rotates to <file>.1 before it would pass this, so each log takes at most twice this on disk. */
  logFileMax: number
  /** Open WebSockets per address and in all, and the unsent bytes past which a socket is dropped. */
  wsPerIp: number
  wsTotal: number
  wsBufferMax: number
  /** How long a send's requestId is remembered, and how many at most. */
  sendIdsMs: number
  sendIdsMax: number
}

export const LIMITS: Limits = {
  apiPerMinute: 600,
  heavyPerMinute: 120,
  transcripts: [2, 4],
  clips: [2, 2],
  speech: [2, 6],
  logBytesPerMinute: 256 * 1024,
  logFileMax: 4 * 1024 * 1024,
  wsPerIp: 10,
  wsTotal: 40,
  wsBufferMax: 1024 * 1024,
  sendIdsMs: 10 * 60_000,
  sendIdsMax: 500,
}

export interface BridgeOptions {
  backend: SessionBackend
  /** The legacy token, held in memory, when no device store is given (tests, older callers). */
  token?: string
  /** Paired devices and the legacy token. Absent: a store in memory with `token` as the legacy token. */
  devices?: DeviceStore
  /** Codes waiting for approval; made over `devices` when absent. */
  pairing?: PairingRequests
  /** Called with one line when a device asks to pair (a desktop notification). Never given a code or a token. */
  notify?: (text: string) => void
  allowIps: string[]
  /** Deprecated: hand the legacy token to any allowed address that asks, so nobody pairs. */
  autoPair?: boolean
  clientDir: string
  probeLog: string
  /** Where instrument mode's measurements go; next to the probe log unless set. */
  instrumentLog?: string
  cert: string | Buffer
  key: string | Buffer
  sendsPerMinute: number
  sendsPerHour: number
  log?: (...a: unknown[]) => void
  stt?: SttProvider
  tts?: TtsProvider
  ffmpeg?: string
  /** Longest clip accepted, and the largest upload. */
  clipMaxSeconds?: number
  clipMaxBytes?: number
  callsigns?: CallsignOverride[]
  /** Tell open HUDs to reload when the built client changes (npm run dev). */
  devReload?: boolean
  /** Character mode. Absent, or with no character selected, the bridge answers exactly as in operator mode. */
  persona?: Persona
  /** Theme packs for the HUD. Absent: none listed, none served. */
  themes?: ThemeStore
  /** Any of LIMITS to change. */
  limits?: Partial<Limits>
}

export interface Bridge {
  server: Server
  status(): BackendStatus
  fleet(): Fleet | null
  close(): Promise<void>
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

const PAGES: Record<string, string> = { '/': 'index.html', '/probe': 'probe.html', '/probe/': 'probe.html' }
const JSON_MAX = 64 * 1024
const CONTEXTS: readonly VoiceContext[] = ['none', 'confirm', 'target']
/** Text the bridge will speak or interpret in one request. */
const TEXT_MAX = 2000
/** Instrument-mode events taken in one POST. */
const EVENTS_MAX = 400
/** The routes that start real work, and so share the tighter per-client budget. */
const HEAVY = new Set(['/api/transcript', '/api/transcribe', '/api/interpret', '/api/speak', '/api/character'])
/** A send's requestId: the card's id, as the HUD sends it. */
export const SEND_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/
/** The 401 for a request whose token is missing, wrong or revoked. */
const TOKEN_REFUSED = 'pairing token missing, wrong or revoked'
/** The retry-after, in seconds, on a 503 from a full pool (transcript reads, clips, speech). */
const BUSY_RETRY_S = '2'
// Moved to ws-hub.ts with the rest of the socket handling; still exported from here for callers and tests.
export { REVOKED_CLOSE, sendBounded } from './ws-hub.ts'

// The page's policy. 'wasm-unsafe-eval' lets instrument mode compile its
// layout engine (yoga, WebAssembly shipped inline in the JS) and nothing
// else: no eval, no inline script, no other origin. connect-src takes data:
// because yoga fetches that inline module from a data: URL; data: names no
// host, so it opens no way out of the page.
export const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' data:; media-src 'self' blob: data:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'"

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * The request target as a URL, or the reason it is not one. A raw client
 * can send any target ("GET http://[ HTTP/1.1"), and new URL throws on it,
 * so it is parsed here once, before anything else reads it.
 */
export function requestUrl(req: IncomingMessage): URL | Error {
  try {
    return new URL(req.url ?? '/', 'https://bridge')
  } catch (err) {
    // Handed back, not swallowed: the caller logs it and refuses the request.
    return err instanceof Error ? err : new Error(String(err))
  }
}

/** Appends to a log that first rotates to <file>.1 when it would pass `max` bytes, so it never holds much more than twice that on disk. */
export async function appendRotating(file: string, text: string, max: number): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  let size = 0
  try {
    size = (await stat(file)).size
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  if (size > 0 && size + Buffer.byteLength(text) > max) await rename(file, `${file}.1`)
  await appendFile(file, text, { mode: 0o600 })
}

/**
 * A JSON body of at most `max` bytes. One that is too big is refused with a
 * 413 the client can read: a declared length over the limit is refused at
 * once and the rest drained, and an undeclared one stops being kept at the
 * limit and is refused when it ends. Destroying the request instead would
 * reset the connection, and the client would never see why.
 */
function readBody(req: IncomingMessage, max: number): Promise<unknown> {
  return new Promise((ok, fail) => {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return fail(new HttpError(415, 'application/json only'))
    const tooBig = () => new HttpError(413, `body over ${max} bytes`)
    if (Number(req.headers['content-length'] ?? NaN) > max) {
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
      if (size <= max) return void chunks.push(c)
      // Past the limit: keep nothing more, drain the rest, answer at the end.
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

function readRaw(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((ok, fail) => {
    // A clip waits for a pool slot before it is read. One abandoned while it
    // waited has already closed, so its data and end events have been and
    // gone: without this the promise never settles and the slot is lost for good.
    if (req.destroyed) return fail(new HttpError(400, 'the upload was abandoned before it was read'))
    const declared = Number(req.headers['content-length'] ?? NaN)
    if (declared > max) {
      fail(new HttpError(413, `clip over ${max} bytes`))
      req.resume()
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > max) {
        if (!over) fail(new HttpError(413, `clip over ${max} bytes`))
        over = true
      } else chunks.push(c)
    })
    let ended = false
    req.on('end', () => {
      ended = true
      if (!over) ok(Buffer.concat(chunks))
    })
    req.on('error', err => fail(err))
    // Abandoned part way: no end will come.
    req.on('close', () => {
      if (!ended && !over) fail(new HttpError(400, 'the upload was abandoned before it arrived'))
    })
  })
}

/** An object body, or {} for anything else. */
const asObject = (d: unknown) => (typeof d === 'object' && d !== null && !Array.isArray(d) ? d : {}) as Record<string, unknown>

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

export function createBridge(o: BridgeOptions): Bridge {
  const log = o.log ?? ((...a: unknown[]) => console.log(new Date().toISOString(), ...a))
  const limits: Limits = { ...LIMITS, ...o.limits }
  const limiter = new RateLimiter(o.sendsPerMinute, o.sendsPerHour)
  const apiBudget = new KeyedBudget(limits.apiPerMinute, 60_000)
  const heavyBudget = new KeyedBudget(limits.heavyPerMinute, 60_000)
  const logBudget = new KeyedBudget(limits.logBytesPerMinute, 60_000)
  const pools = { transcript: new Pool('transcript reads', ...limits.transcripts), clips: new Pool('clips', ...limits.clips), speech: new Pool('speech requests', ...limits.speech) }
  let lastFleet: Fleet | null = null
  let status: BackendStatus = { name: o.backend.name, capabilities: o.backend.capabilities, ok: false, error: 'no read yet', lastOkAt: null }
  const refusedIps = new Set<string>()
  const stt = o.stt ?? new NoStt()
  const tts: TtsProvider = o.tts ?? new NoTts()
  const ffmpeg = o.ffmpeg ?? 'ffmpeg'
  const clipMaxSeconds = o.clipMaxSeconds ?? 30
  const clipMaxBytes = o.clipMaxBytes ?? 2_000_000
  const overrides = o.callsigns ?? []
  let heardAs = new Map<string, string[]>()
  const persona = o.persona ?? null
  const conversation = (): Conversation => persona?.conversation() ?? { character: null, entries: [] }
  const voice = (): VoiceStatus => ({ stt: stt.status(), tts: tts.status(), ...(persona ? { persona: persona.status() } : {}) })
  /** The voice status as last pushed to the HUDs, so speech requests push only a change. */
  let voiceSent = JSON.stringify(voice())
  /** Pushes the voice status to every HUD: when it differs from the last push, or always (`force`) for a provider's own status event. */
  const pushVoice = (force = false) => {
    const v = voice()
    const s = JSON.stringify(v)
    if (!force && s === voiceSent) return
    voiceSent = s
    broadcast({ type: 'voice', voice: v, status })
  }
  let build: BuildInfo = { id: null, reload: !!o.devReload }
  const devices = o.devices ?? new DeviceStore({ file: null, legacyToken: o.token ?? null, log })
  const pairing = o.pairing ?? new PairingRequests({ devices, log })

  const refuseIp = (ip: string) => {
    if (refusedIps.has(ip)) return
    refusedIps.add(ip)
    log(`gate: refused ${ip}: not loopback and not in allowIps. If that is the headset, add "${ip}" to allowIps and restart (logged once per address)`)
  }

  // Refusals a client can repeat at will are logged once a minute per
  // address and kind, so a loop on the headset cannot flood the log.
  const noted = new Map<string, number>()
  const noteOnce = (key: string, line: string) => {
    const now = Date.now()
    if (now - (noted.get(key) ?? 0) < 60_000) return
    if (noted.size > 1000) noted.clear()
    noted.set(key, now)
    log(`${line} (logged once a minute)`)
  }

  /** 429: this client is going too fast. A transcribe answer keeps the VoiceReply shape, so the HUD shows the reason as it does for any clip. */
  function tooMany(res: ServerResponse, path: string, ip: string, kind: string, why: string, retryAfterS: number): void {
    noteOnce(`${kind}:${ip}`, `limits: ${ip}: ${why} (${path})`)
    const headers = { 'retry-after': String(retryAfterS) }
    if (path === '/api/transcribe') return sendJson(res, 429, { transcript: { ok: false, reason: 'busy', error: why, provider: stt.name, audioMs: null, peakDb: null }, interpretation: null } satisfies VoiceReply, headers)
    return sendJson(res, 429, { error: why }, headers)
  }

  /** 503: the bridge is already doing as much of this as it will. */
  function busy(res: ServerResponse, err: Busy): void {
    noteOnce(`busy:${err.message}`, `limits: ${err.message}`)
    return sendJson(res, 503, { error: err.message }, { 'retry-after': BUSY_RETRY_S })
  }

  // ---------------------------------------------------------------- HTTP
  async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    let rel: string
    try {
      rel = PAGES[path] ?? decodeURIComponent(path.slice(1))
    } catch (err) {
      throw new HttpError(400, `the path cannot be read: ${(err as Error).message}`)
    }
    if (rel.includes('\0')) return sendJson(res, 404, { error: 'not found' })
    const file = normalize(join(o.clientDir, rel))
    if (file !== o.clientDir && !file.startsWith(o.clientDir + sep)) return sendJson(res, 404, { error: 'not found' })
    let data: Buffer
    try {
      data = await readFile(file)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'EISDIR') {
        if (PAGES[path]) log(`static: ${rel} missing from ${o.clientDir}; run npm run build`)
        return sendJson(res, 404, { error: PAGES[path] ? `client not built (${rel} missing); run npm run build` : 'not found' })
      }
      throw err
    }
    const type = TYPES[extname(file)] ?? 'application/octet-stream'
    res.writeHead(200, {
      'content-type': type,
      'cache-control': type.startsWith('text/html') ? 'no-store' : 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      // Cross-origin isolation, so the probe can say whether WASM threads
      // (SharedArrayBuffer) would work for in-browser speech models.
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
      ...(type.startsWith('text/html') ? { 'content-security-policy': CSP } : {}),
    })
    res.end(req.method === 'HEAD' ? undefined : data)
  }

  /**
   * The gate's first two steps for an API request or a theme image: a
   * same-origin request, within this client's request budget. False once the
   * refusal has been answered.
   */
  function admit(req: IncomingMessage, res: ServerResponse, path: string, ip: string): boolean {
    if (!originOk(req)) return (sendJson(res, 403, { error: 'not from this origin' }), false)
    const over = apiBudget.take(ip)
    if (over) return (tooMany(res, path, ip, 'api', `over ${limits.apiPerMinute} requests a minute; try again in ${over.retryAfterS} s`, over.retryAfterS), false)
    return true
  }

  /**
   * The whole gate for a request that needs a token: admit(), then a paired
   * device's token or the legacy one, noted as seen. The credential, or null
   * once the refusal has been answered.
   */
  function authorise(req: IncomingMessage, res: ServerResponse, path: string, ip: string): Credential | null {
    if (!admit(req, res, path, ip)) return null
    const cred = devices.match(tokenOf(req))
    if (!cred) {
      noteOnce(`token:${ip}`, `gate: ${req.method} ${path} from ${ip}: missing, wrong or revoked token`)
      sendJson(res, 401, { error: TOKEN_REFUSED })
      return null
    }
    devices.seen(cred)
    return cred
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL, ip: string): Promise<void> {
    const path = url.pathname
    // Auto-pairing (deprecated): hands the legacy token to any allowed
    // address that asks. It answers only when autoPair is on, and the address
    // check has already passed, so with autoPair on the allow list alone
    // decides who may use the bridge.
    if (path === '/api/pair' && req.method === 'POST') {
      if (!admit(req, res, path, ip)) return
      if (!o.autoPair) return sendJson(res, 403, { error: 'auto-pairing is off; pair with the code this page shows' })
      const token = devices.ensureLegacy()
      log(`pair: gave the legacy token to ${ip} (autoPair is on)`)
      return sendJson(res, 200, { token })
    }
    // The handshake, by which a browser with no token gets one.
    if (path.startsWith('/api/pair/')) return admit(req, res, path, ip) ? pairRoute(req, res, url, ip) : undefined
    const cred = authorise(req, res, path, ip)
    if (!cred) return
    if (HEAVY.has(path)) {
      const h = heavyBudget.take(ip)
      if (h) return tooMany(res, path, ip, 'heavy', `over ${limits.heavyPerMinute} voice and transcript requests a minute; try again in ${h.retryAfterS} s`, h.retryAfterS)
    }
    if (path === '/api/health' && req.method === 'GET') return sendJson(res, 200, { ok: true, backend: status })
    if (path === '/api/fleet' && req.method === 'GET') return sendJson(res, 200, { status, fleet: lastFleet })
    if (path === '/api/unpair' && req.method === 'POST') return unpairRoute(res, cred, ip)
    if (path === '/api/probe' && req.method === 'POST' && url.searchParams.get('log') === 'instrument') return instrumentRoute(req, res, ip)
    if (path === '/api/probe' && req.method === 'POST') {
      const d = await readBody(req, JSON_MAX)
      const line = JSON.stringify({ at: new Date().toISOString(), ip, ua: req.headers['user-agent'] ?? null, results: d }) + '\n'
      const full = logBudget.take(ip, Buffer.byteLength(line))
      if (full) return tooMany(res, path, ip, 'log', `over ${Math.round(limits.logBytesPerMinute / 1024)} kB of log a minute; try again in ${full.retryAfterS} s`, full.retryAfterS)
      await appendLog(o.probeLog, line)
      log(`probe: results from ${ip} appended to ${o.probeLog}`)
      return sendJson(res, 200, { ok: true, logged: o.probeLog })
    }
    if (path === '/api/send' && req.method === 'POST') return sendRoute(req, res, ip)
    if (path === '/api/transcript' && req.method === 'GET') return transcriptRoute(res, url.searchParams)
    if (path === '/api/voice' && req.method === 'GET') return sendJson(res, 200, voice())
    if (path === '/api/transcribe' && req.method === 'POST') return transcribeRoute(req, res, url.searchParams, ip)
    if (path === '/api/interpret' && req.method === 'POST') {
      const body = asObject(await readBody(req, JSON_MAX))
      if (typeof body.text !== 'string' || body.text.length > TEXT_MAX) return sendJson(res, 400, { error: `text: the words to interpret, at most ${TEXT_MAX} characters` })
      const m = await meaning(body.text, contextOf(body.context), focusOf(body.focus))
      return sendJson(res, 200, { interpretation: m.interpretation, ...(m.line ? { line: m.line } : {}) })
    }
    if (path === '/api/speak' && req.method === 'POST') return speakRoute(req, res)
    if (path === '/api/line' && req.method === 'GET') return lineRoute(res, url.searchParams)
    if (path === '/api/conversation' && req.method === 'GET') return sendJson(res, 200, conversation())
    if (path === '/api/character' && req.method === 'POST') return characterRoute(req, res, ip)
    if (path === '/api/themes' && req.method === 'GET') return sendJson(res, 200, o.themes ? await o.themes.list() : { themes: [], invalid: [] })
    return sendJson(res, 404, { error: 'no such route' })
  }

  /**
   * GET /themes/<name>/<file>: an image of a theme pack. Behind the same gate
   * as the API (origin, budget, token): packs are private config. Names and
   * files must match the pack patterns exactly, so nothing encoded or dotted
   * reaches the disk, and only a file the pack's theme.json lists is served.
   */
  async function themeAsset(req: IncomingMessage, res: ServerResponse, path: string, ip: string): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' })
    if (!authorise(req, res, path, ip)) return
    const parts = path.split('/')
    if (parts.length !== 4 || !o.themes) return sendJson(res, 404, { error: 'not found' })
    const a = await o.themes.asset(parts[2]!, parts[3]!)
    if (!a.ok) {
      noteOnce(`theme-asset:${ip}:${a.status}`, `themes: ${req.method} ${path.slice(0, 120)} from ${ip}: ${a.status} ${a.error}`)
      return sendJson(res, a.status, { error: a.error })
    }
    const headers = {
      'content-type': a.type,
      'cache-control': 'private, max-age=300',
      etag: a.etag,
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
    }
    if (req.headers['if-none-match'] === a.etag) {
      res.writeHead(304, headers)
      res.end()
      return
    }
    res.writeHead(200, { ...headers, 'content-length': String(a.data.length) })
    res.end(req.method === 'HEAD' ? undefined : a.data)
  }

  // ---------------------------------------------------------------- pairing
  const approveUrl = () => `https://localhost:${(server.address() as AddressInfo | null)?.port ?? 8443}/pair`
  /**
   * The approval page and its routes answer this machine only, whatever
   * allowIps says: the headset must never approve itself. Loopback by address
   * and by Host name, so a site whose name points at 127.0.0.1 is not taken
   * for the bridge's own origin.
   */
  const onThisMachine = (req: IncomingMessage, ip: string) => isLoopback(ip) && loopbackHost(req)
  const PAIR_DIR = join(import.meta.dirname, '..', 'pair')
  const PAIR_FILES: Record<string, string> = { '/pair': 'index.html', '/pair/': 'index.html', '/pair/pair.js': 'pair.js' }
  const PAIR_BODY_MAX = 4096

  async function pairPage(req: IncomingMessage, res: ServerResponse, path: string, ip: string): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' })
    if (!onThisMachine(req, ip)) {
      noteOnce(`pair-page:${ip}`, `pair: refused the approval page to ${ip}: it opens only on this machine`)
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(`The pairing page opens only on the bridge's own machine. Open ${approveUrl()} there.\n`)
      return
    }
    const name = PAIR_FILES[path]
    if (!name) return sendJson(res, 404, { error: 'not found' })
    const data = await readFile(join(PAIR_DIR, name))
    const type = TYPES[extname(name)] ?? 'application/octet-stream'
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cross-origin-opener-policy': 'same-origin',
      ...(type.startsWith('text/html') ? { 'content-security-policy': CSP } : {}),
    })
    res.end(req.method === 'HEAD' ? undefined : data)
  }

  async function pairRoute(req: IncomingMessage, res: ServerResponse, url: URL, ip: string): Promise<void> {
    const path = url.pathname
    const secretHeader = req.headers['x-pair-secret']
    const secret = typeof secretHeader === 'string' ? secretHeader : null

    // The device's side answers any allowed address, with no token.
    if (path === '/api/pair/request' && req.method === 'POST') {
      const body = asObject(await readBody(req, PAIR_BODY_MAX))
      const replaces = typeof body.replaces === 'string' && secret ? { id: body.replaces, secret } : null
      const r = pairing.create(ip, req.headers['user-agent'], replaces)
      if (!r.ok) {
        noteOnce(`pair-req:${ip}`, `pair: refused a new code for ${ip}: ${r.error}`)
        return sendJson(res, r.status, { error: r.error }, { 'retry-after': String(r.retryAfterS) })
      }
      // The code and the secret stay out of the log. The code is read off the device itself.
      const words = `${r.label} at ${ip} wants to pair; enter its code at ${approveUrl()}`
      log(`pair: ${words}`)
      o.notify?.(words)
      return sendJson(res, 200, { id: r.id, secret: r.secret, code: r.code, label: r.label, expiresInMs: r.expiresInMs, approveUrl: approveUrl() } satisfies PairTicket)
    }
    if (path === '/api/pair/status' && req.method === 'GET') {
      const r = pairing.poll(url.searchParams.get('id') ?? '', secret, ip)
      if (r.state === 'pending') return sendJson(res, 200, { state: 'pending', expiresInMs: r.expiresInMs } satisfies PairStatus)
      if (r.state === 'approved') {
        log(`pair: ${r.device.label} at ${ip} collected its token; paired`)
        return sendJson(res, 200, { state: 'approved', token: r.token, label: r.device.label } satisfies PairStatus)
      }
      return sendJson(res, 404, { state: 'gone', error: 'no such pairing request: it expired, was used, or never existed; ask for a new code' } satisfies PairStatus)
    }

    // The approval side answers this machine only, and a change must come from a page on this origin.
    if (!onThisMachine(req, ip)) {
      noteOnce(`pair-admin:${ip}`, `pair: refused ${req.method} ${path} from ${ip}: approving and revoking work only on this machine`)
      return sendJson(res, 403, { error: `pairing is approved on the bridge's own machine only; open ${approveUrl()} there` })
    }
    // A page always sends Origin on a POST; with none, this is not the approval page.
    if (req.method !== 'GET' && !req.headers.origin) return sendJson(res, 403, { error: 'no Origin header: approve and revoke from the approval page' })
    if (path === '/api/pair/devices' && req.method === 'GET') {
      // waiting() first, because it sweeps expired requests, which can unpair a device that never collected its token.
      const waiting = pairing.waiting()
      return sendJson(res, 200, { devices: devices.list(), legacy: { active: devices.legacyActive() }, waiting, autoPair: !!o.autoPair })
    }
    if (path === '/api/pair/approve' && req.method === 'POST') {
      const body = asObject(await readBody(req, PAIR_BODY_MAX))
      if (typeof body.code !== 'string' || body.code.length > 40) return sendJson(res, 400, { error: 'code: the code the device shows, like ACD-347' })
      const r = pairing.approve(body.code)
      if (!r.ok) {
        if (r.status === 429) noteOnce('pair-approve-limit', `pair: approval page: ${r.error}`)
        else log(`pair: approval page: ${r.status === 400 ? 'something that is not a code was typed' : 'a code that no device shows was typed'}`)
        return sendJson(res, r.status, { error: r.error }, r.retryAfterS ? { 'retry-after': String(r.retryAfterS) } : {})
      }
      log(`pair: approved ${r.device.label} at ${r.device.ip}; it collects its token on its next poll`)
      return sendJson(res, 200, { ok: true, device: r.device })
    }
    if (path === '/api/pair/revoke' && req.method === 'POST') {
      const body = asObject(await readBody(req, PAIR_BODY_MAX))
      if (body.legacy === true) {
        const was = devices.revokeLegacy()
        if (was) log(`pair: revoked the legacy token${o.autoPair ? '; autoPair is on, so the next browser that asks gets a new one' : ''}`)
        return sendJson(res, 200, { ok: true, revoked: was ? 'legacy' : null, legacy: { active: devices.legacyActive() } })
      }
      if (typeof body.id !== 'string' || !body.id) return sendJson(res, 400, { error: 'id: the device to revoke, or legacy: true' })
      const d = devices.revoke(body.id)
      if (!d) return sendJson(res, 404, { error: 'no paired device with that id' })
      log(`pair: revoked ${d.label} (paired from ${d.ip})`)
      return sendJson(res, 200, { ok: true, device: d })
    }
    return sendJson(res, 404, { error: 'no such route' })
  }

  /**
   * POST /api/unpair: a device unpairs itself, with the same effect as Revoke
   * on the approval page (its token stops working, its sockets close). The
   * legacy token is shared by every browser holding it, so one of them cannot
   * revoke it for the rest; that is done on the approval page.
   */
  function unpairRoute(res: ServerResponse, cred: Credential, ip: string): void {
    if (cred.kind === 'legacy') {
      log(`pair: ${ip} asked to unpair with the legacy token; nothing revoked`)
      return sendJson(res, 200, { revoked: false, reason: `the legacy token is shared by every browser that has it; revoke it on the pairing page at ${approveUrl()}` })
    }
    const d = devices.revoke(cred.id)
    log(d ? `pair: ${d.label} (paired from ${d.ip}) unpaired itself from ${ip}` : `pair: ${ip} asked to unpair a device that was already gone`)
    return sendJson(res, 200, { revoked: true })
  }

  // The two logs: writes to one file go one at a time, so a rotation never
  // races an append.
  const logChains = new Map<string, Promise<void>>()
  function appendLog(file: string, text: string): Promise<void> {
    const write = (logChains.get(file) ?? Promise.resolve()).then(() => appendRotating(file, text, limits.logFileMax))
    // The next write waits for this one whether it worked or not; this write's own caller gets its error as well.
    logChains.set(
      file,
      write.catch((err: unknown) => log(`log: a write to ${file} failed:`, (err as Error).message)),
    )
    return write
  }

  /**
   * Instrument mode's measurements: session start and end, visibility and
   * blur events, mic state, frame times, renderer memory. The headset sends
   * them in batches; each event becomes one JSON line, stamped with the
   * bridge's clock and the sender's address.
   */
  const instrumentLog = o.instrumentLog ?? join(dirname(o.probeLog), 'instrument.log')
  async function instrumentRoute(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    const body = asObject(await readBody(req, JSON_MAX))
    const events = body.events
    if (!Array.isArray(events) || events.length > EVENTS_MAX || !events.every(e => typeof e === 'object' && e !== null && !Array.isArray(e))) return sendJson(res, 400, { error: `events: an array of at most ${EVENTS_MAX} objects` })
    const at = new Date().toISOString()
    const lines = events.map(e => JSON.stringify(Object.assign({ at, ip }, e, { at, ip }))).join('\n')
    if (lines) {
      const full = logBudget.take(ip, Buffer.byteLength(lines) + 1)
      if (full) return tooMany(res, '/api/probe', ip, 'log', `over ${Math.round(limits.logBytesPerMinute / 1024)} kB of log a minute; try again in ${full.retryAfterS} s`, full.retryAfterS)
      await appendLog(instrumentLog, lines + '\n')
    }
    return sendJson(res, 200, { ok: true, logged: events.length, file: instrumentLog })
  }

  const contextOf = (v: unknown): VoiceContext => (CONTEXTS.includes(v as VoiceContext) ? (v as VoiceContext) : 'none')
  /** The session the HUD has open in its reader, as the client names it. */
  const focusOf = (v: unknown): string | null => (typeof v === 'string' && v && v.length <= 200 ? v : null)

  /**
   * Clip in, transcript and interpretation out. Every way it can fail comes
   * back as its own reason with an HTTP status to match, so the HUD never
   * shows "heard nothing" for a model that is down or a clip it could not read.
   * Reading, decoding and transcribing hold one of the clip slots; working
   * out what the words mean (which may ask the classifier) happens after.
   */
  async function transcribeRoute(req: IncomingMessage, res: ServerResponse, q: URLSearchParams, ip: string): Promise<void> {
    const t0 = Date.now()
    const fail = (http: number, t: Omit<Extract<Transcript, { ok: false }>, 'ok' | 'provider'>, headers: Record<string, string> = {}) => {
      log(`stt: ${ip}: ${t.reason}: ${t.error}`)
      const reply: VoiceReply = { transcript: { ok: false, provider: stt.name, ...t }, interpretation: null }
      return sendJson(res, http, reply, headers)
    }
    const type = String(req.headers['content-type'] ?? '')
    if (!/^(audio\/|video\/webm|application\/octet-stream)/.test(type)) {
      req.resume()
      return fail(415, { reason: 'bad-audio', error: `send the clip as audio/*, not ${type || 'no content type'}`, audioMs: null, peakDb: null })
    }
    /** The words in the clip, or null once a failure has been answered. */
    const hear = async (): Promise<{ text: string; audioMs: number; sttMs: number } | null> => {
      let clip: Buffer
      try {
        clip = await readRaw(req, clipMaxBytes)
      } catch (err) {
        if (err instanceof HttpError && err.status === 413) return (fail(413, { reason: 'too-big', error: `the clip is over ${Math.round(clipMaxBytes / 1000)} kB`, audioMs: null, peakDb: null }), null)
        throw err
      }
      // Refuse before decoding when the model cannot run anyway.
      const st = stt.status()
      if (st.state !== 'ready') return (fail(503, { reason: 'unavailable', error: `transcription unavailable: ${st.error ?? (st.state === 'loading' ? `the ${st.provider} model is still loading` : st.state)}`, audioMs: null, peakDb: null }), null)
      let pcm: Buffer
      let audioMs: number
      try {
        ;({ pcm, ms: audioMs } = await decodeClip(clip, { ffmpeg, maxSeconds: clipMaxSeconds }))
      } catch (err) {
        if (err instanceof ClipError) return (fail(err.reason === 'too-long' ? 413 : 422, { reason: err.reason, error: err.message, audioMs: null, peakDb: null }), null)
        throw err
      }
      const lv = levels(pcm)
      if (lv.peakDb < SILENCE_PEAK_DB) return (fail(422, { reason: 'silent', error: `the clip is silent (loudest ${Number.isFinite(lv.peakDb) ? `${lv.peakDb} dBFS` : 'digital silence'}); is the mic muted?`, audioMs, peakDb: Number.isFinite(lv.peakDb) ? lv.peakDb : null }), null)
      let text: string
      let sttMs: number
      try {
        ;({ text, ms: sttMs } = await stt.transcribe(pcm))
      } catch (err) {
        if (err instanceof SttUnavailable) return (fail(503, { reason: 'unavailable', error: `transcription unavailable: ${err.message}`, audioMs, peakDb: lv.peakDb }), null)
        if (err instanceof SttBusy) return (fail(429, { reason: 'busy', error: err.message, audioMs, peakDb: lv.peakDb }), null)
        return (fail(502, { reason: 'failed', error: (err as Error).message, audioMs, peakDb: lv.peakDb }), null)
      }
      if (!text.trim()) return (fail(422, { reason: 'no-words', error: `heard sound (loudest ${lv.peakDb} dBFS) but no words in it`, audioMs, peakDb: lv.peakDb }), null)
      return { text: text.trim(), audioMs, sttMs }
    }
    let heard: Awaited<ReturnType<typeof hear>>
    try {
      heard = await pools.clips.run(hear)
    } catch (err) {
      if (!(err instanceof Busy)) throw err
      // The upload is left unread; Node drains it once this answer is sent.
      // The same wait as the other pools' refusals (busy below).
      return fail(503, { reason: 'busy', error: err.message, audioMs: null, peakDb: null }, { 'retry-after': BUSY_RETRY_S })
    }
    if (!heard) return
    const transcript: Transcript = { ok: true, text: heard.text, provider: stt.name, audioMs: heard.audioMs, sttMs: heard.sttMs, totalMs: Date.now() - t0 }
    const m = await meaning(transcript.text, contextOf(q.get('context')), focusOf(q.get('focus')))
    log(`stt: ${ip}: ${heard.audioMs} ms clip, ${heard.sttMs} ms model, ${Date.now() - t0} ms total -> ${m.interpretation.kind}${m.line ? ' (line to follow)' : ''}`)
    const reply: VoiceReply = { transcript, interpretation: m.interpretation, ...(m.line ? { line: m.line } : {}) }
    return sendJson(res, 200, reply)
  }

  /**
   * The grammar's reading of the words. "voice X" and "be X" are acted on
   * here, so the reply is already spoken in the new voice. In character mode
   * speech the grammar could not place is classified (bounded by the
   * classify timeout), and a line is started; nobody waits for the line.
   */
  async function meaning(text: string, context: VoiceContext, focusId: string | null): Promise<{ interpretation: Interpretation; line: PendingLine | null }> {
    persona?.heardVoice()
    const characters = persona ? persona.characters().map(c => ({ name: c.name, heardAs: c.heardAs })) : []
    let i = interpret({ transcript: text, fleet: lastFleet, heardAs, context, focusId, voices: tts.voices?.() ?? [], voice: tts.voice?.() ?? null, characters, character: persona?.current()?.name ?? null, now: Date.now() })
    if (i.kind === 'voice' && i.voice) i = changeVoice(i.voice, i)
    if (i.kind === 'character' && i.changed && persona) {
      try {
        persona.select(i.character)
      } catch (err) {
        log('persona: could not change character:', (err as Error).message)
        i = { kind: 'character', character: persona.current()?.name ?? null, changed: false, say: `Could not change character: ${(err as Error).message}.` }
      }
    }
    if (!persona?.current()) return { interpretation: i, line: null }
    // With a card armed the grammar's answer stands: a model must never turn
    // words he said over a counting card into a new target or a new message.
    if (context !== 'confirm') i = await persona.classify(text, i, () => lastFleet, Date.now)
    return { interpretation: i, line: persona.startLine(i, text, () => lastFleet) }
  }

  /**
   * POST /api/character { name }: the character buttons. Turns a character on
   * (null: operator mode) and answers as the voice routes do for "be X", so
   * the HUD handles both the same way. Words only: nothing here sends.
   */
  async function characterRoute(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    const body = asObject(await readBody(req, JSON_MAX))
    const name = body.name
    if (!('name' in body) || (name !== null && (typeof name !== 'string' || !name.trim() || name.length > 100))) return sendJson(res, 400, { error: 'name: a character from the bridge config, or null for operator mode' })
    const want = name === null ? null : name.trim().toLowerCase()
    if (want !== null && !persona?.characters().some(c => c.name === want)) return sendJson(res, 404, { error: persona?.characters().length ? `no character called ${JSON.stringify(want.slice(0, 40))}` : 'no characters are set up in the bridge config' })
    const cur = persona?.current()?.name ?? null
    const i: Extract<Interpretation, { kind: 'character' }> =
      want === null ? { kind: 'character', character: null, changed: cur !== null, say: cur ? 'Operator mode.' : 'Already in operator mode.' } : characterSwitch(want, cur)
    if (!persona) return sendJson(res, 200, { interpretation: i } satisfies CharacterReply)
    // A press counts as him speaking: unprompted lines hold back for a moment, as they do after a hold.
    persona.heardVoice()
    if (i.changed) {
      try {
        persona.select(want)
      } catch (err) {
        log('persona: could not change character:', (err as Error).message)
        return sendJson(res, 409, { error: `could not change character: ${(err as Error).message}` })
      }
    }
    log(`persona: ${ip} pressed ${want ?? 'operator'}${i.changed ? '' : ' (no change)'}`)
    // The line is written from the words the button stands for, as if he had said them.
    const line = persona.current() ? persona.startLine(i, want === null ? 'operator mode' : `be ${want}`, () => lastFleet) : null
    return sendJson(res, 200, { interpretation: i, ...(line ? { line } : {}) } satisfies CharacterReply)
  }

  function changeVoice(name: string, i: Interpretation): Interpretation {
    try {
      if (!tts.select) throw new Error('this text-to-speech provider has one voice')
      tts.select(name)
      pushVoice()
      return i
    } catch (err) {
      log('tts: could not change voice:', (err as Error).message)
      return { kind: 'voice', voice: null, say: `Could not change voice: ${(err as Error).message}.` }
    }
  }

  /** GET /api/line?id=<id>: the character's line for an answer, or the plain one once the line timeout has passed. */
  async function lineRoute(res: ServerResponse, q: URLSearchParams): Promise<void> {
    const id = q.get('id') ?? ''
    if (!/^[0-9a-f]{16}$/.test(id)) return sendJson(res, 400, { error: 'id: the line id from the voice reply' })
    const line = persona?.line(id)
    if (!line) return sendJson(res, 404, { error: 'no such line, or it is over a minute old' })
    return sendJson(res, 200, await line)
  }

  async function speakRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = asObject(await readBody(req, JSON_MAX))
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > TEXT_MAX) return sendJson(res, 400, { error: `text: what to say, at most ${TEXT_MAX} characters` })
    const text = body.text
    try {
      // Uncached speech runs say and ffmpeg, or a paid fish.audio request; only a few at once.
      const sp = await pools.speech.run(() => tts.speak(text))
      res.writeHead(200, { 'content-type': sp.mime, 'content-length': String(sp.audio.length), 'cache-control': 'no-store' })
      res.end(sp.audio)
    } catch (err) {
      if (err instanceof Busy) return busy(res, err)
      if (err instanceof TtsUnavailable) return sendJson(res, 503, { error: `speech unavailable: ${err.message}` })
      log('tts: failed:', (err as Error).message)
      return sendJson(res, 502, { error: `speech failed: ${(err as Error).message}` })
    } finally {
      // A request is where speech finds out it is failing (fish.audio falling
      // back to say) or has recovered; open HUDs hear of it only if it changed.
      pushVoice()
    }
  }

  // Transcript reads start a CLI process each. Two views polling the same
  // session share one read, and only a few run at once (the transcript pool).
  const reading = new Map<string, Promise<SessionTranscript>>()
  function readTranscript(id: string, limit: number): Promise<SessionTranscript> {
    const key = `${limit}|${id}`
    const inflight = reading.get(key)
    if (inflight) return inflight
    const p = pools.transcript.run(() => o.backend.transcript(id, limit)).finally(() => reading.delete(key))
    reading.set(key, p)
    return p
  }

  /** GET /api/transcript?session=<id>&limit=<n>: the session's last turns in full, for the reader. */
  async function transcriptRoute(res: ServerResponse, q: URLSearchParams): Promise<void> {
    if (!o.backend.capabilities.transcript) return sendJson(res, 501, { error: `${o.backend.name} has no full transcripts` })
    const id = q.get('session') ?? ''
    if (!id || id.length > 200) return sendJson(res, 400, { error: 'session: which session' })
    const limit = Math.min(20, Math.max(1, Math.floor(Number(q.get('limit'))) || 10))
    try {
      return sendJson(res, 200, await readTranscript(id, limit))
    } catch (err) {
      const e = err as Error
      if (err instanceof Busy) return busy(res, err)
      if (err instanceof SendRefused) return sendJson(res, err.status, { error: e.message })
      if (err instanceof UnsupportedError) return sendJson(res, 501, { error: e.message })
      log(`transcript: ${id.slice(0, 40)}: ${e.message}`)
      return sendJson(res, 502, { error: `backend: ${e.message}` })
    }
  }

  // A retried send is answered from here, not sent again (send-ledger.ts).
  const ledger = new SendLedger(limits.sendIdsMs, limits.sendIdsMax)

  async function sendRoute(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    if (!o.backend.capabilities.send) return sendJson(res, 501, { error: `${o.backend.name} cannot send` })
    const body = asObject(await readBody(req, JSON_MAX))
    // The gate checked the token when the request began. A device revoked
    // while its body was arriving must not send, so it is checked again here,
    // after the last await before the backend call: from here to that call
    // nothing waits. Refused this way, no rate limit slot is spent.
    if (!devices.match(tokenOf(req))) {
      log(`send: ${ip}: the token was revoked while the request arrived; refused, nothing sent`)
      return sendJson(res, 401, { error: TOKEN_REFUSED })
    }
    const sessionId = body.sessionId
    const text = body.text
    if (typeof sessionId !== 'string' || !sessionId) return sendJson(res, 400, { error: 'sessionId: which session' })
    if (typeof text !== 'string' || !text.trim()) return sendJson(res, 400, { error: 'text: what to send' })
    if (body.requestId !== undefined && (typeof body.requestId !== 'string' || !SEND_REQUEST_ID.test(body.requestId))) return sendJson(res, 400, { error: 'requestId: 8 to 64 letters, digits, "-" or "_", one per message' })
    const requestId = body.requestId as string | undefined
    const reply = (x: SendOutcome, repeat: boolean) => sendJson(res, x.status, repeat ? { ...x.body, repeat: true } : x.body, x.headers)
    const now = Date.now()
    const seen = ledger.check(requestId, sessionId, text, now)
    if (seen.kind === 'conflict') {
      log(`send: ${ip} reused request ${requestId!.slice(0, 16)} for a different message; refused, nothing sent`)
      return sendJson(res, 409, { error: 'requestId was already used for a different message; nothing was sent' })
    }
    if (seen.kind === 'repeat') {
      // Answered before the rate limit, which a repeat does not spend.
      log(`send: ${ip} repeated request ${requestId!.slice(0, 16)}; answering with the first outcome, nothing sent again`)
      return reply(await seen.outcome, true)
    }
    const limited = limiter.take(now)
    if (limited) {
      log(`send: rate limited ${ip}, retry in ${limited.retryAfterS} s`)
      return sendJson(res, 429, { error: `too many sends; try again in ${limited.retryAfterS} s` }, { 'retry-after': String(limited.retryAfterS) })
    }
    const outcome = (async (): Promise<SendOutcome> => {
      try {
        const r = await o.backend.send(sessionId, text, requestId)
        log(`send: ${text.length} chars to ${sessionId.slice(0, 40)} from ${ip}: ok`)
        noteSent(sessionId, text)
        return { status: 200, body: { ...r }, headers: {}, remember: true }
      } catch (err) {
        const e = err as Error
        log(`send: ${text.length} chars to ${sessionId.slice(0, 40)} from ${ip}: ${e.message}`)
        if (err instanceof SendRefused) return { status: err.status, body: { error: e.message }, headers: {}, remember: false }
        if (err instanceof UnsupportedError) return { status: 501, body: { error: e.message }, headers: {}, remember: false }
        // Anything else may have gone out (T3 took the send and its answer was
        // lost, the CLI timed out): the HUD is told the outcome is unknown,
        // with a 5xx kept apart from 501 and 502, which mean "not sent", and
        // a retry of it is answered, not sent.
        return { status: 504, body: { error: `backend: ${e.message}`, outcome: 'unknown' }, headers: {}, remember: true }
      }
    })()
    if (requestId) ledger.remember(requestId, seen.key, outcome, now)
    const out = await outcome
    if (!out.remember) {
      // Refused before anything went out (no such session, no send route): the
      // slot goes back, so a few refusals cannot use up the minute's sends. A
      // 504, whose message may have arrived, is remembered and keeps its slot.
      limiter.refund(now)
      if (requestId) ledger.forget(requestId)
    }
    return reply(out, false)
  }

  /** In character mode a message that reached the dispatcher joins the character's conversation, and its answer will be relayed. */
  function noteSent(sessionId: string, text: string): void {
    const d = lastFleet?.sessions.find(x => x.id === sessionId)
    if (!persona || d?.kind !== 'dispatcher') return
    try {
      if (persona.noteSentToDispatcher(text, d)) log('persona: waiting for the dispatcher to answer, to relay it')
    } catch (err) {
      // The message has gone; a failure here only costs the relay, so it must not turn the send into an error.
      log('persona: could not note the send to the dispatcher:', (err as Error).message)
    }
  }

  const server = createServer({ cert: o.cert, key: o.key }, (req, res) => {
    const ip = normaliseIp(req.socket.remoteAddress)
    if (!ipAllowed(ip, o.allowIps)) {
      refuseIp(ip)
      return sendJson(res, 403, { error: `this address (${ip}) may not use the bridge; add it to allowIps in the bridge config and restart` })
    }
    const url = requestUrl(req)
    if (url instanceof Error) {
      noteOnce(`url:${ip}`, `http: ${ip} sent a request target that is not a URL (${url.message}); answered 400`)
      return sendJson(res, 400, { error: 'the request target is not a URL' })
    }
    const path = url.pathname
    const handle = path.startsWith('/api/')
      ? api(req, res, url, ip)
      : path === '/pair' || path.startsWith('/pair/')
        ? pairPage(req, res, path, ip)
        : path.startsWith('/themes/')
          ? themeAsset(req, res, path, ip)
          : req.method === 'GET' || req.method === 'HEAD'
            ? serveStatic(req, res, path)
            : Promise.resolve(sendJson(res, 405, { error: 'method not allowed' }))
    handle.catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500
      if (status === 500) log(`error: ${req.method} ${path}:`, err)
      if (!res.headersSent) sendJson(res, status, { error: (err as Error).message })
      else res.end()
    })
  })
  server.on('tlsClientError', err => log('tls:', err.message))
  // A whole request, body included, must arrive within this (Node's default
  // is 5 minutes). A clip upload holds a clip slot while it arrives, so a
  // slow sender must not keep one for long; a 2 MB clip on the LAN takes
  // well under a second.
  server.requestTimeout = 60_000

  // ---------------------------------------------------------------- WebSocket
  // The sockets themselves, their caps, presence and heartbeat: ws-hub.ts.
  const hub = new WsHub({
    devices,
    perIp: limits.wsPerIp,
    total: limits.wsTotal,
    bufferMax: limits.wsBufferMax,
    log,
    greet: () => {
      const first: ServerMessage[] = [{ type: 'hello', status, build, voice: voice() }]
      if (lastFleet) first.push({ type: 'fleet', fleet: lastFleet, status })
      if (persona) first.push({ type: 'conversation', conversation: conversation(), status })
      return first
    },
  })
  server.on('upgrade', (req, socket, head) => {
    const ip = normaliseIp(req.socket.remoteAddress)
    const refuse = (code: number, why: string, detail = why, quiet = false) => {
      const line = `gate: websocket from ${ip} refused: ${detail}`
      if (quiet) noteOnce(`ws${code}:${ip}`, line)
      else log(line)
      // Node hands the raw socket over with no error listener; a reset while refusing must not become an uncaught error.
      socket.on('error', err => noteOnce(`wserr:${ip}`, `ws: ${ip}: socket error while refusing: ${err.message}`))
      socket.write(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      socket.destroy()
    }
    try {
      if (!ipAllowed(ip, o.allowIps)) {
        refuseIp(ip)
        return refuse(403, 'Forbidden')
      }
      const url = requestUrl(req)
      if (url instanceof Error) return refuse(400, 'Bad Request', `the request target is not a URL (${url.message})`, true)
      if (url.pathname !== '/ws') return refuse(404, 'Not Found')
      if (!originOk(req)) return refuse(403, 'Forbidden')
      const cred = devices.match(tokenOf(req))
      if (!cred) return refuse(401, 'Unauthorized')
      const full = hub.full(ip)
      if (full) return refuse(503, 'Service Unavailable', full, true)
      hub.accept(req, socket, head, ip, cred)
    } catch (err) {
      // Whatever went wrong, an upgrade from an allowed address must not take the bridge down.
      log(`ws: upgrade from ${ip} failed:`, err)
      socket.destroy()
    }
  })
  const broadcast = (m: ServerMessage) => hub.broadcast(m)

  // ---------------------------------------------------------------- backend
  const unsubscribe = o.backend.subscribe(u => {
    if (u.ok) {
      // The bridge has the last word on callsigns, whatever the adapter chose.
      const r = relabelFleet(u.fleet, overrides)
      const prev = lastFleet
      lastFleet = r.fleet
      persona?.fleetChanged(prev, lastFleet)
      heardAs = r.heardAs
      status = { ...status, ok: true, error: null, lastOkAt: Date.now() }
      broadcast({ type: 'fleet', fleet: lastFleet, status })
    } else {
      status = { ...status, ok: false, error: u.error }
      broadcast({ type: 'status', status })
    }
  })

  const unVoice = stt.onStatus(() => pushVoice(true))
  // A character change also changes the voice: apply() selects it before it notifies.
  const unPersona = persona?.onStatus(() => pushVoice(true)) ?? (() => {})
  // Unprompted lines go only to HUDs that are listening. They are spoken there and never acted on.
  persona?.setAudience(() => hub.audience())
  // Relays read the dispatcher's answer here, read-only, so nothing under
  // persona/ touches the backend. They share the transcript pool; a busy pool
  // throws, and the relay falls back to the fleet's clips.
  persona?.setTurnReader(async id => {
    if (!o.backend.capabilities.transcript) return null
    try {
      return (await readTranscript(id, 12)).turns
    } catch (err) {
      if (err instanceof SendRefused || err instanceof UnsupportedError) return null
      throw err
    }
  })
  const unConversation = persona?.onConversation(c => broadcast({ type: 'conversation', conversation: c, status })) ?? (() => {})
  const unAnnounce =
    persona?.onAnnounce(line => {
      const to = hub.listeners()
      log(`persona: speaking up to ${to.length} HUD${to.length === 1 ? '' : 's'}: ${line.source}`)
      for (const ws of to) hub.push(ws, { type: 'line', line, status })
    }) ?? (() => {})

  // ---------------------------------------------------------------- build
  // The build id is a hash of the built index.html, which names every hashed
  // asset, so any client change gives a new id. In dev the HUD reloads on it.
  const indexHtml = join(o.clientDir, 'index.html')
  const readBuild = async () => {
    try {
      const id = createHash('sha256').update(await readFile(indexHtml)).digest('hex').slice(0, 12)
      if (id === build.id) return
      const first = build.id === null
      build = { ...build, id }
      log(`build: client ${id}${first ? '' : ' (changed)'}`)
      if (!first) broadcast({ type: 'build', build, status })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      // Mid-rebuild the file can be missing for a moment; the next change brings it back.
      if (code !== 'ENOENT') log('build: cannot read', indexHtml, (err as Error).message)
    }
  }
  void readBuild()
  if (o.devReload) watchFile(indexHtml, { interval: 400 }, () => void readBuild())

  return {
    server,
    status: () => status,
    fleet: () => lastFleet,
    close: async () => {
      unsubscribe()
      unVoice()
      unPersona()
      unAnnounce()
      unConversation()
      if (o.devReload) unwatchFile(indexHtml)
      hub.close()
      const closed = new Promise<void>(ok => server.close(() => ok()))
      server.closeAllConnections()
      await closed
    },
  }
}
