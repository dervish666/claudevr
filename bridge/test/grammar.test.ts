import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Fleet, Interpretation, Session } from '../../shared/protocol.ts'
import { interpret, limitsAnswer, resolve, similarity, soundKey, splitName, statusAnswer, tokens, type Target } from '../src/voice/grammar.ts'

const NOW = 1794700000000
const demo = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'demo-fleet.json'), 'utf8')) as Fleet

function session(id: string, callsign: string, extra: Partial<Session> = {}): Session {
  return { id, callsign, title: callsign, project: callsign.toLowerCase(), kind: 'interactive', state: 'idle', action: null, lastLine: null, activeAt: NOW - 120_000, startedAt: 1, asking: null, messages: [], canSend: true, context: null, ...extra }
}

/** The demo fleet plus Tally and Claude, with "Jose" known to mean Claude. */
const fleet: Fleet = { ...demo, sessions: [...demo.sessions, session('t-tally', 'Tally', { lastLine: 'All 212 tests pass.', messages: [{ at: NOW - 60_000, text: 'All 212 tests pass.' }] }), session('t-claude', 'Claude')] }
const heardAs = new Map([['t-claude', ['Jose', 'Hey Jose']]])
const run = (transcript: string, context: 'none' | 'confirm' | 'target' = 'none', f: Fleet | null = fleet) => interpret({ transcript, fleet: f, heardAs, context, now: NOW })

function expectKind<K extends Interpretation['kind']>(i: Interpretation, kind: K): Extract<Interpretation, { kind: K }> {
  assert.equal(i.kind, kind, `expected ${kind}, got ${JSON.stringify(i)}`)
  return i as Extract<Interpretation, { kind: K }>
}

test('tell: the transcript of the test clip lands on Tally with the exact message', () => {
  const i = expectKind(run('Tell Tally to run the tests.'), 'tell')
  assert.equal(i.sessionId, 't-tally')
  assert.equal(i.text, 'Run the tests.')
  assert.equal(i.viaDispatcher, false)
  assert.equal(i.say, 'To Tally: Run the tests.')
})

test('tell: mangled names still match, by spelling or by sound', () => {
  assert.equal(expectKind(run('tell tali to run the tests'), 'tell').callsign, 'Tally')
  assert.equal(expectKind(run('tell harbor that the export is fine'), 'tell').callsign, 'Harbour')
  assert.equal(expectKind(run('tell harbor that the export is fine'), 'tell').text, 'The export is fine')
  assert.equal(expectKind(run('Ask Quil to keep the empty string'), 'tell').callsign, 'Quill')
})

test('tell: a two-word callsign beats its one-word prefix, and the other way round', () => {
  assert.equal(expectKind(run('tell garden vr to rebuild the scene'), 'tell').callsign, 'Garden VR')
  assert.equal(expectKind(run('tell garden to rebuild the card'), 'tell').callsign, 'Garden')
  assert.equal(expectKind(run('tell garden to rebuild the card'), 'tell').text, 'Rebuild the card')
})

test('tell: "Jose" reaches Claude through the configured heard-as list', () => {
  const i = expectKind(run('Tell Jose to look at the bridge log.'), 'tell')
  assert.equal(i.sessionId, 't-claude')
  assert.equal(i.text, 'Look at the bridge log.')
})

test('tell: an unknown name asks who, and keeps the message for the answer', () => {
  const i = expectKind(run('tell zebra to run the tests'), 'which')
  assert.equal(i.why, 'no-match')
  assert.equal(i.heard, 'zebra')
  assert.equal(i.text, 'Run the tests')
})

test('tell: two near-equal sessions ask which rather than guess', () => {
  const twins: Fleet = { ...fleet, sessions: [session('m1', 'Mira'), session('m2', 'Myra')] }
  const i = expectKind(run('tell meera to ship it', 'none', twins), 'which')
  assert.equal(i.why, 'ambiguous')
  assert.deepEqual(i.candidates.map(c => c.callsign).sort(), ['Mira', 'Myra'])
})

test('tell: a session with no send route is named as such, not guessed around', () => {
  const i = expectKind(run('tell lantern to start again'), 'unknown')
  assert.match(i.say, /Lantern cannot be sent to/)
})

test('tell: a name with no message asks for the message', () => {
  assert.match(expectKind(run('tell tally'), 'unknown').say, /Tell Tally what/)
})

test('speech that names no session goes to the dispatcher', () => {
  const i = expectKind(run('Find out why the backup job keeps failing.'), 'tell')
  assert.equal(i.sessionId, 'demo-dispatcher')
  assert.equal(i.viaDispatcher, true)
  assert.equal(i.text, 'Find out why the backup job keeps failing.')
})

test('reader open: speech that names nobody goes straight to that session, not the dispatcher', () => {
  const focused = (transcript: string, context: 'none' | 'confirm' | 'target' = 'none', focusId = 't-tally') => interpret({ transcript, fleet, heardAs, context, focusId, now: NOW })
  const i = expectKind(focused('run the whole suite again please'), 'tell')
  assert.equal(i.sessionId, 't-tally')
  assert.equal(i.viaDispatcher, false)
  assert.equal(i.viaFocus, true)
  assert.equal(i.text, 'Run the whole suite again')
  // Short answers reach it too: with nothing armed, "yes" is an answer, not a confirm.
  const yes = expectKind(focused('yes'), 'tell')
  assert.equal(yes.sessionId, 't-tally')
  assert.equal(yes.text, 'Yes')
  assert.equal(expectKind(focused('no'), 'tell').sessionId, 't-tally')
  // With a card armed, "yes" still confirms that card and "cancel" still cancels.
  expectKind(focused('yes', 'confirm'), 'confirm')
  expectKind(focused('cancel', 'confirm'), 'cancel')
  // Naming another session, or a command, still wins over the open one.
  assert.equal(expectKind(focused('tell quill to check the parser'), 'tell').sessionId, 'demo-quill')
  expectKind(focused('status'), 'status')
  // A focus that is not in the fleet is ignored: back to the dispatcher rule.
  assert.equal(expectKind(focused('run the whole suite again', 'none', 'gone'), 'tell').viaDispatcher, true)
})

test('reader open on a session that cannot be sent to: it says so, and does not fall back to the dispatcher', () => {
  const locked: Fleet = { ...fleet, sessions: fleet.sessions.map(s => (s.id === 't-tally' ? { ...s, canSend: false } : s)) }
  const i = expectKind(interpret({ transcript: 'run the whole suite again', fleet: locked, heardAs, context: 'none', focusId: 't-tally', now: NOW }), 'unknown')
  assert.match(i.say, /Tally cannot be sent to/)
})

test('hesitations are dropped wherever they fall, and the message keeps its sense', () => {
  const i = expectKind(run('Um tell Tally uh to run the um tests er again.'), 'tell')
  assert.equal(i.sessionId, 't-tally')
  assert.equal(i.text, 'Run the tests again.')
  // A sentence end carried by the hesitation moves to the word before it.
  const d = expectKind(run('Could you sort out the limits um. Uh and then look at the interface'), 'tell')
  assert.equal(d.text, 'Could you sort out the limits. and then look at the interface')
  // Nothing but hesitation is nothing.
  assert.equal(run('um uh er').say, 'I heard nothing I could use.')
  // Real words that only look similar stay.
  assert.match(expectKind(run('tell Tally the summer umbrella order erred'), 'tell').text, /summer umbrella order erred/)
})

test('with no dispatcher, it says so and asks who it is for', () => {
  const noDispatcher: Fleet = { ...fleet, sessions: fleet.sessions.filter(s => s.kind !== 'dispatcher') }
  const i = expectKind(run('Find out why the backup job keeps failing.', 'none', noDispatcher), 'which')
  assert.equal(i.why, 'no-dispatcher')
  assert.match(i.say, /no dispatcher/i)
  assert.equal(i.text, 'Find out why the backup job keeps failing.')
  // Answering with a name supplies the target.
  const t = expectKind(run('Tally.', 'target', noDispatcher), 'target')
  assert.equal(t.sessionId, 't-tally')
})

test('short noise is not sent anywhere', () => {
  assert.equal(run('Thank you.').kind, 'unknown')
  assert.equal(run('you').kind, 'unknown')
  assert.equal(run('').kind, 'unknown')
})

test('confirm words confirm only while a card is armed, and only as the whole utterance', () => {
  for (const w of ['Send.', 'send it', 'Yes.', 'confirm', 'Go ahead.', 'okay, send it']) assert.equal(run(w, 'confirm').kind, 'confirm', w)
  assert.equal(run('send', 'none').kind, 'unknown')
  assert.equal(run('yes', 'none').say, 'Nothing to send.')
  // "send" inside a sentence is a new command, not a yes.
  assert.equal(run('tell tally to send the report', 'confirm').kind, 'tell')
})

test('cancel words cancel, armed or not', () => {
  for (const w of ['Cancel.', 'no', 'never mind', "don't send", 'stop']) assert.equal(run(w, 'confirm').kind, 'cancel', w)
  assert.equal(run('cancel', 'none').say, 'Nothing to cancel.')
})

test('status is answered from the fleet', () => {
  for (const w of ['Status.', "what's the status", 'status report', "How's everyone doing?", "What's the status of the fleet?", 'status of my agents', 'give me the status on everything']) assert.equal(run(w).kind, 'status', w)
  const i = expectKind(run('status'), 'status')
  assert.match(i.say, /^9 sessions\./)
  assert.match(i.say, /Working: Harbour and Garden VR\./)
  assert.match(i.say, /Quill is asking: The parser can either drop/)
  assert.match(i.say, /Failed: Kettle\./)
  assert.match(i.say, /4 things need you\./)
  assert.match(i.say, /Context nearly full: Harbour at 91%\./)
})

test('status names no context when none is nearly full, or none is known', () => {
  const calm = { ...fleet, sessions: fleet.sessions.map(s => ({ ...s, context: s.context ? { ...s.context, usedPct: 40 } : null })) }
  assert.doesNotMatch(statusAnswer(calm).say, /Context/)
  const unknown = { ...fleet, sessions: fleet.sessions.map(s => ({ ...s, context: null })) }
  assert.doesNotMatch(statusAnswer(unknown).say, /Context/)
})

test('limits: the words for it, answered from the fleet', () => {
  for (const w of ['Limits.', 'usage', 'rate limits', 'What are my limits?', "what's my usage", 'usage limits', 'How much have I used today?', 'check the limits']) assert.equal(run(w).kind, 'limits', w)
  const i = expectKind(run('limits'), 'limits')
  assert.deepEqual(i.lines, ['5-hour limit 72% used, resets in 1 hour 50 minutes.', 'Weekly limit 46% used, resets in 3 days.', 'Spend today $14.37.', 'Context nearly full: Harbour at 91%.'])
  assert.equal(i.say, i.lines.join(' '))
})

test('limits: unknown figures are said to be unavailable with the reason, never as zero', () => {
  const none = { value: null, at: null, stale: false, note: null }
  const f: Fleet = { ...fleet, sessions: [], usage: { todayUsd: { ...none, note: "dashweb's live stream: connect ECONNREFUSED" }, limits: { ...none, note: 'no session has reported the limits yet' } } }
  const a = limitsAnswer(f, NOW)
  assert.deepEqual(a.lines, ['5-hour limit not available: no session has reported the limits yet.', "Spend today not available: dashweb's live stream: connect ECONNREFUSED."])
  assert.doesNotMatch(a.say, /0%|\$0/)
  // A fleet from an older bridge, with no usage at all.
  const { usage: _gone, ...old } = fleet
  assert.match(limitsAnswer(old as Fleet, NOW).say, /^5-hour limit not available\. Spend today not available\./)
})

test('limits: stale figures are given with their age', () => {
  const u = fleet.usage
  const f: Fleet = { ...fleet, usage: { todayUsd: { ...u.todayUsd, stale: true, at: NOW - 3 * 60_000 }, limits: { ...u.limits, stale: true, at: NOW - 40 * 60_000 } } }
  const a = limitsAnswer(f, NOW)
  assert.match(a.say, /5-hour limit 72% used, resets in 1 hour 50 minutes, as of 40 minutes ago\./)
  assert.match(a.say, /Spend today \$14\.37, as of 3 minutes ago\./)
})

test('read X answers from the session, with its question when it is asking', () => {
  const r = expectKind(run('read tally'), 'read')
  assert.equal(r.sessionId, 't-tally')
  assert.match(r.say, /^Tally, idle, last active 2 minutes ago\. Last said: All 212 tests pass\.$/)
  const q = expectKind(run("What's Quill doing?"), 'read')
  assert.match(q.say, /Asking: The parser can either drop or keep a trailing empty field\. Which do you want\? Options: Drop it, or Keep it as an empty string\./)
  assert.equal(expectKind(run("read harbour's last message"), 'read').callsign, 'Harbour')
  assert.equal(expectKind(run('what did kettle say'), 'read').callsign, 'Kettle')
})

test('switch to X, or just a name, shows that session', () => {
  assert.equal(expectKind(run('Switch to Kettle.'), 'switch').sessionId, 'demo-kettle')
  assert.equal(expectKind(run('show me garden vr'), 'switch').callsign, 'Garden VR')
  assert.equal(expectKind(run('Quill.'), 'switch').callsign, 'Quill')
  assert.equal(expectKind(run('switch to zebra'), 'which').why, 'no-match')
})

test('no fleet yet: commands say so instead of guessing', () => {
  assert.match(run('tell tally to run the tests', 'none', null).say, /No fleet data/)
})

test('matching helpers', () => {
  assert.equal(soundKey('Harbor'), soundKey('Harbour'))
  assert.equal(soundKey('Tali'), soundKey('Tally'))
  assert.equal(similarity('garden 2', 'Garden Two'), 1)
  assert.ok(similarity('zebra', 'Tally') < 0.5)
  const targets: Target[] = [{ sessionId: 'a', callsign: 'Tally', heardAs: [] }, { sessionId: 'b', callsign: 'Garden VR', heardAs: [] }]
  assert.equal(resolve('tally', targets).ok, true)
  const sp = splitName(tokens('garden vr, rebuild it'), targets)
  assert.deepEqual(sp.name.map(t => t.norm), ['garden', 'vr'])
  assert.deepEqual(sp.message.map(t => t.raw), ['rebuild', 'it'])
})

test('status answer for an empty fleet', () => {
  assert.equal(statusAnswer({ ...fleet, sessions: [], needs: [] }).say, 'No live sessions.')
})

test('"dispatcher" on its own deselects, with a session open or not, and is never a message', () => {
  for (const said of ['Dispatcher.', 'dispatcher', 'the dispatcher', 'Back to the dispatcher.', 'go back to dispatcher', 'um, dispatcher please']) {
    assert.equal(run(said).kind, 'dispatcher', said)
    assert.equal(interpret({ transcript: said, fleet, heardAs, context: 'none', focusId: 't-tally', now: NOW }).kind, 'dispatcher', `${said}, Tally open`)
  }
  // Inside a sentence it is not the command: that is a message as before.
  assert.equal(expectKind(run('ask the dispatcher to check the backups'), 'tell').text, 'Check the backups')
  assert.equal(expectKind(run('Find out what the dispatcher did with the backups.'), 'tell').viaDispatcher, true)
  // Answering "who is it for?" with "dispatcher" names the dispatcher session.
  assert.equal(expectKind(run('dispatcher', 'target'), 'target').sessionId, 'demo-dispatcher')
})

test('"be X" still works when speech-to-text writes it as "B. X" or "Bee X"', () => {
  const characters = [{ name: 'bosun', heardAs: [] }]
  for (const w of ['B. Bosun.', 'Bee bosun', 'be Bosun']) {
    const i = interpret({ transcript: w, fleet, heardAs, context: 'none', focusId: 't-tally', characters, character: null, now: NOW })
    assert.deepEqual(i, { kind: 'character', character: 'bosun', changed: true, say: 'Character: bosun.' }, w)
  }
  assert.equal(interpret({ transcript: 'B. Careful with that', fleet, heardAs, context: 'none', focusId: 't-tally', characters, character: null, now: NOW }).kind, 'tell', 'not a character: still a message')
})

test("the character's name first: a command still runs, anything else is a question for the character and reaches no session", () => {
  const characters = [{ name: 'bosun', heardAs: ['bozun'] }]
  const say = (transcript: string, extra: Record<string, unknown> = {}) => interpret({ transcript, fleet, heardAs, context: 'none', focusId: 't-tally', characters, character: 'bosun', now: NOW, ...extra })
  assert.deepEqual(say('Bosun, what should I look at first?'), { kind: 'ask', character: 'bosun', question: 'What should I look at first?', say: 'Bosun did not answer in time.' })
  assert.equal(say('Hey Bozun, how are we doing on the weekly limit').kind, 'ask', 'heard as, after a filler')
  assert.deepEqual(say('Bosun.'), { kind: 'ask', character: 'bosun', question: '', say: 'Listening.' })
  assert.equal(say('Bosun, yes').kind, 'ask', 'a short answer goes to the character, not to the open session')
  // Commands after the name are still commands.
  assert.equal(say('Bosun, status').kind, 'status')
  assert.equal(expectKind(say('Bosun, tell Tally to run the tests'), 'tell').callsign, 'Tally')
  assert.equal(expectKind(say('Bosun, switch to Tally'), 'switch').callsign, 'Tally')
  assert.equal(say('Bosun, cancel', { context: 'confirm' }).kind, 'cancel')
  // Without the name, and in operator mode, nothing changes.
  assert.equal(expectKind(say('What should I look at first?'), 'tell').viaFocus, true)
  assert.equal(expectKind(say('Bosun, what should I look at first?', { character: null }), 'tell').viaFocus, true)
})
