// What the HUD does with each interpretation, from the client
// (client/src/hud/voice/route.ts): which answers arm, send or cancel a card,
// and which only move the view or speak.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { route } from '../../client/src/hud/voice/route.ts'
import { armRequestFor } from '../../client/src/hud/voice/sendcard.ts'
import type { Interpretation } from '../../shared/protocol.ts'

const tell = (over: Partial<Extract<Interpretation, { kind: 'tell' }>> = {}): Interpretation => ({ kind: 'tell', sessionId: 's1', callsign: 'Tally', text: 'run the tests', viaDispatcher: false, say: 'To Tally: run the tests', ...over })

test('a tell arms a card with its own words and target, and speaks nothing', () => {
  assert.deepEqual(route(tell(), null), { do: 'arm', tell: { sessionId: 's1', callsign: 'Tally', text: 'run the tests', viaDispatcher: false, viaFocus: undefined, viaClassifier: undefined } })
})

test('confirm sends the armed card, and cancel cancels it', () => {
  assert.deepEqual(route({ kind: 'confirm', say: 'Sending.' }, null), { do: 'send' })
  assert.deepEqual(route({ kind: 'cancel', say: 'Cancelled. Nothing sent.' }, null), { do: 'cancel', say: 'Cancelled. Nothing sent.' })
})

test('a name given to "who is it for?" arms the kept words for that session', () => {
  const step = route({ kind: 'target', sessionId: 's2', callsign: 'Quill', say: 'To Quill.' }, { text: 'delete the old branch' })
  assert.deepEqual(step, { do: 'arm', tell: { sessionId: 's2', callsign: 'Quill', text: 'delete the old branch', viaDispatcher: false } })
})

test('a name with no words kept only shows that session', () => {
  assert.deepEqual(route({ kind: 'target', sessionId: 's2', callsign: 'Quill', say: 'To Quill.' }, null), { do: 'select', sessionId: 's2', say: 'To Quill.', clearWhich: true })
  assert.deepEqual(route({ kind: 'target', sessionId: 's2', callsign: 'Quill', say: 'To Quill.' }, { text: '' }), { do: 'select', sessionId: 's2', say: 'To Quill.', clearWhich: true })
})

test('switch and read show the session; dispatcher goes home; status and the rest only speak', () => {
  assert.deepEqual(route({ kind: 'switch', sessionId: 's3', callsign: 'Ada', say: 'Ada.' }, null), { do: 'select', sessionId: 's3', say: 'Ada.', clearWhich: false })
  assert.equal(route({ kind: 'dispatcher', say: 'Dispatcher.' }, null).do, 'home')
  assert.deepEqual(route({ kind: 'unknown', say: 'Nothing to send.' }, { text: 'kept' }), { do: 'say', say: 'Nothing to send.', hold: false })
})

test('a classifier tell keeps its mark through to the card, which then gets the full countdown', () => {
  const quickFor = (i: Interpretation) => {
    const step = route(i, null)
    assert.equal(step.do, 'arm')
    return step.do === 'arm' ? armRequestFor(step.tell, 'quick').quickConfirm : null
  }
  assert.equal(quickFor(tell({ viaClassifier: true })), false, 'a model chose the target: the full card')
  assert.equal(quickFor(tell()), true, 'the grammar placed it: the quick line')
})

test('with a card armed, words that came to nothing hold it: "um", "tell Tally" with no message, the bare character name', () => {
  assert.deepEqual(route({ kind: 'unknown', say: 'I heard nothing I could use.' }, null, true), { do: 'say', say: 'I heard nothing I could use.', hold: true })
  assert.deepEqual(route({ kind: 'unknown', say: 'Tell Tally what? Say it again with the message.' }, null, true), { do: 'say', say: 'Tell Tally what? Say it again with the message.', hold: true })
  assert.deepEqual(route({ kind: 'ask', character: 'bosun', question: '', say: 'Listening.' }, null, true), { do: 'say', say: 'Listening.', hold: true })
  // With nothing armed they only speak.
  assert.deepEqual(route({ kind: 'unknown', say: 'I heard nothing I could use.' }, null, false), { do: 'say', say: 'I heard nothing I could use.', hold: false })
  // A command over an armed card does its job and leaves the card alone.
  assert.deepEqual(route({ kind: 'status', say: 'All quiet.', lines: [] }, null, true), { do: 'say', say: 'All quiet.', hold: false })
})

test('with a card armed, a new message waiting for its target replaces the card; a name for nothing else holds it', () => {
  const which = (text: string): Interpretation => ({ kind: 'which', why: 'no-match', heard: 'zorbo', text, candidates: [], say: 'Who is it for?' })
  const replace = route(which('Run the lint'), null, true)
  assert.equal(replace.do, 'which')
  assert.equal(replace.do === 'which' && replace.armed, 'replace')
  const hold = route(which(''), null, true)
  assert.equal(hold.do === 'which' && hold.armed, 'hold')
  const open = route(which('Run the lint'), null, false)
  assert.equal(open.do === 'which' && open.armed, null)
})
