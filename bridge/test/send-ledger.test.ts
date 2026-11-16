// The send ledger on its own: what a requestId is (new, a repeat, a reuse),
// how long it is kept, and the cap. The send route's use of it is in
// limits.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SendLedger, sendKey, type SendOutcome } from '../src/send-ledger.ts'

const ok: SendOutcome = { status: 200, body: { said: 'x' }, headers: {}, remember: true }

test('ledger: an unseen id is new, the same id and words a repeat with the first outcome, other words a conflict', async () => {
  const l = new SendLedger(60_000, 10)
  const c = l.check('card-1', 's1', 'run the tests', 0)
  assert.equal(c.kind, 'new')
  assert.equal(c.kind === 'new' && c.key, sendKey('s1', 'run the tests'))
  l.remember('card-1', sendKey('s1', 'run the tests'), Promise.resolve(ok), 0)
  const again = l.check('card-1', 's1', 'run the tests', 1000)
  assert.equal(again.kind, 'repeat')
  assert.deepEqual(again.kind === 'repeat' && (await again.outcome), ok)
  assert.equal(l.check('card-1', 's1', 'something else', 1000).kind, 'conflict')
  assert.equal(l.check('card-1', 's2', 'run the tests', 1000).kind, 'conflict', 'the session is part of the match')
  assert.equal(l.check(undefined, 's1', 'run the tests', 1000).kind, 'new', 'no id, no memory')
})

test('ledger: the key keeps session and text apart, so no split of one string matches another', () => {
  assert.notEqual(sendKey('ab', 'c'), sendKey('a', 'bc'))
  assert.equal(sendKey('a', 'b'), sendKey('a', 'b'))
})

test('ledger: a forgotten id is new again; one past its time is forgotten; the oldest go past the cap', () => {
  const l = new SendLedger(1000, 3)
  const key = sendKey('s', 't')
  l.remember('a-id', key, Promise.resolve(ok), 0)
  l.forget('a-id')
  assert.equal(l.check('a-id', 's', 't', 10).kind, 'new')
  l.remember('b-id', key, Promise.resolve(ok), 0)
  assert.equal(l.check('b-id', 's', 't', 1000).kind, 'repeat', 'still within its time')
  assert.equal(l.check('b-id', 's', 't', 1001).kind, 'new', 'past it')
  assert.equal(l.size, 0)
  for (const [i, id] of ['c-id', 'd-id', 'e-id'].entries()) l.remember(id, key, Promise.resolve(ok), 2000 + i)
  // A check makes room for one more: the oldest goes.
  assert.equal(l.check('f-id', 's', 't', 2003).kind, 'new')
  assert.equal(l.size, 2)
  assert.equal(l.check('c-id', 's', 't', 2003).kind, 'new')
  assert.equal(l.check('e-id', 's', 't', 2003).kind, 'repeat')
})
