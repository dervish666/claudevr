// The bridge's own limits: per-client budgets, bounded expensive work, send
// request ids, the WebSocket caps and buffer budget, and the log budget and
// rotation. Each test runs its own bridge with the limit under test shrunk.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import type { Fleet, SessionTranscript, TtsStatus } from '../../shared/protocol.ts'
import { appendRotating, createBridge, sendBounded, type Bridge, type BridgeOptions } from '../src/server.ts'
import { Busy, KeyedBudget, Pool } from '../src/gate.ts'
import { FakeAdapter } from '../src/backend/fake.ts'
import { makeCert } from '../src/cert.ts'
import type { SttProvider } from '../src/voice/stt.ts'
import type { TtsProvider } from '../src/voice/tts.ts'

const FIX = join(import.meta.dirname, '..', '..', 'fixtures')
const FLEET = JSON.parse(readFileSync(join(FIX, 'demo-fleet.json'), 'utf8')) as Fleet
const TOKEN = 'ef'.repeat(16)
let dir: string
let cert: Buffer
let key: Buffer
const open: { bridge: Bridge; backend: FakeAdapter }[] = []

/** A fake whose transcript reads wait on `hold`, to see how many run at once. */
class SlowFake extends FakeAdapter {
  reads = 0
  hold: Promise<void> | null = null
  override async transcript(id: string, limit: number): Promise<SessionTranscript> {
    this.reads++
    if (this.hold) await this.hold
    return super.transcript(id, limit)
  }
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'claudevr-limits-'))
  const certs = makeCert(join(dir, 'certs'), ['localhost', '127.0.0.1'])
  cert = readFileSync(certs.cert)
  key = readFileSync(certs.key)
  mkdirSync(join(dir, 'client'))
  writeFileSync(join(dir, 'client', 'index.html'), '<!doctype html><title>hud</title>')
})

after(async () => {
  for (const { bridge, backend } of open) {
    await bridge.close()
    backend.close()
  }
  rmSync(dir, { recursive: true, force: true })
})

let n = 0
async function start(o: Partial<BridgeOptions> = {}): Promise<{ port: number; backend: SlowFake; logs: string[]; probeLog: string }> {
  const backend = new SlowFake(FLEET, { pollMs: 50, log: () => {} })
  const logs: string[] = []
  const probeLog = join(dir, `probe-${++n}.log`)
  const bridge = createBridge({ backend, token: TOKEN, allowIps: [], clientDir: join(dir, 'client'), probeLog, cert, key, sendsPerMinute: 100, sendsPerHour: 1000, log: (...a) => logs.push(a.join(' ')), ...o })
  await new Promise<void>(ok => bridge.server.listen(0, '127.0.0.1', ok))
  open.push({ bridge, backend })
  // The first fleet read, so sends find their session.
  for (let i = 0; i < 100 && !bridge.fleet(); i++) await new Promise(r => setTimeout(r, 10))
  return { port: (bridge.server.address() as AddressInfo).port, backend, logs, probeLog }
}

function call(port: number, method: string, path: string, opts: { body?: unknown; raw?: Buffer; type?: string; token?: string | null } = {}): Promise<{ status: number; body: any; headers: Record<string, unknown> }> {
  return new Promise((ok, fail) => {
    const data = opts.raw ?? (opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body)))
    const token = opts.token === undefined ? TOKEN : opts.token
    const req = request(
      { host: '127.0.0.1', port, path, method, rejectUnauthorized: false, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-type': opts.type ?? 'application/json', 'content-length': String(data.length) } : {}) } },
      res => {
        const chunks: Buffer[] = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          ok({ status: res.statusCode ?? 0, body: String(res.headers['content-type'] ?? '').startsWith('application/json') ? JSON.parse(text || 'null') : text, headers: res.headers })
        })
      },
    )
    req.on('error', fail)
    req.end(data)
  })
}

// ---------------------------------------------------------------- units

test('Pool: runs at most N at once, queues a few, refuses the rest with Busy', async () => {
  const p = new Pool('reads', 2, 1)
  let release!: () => void
  const gate = new Promise<void>(r => (release = r))
  const ran: number[] = []
  const job = (i: number) => p.run(async () => (ran.push(i), await gate, i))
  const a = job(1)
  const b = job(2)
  const c = job(3)
  assert.deepEqual(p.load(), { running: 2, waiting: 1 })
  await assert.rejects(job(4), (e: Error) => e instanceof Busy && /busy: 2 reads running and 1 waiting/.test(e.message))
  release()
  assert.deepEqual(await Promise.all([a, b, c]), [1, 2, 3])
  assert.deepEqual(ran, [1, 2, 3], 'the waiting one ran once a slot freed')
  assert.deepEqual(p.load(), { running: 0, waiting: 0 })
  await assert.rejects(p.run(async () => Promise.reject(new Error('boom'))), /boom/)
  assert.deepEqual(p.load(), { running: 0, waiting: 0 }, 'a failed run frees its slot')
})

test('KeyedBudget: each key has its own window; a full one says how long to wait', () => {
  const b = new KeyedBudget(3, 60_000)
  assert.equal(b.take('a', 1, 0), null)
  assert.equal(b.take('a', 2, 1000), null)
  assert.deepEqual(b.take('a', 1, 2000), { retryAfterS: 58 })
  assert.equal(b.take('b', 3, 2000), null, 'another client is not held back')
  assert.equal(b.take('a', 1, 60_001), null, 'the first unit freed after a minute')
})

test('sendBounded: a socket too far behind is dropped, not buffered without end', () => {
  const sent: string[] = []
  let terminated = false
  const ws = { readyState: 1, OPEN: 1, bufferedAmount: 2_000_000, send: (d: string) => sent.push(d), terminate: () => (terminated = true) } as never
  const drops: number[] = []
  assert.equal(sendBounded(ws, 'x', 1_000_000, b => drops.push(b)), false)
  assert.deepEqual([terminated, drops, sent], [true, [2_000_000], []])
  const ok = { readyState: 1, OPEN: 1, bufferedAmount: 10, send: (d: string) => sent.push(d), terminate: () => assert.fail('not this one') } as never
  assert.equal(sendBounded(ok, 'y', 1_000_000, () => assert.fail('not dropped')), true)
  assert.deepEqual(sent, ['y'])
})

test('appendRotating: a log past its size moves to .1 and starts again, so it never grows without end', async () => {
  const f = join(dir, 'rot', 'x.log')
  for (let i = 0; i < 40; i++) await appendRotating(f, `${'line '.repeat(10)}${i}\n`, 400)
  assert.ok(existsSync(`${f}.1`))
  assert.ok(statSync(f).size <= 400, `current ${statSync(f).size} bytes`)
  assert.ok(statSync(`${f}.1`).size <= 400)
  assert.match(readFileSync(f, 'utf8'), /39\n$/, 'the newest line is in the current file')
})

// ---------------------------------------------------------------- sends

test('send: a repeated requestId gets the first answer and is sent once; a reused one for another message is refused', async () => {
  const { port, backend } = await start()
  const body = { sessionId: 'demo-harbour', text: 'run the tests', requestId: 'card-0001-aaaa' }
  const first = await call(port, 'POST', '/api/send', { body })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(backend.sent.length, 1)
  assert.equal(backend.sent[0]!.requestId, 'card-0001-aaaa', 'the id is passed down to the backend')
  const again = await call(port, 'POST', '/api/send', { body })
  assert.equal(again.status, 200)
  assert.equal(again.body.repeat, true)
  assert.equal(again.body.said, first.body.said)
  assert.equal(backend.sent.length, 1, 'the repeat was not sent again')
  const other = await call(port, 'POST', '/api/send', { body: { ...body, text: 'something else' } })
  assert.equal(other.status, 409)
  assert.equal(backend.sent.length, 1)
  // Two at once with a new id: one send between them.
  const both = await Promise.all([0, 1].map(() => call(port, 'POST', '/api/send', { body: { ...body, requestId: 'card-0002-bbbb' } })))
  assert.deepEqual(both.map(r => r.status), [200, 200])
  assert.equal(both.filter(r => r.body.repeat).length, 1)
  assert.equal(backend.sent.length, 2)
  // Without an id, every send is its own.
  await call(port, 'POST', '/api/send', { body: { sessionId: 'demo-harbour', text: 'run the tests' } })
  await call(port, 'POST', '/api/send', { body: { sessionId: 'demo-harbour', text: 'run the tests' } })
  assert.equal(backend.sent.length, 4)
})

test('send: a bad requestId is refused; a refusal is forgotten, a send that may have gone is remembered', async () => {
  const { port, backend } = await start()
  for (const requestId of ['short', 'x'.repeat(65), 'has spaces in it', 'semi;colon;id', 12345678]) {
    assert.equal((await call(port, 'POST', '/api/send', { body: { sessionId: 'demo-harbour', text: 'x', requestId } })).status, 400, String(requestId))
  }
  assert.equal(backend.sent.length, 0)
  // Refused before it went anywhere: the same id is tried afresh, so no `repeat`.
  const refused = { sessionId: 'nobody', text: 'x', requestId: 'card-0003-cccc' }
  assert.equal((await call(port, 'POST', '/api/send', { body: refused })).status, 404)
  const retried = await call(port, 'POST', '/api/send', { body: refused })
  assert.equal(retried.status, 404)
  assert.equal(retried.body.repeat, undefined)
  // A backend error may mean it went out: the retry is answered, and nothing is tried again.
  backend.setDown('connection dropped (test)')
  const maybe = { sessionId: 'demo-quill', text: 'y', requestId: 'card-0004-dddd' }
  assert.equal((await call(port, 'POST', '/api/send', { body: maybe })).status, 504)
  backend.setDown(null)
  const answered = await call(port, 'POST', '/api/send', { body: maybe })
  assert.equal(answered.status, 504)
  assert.equal(answered.body.repeat, true)
  assert.equal(answered.body.outcome, 'unknown')
  assert.equal(backend.sent.length, 0, 'never sent a second time')
})

test('send: an outcome the bridge cannot know is a 5xx outside 501 and 502, with outcome "unknown"; a refusal says nothing of the kind', async () => {
  const { port, backend } = await start()
  // The words the dashweb adapter uses when T3 may have taken the send.
  backend.setDown('not known whether T3 got the message (T3 did not answer the send within 15 s). Check the thread before sending again.')
  const r = await call(port, 'POST', '/api/send', { body: { sessionId: 'demo-quill', text: 'y', requestId: crypto.randomUUID() } })
  backend.setDown(null)
  assert.ok(r.status >= 500 && r.status !== 501 && r.status !== 502, `status ${r.status}`)
  assert.equal(r.body.outcome, 'unknown')
  assert.match(r.body.error, /not known whether T3 got the message/)
  // Refused before sending: a 4xx with no outcome field, since nothing went anywhere.
  const refused = await call(port, 'POST', '/api/send', { body: { sessionId: 'demo-lantern', text: 'y', requestId: crypto.randomUUID() } })
  assert.equal(refused.status, 404)
  assert.equal(refused.body.outcome, undefined)
  // The HUD's request ids are random UUIDs: 36 characters, inside the rule.
  const ok = await call(port, 'POST', '/api/send', { body: { sessionId: 'demo-quill', text: 'z', requestId: crypto.randomUUID() } })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.outcome, undefined)
})

// ---------------------------------------------------------------- per-client budgets

test('budgets: past the per-client request budget an address gets 429 with the wait', async () => {
  const { port } = await start({ limits: { apiPerMinute: 4 } })
  for (let i = 0; i < 4; i++) assert.equal((await call(port, 'GET', '/api/health')).status, 200)
  const r = await call(port, 'GET', '/api/health')
  assert.equal(r.status, 429)
  assert.match(r.body.error, /over 4 requests a minute; try again in \d+ s/)
  assert.ok(Number(r.headers['retry-after']) > 0)
})

test('budgets: the routes that start work have a tighter budget of their own; a clip refusal keeps the voice reply shape', async () => {
  const { port } = await start({ limits: { heavyPerMinute: 3 } })
  for (let i = 0; i < 3; i++) assert.equal((await call(port, 'POST', '/api/interpret', { body: { text: 'status', context: 'none' } })).status, 200)
  const r = await call(port, 'POST', '/api/interpret', { body: { text: 'status', context: 'none' } })
  assert.equal(r.status, 429)
  assert.match(r.body.error, /voice and transcript requests/)
  assert.equal((await call(port, 'GET', '/api/health')).status, 200, 'the light routes still answer')
  const clip = await call(port, 'POST', '/api/transcribe', { raw: Buffer.alloc(10), type: 'audio/webm' })
  assert.equal(clip.status, 429)
  assert.equal(clip.body.transcript.reason, 'busy')
  assert.equal(clip.body.interpretation, null)
})

// ---------------------------------------------------------------- bounded work

test('transcripts: two views reading one session share a read; only N run, a few wait, the rest get 503', async () => {
  const { port, backend } = await start({ limits: { transcripts: [1, 1] } })
  let release!: () => void
  backend.hold = new Promise<void>(r => (release = r))
  const a = call(port, 'GET', '/api/transcript?session=demo-harbour&limit=5')
  const b = call(port, 'GET', '/api/transcript?session=demo-harbour&limit=5')
  await new Promise(r => setTimeout(r, 50))
  const c = call(port, 'GET', '/api/transcript?session=demo-quill&limit=5')
  await new Promise(r => setTimeout(r, 50))
  const d = await call(port, 'GET', '/api/transcript?session=demo-kettle&limit=5')
  assert.equal(d.status, 503)
  assert.match(d.body.error, /busy: 1 transcript reads running and 1 waiting/)
  release()
  const done = await Promise.all([a, b, c])
  assert.deepEqual(done.map(r => r.status), [200, 200, 200])
  assert.equal(backend.reads, 2, 'harbour read once for both views, then quill')
})

test('clips: a clip waits for a slot before it is even read, and past the queue it is busy', async () => {
  const stt: SttProvider = { name: 'stub', status: () => ({ provider: 'stub', state: 'ready', error: null, model: null, loadMs: 1 }), onStatus: () => () => {}, transcribe: async () => ({ text: 'status', ms: 1 }), close: () => {} }
  const { port } = await start({ stt, limits: { clips: [1, 0] } })
  // The first upload never finishes, so it holds the one slot.
  const slow = request({ host: '127.0.0.1', port, path: '/api/transcribe', method: 'POST', rejectUnauthorized: false, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'audio/webm', 'content-length': '5000' } })
  slow.on('error', () => {})
  slow.write(Buffer.alloc(10))
  await new Promise(r => setTimeout(r, 100))
  const r = await call(port, 'POST', '/api/transcribe', { raw: Buffer.alloc(10), type: 'audio/webm' })
  assert.equal(r.status, 503)
  assert.equal(r.body.transcript.reason, 'busy')
  assert.match(r.body.transcript.error, /busy: 1 clips running and 0 waiting/)
  slow.destroy()
})

test('speech: only a few requests are rendered at once; past the queue it is 503', async () => {
  let release!: () => void
  const gate = new Promise<void>(r => (release = r))
  const tts: TtsProvider = { name: 'slow', status: (): TtsStatus => ({ provider: 'slow', ok: true, error: null }), speak: async () => (await gate, { audio: Buffer.from('audio'), mime: 'audio/webm' }) }
  const { port } = await start({ tts, limits: { speech: [1, 1] } })
  const a = call(port, 'POST', '/api/speak', { body: { text: 'one' } })
  const b = call(port, 'POST', '/api/speak', { body: { text: 'two' } })
  await new Promise(r => setTimeout(r, 50))
  const c = await call(port, 'POST', '/api/speak', { body: { text: 'three' } })
  assert.equal(c.status, 503)
  assert.match(c.body.error, /busy: 1 speech requests running and 1 waiting/)
  release()
  assert.deepEqual((await Promise.all([a, b])).map(r => r.status), [200, 200])
})

// ---------------------------------------------------------------- WebSocket

function connect(port: number): Promise<WebSocket | string> {
  return new Promise(ok => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, ['claudevr', `token.${TOKEN}`], { rejectUnauthorized: false })
    ws.once('open', () => ok(ws))
    ws.once('unexpected-response', (_req, res) => ok(String(res.statusCode)))
    ws.once('error', err => ok(err.message))
  })
}

test('websocket: an address may hold only so many sockets; one closing frees a place', async () => {
  const { port } = await start({ limits: { wsPerIp: 2 } })
  const a = await connect(port)
  const b = await connect(port)
  assert.ok(a instanceof WebSocket && b instanceof WebSocket)
  assert.equal(await connect(port), '503')
  a.close()
  await new Promise(r => setTimeout(r, 100))
  const c = await connect(port)
  assert.ok(c instanceof WebSocket, String(c))
  b.close()
  c.close()
})

test('websocket: the bridge as a whole holds only so many', async () => {
  const { port } = await start({ limits: { wsTotal: 1 } })
  const a = await connect(port)
  assert.ok(a instanceof WebSocket)
  assert.equal(await connect(port), '503')
  a.close()
})

// ---------------------------------------------------------------- logs

test('logs: each client has a byte budget for the probe and instrument logs', async () => {
  const { port, probeLog } = await start({ limits: { logBytesPerMinute: 1500 } })
  const big = { note: 'x'.repeat(500) }
  let status = 200
  let posts = 0
  while (status === 200 && posts < 10) {
    status = (await call(port, 'POST', '/api/probe', { body: big })).status
    posts++
  }
  assert.equal(status, 429)
  assert.ok(posts >= 2 && posts <= 4, `refused after ${posts} posts`)
  const inst = await call(port, 'POST', '/api/probe?log=instrument', { body: { events: [{ type: 'frames', pad: 'y'.repeat(400) }] } })
  assert.equal(inst.status, 429, 'the instrument log shares the budget')
  assert.ok(statSync(probeLog).size <= 1500)
})

test('logs: the probe and instrument logs rotate under their size budget', async () => {
  const { port, probeLog } = await start({ limits: { logFileMax: 1200 } })
  for (let i = 0; i < 8; i++) assert.equal((await call(port, 'POST', '/api/probe', { body: { i, pad: 'z'.repeat(300) } })).status, 200)
  for (let i = 0; i < 8; i++) assert.equal((await call(port, 'POST', '/api/probe?log=instrument', { body: { events: [{ type: 'frames', i, pad: 'w'.repeat(300) }] } })).status, 200)
  const inst = join(dir, 'instrument.log')
  for (const f of [probeLog, inst]) {
    assert.ok(existsSync(`${f}.1`), `${f} rotated`)
    assert.ok(statSync(f).size <= 1200 && statSync(`${f}.1`).size <= 1200, `${f} under budget`)
  }
})
