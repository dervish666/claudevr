// A Claude Code session's turns from its own .jsonl transcript. The path
// comes from the mod's report, so it is untrusted: the file is read only when
// its real path (symlinks resolved) sits under ~/.claude/projects/ and ends
// .jsonl, and only its last 2 MiB.
//
// The transcript's shape, as Claude Code writes it: one JSON object a line.
// `type: "user"` lines carry the person's prompt in message.content (a
// string, or blocks of which the text ones count); `type: "assistant"` lines
// carry one content block each, several lines sharing a message.id. Tool
// calls, tool results, thinking, meta lines (isMeta), compaction summaries,
// sidechains (sub-agents) and the bookkeeping types (api-request, cost-state,
// attachment...) are skipped.

import { open, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import type { Turn } from '../../../../shared/protocol.ts'
import { TURN_MAX } from '../dashweb/adapter.ts'
import { SendRefused } from '../types.ts'

export const TAIL_BYTES = 2 * 1024 * 1024
export const DEFAULT_PROJECTS_DIR = join(homedir(), '.claude', 'projects')

/** Lines that start with these are Claude Code's own wrapping of a slash command or a notice, not something the person said. */
const NOT_SAID = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|task-notification|user-prompt-submit-hook|bash-input|bash-stdout|bash-stderr)>/
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The real path of `p` when it is a .jsonl under `projectsDir`; otherwise a
 * SendRefused saying why not. `projectsDir` is resolved too, so a projects
 * folder that is itself a symlink still works.
 */
export async function confinedPath(p: string, projectsDir = DEFAULT_PROJECTS_DIR): Promise<string> {
  if (!p.endsWith('.jsonl')) throw new SendRefused('the session reported a transcript path that is not a .jsonl file', 403)
  let root: string
  let real: string
  try {
    root = await realpath(projectsDir)
  } catch {
    throw new SendRefused(`no Claude Code projects folder at ${projectsDir}`, 404)
  }
  try {
    real = await realpath(p)
  } catch {
    throw new SendRefused('the session\'s transcript file is not there (yet)', 404)
  }
  if (!real.startsWith(root + sep) || !real.endsWith('.jsonl')) throw new SendRefused('the session reported a transcript outside ~/.claude/projects; not read', 403)
  return real
}

/** The file's last `max` bytes, starting at a whole line. */
export async function readTail(real: string, max = TAIL_BYTES): Promise<string> {
  // O_NOFOLLOW: the path was just resolved, so a symlink here now is a swap.
  const fh = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const st = await fh.stat()
    if (!st.isFile()) throw new SendRefused('the session\'s transcript is not a regular file', 403)
    const start = Math.max(0, st.size - max)
    const len = st.size - start
    const buf = Buffer.alloc(len)
    let got = 0
    while (got < len) {
      const { bytesRead } = await fh.read(buf, got, len - got, start + got)
      if (!bytesRead) break
      got += bytesRead
    }
    let text = buf.subarray(0, got).toString('utf8')
    if (start > 0) {
      const nl = text.indexOf('\n')
      text = nl === -1 ? '' : text.slice(nl + 1)
    }
    return text
  } finally {
    await fh.close()
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(isObj)
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => String(b.text))
    .join('\n\n')
}

function turn(role: Turn['role'], text: string): Turn {
  const cut = text.length > TURN_MAX
  return { role, text: cut ? `${text.slice(0, TURN_MAX)}…` : text, clipped: cut }
}

/** Claude Code jsonl -> turns, oldest first. Lines that do not parse are skipped. */
export function turnsOfJsonl(text: string): Turn[] {
  const out: { role: Turn['role']; text: string; msgId: string | null }[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let o: unknown
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObj(o) || (o.type !== 'user' && o.type !== 'assistant')) continue
    if (o.isMeta === true || o.isSidechain === true || o.isCompactSummary === true || o.isVisibleInTranscriptOnly === true) continue
    const msg = isObj(o.message) ? o.message : null
    if (!msg) continue
    if (o.type === 'user') {
      const said = textOf(msg.content).replace(REMINDER, '').trim()
      if (!said || NOT_SAID.test(said)) continue
      out.push({ role: 'you', text: said, msgId: null })
    } else {
      const said = textOf(msg.content).trim()
      if (!said) continue
      const msgId = typeof msg.id === 'string' ? msg.id : null
      const prev = out.at(-1)
      // One assistant message is written as one line per block: its text blocks are one turn.
      if (prev && prev.role === 'session' && msgId && prev.msgId === msgId) prev.text += `\n\n${said}`
      else out.push({ role: 'session', text: said, msgId })
    }
  }
  return out.map(t => turn(t.role, t.text))
}
