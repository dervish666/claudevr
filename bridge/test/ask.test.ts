import { test } from 'node:test'
import assert from 'node:assert/strict'
import { askPrompt, speakableLine, whatWasDone } from '../src/persona/prompt.ts'

test('ask: the prompt carries his question, says nothing was done, and allows three sentences', () => {
  const p = askPrompt('What should I look at first?', null, 0)
  assert.match(p, /He said: "What should I look at first\?"/)
  assert.match(p, /The display did nothing/)
  assert.match(p, /cannot do anything for him in this turn/)
  assert.match(askPrompt('', null, 0), /He said only your name/)
  assert.equal(whatWasDone({ kind: 'ask', character: 'bosun', question: 'x', say: 'y' }, true), 'Nothing: he spoke to you directly.')
})

test('ask: an answer keeps three sentences where a remark keeps two', () => {
  const raw = 'Kettle first. It failed on the migration. Quill can wait. Tally is fine.'
  assert.equal(speakableLine(raw), 'Kettle first. It failed on the migration.')
  assert.equal(speakableLine(raw, 420, 3), 'Kettle first. It failed on the migration. Quill can wait.')
})
