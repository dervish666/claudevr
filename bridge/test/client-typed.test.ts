// Typed commands and the character line marker, from the client
// (client/src/hud/voice/typed.ts): a typed "cancel" that is slow to come back
// still cancels, a read that stalls lets go of the field and the countdown on
// its deadline, Cancel abandons a read at once, and an answer with no line
// clears the mark that holds announcements back. A real SendCards on a fake
// clock; nothing is sent.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SEND_COUNTDOWN_MS, SendCards, type ArmRequest, type Card } from '../../client/src/hud/voice/sendcard.ts'
import { LineWait, TYPED_TIMEOUT_MS, TypedReader } from '../../client/src/hud/voice/typed.ts'

function rig() {
  let now = 1_000_000
  let next = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  const setTimer = (fn: () => void, ms: number) => {
    const id = next++
    timers.set(id, { at: now + ms, fn })
    return id
  }
  const clearTimer = (h: unknown) => void timers.delete(h as number)
  const advance = (ms: number) => {
    const end = now + ms
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0])
      now = due[1].at
      due[1].fn()
    }
    now = end
  }
  const posts: Card[] = []
  let ids = 0
  const cards = new SendCards({
    now: () => now,
    setTimer,
    clearTimer,
    newRequestId: () => `req-${++ids}`,
    post: card => {
      posts.push(card)
      return Promise.resolve({ kind: 'sent', said: null })
    },
    onChange: () => {},
    onOutcome: () => {},
  })
  const typed = new TypedReader(cards, { setTimer, clearTimer })
  return { cards, typed, posts, advance, now: () => now }
}

const tell = (text = 'run the tests'): ArmRequest => ({ sessionId: 's-tally', callsign: 'Tally', text, viaDispatcher: false, quickConfirm: false })

/** A read the test answers by hand, and the signal it was given. */
function pending<T>() {
  let answer!: (v: T) => void
  let signal: AbortSignal | null = null
  const read = (s: AbortSignal) => {
    signal = s
    return new Promise<T>(ok => (answer = ok))
  }
  return { read, answer: (v: T) => answer(v), signal: () => signal }
}

test('typed: a "cancel" the bridge answers 8 s later still cancels the card armed before it', async () => {
  const r = rig()
  r.cards.arm(tell())
  const p = pending<string>()
  const result = r.typed.read(p.read)
  assert.equal(r.typed.busy, true)
  r.advance(8_000)
  r.cards.tick()
  assert.equal(r.posts.length, 0, 'the card waits while the typed words are read')
  p.answer('cancel')
  const m = await result
  assert.ok(m && m.ok)
  assert.equal(r.cards.isCurrent(m.generation), true, 'nothing came since, so the answer may act')
  // What useVoice's act() does with a cancel.
  r.cards.cancel('Cancelled by voice. Nothing sent.')
  r.advance(60_000)
  r.cards.tick()
  assert.equal(r.posts.length, 0)
  assert.equal(r.cards.card?.state ?? 'cleared', 'cleared')
})

test('typed: a read that never answers lets go of the field and the countdown after its deadline', async () => {
  const r = rig()
  r.cards.arm(tell())
  // A read that ignores its signal: the deadline still settles it.
  const result = r.typed.read(() => new Promise<string>(() => {}))
  r.advance(TYPED_TIMEOUT_MS - 1)
  assert.equal(r.typed.busy, true)
  assert.equal(r.posts.length, 0)
  r.advance(1)
  const m = await result
  assert.ok(m && !m.ok)
  assert.equal(m.abandoned, false)
  assert.match(String((m.error as Error).message), /no answer from the bridge in 10 s/)
  assert.equal(r.typed.busy, false, 'the field takes words again')
  assert.equal(r.cards.card!.sendAt, r.now() + SEND_COUNTDOWN_MS, 'the countdown starts again in full')
  // useVoice holds the card here (miss); what matters below is that the pause is gone for the next card.
  r.cards.cancel('test')
  r.cards.arm(tell('the next one'))
  r.advance(SEND_COUNTDOWN_MS)
  assert.equal(r.posts.length, 1, 'a later card counts down and sends: no typing pause is left behind')
  assert.equal(r.posts[0]?.text, 'the next one')
})

test('typed: the deadline aborts the signal the fetch was given', async () => {
  const r = rig()
  const p = pending<string>()
  const result = r.typed.read(p.read)
  assert.equal(p.signal()!.aborted, false)
  r.advance(TYPED_TIMEOUT_MS)
  await result
  assert.equal(p.signal()!.aborted, true)
})

test('typed: Cancel abandons the read at once, freeing the field and the countdown', async () => {
  const r = rig()
  r.cards.arm(tell())
  const p = pending<string>()
  const result = r.typed.read(p.read)
  // What useVoice's cancel() does: give up on the typed words, then cancel the card.
  assert.equal(r.typed.abandon(), true)
  r.cards.cancel('Cancelled. Nothing sent.')
  const m = await result
  assert.ok(m && !m.ok)
  assert.equal(m.abandoned, true)
  assert.equal(r.cards.isCurrent(m.generation), false, 'its answer could no longer act')
  assert.equal(p.signal()!.aborted, true)
  assert.equal(r.typed.busy, false)
  assert.equal(r.typed.abandon(), false, 'nothing left to abandon')
  r.cards.arm(tell('after the cancel'))
  r.advance(SEND_COUNTDOWN_MS)
  assert.equal(r.posts.length, 1, 'the next card is not left paused')
  // An answer arriving after all that changes nothing.
  p.answer('send')
  await Promise.resolve()
  assert.equal(r.posts.length, 1)
})

test('typed: one read at a time; a second while the first is out is refused', async () => {
  const r = rig()
  const p = pending<string>()
  const first = r.typed.read(p.read)
  assert.equal(await r.typed.read(() => Promise.resolve('again')), null)
  p.answer('status')
  const m = await first
  assert.ok(m && m.ok && m.value === 'status')
  assert.equal(r.typed.busy, false)
})

test('typed: a refusal from the bridge comes back as the error, with the pause lifted', async () => {
  const r = rig()
  r.cards.arm(tell())
  const m = await r.typed.read(() => Promise.reject(new Error('HTTP 401')))
  assert.ok(m && !m.ok)
  assert.equal(m.abandoned, false)
  assert.equal((m.error as Error).message, 'HTTP 401')
  assert.equal(r.cards.card!.sendAt, r.now() + SEND_COUNTDOWN_MS)
})

test('line marker: an answer with no line, after a status line was asked for, clears the mark so announcements can play', () => {
  const marks: (string | null)[] = []
  const lines = new LineWait(w => marks.push(w))
  const status = lines.start('bosun') // "status" in character mode: the line is on its way
  assert.equal(lines.waiting, 'bosun')
  lines.drop() // a typed tell before it landed: no line of its own
  assert.equal(lines.waiting, null, 'nothing is awaited any more')
  assert.equal(lines.land(status), false, 'the late status line is dropped, not spoken')
  assert.deepEqual(marks, ['bosun', null])
})

test('line marker: a newer line replaces the old one, and only the newest lands', () => {
  const lines = new LineWait(() => {})
  const a = lines.start('bosun')
  const b = lines.start('bosun')
  assert.equal(lines.land(a), false)
  assert.equal(lines.waiting, 'bosun', 'still waiting for the newer one')
  assert.equal(lines.land(b), true)
  assert.equal(lines.waiting, null)
})

test('going (unmount, unpair): a typed answer that lands after dispose cannot arm or send a card', async () => {
  const r = rig()
  const p = pending<string>()
  const result = r.typed.read(p.read)
  // What useVoice's cleanup does, minus the abandon, to show dispose alone makes the answer stale.
  r.cards.dispose()
  p.answer('tell tally run the tests')
  const m = await result
  assert.ok(m && m.ok)
  assert.equal(r.cards.isCurrent(m.generation), false, 'the answer is stale, so the hook does not act on it')
  assert.equal(r.cards.arm(tell(), m.generation), null, 'and arm refuses it even if asked')
  r.advance(60_000)
  assert.equal(r.posts.length, 0)
  // Not a one-way switch: StrictMode mounts again, and a fresh intent works.
  const fresh = r.cards.newIntent()
  assert.ok(r.cards.arm(tell('after remount'), fresh))
  r.advance(SEND_COUNTDOWN_MS)
  assert.equal(r.posts.length, 1)
})

test('going: a card armed and paused for typed words does not send when the abandoned read lets go after dispose', async () => {
  const r = rig()
  r.cards.arm(tell('run the tests'))
  const p = pending<string>()
  const result = r.typed.read(p.read)
  // useVoice's cleanup: abandon the read, then dispose. The read settles a moment later and lifts its pause.
  r.typed.abandon()
  r.cards.dispose()
  await result
  r.advance(60_000)
  r.cards.tick()
  assert.equal(r.posts.length, 0, 'nothing sends behind the pairing screen')
  assert.equal(r.cards.card, null, 'the armed card went with the HUD')
})

test('going: a card armed and paused for a clip does not send when the clip ends after dispose', () => {
  const r = rig()
  r.cards.arm(tell('run the tests'))
  r.cards.setTalking(true) // a clip being transcribed
  r.cards.dispose()
  r.cards.setTalking(false) // the aborted upload comes back into end(), which goes idle
  r.advance(60_000)
  r.cards.tick()
  assert.equal(r.posts.length, 0)
  // And the controller still works for a remount.
  r.cards.arm(tell('after remount'), r.cards.newIntent())
  r.advance(SEND_COUNTDOWN_MS)
  assert.equal(r.posts.length, 1)
})

test('going: a hold still open at unmount leaves no pause behind for the remount', () => {
  const r = rig()
  r.cards.setTalking(true) // StrictMode unmounts mid-hold; the hold never ends in this instance
  r.cards.dispose()
  r.cards.arm(tell('after remount'), r.cards.newIntent())
  r.advance(SEND_COUNTDOWN_MS)
  assert.equal(r.posts.length, 1, 'the remount card counts down; no talking pause survived dispose()')
})
