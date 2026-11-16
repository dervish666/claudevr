// Spoken names for sessions. "Tell Tally to run the tests" has to land on one
// thread, so every live session gets a short ordinary word taken from its
// project, unique across the fleet.
//
// The rule, in order:
//   1. The first word of the project name ("tally-reading" -> "Tally",
//      "ClaudeVR" -> "Claude"), else of the title, else "Session".
//   2. Two sessions on the same first word but different projects use the
//      whole project name ("Claude" and "Claude VR").
//   3. Whatever still collides goes by start time: the oldest keeps the
//      plain name. A later one takes a word from its own title when that
//      gives a free name ("T-422 gt: management session" -> "GT"), since
//      "Claude Two" says nothing about what the session is for. Only when
//      the title has no such word is it numbered: "Two", then "Three".
//
// Two adjustments sit on top:
//   - A word the voice grammar treats as a command ("status", "read",
//     "cancel"...) is never a callsign's first word: "read-later" becomes
//     "Later", since "read later" would be heard as "read X".
//   - The private config can name a session's callsign outright (an
//     override, matched on session id or project). Overrides claim their
//     names first; a derived callsign that meets one moves aside.

import type { Fleet } from '../../../shared/protocol.ts'
import { CONFIRM_CANCEL_WORDS, FILLERS } from '../voice/grammar.ts'

export interface CallsignInput {
  id: string
  project: string | null
  title: string
  startedAt: number | null
  /** A role that names itself, like "dispatcher". Wins over the project. */
  role?: string | null
}

/** From the private config: this session or project is called `callsign`. */
export interface CallsignOverride {
  /** A session id, or a project name (case and separators ignored). */
  match: string
  callsign: string
  /** What speech-to-text is known to hear instead ("Jose" for "Claude"). */
  heardAs: string[]
}

/**
 * Words the voice grammar reads as commands, confirmations or cancels. A
 * callsign starting with one would make "read Status" or "tell Send to..."
 * ambiguous, and worse, saying a session called "Yep" while a card is armed
 * would send that card. The confirm and cancel words come from the grammar
 * itself, so the two lists cannot drift apart.
 */
export const COMMAND_WORDS: ReadonlySet<string> = new Set([
  'status', 'switch', 'tell', 'read', 'cancel', 'send', 'confirm', 'confirmed', 'yes', 'no', 'nope', 'stop', 'abort',
  'go', 'ask', 'message', 'show', 'focus', 'open', 'say', 'what', 'ok', 'okay', 'never', 'scrap', 'forget', 'do', 'to', 'that',
  'limits', 'usage', 'voice', 'voices', 'character', 'characters', 'be', 'operator', 'plain',
  ...CONFIRM_CANCEL_WORDS,
])

/** A word the grammar drops ("please", "um") or reads as a command: no callsign may start with one. */
export const reservedWord = (w: string): boolean => COMMAND_WORDS.has(w) || FILLERS.has(w)

/** "ClaudeVR", "claude-vr" and "claude_vr" all compare as "claudevr". */
export const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

export function overrideFor(s: { id: string; project: string | null }, overrides: readonly CallsignOverride[]): CallsignOverride | null {
  return overrides.find(o => o.match === s.id) ?? (s.project ? overrides.find(o => squash(o.match) === squash(s.project!)) : undefined) ?? null
}

/** Drops leading command words: ["read", "later"] -> ["later"]. Empty when nothing else is left. */
function withoutCommandWords(w: string[]): string[] {
  let i = 0
  while (i < w.length && reservedWord(w[i]!.toLowerCase())) i++
  return w.slice(i)
}

const NUMBERS = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']

/** "tally-reading" -> ["tally", "reading"], "ClaudeVR" -> ["Claude", "VR"], "iThink" -> ["iThink"]. */
export function words(name: string): string[] {
  return name
    .replace(/([a-z]{2,})([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z]{2,})([A-Z]{2,})/g, '$1 $2')
    .split(/[^A-Za-z]+/)
    .filter(w => w.length > 0)
}

function speakable(w: string): string {
  // An acronym stays as it is ("VR"); anything else gets a capital first letter.
  if (w.length > 1 && w === w.toUpperCase()) return w
  // So does a name with its own capitals inside ("iThink").
  if (/[A-Z]/.test(w.slice(1))) return w
  return w[0]!.toUpperCase() + w.slice(1)
}

function sourceWords(s: CallsignInput): string[] {
  if (s.role) {
    const r = withoutCommandWords(words(s.role))
    if (r.length) return r
  }
  for (const name of [s.project, s.title]) {
    const w = name ? withoutCommandWords(words(name)) : []
    if (w.length) return w
  }
  return ['Session']
}

/** Words too general to tell one session from another. */
const VAGUE: ReadonlySet<string> = new Set(['the', 'a', 'an', 'and', 'of', 'for', 'in', 'on', 'with', 'my', 'new', 'session', 'sessions', 'thread', 'task', 'chat', 'claude', 'agent', 'manager', 'management', 'untitled'])

/**
 * A name from the session's own title, for when its project's name is taken:
 * the first word that says something. A leading task id ("T-422") is not a word.
 */
export function titleWord(title: string, not: string): string | null {
  const w = withoutCommandWords(words(title.replace(/^\s*[A-Za-z]{1,3}-?\d+\b[\s:.-]*/, '')))
  const pick = w.find(x => x.length > 1 && !VAGUE.has(x.toLowerCase()) && !reservedWord(x.toLowerCase()) && x.toLowerCase() !== not.toLowerCase())
  if (!pick) return null
  // Initials, said letter by letter: any two letters ("ha" -> "HA"), or three with no vowel ("gtk" -> "GTK").
  return pick.length === 2 || (pick.length === 3 && !/[aeiouy]/i.test(pick)) ? pick.toUpperCase() : speakable(pick)
}

/** Session id -> callsign, unique across `sessions`. */
export function assignCallsigns(sessions: CallsignInput[], overrides: readonly CallsignOverride[] = []): Map<string, string> {
  const order = [...sessions].sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) || a.id.localeCompare(b.id))
  const fixed = new Map<string, string>()
  for (const s of order) {
    const o = overrideFor(s, overrides)
    if (o) fixed.set(s.id, o.callsign.trim())
  }
  const first = new Map<string, string>()
  const full = new Map<string, string>()
  for (const s of order) {
    if (fixed.has(s.id)) continue
    const w = sourceWords(s).map(speakable)
    first.set(s.id, w[0]!)
    full.set(s.id, w.join(' '))
  }

  const derived = order.filter(s => !fixed.has(s.id))
  const claimed = new Set([...fixed.values()].map(n => n.toLowerCase()))
  const byFirst = groupBy(derived, s => first.get(s.id)!.toLowerCase())
  const name = new Map<string, string>(fixed)
  for (const group of byFirst.values()) {
    const distinctFull = new Set(group.map(s => full.get(s.id)!.toLowerCase()))
    for (const s of group) {
      const plain = first.get(s.id)!
      // The whole project name when the first word is shared, or is an override's.
      const useFull = (group.length > 1 && distinctFull.size > 1) || (claimed.has(plain.toLowerCase()) && full.get(s.id)!.toLowerCase() !== plain.toLowerCase())
      name.set(s.id, useFull ? full.get(s.id)! : plain)
    }
  }

  const out = new Map<string, string>()
  const taken = new Set<string>()
  // Overrides number among themselves first, so a derived name never pushes one aside.
  const groups = [...groupBy(order.filter(s => fixed.has(s.id)), s => name.get(s.id)!.toLowerCase()).values(), ...groupBy(derived, s => name.get(s.id)!.toLowerCase()).values()]
  for (const group of groups) {
    group.forEach((s, i) => {
      const base = name.get(s.id)!
      let c = i === 0 ? base : `${base} ${NUMBERS[i - 1] ?? String(i + 1)}`
      // A name that would need a number, or that an override already holds, tries its title first.
      // That includes a second session under a project's override: the oldest keeps the name.
      if (i > 0 || (!fixed.has(s.id) && taken.has(c.toLowerCase()))) {
        const t = titleWord(s.title, base)
        if (t && !taken.has(t.toLowerCase()) && !claimed.has(t.toLowerCase())) c = t
      }
      // A numbered name can meet a real one ("Claude Two" as a project), or an override.
      for (let n = i + 1; taken.has(c.toLowerCase()); n++) c = `${base} ${NUMBERS[n - 1] ?? String(n + 1)}`
      taken.add(c.toLowerCase())
      out.set(s.id, c)
    })
  }
  return out
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const it of items) {
    const k = key(it)
    const g = m.get(k)
    if (g) g.push(it)
    else m.set(k, [it])
  }
  return m
}

/**
 * The bridge's last word on callsigns, whatever the adapter chose: applies
 * the config's overrides and the command-word rule across the whole fleet,
 * and carries the new names into the needs queue. Returns what each session
 * is also heard as, for the voice grammar.
 */
export function relabelFleet(fleet: Fleet, overrides: readonly CallsignOverride[]): { fleet: Fleet; heardAs: Map<string, string[]> } {
  const names = assignCallsigns(
    fleet.sessions.map(s => ({ id: s.id, project: s.project, title: s.title, startedAt: s.startedAt, role: s.kind === 'dispatcher' ? 'dispatcher' : null })),
    overrides,
  )
  const heardAs = new Map<string, string[]>()
  const sessions = fleet.sessions.map(s => {
    const o = overrideFor(s, overrides)
    // Only the session that kept the override's name answers to its other spellings.
    if (o?.heardAs.length && names.get(s.id)?.toLowerCase() === o.callsign.trim().toLowerCase()) heardAs.set(s.id, o.heardAs)
    return { ...s, callsign: names.get(s.id) ?? s.callsign }
  })
  const byId = new Map(sessions.map(s => [s.id, s.callsign]))
  const needs = fleet.needs.map(n => (n.sessionId && byId.has(n.sessionId) ? { ...n, callsign: byId.get(n.sessionId)! } : n))
  return { fleet: { ...fleet, sessions, needs }, heardAs }
}
