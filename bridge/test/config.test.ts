import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, parseCallsigns } from '../src/config.ts'

test('callsigns: a plain string or an object with heardAs', () => {
  assert.deepEqual(parseCallsigns({ claudevr: { callsign: 'Claude', heardAs: ['Jose'] }, tally: 'Tally' }), [
    { match: 'claudevr', callsign: 'Claude', heardAs: ['Jose'] },
    { match: 'tally', callsign: 'Tally', heardAs: [] },
  ])
  assert.deepEqual(parseCallsigns(undefined), [])
  assert.throws(() => parseCallsigns({ x: '' }), /plain words/)
  assert.throws(() => parseCallsigns({ x: 'rm -rf' }), /plain words/)
  assert.throws(() => parseCallsigns(['x']), /must be an object/)
})

test('voice settings default safely and read the file and environment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claudevr-cfg-'))
  try {
    const none = loadConfig({ CLAUDEVR_STATE_DIR: dir })
    assert.equal(none.stt.provider, 'parakeet')
    assert.match(none.stt.python, /\.local\/stt-venv\/bin\/python$/)
    assert.equal(none.stt.maxSeconds, 30)
    assert.deepEqual(none.callsigns, [])
    assert.equal(none.dev, false)
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ stt: { provider: 'whisper' }, tts: { voice: 'Serena' }, callsigns: { claudevr: 'Claude' } }))
    const file = loadConfig({ CLAUDEVR_STATE_DIR: dir })
    assert.equal(file.stt.provider, 'whisper')
    assert.equal(file.stt.model, 'small.en')
    assert.equal(file.stt.cacheDir, null)
    assert.equal(file.tts.voice, 'Serena')
    assert.equal(file.callsigns[0]!.callsign, 'Claude')
    const env = loadConfig({ CLAUDEVR_STATE_DIR: dir, CLAUDEVR_STT: 'off', CLAUDEVR_TTS: 'off', CLAUDEVR_DEV: '1' })
    assert.equal(env.stt.provider, 'off')
    assert.equal(env.tts.provider, 'off')
    assert.equal(env.dev, true)
    assert.throws(() => loadConfig({ CLAUDEVR_STATE_DIR: dir, CLAUDEVR_STT: 'siri' }), /stt.provider must be one of/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('callsigns: an override or a heard-as that starts with a command, confirm or cancel word is refused, naming the key', () => {
  for (const [name, word] of [['Send', 'send'], ['Status Board', 'status'], ['Yes Man', 'yes'], ['Cancel', 'cancel'], ['Nope', 'nope'], ['Belay', 'belay'], ['Tell', 'tell'], ['Go Fish', 'go'], ['Never Land', 'never']] as const) {
    assert.throws(() => parseCallsigns({ 'my-project': name }), (e: Error) => e.message === `callsigns.my-project: the callsign ${JSON.stringify(name)} starts with "${word}", which the voice grammar hears as a command; pick a name that does not`, name)
  }
  assert.throws(() => parseCallsigns({ tally: { callsign: 'Tally', heardAs: ['Telly', 'yes sir'] } }), /^Error: callsigns\.tally\.heardAs: "yes sir" starts with "yes", which the voice grammar hears as a command; leave it out$/)
  assert.throws(() => parseCallsigns({ tally: { callsign: 'Tally', heardAs: ["don't"] } }), /callsigns\.tally\.heardAs: "don't" starts with "don't"/)
  // The voice and character commands count, and so does a command behind a filler the grammar drops.
  for (const [name, word] of [['Voices', 'voices'], ['Voice Atlas', 'voice'], ['Please Status', 'status'], ['Yep', 'yep'], ['Um', 'um']] as const) {
    assert.throws(() => parseCallsigns({ 'my-project': name }), (e: Error) => e.message.startsWith(`callsigns.my-project: the callsign ${JSON.stringify(name)} starts with "${word}"`), name)
  }
  // A command word later in the name, or one inside a longer word, is fine.
  assert.deepEqual(parseCallsigns({ a: 'Mission Status', b: 'Sender', c: { callsign: 'Claude', heardAs: ['Hey Jose', 'Clawed'] } }).map(o => o.callsign), ['Mission Status', 'Sender', 'Claude'])
  // At load, the whole config is refused with the same words.
  const dir = mkdtempSync(join(tmpdir(), 'claudevr-cfg-'))
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ callsigns: { 'my-project': 'Confirm' } }))
    assert.throws(() => loadConfig({ CLAUDEVR_STATE_DIR: dir }), /callsigns\.my-project: the callsign "Confirm" starts with "confirm"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('paths: an absolute directory is normalised, so a trailing slash or a ".." cannot break the static file check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claudevr-cfg-'))
  try {
    assert.equal(loadConfig({ CLAUDEVR_STATE_DIR: dir, CLAUDEVR_CLIENT_DIR: '/x/client/dist/' }).clientDir, '/x/client/dist')
    assert.equal(loadConfig({ CLAUDEVR_STATE_DIR: dir, CLAUDEVR_CLIENT_DIR: '/x/a/../client//dist' }).clientDir, '/x/client/dist')
    assert.equal(loadConfig({ CLAUDEVR_STATE_DIR: `${dir}/` }).stateDir, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dashweb.pollMs: past 10 s it is refused, since the HUD drops a link that is silent for 15 s', () => {
  const env = { CLAUDEVR_STATE_DIR: '/nonexistent-claudevr', CLAUDEVR_BACKEND: 'dashweb', CLAUDEVR_DASHWEB_URL: 'http://127.0.0.1:1', CLAUDEVR_T3_BIN: '/bin/true', CLAUDEVR_T3_BASE_DIR: '/tmp' }
  assert.throws(() => loadConfig({ ...env, CLAUDEVR_DASHWEB_POLL_MS: '15000' }), /dashweb\.pollMs: at most 10000 ms, got 15000/)
  assert.equal(loadConfig({ ...env, CLAUDEVR_DASHWEB_POLL_MS: '10000' }).dashweb?.pollMs, 10000)
})
