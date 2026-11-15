// Instrument mode's measurements, for Sam to read after a session instead of
// describing it from inside the headset. Events queue here and go to the
// bridge in batches (POST /api/probe?log=instrument), which appends one JSON
// line each to .local/instrument.log. A batch that fails stays queued and
// says so on the console; nothing is dropped silently.

type Event = Record<string, unknown> & { type: string }

const queue: Event[] = []
let token: string | null = null
let timer: ReturnType<typeof setInterval> | null = null
let flushing = false
let failures = 0
/** Batch size the bridge takes (it refuses more than 400). */
const BATCH = 150
const QUEUE_MAX = 2000

export function startTelemetry(t: string): void {
  token = t
  if (timer) return
  timer = setInterval(() => void flush(), 5000)
  addEventListener('pagehide', () => void flush(true))
  addEventListener('error', e => log('page-error', { message: e.message, source: e.filename, line: e.lineno }))
  addEventListener('unhandledrejection', e => log('page-rejection', { reason: String((e as PromiseRejectionEvent).reason) }))
  addEventListener('securitypolicyviolation', e => log('csp-violation', { directive: e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile }))
}

/** `type` names the event; `data` must be JSON-serialisable. */
export function log(type: string, data: Record<string, unknown> = {}): void {
  queue.push({ type, t: Date.now(), sinceLoadMs: Math.round(performance.now()), ...data })
  if (queue.length > QUEUE_MAX) {
    const dropped = queue.splice(0, queue.length - QUEUE_MAX).length
    queue.unshift({ type: 'telemetry-dropped', t: Date.now(), count: dropped })
  }
}

export async function flush(leaving = false): Promise<void> {
  if (!token || flushing || !queue.length) return
  flushing = true
  try {
    while (queue.length) {
      const batch = queue.slice(0, BATCH)
      let r: Response
      try {
        r = await fetch('/api/probe?log=instrument', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ events: batch }), keepalive: leaving, cache: 'no-store' })
      } catch (err) {
        failures++
        console.error(`instrument log: ${batch.length} events not delivered (attempt ${failures}), kept for the next try:`, err)
        return
      }
      if (!r.ok) {
        failures++
        console.error(`instrument log: the bridge answered HTTP ${r.status}; ${batch.length} events kept for the next try`)
        return
      }
      failures = 0
      queue.splice(0, batch.length)
    }
  } finally {
    flushing = false
  }
}

// ---------------------------------------------------------------- frame times

/** Frame intervals in ms since the last report. */
const frames: number[] = []
let last = 0

export function frameTick(now: number): void {
  if (last) frames.push(now - last)
  last = now
}

export function resetFrames(): void {
  frames.length = 0
  last = 0
}

/**
 * Percentiles of the frame intervals since the last call, and `dropped`: the
 * intervals over 1.5 frames at 72 Hz (20.8 ms), each one at least a missed frame.
 */
export function frameStats(): { n: number; p50: number; p90: number; p99: number; max: number; dropped: number; fps: number } | null {
  if (frames.length < 2) return null
  const s = frames.slice().sort((a, b) => a - b)
  frames.length = 0
  const q = (p: number) => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]! * 100) / 100
  const total = s.reduce((a, b) => a + b, 0)
  return { n: s.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: Math.round(s.at(-1)! * 100) / 100, dropped: s.filter(x => x > 13.9 * 1.5).length, fps: Math.round((s.length / total) * 1000 * 10) / 10 }
}
