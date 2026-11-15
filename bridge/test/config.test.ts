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
