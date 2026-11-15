// The bridge's HTTPS server: the built client, a small JSON API and the
// HUD's WebSocket, all behind the gate in gate.ts.
//
//   GET  /            the HUD                      address check only
//   GET  /probe       the headset probe page       address check only
//   POST /api/pair    the token, if autoPair is on address check + origin
//   GET  /api/health  backend status               address check + token
//   GET  /api/fleet   the last fleet read          address check + token
//   POST /api/probe   append probe results to the log
//   POST /api/probe?log=instrument  { events: [...] } -> one line each in instrument.log
//   POST /api/send    { sessionId, text } -> backend.send, rate limited
//   GET  /api/transcript?session=<id>  a session's last turns in full
//   POST /api/transcribe   a recorded clip -> transcript and what it means
//   POST /api/interpret    { text, context, focus } -> what it means (no audio)
//   POST /api/speak   { text } -> WebM/Opus speech
//   GET  /api/voice   speech-to-text and text-to-speech status
//   WS   /ws          hello, fleet, status, voice and build pushes
//                                                  address check + token + origin
//
// Every /api/ route but /api/pair needs the token and a same-origin request.
// Nothing on the voice routes sends anything: the HUD shows a card with a
// countdown, and calls /api/send when it ends or on "Send now", unless the
// person cancels first.

import { createHash } from 'node:crypto'
import { unwatchFile, watchFile } from 'node:fs'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import type { BackendStatus, BuildInfo, Fleet, Interpretation, ServerMessage, Transcript, VoiceContext, VoiceReply, VoiceStatus } from '../../shared/protocol.ts'
import { ipAllowed, normaliseIp, originOk, RateLimiter, tokenMatches, tokenOf, WS_PROTOCOL } from './gate.ts'
import { SendRefused, UnsupportedError, type SessionBackend } from './backend/types.ts'
import { relabelFleet, type CallsignOverride } from './backend/callsign.ts'
import { ClipError, decodeClip, levels, SILENCE_PEAK_DB } from './voice/audio.ts'
import { interpret } from './voice/grammar.ts'
import { NoStt, SttBusy, SttUnavailable, type SttProvider } from './voice/stt.ts'
import { NoTts, TtsUnavailable, type TtsProvider } from './voice/tts.ts'

export interface BridgeOptions {
  backend: SessionBackend
  token: string
  allowIps: string[]
  /** Hand the token to any allowed address that asks, so nobody types it. */
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

function readBody(req: IncomingMessage, max: number): Promise<unknown> {
  return new Promise((ok, fail) => {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return fail(new HttpError(415, 'application/json only'))
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > max) {
        fail(new HttpError(413, `body over ${max} bytes`))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
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
    req.on('end', () => {
      if (!over) ok(Buffer.concat(chunks))
    })
    req.on('error', err => fail(err))
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
  const limiter = new RateLimiter(o.sendsPerMinute, o.sendsPerHour)
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
  const voice = (): VoiceStatus => ({ stt: stt.status(), tts: tts.status() })
  let build: BuildInfo = { id: null, reload: !!o.devReload }

  const refuseIp = (ip: string) => {
    if (refusedIps.has(ip)) return
    refusedIps.add(ip)
    log(`gate: refused ${ip}: not loopback and not in allowIps. If that is the headset, add "${ip}" to allowIps and restart (logged once per address)`)
  }

  // ---------------------------------------------------------------- HTTP
  async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const rel = PAGES[path] ?? decodeURIComponent(path.slice(1))
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

  async function api(req: IncomingMessage, res: ServerResponse, path: string, ip: string): Promise<void> {
    if (!originOk(req)) return sendJson(res, 403, { error: 'not from this origin' })
    // Auto-pairing: the one API route that needs no token, because it is how
    // a browser gets one without typing. It answers only when autoPair is on,
    // and the address check above has already passed, so with autoPair on the
    // allow list alone decides who may use the bridge.
    if (path === '/api/pair' && req.method === 'POST') {
      if (!o.autoPair) return sendJson(res, 403, { error: 'auto-pairing is off; enter the pairing token, or set autoPair in the config' })
      log(`pair: gave the pairing token to ${ip} (autoPair is on)`)
      return sendJson(res, 200, { token: o.token })
    }
    if (!tokenMatches(tokenOf(req), o.token)) {
      log(`gate: ${req.method} ${path} from ${ip}: missing or wrong pairing token`)
      return sendJson(res, 401, { error: 'pairing token missing or wrong' })
    }
    if (path === '/api/health' && req.method === 'GET') return sendJson(res, 200, { ok: true, backend: status })
    if (path === '/api/fleet' && req.method === 'GET') return sendJson(res, 200, { status, fleet: lastFleet })
    if (path === '/api/probe' && req.method === 'POST' && new URL(req.url ?? '/', 'https://bridge').searchParams.get('log') === 'instrument') return instrumentRoute(req, res, ip)
    if (path === '/api/probe' && req.method === 'POST') {
      const d = await readBody(req, JSON_MAX)
      const line = JSON.stringify({ at: new Date().toISOString(), ip, ua: req.headers['user-agent'] ?? null, results: d })
      await mkdir(dirname(o.probeLog), { recursive: true })
      await appendFile(o.probeLog, line + '\n', { mode: 0o600 })
      log(`probe: results from ${ip} appended to ${o.probeLog}`)
      return sendJson(res, 200, { ok: true, logged: o.probeLog })
    }
    if (path === '/api/send' && req.method === 'POST') return sendRoute(req, res, ip)
    if (path === '/api/transcript' && req.method === 'GET') return transcriptRoute(req, res)
    if (path === '/api/voice' && req.method === 'GET') return sendJson(res, 200, voice())
    if (path === '/api/transcribe' && req.method === 'POST') return transcribeRoute(req, res, ip)
    if (path === '/api/interpret' && req.method === 'POST') {
      const body = asObject(await readBody(req, JSON_MAX))
      if (typeof body.text !== 'string' || body.text.length > TEXT_MAX) return sendJson(res, 400, { error: `text: the words to interpret, at most ${TEXT_MAX} characters` })
      return sendJson(res, 200, { interpretation: meaning(body.text, contextOf(body.context), focusOf(body.focus)) })
    }
    if (path === '/api/speak' && req.method === 'POST') return speakRoute(req, res)
    return sendJson(res, 404, { error: 'no such route' })
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
    await mkdir(dirname(instrumentLog), { recursive: true })
    if (lines) await appendFile(instrumentLog, lines + '\n', { mode: 0o600 })
    return sendJson(res, 200, { ok: true, logged: events.length, file: instrumentLog })
  }

  const contextOf = (v: unknown): VoiceContext => (CONTEXTS.includes(v as VoiceContext) ? (v as VoiceContext) : 'none')
  /** The session the HUD has open in its reader, as the client names it. */
  const focusOf = (v: unknown): string | null => (typeof v === 'string' && v && v.length <= 200 ? v : null)

  /**
   * Clip in, transcript and interpretation out. Every way it can fail comes
   * back as its own reason with an HTTP status to match, so the HUD never
   * shows "heard nothing" for a model that is down or a clip it could not read.
   */
  async function transcribeRoute(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    const t0 = Date.now()
    const fail = (http: number, t: Omit<Extract<Transcript, { ok: false }>, 'ok' | 'provider'>) => {
      log(`stt: ${ip}: ${t.reason}: ${t.error}`)
      const reply: VoiceReply = { transcript: { ok: false, provider: stt.name, ...t }, interpretation: null }
      return sendJson(res, http, reply)
    }
    const type = String(req.headers['content-type'] ?? '')
    if (!/^(audio\/|video\/webm|application\/octet-stream)/.test(type)) {
      req.resume()
      return fail(415, { reason: 'bad-audio', error: `send the clip as audio/*, not ${type || 'no content type'}`, audioMs: null, peakDb: null })
    }
    let clip: Buffer
    try {
      clip = await readRaw(req, clipMaxBytes)
    } catch (err) {
      if (err instanceof HttpError && err.status === 413) return fail(413, { reason: 'too-big', error: `the clip is over ${Math.round(clipMaxBytes / 1000)} kB`, audioMs: null, peakDb: null })
      throw err
    }
    // Refuse before decoding when the model cannot run anyway.
    const st = stt.status()
    if (st.state !== 'ready') return fail(503, { reason: 'unavailable', error: `transcription unavailable: ${st.error ?? (st.state === 'loading' ? `the ${st.provider} model is still loading` : st.state)}`, audioMs: null, peakDb: null })
    let pcm: Buffer
    let audioMs: number
    try {
      ;({ pcm, ms: audioMs } = await decodeClip(clip, { ffmpeg, maxSeconds: clipMaxSeconds }))
    } catch (err) {
      if (err instanceof ClipError) return fail(err.reason === 'too-long' ? 413 : 422, { reason: err.reason, error: err.message, audioMs: null, peakDb: null })
      throw err
    }
    const lv = levels(pcm)
    if (lv.peakDb < SILENCE_PEAK_DB) return fail(422, { reason: 'silent', error: `the clip is silent (loudest ${Number.isFinite(lv.peakDb) ? `${lv.peakDb} dBFS` : 'digital silence'}); is the mic muted?`, audioMs, peakDb: Number.isFinite(lv.peakDb) ? lv.peakDb : null })
    let text: string
    let sttMs: number
    try {
      ;({ text, ms: sttMs } = await stt.transcribe(pcm))
    } catch (err) {
      if (err instanceof SttUnavailable) return fail(503, { reason: 'unavailable', error: `transcription unavailable: ${err.message}`, audioMs, peakDb: lv.peakDb })
      if (err instanceof SttBusy) return fail(429, { reason: 'busy', error: err.message, audioMs, peakDb: lv.peakDb })
      return fail(502, { reason: 'failed', error: (err as Error).message, audioMs, peakDb: lv.peakDb })
    }
    if (!text.trim()) return fail(422, { reason: 'no-words', error: `heard sound (loudest ${lv.peakDb} dBFS) but no words in it`, audioMs, peakDb: lv.peakDb })
    const url = new URL(req.url ?? '/', 'https://bridge')
    const transcript: Transcript = { ok: true, text: text.trim(), provider: stt.name, audioMs, sttMs, totalMs: Date.now() - t0 }
    const interpretation = meaning(transcript.text, contextOf(url.searchParams.get('context')), focusOf(url.searchParams.get('focus')))
    log(`stt: ${ip}: ${audioMs} ms clip, ${sttMs} ms model, ${transcript.totalMs} ms total -> ${interpretation.kind}`)
    const reply: VoiceReply = { transcript, interpretation }
    return sendJson(res, 200, reply)
  }

  /** The grammar's reading of the words. "voice X" is acted on here, so the reply is already spoken in the new voice. */
  function meaning(text: string, context: VoiceContext, focusId: string | null): Interpretation {
    const i = interpret({ transcript: text, fleet: lastFleet, heardAs, context, focusId, voices: tts.voices?.() ?? [], voice: tts.voice?.() ?? null, now: Date.now() })
    if (i.kind !== 'voice' || !i.voice) return i
    try {
      if (!tts.select) throw new Error('this text-to-speech provider has one voice')
      tts.select(i.voice)
      return i
    } catch (err) {
      log('tts: could not change voice:', (err as Error).message)
      return { kind: 'voice', voice: null, say: `Could not change voice: ${(err as Error).message}.` }
    }
  }

  async function speakRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = asObject(await readBody(req, JSON_MAX))
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > TEXT_MAX) return sendJson(res, 400, { error: `text: what to say, at most ${TEXT_MAX} characters` })
    try {
      const sp = await tts.speak(body.text)
      res.writeHead(200, { 'content-type': sp.mime, 'content-length': String(sp.audio.length), 'cache-control': 'no-store' })
      res.end(sp.audio)
    } catch (err) {
      if (err instanceof TtsUnavailable) return sendJson(res, 503, { error: `speech unavailable: ${err.message}` })
      log('tts: failed:', (err as Error).message)
      return sendJson(res, 502, { error: `speech failed: ${(err as Error).message}` })
    }
  }

  /** GET /api/transcript?session=<id>&limit=<n>: the session's last turns in full, for the reader. */
  async function transcriptRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!o.backend.capabilities.transcript) return sendJson(res, 501, { error: `${o.backend.name} has no full transcripts` })
    const q = new URL(req.url ?? '/', 'https://bridge').searchParams
    const id = q.get('session') ?? ''
    if (!id || id.length > 200) return sendJson(res, 400, { error: 'session: which session' })
    const limit = Math.min(20, Math.max(1, Math.floor(Number(q.get('limit'))) || 10))
    try {
      return sendJson(res, 200, await o.backend.transcript(id, limit))
    } catch (err) {
      const e = err as Error
      if (err instanceof SendRefused) return sendJson(res, err.status, { error: e.message })
      if (err instanceof UnsupportedError) return sendJson(res, 501, { error: e.message })
      log(`transcript: ${id.slice(0, 40)}: ${e.message}`)
      return sendJson(res, 502, { error: `backend: ${e.message}` })
    }
  }

  async function sendRoute(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    if (!o.backend.capabilities.send) return sendJson(res, 501, { error: `${o.backend.name} cannot send` })
    const d = await readBody(req, JSON_MAX)
    const body = (typeof d === 'object' && d !== null && !Array.isArray(d) ? d : {}) as Record<string, unknown>
    const sessionId = body.sessionId
    const text = body.text
    if (typeof sessionId !== 'string' || !sessionId) return sendJson(res, 400, { error: 'sessionId: which session' })
    if (typeof text !== 'string' || !text.trim()) return sendJson(res, 400, { error: 'text: what to send' })
    const limited = limiter.take()
    if (limited) {
      log(`send: rate limited ${ip}, retry in ${limited.retryAfterS} s`)
      return sendJson(res, 429, { error: `too many sends; try again in ${limited.retryAfterS} s` }, { 'retry-after': String(limited.retryAfterS) })
    }
    try {
      const r = await o.backend.send(sessionId, text)
      log(`send: ${text.length} chars to ${sessionId.slice(0, 40)} from ${ip}: ok`)
      return sendJson(res, 200, r)
    } catch (err) {
      const e = err as Error
      log(`send: ${text.length} chars to ${sessionId.slice(0, 40)} from ${ip}: ${e.message}`)
      if (err instanceof SendRefused) return sendJson(res, err.status, { error: e.message })
      if (err instanceof UnsupportedError) return sendJson(res, 501, { error: e.message })
      return sendJson(res, 502, { error: `backend: ${e.message}` })
    }
  }

  const server = createServer({ cert: o.cert, key: o.key }, (req, res) => {
    const ip = normaliseIp(req.socket.remoteAddress)
    if (!ipAllowed(ip, o.allowIps)) {
      refuseIp(ip)
      return sendJson(res, 403, { error: `this address (${ip}) may not use the bridge; add it to allowIps in the bridge config and restart` })
    }
    const path = new URL(req.url ?? '/', 'https://bridge').pathname
    const handle = path.startsWith('/api/') ? api(req, res, path, ip) : req.method === 'GET' || req.method === 'HEAD' ? serveStatic(req, res, path) : Promise.resolve(sendJson(res, 405, { error: 'method not allowed' }))
    handle.catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500
      if (status === 500) log(`error: ${req.method} ${path}:`, err)
      if (!res.headersSent) sendJson(res, status, { error: (err as Error).message })
      else res.end()
    })
  })
  server.on('tlsClientError', err => log('tls:', err.message))

  // ---------------------------------------------------------------- WebSocket
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024,
    handleProtocols: protocols => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
  })
  server.on('upgrade', (req, socket, head) => {
    const ip = normaliseIp(req.socket.remoteAddress)
    const refuse = (code: number, why: string) => {
      log(`gate: websocket from ${ip} refused: ${why}`)
      socket.write(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      socket.destroy()
    }
    if (!ipAllowed(ip, o.allowIps)) {
      refuseIp(ip)
      return refuse(403, 'Forbidden')
    }
    if (new URL(req.url ?? '/', 'https://bridge').pathname !== '/ws') return refuse(404, 'Not Found')
    if (!originOk(req)) return refuse(403, 'Forbidden')
    if (!tokenMatches(tokenOf(req), o.token)) return refuse(401, 'Unauthorized')
    wss.handleUpgrade(req, socket, head, ws => {
      log(`ws: ${ip} connected (${wss.clients.size} open)`)
      alive.set(ws, true)
      ws.on('pong', () => alive.set(ws, true))
      ws.on('error', err => log(`ws: ${ip}:`, err.message))
      ws.on('close', () => log(`ws: ${ip} left (${wss.clients.size} open)`))
      push(ws, { type: 'hello', status, build, voice: voice() })
      if (lastFleet) push(ws, { type: 'fleet', fleet: lastFleet, status })
    })
  })
  // A socket that misses a pong for a whole interval is dropped, so the HUD
  // reconnects instead of sitting on a dead connection.
  const alive = new WeakMap<WebSocket, boolean>()
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate()
        continue
      }
      alive.set(ws, false)
      ws.ping()
    }
  }, 15_000)

  function push(ws: WebSocket, m: ServerMessage): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m))
  }
  const broadcast = (m: ServerMessage) => {
    for (const ws of wss.clients) push(ws, m)
  }

  // ---------------------------------------------------------------- backend
  const unsubscribe = o.backend.subscribe(u => {
    if (u.ok) {
      // The bridge has the last word on callsigns, whatever the adapter chose.
      const r = relabelFleet(u.fleet, overrides)
      lastFleet = r.fleet
      heardAs = r.heardAs
      status = { ...status, ok: true, error: null, lastOkAt: Date.now() }
      broadcast({ type: 'fleet', fleet: lastFleet, status })
    } else {
      status = { ...status, ok: false, error: u.error }
      broadcast({ type: 'status', status })
    }
  })

  const unVoice = stt.onStatus(() => broadcast({ type: 'voice', voice: voice(), status }))

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
      if (o.devReload) unwatchFile(indexHtml)
      clearInterval(heartbeat)
      for (const ws of wss.clients) ws.terminate()
      wss.close()
      const closed = new Promise<void>(ok => server.close(() => ok()))
      server.closeAllConnections()
      await closed
    },
  }
}
