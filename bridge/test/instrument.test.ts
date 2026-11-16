// The instrument scene's pure logic, from the client: tile layout, the
// needs-you rail's overflow, and the reply cards' trigger and queue; the
// send card's held line and arming tone; and, from the 2D page, the alarms'
// announcements and unpairing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Need, Session, SessionState } from '../../shared/protocol.ts'
import { MORE_SLOT, REAL_TILES, SUB_LINE_CHARS, SUB_ROOM, SUB_TYPE_CHARS, SUB_W, assignSlots, moreFitsBelow, planSubBoxes, planTiles, slotPose, stateSize, subBoxExtent, subjectChars, tileExtent, type TileAgent } from '../../client/src/instrument/layout.ts'
import { HELD_LINE, TALKING_LINE, armsNow, countdownLeft, countdownLine, countdownStep } from '../../client/src/instrument/sendcue.ts'
import { alarmLine, alarmsOf } from '../../client/src/hud/alarms.ts'
import { unpair } from '../../client/src/pairing.ts'
import { FINISHED_SHOWN_MS, runTime, shownAgents } from '../../shared/agents.ts'
import type { AgentInfo } from '../../shared/protocol.ts'
import { EMPTY_QUEUE, REPLY_MAX, REPLY_TTL_MS, dismissReply, expireReplies, firstLines, nextExpiry, pushReplies, railItems, replyTriggers, snapshot, type ReplyCard } from '../../client/src/instrument/cards.ts'
import { hhmm, msToNextMinute } from '../../client/src/time.ts'

const agents = (n: number, state: SessionState = 'idle'): TileAgent[] => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, state, activeAt: 1000 - i }))

test('tile layout: 0 to 12 sessions, nobody dropped, no padding, no overlaps', () => {
  for (let n = 0; n <= 12; n++) {
    const a = agents(n)
    const slots = assignSlots({}, a)
    const { tiles, hidden } = planTiles(slots, a)
    const real = tiles.filter(t => t.kind === 'session')
    const more = tiles.filter(t => t.kind === 'more')
    assert.equal(real.length, Math.min(n, REAL_TILES), `n=${n} real tiles`)
    assert.equal(real.length + hidden.length, n, `n=${n} everyone accounted for`)
    assert.equal(tiles.length, Math.min(n, REAL_TILES) + (n > REAL_TILES ? 1 : 0), `n=${n} only real tiles and the +N tile, no padding`)
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

test('sub-agent boxes: at 1, 6 and 10 sessions, every tile with a full lane and a "+N", nothing overlaps', () => {
  for (const n of [1, 6, 10]) {
    const a = agents(n)
    const { tiles } = planTiles(assignSlots({}, a), a)
    const boxes: { what: string; e: [number, number, number, number] }[] = []
    for (const t of tiles) {
      boxes.push({ what: `tile ${t.slot}`, e: tileExtent(t.slot) })
      if (t.kind !== 'session') continue
      const plan = planSubBoxes(5, 2, moreFitsBelow(t.slot))
      assert.equal(plan.boxes, SUB_ROOM, `n=${n} slot ${t.slot}: a full lane`)
      assert.equal(plan.more, 2 + 2)
      assert.equal(plan.moreAt, 'below', `n=${n} slot ${t.slot}: the +N box fits under the lane`)
      for (let i = 0; i < plan.boxes; i++) boxes.push({ what: `slot ${t.slot} box ${i}`, e: subBoxExtent(t.slot, i) })
      boxes.push({ what: `slot ${t.slot} +N`, e: subBoxExtent(t.slot, 'more') })
    }
    for (const [i, x] of boxes.entries())
      for (const y of boxes.slice(i + 1)) {
        const [l1, r1, b1, t1] = x.e
        const [l2, r2, b2, t2] = y.e
        assert.ok(r1 <= l2 || r2 <= l1 || t1 <= b2 || t2 <= b1, `n=${n}: ${x.what} overlaps ${y.what}`)
      }
    // Lanes are on the outer side, so the Core's side of each tile stays clear for the tether.
    for (const b of boxes) assert.ok(Math.min(Math.abs(b.e[0]), Math.abs(b.e[1])) > Math.atan(0.6 / 1.33), `${b.what} clears the ring`)
  }
})

test('sub-agent boxes: the cap and the "+N", and fewer boxes when the +N has no room under the lane', () => {
  assert.deepEqual(planSubBoxes(0, 0), { boxes: 0, more: 0, moreAt: null })
  assert.deepEqual(planSubBoxes(2, 0), { boxes: 2, more: 0, moreAt: null })
  assert.deepEqual(planSubBoxes(3, 0), { boxes: 3, more: 0, moreAt: null })
  assert.deepEqual(planSubBoxes(4, 0), { boxes: 3, more: 1, moreAt: 'below' })
  assert.deepEqual(planSubBoxes(1, 2), { boxes: 1, more: 2, moreAt: 'below' }, 'running agents the bridge left out still count')
  assert.deepEqual(planSubBoxes(5, 0, false), { boxes: 2, more: 3, moreAt: 'lane' }, 'no room under: the +N takes the last place')
  assert.deepEqual(planSubBoxes(1, 1, false), { boxes: 1, more: 1, moreAt: 'lane' })
  assert.deepEqual(planSubBoxes(-3, Number.NaN), { boxes: 0, more: 0, moreAt: null })
})

test('sub-agent boxes: running always show, finished ones for two minutes after they end', () => {
  const now = 10_000_000
  const ag = (id: string, state: AgentInfo['state'], endedAt: number | null, startedAt: number | null = now - 600_000): AgentInfo => ({ id, type: 't', description: 'd', state, model: null, startedAt, endedAt, now: null, depth: 1, brief: null, recent: [] })
  const s = { agents: [ag('run', 'running', null, now - 9e9), ag('just', 'done', now - 30_000), ag('old', 'done', now - FINISHED_SHOWN_MS - 1), ag('bad', 'failed', now - 1000), ag('noend', 'unknown', null)], moreRunning: 2 }
  const r = shownAgents(s, now)
  assert.deepEqual(r.agents.map(a => a.id), ['run', 'just', 'bad'])
  assert.equal(r.hiddenRunning, 2)
  assert.deepEqual(shownAgents({}, now), { agents: [], hiddenRunning: 0 })
  assert.equal(runTime({ startedAt: now - 250_000, endedAt: null }, now), '4m 10s')
  assert.equal(runTime({ startedAt: now - 35_000, endedAt: now - 5000 }, now), '30s')
  assert.equal(runTime({ startedAt: null, endedAt: null }, now), null)
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

// ---------------------------------------------------------------- text that has to fit

/** A string's width in px as uikit lays it out from an MSDF atlas: advances, kerning, and letter spacing per glyph. */
const atlases = new Map<string, { size: number; chars: Map<string, { id: number; xadvance: number }>; kern: Map<string, number> }>()
function textWidth(text: string, font: 'rajdhani-600' | 'rajdhani-700' | 'inter-400', px: number, spacingEm = 0): number {
  let a = atlases.get(font)
  if (!a) {
    const j = JSON.parse(readFileSync(join(import.meta.dirname, '../../client/public/fonts', `${font}.json`), 'utf8')) as { info: { size: number }; chars: { id: number; char: string; xadvance: number }[]; kernings?: { first: number; second: number; amount: number }[] }
    a = { size: j.info.size, chars: new Map(j.chars.map(c => [c.char, c])), kern: new Map((j.kernings ?? []).map(k => [`${k.first}:${k.second}`, k.amount])) }
    atlases.set(font, a)
  }
  let w = 0
  let prev: { id: number } | null = null
  for (const ch of text) {
    const c = a.chars.get(ch)
    assert.ok(c, `${font} has "${ch}"`)
    w += (c.xadvance / a.size) * px + spacingEm * px
    if (prev) w += ((a.kern.get(`${prev.id}:${c.id}`) ?? 0) / a.size) * px
    prev = c
  }
  return w
}

const STATES: SessionState[] = ['working', 'thinking', 'asking', 'idle', 'failed', 'done', 'unknown']

test('tile state line: every state, read-only or not, fits beside the gauge on one line with the bosun pack\'s 0.1 em labels', () => {
  // The tile is 300 px with 14 px padding, and the header keeps 82 px clear for the gauge.
  const room = 300 - 2 * 14 - 82
  for (const st of STATES)
    for (const line of [st.toUpperCase(), `${st.toUpperCase()} · READ ONLY`]) {
      const px = stateSize(line)
      assert.ok(px >= 14, `${line}: ${px} px is readable`)
      // 4 px kept spare: the layout rounds to whole pixels, and a line a pixel short wraps.
      const w = textWidth(line, 'rajdhani-600', px, 0.1)
      assert.ok(w <= room - 4, `${line} at ${px} px is ${w.toFixed(0)} px, room ${room}`)
    }
  assert.equal(stateSize('WORKING'), 22, 'a short line keeps the full size')
})

test('tile foot: the cut title and the widest age fit side by side, in operator mode and under wider-spaced packs', () => {
  const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t)
  // The tile's 272 px inside its padding, less the 10 px gap.
  const room = 300 - 2 * 14 - 10
  for (const ls of [0, 0.06, 0.1, 0.2]) {
    const n = subjectChars(ls)
    for (const title of ['FIX WEATHER CARD REFRESH', 'UPGRADE THE TEST RUNNER', 'PORT THE GREENHOUSE SHADER TO WEBGL', 'RENAME BILLING FIELDS', 'RATE LIMIT THE WEBHOOK']) {
      const w = textWidth(clip(title, n), 'rajdhani-600', 16, ls) + textWidth('59M AGO', 'rajdhani-600', 18, ls)
      assert.ok(w <= room, `spacing ${ls}: "${clip(title, n)}" and its age take ${w.toFixed(0)} px, room ${room}`)
    }
  }
  assert.ok(subjectChars(0) >= 24, 'operator mode keeps a title like "FIX WEATHER CARD REFRESH" whole')
})

test('sub-agent boxes: 14 px lines and the cut type fit inside the box, with RUNNING beside the type', () => {
  const inner = SUB_W * 1000 - 2 * 6
  const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t)
  for (const d of ['Find who owns the nightly build', 'Rewrite the tide table parser', 'List every caller of loadBerths', 'Port the greenhouse shader to WebGL 2', 'Measure frame time on the trellis scene', 'Grep: owner in build notes', 'Bash: npm test -- tides', 'Edit: shaders/glass.frag', 'Glob: **/textures/*.ts']) {
    const w = textWidth(clip(d, SUB_LINE_CHARS), 'inter-400', 14)
    assert.ok(w <= inner, `"${clip(d, SUB_LINE_CHARS)}" is ${w.toFixed(0)} px, room ${inner}`)
  }
  for (const t of ['GENERAL-PURPOSE', 'EXPLORE', 'PLAN', 'STATUSLINE-SETUP', 'CODE-REVIEWER']) {
    const w = textWidth(clip(t, SUB_TYPE_CHARS), 'rajdhani-700', 15, 0.06) + 6 + textWidth('RUNNING', 'rajdhani-700', 14, 0.06)
    assert.ok(w <= inner, `${clip(t, SUB_TYPE_CHARS)} and RUNNING take ${w.toFixed(0)} px, room ${inner}`)
  }
})

// ---------------------------------------------------------------- the send card in instrument mode

test('send card: a held card shows the pause line and drains no arc; an armed one counts down; talking pauses it', () => {
  const armed = { held: false, sendAt: 10_000, countdownMs: 5000 }
  const held = { held: true, sendAt: 10_000, countdownMs: 5000 }
  assert.equal(countdownLine(countdownStep(armed, false, 5_000)), 'SENDS IN 5')
  assert.equal(countdownLine(countdownStep(armed, false, 9_001)), 'SENDS IN 1')
  assert.equal(countdownLine(countdownStep(armed, false, 12_000)), 'SENDS IN 0')
  assert.equal(countdownLine(countdownStep(armed, true, 7_000)), TALKING_LINE)
  // Held wins over talking, and over a deadline long gone: nothing counts.
  assert.equal(countdownLine(countdownStep(held, true, 7_000)), HELD_LINE)
  assert.equal(countdownLine(countdownStep(held, false, 60_000)), HELD_LINE)
  assert.equal(HELD_LINE, 'PAUSED · SAY SEND OR CANCEL')
  assert.equal(countdownLeft(held, 7_000), null)
  assert.equal(countdownLeft(armed, 7_500), 0.5)
  assert.equal(countdownLeft(armed, 20_000), 0)
})

test('send card: the arming tone plays once per card, not again when it is held or re-armed', () => {
  let last: number | null = null
  const seen: number[] = []
  const step = (card: { id: number; state: 'armed' | 'sending' | 'sent' | 'cancelled' } | null) => {
    if (armsNow(last, card)) {
      last = card!.id
      seen.push(card!.id)
    }
  }
  step(null)
  step({ id: 1, state: 'armed' })
  step({ id: 1, state: 'armed' }) // held, or restarted after he talked: the same card
  step({ id: 1, state: 'sending' })
  step({ id: 1, state: 'sent' })
  step(null)
  step({ id: 2, state: 'cancelled' })
  step({ id: 3, state: 'armed' })
  assert.deepEqual(seen, [1, 3])
})

// ---------------------------------------------------------------- the 2D page

test('alarms: keyed by kind, and the words a screen reader announces do not change as the seconds tick', () => {
  const b = { link: 'down' as const, linkError: 'bridge unreachable: connect ECONNREFUSED', fleet: { at: 1_000 } as never, status: { ok: false, name: 'fake', error: 'timed out', lastOkAt: 2_000 } as never, heardAt: 3_000, downSince: 4_000 }
  const a1 = alarmsOf(b, 10_000)
  const a2 = alarmsOf(b, 23_000)
  assert.deepEqual(a1.map(a => a.kind), ['bridge-down', 'backend-down'])
  assert.deepEqual(a2.map(a => a.kind), a1.map(a => a.kind))
  assert.deepEqual(a2.map(a => a.text), a1.map(a => a.text), 'announced text unchanged across ticks')
  assert.notDeepEqual(a2.map(a => a.age), a1.map(a => a.age), 'the age does tick')
  assert.equal(a1[0]!.text, 'BRIDGE UNREACHABLE: connect ECONNREFUSED. Showing the last fleet seen.')
  assert.equal(alarmLine(a1[0]!), 'BRIDGE UNREACHABLE: connect ECONNREFUSED. Showing the last fleet seen. Down for 6s, fleet 9s old.')
  const quiet = alarmsOf({ link: 'open', linkError: null, fleet: null, status: null, heardAt: 1_000, downSince: null }, 20_000)
  assert.deepEqual(quiet.map(a => [a.kind, a.text]), [['bridge-quiet', 'NO WORD FROM THE BRIDGE.']])
  assert.deepEqual(alarmsOf({ link: 'open', linkError: null, fleet: null, status: null, heardAt: 19_000, downSince: null }, 20_000), [])
})

test('unpair: posts the token, and reports why when the bridge did not revoke it', async () => {
  const real = globalThis.fetch
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const answer = (r: () => Response | Promise<Response>) => {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return r()
    }) as typeof fetch
  }
  try {
    answer(() => Response.json({ revoked: true }))
    assert.deepEqual(await unpair('tok-1'), { revoked: true })
    assert.equal(calls[0]!.url, '/api/unpair')
    assert.equal(calls[0]!.init?.method, 'POST')
    assert.equal((calls[0]!.init?.headers as Record<string, string>).authorization, 'Bearer tok-1')

    const legacy = 'the legacy token is shared by every browser that has it; revoke it on the pairing page at https://localhost:8443/pair'
    answer(() => Response.json({ revoked: false, reason: legacy }))
    assert.deepEqual(await unpair('tok-2'), { revoked: false, reason: legacy })

    answer(() => Response.json({ error: 'unauthorized' }, { status: 401 }))
    assert.deepEqual(await unpair('tok-3'), { revoked: false, reason: 'the bridge refused to revoke it: unauthorized' })

    answer(() => {
      throw new TypeError('Failed to fetch')
    })
    assert.deepEqual(await unpair('tok-4'), { revoked: false, reason: 'bridge unreachable: Failed to fetch' })
  } finally {
    globalThis.fetch = real
  }
})

test('unpair: a bridge that never answers is given up on, so the page can forget the token', async () => {
  const real = globalThis.fetch
  const realTimeout = AbortSignal.timeout
  let signalled: AbortSignal | undefined
  // The request hangs until its signal fires, as a dead Wi-Fi link would.
  globalThis.fetch = ((_url: string, init?: RequestInit) => {
    signalled = init?.signal ?? undefined
    return new Promise((_ok, fail) => init?.signal?.addEventListener('abort', () => fail(init.signal!.reason)))
  }) as typeof fetch
  const ms: number[] = []
  AbortSignal.timeout = (n: number) => {
    ms.push(n)
    const c = new AbortController()
    setTimeout(() => c.abort(new DOMException('signal timed out', 'TimeoutError')), 5)
    return c.signal
  }
  try {
    assert.deepEqual(await unpair('tok-5'), { revoked: false, reason: 'no answer from the bridge in 5 s' })
    assert.ok(signalled, 'the request carries a signal')
    assert.deepEqual(ms, [5000])
  } finally {
    globalThis.fetch = real
    AbortSignal.timeout = realTimeout
  }
})
