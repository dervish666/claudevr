// dashweb's live office stream, GET /api/sub/office (server-sent events),
// held open for one figure: today's spend. dashweb works it out itself from
// each session's running costUsd and keeps it in its spend.json
// (server.mjs, noteSpend and spendToday), and sends it only on this stream:
// `event: spend` with `{ "usd": number | null }` on connect and whenever the
// total moves by a cent. Null there means no session has reported a cost
// today, not $0.
//
// The stream also carries `: ping` every 5 s (server.mjs, the sweep
// interval), so silence is measurable: past SILENT_MS the last figure is
// marked stale with its age, and past twice that the connection is dropped
// and opened again. Reconnects back off from 1 s to 30 s.

import type { Figure } from '../../../../shared/protocol.ts'

export type StreamFetcher = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; body: AsyncIterable<Uint8Array> | null }>

/** No byte from the stream for this long, pings included, and its figure is stale. */
export const SILENT_MS = 20_000
const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 30_000
/** An event bigger than this (the snapshot is ~10 KB) means the stream is not what we think. */
const BUFFER_MAX = 8 * 1024 * 1024

const localDay = (ms: number) => new Date(ms).toLocaleDateString('en-CA')

export interface SseEvent {
  event: string
  data: string
}

/** Splits complete events off the front of `buf`; returns them and the rest. Comments (": ping") count as nothing. */
export function parseSse(buf: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = []
  const blocks = buf.split(/\r?\n\r?\n/)
  const rest = blocks.pop() ?? ''
  for (const block of blocks) {
    let event = 'message'
    const data: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue
      const i = line.indexOf(':')
      const field = i < 0 ? line : line.slice(0, i)
      const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '')
      if (field === 'event') event = value
      else if (field === 'data') data.push(value)
    }
    if (data.length) events.push({ event, data: data.join('\n') })
  }
  return { events, rest }
}

export class OfficeStream {
  private readonly url: string
  private readonly fetch: StreamFetcher
  private readonly log: (...a: unknown[]) => void
  private readonly now: () => number
  private abort: AbortController | null = null
  private timer: NodeJS.Timeout | null = null
  private watchdog: NodeJS.Timeout | null = null
  private running = false
  private readonly backoffMin: number
  private backoff: number
  /** Epoch ms the current connection attempt began. */
  private openedAt = 0
  /** Epoch ms of the last byte received; null before the first. */
  heardAt: number | null = null
  /** The last spend event: `usd` null is dashweb saying it has no reading today. */
  private last: { usd: number | null; at: number } | null = null
  private error: string | null = null
  /** Why the watchdog cut the connection, when it did. */
  private dropped: string | null = null

  constructor(url: string, deps: { fetch: StreamFetcher; log: (...a: unknown[]) => void; now?: () => number; backoffMinMs?: number }) {
    this.url = url
    this.backoffMin = this.backoff = deps.backoffMinMs ?? BACKOFF_MIN_MS
    this.fetch = deps.fetch
    this.log = deps.log
    this.now = deps.now ?? Date.now
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.watchdog = setInterval(() => {
      // A half-open socket never errors; silence is the only sign.
      const since = Math.max(this.heardAt ?? 0, this.openedAt)
      if (this.abort && this.now() - since > 2 * SILENT_MS) {
        this.dropped = `silent for ${Math.round((this.now() - since) / 1000)} s, dropped`
        this.abort.abort()
      }
    }, SILENT_MS / 2)
    this.watchdog.unref?.()
    void this.connect()
  }

  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    if (this.watchdog) clearInterval(this.watchdog)
    this.timer = this.watchdog = null
    this.abort?.abort()
    this.abort = null
  }

  private async connect(): Promise<void> {
    if (!this.running) return
    const ac = new AbortController()
    this.abort = ac
    this.openedAt = this.now()
    let why: string
    try {
      const res = await this.fetch(this.url, { signal: ac.signal })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}${res.body ? '' : ', no body'}`)
      const dec = new TextDecoder()
      let buf = ''
      for await (const chunk of res.body) {
        this.heardAt = this.now()
        if (this.error) this.log('office stream live again after:', this.error)
        this.error = null
        this.backoff = this.backoffMin
        buf += dec.decode(chunk, { stream: true })
        const { events, rest } = parseSse(buf)
        buf = rest
        if (buf.length > BUFFER_MAX) throw new Error(`an event over ${BUFFER_MAX} bytes`)
        for (const e of events) if (e.event === 'spend') this.takeSpend(e.data)
      }
      why = 'dashweb closed the stream'
    } catch (err) {
      why = ac.signal.aborted && !this.running ? 'stopped' : (this.dropped ?? (err instanceof Error ? err.message : String(err)))
    }
    this.dropped = null
    if (this.abort === ac) this.abort = null
    if (!this.running) return
    if (why !== this.error) this.log(`office stream down (${why}); retrying in ${this.backoff / 1000} s`)
    this.error = why
    this.timer = setTimeout(() => void this.connect(), this.backoff)
    this.timer.unref?.()
    this.backoff = Math.min(BACKOFF_MAX_MS, this.backoff * 2)
  }

  private takeSpend(data: string): void {
    let usd: unknown
    try {
      usd = (JSON.parse(data) as { usd?: unknown } | null)?.usd
    } catch (err) {
      this.log('office stream: a spend event that is not JSON:', err instanceof Error ? err.message : String(err))
      return
    }
    if (usd === null) this.last = { usd: null, at: this.now() }
    else if (typeof usd === 'number' && Number.isFinite(usd) && usd >= 0) this.last = { usd, at: this.now() }
    else this.log('office stream: a spend event with no usable figure:', data.slice(0, 120))
  }

  /** Today's spend as the HUD should show it, with how sure that is. */
  spend(): Figure<number> {
    const now = this.now()
    if (!this.running && this.heardAt === null) return { value: null, at: null, stale: false, note: "dashweb's live stream is not open" }
    if (!this.last) return { value: null, at: null, stale: false, note: this.error ? `dashweb's live stream: ${this.error}` : "waiting for dashweb's live stream" }
    // A figure held across midnight by a dead stream is yesterday's.
    if (localDay(this.last.at) !== localDay(now) && (this.heardAt === null || localDay(this.heardAt) !== localDay(now)))
      return { value: null, at: this.heardAt, stale: true, note: "the last figure was yesterday's and the stream has been silent since" }
    const at = this.heardAt ?? this.last.at
    const silent = now - at
    const stale = silent > SILENT_MS
    const note = stale ? `dashweb's live stream silent for ${Math.round(silent / 1000)} s${this.error ? ` (${this.error})` : ''}` : null
    if (this.last.usd === null) return { value: null, at, stale, note: note ?? 'dashweb has no cost reading for today yet' }
    return { value: this.last.usd, at, stale, note }
  }
}
