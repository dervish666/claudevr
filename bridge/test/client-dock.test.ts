// The voice dock's pure rules, from the client (client/src/hud/dock.ts):
// which answer a dismiss hides, when the character's line shows beside a
// list, and when the typed field clears after a submission is answered.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { afterTyped, replyIsUpdate, showSpoken } from '../../client/src/hud/dock.ts'
import type { Reply } from '../../client/src/hud/voice/useVoice.ts'

const status: Reply = { say: 'Three sessions. Tally is working.', lines: ['Tally: working', 'Harbour: idle', 'Kite: asking'], spoken: null }

test('the character line landing on an answer is the same answer, so a dismiss holds', () => {
  const landed: Reply = { ...status, spoken: { character: 'Marlowe', text: 'Three on the books.', plain: false } }
  assert.equal(replyIsUpdate(status, landed), true)
})

test('a new answer is new even with the same words', () => {
  const again: Reply = { say: status.say, lines: [...status.lines!], spoken: null }
  assert.equal(replyIsUpdate(status, again), false, 'a fresh status has its own lines and no line yet')
  const plain: Reply = { say: 'Nothing to cancel.', lines: null, spoken: null }
  assert.equal(replyIsUpdate(plain, { ...plain }), false, 'the same plain words said twice are two answers')
  assert.equal(replyIsUpdate(null, status), false)
})

test('a line already landed is not overwritten by a later one as the same answer', () => {
  const landed: Reply = { ...status, spoken: { character: 'Marlowe', text: 'a', plain: false } }
  assert.equal(replyIsUpdate(landed, { ...landed, spoken: { character: 'Marlowe', text: 'b', plain: false } }), false)
})

test('beside a list, a plain line (the list read out) is left out and a written one kept', () => {
  assert.equal(showSpoken({ ...status, spoken: { character: 'Marlowe', text: status.say, plain: true } }), false)
  assert.equal(showSpoken({ ...status, spoken: { character: 'Marlowe', text: 'Three on the books.', plain: false } }), true)
  assert.equal(showSpoken({ say: 'Muted.', lines: null, spoken: { character: 'Marlowe', text: 'Muted.', plain: true } }), true, 'with no list the line is the answer')
  assert.equal(showSpoken(status), false)
})

test('a used submission clears the field only if it still holds what was sent', () => {
  assert.equal(afterTyped('tell Tally run the tests', 'tell Tally run the tests', true), '')
  // Submit A, edit the field to draft B while A is read, A is answered: B stays.
  assert.equal(afterTyped('tell Harbour stop', 'tell Tally run the tests', true), 'tell Harbour stop')
  assert.equal(afterTyped('tell Tally run the tests', 'tell Tally run the tests', false), 'tell Tally run the tests', 'refused words stay to be fixed')
})
