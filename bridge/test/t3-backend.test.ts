// The t3 backend against a stub of T3's /mcp on a random loopback port, the
// same stub shape as t3mcp.test.ts. Nothing here reaches T3.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { T3Mcp, T3McpError, writeLink, type T3Link } from '../src/backend/t3mcp.ts'
import { T3Adapter } from '../src/backend/t3/adapter.ts'
import { SendRefused } from '../src/backend/types.ts'
import { loadConfig } from '../src/config.ts'

const TOKEN = 'tok-SECRET-t3backend-0123456789'
const dir = mkdtempSync(join(tmpdir(), 'claudevr-t3backend-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const seen: string[] = []
const log = (...a: unknown[]) => seen.push(a.map(String).join(' '))
after(() => {
  for (const line of seen) assert.ok(!line.includes(TOKEN), `token leaked into: ${line}`)
})

let n = 0
function linkFile(origin: string, over: Partial<T3Link> = {}): string {
  const file = join(dir, `link-${n++}.json`)
  writeLink(file, { version: 1, origin, clientId: 'c', clientName: 'ClaudeVR bridge', accessToken: TOKEN, scope: 'orchestration:read orchestration:operate', linkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), ...over })
  return file
}

const NOW = Date.parse('2026-11-16T19:00:00.000Z')
const iso = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString()

const MAIN = 'e71e9f41-52d7-494c-bdaa-5687cf3fdd36'
const GT = 'mcp:2323a822-893a-4a9c-ab29-e13b8bf2ea69'
const WAITS = '11111111-2222-4333-8444-555555555555'
const OLD = '99999999-2222-4333-8444-555555555555'
const SNOOZED = '88888888-2222-4333-8444-555555555555'
const SUB = `thread:provider:claudeAgent:native-thread:${'x'.repeat(220)}`
const SUB2 = `thread:provider:claudeAgent:native-thread:${'y'.repeat(220)}`
const SUBSUB = `thread:provider:claudeAgent:native-thread:${'z'.repeat(220)}`

const row = (threadId: string, over: Record<string, unknown> = {}) => ({
  threadId,
  projectId: 'p-vr',
  title: 'a thread',
  link: `[a thread](t3-thread://v2/env/${threadId})`,
  status: 'idle',
  providerInstanceId: 'claudeAgent',
  model: 'claude-opus-5-5',
  settled: false,
  snoozed: false,
  parentThreadId: null,
  relationshipToParent: null,
  itemCount: 66,
  createdAt: iso(60),
  updatedAt: iso(1),
  ...over,
})

const THREADS = [
  row(SUB, { title: 'Build T3 MCP backend', parentThreadId: MAIN, relationshipToParent: 'subagent', status: 'running', updatedAt: iso(0) }),
  row(MAIN, { title: 'Make ClaudeVR Public', status: 'running', createdAt: iso(10) }),
  row(SUBSUB, { title: 'nested helper', parentThreadId: SUB, relationshipToParent: 'subagent', status: 'idle', updatedAt: iso(2) }),
  row(GT, { title: 'T-422 gt: management session', projectId: 'p-gt', status: 'completed', updatedAt: iso(10) }),
  row(SUB2, { title: 'Run full GT session', parentThreadId: GT, relationshipToParent: 'subagent', status: 'idle', updatedAt: iso(11) }),
  row(SNOOZED, { title: 'hush', status: 'idle', snoozed: true, updatedAt: iso(20) }),
  row(OLD, { title: 'last week', status: 'completed', updatedAt: iso(60 * 24 * 7) }),
]
const LIVE = [row(MAIN, { title: 'Make ClaudeVR Public', status: 'running', createdAt: iso(10) }), row(WAITS, { title: 'Pick a colour', projectId: 'p-vr', status: 'waiting', updatedAt: iso(60 * 30) })]
const PROJECTS = [
  { id: 'p-vr', title: 'ClaudeVR' },
  { id: 'p-gt', title: 'GalacticTycoons' },
]

type Call = { name: string; args: any }
type Handler = (call: Call, msg: any, res: ServerResponse, req: IncomingMessage) => unknown

const ok = (msg: any, res: ServerResponse, structuredContent: unknown) =>
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent } }))

/** Answers the read tools from the tables above; `over` can take any call first. */
const t3Answers =
  (over?: Handler): Handler =>
  (call, msg, res, req) => {
    if (over && over(call, msg, res, req) !== undefined) return
    if (call.name === 't3_thread_list') return ok(msg, res, { projectId: null, threads: call.args.statuses ? LIVE : THREADS, nextCursor: null, total: THREADS.length })
    if (call.name === 't3_project_list') return ok(msg, res, { projects: PROJECTS, nextCursor: null })
    if (call.name === 't3_thread_read')
      return ok(msg, res, {
        thread: { threadId: call.args.threadId },
        items: [
          { position: 40, type: 'user_message', text: 'run the tests', textTruncated: false },
          { position: 44, type: 'assistant_message', text: 'Tests pass: 386 of 386.', textTruncated: false },
          { position: 50, type: 'assistant_message', text: 'Which colour do you want?', textTruncated: false },
        ],
        nextPosition: 50,
        hasMore: false,
      })
    if (call.name === 't3_thread_send') return ok(msg, res, { threadId: call.args.threadId, messageId: 'm', runId: 'r', status: 'running', delivery: 'steered' })
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'unknown_tool', message: 'no' }) }] } }))
  }

async function stubMcp(onCall: Handler, opts: { status?: number } = {}) {
  const calls: Call[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', c => (raw += c))
    req.on('end', () => {
      if (req.method === 'DELETE') return void res.writeHead(200).end()
      if (opts.status) return void res.writeHead(opts.status).end()
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end()
      const body = JSON.parse(raw)
      const reply = (p: unknown) => res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's-1' }).end(JSON.stringify(p))
      if (body.method === 'initialize') return reply({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '0' } } })
      if (body.method === 'notifications/initialized') return void res.writeHead(202).end()
      if (body.method === 'tools/call') {
        const call = { name: body.params.name, args: body.params.arguments }
        calls.push(call)
        return void onCall(call, body, res, req)
      }
      reply({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'no such method' } })
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  after(() => {
    server.closeAllConnections()
    server.close()
  })
  return { origin, calls }
}

const cfg = { t3BaseDir: '/nonexistent-t3-home', pollMs: 50, activeHours: 24, t3LinkFile: '' }
function adapter(origin: string, file: string, more: { now?: () => number; callTimeoutMs?: number } = {}) {
  const t3mcp = new T3Mcp({ linkFile: file, origin: () => origin, log, callTimeoutMs: more.callTimeoutMs })
  return new T3Adapter({ ...cfg, t3LinkFile: file }, { t3mcp, log, now: more.now ?? (() => NOW) })
}

test('declares list, subscribe, send, pending and transcript', async () => {
  const a = new T3Adapter({ ...cfg, t3LinkFile: join(dir, 'none.json') }, { log })
  assert.deepEqual(a.capabilities, { list: true, subscribe: true, send: true, pending: true, interrupt: false, respond: false, approve: false, transcript: true })
})

test('fleet: top-level threads are sessions, sub-agents fold into their parent, old and snoozed threads stay out', async () => {
  const stub = await stubMcp(t3Answers())
  const fleet = await adapter(stub.origin, linkFile(stub.origin)).list()
  const ids = fleet.sessions.map(s => s.id)
  assert.deepEqual(ids.sort(), [MAIN, GT, WAITS].sort())
  const main = fleet.sessions.find(s => s.id === MAIN)!
  assert.equal(main.state, 'working')
  assert.equal(main.project, 'ClaudeVR')
  assert.equal(main.kind, 'T3 claudeAgent')
  assert.equal(main.canSend, true)
  assert.equal(main.context, null)
  // The sub-agent and the one it started, both under the top-level thread.
  assert.deepEqual(main.agents!.map(a => [a.description, a.state, a.depth]), [['Build T3 MCP backend', 'running', 1], ['nested helper', 'done', 2]])
  for (const a of main.agents!) assert.ok(a.id.length <= 80)
  const gt = fleet.sessions.find(s => s.id === GT)!
  assert.equal(gt.state, 'done')
  assert.equal(gt.project, 'GalacticTycoons')
  assert.deepEqual(gt.agents!.map(a => a.description), ['Run full GT session'])
  // Running threads get their latest line; a finished one is not read.
  assert.equal(main.lastLine, 'Which colour do you want?')
  assert.equal(gt.lastLine, null)
  const reads = stub.calls.filter(c => c.name === 't3_thread_read').map(c => c.args.threadId)
  assert.deepEqual(reads.sort(), [MAIN, WAITS].sort())
  assert.deepEqual(fleet.usage.limits.value, null)
  assert.match(fleet.usage.limits.note!, /T3 does not report/)
  assert.equal(fleet.usage.todayUsd.value, null)
  // Only read tools were called.
  assert.deepEqual([...new Set(stub.calls.map(c => c.name))].sort(), ['t3_project_list', 't3_thread_list', 't3_thread_read'])
  const listArgs = stub.calls.find(c => c.name === 't3_thread_list')!.args
  assert.deepEqual(listArgs, { allProjects: true, includeSubagents: true, settled: false, limit: 100 })
})

test('waiting: the session is asking and its question is a need, even past the activity window', async () => {
  const stub = await stubMcp(t3Answers())
  const fleet = await adapter(stub.origin, linkFile(stub.origin)).list()
  const s = fleet.sessions.find(x => x.id === WAITS)!
  assert.equal(s.state, 'asking')
  assert.equal(s.asking!.text, 'Which colour do you want?')
  assert.equal(s.asking!.answerAt, `t3-thread://v2/env/${WAITS}`)
  const need = fleet.needs.find(x => x.sessionId === WAITS)!
  assert.equal(need.kind, 'question')
  assert.equal(need.callsign, s.callsign)
  assert.equal(fleet.needs.length, 1)
})

test('project names are read once a minute, not every poll', async () => {
  const stub = await stubMcp(t3Answers())
  let now = NOW
  const a = adapter(stub.origin, linkFile(stub.origin), { now: () => now })
  await a.list()
  now += 2_000
  await a.list()
  assert.equal(stub.calls.filter(c => c.name === 't3_project_list').length, 1)
  now += 61_000
  await a.list()
  assert.equal(stub.calls.filter(c => c.name === 't3_project_list').length, 2)
})

test('no link: list fails with a readable error naming the fix, and nothing is asked of T3', async () => {
  const stub = await stubMcp(t3Answers())
  const a = adapter(stub.origin, join(dir, 'missing.json'))
  await assert.rejects(a.list(), (e: Error) => /Not linked to T3/.test(e.message) && /npm run t3-link/.test(e.message))
  assert.equal(stub.calls.length, 0)
  await assert.rejects(a.send(MAIN, 'hi'), SendRefused)
})

test('an expired link, or T3 refusing it, fails the read with the fix', async () => {
  const stub = await stubMcp(t3Answers())
  await assert.rejects(adapter(stub.origin, linkFile(stub.origin, { expiresAt: new Date(NOW - 1000).toISOString() })).list(), /expired.*npm run t3-link/)
  const refused = await stubMcp(t3Answers(), { status: 401 })
  await assert.rejects(adapter(refused.origin, linkFile(refused.origin)).list(), /refused.*npm run t3-link/)
})

test('send goes over t3_thread_send with a UUID request id and says how it landed', async () => {
  const stub = await stubMcp(t3Answers())
  const a = adapter(stub.origin, linkFile(stub.origin))
  await a.list()
  assert.deepEqual(await a.send(MAIN, 'run the tests', 'card-1'), { ok: true, said: 'Went straight in.' })
  const send = stub.calls.find(c => c.name === 't3_thread_send')!
  assert.equal(send.args.threadId, MAIN)
  assert.equal(send.args.mode, 'auto')
  assert.match(send.args.clientRequestId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('send is refused, nothing sent, before a read, after a failed read and once the read is stale', async () => {
  const stub = await stubMcp(t3Answers())
  let now = NOW
  let fail = false
  const flaky = await stubMcp(t3Answers(call => (fail && call.name === 't3_thread_list' ? 'hang' : undefined)))
  const a = adapter(stub.origin, linkFile(stub.origin), { now: () => now })
  await assert.rejects(a.send(MAIN, 'hi'), (e: SendRefused) => e instanceof SendRefused && e.status === 404)
  await a.list()
  now += 61_000
  await assert.rejects(a.send(MAIN, 'hi'), (e: SendRefused) => e instanceof SendRefused && e.status === 409 && /s old/.test(e.message))
  assert.equal(stub.calls.filter(c => c.name === 't3_thread_send').length, 0)

  const b = adapter(flaky.origin, linkFile(flaky.origin), { callTimeoutMs: 150 })
  await b.list()
  fail = true
  await assert.rejects(b.list())
  await assert.rejects(b.send(MAIN, 'hi'), (e: SendRefused) => e instanceof SendRefused && e.status === 409 && /last fleet read failed/.test(e.message))
  assert.equal(flaky.calls.filter(c => c.name === 't3_thread_send').length, 0)
})

test('sub-agents and unknown ids cannot be sent to; empty and long texts are refused', async () => {
  const stub = await stubMcp(t3Answers())
  const a = adapter(stub.origin, linkFile(stub.origin))
  await a.list()
  await assert.rejects(a.send(SUB, 'hi'), SendRefused)
  await assert.rejects(a.send(MAIN, '   '), (e: SendRefused) => e.status === 400)
  await assert.rejects(a.send(MAIN, 'x'.repeat(4001)), (e: SendRefused) => e.status === 400)
})

test('a send that timed out is unknown and not retried; a link refusal goes on the fleet', async () => {
  let mode: 'hang' | 'deny' = 'hang'
  const deny = (msg: any, res: ServerResponse) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'runtime_mode_escalation_denied', message: 'too broad' }) }] } }))
  const stub = await stubMcp(t3Answers((call, msg, res) => (call.name === 't3_thread_send' ? (mode === 'hang' ? 'hang' : deny(msg, res)) : undefined)))
  const a = adapter(stub.origin, linkFile(stub.origin), { callTimeoutMs: 150 })
  await a.list()
  await assert.rejects(a.send(MAIN, 'go'), (e: Error) => !(e instanceof SendRefused) && /not known whether T3 got the message/.test(e.message))
  assert.equal(stub.calls.filter(c => c.name === 't3_thread_send').length, 1)
  mode = 'deny'
  await assert.rejects(a.send(MAIN, 'go'), (e: SendRefused) => e instanceof SendRefused && e.status === 502)
  assert.ok((await a.list()).warnings.some(w => /Full access/.test(w) && /npm run t3-link/.test(w)))
})

test('transcript: messages view near the end, roles mapped, T3-cut text marked clipped', async () => {
  const stub = await stubMcp(
    t3Answers((call, msg, res) => {
      if (call.name !== 't3_thread_read' || call.args.maxCharsPerItem !== 12_000) return undefined
      return ok(msg, res, {
        items: [
          { position: 1, type: 'user_message', text: 'hello', textTruncated: false },
          { position: 2, type: 'assistant_message', text: 'a long answer', textTruncated: true },
          { position: 3, type: 'proposed_plan', text: 'the plan', textTruncated: false },
          { position: 4, type: 'assistant_message', text: '   ', textTruncated: false },
        ],
        nextPosition: 4,
        hasMore: false,
      })
    }),
  )
  const a = adapter(stub.origin, linkFile(stub.origin))
  await a.list()
  const t = await a.transcript(GT, 12)
  assert.deepEqual(t.turns, [
    { role: 'you', text: 'hello', clipped: false },
    { role: 'session', text: 'a long answer…', clipped: true },
    { role: 'other', text: 'the plan', clipped: false },
  ])
  const read = stub.calls.filter(c => c.name === 't3_thread_read' && c.args.threadId === GT).at(-1)!
  assert.equal(read.args.view, 'messages')
  assert.ok(read.args.limit <= 50)
  assert.equal(read.args.maxCharsPerItem, 12_000)
  assert.deepEqual((await a.transcript(GT, 1)).turns.map(x => x.text), ['the plan'])
  await assert.rejects(a.transcript('nope', 5), SendRefused)
})

test('reads are never flagged maybeDelivered: timeout, dropped connection, 500 and a tool error', async () => {
  const cases: Handler[] = [
    () => 'hang',
    (_c, _m, res, req) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': working\n\n')
      setTimeout(() => req.socket.destroy(), 20)
    },
    (_c, _m, res) => res.writeHead(500).end(),
    (_c, msg, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { isError: true, content: [{ type: 'text', text: '{"code":"thread_not_found","message":"gone"}' }] } })),
  ]
  for (const handler of cases) {
    const stub = await stubMcp(handler)
    const client = new T3Mcp({ linkFile: linkFile(stub.origin), origin: () => stub.origin, log, callTimeoutMs: 150 })
    await assert.rejects(
      client.reads(call => call('t3_thread_list', { limit: 1 })),
      (e: unknown) => {
        assert.ok(e instanceof T3McpError, String(e))
        seen.push(e.message)
        assert.equal(e.maybeDelivered, false, e.message)
        return true
      },
    )
  }
})

test('reads reach only the read-only tools, all in one MCP session', async () => {
  const stub = await stubMcp(t3Answers())
  const client = new T3Mcp({ linkFile: linkFile(stub.origin), origin: () => stub.origin, log })
  await client.reads(async call => {
    await call('t3_thread_list', {})
    await call('t3_project_list', {})
    await assert.rejects(call('t3_thread_send' as never, { threadId: MAIN, message: 'x' }), T3McpError)
  })
  assert.deepEqual(stub.calls.map(c => c.name), ['t3_thread_list', 't3_project_list'])
})

test('config: backend t3 with its poll, window and T3 home', () => {
  const env = { CLAUDEVR_CONFIG: join(dir, 'no-config.json'), CLAUDEVR_BACKEND: 't3', CLAUDEVR_STATE_DIR: dir }
  const c = loadConfig(env)
  assert.equal(c.backend, 't3')
  assert.deepEqual(c.t3, { t3BaseDir: join(homedir(), '.t3'), pollMs: 2000, activeHours: 24, t3LinkFile: join(dir, 't3-link.json') })
  assert.equal(c.dashweb, null)
  const d = loadConfig({ ...env, CLAUDEVR_T3_POLL_MS: '3000', CLAUDEVR_T3_ACTIVE_HOURS: '6', CLAUDEVR_T3_BASE_DIR: '/opt/t3home' })
  assert.deepEqual([d.t3!.pollMs, d.t3!.activeHours, d.t3!.t3BaseDir], [3000, 6, '/opt/t3home'])
  assert.throws(() => loadConfig({ ...env, CLAUDEVR_T3_POLL_MS: '20000' }), /t3\.pollMs: at most 10000/)
  assert.equal(loadConfig({ CLAUDEVR_CONFIG: join(dir, 'no-config.json'), CLAUDEVR_STATE_DIR: dir }).backend, 'fake')
})
