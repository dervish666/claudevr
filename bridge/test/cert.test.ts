// The bridge CA: made once, signs the server certificate, survives a change
// of addresses, and is served at /api/pair/ca with its fingerprint on /pair.
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { caPaths, certPaths, certProblem, ensureCa, ensureCert, fingerprint, makeCert, sansOf, signedBy } from '../src/cert.ts'
import { createBridge, type Bridge } from '../src/server.ts'
import { FakeAdapter } from '../src/backend/fake.ts'

const FIX = join(import.meta.dirname, '..', '..', 'fixtures')
const quiet = () => {}
let root: string
const fresh = (name: string) => join(root, name)

before(() => {
  root = mkdtempSync(join(tmpdir(), 'claudevr-cert-'))
})
after(() => rmSync(root, { recursive: true, force: true }))

/** A TLS handshake to a server using `dir`'s server certificate, trusting only `caPem`, to host name `name`. */
async function handshake(dir: string, caPem: Buffer, name: string): Promise<string | null> {
  const p = certPaths(dir)
  const server = createServer({ cert: readFileSync(p.cert), key: readFileSync(p.key) }, (_q, s) => s.end('ok'))
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
  const port = (server.address() as AddressInfo).port
  try {
    return await new Promise<string | null>(ok => {
      const isIp = /^[\d.]+$/.test(name)
      const s = tlsConnect({ host: '127.0.0.1', port, ca: [caPem], ...(isIp ? {} : { servername: name }) }, () => {
        s.end()
        ok(null)
      })
      s.on('error', e => ok((e as NodeJS.ErrnoException).code ?? e.message))
    })
  } finally {
    server.close()
  }
}

test('first start: a CA (key 600) and a server certificate it signed', () => {
  const dir = fresh('first')
  const lines: string[] = []
  const c = ensureCert(dir, (...a) => lines.push(a.join(' ')), false, [], ['192.168.1.20'])
  const ca = caPaths(dir)
  assert.equal(statSync(ca.key).mode & 0o777, 0o600)
  assert.equal(statSync(certPaths(dir).key).mode & 0o777, 0o600)
  const caX = new X509Certificate(readFileSync(ca.cert))
  assert.equal(caX.ca, true)
  assert.equal(new X509Certificate(readFileSync(c.cert)).ca, false)
  assert.ok(signedBy(readFileSync(c.cert), readFileSync(ca.cert)))
  assert.deepEqual(c.names, ['localhost', '127.0.0.1', '192.168.1.20'])
  assert.equal(c.caFingerprint, caX.fingerprint256)
  assert.match(c.caFingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
  assert.ok(lines.some(l => l.includes('made the bridge CA')))
})

test('a restart with the same addresses changes nothing', () => {
  const dir = fresh('same')
  ensureCert(dir, quiet, false, [], ['192.168.1.20'])
  const before = [readFileSync(certPaths(dir).cert), readFileSync(caPaths(dir).cert)]
  ensureCert(dir, quiet, false, [], ['192.168.1.20'])
  assert.deepEqual([readFileSync(certPaths(dir).cert), readFileSync(caPaths(dir).cert)], before)
})

test('an address change reissues only the server certificate, and a client pinning the CA still connects', async () => {
  const dir = fresh('moved')
  ensureCert(dir, quiet, false, [], ['192.168.1.20'])
  const caPem = readFileSync(caPaths(dir).cert)
  const oldLeaf = readFileSync(certPaths(dir).cert)
  assert.equal(await handshake(dir, caPem, '127.0.0.1'), null)

  const lines: string[] = []
  const c = ensureCert(dir, (...a) => lines.push(a.join(' ')), false, [], ['10.0.0.9'])
  assert.deepEqual(readFileSync(caPaths(dir).cert), caPem, 'the CA must not change')
  assert.notDeepEqual(readFileSync(certPaths(dir).cert), oldLeaf, 'the server certificate must be new')
  assert.ok(sansOf(readFileSync(c.cert, 'utf8')).includes('10.0.0.9'))
  assert.ok(lines.some(l => l.includes('does not cover 10.0.0.9')))
  // The same pinned CA, the new server certificate, both by name and by IP SAN.
  assert.equal(await handshake(dir, caPem, '127.0.0.1'), null)
  assert.equal(await handshake(dir, caPem, 'localhost'), null)
})

test('extra names (certNames) are covered too', () => {
  const dir = fresh('names')
  const c = ensureCert(dir, quiet, false, ['studio.local'], [])
  assert.ok(c.names.includes('studio.local'))
})

test('migration: an old self-signed certificate is replaced by a CA-signed one on first start', async () => {
  const dir = fresh('migrate')
  makeCert(dir, ['localhost', '127.0.0.1']) // what bridges before the CA made
  const old = readFileSync(certPaths(dir).cert)
  assert.equal(existsSync(caPaths(dir).cert), false)
  const lines: string[] = []
  ensureCert(dir, (...a) => lines.push(a.join(' ')), false, [], [])
  const caPem = readFileSync(caPaths(dir).cert)
  assert.notDeepEqual(readFileSync(certPaths(dir).cert), old)
  assert.ok(signedBy(readFileSync(certPaths(dir).cert), caPem))
  assert.ok(lines.some(l => l.includes('not signed by the bridge CA')), lines.join('\n'))
  assert.equal(await handshake(dir, caPem, 'localhost'), null)
})

test('falsified: a server certificate from another CA is caught, and a client pinning our CA refuses it', async () => {
  const ours = fresh('ours')
  const theirs = fresh('theirs')
  ensureCert(ours, quiet, false, [], [])
  ensureCert(theirs, quiet, false, [], [])
  const ourCa = readFileSync(caPaths(ours).cert)
  // Their server certificate, under our file names.
  writeFileSync(certPaths(ours).cert, readFileSync(certPaths(theirs).cert))
  writeFileSync(certPaths(ours).key, readFileSync(certPaths(theirs).key))
  assert.equal(signedBy(readFileSync(certPaths(ours).cert), ourCa), false)
  assert.equal(certProblem(ours, ['localhost', '127.0.0.1'], Date.now(), ourCa), 'certificate is not signed by the bridge CA')
  // Without the CA check the same certificate passes, so the check above is what catches it.
  assert.equal(certProblem(ours, ['localhost', '127.0.0.1']), null)
  assert.equal(await handshake(ours, ourCa, 'localhost'), 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
  // And a name the certificate does not cover is refused even with the right CA.
  assert.equal(await handshake(theirs, readFileSync(caPaths(theirs).cert), 'elsewhere.example'), 'ERR_TLS_CERT_ALTNAME_INVALID')
})

test('a CA is never replaced behind the user\'s back: half a CA or a non-CA file is an error', () => {
  const dir = fresh('half')
  ensureCa(dir, quiet)
  unlinkSync(caPaths(dir).key)
  assert.throws(() => ensureCa(dir, quiet), /half a CA/)
  const dir2 = fresh('notca')
  makeCert(dir2, ['localhost'])
  writeFileSync(caPaths(dir2).cert, readFileSync(certPaths(dir2).cert))
  writeFileSync(caPaths(dir2).key, readFileSync(certPaths(dir2).key))
  assert.throws(() => ensureCa(dir2, quiet), /not a CA certificate/)
})

// ---------------------------------------------------------------- routes

test('GET /api/pair/ca serves the CA without a token; /api/pair/devices carries its fingerprint; other origins are refused', async () => {
  const dir = fresh('route')
  const c = ensureCert(dir, quiet, false, [], [])
  const caPem = readFileSync(c.ca, 'utf8')
  const fake = FakeAdapter.fromFixtures(FIX, { pollMs: 1000, log: quiet })
  const make = (withCa: boolean): Bridge =>
    createBridge({ backend: fake, allowIps: [], clientDir: dir, probeLog: join(dir, 'probe.log'), cert: readFileSync(c.cert), key: readFileSync(c.key), ...(withCa ? { caCert: caPem } : {}), sendsPerMinute: 5, sendsPerHour: 50, log: quiet })
  const bridge = make(true)
  const bare = make(false)
  await new Promise<void>(ok => bridge.server.listen(0, '127.0.0.1', ok))
  await new Promise<void>(ok => bare.server.listen(0, '127.0.0.1', ok))
  const get = (b: Bridge, path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; type: string; text: string }>((ok, fail) => {
      const port = (b.server.address() as AddressInfo).port
      // Verified against the CA it is about to fetch: the test checks the route, not trust on first use.
      const req = request({ host: '127.0.0.1', port, path, headers: { host: `localhost:${port}`, ...headers }, ca: [caPem], servername: 'localhost' }, res => {
        let text = ''
        res.on('data', d => (text += d))
        res.on('end', () => ok({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), text }))
      })
      req.on('error', fail)
      req.end()
    })
  try {
    const r = await get(bridge, '/api/pair/ca')
    assert.equal(r.status, 200)
    assert.equal(r.type, 'application/x-pem-file')
    assert.equal(r.text, caPem)
    assert.equal(fingerprint(r.text), c.caFingerprint)
    assert.doesNotMatch(r.text, /PRIVATE KEY/)

    const port = (bridge.server.address() as AddressInfo).port
    const d = await get(bridge, '/api/pair/devices')
    assert.equal(d.status, 200)
    assert.equal(JSON.parse(d.text).ca.sha256, c.caFingerprint)

    assert.equal((await get(bridge, '/api/pair/ca', { origin: 'https://evil.example' })).status, 403)
    assert.equal((await get(bridge, '/api/pair/ca', { origin: `https://localhost:${port}` })).status, 200)

    assert.equal((await get(bare, '/api/pair/ca')).status, 404)
    assert.equal(JSON.parse((await get(bare, '/api/pair/devices')).text).ca, null)
  } finally {
    await bridge.close()
    await bare.close()
    fake.close()
  }
})
