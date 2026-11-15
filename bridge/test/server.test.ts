// The bridge end to end over HTTPS, on FakeAdapter: the gate, the send
// route, the probe log and the WebSocket.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { createBridge, type Bridge } from '../src/server.ts'
import { FakeAdapter } from '../src/backend/fake.ts'
import { makeCert, lanAddresses } from '../src/cert.ts'
import { ipAllowed, loadOrCreateToken, normaliseIp, RateLimiter, tokenMatches } from '../src/gate.ts'
import type { AddressInfo } from 'node:net'

const FIX = join(import.meta.dirname, '..', '..', 'fixtures')
let dir: string
let bridge: Bridge
let fake: FakeAdapter
let port: number
const TOKEN = 'ab'.repeat(16)
const logs: string[] = []

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'claudevr-test-'))
  const certs = makeCert(join(dir, 'certs'), ['localhost', '127.0.0.1'])
  mkdirSync(join(dir, 'client'))
  writeFileSync(join(dir, 'client', 'index.html'), '<!doctype html><title>hud</title>')
  writeFileSync(join(dir, 'client', 'probe.html'), '<!doctype html><title>probe</title>')
  fake = FakeAdapter.fromFixtures(FIX, { pollMs: 50, log: () => {} })
  bridge = createBridge({
    backend: fake,
    token: TOKEN,
    allowIps: [],
    clientDir: join(dir, 'client'),
    probeLog: join(dir, 'probe.log'),
    cert: readFileSync(certs.cert),
    key: readFileSync(certs.key),
    sendsPerMinute: 3,
    sendsPerHour: 100,
    log: (...a) => logs.push(a.join(' ')),
  })
  await new Promise<void>(ok => bridge.server.listen(0, '0.0.0.0', ok))
  port = (bridge.server.address() as AddressInfo).port
})

after(async () => {
  await bridge.close()
  fake.close()
  rmSync(dir, { recursive: true, force: true })
})

function call(method: string, path: string, opts: { token?: string; body?: unknown; host?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: any; headers: Record<string, unknown> }> {
  return new Promise((ok, fail) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body)
    const req = request(
      {
        host: opts.host ?? '127.0.0.1',
        port,
        path,
        method,
        rejectUnauthorized: false,
        headers: {
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...(data ? { 'content-type': 'application/json' } : {}),
          ...opts.headers,
        },
      },
      res => {
        let text = ''
        res.on('data', c => (text += c))
        res.on('end', () => {
          const isJson = String(res.headers['content-type'] ?? '').startsWith('application/json')
          ok({ status: res.statusCode ?? 0, body: isJson ? JSON.parse(text) : text, headers: res.headers })
        })
      },
    )
    req.on('error', fail)
    req.end(data)
  })
}

test('unit: ipAllowed takes loopback and the list, nothing else', () => {
  assert.equal(ipAllowed('127.0.0.1', []), true)
  assert.equal(ipAllowed('::1', []), true)
  assert.equal(ipAllowed('::ffff:127.0.0.1', []), true)
  assert.equal(ipAllowed('10.20.30.40', []), false)
  assert.equal(ipAllowed('::ffff:10.20.30.40', ['10.20.30.40']), true)
  assert.equal(ipAllowed('10.20.30.4', ['10.20.30.40']), false)
  assert.equal(ipAllowed('', ['']), false)
  assert.equal(normaliseIp('::ffff:10.0.0.1'), '10.0.0.1')
})

test('unit: token compare and token file', () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true)
  assert.equal(tokenMatches(TOKEN.slice(1), TOKEN), false)
  assert.equal(tokenMatches('', TOKEN), false)
  assert.equal(tokenMatches(null, TOKEN), false)
  const p = join(dir, 'state', 'pairing-token')
  const first = loadOrCreateToken(p, () => {})
  const second = loadOrCreateToken(p, () => {})
  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(first.token, second.token)
  assert.match(first.token, /^[0-9a-f]{32}$/)
})

test('unit: the rate limiter allows N a minute, then says how long to wait', () => {
  const r = new RateLimiter(2, 3)
  assert.equal(r.take(0), null)
  assert.equal(r.take(1000), null)
  assert.deepEqual(r.take(2000), { retryAfterS: 58 }, 'the oldest slot frees 60 s after it was taken')
  assert.equal(r.take(61_000), null)
  assert.ok((r.take(200_000)?.retryAfterS ?? 0) > 60, 'the hourly cap holds')
})

test('static pages load without a token, with isolation headers', async () => {
  const hud = await call('GET', '/')
  assert.equal(hud.status, 200)
  assert.match(String(hud.body), /<title>hud/)
  assert.equal(hud.headers['cross-origin-opener-policy'], 'same-origin')
  assert.equal(hud.headers['cross-origin-embedder-policy'], 'require-corp')
  const probe = await call('GET', '/probe')
  assert.match(String(probe.body), /<title>probe/)
  assert.equal((await call('GET', '/../../etc/passwd')).status, 404)
})

test('API: no token 401, wrong token 401, right token 200', async () => {
  assert.equal((await call('GET', '/api/health')).status, 401)
  assert.equal((await call('GET', '/api/health', { token: 'cd'.repeat(16) })).status, 401)
  const good = await call('GET', '/api/health', { token: TOKEN })
  assert.equal(good.status, 200)
  assert.equal(good.body.backend.name, 'fake')
})

test('API: a request from another origin is refused even with the token', async () => {
  const r = await call('GET', '/api/health', { token: TOKEN, headers: { origin: 'https://evil.example' } })
  assert.equal(r.status, 403)
})

test('API: http:// on the same host is another origin, since the bridge only serves https://', async () => {
  const host = `127.0.0.1:${port}`
  assert.equal((await call('GET', '/api/health', { token: TOKEN, headers: { origin: `http://${host}` } })).status, 403)
  assert.equal((await call('GET', '/api/health', { token: TOKEN, headers: { origin: `https://${host}` } })).status, 200)
  const ws = await connect(['claudevr', `token.${TOKEN}`], `http://${host}`)
  assert.deepEqual(ws, { error: '403' }, 'the WebSocket too')
})

/** What the bridge answers to bytes written straight onto a TLS socket, so the request line can be anything. */
function rawExchange(text: string): Promise<string> {
  return new Promise((ok, fail) => {
    let got = ''
    const s = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => s.write(text))
    s.on('data', d => (got += d))
    s.on('close', () => ok(got))
    // The bridge closes as soon as it has answered; a reset after the answer is fine.
    s.on('error', err => (got ? ok(got) : fail(err)))
  })
}

test('a request target that is not a URL is answered 400, on HTTP and on the WebSocket path, and the bridge stays up', async () => {
  const http = await rawExchange('GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
  assert.match(http, /^HTTP\/1\.1 400/)
  const upgrade = await rawExchange('GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n')
  assert.match(upgrade, /^HTTP\/1\.1 400/)
  assert.match(String((await rawExchange('GET /%E0%A4%A HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'))), /^HTTP\/1\.1 400/, 'a path that does not decode is 400, not 500')
  assert.equal((await call('GET', '/api/health', { token: TOKEN })).status, 200, 'still serving')
})

test('pair: off by default, so the token is never handed out', async () => {
  const r = await call('POST', '/api/pair')
  assert.equal(r.status, 403)
  assert.equal(JSON.stringify(r.body).includes(TOKEN), false)
})

test('pair: with autoPair on, an allowed address gets a token that works; another origin does not', async () => {
  const certs = makeCert(join(dir, 'certs-pair'), ['localhost', '127.0.0.1'])
  const backend = FakeAdapter.fromFixtures(FIX, { pollMs: 50, log: () => {} })
  const paired = createBridge({
    backend,
    token: TOKEN,
    allowIps: [],
    autoPair: true,
    clientDir: join(dir, 'client'),
    probeLog: join(dir, 'probe-pair.log'),
    cert: readFileSync(certs.cert),
    key: readFileSync(certs.key),
    sendsPerMinute: 3,
    sendsPerHour: 100,
    log: () => {},
  })
  await new Promise<void>(ok => paired.server.listen(0, '127.0.0.1', ok))
  const mainPort = port
  port = (paired.server.address() as AddressInfo).port
  try {
    const got = await call('POST', '/api/pair')
    assert.equal(got.status, 200)
    assert.equal(got.body.token, TOKEN)
    assert.equal((await call('GET', '/api/health', { token: got.body.token })).status, 200)
    // Pairing does not open the rest of the API to a request with no token.
    assert.equal((await call('GET', '/api/health')).status, 401)
    const foreign = await call('POST', '/api/pair', { headers: { origin: 'https://evil.example' } })
    assert.equal(foreign.status, 403)
    assert.equal(JSON.stringify(foreign.body).includes(TOKEN), false)
  } finally {
    port = mainPort
    await paired.close()
    backend.close()
  }
})

test('gate: a non-loopback address not on the list is refused, token or not', async t => {
  const lan = lanAddresses()[0]
  if (!lan) return t.skip('no LAN address on this machine to come from')
  const r = await call('GET', '/api/health', { token: TOKEN, host: lan })
  assert.equal(r.status, 403)
  assert.equal((await call('GET', '/', { host: lan })).status, 403)
})

test('send: delivered through FakeAdapter with the token; refused without it', async () => {
  const before = fake.sent.length
  const none = await call('POST', '/api/send', { body: { sessionId: 'demo-harbour', text: 'run the tests' } })
  assert.equal(none.status, 401)
  assert.equal(fake.sent.length, before, 'nothing reached the backend without a token')
  const ok = await call('POST', '/api/send', { token: TOKEN, body: { sessionId: 'demo-harbour', text: 'run the tests' } })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal(fake.sent.at(-1)?.text, 'run the tests')
  const unknown = await call('POST', '/api/send', { token: TOKEN, body: { sessionId: 'nobody', text: 'x' } })
  assert.equal(unknown.status, 404)
  const bad = await call('POST', '/api/send', { token: TOKEN, body: { sessionId: 'demo-harbour' } })
  assert.equal(bad.status, 400)
})

test('transcript: needs the token, returns turns for a known session, 404 for an unknown one', async () => {
  const id = (await fake.list()).sessions[0]!.id
  assert.equal((await call('GET', `/api/transcript?session=${encodeURIComponent(id)}`)).status, 401)
  const ok = await call('GET', `/api/transcript?session=${encodeURIComponent(id)}&limit=5`, { token: TOKEN })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.sessionId, id)
  assert.ok(Array.isArray(ok.body.turns))
  assert.equal((await call('GET', '/api/transcript?session=nope', { token: TOKEN })).status, 404)
  assert.equal((await call('GET', '/api/transcript', { token: TOKEN })).status, 400)
})

test('send: rate limited after the per-minute allowance', async () => {
  // Three a minute; the test above used two slots (ok and unknown).
  const third = await call('POST', '/api/send', { token: TOKEN, body: { sessionId: 'demo-quill', text: 'one more' } })
  assert.equal(third.status, 200)
  const limited = await call('POST', '/api/send', { token: TOKEN, body: { sessionId: 'demo-quill', text: 'too many' } })
  assert.equal(limited.status, 429)
  assert.ok(Number(limited.headers['retry-after']) > 0)
})

test('probe: results land in the log as one JSON line', async () => {
  const r = await call('POST', '/api/probe', { token: TOKEN, body: { getUserMedia: { status: 'ok' } }, headers: { 'user-agent': 'TestHeadset/1.0' } })
  assert.equal(r.status, 200)
  const lines = readFileSync(join(dir, 'probe.log'), 'utf8').trim().split('\n')
  const last = JSON.parse(lines.at(-1)!)
  assert.equal(last.ua, 'TestHeadset/1.0')
  assert.deepEqual(last.results, { getUserMedia: { status: 'ok' } })
  assert.equal((await call('POST', '/api/probe', { body: { x: 1 } })).status, 401)
})

test('instrument log: each event is its own line, stamped by the bridge, behind the token', async () => {
  const r = await call('POST', '/api/probe?log=instrument', { token: TOKEN, body: { events: [{ type: 'session-start', features: ['layers'] }, { type: 'blur', at: 'forged' }] } })
  assert.equal(r.status, 200)
  assert.equal(r.body.logged, 2)
  const lines = readFileSync(join(dir, 'instrument.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.equal(lines.length, 2)
  assert.equal(lines[0].type, 'session-start')
  assert.deepEqual(lines[0].features, ['layers'])
  assert.notEqual(lines[1].at, 'forged', 'the bridge clock wins')
  assert.equal(lines[1].ip, '127.0.0.1')
  assert.equal((await call('POST', '/api/probe?log=instrument', { body: { events: [] } })).status, 401)
  assert.equal((await call('POST', '/api/probe?log=instrument', { token: TOKEN, body: { events: 'nope' } })).status, 400)
  assert.equal((await call('POST', '/api/probe?log=instrument', { token: TOKEN, body: { events: [1, 2] } })).status, 400)
  // The probe log itself is untouched by instrument events.
  assert.ok(!readFileSync(join(dir, 'probe.log'), 'utf8').includes('session-start'))
})

test('the page policy allows WebAssembly compilation and nothing looser', async () => {
  const csp = String((await call('GET', '/')).headers['content-security-policy'])
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/)
  assert.match(csp, /connect-src 'self' data:;/)
  assert.doesNotMatch(csp, /'unsafe-eval'|'unsafe-inline'[^;]*script|https?:/)
})

function connect(protocols: string[], origin?: string): Promise<{ ws: WebSocket; first: any } | { error: string }> {
  return new Promise(ok => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, protocols, { rejectUnauthorized: false, ...(origin ? { origin } : {}) })
    ws.once('message', m => ok({ ws, first: JSON.parse(String(m)) }))
    ws.once('unexpected-response', (_req, res) => ok({ error: String(res.statusCode) }))
    ws.once('error', err => ok({ error: err.message }))
  })
}

test('websocket: refused without the token, delivers the fleet with it', async () => {
  const none = await connect(['claudevr'])
  assert.deepEqual(none, { error: '401' })
  const wrong = await connect(['claudevr', `token.${'cd'.repeat(16)}`])
  assert.deepEqual(wrong, { error: '401' })
  const good = await connect(['claudevr', `token.${TOKEN}`])
  assert.ok('ws' in good, JSON.stringify(good))
  assert.equal(good.ws.protocol, 'claudevr')
  // The first message is hello or a fleet; within a poll a fleet arrives.
  const fleet = good.first.type === 'fleet' ? good.first : await new Promise<any>(r => good.ws.once('message', m => r(JSON.parse(String(m)))))
  assert.equal(fleet.type, 'fleet')
  assert.equal(fleet.fleet.sessions.length, 7)
  assert.equal(fleet.status.ok, true)
  good.ws.close()
})

test('websocket: a backend outage is pushed as a status, not as an empty fleet', async () => {
  const c = await connect(['claudevr', `token.${TOKEN}`])
  assert.ok('ws' in c)
  fake.setDown('dashweb unreachable (test)')
  const msg = await new Promise<any>(r => {
    const on = (m: WebSocket.RawData) => {
      const d = JSON.parse(String(m))
      if (d.type === 'status') {
        c.ws.off('message', on)
        r(d)
      }
    }
    c.ws.on('message', on)
  })
  fake.setDown(null)
  assert.equal(msg.status.ok, false)
  assert.equal(msg.status.error, 'dashweb unreachable (test)')
  c.ws.close()
})
