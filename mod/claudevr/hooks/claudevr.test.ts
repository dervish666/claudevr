import type { On, SessionUsage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { buildReport, isDue, loopbackUrl, parseBridge, remember, EMPTY_LIVE } from './report'

const NOW = Date.parse('2026-11-17T10:00:00Z')
const HOME = '/home/t'
const BRIDGE_FILE = `${HOME}/.claudevr/bridge.json`
const TRANSCRIPT = `${HOME}/.claude/projects/-work-claudevr/s1.jsonl`
const TOKEN_A = 'a'.repeat(64)
const TOKEN_B = 'b'.repeat(64)

const bridgeJson = (token: string, url = 'http://127.0.0.1:8444') => JSON.stringify({ v: 1, url, token, pid: 1, startedAt: NOW })

const USAGE: SessionUsage = {
  startedAt: NOW - 60_000,
  context: { tokens: 50_000, window: 200_000, percent: 25 },
  rateLimits: [{ kind: 'five_hour', percentUsed: 12.5, resetsAt: '2026-11-17T12:00:00.000Z' }],
  cost: { usd: 1.25 },
}

type Req = { method: string; url: string; token: string | undefined; body: any }
type Item = { id: string; text: string }

type Fake = {
  file?: () => string
  inbox?: Item[][]
  status?: (req: Req) => number
  drop?: string
}

// Stands in for everything beneath the mod: a clock, the disk (bridge.json and
// the transcript), the session's own nouns, the bridge's HTTP answers and the
// prompt box. Records what the mod sent.
function fake(on: On, { file = () => bridgeJson(TOKEN_A), inbox = [], status = () => 204, drop }: Fake = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME })
  const seen = { clock, reqs: [] as Req[], submits: [] as any[], logs: [] as string[], fileReads: 0 }
  on('fs.read', ($, e) => {
    if (e.path !== BRIDGE_FILE) throw new Error(`ENOENT ${e.path}`)
    seen.fileReads++
    return { value: file() }
  })
  on('fs.exists', ($, e) => ({ value: e.path === TRANSCRIPT }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', ($, e) => ({
    value: { exitCode: 0, stdout: e.argv.at(-1) === TRANSCRIPT ? '"customTitle":"old"\n"customTitle":"VR \\"demo\\""\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: '/work/claudevr' }))
  on('session.cwd', () => ({ value: '/work/claudevr/bridge' }))
  on('session.usage', () => ({ value: USAGE }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.log', ($, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('http.fetch', ($, e) => {
    const req: Req = { method: e.init?.method ?? 'GET', url: e.url, token: e.init?.headers?.['x-claudevr-token'], body: typeof e.init?.body === 'string' ? JSON.parse(e.init.body) : undefined }
    seen.reqs.push(req)
    const code = status(req)
    if (code === 0) return { deny: 'ECONNREFUSED' }
    if (req.method === 'GET' && code === 204) {
      const items = inbox.shift()
      if (items) return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ items }) } }
    }
    return { value: { status: code, ok: code < 300, headers: {}, text: '' } }
  })
  on('prompt.submit', ($, e) => {
    seen.submits.push(e)
    return drop ? { drop } : { text: e.text }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'a1' }))
  return seen
}

const start = ($: any) => $.session.start({ cwd: '/work/claudevr', surface: 'terminal', isInteractive: true })
const posts = (seen: { reqs: Req[] }) => seen.reqs.filter(r => r.method === 'POST' && r.url.includes('/mod/v1/session'))
const acks = (seen: { reqs: Req[] }) => seen.reqs.filter(r => r.url.includes('/mod/v1/ack')).map(r => r.body)

test('the report is built from the session events', async ($, on) => {
  const seen = fake(on)
  let release = () => {}
  on('tool.call', ($, e) => {
    if (String(e.tool) !== 'AskUserQuestion') return { result: 'ok' }
    return new Promise(resolve => {
      release = () => resolve({ result: 'Blue' })
    })
  })
  await start($)
  await $.turn.start({ text: 'pick a colour', turnId: 't1' })
  await $.agent.spawn({ tool_use_id: 'u0', prompt: 'look', description: 'find the loader', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5' } as any)
  await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'a1' })
  const asked = $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Which colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Blue', description: '' }, { label: 'Red', description: '' }] }] } as any)
  await seen.clock.advance(1_000)

  const r = posts(seen).at(-1)!.body
  expect(r.v).toBe(1)
  expect(r.sessionId).toBe('s1')
  expect(seen.reqs[0]!.url).toBe('http://127.0.0.1:8444/mod/v1/session?src=s1')
  expect(seen.reqs[0]!.token).toBe(TOKEN_A)
  expect(r.project).toBe('claudevr')
  expect(r.title).toBe('VR "demo"')
  expect(r.cwd).toBe('/work/claudevr/bridge')
  expect(r.transcriptPath).toBe(TRANSCRIPT)
  expect(r.state).toBe('asking')
  expect(r.asking).toEqual({ text: 'Which colour?', options: ['Blue', 'Red'] })
  expect(r.startedAt).toBe(NOW - 60_000)
  expect(r.messages).toEqual([{ role: 'you', text: 'pick a colour', at: NOW }])
  expect(r.agents).toEqual([{ id: 'a1', type: 'Explore', description: 'find the loader', model: 'claude-haiku-4-5', state: 'running', startedAt: NOW, endedAt: null, now: 'Bash: npm test' }])
  expect(r.context).toEqual({ usedPct: 25, tokens: 50_000, windowTokens: 200_000 })
  expect(r.rateLimits).toEqual([{ kind: 'five_hour', usedPct: 12.5, resetsAt: Date.parse('2026-11-17T12:00:00.000Z') }])
  expect(r.costUsd).toBe(1.25)

  release()
  await asked
  await $.turn.complete({ answer: 'Blue it is.\nAll done.', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.turn.complete({ answer: 'found it', durationMs: 1_000, isAborted: false, turnId: 't2', reason: 'answer', agentId: 'a1' })
  await seen.clock.advance(2_000)
  const after = posts(seen).at(-1)!.body
  expect(after.state).toBe('idle')
  expect(after.action).toBe(null)
  expect(after.asking).toBe(null)
  expect(after.lastLine).toBe('All done.')
  expect(after.messages.map((m: any) => m.role)).toEqual(['you', 'session'])
  expect(after.agents[0]).toMatchObject({ state: 'done', endedAt: NOW + 1_000, now: 'found it' })
})

test('a running tool reads as working, a turn without one as thinking, an error as failed', async ($, on) => {
  const seen = fake(on)
  let release = () => {}
  on('tool.call', () => new Promise(resolve => (release = () => resolve({ result: 'ok' }))))
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await seen.clock.advance(1_000)
  expect(posts(seen).at(-1)!.body).toMatchObject({ state: 'thinking', action: 'thinking' })
  const ran = $.tool.call({ tool: 'Bash', command: 'npm   test\n' })
  await seen.clock.advance(2_000)
  expect(posts(seen).at(-1)!.body).toMatchObject({ state: 'working', action: 'Bash: npm test' })
  release()
  await ran
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'error' })
  await seen.clock.advance(2_000)
  expect(posts(seen).at(-1)!.body.state).toBe('failed')
})

test('a report goes within 2 s of a change and every 10 s regardless, never more', async ($, on) => {
  const seen = fake(on)
  on('tool.call', () => ({ result: 'ok' }))
  await start($)
  await seen.clock.advance(1_000)
  expect(posts(seen).length).toBe(1)
  // Nothing changes: quiet until the heartbeat, 10 s after the last report.
  await seen.clock.advance(9_000)
  expect(posts(seen).length).toBe(1)
  await seen.clock.advance(1_000)
  expect(posts(seen).length).toBe(2)
  // A change goes out within 2 s.
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await seen.clock.advance(2_000)
  expect(posts(seen).length).toBe(3)
  expect(posts(seen).at(-1)!.body.state).toBe('thinking')
})

test('the heartbeat and change rule', () => {
  expect(isDue('a', { body: 'a', at: 0 }, 9_999)).toBe(false)
  expect(isDue('a', { body: 'a', at: 0 }, 10_000)).toBe(true)
  expect(isDue('b', { body: 'a', at: 0 }, 1_999)).toBe(false)
  expect(isDue('b', { body: 'a', at: 0 }, 2_000)).toBe(true)
  const r = remember(['x'], 'x')
  expect(r.isNew).toBe(false)
  const many = Array.from({ length: 50 }, (_, i) => `m${i}`)
  const next = remember(many, 'new')
  expect(next.isNew).toBe(true)
  expect(next.ids.length).toBe(50)
  expect(next.ids[0]).toBe('m1')
})

test('a bridge.json naming a host off this machine is refused and nothing is sent', async ($, on) => {
  const seen = fake(on, { file: () => bridgeJson(TOKEN_A, 'http://192.168.0.5:8444') })
  await start($)
  await seen.clock.advance(5_000)
  expect(seen.reqs.length).toBe(0)
  expect(seen.logs.filter(l => /refused/.test(l)).length).toBe(1)
  expect(seen.logs.join('\n')).not.toContain(TOKEN_A)
  const said = await $.command.run({ command: 'claudevr', args: '' } as any)
  expect(said.text).toMatch(/Not linked: .*refused/)
  expect(said.text).not.toContain(TOKEN_A)
})

test('only plain http on loopback is taken', () => {
  expect(loopbackUrl('http://127.0.0.1:8444/')).toBe('http://127.0.0.1:8444')
  expect(loopbackUrl('http://localhost:8444')).toBe('http://localhost:8444')
  expect(loopbackUrl('http://[::1]:8444')).toBe('http://[::1]:8444')
  expect(loopbackUrl('https://127.0.0.1:8444')).toBe(undefined)
  expect(loopbackUrl('http://127.0.0.1.evil.example:8444')).toBe(undefined)
  expect(loopbackUrl('http://user:pw@127.0.0.1:8444')).toBe(undefined)
  expect(loopbackUrl('http://10.0.0.1:8444')).toBe(undefined)
  expect(parseBridge('{"v":1,"url":"http://127.0.0.1:1","token":""}')).toEqual({ error: 'bridge.json has no url or token' })
  expect(parseBridge('nope')).toEqual({ error: 'bridge.json is not JSON' })
})

test('an inbox message is submitted once as the person and acked', async ($, on) => {
  const seen = fake(on, { inbox: [[{ id: 'm1', text: 'run the tests' }]] })
  await start($)
  await seen.clock.advance(1_000)
  await seen.clock.advance(1_000)
  expect(seen.submits.length).toBe(1)
  expect(seen.submits[0]).toMatchObject({ text: 'run the tests', origin: { kind: 'plugin', name: 'claudevr', asUser: true } })
  expect(acks(seen)).toEqual([{ id: 'm1', ok: true, delivery: 'started' }])
  const ack = seen.reqs.find(r => r.url.includes('/mod/v1/ack'))!
  expect(ack.url).toBe('http://127.0.0.1:8444/mod/v1/ack?src=s1')
  expect(ack.token).toBe(TOKEN_A)
})

test('a busy session acks a message as queued at once and still submits it', async ($, on) => {
  const seen = fake(on, { inbox: [[{ id: 'm3', text: 'and add a test' }]] })
  await start($)
  await $.turn.start({ text: 'fix the parser', turnId: 't1' })
  await seen.clock.advance(1_000)
  await seen.clock.advance(1_000)
  expect(acks(seen)).toEqual([{ id: 'm3', ok: true, delivery: 'queued' }])
  expect(seen.submits.length).toBe(1)
  expect(seen.submits[0]).toMatchObject({ text: 'and add a test' })
})

test('a repeated id is acked without being submitted again', async ($, on) => {
  const seen = fake(on, { inbox: [[{ id: 'm1', text: 'hello' }], [{ id: 'm1', text: 'hello' }]] })
  await start($)
  for (let i = 0; i < 4; i++) await seen.clock.advance(1_000)
  expect(seen.submits.length).toBe(1)
  expect(acks(seen)).toEqual([
    { id: 'm1', ok: true, delivery: 'started' },
    { id: 'm1', ok: true },
  ])
})

test('a prompt a hook drops is acked as failed with the reason, and may come again', async ($, on) => {
  const seen = fake(on, { inbox: [[{ id: 'm2', text: 'hi' }], [{ id: 'm2', text: 'hi' }]], drop: 'blocked by policy' })
  await start($)
  for (let i = 0; i < 4; i++) await seen.clock.advance(1_000)
  expect(seen.submits.length).toBe(2)
  expect(acks(seen)).toEqual([
    { id: 'm2', ok: false, reason: 'blocked by policy' },
    { id: 'm2', ok: false, reason: 'blocked by policy' },
  ])
})

test('a 401 reads bridge.json again and carries on with the new token', async ($, on) => {
  let token = TOKEN_A
  const seen = fake(on, { file: () => bridgeJson(token), status: r => (r.token === TOKEN_B ? 204 : 401) })
  await start($)
  await seen.clock.advance(1_000)
  expect(seen.fileReads).toBe(1)
  expect(posts(seen).at(-1)!.token).toBe(TOKEN_A)
  // The bridge restarted with a new token.
  token = TOKEN_B
  await seen.clock.advance(1_000)
  expect(seen.fileReads).toBe(2)
  expect(posts(seen).at(-1)!.token).toBe(TOKEN_B)
  expect(seen.logs.filter(l => /linked to the bridge/.test(l)).length).toBe(1)
  expect(seen.logs.join('\n')).not.toContain(TOKEN_A)
  expect(seen.logs.join('\n')).not.toContain(TOKEN_B)
})

test('with no bridge the mod waits 10 s between tries and says so once each way', async ($, on) => {
  let up = false
  const seen = fake(on, { status: () => (up ? 204 : 0) })
  await start($)
  await seen.clock.advance(1_000)
  expect(posts(seen).length).toBe(1)
  await seen.clock.advance(9_000)
  expect(posts(seen).length).toBe(1)
  await seen.clock.advance(1_000)
  expect(posts(seen).length).toBe(2)
  expect(seen.logs.filter(l => /not reachable/.test(l)).length).toBe(1)
  expect(seen.fileReads).toBe(2)
  up = true
  await seen.clock.advance(10_000)
  expect(seen.logs.filter(l => /linked to the bridge/.test(l)).length).toBe(1)
  const said = await $.command.run({ command: 'claudevr', args: '' } as any)
  expect(said.text).toMatch(/^Linked to the ClaudeVR bridge at http:\/\/127\.0\.0\.1:8444\./)
})

test('the session end drops the session at the bridge', async ($, on) => {
  const seen = fake(on)
  await start($)
  await seen.clock.advance(1_000)
  await $.session.end({ reason: 'exit', sessionId: 's1', resume: { id: 's1' } } as any)
  expect(seen.reqs.at(-1)).toMatchObject({ method: 'DELETE', url: 'http://127.0.0.1:8444/mod/v1/session?src=s1' })
})

test('a report before any reading has no context and empty limits', () => {
  const r = buildReport({ sessionId: 's', root: '/a/b', title: '', cwd: '/a/b', transcriptPath: null, live: EMPTY_LIVE, usage: { startedAt: 5, context: { window: 200_000 }, rateLimits: [] }, now: 10 })
  expect(r).toMatchObject({ project: 'b', state: 'idle', context: null, rateLimits: [], costUsd: null, activeAt: 5, startedAt: 5 })
})
