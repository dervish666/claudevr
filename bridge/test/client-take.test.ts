// One clip's recording, from the client (client/src/hud/voice/take.ts):
// a press between release and the recorder's stop event cannot start a new
// recorder, so the first clip keeps its audio and a late stop event cannot
// clear the next clip. Driven by a fake MediaRecorder and a fake clock.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STOP_GRACE_MS, Takes, type TakeRecorder } from '../../client/src/hud/voice/take.ts'

/** A MediaRecorder whose events fire only when the test says so, as a real one's arrive some time after stop(). */
class FakeRecorder implements TakeRecorder {
  state: 'inactive' | 'recording' | 'paused' = 'inactive'
  readonly mimeType = 'audio/webm'
  ondataavailable: ((ev: { data: Blob }) => void) | null = null
  onstop: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  start() {
    this.state = 'recording'
  }
  stop() {
    this.state = 'inactive'
  }
  /** The browser hands over audio and then says it has stopped. */
  deliver(...parts: string[]) {
    for (const p of parts) this.ondataavailable?.({ data: new Blob([p]) })
    this.onstop?.({})
  }
  fail() {
    this.onerror?.({ type: 'error' })
    this.onstop?.({})
  }
}

function rig() {
  let now = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  let next = 1
  const takes = new Takes({
    now: () => now,
    setTimer: (fn, ms) => {
      const id = next++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer: h => void timers.delete(h as number),
  })
  const advance = (ms: number) => {
    now += ms
    for (const [id, t] of [...timers]) {
      if (t.at > now) continue
      timers.delete(id)
      t.fn()
    }
  }
  return { takes, advance, timers }
}

const text = async (b: Blob) => await b.text()

test('a press before the stop event waits: the first clip keeps its audio (V3)', async () => {
  const r = rig()
  const a = new FakeRecorder()
  r.takes.start(a)
  assert.equal(r.takes.busy, true)
  r.advance(1_200)
  const first = r.takes.stop() // released; the clip is on its way
  assert.equal(r.takes.busy, true, 'busy until the stop event')
  assert.throws(() => r.takes.start(new FakeRecorder()), /still being finished/, 'pressed again before the stop event')
  a.deliver('hello ', 'world')
  const clip = await first
  assert.ok(clip)
  assert.equal(await text(clip.blob), 'hello world', 'none of its audio went to a second recorder')
  assert.equal(clip.ms, 1_200)
  assert.equal(r.takes.busy, false)

  // Now the next press records on its own recorder.
  const b = new FakeRecorder()
  r.takes.start(b)
  const second = r.takes.stop()
  b.deliver('again')
  assert.equal(await text((await second)!.blob), 'again')
})

test("a late stop event from an old recorder cannot clear the next clip (V3)", async () => {
  const r = rig()
  const a = new FakeRecorder()
  r.takes.start(a)
  const first = r.takes.stop()
  a.deliver('one')
  await first
  const b = new FakeRecorder()
  r.takes.start(b)
  a.onstop?.({}) // a stray, repeated stop from the old recorder
  assert.equal(r.takes.busy, true, 'the new take is still the current one')
  assert.equal(r.takes.recording, true)
  const second = r.takes.stop()
  b.deliver('two')
  assert.equal(await text((await second)!.blob), 'two')
})

test('an error mid-recording ends the take, so the button is not left dead', async () => {
  const r = rig()
  const a = new FakeRecorder()
  r.takes.start(a)
  a.ondataavailable?.({ data: new Blob(['partial']) })
  a.state = 'inactive'
  a.fail()
  assert.equal(r.takes.busy, false)
  assert.equal(await r.takes.stop(), null, 'nothing more to hand over')
  r.takes.start(new FakeRecorder())
  assert.equal(r.takes.busy, true)
})

test('a stop event that never comes is given up on after the grace period', async () => {
  const r = rig()
  r.takes.start(new FakeRecorder())
  const clip = r.takes.stop()
  r.advance(STOP_GRACE_MS - 1)
  assert.equal(r.takes.busy, true)
  r.advance(1)
  assert.equal(r.takes.busy, false)
  assert.ok(await clip, 'what was captured is handed over')
  // A normal stop leaves no grace timer behind.
  const a = new FakeRecorder()
  r.takes.start(a)
  const done = r.takes.stop()
  a.deliver('x')
  await done
  assert.equal(r.timers.size, 0)
})

test('an aborted take hands over nothing', async () => {
  const r = rig()
  const a = new FakeRecorder()
  r.takes.start(a)
  r.takes.abort()
  a.deliver('dropped')
  assert.equal(r.takes.busy, false)
  assert.equal(await r.takes.stop(), null)
})
