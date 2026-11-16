// The voice routes end to end over HTTPS on FakeAdapter, with a stand-in
// speech-to-text provider and the real ffmpeg, plus HelperStt's supervision
// against a fake helper process.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import type { SttStatus, TtsStatus } from '../../shared/protocol.ts'
import { createBridge, type Bridge } from '../src/server.ts'
import { FakeAdapter } from '../src/backend/fake.ts'
import { makeCert } from '../src/cert.ts'
import { decodeClip, levels } from '../src/voice/audio.ts'
import { HelperStt, SttUnavailable, type SttProvider } from '../src/voice/stt.ts'
import { speakable, type TtsProvider } from '../src/voice/tts.ts'

const FIX = join(import.meta.dirname, '..', '..', 'fixtures')
const TOKEN = 'ef'.repeat(16)
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0

class StubStt implements SttProvider {
  readonly name = 'stub'
  text = 'Tell Harbour to run the tests.'
  state: SttStatus['state'] = 'ready'
  heard: number[] = []
  private ls = new Set<(s: SttStatus) => void>()
  status(): SttStatus {
    return { provider: 'stub', state: this.state, error: this.state === 'ready' ? null : 'stub helper died', model: 'stub', loadMs: 1 }
  }
  onStatus(l: (s: SttStatus) => void) {
    this.ls.add(l)
    return () => this.ls.delete(l)
  }
  setState(s: SttStatus['state']) {
    this.state = s
    for (const l of this.ls) l(this.status())
  }
  async transcribe(pcm: Buffer) {
    if (this.state !== 'ready') throw new SttUnavailable('stub helper died')
    this.heard.push(pcm.length)
    return { text: this.text, ms: 5 }
  }
  close() {}
}

class StubTts implements TtsProvider {
  readonly name = 'stub'
  said: string[] = []
  status(): TtsStatus {
    return { provider: 'stub', ok: true, error: null }
  }
  async speak(text: string) {
    this.said.push(text)
    return { audio: Buffer.from('OggS-not-really'), mime: 'audio/webm;codecs=opus' }
  }
}

let dir: string
let bridge: Bridge
let fake: FakeAdapter
let stt: StubStt
let tts: StubTts
let port: number
let tone: Buffer
let silence: Buffer

function ff(args: string[]): Buffer {
  const r = spawnSync('ffmpeg', ['-nostdin', '-loglevel', 'error', ...args, '-f', 'webm', '-c:a', 'libopus', 'pipe:1'], { maxBuffer: 1 << 24 })
  assert.equal(r.status, 0, String(r.stderr))
  return r.stdout
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'claudevr-voice-'))
  const certs = makeCert(join(dir, 'certs'), ['localhost', '127.0.0.1'])
  mkdirSync(join(dir, 'client'))
  writeFileSync(join(dir, 'client', 'index.html'), '<!doctype html><title>hud v1</title>')
  fake = FakeAdapter.fromFixtures(FIX, { pollMs: 50, log: () => {} })
  stt = new StubStt()
  tts = new StubTts()
  bridge = createBridge({
    backend: fake,
    token: TOKEN,
    allowIps: [],
    clientDir: join(dir, 'client'),
    probeLog: join(dir, 'probe.log'),
    cert: readFileSync(certs.cert),
    key: readFileSync(certs.key),
    sendsPerMinute: 10,
    sendsPerHour: 100,
    log: () => {},
    stt,
    tts,
    clipMaxSeconds: 5,
    clipMaxBytes: 200_000,
    callsigns: [{ match: 'harbour-rota', callsign: 'Tally', heardAs: ['Telly'] }],
    devReload: true,
  })
  await new Promise<void>(ok => bridge.server.listen(0, '127.0.0.1', ok))
  port = (bridge.server.address() as AddressInfo).port
  if (hasFfmpeg) {
    tone = ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5'])
    silence = ff(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '1.5'])
  }
  // Wait for the first fleet read.
  for (let i = 0; i < 50 && !bridge.fleet(); i++) await new Promise(r => setTimeout(r, 20))
})

after(async () => {
  await bridge.close()
  fake.close()
  rmSync(dir, { recursive: true, force: true })
})

function call(method: string, path: string, opts: { token?: string | null; json?: unknown; raw?: Buffer; type?: string } = {}): Promise<{ status: number; body: any; raw: Buffer; type: string }> {
  return new Promise((ok, fail) => {
    const data = opts.raw ?? (opts.json === undefined ? undefined : Buffer.from(JSON.stringify(opts.json)))
    const token = opts.token === undefined ? TOKEN : opts.token
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        rejectUnauthorized: false,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(data ? { 'content-type': opts.type ?? (opts.raw ? 'audio/webm' : 'application/json'), 'content-length': String(data.length) } : {}),
        },
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks)
          const type = String(res.headers['content-type'] ?? '')
          ok({ status: res.statusCode ?? 0, raw, type, body: type.startsWith('application/json') ? JSON.parse(raw.toString('utf8')) : null })
        })
      },
    )
    req.on('error', fail)
    req.end(data)
  })
}

test('callsign overrides from the config reach the fleet and the needs queue', () => {
  const f = bridge.fleet()!
  assert.equal(f.sessions.find(s => s.id === 'demo-harbour')!.callsign, 'Tally')
})

test('transcribe: a spoken clip comes back as a transcript and a tell card, and nothing is sent', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
  stt.text = 'Tell Telly to run the tests.'
  const r = await call('POST', '/api/transcribe?context=none', { raw: tone })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.transcript.ok, true)
  assert.equal(r.body.transcript.text, 'Tell Telly to run the tests.')
  assert.ok(r.body.transcript.audioMs >= 1400 && r.body.transcript.audioMs <= 1600, `audioMs ${r.body.transcript.audioMs}`)
  assert.equal(r.body.interpretation.kind, 'tell')
  assert.equal(r.body.interpretation.sessionId, 'demo-harbour')
  assert.equal(r.body.interpretation.text, 'Run the tests.')
  assert.equal(fake.sent.length, 0, 'a transcript never sends by itself')
  // 1.5 s at 16 kHz mono s16 reached the model.
  assert.ok(Math.abs(stt.heard.at(-1)! - 48_000) < 2000)
})

test('transcribe: the confirm context turns "send" into a confirm', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
  stt.text = 'Send it.'
  const r = await call('POST', '/api/transcribe?context=confirm', { raw: tone })
  assert.equal(r.body.interpretation.kind, 'confirm')
  const r2 = await call('POST', '/api/transcribe', { raw: tone })
  assert.equal(r2.body.interpretation.kind, 'unknown')
  assert.equal(fake.sent.length, 0)
})

test('transcribe: silence, a corrupt upload and an empty upload are each reported as themselves', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
  const before = stt.heard.length
  const s = await call('POST', '/api/transcribe', { raw: silence })
  assert.equal(s.status, 422)
  assert.equal(s.body.transcript.reason, 'silent')
  const c = await call('POST', '/api/transcribe', { raw: Buffer.from('this is not a webm file at all, just bytes'.repeat(20)) })
  assert.equal(c.status, 422)
  assert.equal(c.body.transcript.reason, 'bad-audio')
  const e = await call('POST', '/api/transcribe', { raw: Buffer.alloc(0) })
  assert.equal(e.body.transcript.reason, 'empty')
  assert.equal(stt.heard.length, before, 'none of them reached the model')
  for (const r of [s, c, e]) assert.equal(r.body.interpretation, null)
})

test('transcribe: too long, too big, wrong type, no token', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
  const long = ff(['-f', 'lavfi', '-i', 'sine=frequency=300:duration=7'])
  const l = await call('POST', '/api/transcribe', { raw: long })
  assert.equal(l.status, 413)
  assert.equal(l.body.transcript.reason, 'too-long')
  const big = await call('POST', '/api/transcribe', { raw: Buffer.alloc(300_000, 1) })
  assert.equal(big.status, 413)
  assert.equal(big.body.transcript.reason, 'too-big')
  const json = await call('POST', '/api/transcribe', { json: { a: 1 } })
  assert.equal(json.status, 415)
  const anon = await call('POST', '/api/transcribe', { raw: tone, token: null })
  assert.equal(anon.status, 401)
})

test('transcribe: a dead provider says transcription is unavailable, and the HUD is told', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, ['claudevr', `token.${TOKEN}`], { rejectUnauthorized: false })
  const voiceMsg = new Promise<any>(ok => ws.on('message', m => {
    const d = JSON.parse(String(m))
    if (d.type === 'voice') ok(d)
  }))
  await new Promise(ok => ws.once('message', ok))
  stt.setState('unavailable')
  try {
    const v = await voiceMsg
    assert.equal(v.voice.stt.state, 'unavailable')
    const r = await call('POST', '/api/transcribe', { raw: tone })
    assert.equal(r.status, 503)
    assert.equal(r.body.transcript.reason, 'unavailable')
    assert.match(r.body.transcript.error, /transcription unavailable: stub helper died/)
  } finally {
    stt.setState('ready')
    ws.close()
  }
})

test('interpret: text from any provider gets the same parse', async () => {
  const r = await call('POST', '/api/interpret', { json: { text: 'status', context: 'none' } })
  assert.equal(r.status, 200)
  assert.equal(r.body.interpretation.kind, 'status')
  assert.match(r.body.interpretation.say, /^7 sessions\./)
  assert.equal((await call('POST', '/api/interpret', { json: { text: 'status' }, token: null })).status, 401)
  assert.equal((await call('POST', '/api/interpret', { json: { text: 'x'.repeat(3000) } })).status, 400)
})

test('speak: returns audio from the provider, behind the token', async () => {
  const r = await call('POST', '/api/speak', { json: { text: 'Sent to Tally.' } })
  assert.equal(r.status, 200)
  assert.equal(r.type, 'audio/webm;codecs=opus')
  assert.equal(tts.said.at(-1), 'Sent to Tally.')
  assert.equal((await call('POST', '/api/speak', { json: { text: 'x' }, token: null })).status, 401)
  assert.equal((await call('POST', '/api/speak', { json: { text: '' } })).status, 400)
})

test('build: hello carries the build id, and a rebuild is pushed to open HUDs', async () => {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, ['claudevr', `token.${TOKEN}`], { rejectUnauthorized: false })
  const msgs: any[] = []
  ws.on('message', m => msgs.push(JSON.parse(String(m))))
  for (let i = 0; i < 50 && !msgs.length; i++) await new Promise(r => setTimeout(r, 20))
  const hello = msgs[0]
  assert.equal(hello.type, 'hello')
  assert.match(hello.build.id, /^[0-9a-f]{12}$/)
  assert.equal(hello.build.reload, true)
  assert.equal(hello.voice.stt.provider, 'stub')
  writeFileSync(join(dir, 'client', 'index.html'), '<!doctype html><title>hud v2</title>')
  let changed: any
  for (let i = 0; i < 100 && !changed; i++) {
    await new Promise(r => setTimeout(r, 50))
    changed = msgs.find(m => m.type === 'build')
  }
  ws.close()
  assert.ok(changed, 'no build message after index.html changed')
  assert.notEqual(changed.build.id, hello.build.id)
})

test('audio: decodeClip and levels', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
  const d = await decodeClip(tone, { ffmpeg: 'ffmpeg', maxSeconds: 5 })
  assert.ok(Math.abs(d.ms - 1500) < 60, String(d.ms))
  assert.ok(levels(d.pcm).peakDb > -25) // lavfi's sine is at 1/8 scale, about -18 dBFS
  const q = await decodeClip(silence, { ffmpeg: 'ffmpeg', maxSeconds: 5 })
  assert.equal(levels(q.pcm).peakDb, -Infinity)
})

test('tts: text for say has no embedded commands or control characters, and is capped', () => {
  assert.equal(speakable('Hello [[volm 0]] world\u0007 [[rate 900]]', 100), 'Hello world')
  const long = speakable('word '.repeat(400), 50)
  assert.ok(long.length <= 51 && long.endsWith('…'), long)
})

// ---------------------------------------------------------------- supervision

const FAKE_HELPER = `
const rl = require('node:readline').createInterface({ input: process.stdin })
const mode = process.argv[1]
if (mode === 'fail-load') { console.log(JSON.stringify({ ready: false, error: 'no weights' })); process.exit(3) }
console.log(JSON.stringify({ ready: true, loadMs: 7 }))
rl.on('line', l => {
  const r = JSON.parse(l)
  if (mode === 'die') process.exit(9)
  console.log(JSON.stringify({ id: r.id, text: 'bytes ' + Buffer.from(r.pcm, 'base64').length, ms: 1 }))
})
`

function fakeHelper(mode: string) {
  return () => spawn(process.execPath, ['-e', FAKE_HELPER, mode], { stdio: ['pipe', 'pipe', 'pipe'] })
}

async function until(f: () => boolean, ms = 3000) {
  for (let t = 0; t < ms && !f(); t += 20) await new Promise(r => setTimeout(r, 20))
  assert.ok(f(), 'timed out waiting')
}

test('HelperStt: loads once, then answers request after request', async () => {
  const h = new HelperStt({ engine: 'fake', python: 'x', script: 'x', model: 'm', cacheDir: null, log: () => {}, spawnHelper: fakeHelper('ok') })
  try {
    await until(() => h.status().state === 'ready')
    assert.equal(h.status().loadMs, 7)
    assert.equal((await h.transcribe(Buffer.alloc(10))).text, 'bytes 10')
    assert.equal((await h.transcribe(Buffer.alloc(20))).text, 'bytes 20')
  } finally {
    h.close()
  }
})

test('HelperStt: a helper that dies fails the clip as unavailable, says why, and restarts', async () => {
  const h = new HelperStt({ engine: 'fake', python: 'x', script: 'x', model: 'm', cacheDir: null, log: () => {}, spawnHelper: fakeHelper('die') })
  try {
    await until(() => h.status().state === 'ready')
    await assert.rejects(h.transcribe(Buffer.alloc(10)), (e: Error) => e instanceof SttUnavailable && /exited \(code 9\)/.test(e.message))
    assert.equal(h.status().state, 'unavailable')
    assert.match(h.status().error!, /restarting in 1 s/)
    await until(() => h.status().state === 'ready')
  } finally {
    h.close()
  }
})

test('HelperStt: a model that fails to load is reported with its reason', async () => {
  const h = new HelperStt({ engine: 'fake', python: 'x', script: 'x', model: 'm', cacheDir: null, log: () => {}, spawnHelper: fakeHelper('fail-load') })
  try {
    await until(() => h.status().state === 'unavailable' && /restarting/.test(h.status().error ?? ''))
    assert.match(h.status().error!, /failed to load: no weights/)
    await assert.rejects(h.transcribe(Buffer.alloc(10)), SttUnavailable)
  } finally {
    h.close()
  }
})

test('HelperStt: a helper that never says ready is killed at the load deadline and restarted', async () => {
  const spawned: ReturnType<typeof spawn>[] = []
  const silent = () => {
    // Loads nothing and says nothing, as a helper stuck in an import would.
    const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['pipe', 'pipe', 'pipe'] })
    spawned.push(c)
    return c
  }
  const logs: string[] = []
  const h = new HelperStt({ engine: 'fake', python: 'x', script: 'x', model: 'm', cacheDir: null, loadTimeoutMs: 1000, log: (...a) => logs.push(a.join(' ')), spawnHelper: silent })
  try {
    assert.equal(h.status().state, 'loading')
    await until(() => h.status().state === 'unavailable' && /restarting/.test(h.status().error ?? ''), 4000)
    assert.equal(h.status().error, 'the fake model did not load in 1 s; restarting in 1 s')
    assert.equal(spawned[0]!.signalCode, 'SIGKILL')
    assert.ok(logs.some(l => l === 'the fake model did not load in 1 s; killing the helper'), logs.join('\n'))
    await assert.rejects(h.transcribe(Buffer.alloc(10)), SttUnavailable)
    // The backoff starts it again, and the new one gets its own deadline.
    await until(() => spawned.length === 2 && h.status().state === 'loading', 3000)
  } finally {
    h.close()
  }
})

test('HelperStt: a missing Python is reported, not retried', () => {
  const h = new HelperStt({ engine: 'parakeet', python: '/nonexistent/python', script: 'x', model: 'm', cacheDir: null, log: () => {} })
  assert.equal(h.status().state, 'unavailable')
  assert.match(h.status().error!, /no Python at \/nonexistent\/python; run npm run stt:setup/)
  h.close()
})
