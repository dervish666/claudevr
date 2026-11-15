// The transcript polling the 2D reader and the instrument Stream share, from
// the client (client/src/hud/transcript-poll.ts): one read in flight, the
// newest answer wins, a hung read times out, and unchanged turns keep their
// identity so nothing is drawn again.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Turn } from '../../shared/protocol.ts'
import { Poller, blankTranscript, landProblem, landTurns, transcriptKey } from '../../client/src/hud/transcript-poll.ts'

function rig(timeoutMs = 20_000) {
  let now = 0
  let next = 1
  const timers = new Map<number, { at: number; fn: () => void; every: number | null }>()
  const reads: { signal: AbortSignal; resolve(v: string): void; reject(e: unknown): void }[] = []
  const results: string[] = []
  const errors: { err: unknown; timedOut: boolean }[] = []
  const add = (fn: () => void, ms: number, every: number | null) => {
    const id = next++
    timers.set(id, { at: now + ms, fn, every })
    return id
  }
  const poller = new Poller<string>({
    read: signal =>
      new Promise<string>((resolve, reject) => {
        reads.push({ signal, resolve, reject })
      }),
    onResult: v => results.push(v),
    onError: (err, timedOut) => errors.push({ err, timedOut }),
    everyMs: 6_000,
    timeoutMs,
    setTimer: (fn, ms) => add(fn, ms, null),
    clearTimer: h => void timers.delete(h as number),
    setRepeat: (fn, ms) => add(fn, ms, ms),
    clearRepeat: h => void timers.delete(h as number),
  })
  const advance = (ms: number) => {
    const end = now + ms
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      const [id, t] = due
      now = t.at
      if (t.every) t.at += t.every
      else timers.delete(id)
      t.fn()
    }
    now = end
  }
  return { poller, reads, results, errors, advance }
}

const settle = () => new Promise<void>(r => setImmediate(r))

test('a slow older read never replaces a newer one, and is aborted (F10)', async () => {
  const r = rig()
  r.poller.start()
  r.poller.readNow() // the session said something: read again at once
  assert.equal(r.reads.length, 2)
  assert.equal(r.reads[0]!.signal.aborted, true, 'the superseded read is aborted')
  r.reads[1]!.resolve('newer')
  r.reads[0]!.resolve('older')
  await settle()
  assert.deepEqual(r.results, ['newer'])
})

test('the interval skips while a read is in flight: one request at a time (F10)', async () => {
  const r = rig()
  r.poller.start()
  r.advance(6_000)
  r.advance(6_000)
  assert.equal(r.reads.length, 1, 'no second request behind a slow first one')
  r.reads[0]!.resolve('a')
  await settle()
  r.advance(6_000)
  assert.equal(r.reads.length, 2)
  r.poller.stop()
})

test('stop abandons the read in flight; nothing lands after it', async () => {
  const r = rig()
  r.poller.start()
  r.poller.stop()
  assert.equal(r.reads[0]!.signal.aborted, true)
  r.reads[0]!.resolve('late')
  await settle()
  r.advance(60_000)
  assert.deepEqual(r.results, [])
  assert.equal(r.reads.length, 1, 'no more reads after stop')
})

test('a read with no answer times out, says so once, and the next interval reads again', async () => {
  const r = rig(10_000)
  r.poller.start()
  r.advance(10_000)
  assert.equal(r.errors.length, 1)
  assert.equal(r.errors[0]!.timedOut, true)
  assert.equal(r.reads[0]!.signal.aborted, true)
  r.reads[0]!.reject(new Error('aborted'))
  await settle()
  assert.equal(r.errors.length, 1, 'the aborted read does not report twice')
  r.advance(2_000) // the 12 s interval tick
  assert.equal(r.reads.length, 2)
  r.poller.stop()
})

test('unchanged turns keep their identity; a problem keeps the turns on screen', () => {
  const key = transcriptKey('s1')
  const turns: Turn[] = [{ role: 'session', text: 'hello', clipped: false }]
  const a = landTurns(blankTranscript(key, false), key, turns, 1)
  assert.equal(a.loaded, true)
  const again = landTurns(a, key, [{ role: 'session', text: 'hello', clipped: false }], 2)
  assert.equal(again, a, 'a re-read that says the same thing is the same state')
  const failed = landProblem(a, key, { kind: 'failed', why: 'HTTP 502' })
  assert.equal(failed.turns, a.turns, 'the turns already shown stay')
  assert.equal(landProblem(failed, key, { kind: 'failed', why: 'HTTP 502' }), failed)
  const back = landTurns(failed, key, [{ role: 'session', text: 'hello', clipped: false }], 3)
  assert.equal(back.problem, null)
  assert.equal(back.turns, a.turns, 'same turns, same array: the uikit text is not laid out again')
  const changed = landTurns(back, key, [{ role: 'session', text: 'hello there', clipped: false }], 4)
  assert.notEqual(changed.turns, a.turns)
  assert.equal(landTurns(a, transcriptKey('s2'), turns, 5).key, transcriptKey('s2'), 'another session starts afresh')
})
