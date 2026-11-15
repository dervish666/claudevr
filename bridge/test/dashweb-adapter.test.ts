// DashwebAdapter with its fetch and command runner injected: nothing here
// reaches a real dashweb or runs the T3 CLI.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DashwebAdapter, t3RequestId, type CommandRunner, type Fetcher, type T3Sender } from '../src/backend/dashweb/adapter.ts'
import { SendRefused, UnsupportedError } from '../src/backend/types.ts'
import { T3McpError } from '../src/backend/t3mcp.ts'
import type { StreamFetcher } from '../src/backend/dashweb/stream.ts'

const FIX = join(import.meta.dirname, '..', '..', 'fixtures')
const BOARD = JSON.parse(readFileSync(join(FIX, 'board.json'), 'utf8'))
const T3 = JSON.parse(readFileSync(join(FIX, 't3.json'), 'utf8'))
const BUSY = 'b2e07a6c-d1fe-cc87-ac1e-f2aefa7b9949'
const BUSY_THREAD = 'afd5b10a-0619-956e-9bc7-1cc3dddc115c'

const cfg = { url: 'http://dashweb.test', t3Bin: '/opt/t3/bin/t3', t3BaseDir: '/opt/t3home', pollMs: 50 }

function fakeFetch(routes: Record<string, unknown | Error | number>): { fetch: Fetcher; calls: string[] } {
  const calls: string[] = []
  const fetch: Fetcher = async url => {
    calls.push(url)
    const r = routes[new URL(url).pathname]
    if (r instanceof Error) throw r
    if (typeof r === 'number') return { ok: false, status: r, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => structuredClone(r) }
  }
  return { fetch, calls }
}

function recorder(reply = 'queued'): { run: CommandRunner; calls: { file: string; args: string[]; input: string }[] } {
  const calls: { file: string; args: string[]; input: string }[] = []
  return {
    calls,
    run: async (file, args, input) => {
      calls.push({ file, args, input })
      return reply
    },
  }
}

const quiet = () => {}

/** A stream that connects and then says nothing until aborted. */
const hangingStream: StreamFetcher = async (_url, { signal }) => ({
  ok: true,
  status: 200,
  body: (async function* () {
    await new Promise((_ok, fail) => signal.addEventListener('abort', () => fail(new Error('aborted'))))
    yield new Uint8Array()
  })(),
})

test('declares what T3 CLI 0.1.9 can do and nothing more', () => {
  const a = new DashwebAdapter(cfg, { log: quiet })
  assert.deepEqual(a.capabilities, { list: true, subscribe: true, send: true, pending: true, interrupt: false, respond: false, approve: false, transcript: true })
})

test('interrupt, respond and approve reject as unsupported', async () => {
  const a = new DashwebAdapter(cfg, { log: quiet })
  for (const op of [() => a.interrupt(), () => a.respond(), () => a.approve()]) await assert.rejects(op(), UnsupportedError)
})

test('list reads the board, T3 and the office under the configured URL', async () => {
  const f = fakeFetch({ '/api/board': BOARD, '/api/t3': T3, '/api/state/office': {} })
  const a = new DashwebAdapter(cfg, { fetch: f.fetch, log: quiet })
  const fleet = await a.list()
  assert.deepEqual(f.calls.sort(), ['http://dashweb.test/api/board', 'http://dashweb.test/api/state/office', 'http://dashweb.test/api/t3'])
  assert.equal(fleet.sessions.length, 2)
})

test('dashweb down rejects with the reason; a non-200 board rejects too', async () => {
  await assert.rejects(new DashwebAdapter(cfg, { fetch: fakeFetch({ '/api/board': new Error('ECONNREFUSED'), '/api/t3': T3 }).fetch, log: quiet }).list(), /cannot reach dashweb.*ECONNREFUSED/)
  await assert.rejects(new DashwebAdapter(cfg, { fetch: fakeFetch({ '/api/board': 403, '/api/t3': T3 }).fetch, log: quiet }).list(), /HTTP 403/)
})

test('T3 endpoint down: the fleet still loads, sends are refused', async () => {
  const r = recorder()
  const a = new DashwebAdapter(cfg, { fetch: fakeFetch({ '/api/board': BOARD, '/api/t3': 500 }).fetch, run: r.run, log: quiet })
  const fleet = await a.list()
  assert.equal(fleet.sessions.length, 2)
  assert.ok(fleet.warnings.some(w => w.includes('T3 not readable')))
  await assert.rejects(a.send(BUSY, 'hello'), SendRefused)
  assert.equal(r.calls.length, 0)
})

test('send runs `t3 thread send --base-dir <home> <threadId> -` with the text on stdin', async () => {
  const r = recorder('message queued\n')
  const a = new DashwebAdapter(cfg, { fetch: fakeFetch({ '/api/board': BOARD, '/api/t3': T3 }).fetch, run: r.run, log: quiet })
  await a.list()
  const res = await a.send(BUSY, 'run the tests; then $(rm -rf /) stays text')
  assert.deepEqual(res, { ok: true, said: 'message queued' })
  assert.deepEqual(r.calls, [{ file: '/opt/t3/bin/t3', args: ['thread', 'send', '--base-dir', '/opt/t3home', BUSY_THREAD, '-'], input: 'run the tests; then $(rm -rf /) stays text' }])
})

test('send refuses unknown sessions, empty and oversized text, before running anything', async () => {
  const r = recorder()
  const a = new DashwebAdapter(cfg, { fetch: fakeFetch({ '/api/board': BOARD, '/api/t3': T3 }).fetch, run: r.run, log: quiet })
  await assert.rejects(a.send(BUSY, 'before any read'), SendRefused)
  await a.list()
  await assert.rejects(a.send('no-such-session', 'hi'), SendRefused)
  await assert.rejects(a.send(BUSY, '   '), SendRefused)
  await assert.rejects(a.send(BUSY, 'x'.repeat(4001)), SendRefused)
  assert.equal(r.calls.length, 0)
})

test('send: refused while the latest fleet read failed, or once the last good read is over a minute old', async () => {
  const r = recorder()
  let t = 1_000_000
  const routes: Record<string, unknown> = { '/api/board': BOARD, '/api/t3': T3 }
  const a = new DashwebAdapter(cfg, { fetch: fakeFetch(routes).fetch, run: r.run, log: quiet, now: () => t })
  await a.list()
  await a.send(BUSY, 'one')
  routes['/api/board'] = new Error('ECONNREFUSED')
  await assert.rejects(a.list())
  await assert.rejects(a.send(BUSY, 'two'), (e: Error) => e instanceof SendRefused && e.status === 409 && /cannot confirm the session is still there: the last fleet read failed/.test(e.message))
  routes['/api/board'] = BOARD
  await a.list()
  await a.send(BUSY, 'three')
  t += 61_000
  await assert.rejects(a.send(BUSY, 'four'), /cannot confirm the session is still there: the last good fleet read is 61 s old/)
  assert.deepEqual(r.calls.map(c => c.input), ['one', 'three'], 'nothing ran for the refused sends')
})

test('send: the HUD request id reaches T3 as one stable UUID; without one, each send gets a fresh id', async () => {
  const ids: string[] = []
  const t3mcp: T3Sender = { linkState: () => 'ok', send: async (_thread, _text, id) => (ids.push(id), { delivery: 'started', runId: '' }) }
  const a = new DashwebAdapter(cfg, { fetch: fakeFetch({ '/api/board': BOARD, '/api/t3': T3 }).fetch, run: recorder().run, log: quiet, t3mcp })
  await a.list()
  await a.send(BUSY, 'x', 'card-0123456789')
  await a.send(BUSY, 'x', 'card-0123456789')
  await a.send(BUSY, 'x', 'card-other-0001')
  await a.send(BUSY, 'x')
  await a.send(BUSY, 'x')
  assert.equal(ids[0], ids[1], 'a retry of one card is the same request to T3')
  assert.notEqual(ids[0], ids[2])
  assert.notEqual(ids[3], ids[4])
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(t3RequestId('card-0123456789'), ids[0])
  assert.match(ids[0]!, /^.{14}5/, 'version 5 layout')
})

test('send: T3 refusing the send is a refusal (nothing went out), not an unknown outcome', async () => {
  const t3mcp: T3Sender = { linkState: () => 'ok', send: async () => Promise.reject(new T3McpError('tool', 'T3 refused the send (invalid_request): nope')) }
  const r = recorder()
  const a = new DashwebAdapter(cfg, { fetch: fakeFetch({ '/api/board': BOARD, '/api/t3': T3 }).fetch, run: r.run, log: quiet, t3mcp })
  await a.list()
  await assert.rejects(a.send(BUSY, 'x'), (e: Error) => e instanceof SendRefused && e.status === 502 && /nope/.test(e.message))
  assert.equal(r.calls.length, 0, 'and the CLI is not tried')
})

test('transcript runs `t3 thread show --json` and maps roles, in full, cutting only at the cap', async () => {
  const long = 'x'.repeat(13_000)
  const r = recorder(JSON.stringify({ thread: { threadId: BUSY_THREAD }, messages: [{ role: 'user', text: 'run the tests' }, { role: 'assistant', text: 'All 84 pass.\n\n- one\n- two' }, { role: 'assistant', text: '  ' }, { role: 'tool', text: 'note' }, { role: 'assistant', text: long }] }))
  const a = new DashwebAdapter(cfg, { fetch: fakeFetch({ '/api/board': BOARD, '/api/t3': T3 }).fetch, run: r.run, log: quiet })
  await a.list()
  const t = await a.transcript(BUSY, 6)
  assert.deepEqual(r.calls[0]!.args, ['thread', 'show', '--base-dir', '/opt/t3home', '--json', '--messages', '6', BUSY_THREAD])
  assert.equal(r.calls[0]!.input, '')
  assert.deepEqual(t.turns.map(x => x.role), ['you', 'session', 'other', 'session'])
  assert.equal(t.turns[1]!.text, 'All 84 pass.\n\n- one\n- two')
  assert.equal(t.turns[1]!.clipped, false)
  assert.equal(t.turns[3]!.clipped, true)
  assert.equal(t.turns[3]!.text.length, 12_001)
})

test('transcript refuses a session with no T3 thread, and says so when the CLI prints something else', async () => {
  const r = recorder('not json')
  const a = new DashwebAdapter(cfg, { fetch: fakeFetch({ '/api/board': BOARD, '/api/t3': T3 }).fetch, run: r.run, log: quiet })
  await a.list()
  await assert.rejects(a.transcript('no-such-session', 5), SendRefused)
  assert.equal(r.calls.length, 0)
  await assert.rejects(a.transcript(BUSY, 5), /did not print JSON/)
})

test('a CLI failure surfaces as a rejection', async () => {
  const a = new DashwebAdapter(cfg, {
    fetch: fakeFetch({ '/api/board': BOARD, '/api/t3': T3 }).fetch,
    run: async () => {
      throw new Error('thread not found')
    },
    log: quiet,
  })
  await a.list()
  await assert.rejects(a.send(BUSY, 'hi'), /thread not found/)
})

test('subscribe polls and reports failures as updates, then stops when unsubscribed', async () => {
  let fail = false
  const f: Fetcher = async url => {
    if (fail) throw new Error('down')
    return { ok: true, status: 200, json: async () => structuredClone(new URL(url).pathname === '/api/board' ? BOARD : T3) }
  }
  const a = new DashwebAdapter(cfg, { fetch: f, streamFetch: hangingStream, log: quiet })
  const seen: boolean[] = []
  const off = a.subscribe(u => seen.push(u.ok))
  await new Promise(r => setTimeout(r, 80))
  fail = true
  await new Promise(r => setTimeout(r, 120))
  off()
  const n = seen.length
  await new Promise(r => setTimeout(r, 120))
  assert.ok(seen[0] === true, 'first update is good')
  assert.ok(seen.includes(false), 'a failed poll is reported')
  assert.equal(seen.length, n, 'no updates after unsubscribe')
})

test('usage: the office gives limits and contexts, the live stream gives spend; the stream closes with the last listener', async () => {
  const office = {
    [BUSY]: { at: 1, data: { stats: { usage: { measuredAt: Date.now() - 1000, context: { tokens: 90_000, window: 200_000, percent: 45 }, rateLimits: [{ kind: 'five_hour', percentUsed: 42, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] }, breakdown: null } } },
  }
  const f = fakeFetch({ '/api/board': BOARD, '/api/t3': T3, '/api/state/office': office })
  let aborted = false
  let opened = 0
  const streamFetch: StreamFetcher = async (url, { signal }) => {
    opened++
    assert.equal(url, 'http://dashweb.test/api/sub/office')
    signal.addEventListener('abort', () => (aborted = true))
    return {
      ok: true,
      status: 200,
      body: (async function* () {
        yield new TextEncoder().encode('event: snapshot\ndata: {}\n\nevent: spend\ndata: {"usd":12.5}\n\n')
        await new Promise((_ok, fail) => signal.addEventListener('abort', () => fail(new Error('aborted'))))
      })(),
    }
  }
  const a = new DashwebAdapter(cfg, { fetch: f.fetch, streamFetch, log: quiet })
  const before = await a.list()
  assert.equal(before.usage.todayUsd.value, null, 'no stream yet: not available, not $0')
  const off = a.subscribe(() => {})
  await new Promise(r => setTimeout(r, 30))
  const fleet = await a.list()
  assert.equal(fleet.usage.todayUsd.value, 12.5)
  assert.equal(fleet.usage.todayUsd.stale, false)
  assert.deepEqual(fleet.usage.limits.value?.map(w => [w.kind, w.usedPct]), [['five_hour', 42]])
  assert.equal(fleet.sessions.find(s => s.id === BUSY)!.context?.usedPct, 45)
  assert.equal(fleet.sessions.find(s => s.id !== BUSY)!.context, null, 'a session the office does not carry has no context, not 0%')
  off()
  assert.equal(opened, 1)
  assert.equal(aborted, true, 'unsubscribing closes the stream')
})

test('usage: an unreadable office leaves the fleet up and every usage figure unavailable', async () => {
  const f = fakeFetch({ '/api/board': BOARD, '/api/t3': T3, '/api/state/office': 503 })
  const a = new DashwebAdapter(cfg, { fetch: f.fetch, log: quiet })
  const fleet = await a.list()
  assert.equal(fleet.sessions.length, 2)
  assert.equal(fleet.usage.limits.value, null)
  assert.match(fleet.usage.limits.note ?? '', /HTTP 503/)
  assert.ok(fleet.sessions.every(s => s.context === null))
})

test('a thread made through T3\'s MCP tools ("mcp:<uuid>") can be sent to and read; an id that looks like a flag cannot', async () => {
  const withId = (id: string) => [BOARD, T3].map(x => JSON.parse(JSON.stringify(x).replaceAll(BUSY_THREAD, id)))
  const mcp = `mcp:${BUSY_THREAD}`
  const [board, t3] = withId(mcp)
  const r = recorder(JSON.stringify({ thread: { threadId: mcp }, messages: [{ role: 'assistant', text: 'hello' }] }))
  const a = new DashwebAdapter(cfg, { fetch: fakeFetch({ '/api/board': board, '/api/t3': t3 }).fetch, run: r.run, log: quiet })
  await a.list()
  await a.send(BUSY, 'status?')
  assert.deepEqual(r.calls[0]!.args, ['thread', 'send', '--base-dir', '/opt/t3home', mcp, '-'])
  assert.equal((await a.transcript(BUSY, 3)).turns[0]!.text, 'hello')
  assert.ok(r.calls[1]!.args.includes(mcp))

  for (const bad of ['--base-dir', '-x', 'a b', 'a;b', 'a$(b)']) {
    const [b2, t2] = withId(bad)
    const r2 = recorder()
    const a2 = new DashwebAdapter(cfg, { fetch: fakeFetch({ '/api/board': b2, '/api/t3': t2 }).fetch, run: r2.run, log: quiet })
    await a2.list()
    await assert.rejects(a2.send(BUSY, 'hi'), /not one the CLI can take|no T3 thread/, bad)
    assert.equal(r2.calls.length, 0, bad)
  }
})
