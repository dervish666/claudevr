import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Interpretation, TtsStatus } from '../../shared/protocol.ts'
import { loadConfig, parseFish } from '../src/config.ts'
import { interpret, voiceCommand } from '../src/voice/grammar.ts'
import { FishTts, type Speech, type TtsProvider } from '../src/voice/tts.ts'

const SKIPPY = '1'.repeat(32)
const GLADOS = '2'.repeat(32)
const voices = [
  { name: 'skippy', id: SKIPPY, heardAs: [] },
  { name: 'glados', id: GLADOS, heardAs: ['gladys', 'glad os'] },
  { name: 'jarvis', id: '3'.repeat(32), heardAs: [] },
]

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> }

function stubFetch(reply: () => Response): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = []
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init!.headers as Record<string, string>, body: JSON.parse(String(init!.body)) as Record<string, unknown> })
    return reply()
  }) as typeof fetch
  return { calls, fetch: f }
}

const mp3 = () => new Response(Buffer.alloc(4000, 1), { status: 200, headers: { 'content-type': 'audio/mpeg' } })

class Stand implements TtsProvider {
  readonly name = 'stand-in'
  said: string[] = []
  status(): TtsStatus {
    return { provider: 'stand-in', ok: true, error: null }
  }
  speak(text: string): Promise<Speech> {
    this.said.push(text)
    return Promise.resolve({ audio: Buffer.from('x'), mime: 'audio/webm' })
  }
}

const quiet = () => {}

test('fish: sends the model as a header and the current voice id, and caches a repeated phrase', async () => {
  const net = stubFetch(mp3)
  const t = new FishTts({ apiKey: 'k', keyHint: '', model: 's2.1-pro', voices, voice: 'skippy', maxChars: 600, fetch: net.fetch, log: quiet })
  const sp = await t.speak('Sent to [[rate 900]] Tally.')
  assert.equal(sp.mime, 'audio/mpeg')
  assert.equal(sp.audio.length, 4000)
  const c = net.calls[0]!
  assert.equal(c.url, 'https://api.fish.audio/v1/tts')
  assert.equal(c.headers.model, 's2.1-pro')
  assert.equal(c.headers.authorization, 'Bearer k')
  assert.equal(c.body.reference_id, SKIPPY)
  assert.equal(c.body.text, 'Sent to Tally.')
  assert.equal(c.body.format, 'mp3')
  await t.speak('Sent to Tally.')
  assert.equal(net.calls.length, 1, 'the same words in the same voice are not bought twice')
  assert.deepEqual(t.status(), { provider: 'fish.audio (skippy, s2.1-pro)', ok: true, error: null })
})

test('fish: select changes the voice for the next phrase, remembers it, and refuses an unknown name', async () => {
  const net = stubFetch(mp3)
  const kept: string[] = []
  const t = new FishTts({ apiKey: 'k', keyHint: '', model: 's2.1-pro', voices, voice: 'skippy', maxChars: 600, fetch: net.fetch, remember: n => kept.push(n), log: quiet })
  await t.speak('Hello.')
  t.select('glados')
  assert.equal(t.voice(), 'glados')
  await t.speak('Hello.')
  assert.equal(net.calls.length, 2, 'the cache is per voice')
  assert.equal(net.calls[1]!.body.reference_id, GLADOS)
  assert.deepEqual(kept, ['glados'])
  assert.throws(() => t.select('hal'), /no voice called hal/)
  assert.equal(t.voice(), 'glados')
})

test('fish: a refused request falls back, says why in the status, and recovers', async () => {
  let ok = false
  const net = stubFetch(() => (ok ? mp3() : new Response('{"status":402,"message":"no credit"}', { status: 402 })))
  const stand = new Stand()
  const t = new FishTts({ apiKey: 'k', keyHint: '', model: 's2.1-pro', voices, voice: 'skippy', maxChars: 600, fetch: net.fetch, fallback: stand, log: quiet })
  const sp = await t.speak('Status.')
  assert.equal(sp.mime, 'audio/webm')
  assert.deepEqual(stand.said, ['Status.'])
  assert.match(t.status().provider, /stand-in; fish\.audio failed: HTTP 402: the account is out of credit/)
  ok = true
  assert.equal((await t.speak('Status.')).mime, 'audio/mpeg')
  assert.equal(t.status().provider, 'fish.audio (skippy, s2.1-pro)')
})

test('fish: with no fallback a failure is an error, and no key is its own reason', async () => {
  const net = stubFetch(() => new Response('nope', { status: 401 }))
  const t = new FishTts({ apiKey: 'k', keyHint: '', model: 's2.1-pro', voices, voice: 'skippy', maxChars: 600, fetch: net.fetch, log: quiet })
  await assert.rejects(t.speak('Hello.'), /fish\.audio: HTTP 401: the API key was refused/)
  assert.equal(t.status().ok, false)
  const keyless = new FishTts({ apiKey: null, keyHint: 'set FISH_API_KEY', model: 's2.1-pro', voices, voice: 'skippy', maxChars: 600, fetch: net.fetch, log: quiet })
  assert.deepEqual(keyless.status(), { provider: 'fish.audio (skippy, s2.1-pro)', ok: false, error: 'no fish.audio API key (set FISH_API_KEY)' })
  await assert.rejects(keyless.speak('Hello.'), /no fish\.audio API key/)
  assert.equal(net.calls.length, 1, 'nothing is sent without a key')
  assert.throws(() => new FishTts({ apiKey: 'k', keyHint: '', model: 'm', voices, voice: 'hal', maxChars: 600 }), /not one of tts\.fish\.voices/)
})

test('fish config: voices as ids or objects, the key from the environment or a file, never a bad id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claudevr-fish-'))
  try {
    const f = parseFish({ voices: { Skippy: SKIPPY, glados: { id: GLADOS, heardAs: ['gladys'] } } }, {}, dir)
    assert.deepEqual(f.voices, [{ name: 'skippy', id: SKIPPY, heardAs: [] }, { name: 'glados', id: GLADOS, heardAs: ['gladys'] }])
    assert.equal(f.model, 's2.1-pro')
    assert.equal(f.apiKey, null)
    assert.match(f.keyHint, /fish-api-key$/)
    writeFileSync(join(dir, 'fish-api-key'), 'from-file\n')
    assert.equal(parseFish({ voices: { a: SKIPPY } }, {}, dir).apiKey, 'from-file')
    assert.equal(parseFish({ voices: { a: SKIPPY } }, { FISH_API_KEY: 'from-env' }, dir).apiKey, 'from-env')
    assert.throws(() => parseFish({ voices: { a: 'not-an-id' } }, {}, dir), /32 hex characters/)
    assert.throws(() => parseFish({}, {}, dir), /needs tts\.fish\.voices/)

    writeFileSync(join(dir, 'config.json'), JSON.stringify({ tts: { provider: 'fish', fish: { voices: { skippy: SKIPPY, glados: GLADOS } } } }))
    const cfg = loadConfig({ CLAUDEVR_STATE_DIR: dir })
    assert.equal(cfg.tts.provider, 'fish')
    assert.equal(cfg.tts.voice, 'skippy', 'the first voice when none is named')
    assert.throws(() => loadConfig({ CLAUDEVR_STATE_DIR: dir, CLAUDEVR_TTS_VOICE: 'hal' }), /not one of tts\.fish\.voices/)
    assert.equal(loadConfig({ CLAUDEVR_STATE_DIR: dir, CLAUDEVR_TTS: 'off' }).tts.fish, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const say = (text: string, voice: string | null = 'skippy') => voiceCommand(text, { voices, voice })
const picked = (i: Interpretation | null) => (i?.kind === 'voice' ? i.voice : undefined)

test('voice command: the ways of asking for a voice', () => {
  for (const t of ['voice glados', 'change voice to glados', 'switch your voice to glados', 'set the voice to glados', 'use the glados voice', 'glados voice', 'use voice gladys', 'change voice to glad os', 'be the glados voice']) {
    assert.equal(picked(say(t)), 'glados', t)
  }
  assert.equal(picked(say('voice jarvis')), 'jarvis')
  assert.equal(say('voice skippy')!.say, 'Already skippy.')
  assert.equal(say('voice glados')!.say, 'Voice: glados.')
})

test('voice command: lists, refuses an unknown name, and leaves other speech alone', () => {
  assert.deepEqual(say('voices'), { kind: 'voice', voice: null, say: 'Voices: skippy, glados, jarvis. Now: skippy.' })
  assert.equal(picked(say('what voices do you have')), null)
  assert.deepEqual(say('voice hal'), { kind: 'voice', voice: null, say: 'No voice called hal. There is skippy, glados, jarvis.' })
  assert.equal(say('tell tally to add a voice'), null)
  assert.equal(say('the tests need a louder voice'), null, 'a loose match that is not a voice is not a command')
  assert.equal(say('use voice input instead of typing for the form'), null, 'a sentence, not a name')
  assert.deepEqual(voiceCommand('voice glados', {}), { kind: 'voice', voice: null, say: 'This bridge has one voice.' })
})

test('voice command: works with no fleet, and never while a card is armed', () => {
  const i = interpret({ transcript: 'Um, voice Glados.', fleet: null, context: 'none', voices, voice: 'skippy', now: 0 })
  assert.deepEqual(i, { kind: 'voice', voice: 'glados', say: 'Voice: glados.' })
  const armed = interpret({ transcript: 'voice glados', fleet: null, context: 'confirm', voices, voice: 'skippy', now: 0 })
  assert.notEqual(armed.kind, 'voice')
})
