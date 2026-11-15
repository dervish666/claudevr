// The read-back card's send safety, from the client (client/src/hud/voice/sendcard.ts):
// countdown lengths, the quick-line rule, stale timers, overlapping answers,
// Cancel during transcription, Send now racing the countdown, holding to
// talk, and the unknown outcome. Driven by a fake clock; nothing is sent.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DISMISS_MS,
  QUICK_COUNTDOWN_MS,
  QUICK_MAX_CHARS,
  SEND_COUNTDOWN_MS,
  SendCards,
  UNKNOWN_DETAIL,
  classifySend,
  postSend,
  randomRequestId,
  sendBody,
  type ArmRequest,
  type Card,
  type SendFetch,
  type SendOutcome,
} from '../../client/src/hud/voice/sendcard.ts'

/**
 * A fake clock. `leaky` makes clearTimer do nothing, as if the callback had
 * already been queued: the controller's own checks must then stop it.
 */
function clock(leaky = false) {
  let now = 1_000_000
  let next = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = next++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer: (h: unknown) => {
      if (!leaky) timers.delete(h as number)
    },
    /** Moves the clock on by `ms`, firing every timer that falls due, in order. */
    advance(ms: number) {
      const end = now + ms
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = end
    },
  }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(v: T): void
  reject(e: unknown): void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}

const settle = () => new Promise<void>(r => setImmediate(r))

/** A controller on a fake clock, recording every post and every answer. `answer` decides each post's outcome. */
function rig(o: { leaky?: boolean; answer?: (c: Card) => Promise<SendOutcome> } = {}) {
  const c = clock(o.leaky)
  const posts: Card[] = []
  const outcomes: { card: Card; outcome: SendOutcome; current: boolean }[] = []
  let ids = 0
  const cards = new SendCards({
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    newRequestId: () => `req-${String(++ids).padStart(4, '0')}`,
    post: card => {
      posts.push(card)
      return o.answer ? o.answer(card) : Promise.resolve({ kind: 'sent', said: null })
    },
    onChange: () => {},
    onOutcome: (card, outcome, current) => outcomes.push({ card, outcome, current }),
  })
  return { cards, clock: c, posts, outcomes }
}

const tell = (text = 'run the tests', over: Partial<ArmRequest> = {}): ArmRequest => ({ sessionId: 's-tally', callsign: 'Tally', text, viaDispatcher: false, quickConfirm: false, ...over })

test('countdown: 5 s for the card, 2 s for a quick line, never zero', () => {
  assert.ok(SEND_COUNTDOWN_MS > 0 && QUICK_COUNTDOWN_MS > 0)
  assert.equal(SEND_COUNTDOWN_MS, 5_000)
  assert.equal(QUICK_COUNTDOWN_MS, 2_000)

  const a = rig()
  const card = a.cards.arm(tell())!
  assert.equal(card.countdownMs, 5_000)
  assert.equal(card.sendAt, a.clock.now() + 5_000)
  a.clock.advance(4_999)
  a.cards.tick()
  assert.equal(a.posts.length, 0, 'nothing goes before the countdown ends')
  a.clock.advance(1)
  assert.equal(a.posts.length, 1)

  const b = rig()
  const quick = b.cards.arm(tell('yes go ahead', { quickConfirm: true }))!
  assert.equal(quick.quick, true)
  assert.equal(quick.countdownMs, 2_000)
  b.clock.advance(1_999)
  b.cards.tick()
  assert.equal(b.posts.length, 0)
  b.clock.advance(1)
  assert.equal(b.posts.length, 1)
})

test('the quick line takes a message only when the whole of it fits; a longer one gets the full card and 5 s', () => {
  const r = rig()
  const fits = 'x'.repeat(QUICK_MAX_CHARS)
  assert.equal(r.cards.arm(tell(fits, { quickConfirm: true }))!.quick, true)
  const long = r.cards.arm(tell(`${fits}y`, { quickConfirm: true }))!
  assert.equal(long.quick, false)
  assert.equal(long.countdownMs, SEND_COUNTDOWN_MS)
  assert.equal(long.text, `${fits}y`, 'the card carries the whole text')
  assert.equal(r.cards.arm(tell('two\nlines', { quickConfirm: true }))!.quick, false)
  assert.equal(r.cards.arm(tell('yes', { quickConfirm: false }))!.quick, false, 'operator mode never uses the quick line')
})

test('a stale countdown timer never sends a newer card (F03)', () => {
  // Leaky: card A's timer still fires after card B replaced it.
  const r = rig({ leaky: true })
  r.cards.arm(tell('first message'))
  r.clock.advance(4_900)
  const b = r.cards.arm(tell('second message'))!
  r.clock.advance(100) // A's timer comes due here
  assert.equal(r.posts.length, 0, "A's timer must not send B")
  assert.equal(r.cards.card?.state, 'armed')
  r.cards.tick()
  assert.equal(r.posts.length, 0, 'nor may the frame tick: B has its own deadline')
  r.clock.advance(4_899)
  assert.equal(r.posts.length, 0)
  r.clock.advance(1)
  assert.deepEqual(
    r.posts.map(p => p.id),
    [b.id],
    'B goes once, after its own full countdown',
  )
})

test('holding to talk blocks the automatic send, and the countdown restarts in full after (F03)', () => {
  const r = rig({ leaky: true })
  r.cards.arm(tell())
  r.clock.advance(3_000)
  r.cards.setTalking(true)
  r.clock.advance(10_000) // the old timer fires while he talks
  r.cards.tick()
  assert.equal(r.posts.length, 0, 'nothing sends while he holds to talk')
  r.cards.setTalking(false)
  assert.equal(r.cards.card!.sendAt, r.clock.now() + SEND_COUNTDOWN_MS, 'the countdown starts again in full')
  r.clock.advance(4_999)
  r.cards.tick()
  assert.equal(r.posts.length, 0)
  r.clock.advance(1)
  assert.equal(r.posts.length, 1)
})

test("a timer from before he talked cannot cut the restarted countdown short (F03)", () => {
  // Same card, so only the deadline check stands between the old timer and an early send.
  const r = rig({ leaky: true })
  r.cards.arm(tell()) // its timer falls due 5 s from now
  r.clock.advance(3_000)
  r.cards.setTalking(true)
  r.clock.advance(1_000)
  r.cards.setTalking(false) // restarts: due 5 s from here, 9 s from the start
  r.clock.advance(1_000) // the old timer fires
  assert.equal(r.posts.length, 0, 'one second after he stopped talking is not a countdown')
  r.clock.advance(3_999)
  assert.equal(r.posts.length, 0)
  r.clock.advance(1)
  assert.equal(r.posts.length, 1)
})

test('a card armed while he talks waits for him to stop', () => {
  const r = rig()
  r.cards.setTalking(true)
  r.cards.arm(tell())
  r.clock.advance(20_000)
  r.cards.tick()
  assert.equal(r.posts.length, 0)
  r.cards.setTalking(false)
  r.clock.advance(SEND_COUNTDOWN_MS)
  assert.equal(r.posts.length, 1)
})

test('Send now racing the countdown and the frame tick sends exactly once', async () => {
  for (const leaky of [false, true]) {
    const r = rig({ leaky })
    r.cards.arm(tell())
    r.clock.advance(4_999)
    assert.equal(r.cards.sendNow(), true)
    r.clock.advance(10)
    r.cards.tick()
    assert.equal(r.cards.sendNow(), false, 'a second press does nothing')
    await settle()
    assert.equal(r.posts.length, 1, `leaky=${leaky}`)
  }
  // The other way round: the countdown fires, then Send now.
  const r = rig()
  r.cards.arm(tell())
  r.clock.advance(SEND_COUNTDOWN_MS)
  r.cards.tick()
  assert.equal(r.cards.sendNow(), false)
  assert.equal(r.posts.length, 1)
})

test("a late answer never replaces a newer card (F06)", async () => {
  const outcomes: SendOutcome[] = [
    { kind: 'sent', said: 'queued' },
    { kind: 'refused', status: 502, error: 'backend: no route' },
    { kind: 'limited', retryAfterS: 9 },
    { kind: 'unknown', why: 'The connection to the bridge failed.' },
  ]
  for (const o of outcomes) {
    const pending = deferred<SendOutcome>()
    const r = rig({ answer: () => pending.promise })
    const a = r.cards.arm(tell('first'))!
    r.cards.sendNow()
    assert.equal(r.cards.card!.state, 'sending')
    const b = r.cards.arm(tell('second'))!
    pending.resolve(o)
    await settle()
    assert.equal(r.cards.card!.id, b.id, `${o.kind}: B is still the card`)
    assert.equal(r.cards.card!.state, 'armed', `${o.kind}: B is untouched`)
    assert.equal(r.outcomes.length, 1)
    assert.equal(r.outcomes[0]!.card.id, a.id)
    assert.equal(r.outcomes[0]!.current, false, "A's answer is reported as late, not drawn")
  }
})

test('an answer lands on its own card: sent clears itself, a refusal stays', async () => {
  const r = rig({ answer: () => Promise.resolve({ kind: 'sent', said: 'queued for Tally' }) })
  r.cards.arm(tell())
  r.cards.sendNow()
  await settle()
  assert.equal(r.cards.card!.state, 'sent')
  assert.equal(r.cards.card!.detail, 'Sent. queued for Tally')
  assert.equal(r.outcomes[0]!.current, true)
  r.clock.advance(DISMISS_MS)
  assert.equal(r.cards.card, null)

  const f = rig({ answer: () => Promise.resolve({ kind: 'refused', status: 404, error: 'no such session' }) })
  f.cards.arm(tell())
  f.cards.sendNow()
  await settle()
  assert.equal(f.cards.card!.state, 'refused')
  assert.match(f.cards.card!.detail!, /Refused \(HTTP 404\): no such session\. Not sent\./)
  f.clock.advance(60_000)
  assert.equal(f.cards.card?.state, 'refused', 'a failed card waits to be dismissed')
  f.cards.dismiss()
  assert.equal(f.cards.card, null)
})

test('Cancel during transcription makes that interpretation stale: it arms nothing (F07)', () => {
  const r = rig()
  const clip = r.cards.newIntent() // he holds to talk
  r.cards.cancel('Cancelled. Nothing sent.') // and cancels while it is transcribed
  assert.equal(r.cards.isCurrent(clip), false)
  assert.equal(r.cards.arm(tell(), clip), null, 'the late interpretation arms no card')
  assert.equal(r.cards.card, null)
  r.clock.advance(60_000)
  r.cards.tick()
  assert.equal(r.posts.length, 0)
  // The next clip is current.
  const next = r.cards.newIntent()
  assert.ok(r.cards.arm(tell(), next))
})

test('Cancel stops an armed card, which then clears itself', () => {
  const r = rig({ leaky: true })
  r.cards.arm(tell())
  r.clock.advance(1_000)
  assert.equal(r.cards.cancel('Cancelled by voice. Nothing sent.'), true)
  assert.equal(r.cards.card!.state, 'cancelled')
  r.clock.advance(SEND_COUNTDOWN_MS)
  r.cards.tick()
  assert.equal(r.posts.length, 0, 'a cancelled card never sends, even if its timer fires')
  r.clock.advance(DISMISS_MS)
  assert.equal(r.cards.card, null)
})

test('an unknown outcome says so, stays up, and is never retried (F08)', async () => {
  const r = rig({ answer: () => Promise.resolve({ kind: 'unknown', why: 'No answer from the bridge in 60 s.' }) })
  r.cards.arm(tell())
  r.clock.advance(SEND_COUNTDOWN_MS)
  await settle()
  assert.equal(r.cards.card!.state, 'unknown')
  assert.ok(r.cards.card!.detail!.startsWith(UNKNOWN_DETAIL))
  assert.equal(UNKNOWN_DETAIL, 'Not known whether it was sent. Check the session before sending again.')
  r.clock.advance(120_000)
  r.cards.tick()
  assert.equal(r.cards.sendNow(), false, 'no retry is offered')
  assert.equal(r.posts.length, 1)
  assert.equal(r.cards.card!.state, 'unknown', 'it waits to be dismissed')

  // A post that throws is taken as unknown too: it may have gone.
  const t = rig({ answer: () => Promise.reject(new Error('boom')) })
  t.cards.arm(tell())
  t.cards.sendNow()
  await settle()
  assert.equal(t.cards.card!.state, 'unknown')
})

test('each card has its own request id, sent with the message', () => {
  const r = rig()
  const a = r.cards.arm(tell('first'))!
  const b = r.cards.arm(tell('second'))!
  assert.notEqual(a.requestId, b.requestId)
  assert.deepEqual(JSON.parse(sendBody(a)), { sessionId: 's-tally', text: 'first', requestId: a.requestId })
  for (let i = 0; i < 20; i++) assert.match(randomRequestId(), /^[A-Za-z0-9_-]{8,64}$/)
})

test('postSend: what each answer from /api/send means (F08)', async t => {
  t.mock.method(console, 'error', () => {})
  const card: Card = { id: 1, requestId: 'req-abcdef12', sessionId: 's1', callsign: 'Tally', text: 'hello', viaDispatcher: false, viaFocus: false, sendAt: 0, countdownMs: 5000, quick: false, state: 'sending', detail: null }
  const seen: { body: string; signal: boolean }[] = []
  const answer =
    (status: number, body: unknown, headers: Record<string, string> = {}): SendFetch =>
    async (_url, init) => {
      seen.push({ body: init.body, signal: init.signal !== undefined })
      return { ok: status >= 200 && status < 300, status, headers: { get: (n: string) => headers[n] ?? null }, json: async () => (body instanceof Error ? Promise.reject(body) : body) }
    }
  const throws =
    (err: unknown): SendFetch =>
    async () => {
      throw err
    }

  assert.deepEqual(await postSend(answer(200, { said: 'queued' }), 'tok', card), { kind: 'sent', said: 'queued' })
  assert.deepEqual(JSON.parse(seen[0]!.body), { sessionId: 's1', text: 'hello', requestId: 'req-abcdef12' })
  assert.equal(seen[0]!.signal, true, 'the request has a timeout')
  assert.deepEqual(await postSend(answer(200, new Error('cut off')), 'tok', card), { kind: 'sent', said: null }, 'a 200 went, even if its body broke')
  assert.deepEqual(await postSend(answer(429, { error: 'too many' }, { 'retry-after': '7' }), 'tok', card), { kind: 'limited', retryAfterS: 7 })
  assert.equal((await postSend(answer(400, { error: 'text: what to send' }), 'tok', card)).kind, 'refused')
  assert.equal((await postSend(answer(502, { error: 'backend: thread not found' }), 'tok', card)).kind, 'refused')
  assert.equal((await postSend(answer(502, { error: 'backend: not known whether T3 got the message (timeout). Check the thread before sending again.' }), 'tok', card)).kind, 'unknown')
  assert.equal((await postSend(answer(502, { error: 'backend: broke', outcome: 'unknown' }), 'tok', card)).kind, 'unknown')
  assert.equal((await postSend(answer(500, { error: 'boom' }), 'tok', card)).kind, 'unknown')
  assert.equal((await postSend(answer(504, new Error('html')), 'tok', card)).kind, 'unknown')
  const dropped = await postSend(throws(new TypeError('Failed to fetch')), 'tok', card)
  assert.equal(dropped.kind, 'unknown', 'a connection that failed may have carried the message')
  const late = await postSend(throws(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), 'tok', card, 60_000)
  assert.deepEqual(late, { kind: 'unknown', why: 'No answer from the bridge in 60 s.' })
  assert.deepEqual(classifySend(200, true, { said: '' }, null), { kind: 'sent', said: null })
})
