// Instrument mode's log queue and how it goes to the bridge, kept free of
// the DOM so the tests can drive it. The bridge takes a JSON body of at most
// 64 KiB holding at most 400 events, so a batch is cut by its encoded size
// as well as its count. An event too big for any batch is replaced by a
// short stand-in that says so. A body the bridge refuses for its size or
// shape (413, 400) is never sent again as it was: it is split in half, and
// a single event it refuses is dropped, with a console error and a marker.
// Anything else that fails (no network, a 5xx, a 401) stays queued for the
// next flush.
//
// Events keep arriving while a batch is on its way, and a full queue drops
// its oldest entries to make room, so the front of the queue may have moved
// by the time the bridge answers. An answer therefore settles the entries
// that were in its batch, by identity, never "the first n". A full queue
// drops its oldest entries that are not on their way (their answer settles
// them), so every entry it counts in a marker really was lost, and a marker
// that is itself dropped passes its count on.

/** The bridge's limit on a request body (JSON_MAX in bridge/src/server.ts). */
export const BODY_MAX = 64 * 1024
/** What a batch may use, under BODY_MAX with room to spare. */
export const BODY_BUDGET = BODY_MAX - 4 * 1024
/** Events in a batch (the bridge refuses more than 400). */
export const BATCH = 150
export const QUEUE_MAX = 2000
/** How much of an oversized event's JSON the stand-in keeps. */
const HEAD_CHARS = 2000

export type LogEvent = Record<string, unknown> & { type: string }

interface Queued {
  json: string
  bytes: number
  /** One of the outbox's own notes about lost events: when the bridge refuses one, no note about that note follows. */
  marker: boolean
  /** How many lost events this entry reports, so a marker dropped from a full queue passes its count on. */
  lost: number
}

const encoder = new TextEncoder()
const utf8Bytes = (s: string) => encoder.encode(s).length
/** The body around the events: `{"events":[` and `]}`. */
const WRAP_BYTES = utf8Bytes('{"events":[]}')

/** An event as JSON that fits in a batch on its own: too big, or not serialisable, and a stand-in says what it was. */
export function encodeEvent(e: LogEvent, maxBytes = BODY_BUDGET - WRAP_BYTES): { json: string; bytes: number } {
  let json: string
  try {
    json = JSON.stringify(e)
  } catch (err) {
    json = JSON.stringify({ type: 'telemetry-unserialisable', of: String(e.type).slice(0, 100), t: e.t, error: String(err).slice(0, 300) })
  }
  let bytes = utf8Bytes(json)
  if (bytes > maxBytes) {
    const keys = Object.keys(e)
      .slice(0, 50)
      .map(k => k.slice(0, 60))
    json = JSON.stringify({ type: String(e.type).slice(0, 100), t: e.t, sinceLoadMs: e.sinceLoadMs, truncated: true, bytes, keys, head: json.slice(0, HEAD_CHARS) })
    bytes = utf8Bytes(json)
  }
  return { json, bytes }
}

/** How many queued events, from the front, go in the next batch: at most `maxEvents`, under `maxBytes`, and always at least one. */
export function batchCount(sizes: readonly number[], maxEvents: number, maxBytes = BODY_BUDGET): number {
  let total = WRAP_BYTES
  let n = 0
  for (const b of sizes) {
    if (n >= maxEvents) break
    const add = b + (n ? 1 : 0)
    if (n > 0 && total + add > maxBytes) break
    total += add
    n++
  }
  return n
}

export const batchBody = (jsons: readonly string[]) => `{"events":[${jsons.join(',')}]}`

export interface OutboxDeps {
  /** POSTs one body. Rejects when the request did not complete. */
  post(body: string, leaving: boolean): Promise<{ ok: boolean; status: number }>
  /** Where the outbox says what it kept or dropped. */
  report(message: string, err?: unknown): void
  now(): number
}

export class Outbox {
  private readonly d: OutboxDeps
  private readonly queue: Queued[] = []
  private flushing = false
  private failures = 0
  /** The batch on its way to the bridge, which a full queue leaves alone. */
  private inFlight: ReadonlySet<Queued> = new Set()

  constructor(deps: OutboxDeps) {
    this.d = deps
  }

  get size(): number {
    return this.queue.length
  }

  push(e: LogEvent): void {
    this.enqueue(e, 0)
    if (this.queue.length > QUEUE_MAX) {
      let over = this.queue.length - QUEUE_MAX
      let count = 0
      let kept = 0
      for (const q of this.queue) {
        if (over > 0 && !this.inFlight.has(q)) {
          over--
          // An event dropped is one lost; a marker dropped hands on the losses it reported.
          count += q.marker ? q.lost : 1
        } else this.queue[kept++] = q
      }
      this.queue.length = kept
      const m = encodeEvent({ type: 'telemetry-dropped', t: this.d.now(), count })
      this.queue.unshift({ ...m, marker: true, lost: count })
    }
  }

  async flush(leaving = false): Promise<void> {
    if (this.flushing || !this.queue.length) return
    this.flushing = true
    // Shrinks for this flush when the bridge refuses a batch as too big; the next flush starts over.
    let cap = BATCH
    try {
      while (this.queue.length) {
        const n = batchCount(
          this.queue.map(q => q.bytes),
          cap,
        )
        const batch = this.queue.slice(0, n)
        let r: { ok: boolean; status: number }
        this.inFlight = new Set(batch)
        try {
          r = await this.d.post(batchBody(batch.map(q => q.json)), leaving)
        } catch (err) {
          this.failures++
          this.d.report(`instrument log: ${n} events not delivered (attempt ${this.failures}), kept for the next try:`, err)
          return
        }
        if (r.status === 413 || r.status === 400) {
          // Refused for what the body is: sent again unchanged it would be refused again, forever.
          if (n > 1) {
            cap = Math.max(1, Math.floor(n / 2))
            this.d.report(`instrument log: the bridge refused ${n} events (HTTP ${r.status}); sending them in batches of ${cap}`)
            continue
          }
          const lost = batch[0]!
          this.settle(batch)
          this.d.report(`instrument log: the bridge refused one event (HTTP ${r.status}, ${lost.bytes} bytes); dropped it: ${lost.json.slice(0, 200)}`)
          if (!lost.marker) this.enqueue({ type: 'telemetry-refused', t: this.d.now(), status: r.status, bytes: lost.bytes }, 1)
          continue
        }
        if (!r.ok) {
          this.failures++
          this.d.report(`instrument log: the bridge answered HTTP ${r.status}; ${n} events kept for the next try`)
          return
        }
        this.failures = 0
        this.settle(batch)
      }
    } finally {
      this.flushing = false
      this.inFlight = new Set()
    }
  }

  /** A note about `lost` lost events is a marker; an ordinary event reports none. */
  private enqueue(e: LogEvent, lost: number): void {
    this.queue.push({ ...encodeEvent(e), marker: lost > 0, lost })
  }

  /** Takes out exactly the entries of an answered batch that are still queued. Returns how many were. */
  private settle(batch: readonly Queued[]): number {
    const done = new Set(batch)
    let kept = 0
    for (const q of this.queue) if (!done.has(q)) this.queue[kept++] = q
    const removed = this.queue.length - kept
    this.queue.length = kept
    return removed
  }
}
