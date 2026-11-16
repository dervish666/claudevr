// Which session voice is aimed at, from the client (client/src/hud/focus.ts),
// and what the bridge's grammar then does with it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VoiceFocus } from '../../client/src/hud/focus.ts'
import { interpret } from '../src/voice/grammar.ts'
import type { Fleet, Session } from '../../shared/protocol.ts'

const session = (id: string, callsign: string, kind: Session['kind'] = 'session'): Session =>
  ({ id, callsign, kind, canSend: true, state: 'idle', title: callsign, project: null, lastLine: '', action: null, asking: null, messages: [], startedAt: 0, agents: [] }) as unknown as Session
const fleetOf = (...s: Session[]): Fleet => ({ sessions: s, needs: [], usage: null }) as unknown as Fleet

test('voice keeps a selection whose session left the fleet, so the grammar refuses instead of sending to the dispatcher', () => {
  const f = new VoiceFocus()
  const dispatcher = session('d', 'Dispatcher', 'dispatcher')
  assert.equal(f.focus('h', ['d', 'h']), 'h', 'open and in the fleet')
  // Harbour leaves the fleet while its reader is open.
  const after = fleetOf(dispatcher)
  const focusId = f.focus('h', ['d'])
  assert.equal(focusId, 'h', 'still aimed at Harbour')
  const i = interpret({ transcript: 'run the whole suite again', fleet: after, context: 'none', focusId, now: 0 })
  assert.equal(i.kind, 'unknown', 'refused, not a card for the dispatcher')
  assert.match(i.say, /The session you had open has gone/)
  // Had voice followed the view to "nothing selected", the same words would have gone to the dispatcher.
  const wrong = interpret({ transcript: 'run the whole suite again', fleet: after, context: 'none', focusId: null, now: 0 })
  assert.equal(wrong.kind === 'tell' && wrong.sessionId, 'd')
})

test('a selection never seen in this page’s fleet counts as none; a deselection is none', () => {
  const f = new VoiceFocus()
  assert.equal(f.focus('stored-from-last-week', ['d', 'h']), null)
  assert.equal(f.focus('h', null), null, 'no fleet yet proves nothing')
  assert.equal(f.focus('h', ['h']), 'h')
  assert.equal(f.focus(null, ['h']), null)
})
