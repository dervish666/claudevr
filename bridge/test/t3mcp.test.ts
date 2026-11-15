// The T3 MCP client, the adapter's use of it, and the link flow, all against
// stub HTTP servers on random loopback ports. Nothing here reaches T3.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, statSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { T3Mcp, T3McpError, readLink, writeLink, removeLink, type T3Link } from '../src/backend/t3mcp.ts'
import { linkT3 } from '../src/backend/t3oauth.ts'
import { DashwebAdapter, type CommandRunner, type Fetcher } from '../src/backend/dashweb/adapter.ts'

const TOKEN = 'tok-SECRET-test-0123456789abcdef'
const THREAD = 'thread-0001'
const FIX = join(import.meta.dirname, '..', '..', 'fixtures')
const BOARD = JSON.parse(readFileSync(join(FIX, 'board.json'), 'utf8'))
const T3 = JSON.parse(readFileSync(join(FIX, 't3.json'), 'utf8'))
const BUSY = 'b2e07a6c-d1fe-cc87-ac1e-f2aefa7b9949'
const BUSY_THREAD = 'afd5b10a-0619-956e-9bc7-1cc3dddc115c'

const dir = mkdtempSync(join(tmpdir(), 'claudevr-t3mcp-'))
after(() => rmSync(dir, { recursive: true, force: true }))

/** Every log line and error message the code under test produced; none may hold the token. */
const seen: string[] = []
const log = (...a: unknown[]) => seen.push(a.map(String).join(' '))
after(() => {
  for (const line of seen) assert.ok(!line.includes(TOKEN), `token leaked into: ${line}`)
})

let n = 0
function linkFile(over: Partial<T3Link> = {}, origin = 'http://127.0.0.1:1'): string {
  const file = join(dir, `link-${n++}.json`)
  writeLink(file, { version: 1, origin, clientId: 'client-x', clientName: 'ClaudeVR bridge', accessToken: TOKEN, scope: 'orchestration:read orchestration:operate', linkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), ...over })
  return file
}

/** Answers tools/call on `res`; a reply that never writes leaves the request hanging. */
type Reply = (msg: { id?: number; method?: string; params?: any }, req: IncomingMessage, res: ServerResponse) => unknown

/** A stub of T3's /mcp. `onCall` answers tools/call; the handshake is answered here. */
async function stubMcp(onCall: Reply, opts: { sse?: boolean; status?: number; sessionId?: string } = {}) {
  const requests: { method: string; headers: IncomingMessage['headers']; body: any }[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', c => (raw += c))
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null
      requests.push({ method: req.method!, headers: req.headers, body })
      if (req.method === 'DELETE') return void res.writeHead(200).end()
      if (opts.status) return void res.writeHead(opts.status, { 'content-type': 'application/json' }).end('{"error":"invalid_mcp_credential"}')
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end()
      const send = (payload: unknown) => {
        const headers: Record<string, string> = { 'content-type': opts.sse ? 'text/event-stream' : 'application/json' }
        if (opts.sessionId) headers['mcp-session-id'] = opts.sessionId
        res.writeHead(200, headers)
        res.end(opts.sse ? `: keep-alive\n\nevent: message\ndata: ${JSON.stringify(payload)}\n\n` : JSON.stringify(payload))
      }
      if (body.method === 'initialize') return send({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '0' } } })
      if (body.method === 'notifications/initialized') return void res.writeHead(202).end()
      if (body.method === 'tools/call') return void onCall(body, req, res)
      send({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'no such method' } })
    })
  })
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  after(() => {
    server.closeAllConnections()
    server.close()
  })
  return { origin, requests }
}

const result = (delivery: string) => (msg: any, _req: IncomingMessage, res: ServerResponse) => {
  const structuredContent = { threadId: msg.params.arguments.threadId, messageId: 'm1', runId: 'run-7', status: 'running', delivery }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent } }))
}

const client = (file: string, origin: string, more: Partial<ConstructorParameters<typeof T3Mcp>[0]> = {}) => new T3Mcp({ linkFile: file, origin: () => origin, log, ...more })

async function rejectsWith(p: Promise<unknown>, kind: string, maybeDelivered: boolean) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof T3McpError, String(err))
    seen.push(err.message)
    assert.equal(err.kind, kind)
    assert.equal(err.maybeDelivered, maybeDelivered)
    return true
  })
}

test('handshake: initialize, initialized, then t3_thread_send in auto mode with the session header and version', async () => {
  const stub = await stubMcp(result('started'), { sessionId: 'sess-42' })
  const r = await client(linkFile({}, stub.origin), stub.origin).send(THREAD, '  run the tests\n', 'req-1')
  assert.deepEqual(r, { delivery: 'started', runId: 'run-7' })
  await new Promise(ok => setTimeout(ok, 20))
  const posts = stub.requests.filter(q => q.method === 'POST')
  assert.deepEqual(posts.map(q => q.body.method), ['initialize', 'notifications/initialized', 'tools/call'])
  assert.equal(posts[0]!.headers['mcp-session-id'], undefined)
  for (const q of posts.slice(1)) {
    assert.equal(q.headers['mcp-session-id'], 'sess-42')
    assert.equal(q.headers['mcp-protocol-version'], '2025-06-18')
  }
  for (const q of posts) {
    assert.equal(q.headers.authorization, `Bearer ${TOKEN}`)
    assert.match(String(q.headers.accept), /application\/json/)
    assert.match(String(q.headers.accept), /text\/event-stream/)
  }
  // Exactly one tool, one mode, and the text untouched.
  assert.deepEqual(posts[2]!.body.params, { name: 't3_thread_send', arguments: { threadId: THREAD, message: '  run the tests\n', mode: 'auto', clientRequestId: 'req-1' } })
  // The session is ended afterwards, as T3's own client does.
  assert.equal(stub.requests.at(-1)!.method, 'DELETE')
  assert.equal(stub.requests.at(-1)!.headers['mcp-session-id'], 'sess-42')
})

test('an event-stream reply is read as well as a JSON one', async () => {
  const stub = await stubMcp((msg, _req, res) => {
    const structuredContent = { delivery: 'steered', runId: 'run-9' }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\n`)
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { structuredContent } })}\n\n`)
  }, { sse: true })
  assert.deepEqual(await client(linkFile({}, stub.origin), stub.origin).send(THREAD, 'hi', 'r'), { delivery: 'steered', runId: 'run-9' })
})

test('a thread id outside the shared rule is refused before any request', async () => {
  const stub = await stubMcp(result('started'))
  await rejectsWith(client(linkFile({}, stub.origin), stub.origin).send('--flag', 'hi', 'r'), 'tool', false)
  assert.equal(stub.requests.length, 0)
})

test('no link file, or one past its expiry: not-linked and expired, nothing sent', async () => {
  const stub = await stubMcp(result('started'))
  await rejectsWith(client(join(dir, 'missing.json'), stub.origin).send(THREAD, 'hi', 'r'), 'not-linked', false)
  await rejectsWith(client(linkFile({ expiresAt: new Date(Date.now() - 1000).toISOString() }, stub.origin), stub.origin).send(THREAD, 'hi', 'r'), 'expired', false)
  assert.equal(stub.requests.length, 0)
})

test('401 from T3 is "expired" and not delivered', async () => {
  const stub = await stubMcp(result('started'), { status: 401 })
  await rejectsWith(client(linkFile({}, stub.origin), stub.origin).send(THREAD, 'hi', 'r'), 'expired', false)
})

test('a closed port is "unreachable" and not delivered', async () => {
  const stub = await stubMcp(result('started'))
  const closed = 'http://127.0.0.1:9'
  await rejectsWith(client(linkFile({}, stub.origin), closed).send(THREAD, 'hi', 'r'), 'unreachable', false)
})

test('no answer to the send in time is a timeout that may have been delivered', async () => {
  const stub = await stubMcp(() => 'hang')
  await rejectsWith(client(linkFile({}, stub.origin), stub.origin, { callTimeoutMs: 150 }).send(THREAD, 'hi', 'r'), 'timeout', true)
})

test('a connection dropped mid-answer is "unknown" and may have been delivered', async () => {
  const stub = await stubMcp((_msg, req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(': working\n\n')
    setTimeout(() => req.socket.destroy(), 20)
  })
  await rejectsWith(client(linkFile({}, stub.origin), stub.origin).send(THREAD, 'hi', 'r'), 'unknown', true)
})

test("T3's tool failures carry its message; a mode refusal is 'denied'", async () => {
  const fail = (code: string, message: string) => (msg: any, _req: IncomingMessage, res: ServerResponse) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message }) }] } }))
  const a = await stubMcp(fail('thread_not_found', 'Thread thread-0001 was not found.'))
  await assert.rejects(client(linkFile({}, a.origin), a.origin).send(THREAD, 'hi', 'r'), (e: T3McpError) => e.kind === 'tool' && /was not found/.test(e.message) && !e.maybeDelivered)
  const b = await stubMcp(fail('runtime_mode_escalation_denied', 'Child runtime mode full-access is broader than parent mode auto.'))
  await rejectsWith(client(linkFile({}, b.origin), b.origin).send(THREAD, 'hi', 'r'), 'denied', false)
})

test('the link file is written owner-only, read back, and removed', () => {
  const file = linkFile()
  assert.equal(statSync(file).mode & 0o777, 0o600)
  // Rewriting keeps it owner-only even if it was opened up in between.
  writeFileSync(file, readFileSync(file), { mode: 0o644 })
  writeLink(file, readLink(file)!)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(readLink(file)!.accessToken, TOKEN)
  assert.equal(removeLink(file), true)
  assert.equal(removeLink(file), false)
})

test('a broken link file is reported without quoting it', () => {
  const file = join(dir, 'broken.json')
  writeFileSync(file, `{"accessToken": "${TOKEN}", oops`)
  assert.throws(() => readLink(file), (e: T3McpError) => {
    seen.push(e.message)
    return e.kind === 'not-linked'
  })
})

// The adapter: MCP first, the CLI only when the MCP send surely did not land.

const cfg = { url: 'http://dashweb.test', t3Bin: '/opt/t3/bin/t3', t3BaseDir: '/opt/t3home', pollMs: 50 }
const board: Fetcher = async url => {
  const r = ({ '/api/board': BOARD, '/api/t3': T3 } as Record<string, unknown>)[new URL(url).pathname]
  return r ? { ok: true, status: 200, json: async () => structuredClone(r) } : { ok: false, status: 404, json: async () => ({}) }
}
function cli(): { run: CommandRunner; calls: string[] } {
  const calls: string[] = []
  return { calls, run: async (_f, _a, input) => (calls.push(input), 'Queued.\n') }
}
async function adapter(t3: T3Mcp, more: Record<string, unknown> = {}) {
  const r = cli()
  const a = new DashwebAdapter({ ...cfg, ...more }, { fetch: board, run: r.run, log, t3mcp: t3 })
  await a.list()
  return { a, calls: r.calls }
}

test('each delivery kind reads as plain words, and the CLI is not run', async () => {
  const said = { started: 'Started.', steered: 'Went straight in.', queued: 'Queued behind the current turn.', restarted: 'Restarted the turn with it.' }
  for (const [delivery, words] of Object.entries(said)) {
    const stub = await stubMcp(result(delivery))
    const { a, calls } = await adapter(client(linkFile({}, stub.origin), stub.origin))
    assert.deepEqual(await a.send(BUSY, 'go'), { ok: true, said: words })
    assert.deepEqual(calls, [])
    const call = stub.requests.find(q => q.body?.method === 'tools/call')!
    assert.equal(call.body.params.arguments.threadId, BUSY_THREAD)
    assert.match(call.body.params.arguments.clientRequestId, /^[0-9a-f-]{36}$/)
  }
})

test('401: falls back to the CLI once and warns on the fleet until a send works', async () => {
  const stub = await stubMcp(result('started'), { status: 401 })
  const { a, calls } = await adapter(client(linkFile({}, stub.origin), stub.origin))
  assert.deepEqual(await a.send(BUSY, 'go'), { ok: true, said: 'Queued.' })
  assert.deepEqual(calls, ['go'])
  const warnings = (await a.list()).warnings.filter(w => /T3 link/.test(w))
  assert.deepEqual(warnings, ['T3 link expired: messages will queue. Run npm run t3-link.'])
  await a.send(BUSY, 'again')
  assert.equal((await a.list()).warnings.filter(w => /T3 link/.test(w)).length, 1)
})

test('no link: the CLI queues and the fleet says why', async () => {
  const { a, calls } = await adapter(client(join(dir, 'never.json'), 'http://127.0.0.1:9'))
  await a.send(BUSY, 'go')
  assert.deepEqual(calls, ['go'])
  assert.ok((await a.list()).warnings.includes('Not linked to T3: messages will queue. Run npm run t3-link.'))
})

test('an expired link is on the fleet from the start', async () => {
  const { a } = await adapter(client(linkFile({ expiresAt: new Date(Date.now() - 1).toISOString() }), 'http://127.0.0.1:9'))
  assert.ok((await a.list()).warnings.includes('T3 link expired: messages will queue. Run npm run t3-link.'))
})

test('timeout after the send went out: outcome unknown and NO fallback to the CLI', async () => {
  const stub = await stubMcp(() => 'hang')
  const { a, calls } = await adapter(client(linkFile({}, stub.origin), stub.origin, { callTimeoutMs: 150 }))
  await assert.rejects(a.send(BUSY, 'go'), (e: Error) => {
    seen.push(e.message)
    return /not known whether T3 got the message/.test(e.message)
  })
  assert.deepEqual(calls, [])
})

test("T3 refusing the send itself is an error, not a CLI retry", async () => {
  const stub = await stubMcp((msg, _req, res) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'invalid_request', message: 'nope' }) }] } })),
  )
  const { a, calls } = await adapter(client(linkFile({}, stub.origin), stub.origin))
  await assert.rejects(a.send(BUSY, 'go'), /nope/)
  assert.deepEqual(calls, [])
})

test('t3.delivery "queue" never touches MCP', async () => {
  const stub = await stubMcp(result('started'))
  const { a, calls } = await adapter(client(linkFile({}, stub.origin), stub.origin), { t3Delivery: 'queue' })
  await a.send(BUSY, 'go')
  assert.deepEqual(calls, ['go'])
  assert.equal(stub.requests.length, 0)
})

// The link flow, with a stub authorization server and a "browser" that follows redirects.

async function stubAuth(opts: { tamperState?: boolean } = {}) {
  const seenReq: Record<string, any> = {}
  let challenge = ''
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', c => (raw += c))
    req.on('end', () => {
      const url = new URL(req.url!, origin)
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return void res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({ issuer: origin, authorization_endpoint: `${origin}/oauth/mcp/authorize`, token_endpoint: `${origin}/oauth/mcp/token`, registration_endpoint: `${origin}/oauth/mcp/register`, code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code'] }),
        )
      }
      if (url.pathname === '/oauth/mcp/register') {
        seenReq.register = JSON.parse(raw)
        return void res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ client_id: 'signed-client', client_name: seenReq.register.client_name, redirect_uris: seenReq.register.redirect_uris }))
      }
      if (url.pathname === '/oauth/mcp/authorize') {
        seenReq.authorize = Object.fromEntries(url.searchParams)
        challenge = url.searchParams.get('code_challenge')!
        const back = new URL(url.searchParams.get('redirect_uri')!)
        back.searchParams.set('code', 'the-code')
        back.searchParams.set('state', opts.tamperState ? 'forged' : url.searchParams.get('state')!)
        back.searchParams.set('iss', origin)
        return void res.writeHead(302, { location: back.href }).end()
      }
      if (url.pathname === '/oauth/mcp/token') {
        const p = new URLSearchParams(raw)
        seenReq.token = Object.fromEntries(p)
        const ok = p.get('code') === 'the-code' && createHash('sha256').update(p.get('code_verifier')!).digest('base64url') === challenge
        if (!ok) return void res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_grant', error_description: 'The authorization code is invalid or expired.' }))
        return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: TOKEN, token_type: 'Bearer', expires_in: 2_592_000, scope: 'orchestration:read orchestration:operate' }))
      }
      res.writeHead(404).end()
    })
  })
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  after(() => {
    server.closeAllConnections()
    server.close()
  })
  return { origin, seenReq }
}

test('link flow: register, authorize with PKCE and state, take the callback, store the token 0600, never say it', async () => {
  const auth = await stubAuth()
  const file = join(dir, 'flow.json')
  const said: string[] = []
  let page = ''
  const out = await linkT3({
    origin: auth.origin,
    linkFile: file,
    say: l => said.push(l),
    openUrl: async url => {
      // The "browser": follows T3's redirect to the bridge's loopback callback.
      page = await (await fetch(url)).text()
    },
  })
  assert.match(page, /ClaudeVR is linked/)
  assert.equal(auth.seenReq.register.client_name, 'ClaudeVR bridge')
  assert.match(auth.seenReq.register.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
  assert.equal(auth.seenReq.authorize.code_challenge_method, 'S256')
  assert.equal(auth.seenReq.authorize.resource, `${auth.origin}/mcp`)
  assert.equal(auth.seenReq.token.grant_type, 'authorization_code')
  assert.equal(statSync(file).mode & 0o777, 0o600)
  const link = readLink(file)!
  assert.equal(link.accessToken, TOKEN)
  assert.equal(link.clientId, 'signed-client')
  assert.ok(out.expiresAt && Math.abs(Date.parse(out.expiresAt) - Date.now() - 2_592_000_000) < 60_000)
  for (const l of said) assert.ok(!l.includes(TOKEN), l)
  assert.ok(said.some(l => /Full access/.test(l)))
})

test('link flow: a callback with the wrong state is refused and nothing is stored', async () => {
  const auth = await stubAuth({ tamperState: true })
  const file = join(dir, 'forged.json')
  let status = 0
  await assert.rejects(
    linkT3({
      origin: auth.origin,
      linkFile: file,
      say: () => {},
      approvalTimeoutMs: 300,
      openUrl: async url => {
        status = (await fetch(url)).status
      },
    }),
    /no approval within/,
  )
  assert.equal(status, 400)
  assert.equal(auth.seenReq.token, undefined)
  assert.equal(existsSync(file), false)
})

test('link flow: endpoints on another origin are refused', async () => {
  const server = createServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ issuer: 'x', authorization_endpoint: 'https://evil.example/a', token_endpoint: 'https://evil.example/t', registration_endpoint: 'https://evil.example/r', code_challenge_methods_supported: ['S256'] })),
  )
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
  after(() => server.close())
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  await assert.rejects(linkT3({ origin, linkFile: join(dir, 'evil.json'), say: () => {}, openUrl: () => {} }), /refusing to link/)
})
