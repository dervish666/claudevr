// The claude backend and the mod listener it is fed by (docs/mod-protocol.md),
// against a real listener on a random loopback port and a temp discovery
// file and projects folder. Nothing here touches ~/.claudevr or ~/.claude.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModHub } from '../src/backend/claude/hub.ts'
import { ClaudeAdapter, INSTALL_HINT } from '../src/backend/claude/adapter.ts'
import { parseReport, ReportError } from '../src/backend/claude/report.ts'
import { limitsOf, normaliseClaude, spendOf } from '../src/backend/claude/normalise.ts'
import { confinedPath, readTail, turnsOfJsonl } from '../src/backend/claude/transcript.ts'
import { ModListener, removeBridgeFile, tokenMatches, writeBridgeFile } from '../src/mod-listener.ts'
import { SendRefused, type FleetUpdate } from '../src/backend/types.ts'
import { loadConfig } from '../src/config.ts'

const dir = mkdtempSync(join(tmpdir(), 'claudevr-claude-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const TOKEN = 'a'.repeat(32) + 'SECRET' + 'b'.repeat(26)
const seen: string[] = []
const log = (...a: unknown[]) => seen.push(a.map(String).join(' '))
after(() => {
  for (const line of seen) assert.ok(!line.includes(TOKEN), `token leaked into: ${line}`)
})

const NOW = Date.parse('2026-11-17T12:00:00.000Z')
const SID = 'c0ffee00-1111-4222-8333-444455556666'

function report(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    sessionId: SID,
    project: 'claudevr',
    title: 'Build the bridge',
    cwd: '/work/claudevr',
    transcriptPath: null,
    state: 'working',
    action: 'Bash: npm test',
    lastLine: 'Running the tests now.',
    activeAt: NOW - 1000,
    startedAt: NOW - 600_000,
    asking: null,
    messages: [
      { role: 'you', text: 'run the tests', at: NOW - 5000 },
      { role: 'session', text: 'Running the tests now.', at: NOW - 1000 },
    ],
    agents: [],
    context: { usedPct: 42, tokens: 84_000, windowTokens: 200_000 },
    rateLimits: [{ kind: 'five_hour', usedPct: 30, resetsAt: NOW + 3_600_000 }],
    costUsd: 1.25,
    ...over,
  }
}

let fileN = 0
async function listener(hubOpts: ConstructorParameters<typeof ModHub>[0] = {}) {
  const hub = new ModHub({ log, ...hubOpts })
  const bridgeFile = join(dir, `run-${fileN++}`, 'bridge.json')
  const l = new ModListener({ hub, port: 0, bridgeFile, log, token: TOKEN })
  const url = await l.start()
  after(() => l.close())
  return { hub, l, url, bridgeFile }
}

interface Res {
  status: number
  body: any
}
function call(url: string, method: string, path: string, opts: { token?: string | null; body?: unknown; raw?: string | Buffer; chunked?: boolean } = {}): Promise<Res> {
  return new Promise((ok, fail) => {
    const u = new URL(path, url)
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (opts.token !== null) headers['x-claudevr-token'] = opts.token ?? TOKEN
    const data = opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined)
    if (data !== undefined && !opts.chunked) headers['content-length'] = String(Buffer.byteLength(data))
    const req = request(u, { method, headers }, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        ok({ status: res.statusCode!, body: text ? JSON.parse(text) : null })
      })
    })
    req.on('error', fail)
    if (data !== undefined) {
      if (opts.chunked) {
        const b = Buffer.from(data)
        for (let i = 0; i < b.length; i += 16 * 1024) req.write(b.subarray(i, i + 16 * 1024))
      } else req.write(data)
    }
    req.end()
  })
}
/** Marks a send's rejection as handled now; the test still awaits it later. */
function early<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {})
  return p
}
const src = (id = SID) => `?src=${encodeURIComponent(id)}`

// ---------------------------------------------------------------- listener

test('tokenMatches: exact token only, any length, constant-time path', () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true)
  assert.equal(tokenMatches(TOKEN.slice(0, -1) + 'x', TOKEN), false)
  assert.equal(tokenMatches('short', TOKEN), false)
  assert.equal(tokenMatches('', TOKEN), false)
  assert.equal(tokenMatches(undefined, TOKEN), false)
  assert.equal(tokenMatches(['a'], TOKEN), false)
})

test('listener: no token, a wrong token, or one of another length get 401 and nothing else', async () => {
  const { url, hub } = await listener()
  for (const token of [null, 'wrong', TOKEN.slice(0, -1) + 'c', TOKEN + 'x']) {
    const r = await call(url, 'POST', `/mod/v1/session${src()}`, { token, body: report() })
    assert.equal(r.status, 401)
    assert.deepEqual(Object.keys(r.body), ['error'])
  }
  // 401 comes before the route is even looked at.
  assert.equal((await call(url, 'GET', '/nope', { token: null })).status, 401)
  assert.equal((await call(url, 'GET', '/nope')).status, 404)
  assert.equal((await call(url, 'PUT', `/mod/v1/session${src()}`)).status, 405)
  assert.equal(hub.live().length, 0)
})

test('listener: src must be 1 to 128 of [A-Za-z0-9._:-], given once', async () => {
  const { url } = await listener()
  for (const q of ['', '?src=', `?src=${'a'.repeat(129)}`, '?src=a%2Fb', '?src=a%20b', '?src=a&src=b', '?src=%00']) {
    assert.equal((await call(url, 'GET', `/mod/v1/inbox${q}`)).status, 400, q)
  }
  assert.equal((await call(url, 'DELETE', `/mod/v1/session?src=${'a'.repeat(128)}`)).status, 204)
  assert.equal((await call(url, 'DELETE', '/mod/v1/session?src=Ab0._:-')).status, 204)
})

test('listener: a body over 64 KiB is a 413, declared or chunked', async () => {
  const { url, hub } = await listener()
  const big = JSON.stringify(report({ title: 'x'.repeat(70 * 1024) }))
  assert.equal((await call(url, 'POST', `/mod/v1/session${src()}`, { raw: big })).status, 413)
  assert.equal((await call(url, 'POST', `/mod/v1/session${src()}`, { raw: big, chunked: true })).status, 413)
  assert.equal((await call(url, 'POST', `/mod/v1/ack${src()}`, { raw: big, chunked: true })).status, 413)
  assert.equal(hub.live().length, 0)
  // Just under the limit is fine, and the title is clipped.
  const ok = await call(url, 'POST', `/mod/v1/session${src()}`, { body: report({ title: 'y'.repeat(60 * 1024) }) })
  assert.equal(ok.status, 204)
  assert.ok(hub.live()[0]!.report.title.length <= 160)
})

test('listener: a report with a wrong type is a 400; unknown keys are dropped', async () => {
  const { url, hub } = await listener()
  const bad = [
    report({ state: 'dancing' }),
    report({ v: 2 }),
    report({ sessionId: 'someone-else' }),
    report({ activeAt: '12' }),
    report({ messages: 'hi' }),
    report({ messages: [{ role: 'them', text: 'x', at: 1 }] }),
    report({ agents: [{ id: 'a', type: 't', description: 'd', model: null, state: 'running', startedAt: null, endedAt: null, now: 5 }] }),
    report({ rateLimits: [{ kind: 'five hour; rm', usedPct: 1, resetsAt: null }] }),
    report({ asking: { text: 'q', options: [1] } }),
    report({ costUsd: 'free' }),
    report({ context: { usedPct: Infinity, tokens: null, windowTokens: null } }),
  ]
  for (const b of bad) assert.equal((await call(url, 'POST', `/mod/v1/session${src()}`, { body: b })).status, 400, JSON.stringify(b).slice(0, 80))
  assert.equal((await call(url, 'POST', `/mod/v1/session${src()}`, { raw: '{not json' })).status, 400)
  assert.equal(hub.live().length, 0)

  assert.equal((await call(url, 'POST', `/mod/v1/session${src()}`, { body: report({ extra: { run: 'rm -rf /' }, __proto__x: 1 }) })).status, 204)
  const r = hub.live()[0]!.report as unknown as Record<string, unknown>
  assert.equal('extra' in r, false)
  assert.equal('__proto__x' in r, false)
})

test('parseReport clips every shown string and caps the lists', () => {
  const r = parseReport(
    report({
      lastLine: 'word '.repeat(200),
      messages: Array.from({ length: 10 }, (_, i) => ({ role: 'session', text: `m${i} ${'z'.repeat(900)}`, at: i })),
      agents: Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, type: 'Explore', description: 'look', model: null, state: 'done', startedAt: i, endedAt: i + 1, now: null })),
      rateLimits: [{ kind: 'seven_day', usedPct: 5, resetsAt: Math.floor((NOW + 86_400_000) / 1000) }],
    }),
    SID,
  )
  assert.ok(r.lastLine!.length <= 240)
  assert.equal(r.messages.length, 6)
  assert.ok(r.messages[0]!.text.startsWith('m4'))
  assert.ok(r.messages.every(m => m.text.length <= 500))
  assert.equal(r.agents.length, 12)
  assert.equal(r.rateLimits[0]!.resetsAt, NOW + 86_400_000, 'seconds are read as seconds')
  assert.throws(() => parseReport(report(), 'other'), ReportError)
})

// ---------------------------------------------------------------- hub and fleet

test('hub: a session not heard from in 30 s leaves the fleet; any request keeps it', () => {
  let now = NOW
  const hub = new ModHub({ now: () => now, log })
  hub.report(parseReport(report(), SID))
  now += 25_000
  hub.heard(SID)
  now += 25_000
  assert.equal(hub.live().length, 1)
  now += 31_000
  assert.equal(hub.live().length, 0)
})

test('fleet: a report maps to a Claude Code session, asking and failed to needs, agents ordered and capped', () => {
  let now = NOW
  const hub = new ModHub({ now: () => now })
  const agents = [
    { id: 'old', type: 'Explore', description: 'old one', model: 'haiku', state: 'done', startedAt: NOW - 90_000, endedAt: NOW - 80_000, now: null },
    { id: 'run1', type: 'general-purpose', description: 'running', model: null, state: 'running', startedAt: NOW - 50_000, endedAt: null, now: 'Bash: ls' },
    { id: 'new', type: 'Explore', description: 'newest done', model: null, state: 'failed', startedAt: NOW - 30_000, endedAt: NOW - 10_000, now: null },
    ...Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, type: 'Plan', description: 'x', model: null, state: 'done', startedAt: NOW - 200_000, endedAt: NOW - 100_000 - i, now: null })),
    { id: 'run2', type: 'Plan', description: 'running too', model: null, state: 'running', startedAt: NOW - 1000, endedAt: null, now: null },
  ]
  hub.report(parseReport(report({ agents, asking: { text: 'Which colour?', options: ['Red', 'Blue'] } }), SID))
  hub.report(parseReport(report({ sessionId: 'two', title: '', project: 'gt', state: 'failed', lastLine: 'API error', startedAt: NOW - 100 }), 'two'))
  const fleet = normaliseClaude({ sessions: hub.live(), readings: hub.limitReadings(), spent: hub.spend() }, now)
  assert.equal(fleet.sessions.length, 2)
  const s = fleet.sessions.find(x => x.id === SID)!
  assert.equal(s.kind, 'Claude Code')
  assert.equal(s.state, 'asking')
  assert.equal(s.action, null)
  assert.deepEqual(s.asking, { text: 'Which colour?', options: ['Red', 'Blue'], answerAt: null })
  assert.deepEqual(s.messages, [{ at: NOW - 1000, text: 'Running the tests now.' }])
  assert.equal(s.canSend, true)
  assert.equal(s.context!.usedPct, 42)
  assert.deepEqual(s.agents!.map(a => a.id), ['run2', 'run1', 'new', 'old', 'd0', 'd1'])
  assert.equal(s.moreAgents, 4)
  assert.equal(s.moreRunning, 0)
  const two = fleet.sessions.find(x => x.id === 'two')!
  assert.equal(two.title, 'gt')
  assert.equal(two.state, 'failed')
  assert.deepEqual(
    fleet.needs.map(n => [n.kind, n.sessionId, n.source]).sort(),
    [
      ['failed', 'two', 'Claude Code'],
      ['question', SID, 'Claude Code'],
    ],
  )
  assert.notEqual(fleet.sessions[0]!.callsign, fleet.sessions[1]!.callsign)
})

test('usage: freshest reading of each window wins, reset windows drop, old readings are stale', () => {
  const r = (kind: string, usedPct: number, at: number, resetsAt: number | null = NOW + 3_600_000) => ({ kind, usedPct, at, resetsAt })
  const fresh = limitsOf([r('seven_day', 10, NOW - 1000), r('five_hour', 55, NOW - 500)], NOW)
  assert.deepEqual(fresh.value!.map(w => [w.kind, w.label, w.usedPct]), [
    ['five_hour', '5-hour', 55],
    ['seven_day', 'Weekly', 10],
  ])
  assert.equal(fresh.stale, false)
  assert.equal(fresh.at, NOW - 1000, 'the age is the oldest window shown')

  const rolled = limitsOf([r('five_hour', 90, NOW - 1000, NOW - 1)], NOW)
  assert.equal(rolled.value, null)
  assert.match(rolled.note!, /5-hour window reset/)

  const stale = limitsOf([r('five_hour', 20, NOW - 16 * 60_000)], NOW)
  assert.equal(stale.stale, true)
  assert.match(stale.note!, /16 min ago/)

  assert.equal(limitsOf([], NOW).value, null)

  // Across sessions, through the hub: the later report wins.
  let now = NOW
  const hub = new ModHub({ now: () => now })
  hub.report(parseReport(report({ rateLimits: [{ kind: 'five_hour', usedPct: 30, resetsAt: NOW + 3_600_000 }] }), SID))
  now += 1000
  hub.report(parseReport(report({ sessionId: 'b', rateLimits: [{ kind: 'five_hour', usedPct: 31, resetsAt: NOW + 3_600_000 }] }), 'b'))
  assert.equal(limitsOf(hub.limitReadings(), now).value![0]!.usedPct, 31)
})

test("usage: today's spend sums each session's latest cost seen today, with a note on what it measures", () => {
  const yesterday = NOW - 86_400_000
  const s = spendOf(
    [
      { usd: 1.25, at: NOW - 1000 },
      { usd: 2.5, at: NOW - 2000 },
      { usd: 99, at: yesterday },
    ],
    NOW,
  )
  assert.equal(s.value, 3.75)
  assert.match(s.note!, /API rates/)
  assert.equal(spendOf([], NOW).value, null)

  let now = NOW
  const hub = new ModHub({ now: () => now })
  hub.report(parseReport(report({ costUsd: 1 }), SID))
  hub.report(parseReport(report({ costUsd: 1.5 }), SID))
  assert.equal(spendOf(hub.spend(), now).value, 1.5, 'the latest cost of a session, not a sum of its reports')
  // A session that dropped still counts today.
  now += 60_000
  assert.equal(hub.live().length, 0)
  assert.equal(spendOf(hub.spend(), now).value, 1.5)
})

test('adapter: a changed report is pushed at once, not on the next tick; the install hint shows until one arrives', async () => {
  const hub = new ModHub({ log })
  const a = new ClaudeAdapter(hub, { log, tickMs: 60_000 })
  const got: FleetUpdate[] = []
  const off = a.subscribe(u => got.push(u))
  await new Promise(r => setTimeout(r, 20))
  assert.equal(got.length, 1)
  assert.ok(got[0]!.ok && got[0]!.fleet.warnings.includes(INSTALL_HINT))
  hub.report(parseReport(report(), SID))
  await new Promise(r => setTimeout(r, 200))
  assert.equal(got.length, 2)
  assert.ok(got[1]!.ok && got[1]!.fleet.sessions.length === 1 && !got[1]!.fleet.warnings.length)
  off()
  a.close()
})

// ---------------------------------------------------------------- sending

async function live(o: ConstructorParameters<typeof ModHub>[0] = {}) {
  const x = await listener(o)
  assert.equal((await call(x.url, 'POST', `/mod/v1/session${src()}`, { body: report() })).status, 204)
  const adapter = new ClaudeAdapter(x.hub, { log })
  after(() => adapter.close())
  return { ...x, adapter }
}

test('send: the message reaches an open inbox poll at once, and an ok ack gives "Delivered."', async () => {
  const { url, adapter } = await live()
  const poll = call(url, 'GET', `/mod/v1/inbox${src()}`)
  await new Promise(r => setTimeout(r, 30))
  const sent = adapter.send(SID, 'run the tests again', 'card-0001-abcdef')
  const p = await poll
  assert.equal(p.status, 200)
  assert.equal(p.body.items.length, 1)
  assert.equal(p.body.items[0].text, 'run the tests again')
  const id = p.body.items[0].id
  assert.match(id, /^[0-9a-f-]{36}$/)
  // An ack from another session settles nothing.
  assert.equal((await call(url, 'POST', `/mod/v1/ack${src('intruder')}`, { body: { id, ok: true } })).status, 204)
  assert.equal((await call(url, 'POST', `/mod/v1/ack${src()}`, { body: { id, ok: 'yes' } })).status, 400)
  assert.equal((await call(url, 'POST', `/mod/v1/ack${src()}`, { body: { id, ok: true } })).status, 204)
  assert.deepEqual(await sent, { ok: true, said: 'Delivered.' })
  // The same request id gives the same message id, so the mod's memory catches a retry after a restart.
  const again = adapter.send(SID, 'run the tests again', 'card-0001-abcdef')
  const p2 = await call(url, 'GET', `/mod/v1/inbox${src()}`)
  assert.equal(p2.body.items[0].id, id)
  await call(url, 'POST', `/mod/v1/ack${src()}`, { body: { id, ok: true } })
  await again
})

test('send: a message queued before the poll is collected by the next poll', async () => {
  const { url, adapter } = await live()
  const sent = early(adapter.send(SID, 'hello'))
  const p = await call(url, 'GET', `/mod/v1/inbox${src()}`)
  assert.equal(p.status, 200)
  await call(url, 'POST', `/mod/v1/ack${src()}`, { body: { id: p.body.items[0].id, ok: true } })
  assert.equal((await sent).said, 'Delivered.')
})

test('send: the ack names how the session took it, and an unknown word reads as plain delivered', async () => {
  const { url, adapter } = await live()
  const said: string[] = []
  for (const delivery of ['queued', 'started', 'teleported']) {
    const sent = early(adapter.send(SID, `message ${delivery}`))
    const p = await call(url, 'GET', `/mod/v1/inbox${src()}`)
    await call(url, 'POST', `/mod/v1/ack${src()}`, { body: { id: p.body.items[0].id, ok: true, delivery } })
    said.push((await sent).said)
  }
  assert.deepEqual(said, ['Queued behind the current turn.', 'Started.', 'Delivered.'])
})

test('send: an empty inbox poll is held, then answered 204', async () => {
  const { url } = await live({ pollHoldMs: 80 })
  const t = Date.now()
  const p = await call(url, 'GET', `/mod/v1/inbox${src()}`)
  assert.equal(p.status, 204)
  assert.ok(Date.now() - t >= 70)
})

test('send: ok:false is a 502 refusal carrying the reason', async () => {
  const { url, adapter } = await live()
  const sent = early(adapter.send(SID, 'hello'))
  const p = await call(url, 'GET', `/mod/v1/inbox${src()}`)
  await call(url, 'POST', `/mod/v1/ack${src()}`, { body: { id: p.body.items[0].id, ok: false, reason: 'prompt.submit threw' } })
  await assert.rejects(sent, (e: unknown) => e instanceof SendRefused && e.status === 502 && /prompt\.submit threw/.test(e.message) && /Nothing was sent/.test(e.message))
})

test('send: collected and not acked in time is a plain error (the server makes it a 504, outcome unknown)', async () => {
  const { url, adapter } = await live({ ackTimeoutMs: 120 })
  const sent = early(adapter.send(SID, 'hello'))
  const p = await call(url, 'GET', `/mod/v1/inbox${src()}`)
  assert.equal(p.status, 200)
  await assert.rejects(sent, (e: unknown) => e instanceof Error && !(e instanceof SendRefused) && /may still arrive/.test(e.message))
  // A late ack changes nothing and is answered.
  assert.equal((await call(url, 'POST', `/mod/v1/ack${src()}`, { body: { id: p.body.items[0].id, ok: true } })).status, 204)
})

test('send: never collected in time is withdrawn and refused, since it surely was not sent', async () => {
  const { url, adapter } = await live({ ackTimeoutMs: 80 })
  await assert.rejects(adapter.send(SID, 'hello'), (e: unknown) => e instanceof SendRefused && e.status === 502 && /withdrawn/.test(e.message))
  // And it is gone: the next poll does not get it.
  const p = await call(url, 'GET', `/mod/v1/inbox${src()}`)
  assert.equal(p.status, 204)
})

test('send: a queued message is refused when its session ends or expires; a collected one is unknown', async () => {
  let now = Date.now()
  const { url, adapter, hub } = await live({ now: () => now, pollHoldMs: 5000 })
  const queued = early(adapter.send(SID, 'one'))
  assert.equal((await call(url, 'DELETE', `/mod/v1/session${src()}`)).status, 204)
  await assert.rejects(queued, (e: unknown) => e instanceof SendRefused && /before it collected/.test(e.message))
  await assert.rejects(adapter.send(SID, 'two'), (e: unknown) => e instanceof SendRefused && e.status === 404)

  await call(url, 'POST', `/mod/v1/session${src()}`, { body: report() })
  const handed = early(adapter.send(SID, 'three'))
  assert.equal((await call(url, 'GET', `/mod/v1/inbox${src()}`)).status, 200)
  now += 31_000
  hub.sweep()
  await assert.rejects(handed, (e: unknown) => e instanceof Error && !(e instanceof SendRefused) && /may still arrive/.test(e.message))
})

test('send: unknown session and bad text are refused before anything is queued', async () => {
  const { adapter } = await live()
  await assert.rejects(adapter.send('nobody', 'hi'), (e: unknown) => e instanceof SendRefused && e.status === 404)
  await assert.rejects(adapter.send(SID, '   '), (e: unknown) => e instanceof SendRefused && e.status === 400)
  await assert.rejects(adapter.send(SID, 'x'.repeat(4001)), (e: unknown) => e instanceof SendRefused && e.status === 400)
})

// ---------------------------------------------------------------- transcripts

const projects = join(dir, 'projects')
const proj = join(projects, '-work-claudevr')
mkdirSync(proj, { recursive: true })
const outside = join(dir, 'outside')
mkdirSync(outside, { recursive: true })

const JSONL = [
  { type: 'custom-title', customTitle: 'x', sessionId: SID },
  { type: 'user', message: { role: 'user', content: 'run the tests<system-reminder>hidden</system-reminder>' } },
  { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'meta caveat' }] } },
  { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] } },
  { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Running them.' }] } },
  { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
  { type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'All green.' }] } },
  { type: 'assistant', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'Shall I commit?' }] } },
  { type: 'assistant', isSidechain: true, message: { id: 'm3', role: 'assistant', content: [{ type: 'text', text: 'sub-agent chatter' }] } },
  { type: 'user', message: { role: 'user', content: '<command-name>/compact</command-name>' } },
  { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'summary of before' } },
  { type: 'user', message: { role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'look at this' }] } },
  { type: 'assistant', message: { id: 'm4', role: 'assistant', content: [{ type: 'text', text: 'L'.repeat(13_000) }] } },
]
  .map(o => JSON.stringify(o))
  .join('\n')

test('transcript: Claude Code jsonl becomes turns; tools, thinking, meta and sidechains are skipped', () => {
  const turns = turnsOfJsonl(JSONL + '\n{broken\n')
  assert.deepEqual(
    turns.slice(0, 4).map(t => [t.role, t.text]),
    [
      ['you', 'run the tests'],
      ['session', 'Running them.'],
      ['session', 'All green.\n\nShall I commit?'],
      ['you', 'look at this'],
    ],
  )
  assert.equal(turns.length, 5)
  assert.equal(turns[4]!.clipped, true)
  assert.equal(turns[4]!.text.length, 12_001)
})

test('transcript: read only under the projects folder, as a .jsonl, symlinks resolved', async () => {
  const good = join(proj, `${SID}.jsonl`)
  writeFileSync(good, JSONL)
  const secret = join(outside, 'secret.jsonl')
  writeFileSync(secret, JSONL)
  const link = join(proj, 'escape.jsonl')
  symlinkSync(secret, link)
  const dirLink = join(projects, 'sneaky')
  symlinkSync(outside, dirLink)

  assert.ok((await confinedPath(good, projects)).endsWith(`${SID}.jsonl`))
  for (const p of [secret, link, join(dirLink, 'secret.jsonl'), join(proj, '..', '..', 'outside', 'secret.jsonl'), join(proj, 'notes.txt'), '/etc/passwd']) {
    await assert.rejects(confinedPath(p, projects), (e: unknown) => e instanceof SendRefused, p)
  }

  const hub = new ModHub()
  const a = new ClaudeAdapter(hub, { log, projectsDir: projects })
  hub.report(parseReport(report({ transcriptPath: good }), SID))
  const t = await a.transcript(SID, 3)
  assert.equal(t.turns.length, 3)
  assert.equal(t.turns.at(-1)!.text.slice(0, 3), 'LLL')
  hub.report(parseReport(report({ transcriptPath: link }), SID))
  await assert.rejects(a.transcript(SID, 3), (e: unknown) => e instanceof SendRefused && e.status === 403)
  await assert.rejects(a.transcript('nobody', 3), (e: unknown) => e instanceof SendRefused && e.status === 404)
})

test('transcript: only the tail is read, starting at a whole line', async () => {
  const f = join(proj, 'long.jsonl')
  const line = (i: number) => JSON.stringify({ type: 'user', message: { role: 'user', content: `message ${i} ${'p'.repeat(80)}` } })
  writeFileSync(f, Array.from({ length: 200 }, (_, i) => line(i)).join('\n') + '\n')
  const tail = await readTail(f, 1000)
  assert.ok(Buffer.byteLength(tail) <= 1000)
  const turns = turnsOfJsonl(tail)
  assert.ok(turns.length > 0 && turns.length < 20)
  assert.match(turns.at(-1)!.text, /^message 199 /)
  assert.ok(turns.every(t => /^message \d+ p+$/.test(t.text)), 'no half line at the start')
})

// ---------------------------------------------------------------- discovery file

test('discovery file: 0600 in a 0700 folder, written whole, removed on close only while it is ours', async () => {
  const { l, url, bridgeFile } = await listener()
  const st = statSync(bridgeFile)
  assert.equal(st.mode & 0o777, 0o600)
  assert.equal(statSync(join(bridgeFile, '..')).mode & 0o777, 0o700)
  const d = JSON.parse(readFileSync(bridgeFile, 'utf8'))
  assert.equal(d.v, 1)
  assert.equal(d.url, url)
  assert.match(d.url, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal(d.token, TOKEN)
  assert.equal(d.pid, process.pid)
  await l.close()
  assert.equal(existsSync(bridgeFile), false)

  // Another bridge wrote its own since: left alone.
  const other = join(dir, 'other', 'bridge.json')
  writeBridgeFile(other, { v: 1, url: 'http://127.0.0.1:1', token: 'f'.repeat(64), pid: 1, startedAt: 1 }, false)
  assert.equal(removeBridgeFile(other, TOKEN), false)
  assert.equal(existsSync(other), true)
})

test('discovery file: a fresh random token each start when none is given, and never in the log', async () => {
  const before = seen.length
  const tokens = new Set<string>()
  for (let i = 0; i < 2; i++) {
    const bridgeFile = join(dir, `fresh-${i}`, 'bridge.json')
    const l = new ModListener({ hub: new ModHub({ log }), port: 0, bridgeFile, log })
    await l.start()
    const t = JSON.parse(readFileSync(bridgeFile, 'utf8')).token as string
    assert.match(t, /^[0-9a-f]{64}$/)
    tokens.add(t)
    await l.close()
    for (const line of seen.slice(before)) assert.ok(!line.includes(t), `token in log: ${line}`)
  }
  assert.equal(tokens.size, 2)
})

// ---------------------------------------------------------------- config

test('config: backend claude, mod.port from env (0 = off) and the bridge file override', () => {
  const env = { CLAUDEVR_STATE_DIR: join(dir, 'nostate'), CLAUDEVR_BACKEND: 'claude' }
  const c = loadConfig(env)
  assert.equal(c.backend, 'claude')
  assert.equal(c.mod.port, 8444)
  assert.match(c.mod.bridgeFile, /\.claudevr\/bridge\.json$/)
  assert.equal(loadConfig({ ...env, CLAUDEVR_MOD_PORT: '0' }).mod.port, 0)
  assert.equal(loadConfig({ ...env, CLAUDEVR_MOD_PORT: '9001', CLAUDEVR_BRIDGE_FILE: join(dir, 'b.json') }).mod.bridgeFile, join(dir, 'b.json'))
  assert.throws(() => loadConfig({ ...env, CLAUDEVR_MOD_PORT: '70000' }), /mod\.port/)
  assert.equal(loadConfig({ CLAUDEVR_STATE_DIR: join(dir, 'nostate') }).backend, 'fake')
})
