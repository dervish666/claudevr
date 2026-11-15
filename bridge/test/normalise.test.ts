import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { clip, normalise, parseLocalStamp, readT3 } from '../src/backend/dashweb/normalise.ts'

const FIX = join(import.meta.dirname, '..', '..', 'fixtures')
const load = (name: string) => JSON.parse(readFileSync(join(FIX, name), 'utf8')) as Record<string, any>
const board = () => load('board.json')
const t3 = () => load('t3.json')

const BUSY = 'b2e07a6c-d1fe-cc87-ac1e-f2aefa7b9949'
const IDLE = '6cc1b82e-a279-dab0-465e-ff2b4a03d828'

test('the captured board gives both live sessions with callsigns, states and actions', () => {
  const { fleet } = normalise(board(), t3())
  assert.equal(fleet.at, 1794736094382)
  assert.deepEqual(
    fleet.sessions.map(s => [s.id, s.callsign, s.state]),
    [
      [BUSY, 'Kettle VR', 'working'],
      [IDLE, 'Kettle', 'idle'],
    ],
  )
  const busy = fleet.sessions[0]!
  assert.equal(busy.action, 'Agent: briefing an agent: Speed Up Config Keys')
  assert.equal(busy.project, 'KettleVR')
  assert.equal(busy.kind, 'interactive')
  assert.ok(busy.lastLine && busy.lastLine.length <= 240)
  assert.equal(fleet.sessions[1]!.action, null, 'an idle session has no action line')
})

test('focus messages are what the session said, newest last, at most six', () => {
  const { fleet } = normalise(board(), t3())
  for (const s of fleet.sessions) {
    assert.ok(s.messages.length > 0 && s.messages.length <= 6)
    const ats = s.messages.map(m => m.at ?? 0)
    assert.deepEqual(ats, [...ats].sort((a, b) => a - b))
    assert.equal(s.lastLine, clip(s.messages.at(-1)!.text))
  }
})

test('the needs queue carries each open ledger question once, with its age', () => {
  const { fleet } = normalise(board(), t3())
  assert.deepEqual(
    fleet.needs.map(n => [n.id, n.kind, n.label, n.source]),
    [
      ['task:T-415:Q-1', 'needs-sam', 'T-415 garden', 'ledger table'],
      ['task:T-420:Q-1', 'needs-sam', 'T-420 harbour', 'ledger table'],
    ],
  )
  assert.equal(fleet.needs[0]!.since, new Date(2026, 10, 9, 12, 55).getTime())
  assert.equal(fleet.needs[1]!.since, new Date(2026, 10, 10).getTime())
})

test('sessions on a non-native T3 thread are routed for send', () => {
  const { fleet, routes } = normalise(board(), t3())
  assert.equal(routes.get(BUSY), 'afd5b10a-0619-956e-9bc7-1cc3dddc115c')
  assert.equal(routes.get(IDLE), '6675ab73-d2db-25b9-3bda-17771c98e01c')
  assert.ok(fleet.sessions.every(s => s.canSend))
})

test('a native (mirrored) T3 thread is not routed', () => {
  const t = t3()
  for (const th of t.list) if (th.threadId === 'afd5b10a-0619-956e-9bc7-1cc3dddc115c') th.native = true
  const { fleet, routes } = normalise(board(), t)
  assert.equal(routes.has(BUSY), false)
  assert.equal(fleet.sessions.find(s => s.id === BUSY)!.canSend, false)
})

test('ledger rows and closed items come through; usage not read says so, never zero', () => {
  const { fleet } = normalise(board(), t3())
  assert.equal(fleet.ledger?.ok, true)
  assert.deepEqual(
    fleet.ledger?.rows.map(r => [r.task, r.verdict]),
    [
      ['T-415', 'NEEDS SAM'],
      ['T-420', 'NEEDS SAM'],
    ],
  )
  assert.equal(fleet.ledger?.closed.length, 3)
  assert.equal(fleet.usage.todayUsd.value, null)
  assert.equal(fleet.usage.limits.value, null)
  assert.match(fleet.usage.limits.note ?? '', /not read/)
  assert.ok(fleet.sessions.every(s => s.context === null))
  assert.ok(fleet.warnings.includes('no dispatcher session is live'))
})

test('T3 unreadable: the fleet still shows, sends are off, and it says so', () => {
  const { fleet, routes } = normalise(board(), new Error('connect ECONNREFUSED'))
  assert.equal(fleet.sessions.length, 2)
  assert.equal(routes.size, 0)
  assert.ok(fleet.sessions.every(s => !s.canSend))
  assert.ok(fleet.warnings.some(w => w.includes('T3 not readable') && w.includes('ECONNREFUSED')))
  const t = t3()
  t.state = 'unavailable'
  t.reason = 'no node:sqlite'
  assert.ok(normalise(board(), t).fleet.warnings.some(w => w.includes('no node:sqlite')))
})

test('a response that is not a board throws instead of giving an empty fleet', () => {
  assert.throws(() => normalise({ error: 'not a feed reader' }, t3()), /did not return a board/)
  assert.throws(() => normalise(null, t3()), /did not return a board/)
  assert.throws(() => normalise('<html>', t3()), /did not return a board/)
})

test('dashweb unable to list sessions is a warning, not a quiet empty fleet', () => {
  const b = board()
  b.sessions = { from: 'claude agents', error: 'claude agents exited 1', count: 0 }
  b.other = []
  const { fleet } = normalise(b, t3())
  assert.equal(fleet.sessions.length, 0)
  assert.ok(fleet.warnings.some(w => w.includes('cannot list live sessions')))
})

test('an AskUserQuestion dialog makes the session "asking" and puts it in the queue', () => {
  const b = board()
  b.other[1].asking = [{ id: 'q1', station: 'main', questions: [{ question: 'Ship it now?', header: 'Ship', options: [{ label: 'Yes' }, { label: 'Not yet' }], multiSelect: false }] }]
  const { fleet } = normalise(b, t3())
  const s = fleet.sessions.find(x => x.id === IDLE)!
  assert.equal(s.state, 'asking')
  assert.deepEqual(s.asking, { text: 'Ship it now?', options: ['Yes', 'Not yet'], answerAt: null })
  const n = fleet.needs.find(x => x.sessionId === IDLE)!
  assert.equal(n.kind, 'question')
  assert.equal(n.callsign, 'Kettle')
})

test('a failed session and a failed ledger report both reach the queue', () => {
  const b = board()
  b.other[1].state = 'failed'
  b.kanban.cards[0].failed = { at: 1794730000000, text: 'FAILED T-415 build broke', source: 'transcript' }
  const { fleet } = normalise(b, t3())
  assert.ok(fleet.needs.some(n => n.kind === 'failed' && n.sessionId === IDLE))
  const f = fleet.needs.find(n => n.id === 'task:T-415:failed')!
  assert.equal(f.since, 1794730000000)
  assert.ok(!fleet.needs.some(n => n.id === 'task:T-415:Q-1'), 'a failed card is listed once, as failed')
})

test('T3 requests waiting on a thread the board does not carry become approvals', () => {
  const t = t3()
  const loose = t.list.find((x: any) => !x.native && x.threadId !== 'afd5b10a-0619-956e-9bc7-1cc3dddc115c' && x.threadId !== '6675ab73-d2db-25b9-3bda-17771c98e01c')
  loose.pending = 2
  const { fleet } = normalise(board(), t)
  const n = fleet.needs.find(x => x.kind === 'approval')!
  assert.equal(n.text, '2 requests waiting in T3')
  assert.equal(n.label, loose.title)
  assert.equal(n.sessionId, null)
})

test('readT3 and parseLocalStamp read what dashweb writes', () => {
  const r = readT3(t3())
  assert.equal(r.ok, true)
  assert.equal(r.threads.size, 77)
  assert.equal(parseLocalStamp('not sent yet'), null)
  assert.equal(parseLocalStamp('15:10'), null)
  assert.equal(parseLocalStamp(null), null)
})

test("the bridge's own sessions, by working directory, stay out of the fleet", () => {
  const b = board()
  const own = { sessionId: 'own-1', name: 'lines-81', kind: 'interactive', status: 'idle', cwd: '/state/frontman/lines', startedAt: 1, updatedAt: 1, recent: [], agents: [], asking: [] }
  const near = { ...own, sessionId: 'near-1', name: 'frontman-notes', cwd: '/state/frontman-notes' }
  b.other.push(own, near)
  const shown = normalise(b, t3(), Date.now()).fleet.sessions.map(s => s.id)
  assert.ok(shown.includes('own-1'), 'shown when nothing is hidden')
  const hidden = normalise(b, t3(), Date.now(), { hideCwds: ['/state/frontman'] }).fleet.sessions.map(s => s.id)
  assert.ok(!hidden.includes('own-1'))
  assert.ok(hidden.includes('near-1'), 'a directory that only starts with the same letters is not inside it')
  assert.equal(hidden.length, shown.length - 1)
})
