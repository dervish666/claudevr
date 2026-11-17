// The report a Claude Code session's claudevr mod posts (docs/mod-protocol.md),
// checked and clipped. The whole report is untrusted: unknown keys are
// dropped, a wrong type makes it a 400, and every string the HUD might show
// is clipped here whatever the mod sent. Nothing in it is ever run.

import { clip } from '../dashweb/normalise.ts'

export type ModState = 'working' | 'thinking' | 'asking' | 'idle' | 'failed'
export type ModAgentState = 'running' | 'done' | 'failed'

export interface ModAgent {
  id: string
  type: string
  description: string
  model: string | null
  state: ModAgentState
  startedAt: number | null
  endedAt: number | null
  now: string | null
}

export interface ModReport {
  v: 1
  sessionId: string
  project: string
  title: string
  cwd: string
  transcriptPath: string | null
  state: ModState
  action: string | null
  lastLine: string | null
  activeAt: number
  startedAt: number
  asking: { text: string; options: string[] } | null
  messages: { role: 'you' | 'session'; text: string; at: number }[]
  agents: ModAgent[]
  context: { usedPct: number; tokens: number | null; windowTokens: number | null } | null
  rateLimits: { kind: string; usedPct: number; resetsAt: number | null }[]
  costUsd: number | null
}

/** A session id as `?src=` and `sessionId` carry it. */
export const SRC = /^[A-Za-z0-9._:-]{1,128}$/

const STATES: ReadonlySet<string> = new Set(['working', 'thinking', 'asking', 'idle', 'failed'])
const AGENT_STATES: ReadonlySet<string> = new Set(['running', 'done', 'failed'])
const ROLES: ReadonlySet<string> = new Set(['you', 'session'])

export const MESSAGES_MAX = 6
export const MESSAGE_TEXT_MAX = 500
export const AGENTS_MAX = 12
const RATE_LIMITS_MAX = 8
const OPTIONS_MAX = 8
const LINE_MAX = 240
const ASK_MAX = 1200
const PATH_MAX = 4096
const AGENT_LINE_MAX = 100
const AGENT_ID_MAX = 80

export class ReportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReportError'
  }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function str(o: Obj, k: string, where: string): string {
  const v = o[k]
  if (typeof v !== 'string') throw new ReportError(`${where}${k}: a string`)
  return v
}
function strOrNull(o: Obj, k: string, where: string): string | null {
  const v = o[k]
  if (v === null || v === undefined) return null
  if (typeof v !== 'string') throw new ReportError(`${where}${k}: a string or null`)
  return v
}
function num(o: Obj, k: string, where: string): number {
  const v = o[k]
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ReportError(`${where}${k}: a finite number`)
  return v
}
function numOrNull(o: Obj, k: string, where: string): number | null {
  const v = o[k]
  if (v === null || v === undefined) return null
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ReportError(`${where}${k}: a finite number or null`)
  return v
}
function list(o: Obj, k: string, where: string): unknown[] {
  const v = o[k]
  if (!Array.isArray(v)) throw new ReportError(`${where}${k}: an array`)
  return v
}
const pct = (n: number) => Math.min(1000, Math.max(0, n))
/** A clipped one-liner, or null for an empty one. */
const line = (s: string | null, max = LINE_MAX): string | null => {
  if (s === null) return null
  const c = clip(s, max)
  return c ? c : null
}
/** Epoch ms. A value small enough to be seconds is taken as seconds. */
const epochMs = (n: number | null): number | null => (n === null ? null : n > 0 && n < 1e11 ? n * 1000 : n)

/** Checks and clips a posted report. Throws ReportError (a 400) when it is not one. */
export function parseReport(raw: unknown, src: string): ModReport {
  if (!isObj(raw)) throw new ReportError('the report must be a JSON object')
  if (raw.v !== 1) throw new ReportError('v: must be 1')
  const sessionId = str(raw, 'sessionId', '')
  if (sessionId !== src) throw new ReportError('sessionId: must be the same as ?src=')
  const state = str(raw, 'state', '')
  if (!STATES.has(state)) throw new ReportError(`state: one of ${[...STATES].join(', ')}`)

  let asking: ModReport['asking'] = null
  if (raw.asking !== null && raw.asking !== undefined) {
    if (!isObj(raw.asking)) throw new ReportError('asking: an object or null')
    const opts = list(raw.asking, 'options', 'asking.')
    if (!opts.every(o => typeof o === 'string')) throw new ReportError('asking.options: strings')
    asking = {
      text: clip(str(raw.asking, 'text', 'asking.'), ASK_MAX) || 'A question is waiting',
      options: (opts as string[]).slice(0, OPTIONS_MAX).map(o => clip(o, 80)).filter(Boolean),
    }
  }

  const messages = list(raw, 'messages', '').map((m, i) => {
    const w = `messages[${i}].`
    if (!isObj(m)) throw new ReportError(`messages[${i}]: an object`)
    const role = str(m, 'role', w)
    if (!ROLES.has(role)) throw new ReportError(`${w}role: "you" or "session"`)
    return { role: role as 'you' | 'session', text: clip(str(m, 'text', w), MESSAGE_TEXT_MAX), at: num(m, 'at', w) }
  })

  const agents = list(raw, 'agents', '').map((a, i): ModAgent => {
    const w = `agents[${i}].`
    if (!isObj(a)) throw new ReportError(`agents[${i}]: an object`)
    const st = str(a, 'state', w)
    if (!AGENT_STATES.has(st)) throw new ReportError(`${w}state: one of ${[...AGENT_STATES].join(', ')}`)
    const id = str(a, 'id', w)
    if (!id) throw new ReportError(`${w}id: not empty`)
    return {
      id: id.slice(0, AGENT_ID_MAX),
      type: clip(str(a, 'type', w), 40) || 'agent',
      description: clip(str(a, 'description', w), AGENT_LINE_MAX) || 'no description',
      model: line(strOrNull(a, 'model', w), 40),
      state: st as ModAgentState,
      startedAt: numOrNull(a, 'startedAt', w),
      endedAt: numOrNull(a, 'endedAt', w),
      now: line(strOrNull(a, 'now', w), AGENT_LINE_MAX),
    }
  })

  let context: ModReport['context'] = null
  if (raw.context !== null && raw.context !== undefined) {
    if (!isObj(raw.context)) throw new ReportError('context: an object or null')
    context = { usedPct: pct(num(raw.context, 'usedPct', 'context.')), tokens: numOrNull(raw.context, 'tokens', 'context.'), windowTokens: numOrNull(raw.context, 'windowTokens', 'context.') }
  }

  const rateLimits = list(raw, 'rateLimits', '').map((l, i) => {
    const w = `rateLimits[${i}].`
    if (!isObj(l)) throw new ReportError(`rateLimits[${i}]: an object`)
    const kind = str(l, 'kind', w)
    if (!/^[\w.-]{1,40}$/.test(kind)) throw new ReportError(`${w}kind: up to 40 letters, digits, "_", "." or "-"`)
    return { kind, usedPct: pct(num(l, 'usedPct', w)), resetsAt: epochMs(numOrNull(l, 'resetsAt', w)) }
  })

  const costUsd = numOrNull(raw, 'costUsd', '')
  const transcriptPath = strOrNull(raw, 'transcriptPath', '')

  return {
    v: 1,
    sessionId,
    project: clip(str(raw, 'project', ''), 80),
    title: clip(str(raw, 'title', ''), 160),
    cwd: str(raw, 'cwd', '').slice(0, PATH_MAX),
    transcriptPath: transcriptPath && transcriptPath.length <= PATH_MAX ? transcriptPath : null,
    state: state as ModState,
    action: line(strOrNull(raw, 'action', '')),
    lastLine: line(strOrNull(raw, 'lastLine', '')),
    activeAt: num(raw, 'activeAt', ''),
    startedAt: num(raw, 'startedAt', ''),
    asking,
    // Newest last, as the mod sends them; only the newest are kept.
    messages: messages.slice(-MESSAGES_MAX),
    agents: agents.slice(0, AGENTS_MAX),
    context,
    rateLimits: rateLimits.slice(0, RATE_LIMITS_MAX),
    costUsd: costUsd !== null && costUsd >= 0 ? costUsd : null,
  }
}
