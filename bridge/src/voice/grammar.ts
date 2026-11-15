// The voice command grammar: a transcript in, an Interpretation out. Pure
// functions over the fleet the bridge already holds, so `status` and `read X`
// are answered with no model call, and nothing here can send anything.
//
// It lives in the bridge, not the HUD, because the bridge is where the fleet,
// the private callsign config (overrides and what a name is misheard as) and
// the spoken answers are. A future in-browser speech-to-text provider sends
// its text to POST /api/interpret and gets the same parse.
//
//   status                         "status", "what's the status", "how's everyone"
//   limits                         "limits", "usage", "what are my limits", "how much have I used"
//   switch to X                    "switch to X", "go to X", "show X", or just "X"
//   read X                         "read X", "what did X say", "what's X doing"
//   tell X <message>               "tell X to ...", "ask X ...", "message X ..."
//   confirm / cancel               only while a card is armed ("send", "yes" / "cancel", "no")
//   dispatcher                     "dispatcher", "back to the dispatcher": drop the selection
//   voice X                        "voice X", "change voice to X", "use the X voice"; "voices" lists them
//   <character>, ...               the current character's name first: a command still runs,
//                                  anything else is a question for the character, sent to no session
//   character X                    "be X", "character X", "X mode"; "operator mode" drops it; "characters" lists them
//   anything else, 3+ words        a message for the dispatcher, if the fleet has one
//   anything else, reader open     a message for the session being read, never the dispatcher
//
// Callsigns match fuzzily (spelling and sound), because transcription
// mangles names. A weak best match, or two near-equal ones, asks which.

import type { Candidate, Fleet, Interpretation, Session, VoiceContext } from '../../../shared/protocol.ts'

/** A best match at or above this is taken. */
export const ACCEPT = 0.75
/** Two sessions within this of each other, both plausible, is a tie: ask. */
export const TIE_MARGIN = 0.08
const PLAUSIBLE = 0.6

const DIGITS: Record<string, string> = { '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine', '10': 'ten' }
const FILLERS = new Set(['um', 'uh', 'er', 'erm', 'hmm', 'hey', 'so', 'please', 'right', 'okay', 'ok', 'oh'])
const CONFIRM = new Set(['send', 'send it', 'send that', 'send this', 'yes', 'yes send', 'yes send it', 'yeah', 'yep', 'confirm', 'confirmed', 'go', 'go ahead', 'do it'])
const CANCEL = new Set(['cancel', 'cancel it', 'cancel that', 'no', 'nope', 'stop', 'abort', 'never mind', 'nevermind', 'scrap that', 'scrap it', "don't send", 'do not send', 'dont send', 'forget it', 'belay', 'belay that', 'belay it'])
/** The words before a callsign that mean `tell`. */
const TELL = new Set(['tell', 'ask', 'message'])
/** Shorter than this, and not a command, is noise rather than a message for the dispatcher. */
const DISPATCH_MIN_WORDS = 3

export interface Token {
  /** As transcribed, punctuation and case kept: what a message is made of. */
  raw: string
  /** Lowercase letters, digits as words, apostrophes kept. */
  norm: string
}

export function tokens(transcript: string): Token[] {
  return transcript
    .trim()
    .split(/\s+/)
    .map(raw => ({ raw, norm: normWord(raw) }))
    .filter(t => t.norm)
}

function normWord(w: string): string {
  const s = w.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9']/g, '').replace(/^'+|'+$/g, '')
  return DIGITS[s] ?? s
}

export const normalise = (s: string) => tokens(s).map(t => t.norm).join(' ')

// ---------------------------------------------------------------- matching

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]!
}

const ratio = (a: string, b: string) => (a.length || b.length ? 1 - levenshtein(a, b) / Math.max(a.length, b.length) : 1)

/** A rough sound key: "Harbor" and "Harbour" both give "hrbr", "Tali" and "Tally" both "tl". */
export function soundKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .split(' ')
    .filter(Boolean)
    .map(w => {
      const x = w
        .replace(/ph/g, 'f')
        .replace(/ck/g, 'k')
        .replace(/c(?=[eiy])/g, 's')
        .replace(/[cq]/g, 'k')
        .replace(/x/g, 'ks')
        .replace(/z/g, 's')
        .replace(/wh/g, 'w')
        .replace(/gh/g, '')
        .replace(/dg/g, 'j')
      const body = x.slice(1).replace(/[aeiouyhw]/g, '')
      return (x[0]! + body).replace(/(.)\1+/g, '$1')
    })
    .join('')
}

/** 0..1: how well a heard name fits a callsign, by spelling and by sound. */
export function similarity(heard: string, name: string): number {
  const a = normalise(heard)
  const b = normalise(name)
  if (!a || !b) return 0
  if (a === b) return 1
  const spelt = ratio(a.replace(/ /g, ''), b.replace(/ /g, ''))
  const ka = soundKey(a)
  const kb = soundKey(b)
  const sound = ka && kb ? ratio(ka, kb) : 0
  return Math.max(spelt, 0.9 * sound)
}

export interface Target {
  sessionId: string
  callsign: string
  /** Other things speech-to-text is known to produce for this callsign. */
  heardAs: string[]
}

export interface Match {
  target: Target
  score: number
}

/** Every target scored against `heard`, best first. */
export function rank(heard: string, targets: readonly Target[]): Match[] {
  return targets
    .map(target => ({ target, score: Math.max(similarity(heard, target.callsign), ...target.heardAs.map(h => similarity(heard, h))) }))
    .sort((x, y) => y.score - x.score)
}

export type Resolution = { ok: true; target: Target; score: number } | { ok: false; why: 'ambiguous' | 'no-match'; candidates: Target[] }

/** One target, or a reason to ask. */
export function resolve(heard: string, targets: readonly Target[]): Resolution {
  const r = rank(heard, targets)
  const best = r[0]
  if (!best || best.score < ACCEPT) return { ok: false, why: 'no-match', candidates: r.filter(m => m.score >= PLAUSIBLE).slice(0, 4).map(m => m.target) }
  const close = r.filter(m => m.score >= PLAUSIBLE && best.score - m.score <= TIE_MARGIN)
  if (close.length > 1 && best.score < 1) return { ok: false, why: 'ambiguous', candidates: close.slice(0, 4).map(m => m.target) }
  // An exact name still loses to an exact alias of another session only if both are exact; then ask.
  if (close.length > 1 && close[1]!.score === 1) return { ok: false, why: 'ambiguous', candidates: close.slice(0, 4).map(m => m.target) }
  return { ok: true, target: best.target, score: best.score }
}

/**
 * "tally to run the tests" -> callsign "tally", message "run the tests".
 * Tries the first one to four words as the name and keeps the split whose
 * name matches best; on a tie the longer name wins, so "garden vr" beats
 * "garden" when both sessions exist.
 */
export function splitName(rest: Token[], targets: readonly Target[]): { name: Token[]; message: Token[]; best: Match | null } {
  let pick: { name: Token[]; message: Token[]; best: Match | null } = { name: rest.slice(0, 1), message: rest.slice(1), best: null }
  for (let n = 1; n <= Math.min(4, rest.length); n++) {
    const name = rest.slice(0, n)
    const best = rank(name.map(t => t.norm).join(' '), targets)[0] ?? null
    if (best && (!pick.best || best.score >= pick.best.score)) pick = { name, message: rest.slice(n), best }
    if (name.some(t => t.norm === 'to' || t.norm === 'that')) break
  }
  // "to" and "that" join the name to the message; they are not part of either.
  const message = [...pick.message]
  while (message[0] && (message[0].norm === 'to' || message[0].norm === 'that')) message.shift()
  return { ...pick, message }
}

// ---------------------------------------------------------------- answers

const STATE_SAID: Record<Session['state'], string> = { working: 'working', thinking: 'thinking', asking: 'asking', idle: 'idle', failed: 'failed', done: 'done', unknown: 'in an unknown state' }

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20))}…`
}

function spokenAge(since: number | null, now: number): string {
  if (since === null) return 'at an unknown time'
  const s = Math.max(0, Math.round((now - since) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`
  return `${Math.round(h / 24)} days ago`
}

/** A context this full or more is called out in `status` and `limits`, and shows red on the HUD. */
export const CONTEXT_NEAR_FULL = 80

function spokenUntil(t: number, now: number): string {
  const m = Math.max(0, Math.round((t - now) / 60_000))
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}${m % 60 ? ` ${m % 60} minute${m % 60 === 1 ? '' : 's'}` : ''}`
  const d = Math.round(h / 24)
  return `${d} day${d === 1 ? '' : 's'}`
}

/** Sessions whose context is nearly full, fullest first. */
export function nearlyFull(fleet: Fleet): Session[] {
  return fleet.sessions.filter(s => s.context && s.context.usedPct >= CONTEXT_NEAR_FULL).sort((a, b) => b.context!.usedPct - a.context!.usedPct)
}

const fullLine = (ss: Session[]) => `Context nearly full: ${ss.map(s => `${s.callsign} at ${Math.round(s.context!.usedPct)}%`).join(', ')}.`

const names = (ss: Session[]) => (ss.length <= 1 ? (ss[0]?.callsign ?? '') : `${ss.slice(0, -1).map(s => s.callsign).join(', ')} and ${ss.at(-1)!.callsign}`)

/** The fleet in a few spoken sentences, and the same as lines for the screen. */
export function statusAnswer(fleet: Fleet): { say: string; lines: string[] } {
  const ss = fleet.sessions
  if (!ss.length) return { say: 'No live sessions.', lines: ['No live sessions.'] }
  const lines: string[] = [`${ss.length} session${ss.length === 1 ? '' : 's'}.`]
  const busy = ss.filter(s => s.state === 'working' || s.state === 'thinking')
  if (busy.length) lines.push(`Working: ${names(busy)}.`)
  for (const s of ss.filter(s => s.state === 'asking')) lines.push(`${s.callsign} is asking: ${clip(s.asking?.text ?? s.lastLine ?? 'a question', 90)}`)
  const failed = ss.filter(s => s.state === 'failed')
  if (failed.length) lines.push(`Failed: ${names(failed)}.`)
  const idle = ss.filter(s => s.state === 'idle' || s.state === 'done')
  if (idle.length) lines.push(`Idle: ${names(idle)}.`)
  const full = nearlyFull(fleet)
  if (full.length) lines.push(fullLine(full))
  if (fleet.needs.length) lines.push(`${fleet.needs.length} thing${fleet.needs.length === 1 ? ' needs' : 's need'} you.`)
  else lines.push('Nothing needs you.')
  return { say: clip(lines.join(' '), 500), lines }
}

/**
 * The usage limits and today's spend, from what the backend reported. A
 * figure it does not have is said to be unavailable, never zero; a stale
 * one is given with its age.
 */
export function limitsAnswer(fleet: Fleet, now: number): { say: string; lines: string[] } {
  // A fleet from a bridge older than the usage field has none.
  const usage = (fleet as Partial<Fleet>).usage
  const lines: string[] = []
  const lim = usage?.limits
  const asOf = (f: { stale: boolean; at: number | null }) => (f.stale ? `, as of ${spokenAge(f.at, now)}` : '')
  const windows = lim?.value ?? []
  if (!windows.some(w => w.kind === 'five_hour')) lines.push(`5-hour limit not available${lim?.note ? `: ${clip(lim.note, 120)}` : ''}.`)
  for (const w of windows) lines.push(`${w.label} limit ${Math.round(w.usedPct)}% used${w.resetsAt !== null ? `, resets in ${spokenUntil(w.resetsAt, now)}` : ''}${asOf(lim!)}.`)
  const today = usage?.todayUsd
  if (today && today.value !== null) lines.push(`Spend today $${today.value.toFixed(2)}${asOf(today)}.`)
  else lines.push(`Spend today not available${today?.note ? `: ${clip(today.note, 120)}` : ''}.`)
  const full = nearlyFull(fleet)
  if (full.length) lines.push(fullLine(full))
  return { say: clip(lines.join(' '), 500), lines }
}

/** "dispatcher", "the dispatcher", "back to the dispatcher", "go back to dispatcher". */
const DISPATCHER = /^(?:(?:go |switch |come )?back to )?(?:the )?dispatcher$/

/** "limits", "usage", "rate limits", "what are my limits", "how much have I used". */
const LIMITS = [
  /^(?:(?:what are|what's|whats|what is|read|give me|check)(?: me)?(?: my| the)? )?(?:(?:usage|rate) )?(?:limits?|usage)(?: report| status)?$/,
  /^how much (?:have i|did i|i've|ive) (?:used|spent)(?: today)?$/,
  /^how(?:'s| is) my usage$/,
]

export function readAnswer(s: Session, now: number): string {
  const parts = [`${s.callsign}, ${STATE_SAID[s.state]}, last active ${spokenAge(s.activeAt, now)}.`]
  if (s.asking) parts.push(`Asking: ${clip(s.asking.text, 200)}${s.asking.options.length ? ` Options: ${s.asking.options.join(', or ')}.` : ''}`)
  if (s.action) parts.push(`Doing: ${clip(s.action, 100)}.`)
  const last = s.messages.at(-1)?.text ?? s.lastLine
  if (last && last !== s.asking?.text) parts.push(`Last said: ${clip(last, 300)}`)
  else if (!last) parts.push('Nothing said yet.')
  return parts.join(' ')
}

// ---------------------------------------------------------------- parse

export interface InterpretInput {
  transcript: string
  fleet: Fleet | null
  /** What each session is also heard as, from the config. */
  heardAs?: ReadonlyMap<string, readonly string[]>
  context: VoiceContext
  /** The session open in the reader, if any. Speech that names no session goes to it. */
  focusId?: string | null
  /** The speaking voices the bridge can change between, and the current one. Empty: it has one voice. */
  voices?: readonly { name: string; heardAs: readonly string[] }[]
  voice?: string | null
  /** The characters character mode can take on, and the current one (null: operator mode). */
  characters?: readonly { name: string; heardAs: readonly string[] }[]
  character?: string | null
  /** Set by interpret itself for the words after the character's name. */
  addressed?: boolean
  now: number
}

const VOICE_LIST = /^(?:(?:what|which) voices?(?: are there| do you have| have you got| can you do)?|(?:list|show)(?: me)?(?: the| your)? voices|voices)$/
/** Explicit: the words say it is about the voice, so a name that matches nothing gets an answer. */
const VOICE_SET = [/^(?:(?:change|switch|set)(?: the| your)? voice to|(?:use|try|do)(?: the)? voice|voice)(?: the)? (.+?)(?: voice)?$/, /^(?:use|try|do|be|become|switch to|change to)(?: the)? (.+) voice$/]
/** Loose: "juniper voice". Taken only when the name is a voice. */
const VOICE_LOOSE = /^(.+) voice$/

/** "voice X" and "voices". Null when the words are not about the voice. */
export function voiceCommand(text: string, input: Pick<InterpretInput, 'voices' | 'voice'>): Interpretation | null {
  const voices = input.voices ?? []
  const names = voices.map(v => v.name)
  const now = input.voice ? ` Now: ${input.voice}.` : ''
  if (VOICE_LIST.test(text)) return { kind: 'voice', voice: null, say: names.length ? `Voices: ${names.join(', ')}.${now}` : 'This bridge has one voice.' }
  const explicit = VOICE_SET.map(r => r.exec(text)?.[1]).find(Boolean)
  const heard = explicit ?? VOICE_LOOSE.exec(text)?.[1]
  if (!heard) return null
  const r = resolve(heard, voices.map(v => ({ sessionId: v.name, callsign: v.name, heardAs: [...v.heardAs] })))
  if (r.ok) return { kind: 'voice', voice: r.target.callsign, say: r.target.callsign === input.voice ? `Already ${r.target.callsign}.` : `Voice: ${r.target.callsign}.` }
  // Many words after "voice" are a sentence that happens to start that way, not a name.
  if (!explicit || heard.split(' ').length > 3) return null
  if (!names.length) return { kind: 'voice', voice: null, say: 'This bridge has one voice.' }
  return { kind: 'voice', voice: null, say: r.why === 'ambiguous' ? `Which voice: ${r.candidates.map(c => c.callsign).join(', or ')}?` : `No voice called ${heard}. There is ${names.join(', ')}.` }
}

const CHARACTER_LIST = /^(?:(?:what|which) characters?(?: are there| do you have| have you got| can you do)?|(?:list|show)(?: me)?(?: the| your)? characters|characters)$/
const OPERATOR = /^(?:(?:go|switch|change|come)?(?: ?back)? ?(?:to|into) )?(?:the )?(?:operator|plain|normal) mode$|^(?:drop|lose|stop)(?: the)? (?:character|act)$/
/** Explicit: the words say it is a character, so a name that matches nothing gets an answer. */
const CHARACTER_SET = /^(?:(?:switch|change) to )?character (.+)$/
/** Loose: taken only when the name is a character. "be quiet" is not a character, so it falls through. Speech-to-text writes a clipped "be" as "B." or "bee". */
const CHARACTER_LOOSE = [/^(?:be|become|b|bee) (.+)$/, /^(?:(?:switch|change|go) (?:to|into) )?(.+) mode$/]

/** "be X", "character X", "X mode", "operator mode", "characters". Null when the words are not about the character. */
export function characterCommand(text: string, input: Pick<InterpretInput, 'characters' | 'character'>): Interpretation | null {
  const chars = input.characters ?? []
  const names = chars.map(c => c.name)
  const cur = input.character ?? null
  const none = 'No characters are set up in the bridge config.'
  if (CHARACTER_LIST.test(text)) return { kind: 'character', character: cur, changed: false, say: names.length ? `Characters: ${names.join(', ')}.${cur ? ` Now: ${cur}.` : ' Now: operator mode.'}` : none }
  if (OPERATOR.test(text)) return { kind: 'character', character: null, changed: cur !== null, say: cur ? 'Operator mode.' : 'Already in operator mode.' }
  const explicit = CHARACTER_SET.exec(text)?.[1]
  const heard = explicit ?? CHARACTER_LOOSE.map(r => r.exec(text)?.[1]).find(Boolean)
  if (!heard) return null
  const r = resolve(heard, chars.map(c => ({ sessionId: c.name, callsign: c.name, heardAs: [...c.heardAs] })))
  if (r.ok) return { kind: 'character', character: r.target.callsign, changed: r.target.callsign !== cur, say: r.target.callsign === cur ? `Already ${r.target.callsign}.` : `Character: ${r.target.callsign}.` }
  if (!explicit || heard.split(' ').length > 3) return null
  if (!names.length) return { kind: 'character', character: cur, changed: false, say: none }
  return { kind: 'character', character: cur, changed: false, say: r.why === 'ambiguous' ? `Which character: ${r.candidates.map(c => c.callsign).join(', or ')}?` : `No character called ${heard}. There is ${names.join(', ')}.` }
}

const capitalise = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s)
const joinRaw = (ts: Token[]) => capitalise(ts.map(t => t.raw).join(' ').replace(/^[,;:.\s]+/, ''))

/** Sounds of thinking, never words of the message: dropped wherever they fall. */
const HESITATIONS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'err', 'erm', 'hmm', 'mm'])

/** Drops hesitations anywhere, handing a sentence end ("um.") back to the word before it. */
function dropHesitations(ts: Token[]): Token[] {
  const out: Token[] = []
  for (const t of ts) {
    if (!HESITATIONS.has(t.norm)) {
      out.push(t)
      continue
    }
    const end = /[.?!]+$/.exec(t.raw)?.[0]
    const prev = out[out.length - 1]
    if (end && prev && !/[.?!,;:]$/.test(prev.raw)) out[out.length - 1] = { ...prev, raw: prev.raw + end }
  }
  return out
}

function stripFillers(all: Token[]): Token[] {
  const ts = dropHesitations(all)
  let a = 0
  let b = ts.length
  while (a < b - 1 && FILLERS.has(ts[a]!.norm)) a++
  while (b > a + 1 && (ts[b - 1]!.norm === 'please' || ts[b - 1]!.norm === 'thanks')) b--
  return ts.slice(a, b)
}

const cand = (t: Target): Candidate => ({ sessionId: t.sessionId, callsign: t.callsign })

function whichSay(why: 'ambiguous' | 'no-match' | 'no-dispatcher', heard: string | null, candidates: Target[]): string {
  const opts = candidates.length ? ` ${candidates.map(c => c.callsign).join(', or ')}?` : ''
  if (why === 'ambiguous') return `Which one:${opts}`
  if (why === 'no-dispatcher') return `There is no dispatcher session. Who is it for?${opts}`
  return `I don't know ${heard ? `"${heard}"` : 'that name'}. Who is it for?${opts}`
}

/** How many leading words are the character's name (or what it is heard as); 0 when he is not talking to it. */
export function addressedTo(ts: readonly Token[], c: { name: string; heardAs: readonly string[] }): number {
  const target: Target = { sessionId: c.name, callsign: c.name, heardAs: [...c.heardAs] }
  const most = Math.max(...[c.name, ...c.heardAs].map(n => n.trim().split(/\s+/).length))
  for (let n = Math.min(most, ts.length); n >= 1; n--) {
    if (rank(ts.slice(0, n).map(t => t.norm).join(' '), [target])[0]!.score >= ACCEPT) return n
  }
  return 0
}

export function interpret(input: InterpretInput): Interpretation {
  const ts = stripFillers(tokens(input.transcript))
  const text = ts.map(t => t.norm).join(' ')
  const fleet = input.fleet
  const sessions = fleet?.sessions ?? []
  const targets: Target[] = sessions.map(s => ({ sessionId: s.id, callsign: s.callsign, heardAs: [...(input.heardAs?.get(s.id) ?? [])] }))
  const sendable = targets.filter(t => sessions.find(s => s.id === t.sessionId)?.canSend)
  const byId = (id: string) => sessions.find(s => s.id === id)!

  if (!text) return { kind: 'unknown', say: 'I heard nothing I could use.' }

  // The current character's name first means he is talking to the character.
  // A command after the name still runs ("Atlas, status"). Words that would
  // only have been passed on as a message are a question for the character
  // instead, and reach no session, whatever is open in the reader.
  const me = input.addressed ? null : ((input.characters ?? []).find(c => c.name === input.character) ?? null)
  const named = me ? addressedTo(ts, me) : 0
  if (me && named) {
    const rest = ts.slice(named)
    const ask: Interpretation = { kind: 'ask', character: me.name, question: joinRaw(rest), say: rest.length ? `${capitalise(me.name)} did not answer in time.` : 'Listening.' }
    if (!rest.length) return ask
    const inner = interpret({ ...input, transcript: rest.map(t => t.raw).join(' '), focusId: null, addressed: true })
    const passedOn = inner.kind === 'unknown' || (inner.kind === 'tell' && inner.viaDispatcher) || (inner.kind === 'which' && inner.why === 'no-dispatcher')
    return passedOn ? ask : inner
  }

  // Confirm and cancel words mean something only while a card is armed,
  // and only as the whole utterance: "send" inside a sentence is not a yes.
  //
  // With a session open in the reader and no card armed, "yes", "no" and
  // "go ahead" are answers to that session, so they fall through and become
  // a message for it (still behind a read-back card).
  const focus = input.focusId ? (sessions.find(s => s.id === input.focusId) ?? null) : null
  const answerToFocus = Boolean(focus) && input.context === 'none' && (CONFIRM.has(text) || text === 'no' || text === 'nope')
  if (!answerToFocus) {
    if (CONFIRM.has(text)) return input.context === 'confirm' ? { kind: 'confirm', say: 'Sending.' } : { kind: 'unknown', say: 'Nothing to send.' }
    if (CANCEL.has(text)) return { kind: 'cancel', say: input.context === 'none' ? 'Nothing to cancel.' : 'Cancelled. Nothing sent.' }
  }

  // About the bridge's own voice, so it needs no fleet. Not while a card is
  // armed or a name is being asked for: those words belong to the message.
  if (input.context === 'none') {
    // With no characters configured nothing here matches, so operator mode parses as it always has.
    if (input.characters?.length) {
      const c = characterCommand(text, input)
      if (c) return c
    }
    const v = voiceCommand(text, input)
    if (v) return v
  }

  if (!fleet) return { kind: 'unknown', say: 'No fleet data yet, so I cannot act on that.' }

  if (/^(?:(?:what's|whats|what is|give me|read)(?: the| me the)? )?(?:fleet )?status(?: report| update)?(?: (?:of|on|for) (?:the |my )?(?:fleet|agents|sessions|team|everyone|everything))?$/.test(text) || /^how(?:'s| is| are) (?:everyone|everybody|the fleet|things)(?: doing)?$/.test(text)) {
    const a = statusAnswer(fleet)
    return { kind: 'status', say: a.say, lines: a.lines }
  }

  if (LIMITS.some(r => r.test(text))) {
    const a = limitsAnswer(fleet, input.now)
    return { kind: 'limits', say: a.say, lines: a.lines }
  }

  // Answering "who is it for?": the whole utterance is a name.
  if (input.context === 'target') {
    const r = resolve(text.replace(/^(?:to|for|it's for|its for|it is for) /, ''), sendable)
    if (r.ok) return { kind: 'target', sessionId: r.target.sessionId, callsign: r.target.callsign, say: `To ${r.target.callsign}.` }
    // Not a name: fall through, so "status" or a new "tell" still work.
  }

  // "dispatcher", "back to the dispatcher": deselect, whatever the dispatcher
  // session is called. Asked "who is it for?", the answer above already
  // took it as a name.
  if (DISPATCHER.test(text)) return { kind: 'dispatcher', say: 'Dispatcher.' }

  const which = (why: 'ambiguous' | 'no-match', heard: string, candidates: Target[], body = ''): Interpretation => ({ kind: 'which', why, heard, text: body, candidates: candidates.map(cand), say: whichSay(why, heard, candidates) })

  // read X / what did X say / what's X doing
  const readName =
    /^read(?: out| me| back)?(?: from)? (.+?)(?:'s)?(?: last)?(?: message| messages| reply)?$/.exec(text)?.[1] ??
    /^what (?:did|has|does) (.+?) (?:say|said|saying)$/.exec(text)?.[1] ??
    /^what(?:'s| is|s) (.+?) (?:doing|saying|up to)$/.exec(text)?.[1]
  if (readName) {
    const r = resolve(readName, targets)
    if (!r.ok) return which(r.why, readName, r.candidates)
    return { kind: 'read', sessionId: r.target.sessionId, callsign: r.target.callsign, say: readAnswer(byId(r.target.sessionId), input.now) }
  }

  // switch to X / show X
  const switchName = /^(?:(?:switch|go|change|move)(?: over)? to|(?:show|focus|open)(?: me)?(?: on)?) (.+)$/.exec(text)?.[1]
  if (switchName) {
    const r = resolve(switchName, targets)
    if (!r.ok) return which(r.why, switchName, r.candidates)
    return { kind: 'switch', sessionId: r.target.sessionId, callsign: r.target.callsign, say: `${r.target.callsign}.` }
  }

  // tell X <message>
  if (TELL.has(ts[0]!.norm) && ts.length > 1) {
    const { name, message } = splitName(ts.slice(1), sendable.length ? sendable : targets)
    const heard = name.map(t => t.norm).join(' ')
    const body = joinRaw(message)
    const r = resolve(heard, sendable)
    if (!r.ok) {
      // A name that matches a session that cannot be sent to says so, rather than asking.
      const unreachable = resolve(heard, targets)
      if (unreachable.ok) return { kind: 'unknown', say: `${unreachable.target.callsign} cannot be sent to from here.` }
      return which(r.why, heard, r.candidates, body)
    }
    if (!body) return { kind: 'unknown', say: `Tell ${r.target.callsign} what? Say it again with the message.` }
    return { kind: 'tell', sessionId: r.target.sessionId, callsign: r.target.callsign, text: body, viaDispatcher: false, say: `To ${r.target.callsign}: ${body}` }
  }

  // Just a name: show that session.
  if (ts.length <= 3) {
    const r = resolve(text, targets)
    if (r.ok && r.score >= 0.85) return { kind: 'switch', sessionId: r.target.sessionId, callsign: r.target.callsign, say: `${r.target.callsign}.` }
  }

  // With a session open in the reader, anything else is for that session,
  // however short, and never rerouted through the dispatcher.
  if (focus) {
    if (!focus.canSend) return { kind: 'unknown', say: `${focus.callsign} cannot be sent to from here.` }
    const toFocus = joinRaw(ts)
    return { kind: 'tell', sessionId: focus.id, callsign: focus.callsign, text: toFocus, viaDispatcher: false, viaFocus: true, say: `To ${focus.callsign}: ${toFocus}` }
  }

  // Anything else is for the dispatcher.
  if (ts.length < DISPATCH_MIN_WORDS) return { kind: 'unknown', say: `Heard "${input.transcript.trim()}". That is not a command. Say status, read, switch to, or tell.` }
  const body = joinRaw(ts)
  const dispatcher = sessions.find(s => s.kind === 'dispatcher' && s.canSend)
  if (!dispatcher) return { kind: 'which', why: 'no-dispatcher', heard: null, text: body, candidates: sendable.slice(0, 4).map(cand), say: whichSay('no-dispatcher', null, sendable.slice(0, 4)) }
  return { kind: 'tell', sessionId: dispatcher.id, callsign: dispatcher.callsign, text: body, viaDispatcher: true, say: `To ${dispatcher.callsign}: ${body}` }
}
