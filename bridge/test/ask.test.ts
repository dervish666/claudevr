import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Fleet } from '../../shared/protocol.ts'
import { askPrompt, speakableLine, whatWasDone } from '../src/persona/prompt.ts'
import { addressedTo, interpret, tokens } from '../src/voice/grammar.ts'

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

const fleet = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'demo-fleet.json'), 'utf8')) as Fleet
// "at las" is a two-word mishearing, so "atlas be" is close enough to it to pass as the name.
const CHARS = [
  { name: 'atlas', heardAs: ['at las', 'atlus'] },
  { name: 'juniper', heardAs: ['jupiter', 'june iper'] },
]
const as = (transcript: string, character: string | null = 'atlas', focusId: string | null = 'demo-dispatcher') =>
  interpret({ transcript, fleet, context: 'none', focusId, characters: CHARS, character, now: 0 })

test('character change: the name he is talking to does not swallow the next word', () => {
  assert.equal(addressedTo(tokens('Atlas be Juniper'), CHARS[0]!), 1)
  assert.equal(addressedTo(tokens('at las, be Juniper'), CHARS[0]!), 2)
  for (const t of ['Atlas, be Juniper.', 'Atlas be Juniper', 'Atlus, be Jupiter.', 'at las, become juniper', 'Atlas, switch to Juniper']) {
    assert.deepEqual(as(t), { kind: 'character', character: 'juniper', changed: true, say: 'Character: Juniper.' }, t)
  }
})

test('character change: the ways of asking, and what stays a session matter', () => {
  for (const t of ['be juniper', 'now be juniper', 'can you be juniper', 'switch to juniper', 'change to juniper', 'change character to juniper', 'set the character to juniper', 'I want Juniper', 'talk to juniper', 'Juniper.', 'jupiter']) {
    const i = as(t)
    assert.equal(i.kind === 'character' && i.changed && i.character, 'juniper', t)
  }
  assert.equal(as('switch to harbour').kind, 'switch', 'a session by that name keeps the words')
  assert.equal(as('skip it').kind, 'tell', 'a short answer for the open session is not a character')
  assert.equal(as('be quiet').kind, 'tell')
  assert.equal(as('junip').kind, 'tell', 'a bare name must be exact')
  assert.deepEqual(as('atlas'), { kind: 'ask', character: 'atlas', question: '', say: 'Listening.' })
})

// Short names: by sound, "ada" answered to "add", "bo" to "by" and "bob", "rex" to "racks".
const SHORT = [{ name: 'ada', heardAs: [] }, { name: 'bo', heardAs: [] }, { name: 'rex', heardAs: ['r e x'] }, ...CHARS]
const said = (transcript: string, character: string) => interpret({ transcript, fleet, context: 'none', focusId: null, characters: SHORT, character, now: 0 })

test('short character names: an ordinary sentence that starts with a like-sounding word is not said to the character', () => {
  for (const [character, t] of [
    ['ada', 'add a test for the parser'],
    ['bo', 'by the way the build is red'],
    ['bo', 'bob said the build is red'],
    ['rex', 'racks of tests are failing'],
  ] as const) {
    const i = said(t, character)
    assert.equal(i.kind === 'tell' && i.viaDispatcher, true, `${character}: "${t}" goes to the dispatcher, got ${JSON.stringify(i)}`)
    assert.equal(addressedTo(tokens(t), SHORT.find(c => c.name === character)!), 0)
  }
  assert.notEqual(said('be add', 'rex').kind, 'character', 'the loose "be X" needs the short name itself')
})

test('short character names: the name itself still works, alone, first, after "be", and as a spelled-out heard-as', () => {
  assert.equal(said('Rex, status', 'rex').kind, 'status')
  assert.equal(said('r e x, status', 'rex').kind, 'status', 'a multi-word heard-as matches as an exact phrase')
  assert.deepEqual(said('rex', 'rex'), { kind: 'ask', character: 'rex', question: '', say: 'Listening.' })
  assert.deepEqual(said('Rex.', 'rex'), { kind: 'ask', character: 'rex', question: '', say: 'Listening.' }, 'punctuation and case aside')
  assert.deepEqual(said('be rex', 'ada'), { kind: 'character', character: 'rex', changed: true, say: 'Character: Rex.' })
  assert.deepEqual(said('be bo', 'bo'), { kind: 'character', character: 'bo', changed: false, say: 'Already Bo.' })
  assert.deepEqual(said('rex', 'ada'), { kind: 'character', character: 'rex', changed: true, say: 'Character: Rex.' })
  // Longer names keep the fuzzy match.
  assert.deepEqual(said('Atlus, be Jupiter.', 'atlas'), { kind: 'character', character: 'juniper', changed: true, say: 'Character: Juniper.' })
})
