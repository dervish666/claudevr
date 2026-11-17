// The claudevr mod: tells the ClaudeVR bridge on this machine what this
// session is doing, and submits the messages the HUD sends it. The wire
// contract is docs/mod-protocol.md in the claudevr repository.
//
// What the session is doing lives in $.state (a hot reload keeps it); the
// link to the bridge lives in module variables (a reload starts it over,
// which costs one re-read of bridge.json).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, HttpResponse, Register, SessionUsage } from 'claude-code'

import type { ClaudevrLive } from '../types'
import {
  EMPTY_LIVE,
  SRC,
  actionOf,
  addMessage,
  askingOf,
  buildReport,
  isDue,
  lastLineOf,
  oneLine,
  parseBridge,
  pickAgents,
  remember,
  upsertCall,
} from './report'

type Engine = EngineInterface

const live = atom({ plugin: 'claudevr', key: 'live' } as const, EMPTY_LIVE, { shape: 'live-1' })
const sent = atom({ plugin: 'claudevr', key: 'sent' } as const, [] as string[], { shape: 'sent-1' })

const TICK_MS = 1_000
const RETRY_MS = 10_000
const TITLE_MS = 10_000
const KEEP_AGENTS = 30

const reason = (err: unknown) => oneLine(err instanceof Error ? err.message : String(err), 200)
const debug = ($: Engine, text: string) => $.ui.log(`claudevr: ${text}`, { to: 'debug' })

// ---------------------------------------------------------------- The link

const link = {
  url: '',
  token: '',
  // up: the last request was answered; down: the bridge is missing or unreachable.
  state: 'unknown' as 'unknown' | 'up' | 'down',
  retryAt: 0,
  lastError: '',
  authRetried: false,
  lastReportAt: 0,
}

function linkUp($: Engine): void {
  link.authRetried = false
  link.lastError = ''
  if (link.state !== 'up') debug($, `linked to the bridge at ${link.url}`)
  link.state = 'up'
}

// Down for now: drop the token so the next try reads bridge.json again (a
// restarted bridge has a new token and maybe a new port), and wait 10 s.
function linkDown($: Engine, why: string, now: number): void {
  link.token = ''
  link.retryAt = now + RETRY_MS
  link.lastError = why
  if (link.state !== 'down') debug($, `${why}; trying again every 10 s`)
  link.state = 'down'
}

async function bridgeFile($: Engine): Promise<string> {
  const named = await $.env.get('CLAUDEVR_BRIDGE_FILE')
  if (named) return named
  const home = await $.env.get('HOME')
  if (!home) throw new Error('HOME is not set')
  return `${home}/.claudevr/bridge.json`
}

// Ready to talk to the bridge: a token in hand, or bridge.json read for one.
async function ensureLink($: Engine, now: number): Promise<boolean> {
  if (link.token) return true
  if (now < link.retryAt) return false
  let text: string
  try {
    text = await $.fs.read(await bridgeFile($))
  } catch {
    linkDown($, 'no bridge running (bridge.json not found)', now)
    return false
  }
  const found = parseBridge(text)
  if ('error' in found) {
    linkDown($, found.error, now)
    return false
  }
  link.url = found.url
  link.token = found.token
  return true
}

// One request to the bridge. Answers the response, or nothing when the
// bridge could not be reached or refused the token (both handled here).
async function call($: Engine, src: string, method: string, path: string, body?: unknown): Promise<HttpResponse | undefined> {
  if (!link.token) return undefined
  const token = link.token
  let res: HttpResponse
  try {
    res = await $.http.fetch(`${link.url}${path}?src=${encodeURIComponent(src)}`, {
      method,
      headers: { 'x-claudevr-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    })
  } catch (err) {
    linkDown($, `bridge at ${link.url} not reachable: ${reason(err)}`, await $.clock.now())
    return undefined
  }
  if (res.status === 401) {
    // A new bridge wrote a new token: read the file again at once. A second
    // 401 straight after a fresh read waits the usual 10 s.
    const now = await $.clock.now()
    if (link.token === token) link.token = ''
    if (link.authRetried) linkDown($, 'the bridge refused the token in bridge.json', now)
    else link.retryAt = now
    link.authRetried = true
    return undefined
  }
  return res
}

// ---------------------------------------------------------------- Publishing

const session = { id: '', root: '', transcriptPath: null as string | null, title: '', titleAt: 0 }
const last = { body: '', at: 0 }

// The session's .jsonl under ~/.claude/projects: the folder is the start
// directory with every other character turned to '-'; failing that, any
// project folder that holds the id's file.
async function findTranscript($: Engine, id: string, dirs: string[]): Promise<string | null> {
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) ?? ''}/.claude`
  const projects = `${config}/projects`
  for (const dir of dirs) {
    const path = `${projects}/${dir.replace(/[^A-Za-z0-9]/g, '-')}/${id}.jsonl`
    if (await $.fs.exists(path).catch(() => false)) return path
  }
  const all = await $.fs.list(projects).catch(() => [])
  for (const entry of all) {
    if (entry.kind !== 'dir') continue
    const path = `${projects}/${entry.name}/${id}.jsonl`
    if (await $.fs.exists(path).catch(() => false)) return path
  }
  return null
}

// The /rename title: no noun answers it; the transcript keeps it as its
// newest custom-title row.
const TITLE = String.raw`"customTitle":"([^"\\]|\\.)*"`
async function readTitle($: Engine, path: string): Promise<string> {
  const { stdout } = await $.process.run(['grep', '-oE', TITLE, path], { timeoutMs: 5_000 })
  const row = stdout.trim().split('\n').at(-1)
  if (!row) return ''
  try {
    const value = (JSON.parse(`{${row}}`) as { customTitle?: unknown }).customTitle
    return typeof value === 'string' ? oneLine(value, 200) : ''
  } catch {
    return ''
  }
}

async function refreshSession($: Engine, now: number): Promise<void> {
  const [id, root] = await Promise.all([$.session.id(), $.session.root()])
  if (id !== session.id) {
    Object.assign(session, { id, root, transcriptPath: null, title: '', titleAt: 0 })
    last.body = ''
    session.transcriptPath = await findTranscript($, id, [root, await $.session.cwd()]).catch(() => null)
  }
  session.root = root
  if (session.transcriptPath && now - session.titleAt >= TITLE_MS) {
    session.titleAt = now
    session.title = await readTitle($, session.transcriptPath).catch(() => session.title)
  }
}

async function publish($: Engine, now: number): Promise<void> {
  await refreshSession($, now)
  if (!SRC.test(session.id)) {
    if (link.lastError !== 'session id not usable as src') debug($, 'the session id is not one the bridge takes; not reporting')
    link.lastError = 'session id not usable as src'
    return
  }
  const [state, cwd, usage] = await Promise.all([
    read($, live),
    $.session.cwd(),
    $.session.usage().catch((): SessionUsage | null => null),
  ])
  const report = buildReport({ sessionId: session.id, root: session.root, title: session.title, cwd, transcriptPath: session.transcriptPath, live: state, usage, now })
  const body = JSON.stringify(report)
  if (!isDue(body, last, now)) return
  const res = await call($, session.id, 'POST', '/mod/v1/session', body)
  if (!res) return
  last.at = now
  if (res.ok) {
    last.body = body
    link.lastReportAt = now
    linkUp($)
    return
  }
  // A 400 or 413 is this mod's fault, not the bridge being away.
  const why = `the bridge answered a report with HTTP ${res.status}`
  if (link.lastError !== why) debug($, why)
  link.lastError = why
}

// ---------------------------------------------------------------- The inbox

let polling = false

type Delivery = 'started' | 'queued'
async function ack($: Engine, src: string, id: string, ok: boolean, why?: string, delivery?: Delivery): Promise<void> {
  const res = await call($, src, 'POST', '/mod/v1/ack', ok ? { id, ok: true, ...(delivery ? { delivery } : {}) } : { id, ok: false, reason: oneLine(why ?? 'not submitted', 300) })
  if (res && !res.ok) debug($, `ack for a message not taken: HTTP ${res.status}`)
}

// Submits one message as the person's own words, once: a repeat of an id
// already submitted is acked without going in again.
async function deliver($: Engine, src: string, raw: unknown): Promise<void> {
  const item = (raw ?? {}) as { id?: unknown; text?: unknown }
  if (typeof item.id !== 'string' || !item.id) return
  const id = item.id
  if (typeof item.text !== 'string' || !item.text.trim()) return ack($, src, id, false, 'the message has no text')
  let isNew = false
  await update($, sent, ids => {
    const r = remember(ids, id)
    isNew = r.isNew
    return r.ids
  })
  if (!isNew) return ack($, src, id, true)
  // $.prompt.submit resolves only once the message's turn starts. A busy
  // session takes it behind the current turn, which can outlast the bridge's
  // 30 s ack wait, so that case is acked as queued at once. A later refusal
  // can no longer reach the HUD; it goes to the debug log.
  if ((await read($, live)).busy) {
    void $.prompt.submit({ text: item.text, asUser: true }).then(
      r => {
        if (r.drop !== undefined) debug($, `a queued message was dropped: ${r.drop || 'by a hook'}`)
      },
      err => debug($, `a queued message failed: ${reason(err)}`),
    )
    return ack($, src, id, true, undefined, 'queued')
  }
  let dropped: string | undefined
  try {
    const r = await $.prompt.submit({ text: item.text, asUser: true })
    if (r.drop !== undefined) dropped = r.drop || 'a hook dropped the prompt'
  } catch (err) {
    dropped = `submit failed: ${reason(err)}`
  }
  if (dropped !== undefined) {
    // Nothing went in, so the id is free to be tried again.
    await update($, sent, ids => ids.filter(x => x !== id))
    return ack($, src, id, false, dropped)
  }
  return ack($, src, id, true, undefined, 'started')
}

async function poll($: Engine, src: string): Promise<void> {
  polling = true
  try {
    const res = await call($, src, 'GET', '/mod/v1/inbox')
    if (!res || res.status === 204) return
    if (res.status !== 200) {
      const why = `the inbox answered HTTP ${res.status}`
      if (link.lastError !== why) debug($, why)
      link.lastError = why
      return
    }
    let items: unknown
    try {
      items = (JSON.parse(res.text) as { items?: unknown }).items
    } catch {
      debug($, 'the inbox answered something that is not JSON')
      return
    }
    // Not awaited: a busy session takes a message as its next turn, and the
    // poll goes on collecting meanwhile.
    for (const item of Array.isArray(items) ? items : []) void deliver($, src, item).catch(err => debug($, `delivery failed: ${reason(err)}`))
  } finally {
    polling = false
  }
}

// ---------------------------------------------------------------- The loop

let ticking = false
async function tick($: Engine): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const now = await $.clock.now()
    if (!(await ensureLink($, now))) return
    await publish($, now)
    // The inbox only once the bridge has this session: it drops one it has not heard from.
    if (link.state === 'up' && link.token && !polling && session.id) void poll($, session.id).catch(err => debug($, `inbox poll failed: ${reason(err)}`))
  } finally {
    ticking = false
  }
}

// Timers die with the module's environment on a hot reload, and a mod first
// loaded mid-session sees no session.start, so every hook arms them.
let armed = false
function arm($: Engine): void {
  if (armed) return
  armed = true
  $.clock.every(TICK_MS, () => {
    tick($).catch(err => debug($, `tick failed: ${reason(err)}`))
  })
  $.command
    .register({ name: 'claudevr', description: 'Say whether this session is linked to the ClaudeVR bridge' })
    .catch(err => debug($, `command.register failed: ${reason(err)}`))
}

async function touch($: Engine, fn: (l: ClaudevrLive, now: number) => ClaudevrLive): Promise<void> {
  const now = await $.clock.now()
  await update($, live, l => ({ ...fn(l, now), activeAt: now }))
}

const quietly = ($: Engine, what: string, work: Promise<unknown>) => work.catch(err => debug($, `${what} failed: ${reason(err)}`))

async function statusText($: Engine): Promise<string> {
  const now = await $.clock.now()
  if (link.state === 'up' && link.token) {
    const ago = Math.max(0, Math.round((now - link.lastReportAt) / 1000))
    return `Linked to the ClaudeVR bridge at ${link.url}. Last report ${ago} s ago.${link.lastError ? ` Last error: ${link.lastError}.` : ''}`
  }
  if (link.state === 'unknown') return 'Not linked yet: the first try is under way.'
  return `Not linked: ${link.lastError || 'the bridge is not running'}. Trying again every 10 s.`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    arm($)
    return next(e)
  })

  // A /clear ends this session's id; the next tick reports under the new one.
  on('session.end', async ($, e, next) => {
    arm($)
    const src = session.id || e.sessionId
    if (link.token && SRC.test(src)) await quietly($, 'session drop', call($, src, 'DELETE', '/mod/v1/session'))
    session.id = ''
    last.body = ''
    await quietly($, 'reset', update($, live, () => EMPTY_LIVE))
    return next(e)
  })

  on('command.run', { command: 'claudevr' }, async $ => ({ text: await statusText($) }))

  on('turn.start', async ($, e, next) => {
    arm($)
    const id = e.agentId
    await quietly(
      $,
      'turn start note',
      touch($, (l, now) =>
        id === undefined
          ? { ...l, busy: true, failed: false, calls: [], messages: addMessage(l.messages, 'you', e.text, now) }
          : { ...l, agents: l.agents.map(a => (a.id === id ? { ...a, state: 'running' as const, endedAt: null } : a)) },
      ),
    )
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    arm($)
    const id = e.agentId
    const failed = e.reason === 'error' || e.reason === 'refusal'
    await quietly(
      $,
      'turn end note',
      touch($, (l, now) => {
        if (id !== undefined) {
          const agents = l.agents.map(a =>
            a.id === id ? { ...a, state: failed || e.isAborted ? ('failed' as const) : ('done' as const), endedAt: now, now: lastLineOf(e.answer) ?? a.now } : a,
          )
          return { ...l, agents }
        }
        return {
          ...l,
          busy: false,
          failed,
          calls: [],
          lastLine: lastLineOf(e.answer) ?? l.lastLine,
          messages: addMessage(l.messages, 'session', e.answer, now),
        }
      }),
    )
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    arm($)
    const r = await next(e)
    const id = r.agentId
    if (r.deny !== undefined || !id) return r
    await quietly(
      $,
      'agent note',
      touch($, (l, now) => {
        const agent = { id, type: e.subagentType, description: oneLine(e.description, 200), model: r.model || null, state: 'running' as const, startedAt: now, endedAt: null, now: null }
        return { ...l, agents: pickAgents([...l.agents.filter(a => a.id !== id), agent], KEEP_AGENTS) }
      }),
    )
    return r
  }).catch(($, e, next) => next(e))

  // Each of these three only watches: one that fails lets what it watched go on.
  on('tool.call', async ($, e, next) => {
    arm($)
    const tool = String(e.tool)
    const args = e as unknown as Record<string, unknown>
    const action = actionOf(tool, args)
    const agentId = e.agentId
    const id = e.tool_use_id
    await quietly(
      $,
      'tool note',
      touch($, l =>
        agentId !== undefined
          ? { ...l, agents: l.agents.map(a => (a.id === agentId ? { ...a, now: action } : a)) }
          : { ...l, calls: upsertCall(l.calls, { id, action, asking: tool === 'AskUserQuestion' ? askingOf(args) : null, permission: false }) },
      ),
    )
    try {
      return await next(e)
    } finally {
      if (agentId === undefined) await quietly($, 'tool end note', touch($, l => ({ ...l, calls: l.calls.filter(c => c.id !== id) })))
    }
  }).catch(($, e, next) => next(e))

  // A permission prompt waits on the person, so the session is asking.
  on('tool.check', async ($, e, next) => {
    arm($)
    const verdict = await next(e)
    const id = e.tool_use_id
    if (verdict.decision === 'ask' && e.agentId === undefined && id !== undefined) {
      const action = actionOf(e.tool, (e.input ?? {}) as Record<string, unknown>)
      await quietly($, 'ask note', touch($, l => ({ ...l, calls: upsertCall(l.calls, { id, action, asking: null, permission: true }) })))
    }
    return verdict
  }).catch(($, e, next) => next(e))

  // The figures come from $.session.usage() at each report; a measurement
  // only arms the loop for a mod loaded mid-session.
  on('session.measure', async ($, e, next) => {
    arm($)
    return next(e)
  })
}

