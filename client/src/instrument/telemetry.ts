// Instrument mode's measurements, for Sam to read after a session instead of
// describing it from inside the headset. Events queue here and go to the
// bridge in batches (POST /api/probe?log=instrument), which appends one JSON
// line each to .local/instrument.log. Batches are cut to the bridge's size
// and count limits (outbox.ts); one that fails for now stays queued, one the
// bridge refuses is split, and an event it will not take is dropped with a
// console error and a marker line. Nothing is dropped silently.

import { Outbox, type LogEvent } from './outbox.ts'

let token: string | null = null
let timer: ReturnType<typeof setInterval> | null = null

const outbox = new Outbox({
  post: async (body, leaving) => {
    const r = await fetch('/api/probe?log=instrument', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body, keepalive: leaving, cache: 'no-store' })
    return { ok: r.ok, status: r.status }
  },
  report: (message, err) => (err === undefined ? console.error(message) : console.error(message, err)),
  now: () => Date.now(),
})

export function startTelemetry(t: string): void {
  token = t
  if (timer) return
  timer = setInterval(() => void flush(), 5000)
  addEventListener('pagehide', () => void flush(true))
  addEventListener('error', e => log('page-error', { message: e.message, source: e.filename, line: e.lineno }))
  addEventListener('unhandledrejection', e => log('page-rejection', { reason: String((e as PromiseRejectionEvent).reason) }))
  addEventListener('securitypolicyviolation', e => log('csp-violation', { directive: e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile }))
}

/** `type` names the event; `data` should be JSON-serialisable (an event that is not is logged as such). */
export function log(type: string, data: Record<string, unknown> = {}): void {
  const e: LogEvent = { type, t: Date.now(), sinceLoadMs: Math.round(performance.now()), ...data }
  outbox.push(e)
}

export async function flush(leaving = false): Promise<void> {
  if (!token) return
  await outbox.flush(leaving)
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

// ---------------------------------------------------------------- React renders

/** Renders per component since the last report: the scene should render on a fleet read, not every second. */
export const renders: Record<string, number> = {}

export function countRender(name: string): void {
  renders[name] = (renders[name] ?? 0) + 1
}

/** The counts since the last call, then zeroed. */
export function takeRenders(): Record<string, number> {
  const out = { ...renders }
  for (const k of Object.keys(renders)) renders[k] = 0
  return out
}
