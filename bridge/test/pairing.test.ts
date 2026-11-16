// The pairing handshake end to end over HTTPS: a device asks for a code, the
// code is approved on this machine, the device collects its own token once.
// Plus the guards: loopback only, Origin, wrong-code and request limits,
// expiry, revocation, the legacy token, the devices file and the log.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { request } from 'node:https'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { createBridge, REVOKED_CLOSE, type Bridge } from '../src/server.ts'
import { FakeAdapter } from '../src/backend/fake.ts'
import { lanAddresses, makeCert } from '../src/cert.ts'
import { isLoopback, loopbackHost } from '../src/gate.ts'
import { appleScriptString, deviceLabel, DeviceStore, formatCode, normaliseCode, notifyMac, PAIR_ALPHABET, PairingRequests, type PairLimits } from '../src/pairing.ts'

const FIX = join(import.meta.dirname, '..', '..', 'fixtures')
const QUEST_UA = 'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/37.0.0 SamsungBrowser/4.0 Chrome/132.0.0.0 VR Safari/537.36'
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const LEGACY = 'ab'.repeat(16)
const CODE_RE = new RegExp(`^[${PAIR_ALPHABET}]{3}-[${PAIR_ALPHABET}]{3}$`)
const LAN = lanAddresses()[0] ?? null

let dir: string
let cert: Buffer
let key: Buffer
const running: { bridge: Bridge; backend: FakeAdapter }[] = []
/** Every line every test bridge logged, and every code, token and secret it handed out: the last test checks none leaked. */
const allLogs: string[] = []
const secrets = new Set<string>([LEGACY])

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'claudevr-pairing-'))
  const certs = makeCert(join(dir, 'certs'), ['localhost', '127.0.0.1', ...(LAN ? [LAN] : [])])
  cert = readFileSync(certs.cert)
  key = readFileSync(certs.key)
  mkdirSync(join(dir, 'client'))
  writeFileSync(join(dir, 'client', 'index.html'), '<!doctype html><title>hud</title>')
})

after(async () => {
  for (const { bridge, backend } of running) {
    await bridge.close()
    backend.close()
  }
  rmSync(dir, { recursive: true, force: true })
})

interface Rig {
  port: number
  devices: DeviceStore
  pairing: PairingRequests
  logs: string[]
  notes: string[]
  state: string
  /** The pairing clock; tests move it. */
  clock: { t: number }
  backend: FakeAdapter
}

let n = 0
async function start(o: { limits?: Partial<PairLimits>; autoPair?: boolean; legacy?: boolean } = {}): Promise<Rig> {
  const state = join(dir, `state-${++n}`)
  mkdirSync(state, { recursive: true })
  if (o.legacy !== false) writeFileSync(join(state, 'pairing-token'), `${LEGACY}\n`, { mode: 0o600 })
  const logs: string[] = []
  const notes: string[] = []
  const log = (...a: unknown[]) => {
    const line = a.map(x => (x instanceof Error ? x.message : String(x))).join(' ')
    logs.push(line)
    allLogs.push(line)
  }
  const clock = { t: 1_800_000_000_000 }
  const now = () => clock.t
  const devices = new DeviceStore({ file: join(state, 'devices.json'), legacyFile: join(state, 'pairing-token'), log, now })
  const pairing = new PairingRequests({ devices, log, now, limits: o.limits })
  const backend = FakeAdapter.fromFixtures(FIX, { pollMs: 50, log: () => {} })
  const bridge = createBridge({
    backend,
    devices,
    pairing,
    notify: text => notes.push(text),
    allowIps: LAN ? [LAN] : [],
    autoPair: o.autoPair,
    clientDir: join(dir, 'client'),
    probeLog: join(state, 'probe.log'),
    cert,
    key,
    sendsPerMinute: 3,
    sendsPerHour: 100,
    log,
  })
  await new Promise<void>(ok => bridge.server.listen(0, LAN ? '0.0.0.0' : '127.0.0.1', ok))
  running.push({ bridge, backend })
  return { port: (bridge.server.address() as AddressInfo).port, devices, pairing, logs, notes, state, clock, backend }
}

type Reply = { status: number; body: any; headers: Record<string, unknown> }
function call(port: number, method: string, path: string, opts: { body?: unknown; token?: string; headers?: Record<string, string>; host?: string } = {}): Promise<Reply> {
  return new Promise((ok, fail) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body)
    const req = request(
      {
        host: opts.host ?? '127.0.0.1',
        port,
        path,
        method,
        rejectUnauthorized: false,
        headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(data ? { 'content-type': 'application/json' } : {}), ...opts.headers },
      },
      res => {
        let text = ''
        res.on('data', c => (text += c))
        res.on('end', () => ok({ status: res.statusCode ?? 0, body: String(res.headers['content-type'] ?? '').startsWith('application/json') ? JSON.parse(text) : text, headers: res.headers }))
      },
    )
    req.on('error', fail)
    req.end(data)
  })
}

/** What the approval page sends: a same-origin POST, which a browser always gives an Origin header. */
const fromPage = (port: number) => ({ origin: `https://127.0.0.1:${port}` })

async function ask(r: Rig, ua = QUEST_UA, host?: string, body: unknown = {}, headers: Record<string, string> = {}): Promise<Reply> {
  const res = await call(r.port, 'POST', '/api/pair/request', { body, headers: { 'user-agent': ua, ...headers }, host })
  if (res.status === 200) {
    secrets.add(res.body.code)
    secrets.add(normaliseCode(res.body.code))
    secrets.add(res.body.secret)
  }
  return res
}
const poll = (r: Rig, id: string, secret: string | null, host?: string) => call(r.port, 'GET', `/api/pair/status?id=${id}`, { headers: secret ? { 'x-pair-secret': secret } : {}, host })
const approve = (r: Rig, code: string, headers: Record<string, string> = fromPage(r.port), host?: string) => call(r.port, 'POST', '/api/pair/approve', { body: { code }, headers, host })
const revoke = (r: Rig, body: unknown) => call(r.port, 'POST', '/api/pair/revoke', { body, headers: fromPage(r.port) })
const listed = (r: Rig) => call(r.port, 'GET', '/api/pair/devices')

async function pairDevice(r: Rig, ua = QUEST_UA): Promise<{ token: string; id: string }> {
  const t = await ask(r, ua)
  assert.equal(t.status, 200, JSON.stringify(t.body))
  assert.equal((await approve(r, t.body.code)).status, 200)
  const got = await poll(r, t.body.id, t.body.secret)
  assert.equal(got.body.state, 'approved')
  secrets.add(got.body.token)
  const id = r.devices.list().at(-1)!.id
  return { token: got.body.token, id }
}

function wsOpen(port: number, token: string): Promise<{ ws: WebSocket } | { error: string }> {
  return new Promise(ok => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, ['claudevr', `token.${token}`], { rejectUnauthorized: false })
    ws.once('open', () => ok({ ws }))
    ws.once('unexpected-response', (_req, res) => ok({ error: String(res.statusCode) }))
    ws.once('error', err => ok({ error: err.message }))
  })
}
const closed = (ws: WebSocket) => new Promise<number>(ok => ws.once('close', code => ok(code)))

// ------------------------------------------------------------------ units

test('unit: codes use the unambiguous alphabet, show as ABC-123, and are typed any way', () => {
  const devices = new DeviceStore({ file: null })
  const p = new PairingRequests({ devices, limits: { perIp: 1000, total: 1000, requestsPerMinute: 1000 } })
  const seen = new Set<string>()
  for (let i = 0; i < 300; i++) {
    const r = p.create(`10.0.0.${i % 250}`, QUEST_UA)
    assert.ok(r.ok)
    assert.match(r.code, CODE_RE)
    seen.add(r.code)
  }
  assert.equal(seen.size, 300, 'no two waiting codes are the same')
  assert.equal(normaliseCode(' acd-347 '), 'ACD347')
  assert.equal(formatCode('ACD347'), 'ACD-347')
  for (const c of '0O1IL2Z5S8B') assert.equal(PAIR_ALPHABET.includes(c), false, `${c} is easy to misread`)
})

test('unit: device labels come from the User-Agent, printable and clipped', () => {
  assert.equal(deviceLabel(QUEST_UA), 'Quest browser')
  assert.equal(deviceLabel(MAC_UA), 'Chrome on Mac')
  assert.equal(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'), 'Safari on Mac')
  assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'), 'Safari on iPhone')
  assert.equal(deviceLabel(undefined), 'Unknown browser')
  const odd = deviceLabel(`curl/8.0\n\u001b[31mpair: fake line ${'x'.repeat(200)}`)
  assert.ok(odd.length <= 60, odd)
  assert.equal(/[\x00-\x1f\x7f]/.test(odd), false, 'no newline or escape survives into a log line')
})

test('unit: the approval routes check loopback by address and by Host name', () => {
  for (const ip of ['127.0.0.1', '127.0.0.9', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopback(ip), true, ip)
  for (const ip of ['192.0.2.10', '::ffff:192.0.2.10', '', undefined]) assert.equal(isLoopback(ip), false, String(ip))
  const req = (host?: string) => ({ headers: host === undefined ? {} : { host } }) as IncomingMessage
  for (const h of ['localhost:8443', '127.0.0.1:8443', '[::1]:8443', 'LOCALHOST:8443']) assert.equal(loopbackHost(req(h)), true, h)
  for (const h of ['192.0.2.10:8443', 'evil.example:8443', 'localhost.evil.example', '127.0.0.1.nip.io', undefined]) assert.equal(loopbackHost(req(h)), false, String(h))
})

test('unit: the notification hands osascript one escaped argument, with no shell', () => {
  const calls: { file: string; args: string[] }[] = []
  const logs: string[] = []
  notifyMac('Quest "x" \\ at 192.0.2.10\nwants to pair', l => logs.push(String(l)), (file, args, _o, done) => {
    calls.push({ file, args })
    done(new Error('not allowed to send notifications'))
  })
  assert.deepEqual(calls, [{ file: 'osascript', args: ['-e', 'display notification "Quest \\"x\\" \\\\ at 192.0.2.10 wants to pair" with title "ClaudeVR"'] }])
  assert.match(logs[0]!, /could not post a notification: not allowed/, 'a failed notification is logged, not swallowed')
  assert.equal(appleScriptString('a"b\\c'), 'a\\"b\\\\c')
})

test('unit: last seen is written at most once a minute per device', () => {
  const f = join(dir, 'seen', 'devices.json')
  const clock = { t: 1_000_000 }
  const store = new DeviceStore({ file: f, now: () => clock.t })
  const { token } = store.add('Quest browser', '192.0.2.10')
  secrets.add(token)
  const cred = store.match(token)!
  assert.equal(cred.kind, 'device')
  const lastSeen = () => JSON.parse(readFileSync(f, 'utf8')).devices[0].lastSeen
  store.seen(cred)
  assert.equal(lastSeen(), 1_000_000)
  clock.t += 30_000
  store.seen(cred)
  assert.equal(lastSeen(), 1_000_000, 'not written again within the minute')
  clock.t += 31_000
  store.seen(cred)
  assert.equal(lastSeen(), 1_061_000)
})

// ------------------------------------------------------------------ the flow

test('flow: ask, poll, approve on this machine, collect the token once; it opens the API and the WebSocket', async () => {
  const r = await start()
  const t = await ask(r)
  assert.equal(t.status, 200, JSON.stringify(t.body))
  assert.match(t.body.code, CODE_RE)
  assert.equal(t.body.label, 'Quest browser')
  assert.equal(t.body.approveUrl, `https://localhost:${r.port}/pair`)
  assert.equal(t.body.expiresInMs, 120_000)
  assert.ok(r.logs.includes(`pair: Quest browser at 127.0.0.1 wants to pair; enter its code at https://localhost:${r.port}/pair`), r.logs.join('\n'))
  assert.deepEqual(r.notes, [`Quest browser at 127.0.0.1 wants to pair; enter its code at https://localhost:${r.port}/pair`])

  assert.deepEqual((await poll(r, t.body.id, t.body.secret)).body, { state: 'pending', expiresInMs: 120_000 })
  assert.equal((await poll(r, t.body.id, null)).status, 404, 'no secret, no answer')
  assert.equal((await poll(r, t.body.id, 'x'.repeat(43))).status, 404, 'a wrong secret looks like an unknown id')

  const page = await call(r.port, 'GET', '/pair')
  assert.equal(page.status, 200)
  assert.match(String(page.body), /Pair a device/)
  assert.match(String(page.headers['content-security-policy']), /frame-ancestors 'none'/, 'no other page can frame the approval page')
  assert.equal((await call(r.port, 'GET', '/pair/pair.js')).status, 200)
  const before = await listed(r)
  assert.equal(before.status, 200)
  assert.deepEqual(before.body.waiting.map((w: any) => w.label), ['Quest browser'])
  assert.equal(JSON.stringify(before.body).includes(normaliseCode(t.body.code)) || JSON.stringify(before.body).includes(t.body.code), false, 'the list never shows a code')

  const ok = await approve(r, t.body.code.toLowerCase().replace('-', ' '))
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal(ok.body.device.label, 'Quest browser')
  assert.equal(ok.body.device.ip, '127.0.0.1')
  assert.equal((await approve(r, t.body.code)).status, 404, 'a request is approved once')

  const got = await poll(r, t.body.id, t.body.secret)
  assert.equal(got.status, 200)
  assert.equal(got.body.state, 'approved')
  assert.match(got.body.token, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url')
  secrets.add(got.body.token)
  assert.equal((await poll(r, t.body.id, t.body.secret)).status, 404, 'the token is handed over once')

  assert.equal((await call(r.port, 'GET', '/api/health', { token: got.body.token })).status, 200)
  const ws = await wsOpen(r.port, got.body.token)
  assert.ok('ws' in ws, JSON.stringify(ws))
  ws.ws.close()
  const [d] = (await listed(r)).body.devices
  assert.equal(d.label, 'Quest browser')
  assert.equal(d.lastSeen, r.clock.t, 'last seen is noted on use')
})

test('approve: a wrong code is refused; ten wrong a minute, then even the right one waits', async () => {
  const r = await start()
  const t = await ask(r)
  const wrong = [...'ACDEFGHJKMNP'].map(c => c.repeat(6)).filter(c => c !== normaliseCode(t.body.code)).slice(0, 10)
  for (const [i, c] of wrong.entries()) {
    const res = await approve(r, c)
    assert.equal(res.status, 404, `wrong code ${i + 1}`)
    assert.match(res.body.error, /No device is waiting with that code/)
  }
  const blocked = await approve(r, t.body.code)
  assert.equal(blocked.status, 429, 'the limit holds for the right code too, so guessing cannot slip one in')
  assert.ok(Number(blocked.headers['retry-after']) > 0)
  assert.equal((await poll(r, t.body.id, t.body.secret)).body.state, 'pending', 'nothing was paired')
  r.clock.t += 61_000
  assert.equal((await approve(r, t.body.code)).status, 200, 'a minute later the right code works')
  assert.equal((await approve(r, 'not a code at all')).status, 400)
})

test('expiry: a code unused for 2 minutes is gone; one approved but never collected is unpaired', async () => {
  const r = await start()
  const t = await ask(r)
  r.clock.t += 120_001
  assert.equal((await poll(r, t.body.id, t.body.secret)).status, 404)
  assert.equal((await approve(r, t.body.code)).status, 404)

  const u = await ask(r)
  assert.equal((await approve(r, u.body.code)).status, 200)
  assert.equal(r.devices.list().length, 1)
  r.clock.t += 120_001
  assert.equal((await listed(r)).body.devices.length, 0, 'nobody holds its token, so the device is gone')
  assert.ok(r.logs.some(l => /approved but never collected its token; unpaired it/.test(l)))
  assert.equal((await poll(r, u.body.id, u.body.secret)).status, 404)
})

test('limits: 3 codes wait per address; "New code" replaces one; new codes and waiting codes are capped', async () => {
  const r = await start()
  const first = await ask(r)
  assert.equal((await ask(r)).status, 200)
  assert.equal((await ask(r)).status, 200)
  const fourth = await ask(r)
  assert.equal(fourth.status, 429)
  assert.match(fourth.body.error, /3 codes are already waiting/)
  const replaced = await ask(r, QUEST_UA, undefined, { replaces: first.body.id }, { 'x-pair-secret': first.body.secret })
  assert.equal(replaced.status, 200, 'replacing its own code works at the cap')
  assert.equal((await poll(r, first.body.id, first.body.secret)).status, 404, 'the replaced code is gone')
  const notMine = await ask(r, QUEST_UA, undefined, { replaces: replaced.body.id }, { 'x-pair-secret': 'wrong' })
  assert.equal(notMine.status, 429, 'a replace needs the poll secret')
  assert.match(notMine.body.error, /already waiting/)

  const fast = await start({ limits: { perIp: 100 } })
  for (let i = 0; i < 6; i++) assert.equal((await ask(fast)).status, 200)
  const seventh = await ask(fast)
  assert.equal(seventh.status, 429)
  assert.match(seventh.body.error, /over 6 new codes a minute/)

  const small = await start({ limits: { total: 2, perIp: 10 } })
  assert.equal((await ask(small)).status, 200)
  assert.equal((await ask(small)).status, 200)
  assert.equal((await ask(small)).status, 503)
})

test('this machine only: from the LAN the approval page and routes are 403, allowed or not; the device side works', async t => {
  const r = await start()
  // A name that resolves to 127.0.0.1 is not this machine's name.
  const rebound = { host: `evil.example:${r.port}`, origin: `https://evil.example:${r.port}` }
  const code = (await ask(r)).body.code
  assert.equal((await call(r.port, 'GET', '/pair', { headers: { host: rebound.host } })).status, 403)
  assert.equal((await approve(r, code, rebound)).status, 403)
  if (!LAN) return t.skip('no LAN address on this machine to come from')
  const fromLan = await ask(r, QUEST_UA, LAN)
  assert.equal(fromLan.status, 200, 'an allowed address may ask for a code')
  assert.ok(r.logs.includes(`pair: Quest browser at ${LAN} wants to pair; enter its code at https://localhost:${r.port}/pair`))
  const page = await call(r.port, 'GET', '/pair', { host: LAN })
  assert.equal(page.status, 403)
  assert.match(String(page.body), /opens only on the bridge's own machine/)
  assert.equal((await call(r.port, 'GET', '/pair/pair.js', { host: LAN })).status, 403)
  assert.equal((await call(r.port, 'GET', '/api/pair/devices', { host: LAN })).status, 403)
  const self = await approve(r, fromLan.body.code, { origin: `https://${LAN}:${r.port}` }, LAN)
  assert.equal(self.status, 403, 'the headset cannot approve its own code')
  assert.equal((await call(r.port, 'POST', '/api/pair/revoke', { body: { legacy: true }, headers: { origin: `https://${LAN}:${r.port}` }, host: LAN })).status, 403)
  assert.equal((await poll(r, fromLan.body.id, fromLan.body.secret, LAN)).body.state, 'pending', 'still waiting for this machine')
  assert.equal((await poll(r, fromLan.body.id, fromLan.body.secret)).status, 404, 'only the address that asked may collect')
  assert.equal(r.devices.legacyActive(), true)
})

test('approve: another origin, or no Origin at all, is refused and the code still waits', async () => {
  const r = await start()
  const t = await ask(r)
  assert.equal((await approve(r, t.body.code, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await approve(r, t.body.code, { origin: `http://127.0.0.1:${r.port}` })).status, 403, 'http:// on the same host is another origin')
  assert.equal((await approve(r, t.body.code, {})).status, 403, 'a POST with no Origin is not from the page')
  assert.equal((await call(r.port, 'POST', '/api/pair/revoke', { body: { legacy: true }, headers: { origin: 'https://evil.example' } })).status, 403)
  assert.equal((await poll(r, t.body.id, t.body.secret)).body.state, 'pending')
  assert.equal(r.devices.list().length, 0)
  assert.equal((await approve(r, t.body.code)).status, 200)
})

test('revoke: the device token stops working at once and its open WebSocket is closed', async () => {
  const r = await start()
  const keep = await pairDevice(r, MAC_UA)
  const gone = await pairDevice(r)
  const a = await wsOpen(r.port, gone.token)
  const b = await wsOpen(r.port, keep.token)
  assert.ok('ws' in a && 'ws' in b)
  const aClosed = closed(a.ws)
  const res = await revoke(r, { id: gone.id })
  assert.equal(res.status, 200)
  assert.equal(res.body.device.label, 'Quest browser')
  assert.equal(await aClosed, REVOKED_CLOSE)
  assert.equal(b.ws.readyState, WebSocket.OPEN, 'the other device is untouched')
  assert.equal((await call(r.port, 'GET', '/api/health', { token: gone.token })).status, 401)
  assert.deepEqual(await wsOpen(r.port, gone.token), { error: '401' })
  assert.equal((await call(r.port, 'GET', '/api/health', { token: keep.token })).status, 200)
  assert.deepEqual((await listed(r)).body.devices.map((d: any) => d.label), ['Chrome on Mac'])
  assert.equal((await revoke(r, { id: gone.id })).status, 404)
  b.ws.close()
})

test('legacy token: still accepted and listed; revoking it deletes its file and closes its sockets, across a restart too', async () => {
  const r = await start()
  assert.equal((await call(r.port, 'GET', '/api/health', { token: LEGACY })).status, 200, 'browsers paired before keep working')
  const ws = await wsOpen(r.port, LEGACY)
  assert.ok('ws' in ws)
  assert.equal((await listed(r)).body.legacy.active, true)
  const shut = closed(ws.ws)
  const res = await revoke(r, { legacy: true })
  assert.equal(res.status, 200)
  assert.equal(res.body.revoked, 'legacy')
  assert.equal(await shut, REVOKED_CLOSE)
  assert.equal(existsSync(join(r.state, 'pairing-token')), false)
  assert.equal((await call(r.port, 'GET', '/api/health', { token: LEGACY })).status, 401)
  assert.equal((await listed(r)).body.legacy.active, false)
  assert.equal(new DeviceStore({ file: join(r.state, 'devices.json'), legacyFile: join(r.state, 'pairing-token') }).legacyActive(), false, 'a restart without autoPair makes no new one')
})

test('autoPair, deprecated, still hands out the legacy token; after a revoke it makes a new one', async () => {
  const r = await start({ autoPair: true })
  const first = await call(r.port, 'POST', '/api/pair')
  assert.equal(first.body.token, LEGACY)
  assert.equal((await revoke(r, { legacy: true })).status, 200)
  const next = await call(r.port, 'POST', '/api/pair')
  assert.equal(next.status, 200)
  secrets.add(next.body.token)
  assert.notEqual(next.body.token, LEGACY)
  assert.equal((await call(r.port, 'GET', '/api/health', { token: next.body.token })).status, 200)
  assert.equal((await call(r.port, 'GET', '/api/health', { token: LEGACY })).status, 401)
})

test('devices.json: mode 600, written whole, holds hashes and never a token, and a restart keeps the pairing', async () => {
  const r = await start({ legacy: false })
  const { token, id } = await pairDevice(r)
  const f = join(r.state, 'devices.json')
  assert.equal(statSync(f).mode & 0o777, 0o600)
  const text = readFileSync(f, 'utf8')
  assert.equal(text.includes(token), false)
  const saved = JSON.parse(text)
  assert.equal(saved.devices[0].id, id)
  assert.match(saved.devices[0].hash, /^[0-9a-f]{64}$/)
  assert.deepEqual(readdirSync(r.state).filter(x => x.endsWith('.tmp')), [], 'no temporary file is left behind')
  const again = new DeviceStore({ file: f, legacyFile: join(r.state, 'pairing-token') })
  assert.deepEqual(again.match(token), { kind: 'device', id })
  assert.equal(again.match(`${token}x`), null)
  assert.equal(again.legacyActive(), false, 'no legacy token unless one was there before')
})

test('unpair: a device revokes its own token, and its open WebSocket closes; the legacy token revokes nothing', async () => {
  const r = await start()
  const keep = await pairDevice(r, MAC_UA)
  const gone = await pairDevice(r)
  const ws = await wsOpen(r.port, gone.token)
  assert.ok('ws' in ws, JSON.stringify(ws))
  const shut = closed(ws.ws)
  const res = await call(r.port, 'POST', '/api/unpair', { token: gone.token })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { revoked: true })
  assert.equal(await shut, REVOKED_CLOSE)
  assert.equal((await call(r.port, 'GET', '/api/health', { token: gone.token })).status, 401)
  assert.equal((await call(r.port, 'POST', '/api/unpair', { token: gone.token })).status, 401, 'once revoked, it is a stranger')
  assert.deepEqual(r.devices.list().map(d => d.label), ['Chrome on Mac'], 'the other device is untouched')
  assert.equal((await call(r.port, 'GET', '/api/health', { token: keep.token })).status, 200)
  assert.ok(r.logs.includes(`pair: Quest browser (paired from 127.0.0.1) unpaired itself from 127.0.0.1`), r.logs.join('\n'))
  // The legacy token is shared by every browser that has it: nothing is revoked from here.
  const legacy = await call(r.port, 'POST', '/api/unpair', { token: LEGACY })
  assert.equal(legacy.status, 200)
  assert.deepEqual(legacy.body, { revoked: false, reason: `the legacy token is shared by every browser that has it; revoke it on the pairing page at https://localhost:${r.port}/pair` })
  assert.equal(r.devices.legacyActive(), true)
  assert.equal((await call(r.port, 'GET', '/api/health', { token: LEGACY })).status, 200)
  // The usual gate: no token, or another origin.
  assert.equal((await call(r.port, 'POST', '/api/unpair')).status, 401)
  assert.equal((await call(r.port, 'POST', '/api/unpair', { token: keep.token, headers: { origin: 'https://evil.example' } })).status, 403)
  assert.equal(r.devices.list().length, 1)
})

test('send: a device revoked while its request is arriving sends nothing, gets 401, and spends no send', async () => {
  const r = await start()
  const d = await pairDevice(r)
  const body = Buffer.from(JSON.stringify({ sessionId: 'demo-harbour', text: 'run the tests' }))
  const reply = new Promise<Reply>((ok, fail) => {
    const req = request(
      { host: '127.0.0.1', port: r.port, path: '/api/send', method: 'POST', rejectUnauthorized: false, headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', 'content-length': String(body.length) } },
      res => {
        let text = ''
        res.on('data', c => (text += c))
        res.on('end', () => ok({ status: res.statusCode ?? 0, body: JSON.parse(text), headers: res.headers }))
      },
    )
    req.on('error', fail)
    // Half the body: the gate has passed the token, and the route is waiting on the rest.
    req.write(body.subarray(0, 10))
    setTimeout(() => {
      assert.ok(r.devices.revoke(d.id))
      req.end(body.subarray(10))
    }, 150)
  })
  const res = await reply
  assert.equal(res.status, 401)
  assert.equal(res.body.error, 'pairing token missing, wrong or revoked')
  assert.deepEqual(r.backend.sent, [], 'nothing reached the backend')
  assert.ok(r.logs.includes('send: 127.0.0.1: the token was revoked while the request arrived; refused, nothing sent'), r.logs.join('\n'))
  // The bridge takes 3 sends a minute; the refused one took none of them.
  for (let i = 0; i < 3; i++) assert.equal((await call(r.port, 'POST', '/api/send', { token: LEGACY, body: { sessionId: 'demo-harbour', text: `go ${i}` } })).status, 200, `send ${i}`)
  assert.equal(r.backend.sent.length, 3)
})

test('logs: no code, token or poll secret appears in any line, across every test above', () => {
  assert.ok(allLogs.length > 20, `the tests logged (${allLogs.length} lines)`)
  assert.ok(secrets.size > 20, `codes and tokens were collected (${secrets.size})`)
  for (const line of allLogs) for (const s of secrets) assert.equal(line.includes(s), false, `a secret leaked into: ${line}`)
})
