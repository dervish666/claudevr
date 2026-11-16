// The desktop voice keys, from the client (client/src/hud/voice/keys.ts):
// Space and Enter leave a focused control alone, the hold-to-talk button
// keeps its own keys, and Escape cancels from anywhere.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keyAction, type KeyPress, type KeyTarget } from '../../client/src/hud/voice/keys.ts'

const space: KeyPress = { key: ' ', code: 'Space', repeat: false }
const enter: KeyPress = { key: 'Enter', code: 'Enter', repeat: false }
const escape: KeyPress = { key: 'Escape', code: 'Escape', repeat: false }
const el = (tag: string, over: Partial<KeyTarget> = {}): KeyTarget => ({ tag, role: null, editable: false, talk: false, ...over })

test('on the page itself, Space talks, Enter sends an armed card, Escape cancels', () => {
  for (const target of [null, el('BODY'), el('DIV'), el('SECTION')]) {
    assert.equal(keyAction(space, false, target), 'talk')
    assert.equal(keyAction(space, true, target), 'talk')
    assert.equal(keyAction(enter, true, target), 'send')
    assert.equal(keyAction(enter, false, target), null, 'nothing armed, nothing to send')
    assert.equal(keyAction(escape, true, target), 'cancel')
  }
  assert.equal(keyAction({ key: 'a', code: 'KeyA', repeat: false }, true, null), null)
})

test('a focused control keeps Space and Enter: Enter on Cancel presses Cancel, it does not send (V2)', () => {
  const controls = [el('BUTTON'), el('A'), el('SELECT'), el('SUMMARY'), el('DIV', { role: 'button' }), el('SPAN', { role: 'link' }), el('DIV', { role: 'checkbox' })]
  for (const target of controls) {
    assert.equal(keyAction(enter, true, target), null, `${target.tag} ${target.role ?? ''}: Enter is the control's`)
    assert.equal(keyAction(space, true, target), null, `${target.tag} ${target.role ?? ''}: Space is the control's`)
    assert.equal(keyAction(escape, true, target), 'cancel', 'Escape still cancels from a control')
  }
})

test('typing in a field keeps Space and Enter: Enter in "Type instead" does not also send the card', () => {
  for (const target of [el('INPUT'), el('TEXTAREA'), el('DIV', { editable: true })]) {
    assert.equal(keyAction(enter, true, target), null)
    assert.equal(keyAction(space, false, target), null)
    assert.equal(keyAction(escape, true, target), 'cancel', 'Escape cancels even from a field')
  }
})

test('the hold-to-talk button keeps Space for voice, but Enter on it never sends the armed card', () => {
  const talk = el('BUTTON', { talk: true })
  assert.equal(keyAction(space, false, talk), 'talk')
  assert.equal(keyAction(space, true, talk), 'talk')
  assert.equal(keyAction(enter, true, talk), null, 'pressing the labelled talk control must not send the previous message')
  assert.equal(keyAction(escape, true, talk), 'cancel')
})

test('a repeated Space still belongs to the hold (so the page does not scroll); a held-down Enter sends nothing', () => {
  assert.equal(keyAction({ ...space, repeat: true }, false, null), 'talk')
  assert.equal(keyAction({ ...space, repeat: true }, false, el('BUTTON')), null)
  assert.equal(keyAction({ ...enter, repeat: true }, true, null), null, 'a card that armed while Enter was held has not been read')
})
