// The pure half of the mod: the report built from what the hooks recorded,
// and the small checks the bridge link makes. Nothing here touches `$`.

import type { SessionUsage } from 'claude-code'

import type { ClaudevrAgent, ClaudevrAsking, ClaudevrCall, ClaudevrLive, ClaudevrMessage } from '../types'

export interface ModReport {
  v: 1
  sessionId: string
  project: string
  title: string
  cwd: string
  transcriptPath: string | null
  state: 'working' | 'thinking' | 'asking' | 'idle' | 'failed'
  action: string | null
  lastLine: string | null
  activeAt: number
  startedAt: number
  asking: ClaudevrAsking | null
  messages: ClaudevrMessage[]
  agents: ClaudevrAgent[]
  context: { usedPct: number; tokens: number | null; windowTokens: number | null } | null
  rateLimits: { kind: string; usedPct: number; resetsAt: number | null }[]
  costUsd: number | null
}

export const MAX_MESSAGES = 6
export const MAX_MESSAGE_CHARS = 500
export const MAX_AGENTS = 12
export const REMEMBER_IDS = 50

export const EMPTY_LIVE: ClaudevrLive = {
  busy: false,
  failed: false,
  calls: [],
  lastLine: null,
  activeAt: 0,
  messages: [],
  agents: [],
}

// One line, at most `max` characters, an ellipsis where it was cut.
export function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

// The last line of an answer that has words in it.
export function lastLineOf(text: string): string | null {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const last = lines.at(-1)
  return last ? oneLine(last) : null
}

export function addMessage(list: ClaudevrMessage[], role: ClaudevrMessage['role'], text: string, at: number): ClaudevrMessage[] {
  const trimmed = text.trim()
  if (!trimmed) return list
  return [...list, { role, text: trimmed.slice(0, MAX_MESSAGE_CHARS), at }].slice(-MAX_MESSAGES)
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
const base = (path: string) => path.split('/').filter(Boolean).pop() ?? path

// "Bash: npm test": the tool and the one argument that says what it is doing.
export function actionOf(tool: string, args: Record<string, unknown>): string {
  const arg =
    str(args.command) ??
    (str(args.file_path) ? base(args.file_path as string) : undefined) ??
    (str(args.notebook_path) ? base(args.notebook_path as string) : undefined) ??
    str(args.pattern) ??
    str(args.url) ??
    str(args.query) ??
    str(args.description) ??
    str(args.prompt)
  return oneLine(arg ? `${tool}: ${arg}` : tool, 120)
}

// The first question of an AskUserQuestion call, with its option labels.
export function askingOf(args: Record<string, unknown>): ClaudevrAsking | null {
  const qs = Array.isArray(args.questions) ? (args.questions as unknown[]) : []
  const q = qs[0] as Record<string, unknown> | undefined
  const text = q && str(q.question)
  if (!q || !text) return null
  const options = (Array.isArray(q.options) ? (q.options as unknown[]) : [])
    .map(o => (typeof o === 'string' ? o : str((o as Record<string, unknown> | null)?.label)))
    .filter((o): o is string => typeof o === 'string')
    .map(o => oneLine(o, 120))
  return { text: oneLine(text, 500), options }
}

export function upsertCall(calls: ClaudevrCall[], call: ClaudevrCall): ClaudevrCall[] {
  const at = calls.findIndex(c => c.id === call.id)
  if (at === -1) return [...calls, call]
  const old = calls[at] as ClaudevrCall
  const merged = { ...call, permission: call.permission || old.permission, asking: call.asking ?? old.asking }
  return calls.map((c, i) => (i === at ? merged : c))
}

// Running first, then the newest finished; at most `max`. The report takes
// 12; the store keeps a few more so a burst of finishes loses nothing running.
export function pickAgents(agents: ClaudevrAgent[], max = MAX_AGENTS): ClaudevrAgent[] {
  const running = agents.filter(a => a.state === 'running')
  const finished = agents.filter(a => a.state !== 'running').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  return [...running, ...finished].slice(0, max)
}

export function stateOf(live: ClaudevrLive): { state: ModReport['state']; action: string | null; asking: ClaudevrAsking | null } {
  const asking = live.calls.find(c => c.asking)?.asking ?? null
  const permission = live.calls.find(c => c.permission)
  const current = live.calls.at(-1)
  if (asking) return { state: 'asking', action: current?.action ?? null, asking }
  if (permission) return { state: 'asking', action: permission.action, asking: { text: `Allow ${permission.action}?`, options: [] } }
  if (live.busy) return current ? { state: 'working', action: current.action, asking: null } : { state: 'thinking', action: 'thinking', asking: null }
  if (live.failed) return { state: 'failed', action: null, asking: null }
  const running = live.agents.filter(a => a.state === 'running').length
  if (running) return { state: 'working', action: running === 1 ? '1 agent running' : `${running} agents running`, asking: null }
  return { state: 'idle', action: null, asking: null }
}

export type ReportInput = {
  sessionId: string
  root: string
  title: string
  cwd: string
  transcriptPath: string | null
  live: ClaudevrLive
  usage: SessionUsage | null
  now: number
}

export function buildReport(i: ReportInput): ModReport {
  const { state, action, asking } = stateOf(i.live)
  const u = i.usage
  const startedAt = u?.startedAt ?? i.now
  const ctx = u?.context
  const usedPct = ctx?.percent ?? (ctx?.tokens !== undefined && ctx.window ? Math.round((ctx.tokens / ctx.window) * 100) : undefined)
  return {
    v: 1,
    sessionId: i.sessionId,
    project: base(i.root),
    title: i.title,
    cwd: i.cwd,
    transcriptPath: i.transcriptPath,
    state,
    action,
    lastLine: i.live.lastLine,
    activeAt: Math.max(i.live.activeAt, startedAt),
    startedAt,
    asking,
    messages: i.live.messages.slice(-MAX_MESSAGES),
    agents: pickAgents(i.live.agents),
    context: ctx && usedPct !== undefined ? { usedPct, tokens: ctx.tokens ?? null, windowTokens: ctx.window || null } : null,
    rateLimits: (u?.rateLimits ?? []).map(r => {
      const resets = r.resetsAt === undefined ? NaN : Date.parse(r.resetsAt)
      return { kind: r.kind, usedPct: r.percentUsed, resetsAt: Number.isFinite(resets) ? resets : null }
    }),
    costUsd: u?.cost?.usd ?? null,
  }
}

// ---------------------------------------------------------------- The link

export const SRC = /^[A-Za-z0-9._:-]{1,128}$/
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

export type Bridge = { url: string; token: string }

// Reads bridge.json's text: the bridge to talk to, or why not. A url whose
// host is not loopback is refused so the token never leaves the machine.
export function parseBridge(text: string): Bridge | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { error: 'bridge.json is not JSON' }
  }
  const o = (raw ?? {}) as Record<string, unknown>
  if (o.v !== 1) return { error: 'bridge.json is not version 1' }
  if (typeof o.url !== 'string' || typeof o.token !== 'string' || !o.token) return { error: 'bridge.json has no url or token' }
  const url = loopbackUrl(o.url)
  if (!url) return { error: 'bridge.json names a url that is not plain http on 127.0.0.1, localhost or [::1]; refused' }
  return { url, token: o.token }
}

export function loopbackUrl(text: string): string | undefined {
  let u: URL
  try {
    u = new URL(text)
  } catch {
    return undefined
  }
  if (u.protocol !== 'http:' || u.username || u.password || !LOOPBACK.has(u.hostname)) return undefined
  return `${u.protocol}//${u.host}`
}

// Remembers an id; `isNew` says whether it was already there.
export function remember(ids: readonly string[], id: string): { ids: string[]; isNew: boolean } {
  if (ids.includes(id)) return { ids: [...ids], isNew: false }
  return { ids: [...ids, id].slice(-REMEMBER_IDS), isNew: true }
}

// Whether a report should go now: a change goes at most every 2 s (so within
// 2 s of happening, on a 1 s tick), and the same report every 10 s regardless.
export const CHANGE_GAP_MS = 2_000
export const HEARTBEAT_MS = 10_000
export function isDue(body: string, last: { body: string; at: number }, now: number): boolean {
  const since = now - last.at
  return since >= HEARTBEAT_MS || (body !== last.body && since >= CHANGE_GAP_MS)
}
