// The HUD's WebSocket policy, from the client (client/src/hud/link.ts): an
// open socket that hears nothing for 15 s is dropped at once and a new one
// started after the backoff, without waiting for a close event that may
// take minutes; a socket that keeps talking is never touched.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BridgeLink, SILENCE_MS, SILENT_CLOSE, backoffMs, type Down, type LinkSocket } from '../../client/src/hud/link.ts'

class FakeSocket implements LinkSocket {
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  closed: { code?: number; reason?: string } | null = null
  close(code?: number, reason?: string) {
    this.closed = { code, reason }
  }
  open() {
    this.onopen?.({})
  }
  say(data: string) {
    this.onmessage?.({ data })
  }
}

function rig(o: { opens?: boolean; onDown?: (d: Down) => 'retry' | 'stop' } = {}) {
  let now = 0
  let next = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  const sockets: FakeSocket[] = []
  const connectsAt: number[] = []
  const downs: Down[] = []
  const messages: unknown[] = []
  const link = new BridgeLink<FakeSocket>({
    open: () => {
      const s = new FakeSocket()
      sockets.push(s)
      connectsAt.push(now)
      if (o.opens !== false) queueMicrotask(() => s.open())
      return s
    },
    now: () => now,
    setTimer: (fn, ms) => {
      const id = next++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer: h => void timers.delete(h as number),
    onOpen: () => {},
    onMessage: d => void messages.push(d),
    onDown: d => {
      downs.push(d)
      return o.onDown ? o.onDown(d) : 'retry'
    },
  })
  /** Moves the clock on, firing timers in order, and lets queued opens and onDown answers run. */
  const advance = async (ms: number) => {
    const end = now + ms
    for (;;) {
      await settle()
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      now = due[1].at
      due[1].fn()
    }
    now = end
    await settle()
  }
  return { link, sockets, connectsAt, downs, messages, advance, now: () => now }
}

const settle = () => new Promise<void>(r => setImmediate(r))

test('15 s of silence on an open socket closes it and reconnects after the backoff (V4)', async () => {
  const r = rig()
  r.link.start()
  await r.advance(0)
  const first = r.sockets[0]!
  first.say('{"type":"hello"}')
  await r.advance(SILENCE_MS - 1)
  assert.equal(first.closed, null, 'not yet: 1 ms short of the limit')
  await r.advance(1)
  assert.deepEqual(first.closed, { code: SILENT_CLOSE, reason: 'silent' })
  assert.equal(first.onclose, null, 'its handlers are gone, so a late close event reaches nothing')
  assert.equal(first.onmessage, null)
  assert.deepEqual(r.downs, [{ kind: 'silent', quietMs: SILENCE_MS }], 'the link is marked down at once, not on a close event')
  assert.equal(r.link.socket, null)
  assert.equal(r.sockets.length, 1, 'the new socket waits for the backoff')
  await r.advance(backoffMs(0) - 1)
  assert.equal(r.sockets.length, 1)
  await r.advance(1)
  assert.equal(r.sockets.length, 2, 'reconnected after 500 ms')
  assert.equal(r.link.socket, r.sockets[1])
})

test('steady messages never trip the silence limit (V4)', async () => {
  const r = rig()
  r.link.start()
  await r.advance(0)
  const ws = r.sockets[0]!
  // The bridge pushes the fleet every backend poll, 2 s by default.
  for (let i = 0; i < 60; i++) {
    ws.say('{"type":"fleet"}')
    await r.advance(2_000)
  }
  assert.equal(ws.closed, null)
  assert.equal(r.sockets.length, 1)
  assert.equal(r.downs.length, 0)
  assert.equal(r.messages.length, 60)
  // Even gaps of nearly the whole limit are fine.
  ws.say('x')
  await r.advance(SILENCE_MS - 1)
  ws.say('y')
  await r.advance(SILENCE_MS - 1)
  assert.equal(ws.closed, null)
})

test('the backoff grows while new sockets fail to open, and resets once one opens (V4)', async () => {
  const r = rig({ opens: false })
  r.link.start()
  await r.advance(0)
  // Each socket closes without opening; the waits grow 0.5, 1, 2, 4 s.
  for (let i = 0; i < 4; i++) {
    r.sockets[i]!.onclose?.({ code: 1006 })
    await r.advance(backoffMs(i))
    assert.equal(r.sockets.length, i + 2, `attempt ${i + 2} after ${backoffMs(i)} ms`)
  }
  assert.deepEqual(
    r.connectsAt.slice(1).map((t, i) => t - r.connectsAt[i]!),
    [500, 1_000, 2_000, 4_000],
  )
  r.sockets.at(-1)!.open()
  await r.advance(SILENCE_MS)
  await r.advance(backoffMs(0))
  assert.equal(r.downs.at(-1)!.kind, 'silent')
  assert.equal(r.connectsAt.at(-1)! - r.connectsAt.at(-2)!, SILENCE_MS + backoffMs(0), 'an open resets the backoff to 500 ms')
})

test('a socket that never opens is left to its own close event, and a refused token stops the retries', async () => {
  const r = rig({ opens: false, onDown: d => (d.kind === 'closed' && !d.opened ? 'stop' : 'retry') })
  r.link.start()
  await r.advance(SILENCE_MS * 3)
  assert.equal(r.sockets[0]!.closed, null, 'the silence limit is for open sockets')
  r.sockets[0]!.onclose?.({ code: 1006 })
  await r.advance(60_000)
  assert.equal(r.sockets.length, 1, 'stopped: no retry')
  assert.deepEqual(r.downs, [{ kind: 'closed', opened: false, code: 1006 }])
})

test('stop() closes the socket and ends every timer', async () => {
  const r = rig()
  r.link.start()
  await r.advance(0)
  r.link.stop()
  assert.ok(r.sockets[0]!.closed)
  await r.advance(SILENCE_MS * 4)
  assert.equal(r.sockets.length, 1)
  assert.equal(r.downs.length, 0, 'an unmount is not a link going down')
})
