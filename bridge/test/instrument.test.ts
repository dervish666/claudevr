// The instrument scene's pure logic, from the client: tile layout, the
// needs-you rail's overflow, and the reply cards' trigger and queue.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Need, Session, SessionState } from '../../shared/protocol.ts'
import { DEMO_MIN, MORE_SLOT, REAL_TILES, assignSlots, planTiles, slotPose, tileExtent, type TileAgent } from '../../client/src/instrument/layout.ts'
import { EMPTY_QUEUE, REPLY_MAX, REPLY_TTL_MS, dismissReply, expireReplies, firstLines, nextExpiry, pushReplies, railItems, replyTriggers, snapshot, type ReplyCard } from '../../client/src/instrument/cards.ts'
import { hhmm, msToNextMinute } from '../../client/src/time.ts'

const agents = (n: number, state: SessionState = 'idle'): TileAgent[] => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, state, activeAt: 1000 - i }))

test('tile layout: 1 to 12 sessions, nobody dropped, no overlaps', () => {
  for (let n = 1; n <= 12; n++) {
    const a = agents(n)
    const slots = assignSlots({}, a)
    const { tiles, hidden } = planTiles(slots, a)
    const real = tiles.filter(t => t.kind === 'session')
    const demo = tiles.filter(t => t.kind === 'demo')
    const more = tiles.filter(t => t.kind === 'more')
    assert.equal(real.length, Math.min(n, REAL_TILES), `n=${n} real tiles`)
    assert.equal(real.length + hidden.length, n, `n=${n} everyone accounted for`)
    assert.equal(demo.length, Math.max(0, DEMO_MIN - n), `n=${n} demo padding`)
    assert.equal(more.length, n > REAL_TILES ? 1 : 0, `n=${n} +N tile`)
    if (more[0]?.kind === 'more') {
      assert.equal(more[0].slot, MORE_SLOT)
      assert.equal(more[0].hidden.length, n - REAL_TILES)
    }
    const used = tiles.map(t => t.slot)
    assert.equal(new Set(used).size, used.length, `n=${n} slots unique`)
    // The outer columns open only past six.
    assert.equal(
      tiles.some(t => slotPose(t.slot).column === 1),
      n > 6,
      `n=${n} outer column use`,
    )
    // No two tiles overlap, as seen from the eye.
    for (const x of used)
      for (const y of used) {
        if (x >= y) continue
        const [l1, r1, b1, t1] = tileExtent(x)
        const [l2, r2, b2, t2] = tileExtent(y)
        const apart = r1 <= l2 || r2 <= l1 || t1 <= b2 || t2 <= b1
        assert.ok(apart, `n=${n}: slots ${x} and ${y} overlap`)
      }
  }
})

test('tile layout: wings mirror each other and stay clear of the Core', () => {
  for (let s = 0; s < 12; s += 2) {
    const l = slotPose(s)
    const r = slotPose(s + 1)
    assert.equal(l.side, -1)
    assert.equal(r.side, 1)
    assert.ok(Math.abs(l.x + r.x) < 1e-9 && Math.abs(l.y - r.y) < 1e-9)
  }
  // The Core's ring is 0.6 m in radius at about 1.33 m: about 24 degrees.
  const ring = Math.atan(0.6 / 1.33)
  for (let s = 0; s < 12; s++) assert.ok(Math.abs(tileExtent(s)[s % 2 ? 0 : 1]) > ring, `slot ${s} clears the ring`)
})

test('tile layout: slots are sticky as the fleet grows, and a shrinking fleet moves in', () => {
  const four = agents(4)
  const s4 = assignSlots({}, four)
  const eight = [...four, ...agents(8).slice(4)]
  const s8 = assignSlots(s4, eight)
  for (const a of four) assert.equal(s8[a.id], s4[a.id], 'existing tiles keep their slots')
  assert.ok(Object.values(s8).some(v => v >= 6), 'the eighth session opens an outer column')
  // Down to five: anyone in an outer slot moves into a free inner one.
  const outer = Object.entries(s8).find(([, v]) => v >= 6)![0]
  const five = eight.filter(a => a.id === outer || four.some(f => f.id === a.id))
  const s5 = assignSlots(s8, five)
  assert.ok(s5[outer]! < 6, 'moved inward')
  for (const a of four) assert.equal(s5[a.id], s4[a.id], 'and nobody else moves')
})

test('tile layout: an asking session claims a free slot before an idle one; past ten it waits on the +N tile', () => {
  const a = agents(10)
  const s = assignSlots({}, a)
  const extra: TileAgent[] = [...a, { id: 'late-idle', state: 'idle', activeAt: 5000 }, { id: 'late-ask', state: 'asking', activeAt: 1 }]
  const s2 = assignSlots(s, extra)
  const { tiles, hidden } = planTiles(s2, extra)
  assert.deepEqual(hidden, ['late-ask', 'late-idle'], 'hidden, asking first')
  assert.equal(tiles.find(t => t.kind === 'more')?.kind, 'more')
  const fresh = assignSlots({}, [{ id: 'i', state: 'idle', activeAt: 9 }, { id: 'q', state: 'asking', activeAt: 1 }])
  assert.equal(fresh.q, 0)
  assert.equal(fresh.i, 1)
  // A stored slot that is out of range or doubled is ignored, never trusted.
  const bad = assignSlots({ s0: 99, s1: 0, s2: 0 }, agents(3))
  assert.equal(new Set(Object.values(bad)).size, 3)
})

const need = (id: string, since: number | null): Need => ({ id, kind: 'question', sessionId: id, callsign: id, label: id, text: `q ${id}`, options: [], since, source: 'test' })

test('rail: empty draws nothing, overflow keeps the oldest and counts the rest', () => {
  assert.deepEqual(railItems([]), { shown: [], more: 0 })
  const three = railItems([need('b', 20), need('a', 10), need('c', null)])
  assert.deepEqual(
    three.shown.map(n => n.id),
    ['a', 'b', 'c'],
    'oldest first, unknown age last',
  )
  assert.equal(three.more, 0)
  const four = railItems([need('a', 1), need('b', 2), need('c', 3), need('d', 4)])
  assert.equal(four.shown.length, 4, 'four fit exactly')
  assert.equal(four.more, 0)
  const nine = railItems(Array.from({ length: 9 }, (_, i) => need(`n${i}`, 100 - i)))
  assert.deepEqual(
    nine.shown.map(n => n.id),
    ['n8', 'n7', 'n6'],
  )
  assert.equal(nine.more, 6)
  assert.equal(nine.shown.length + nine.more, 9, 'nothing silently dropped')
})

const session = (id: string, state: SessionState, lastLine: string | null, extra: Partial<Session> = {}): Session => ({
  id,
  callsign: id.toUpperCase(),
  title: id,
  project: null,
  kind: 'interactive',
  state,
  action: null,
  lastLine,
  activeAt: 0,
  startedAt: 0,
  asking: null,
  messages: lastLine ? [{ at: 0, text: lastLine }] : [],
  canSend: true,
  context: null,
  ...extra,
})

test('reply cards: fire on a new line or on stopping work, never on first sight or for the target', () => {
  const before = [session('a', 'working', 'one'), session('b', 'working', 'x'), session('t', 'working', 'y')]
  assert.deepEqual(replyTriggers(null, before, null), [], 'the first look after entry fires nothing')
  const prev = snapshot(before)
  const after = [
    session('a', 'working', 'two\nsecond line\n\nthird\nfourth'),
    session('b', 'idle', 'x'),
    session('t', 'idle', 'new for target'),
    session('new', 'working', 'hello'),
  ]
  const cards = replyTriggers(prev, after, 't')
  assert.deepEqual(
    cards.map(c => [c.id, c.why]),
    [
      ['a', 'said'],
      ['b', 'finished'],
    ],
  )
  assert.deepEqual(cards[0]!.lines, ['two', 'second line', 'third'], 'first three non-empty lines')
  assert.equal(cards[1]!.lines.length, 1)
  assert.deepEqual(replyTriggers(snapshot(after), after, null), [], 'an unchanged fleet fires nothing')
  const asking = replyTriggers(prev, [session('a', 'asking', 'one', { asking: { text: 'Which one?', options: [], answerAt: null } })], null)
  assert.equal(asking[0]!.why, 'asking')
  assert.deepEqual(asking[0]!.lines, ['Which one?'])
  assert.equal(firstLines('x'.repeat(200), 3, 20)[0]!.length, 20)
})

const card = (id: string): ReplyCard => ({ id, callsign: id, why: 'said', lines: [id], shownAt: null })

test('reply cards: at most a few at once, the rest queue, each lasts its time', () => {
  let q = pushReplies(EMPTY_QUEUE, [card('a'), card('b'), card('c'), card('d'), card('e')], 1000)
  assert.equal(q.shown.length, REPLY_MAX)
  assert.deepEqual(
    q.waiting.map(c => c.id),
    ['d', 'e'],
  )
  assert.equal(nextExpiry(q), 1000 + REPLY_TTL_MS)
  assert.equal(expireReplies(q, 1000 + REPLY_TTL_MS - 1), q, 'nothing changes before time')
  q = expireReplies(q, 1000 + REPLY_TTL_MS)
  assert.deepEqual(
    q.shown.map(c => c.id),
    ['d', 'e'],
  )
  assert.equal(q.shown[0]!.shownAt, 1000 + REPLY_TTL_MS, 'a promoted card gets its full time')
  // The same session again updates its card in place and restarts it.
  q = pushReplies(q, [{ ...card('d'), lines: ['newer'] }], 12_000)
  assert.equal(q.shown.length, 2)
  assert.deepEqual(q.shown.find(c => c.id === 'd')!.lines, ['newer'])
  assert.equal(q.shown.find(c => c.id === 'd')!.shownAt, 12_000)
  // Picking a card, or selecting its session, takes it away and promotes the next.
  q = pushReplies(q, [card('f'), card('g')], 12_500)
  assert.deepEqual(
    q.waiting.map(c => c.id),
    ['g'],
  )
  q = dismissReply(q, 'e', 13_000)
  assert.deepEqual(
    q.shown.map(c => c.id).sort(),
    ['d', 'f', 'g'],
  )
  assert.equal(q.waiting.length, 0)
  assert.equal(dismissReply(q, 'nobody', 13_000), q)
})

test('clock: 24-hour HH:MM and the wait to the next minute', () => {
  assert.equal(hhmm(new Date(2026, 10, 15, 9, 5)), '09:05')
  assert.equal(hhmm(new Date(2026, 10, 15, 23, 59)), '23:59')
  assert.equal(hhmm(new Date(2026, 10, 15, 0, 0)), '00:00')
  assert.equal(msToNextMinute(120_000), 60_000)
  assert.equal(msToNextMinute(120_001), 59_999)
})
