import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assignCallsigns, titleWord, relabelFleet, words } from '../src/backend/callsign.ts'

const s = (id: string, project: string | null, startedAt: number, title = '') => ({ id, project, title, startedAt })

test('words splits kebab, snake, spaces and camel case, keeps inner capitals', () => {
  assert.deepEqual(words('tally-reading'), ['tally', 'reading'])
  assert.deepEqual(words('ClaudeVR'), ['Claude', 'VR'])
  assert.deepEqual(words('TallyReading'), ['Tally', 'Reading'])
  assert.deepEqual(words('iThink'), ['iThink'])
  assert.deepEqual(words('unraid_monitor 2'), ['unraid', 'monitor'])
})

test('one session per project gets the first word, capitalised', () => {
  const c = assignCallsigns([s('a', 'tally-reading', 1), s('b', 'galactic-tycoons', 2), s('c', 'iThink', 3)])
  assert.deepEqual([...c.values()], ['Tally', 'Galactic', 'iThink'])
})

test('projects that share a first word use their whole names', () => {
  const c = assignCallsigns([s('a', 'Claude', 1), s('b', 'ClaudeVR', 2)])
  assert.equal(c.get('a'), 'Claude')
  assert.equal(c.get('b'), 'Claude VR')
})

test('sessions on the same project are numbered by start time, oldest plain', () => {
  const c = assignCallsigns([s('late', 'tally', 300), s('early', 'tally', 100), s('mid', 'tally', 200)])
  assert.equal(c.get('early'), 'Tally')
  assert.equal(c.get('mid'), 'Tally Two')
  assert.equal(c.get('late'), 'Tally Three')
})

test('a numbered name never collides with a real one', () => {
  const c = assignCallsigns([s('a', 'tally', 1), s('b', 'tally', 2), s('c', 'Tally Two', 3)])
  const names = [...c.values()].map(n => n.toLowerCase())
  assert.equal(new Set(names).size, names.length, `not unique: ${names.join(', ')}`)
})

test('callsigns stay put when a newer session joins', () => {
  const before = assignCallsigns([s('a', 'tally', 1), s('b', 'tally', 2)])
  const after = assignCallsigns([s('a', 'tally', 1), s('b', 'tally', 2), s('c', 'tally', 3)])
  assert.equal(after.get('a'), before.get('a'))
  assert.equal(after.get('b'), before.get('b'))
  assert.equal(after.get('c'), 'Tally Three')
})

test('falls back to the title, then to "Session"; a role wins over the project', () => {
  const c = assignCallsigns([
    { id: 'a', project: null, title: 'Fix the parser', startedAt: 1 },
    { id: 'b', project: null, title: '', startedAt: 2 },
    { id: 'd', project: 'Workbench', title: 'x', startedAt: 3, role: 'dispatcher' },
  ])
  assert.equal(c.get('a'), 'Fix')
  assert.equal(c.get('b'), 'Session')
  assert.equal(c.get('d'), 'Dispatcher')
})

test('unique across a large mixed fleet', () => {
  const projects = ['tally', 'tally', 'Claude', 'ClaudeVR', 'claude', 'gt', 'GT', 'unraid-monitor', null, null]
  const c = assignCallsigns(projects.map((p, i) => s(`id${i}`, p, i, i > 7 ? 'Untitled' : '')))
  const names = [...c.values()].map(n => n.toLowerCase())
  assert.equal(names.length, projects.length)
  assert.equal(new Set(names).size, names.length, `not unique: ${[...c.values()].join(', ')}`)
})

test('a callsign never starts with a command word', () => {
  const c = assignCallsigns([s('a', 'read-later', 1), s('b', 'status-page', 2), s('c', 'send', 3, 'Mail Robot'), s('d', 'tell', 4)])
  assert.equal(c.get('a'), 'Later')
  assert.equal(c.get('b'), 'Page')
  // All command words: the title instead, then "Session".
  assert.equal(c.get('c'), 'Mail')
  assert.equal(c.get('d'), 'Session')
})

test('overrides name a session by project or id, and derived names move aside', () => {
  const overrides = [{ match: 'claudevr', callsign: 'Claude', heardAs: ['Jose'] }, { match: 'sid-9', callsign: 'Nine', heardAs: [] }]
  const c = assignCallsigns([s('home', 'Claude', 1), s('vr', 'ClaudeVR', 2), s('x', 'whatever', 3), { id: 'sid-9', project: 'foo', title: '', startedAt: 4 }], overrides)
  assert.equal(c.get('vr'), 'Claude')
  assert.equal(c.get('sid-9'), 'Nine')
  // The older ~/Claude session loses the plain name to the override.
  assert.equal(c.get('home'), 'Claude Two')
  assert.equal(c.get('x'), 'Whatever')
})

test('a derived name with more words uses them when an override holds its first word', () => {
  const c = assignCallsigns([s('a', 'tally-reading', 1), s('b', 'other', 2)], [{ match: 'other', callsign: 'Tally', heardAs: [] }])
  assert.equal(c.get('b'), 'Tally')
  assert.equal(c.get('a'), 'Tally Reading')
})

test('relabelFleet applies overrides to sessions and needs, and returns heard-as names', () => {
  const fleet = {
    at: 1,
    sessions: [
      { id: 'vr', callsign: 'Claude VR', title: 't', project: 'claudevr', kind: 'T3 codex', state: 'idle' as const, action: null, lastLine: null, activeAt: null, startedAt: 2, asking: null, messages: [], canSend: true, context: null },
      { id: 'd', callsign: 'Dispatcher', title: 'Dispatcher', project: 'Workbench', kind: 'dispatcher', state: 'idle' as const, action: null, lastLine: null, activeAt: null, startedAt: 1, asking: null, messages: [], canSend: true, context: null },
    ],
    needs: [{ id: 'n', kind: 'question' as const, sessionId: 'vr', callsign: 'Claude VR', label: 'x', text: 'q', options: [], since: null, source: 's' }],
    ledger: null,
    usage: { todayUsd: { value: null, at: null, stale: false, note: null }, limits: { value: null, at: null, stale: false, note: null } },
    warnings: [],
  }
  const r = relabelFleet(fleet, [{ match: 'ClaudeVR', callsign: 'Claude', heardAs: ['Jose'] }])
  assert.deepEqual(r.fleet.sessions.map(x => x.callsign), ['Claude', 'Dispatcher'])
  assert.equal(r.fleet.needs[0]!.callsign, 'Claude')
  assert.deepEqual(r.heardAs.get('vr'), ['Jose'])
  assert.equal(fleet.sessions[0]!.callsign, 'Claude VR', 'the input is not changed')
})

test('a second session in the same project is named from its own title before it is numbered', () => {
  const at = (id: string, project: string, title: string, startedAt: number) => ({ id, project, title, startedAt })
  const names = (ss: ReturnType<typeof at>[], o: Parameters<typeof assignCallsigns>[1] = []) => [...assignCallsigns(ss, o).values()].sort()
  // The oldest keeps the plain name; the manager started for a task is called after the task.
  assert.deepEqual(names([at('a', 'Claude', 'workspace chat', 1), at('b', 'Claude', 'T-422 gt: management session', 2)]), ['Claude', 'GT'])
  assert.deepEqual(names([at('a', 'Claude', 'x', 1), at('b', 'Claude', 'T-415 brisflix: pair WhatsApp', 2)]), ['Brisflix', 'Claude'])
  // An override holds "Claude": the derived session moves to its title, not to "Claude Two".
  assert.deepEqual(names([at('vr', 'ClaudeVR', 'Voice hub', 1), at('b', 'Claude', 'T-422 gt: management session', 2)], [{ match: 'claudevr', callsign: 'Claude', heardAs: [] }]), ['Claude', 'GT'])
  // A title with nothing to offer, or whose word is taken, is still numbered.
  assert.deepEqual(names([at('a', 'Claude', 'x', 1), at('b', 'Claude', 'new session', 2)]), ['Claude', 'Claude Two'])
  assert.deepEqual(names([at('a', 'Tally', 'x', 1), at('b', 'Claude', 'y', 2), at('c', 'Claude', 'tally sync', 3)]), ['Claude', 'Claude Two', 'Tally'])
  // Never a command word, never the task id.
  assert.equal(titleWord('T-9 read the status page', 'Claude'), 'Page')
  assert.equal(titleWord('T-422', 'Claude'), null)
  assert.equal(titleWord('T-423 ha: voice errors', 'Claude'), 'HA', 'two letters are initials')
  assert.equal(titleWord('gt: management session', 'Claude'), 'GT')
})

test('a second session under a project override is named from its title, and only the first answers to the heard-as names', () => {
  const overrides = [{ match: 'ClaudeVR', callsign: 'Claude', heardAs: ['Jose'] }]
  const c = assignCallsigns([s('main', 'ClaudeVR', 1, 'Voice-Controlled Agent Session Hub'), s('audit', 'ClaudeVR', 2, 'Codex codebase audit of ClaudeVR'), s('bare', 'ClaudeVR', 3)], overrides)
  assert.equal(c.get('main'), 'Claude')
  assert.equal(c.get('audit'), 'Codex')
  assert.equal(c.get('bare'), 'Claude Three', 'no title to use, so it is numbered')
})

test('callsigns: a derived name never starts with a word the grammar takes as a command, a confirm, a cancel or a filler', () => {
  // A session called "Yep" would send whatever card is armed the moment he said its name.
  const c = assignCallsigns([s('a', 'yep', 1), s('b', 'yeah-board', 2), s('c', 'go-fish', 3), s('d', 'please-tally', 4), s('e', 'voice-lab', 5)])
  assert.equal(c.get('b'), 'Board')
  assert.equal(c.get('c'), 'Fish')
  assert.equal(c.get('d'), 'Tally')
  assert.equal(c.get('e'), 'Lab')
  for (const name of c.values()) assert.doesNotMatch(name.toLowerCase(), /^(yep|yeah|yes|go|please|voice)\b/, name)
})
