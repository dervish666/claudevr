// The office reader (limits and contexts) and the live stream (spend), on
// shapes taken from a real dashweb office snapshot, ids and figures changed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LIMITS_STALE_MS, readOffice } from '../src/backend/dashweb/usage.ts'
import { OfficeStream, parseSse, SILENT_MS, type StreamFetcher } from '../src/backend/dashweb/stream.ts'
import { normalise } from '../src/backend/dashweb/normalise.ts'

const NOW = Date.parse('2026-11-15T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const FIX = join(import.meta.dirname, '..', '..', 'fixtures')
const BUSY = 'b2e07a6c-d1fe-cc87-ac1e-f2aefa7b9949'
const IDLE = '6cc1b82e-a279-dab0-465e-ff2b4a03d828'

function entry(usage: object | null, breakdown: object | null = null) {
  return { at: NOW, data: { project: 'p', stats: { usage, breakdown, turns: null, tools: null, jev: null } } }
}
const usage = (measuredAt: number, five: number, week: number, ctx: object = { tokens: 305_406, window: 1_000_000, percent: 31 }) => ({
  model: 'Fable 5.2',
  measuredAt,
  context: ctx,
  rateLimits: [
    { kind: 'five_hour', percentUsed: five, resetsAt: iso(NOW + 80 * 60_000) },
    { kind: 'seven_day', percentUsed: week, resetsAt: iso(NOW + 6 * 86_400_000) },
  ],
  costUsd: 32.8,
})

test('limits: the freshest reading of each window wins, shortest window first', () => {
  const r = readOffice({ a: entry(usage(NOW - 600_000, 38, 33)), b: entry(usage(NOW - 60_000, 42, 34)) }, NOW)
  assert.deepEqual(
    r.limits.value?.map(w => [w.kind, w.label, w.usedPct, w.resetsAt]),
    [
      ['five_hour', '5-hour', 42, NOW + 80 * 60_000],
      ['seven_day', 'Weekly', 34, NOW + 6 * 86_400_000],
    ],
  )
  assert.equal(r.limits.at, NOW - 60_000)
  assert.equal(r.limits.stale, false)
  assert.equal(r.limits.note, null)
})

test('limits: a reading of a window that has reset since is dropped, and the HUD is told why', () => {
  const old = usage(NOW - 6 * 3_600_000, 97, 40)
  old.rateLimits[0]!.resetsAt = iso(NOW - 3_600_000)
  const r = readOffice({ a: entry(old) }, NOW)
  assert.deepEqual(r.limits.value?.map(w => w.kind), ['seven_day'], 'the reset 5-hour window is not shown as 97%')
  assert.match(r.limits.note ?? '', /5-hour window reset since the last reading/)
})

test('limits: an old reading is kept but marked stale, with its age', () => {
  const r = readOffice({ a: entry(usage(NOW - LIMITS_STALE_MS - 5 * 60_000, 50, 30)) }, NOW)
  assert.equal(r.limits.value?.[0]?.usedPct, 50)
  assert.equal(r.limits.stale, true)
  assert.match(r.limits.note ?? '', /last reading 20 min ago/)
})

test('limits: the windows share the age of the oldest one shown, so a fresh 5-hour reading cannot hide a stale weekly one', () => {
  const at = (measuredAt: number, kind: string, percentUsed: number, resetsAt: number) => ({ measuredAt, rateLimits: [{ kind, percentUsed, resetsAt: iso(resetsAt) }] })
  const old = NOW - LIMITS_STALE_MS - 10 * 60_000
  const r = readOffice({ a: entry(at(NOW - 60_000, 'five_hour', 40, NOW + 80 * 60_000)), b: entry(at(old, 'seven_day', 70, NOW + 6 * 86_400_000)) }, NOW)
  assert.deepEqual(r.limits.value?.map(w => [w.kind, w.usedPct]), [['five_hour', 40], ['seven_day', 70]])
  assert.equal(r.limits.at, old)
  assert.equal(r.limits.stale, true)
  assert.match(r.limits.note ?? '', /last reading 25 min ago/)
})

test('limits unknown: no readings, a failed read, or not a snapshot are null with a reason, never 0%', () => {
  for (const raw of [{}, { a: entry(null) }, { a: entry({ measuredAt: NOW, context: {}, rateLimits: [] }) }, new Error('HTTP 503'), 'nonsense', undefined]) {
    const r = readOffice(raw, NOW)
    assert.equal(r.limits.value, null, `for ${JSON.stringify(raw)}`)
    assert.ok(r.limits.note, 'says why')
    assert.equal(r.limits.stale, false)
  }
  assert.match(readOffice(new Error('HTTP 503'), NOW).limits.note!, /HTTP 503/)
  // A percentage that is not a number is not a reading.
  const bad = usage(NOW, 0, 0)
  ;(bad.rateLimits[0] as { percentUsed: unknown }).percentUsed = 'lots'
  assert.deepEqual(readOffice({ a: entry(bad) }, NOW).limits.value?.map(w => w.kind), ['seven_day'])
})

test('context: the /context breakdown first, as dashweb shows it, then the status line, then tokens over window', () => {
  const r = readOffice(
    {
      bd: entry(usage(NOW, 1, 1), { totalTokens: 310_054, rawMaxTokens: 400_000, percentage: 78, isAutoCompactEnabled: true, categories: [], model: 'x' }),
      line: entry(usage(NOW, 1, 1)),
      sum: entry(usage(NOW, 1, 1, { tokens: 50_000, window: 200_000 })),
      none: entry(usage(NOW, 1, 1, { window: 200_000 })),
      nothing: entry(null),
    },
    NOW,
  )
  assert.deepEqual(r.contexts.get('bd'), { usedPct: 78, tokens: 310_054, windowTokens: 400_000, at: NOW })
  assert.deepEqual(r.contexts.get('line'), { usedPct: 31, tokens: 305_406, windowTokens: 1_000_000, at: NOW })
  assert.equal(r.contexts.get('sum')?.usedPct, 25)
  assert.equal(r.contexts.has('none'), false, 'a window with no tokens is not 0% full')
  assert.equal(r.contexts.has('nothing'), false)
})

test('normalise: contexts land on the sessions by id; one the office lacks stays null', () => {
  const board = JSON.parse(readFileSync(join(FIX, 'board.json'), 'utf8'))
  const t3 = JSON.parse(readFileSync(join(FIX, 't3.json'), 'utf8'))
  const spend = { value: 3.21, at: NOW, stale: false, note: null }
  const { fleet } = normalise(board, t3, NOW, { office: { [BUSY]: entry(usage(NOW - 1000, 42, 34)) }, spend })
  assert.equal(fleet.sessions.find(s => s.id === BUSY)!.context?.usedPct, 31)
  assert.equal(fleet.sessions.find(s => s.id === IDLE)!.context, null)
  assert.equal(fleet.usage.limits.value?.[0]?.usedPct, 42)
  assert.equal(fleet.usage.todayUsd, spend)
})

// ---------------------------------------------------------------- stream

test('parseSse: events split on blank lines, comments ignored, a partial event kept for later', () => {
  const { events, rest } = parseSse(': ping\n\nevent: spend\ndata: {"usd":1}\n\nevent: update\ndata: a\ndata: b\n\nevent: spe')
  assert.deepEqual(events, [
    { event: 'spend', data: '{"usd":1}' },
    { event: 'update', data: 'a\nb' },
  ])
  assert.equal(rest, 'event: spe')
})

/** A stream the test feeds by hand, on a clock the test moves. */
function rig(opts: { refuse?: boolean } = {}) {
  let now = NOW
  let push: ((s: string) => void) | null = null
  const queue: string[] = []
  let wake: (() => void) | null = null
  let calls = 0
  const fetch: StreamFetcher = async (_url, { signal }) => {
    calls++
    if (opts.refuse) throw new Error('connect ECONNREFUSED 127.0.0.1:9')
    push = s => {
      queue.push(s)
      wake?.()
    }
    return {
      ok: true,
      status: 200,
      body: (async function* () {
        while (!signal.aborted) {
          if (!queue.length) await new Promise<void>(r => ((wake = r), signal.addEventListener('abort', () => r())))
          while (queue.length) yield new TextEncoder().encode(queue.shift()!)
        }
      })(),
    }
  }
  const logs: string[] = []
  const stream = new OfficeStream('http://dashweb.test/api/sub/office', { fetch, log: (...a) => logs.push(a.join(' ')), now: () => now, backoffMinMs: 10 })
  const tick = () => new Promise(r => setTimeout(r, 5))
  return { stream, send: async (s: string) => (push!(s), await tick()), advance: (ms: number) => (now += ms), tick, calls: () => calls, logs, setNow: (t: number) => (now = t) }
}

test('spend: unknown until the stream speaks, then live, then stale with its age when it goes quiet', async () => {
  const r = rig()
  assert.equal(r.stream.spend().value, null)
  assert.match(r.stream.spend().note!, /not open/)
  r.stream.start()
  await r.tick()
  assert.equal(r.stream.spend().value, null, 'connected, no spend event yet')
  assert.match(r.stream.spend().note!, /waiting/)
  await r.send('event: spend\ndata: {"usd":83.78}\n\n')
  assert.deepEqual(r.stream.spend(), { value: 83.78, at: NOW, stale: false, note: null })
  // Pings keep it live.
  r.advance(15_000)
  await r.send(': ping\n\n')
  assert.equal(r.stream.spend().stale, false)
  r.advance(SILENT_MS + 5_000)
  const s = r.stream.spend()
  assert.equal(s.value, 83.78, 'the last figure stays on screen')
  assert.equal(s.stale, true)
  assert.equal(s.at, NOW + 15_000)
  assert.match(s.note!, /silent for 25 s/)
  r.stream.stop()
})

test('spend: dashweb saying null means not available, not $0', async () => {
  const r = rig()
  r.stream.start()
  await r.tick()
  await r.send('event: spend\ndata: {"usd":null}\n\n')
  const s = r.stream.spend()
  assert.equal(s.value, null)
  assert.match(s.note!, /no cost reading for today/)
  r.stream.stop()
})

test('spend: a figure held across midnight by a dead stream is dropped', async () => {
  const r = rig()
  r.stream.start()
  await r.tick()
  await r.send('event: spend\ndata: {"usd":40}\n\n')
  r.setNow(NOW + 86_400_000)
  assert.equal(r.stream.spend().value, null)
  assert.match(r.stream.spend().note!, /yesterday/)
  r.stream.stop()
})

test('spend: a dead stream is unavailable with the reason, and is retried with backoff', async () => {
  const r = rig({ refuse: true })
  r.stream.start()
  await new Promise(res => setTimeout(res, 60))
  const s = r.stream.spend()
  assert.equal(s.value, null)
  assert.match(s.note!, /ECONNREFUSED/)
  assert.ok(r.calls() >= 2, `retried (${r.calls()} attempts)`)
  assert.ok(r.calls() <= 4, `backing off (${r.calls()} attempts in 60 ms from 10 ms)`)
  assert.equal(r.logs.filter(l => l.includes('ECONNREFUSED')).length, 1, 'the same failure is logged once')
  r.stream.stop()
  const n = r.calls()
  await new Promise(res => setTimeout(res, 50))
  assert.equal(r.calls(), n, 'no retries after stop')
})
