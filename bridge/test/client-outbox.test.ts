// Instrument mode's log queue, from the client (client/src/instrument/outbox.ts):
// batches fit the bridge's 64 KiB body and 400-event limits, an oversized
// event is cut to a stand-in, and a body the bridge refuses is split or
// dropped, never sent again unchanged.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BATCH, BODY_BUDGET, BODY_MAX, Outbox, encodeEvent } from '../../client/src/instrument/outbox.ts'

const bytes = (s: string) => Buffer.byteLength(s, 'utf8')

/** An outbox whose bridge answers with `answer(body)`; records every body and every report. */
function rig(answer: (body: string) => number | Error = () => 200) {
  const bodies: string[] = []
  const reports: string[] = []
  const box = new Outbox({
    post: async body => {
      bodies.push(body)
      const a = answer(body)
      if (a instanceof Error) throw a
      return { ok: a >= 200 && a < 300, status: a }
    },
    report: m => void reports.push(m),
    now: () => 0,
  })
  const delivered = () => bodies.filter(b => answer(b) === 200).flatMap(b => (JSON.parse(b) as { events: { type: string; i?: number }[] }).events)
  return { box, bodies, reports, delivered }
}

/** The bridge's own limits: over 64 KiB is 413, over 400 events is 400. */
const bridge = (body: string) => (bytes(body) > BODY_MAX ? 413 : (JSON.parse(body) as { events: unknown[] }).events.length > 400 ? 400 : 200)

test('batches fit the bridge body limit and event count, and keep every event in order (F17)', async () => {
  const r = rig(bridge)
  // About 1.5 KiB each, with multi-byte text, so 150 of them would be far over 64 KiB.
  for (let i = 0; i < 500; i++) r.box.push({ type: 'frames', i, note: 'é'.repeat(700) })
  await r.box.flush()
  assert.equal(r.box.size, 0)
  for (const b of r.bodies) {
    assert.ok(bytes(b) <= BODY_BUDGET, `a body of ${bytes(b)} bytes`)
    assert.ok((JSON.parse(b) as { events: unknown[] }).events.length <= BATCH)
  }
  assert.deepEqual(
    r.delivered().map(e => e.i),
    Array.from({ length: 500 }, (_, i) => i),
  )
})

test('an event too big for any batch goes as a stand-in that says so (F17)', async () => {
  const r = rig(bridge)
  r.box.push({ type: 'draw-census', t: 5, blob: 'x'.repeat(200_000) })
  r.box.push({ type: 'after' })
  await r.box.flush()
  const [big, after] = r.delivered() as unknown as [{ type: string; truncated: boolean; bytes: number; keys: string[] }, { type: string }]
  assert.equal(big.type, 'draw-census')
  assert.equal(big.truncated, true)
  assert.ok(big.bytes > 200_000)
  assert.deepEqual(big.keys, ['type', 't', 'blob'])
  assert.equal(after.type, 'after')
  const bad = encodeEvent({ type: 'x', n: 1n } as never)
  assert.equal((JSON.parse(bad.json) as { type: string }).type, 'telemetry-unserialisable')
})

test('a body refused as too large is split, and no refused body is sent again (F17)', async () => {
  // A stricter bridge than ours expects: 20 kB.
  const strict = (body: string) => (bytes(body) > 20_000 ? 413 : 200)
  const r = rig(strict)
  for (let i = 0; i < 100; i++) r.box.push({ type: 'e', i, pad: 'y'.repeat(900) })
  await r.box.flush()
  assert.equal(r.box.size, 0)
  const refused = r.bodies.filter(b => strict(b) === 413)
  assert.ok(refused.length > 0, 'the check saw a refusal')
  assert.equal(new Set(refused).size, refused.length, 'a refused body is never sent twice')
  assert.deepEqual(
    r.delivered().map(e => e.i),
    Array.from({ length: 100 }, (_, i) => i),
  )
})

test('a single event the bridge refuses is dropped, with a report and a marker (F17)', async () => {
  const r = rig(body => (body.includes('poison') ? 400 : 200))
  r.box.push({ type: 'a' })
  r.box.push({ type: 'poison' })
  r.box.push({ type: 'b' })
  await r.box.flush()
  assert.equal(r.box.size, 0)
  assert.deepEqual(
    r.delivered().map(e => e.type),
    ['a', 'b', 'telemetry-refused'],
  )
  assert.ok(r.reports.some(m => m.includes('dropped')))
})

test('a bridge that refuses everything does not loop: markers about markers are not made', async () => {
  const r = rig(() => 400)
  for (let i = 0; i < 10; i++) r.box.push({ type: 'e', i })
  await r.box.flush()
  assert.equal(r.box.size, 0)
  assert.ok(r.bodies.length < 60, `${r.bodies.length} posts`)
})

test('a failure that may pass (no network, 5xx) keeps the batch for the next flush', async () => {
  let up = false
  const r = rig(() => (up ? 200 : new Error('offline')))
  r.box.push({ type: 'a' })
  await r.box.flush()
  assert.equal(r.box.size, 1)
  up = true
  await r.box.flush()
  assert.equal(r.box.size, 0)
})
