import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { FakeAdapter } from '../src/backend/fake.ts'
import { loadConfig, REPO_ROOT } from '../src/config.ts'

const FIX = join(REPO_ROOT, 'fixtures')

test('fake backend: the ten-agent fixture loads, with sessions needing the person', async () => {
  const fake = FakeAdapter.fromFixtures(FIX, { file: 'demo-fleet-10.json', log: () => {} })
  const f = await fake.list()
  assert.equal(f.sessions.filter(s => s.kind !== 'dispatcher').length, 10)
  assert.ok(f.needs.filter(n => n.sessionId).length >= 2)
  assert.equal(new Set(f.sessions.map(s => s.callsign)).size, f.sessions.length, 'callsigns unique')
  fake.close()
})

test('fake backend: demo motion changes one agent per step, never the dispatcher', async () => {
  let t = 1_000
  const fake = FakeAdapter.fromFixtures(FIX, { now: () => t, log: () => {} })
  const before = await fake.list()
  fake.step()
  t += 1000
  const after = await fake.list()
  const changed = after.sessions.filter(s => before.sessions.find(b => b.id === s.id)!.lastLine !== s.lastLine)
  assert.equal(changed.length, 1)
  assert.notEqual(changed[0]!.kind, 'dispatcher')
  for (let i = 0; i < 12; i++) fake.step()
  const later = await fake.list()
  assert.equal(later.sessions.find(s => s.kind === 'dispatcher')!.lastLine, before.sessions.find(s => s.kind === 'dispatcher')!.lastLine)
  fake.close()
})

test('config: the fake fleet is a file name inside the fixtures directory', () => {
  assert.equal(loadConfig({ CLAUDEVR_STATE_DIR: '/nonexistent-claudevr' }).fakeFleet, 'demo-fleet.json')
  assert.equal(loadConfig({ CLAUDEVR_STATE_DIR: '/nonexistent-claudevr', CLAUDEVR_FAKE_FLEET: 'demo-fleet-10.json', CLAUDEVR_FAKE_LIVE_MS: '5000' }).fakeLiveMs, 5000)
  assert.throws(() => loadConfig({ CLAUDEVR_STATE_DIR: '/nonexistent-claudevr', CLAUDEVR_FAKE_FLEET: '../secrets.json' }), /file name inside/)
})
