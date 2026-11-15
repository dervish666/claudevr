// Character mode: which character is on, the lines it speaks, the commands
// it classifies, and when it speaks up unprompted.
//
// The action never waits for a line. The server acts on what the grammar
// (or a validated classification) said, answers the HUD at once with a line
// id, and the line follows from GET /api/line within `lineTimeoutMs`, as the
// character's words or, when the model is slow, down or unusable, the plain
// words the grammar wrote. Nothing in this file can send to a session: it
// returns Interpretations to the server, and lines that are only spoken.

import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import type { CharacterInfo, Fleet, Interpretation, PendingLine, PersonaStatus, SpokenLine } from '../../../shared/protocol.ts'
import type { TtsProvider } from '../voice/tts.ts'
import type { FrontMan } from './frontman.ts'
import { announcementFacts, askPrompt, CLASSIFIER_PROMPT, classifyPrompt, fleetEvents, linePrompt, parseClassified, speakableLine, systemPrompt, validateClassified, whatWasDone, type Character, type FleetEvent, type LineFacts } from './prompt.ts'

export interface Audience {
  /** Some HUD is connected and not muted. */
  listening: boolean
  /** Someone is holding to talk right now. */
  holding: boolean
}

export interface PersonaOptions {
  characters: Character[]
  /** Spend one throwaway turn per model when a character is restored at start-up, so its first line is not a cold one. */
  warmUp?: boolean
  /** Writes the lines. */
  frontMan: FrontMan
  /** Classifies speech the grammar could not place. A separate conversation, so a parse never shares context with session text. */
  classifier: FrontMan
  tts: TtsProvider
  /** Where the choice is kept across restarts; null keeps it in memory only. */
  stateFile: string | null
  initial: string | null
  /** Longest wait for a line before the plain one is used. */
  lineTimeoutMs?: number
  /** Longest wait for a classification before the grammar's reading stands. */
  classifyTimeoutMs?: number
  /** At most one unprompted line per this many ms. */
  announceGapMs?: number
  /** Events are gathered for this long before a line is asked for, so a burst becomes one line. */
  coalesceMs?: number
  /** No unprompted line until this long after he last spoke. */
  quietAfterVoiceMs?: number
  audience?: () => Audience
  log?: (...a: unknown[]) => void
}

const info = (c: Character): CharacterInfo => ({ name: c.name, confirm: c.confirm, accent: c.accent })

/** The line spoken when the model cannot be: the grammar's own words, except where those were never meant to be spoken. */
export function plainLine(i: Interpretation): string {
  if (i.kind === 'tell') return `Message for ${i.callsign}.`
  return i.say
}

export class Persona {
  private readonly o: Required<Omit<PersonaOptions, 'stateFile' | 'initial' | 'audience'>> & Pick<PersonaOptions, 'stateFile' | 'audience'>
  private cur: Character | null = null
  private readonly lines = new Map<string, { at: number; line: Promise<SpokenLine> }>()
  private readonly listeners = new Set<(s: PersonaStatus) => void>()
  private readonly announceListeners = new Set<(l: SpokenLine) => void>()
  private pending: FleetEvent[] = []
  private timer: NodeJS.Timeout | null = null
  private lastSpokeAt = 0
  private lastVoiceAt = 0
  private readonly unsub: (() => void)[] = []

  constructor(o: PersonaOptions) {
    this.o = { warmUp: false, lineTimeoutMs: 4_000, classifyTimeoutMs: 3_000, announceGapMs: 20_000, coalesceMs: 1_500, quietAfterVoiceMs: 6_000, log: (...a) => console.log('[persona]', ...a), ...o }
    const notify = () => this.notify()
    this.unsub.push(o.frontMan.onStatus(notify))
    if (o.initial) {
      const c = o.characters.find(x => x.name === o.initial)
      if (c) this.apply(c, false)
      else this.o.log(`no character called ${JSON.stringify(o.initial)}; operator mode`)
    }
  }

  characters(): Character[] {
    return this.o.characters
  }

  current(): Character | null {
    return this.cur
  }

  status(): PersonaStatus {
    const fm = this.o.frontMan.status()
    return { character: this.cur ? info(this.cur) : null, characters: this.o.characters.map(info), frontMan: this.cur ? fm : { provider: fm.provider, state: 'off', error: null } }
  }

  onStatus(l: (s: PersonaStatus) => void): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  onAnnounce(l: (line: SpokenLine) => void): () => void {
    this.announceListeners.add(l)
    return () => this.announceListeners.delete(l)
  }

  private notify(): void {
    const s = this.status()
    for (const l of this.listeners) l(s)
  }

  /** Turns a character on (and its voice), or with null goes back to operator mode. Throws for a name the config does not have. */
  select(name: string | null): void {
    if (name === null) {
      this.cur = null
      this.o.frontMan.configure(null)
      this.o.classifier.configure(null)
      this.pending = []
      this.remember('')
      this.o.log('operator mode')
      this.notify()
      return
    }
    const c = this.o.characters.find(x => x.name === name)
    if (!c) throw new Error(`no character called ${name}`)
    this.apply(c, true)
  }

  private apply(c: Character, remember: boolean): void {
    const tts = this.o.tts
    if (tts.select && tts.voices?.().some(v => v.name === c.voice)) {
      try {
        if (tts.voice?.() !== c.voice) tts.select(c.voice)
      } catch (err) {
        this.o.log(`${c.name}: could not change to the ${c.voice} voice: ${(err as Error).message}`)
      }
    } else this.o.log(`${c.name}: speaks with ${tts.name}'s own voice (the ${c.voice} voice needs the fish provider)`)
    this.cur = c
    this.o.frontMan.configure(systemPrompt(c))
    this.o.classifier.configure(CLASSIFIER_PROMPT)
    if (remember) this.remember(c.name)
    // Restored at start-up, nobody is waiting on a line yet: one throwaway
    // turn each, so the first real line does not pay for a cold model and
    // time out. A character chosen by voice warms itself with its own line.
    else if (this.o.warmUp) {
      for (const [who, fm] of [['lines', this.o.frontMan], ['classifier', this.o.classifier]] as const) {
        fm.complete('Reply with the one word: ready', 20_000).catch((err: unknown) => this.o.log(`${c.name}: ${who} warm-up failed: ${(err as Error).message}`))
      }
    }
    this.o.log(`character: ${c.name} (confirm ${c.confirm})`)
    this.notify()
  }

  private remember(name: string): void {
    if (!this.o.stateFile) return
    try {
      writeFileSync(this.o.stateFile, name + '\n')
    } catch (err) {
      this.o.log(`could not save the character choice to ${this.o.stateFile}: ${(err as Error).message}`)
    }
  }

  /** Who is there to hear an unprompted line; the server knows, from each HUD's presence messages. */
  setAudience(a: () => Audience): void {
    this.o.audience = a
  }

  /** He just spoke: hold unprompted lines back for a while. */
  heardVoice(): void {
    this.lastVoiceAt = Date.now()
  }

  // ------------------------------------------------------------ lines

  /**
   * Starts writing the line for an answer and returns its id, or null in
   * operator mode and for answers that need no line (a message being armed
   * or sent: the card and the send are the answer). The returned line always resolves, never rejects.
   */
  startLine(i: Interpretation, heard: string, fleet: () => Fleet | null): PendingLine | null {
    const c = this.cur
    // A message for a session gets no line: the countdown on screen is the read-back, and a remark on every message he sends is noise.
    if (!c || i.kind === 'confirm' || i.kind === 'tell' || i.kind === 'target') return null
    const facts: LineFacts = { heard, done: whatWasDone(i, c.confirm === 'quick'), plain: i.say }
    const id = randomBytes(8).toString('hex')
    this.prune()
    // An answer to a question is longer than a remark, and worth a longer wait.
    const line =
      i.kind === 'ask'
        ? this.write(id, c, () => askPrompt(i.question, fleet(), Date.now()), plainLine(i), { timeoutMs: this.o.lineTimeoutMs + 3_000, max: 420, sentences: 3 })
        : this.write(id, c, () => linePrompt(facts, fleet(), Date.now()), plainLine(i), { timeoutMs: this.o.lineTimeoutMs, max: 280, sentences: 2 })
    this.lines.set(id, { at: Date.now(), line })
    return { id, character: c.name }
  }

  /** The line for an id: ready, or the plain one at the timeout. Null for an id it never made, or one long gone. */
  line(id: string): Promise<SpokenLine> | null {
    return this.lines.get(id)?.line ?? null
  }

  private prune(): void {
    const old = Date.now() - 60_000
    for (const [k, v] of this.lines) if (v.at < old || this.lines.size > 100) this.lines.delete(k)
  }

  private async write(id: string, c: Character, prompt: () => string, plain: string, lim: { timeoutMs: number; max: number; sentences: number }): Promise<SpokenLine> {
    const t0 = Date.now()
    const done = (text: string, source: SpokenLine['source'], reason: string | null): SpokenLine => {
      const ms = Date.now() - t0
      this.o.log(`line ${id.slice(0, 6)}: ${source} in ${ms} ms${reason ? ` (${reason})` : ''}`)
      return { id, text, character: c.name, source, reason, ms }
    }
    try {
      const raw = await this.o.frontMan.complete(prompt(), lim.timeoutMs)
      const text = speakableLine(raw, lim.max, lim.sentences)
      if (!text) return done(plain, 'fallback', `nothing speakable in ${JSON.stringify(raw.slice(0, 80))}`)
      // Switched character while it was being written: the old character's line is not spoken in the new voice.
      if (this.cur !== c) return done(plain, 'fallback', 'the character changed')
      return done(text, 'character', null)
    } catch (err) {
      return done(plain, 'fallback', (err as Error).message)
    }
  }

  // ------------------------------------------------------------ classification

  /**
   * In character mode, speech the grammar answered with `unknown` or `which`
   * goes to the classifier. What comes back is untrusted: parsed, then
   * checked against the fleet as it is when the answer arrives. Any failure
   * keeps the grammar's answer.
   */
  async classify(transcript: string, grammar: Interpretation, fleet: () => Fleet | null, now: () => number): Promise<Interpretation> {
    if (!this.cur || (grammar.kind !== 'unknown' && grammar.kind !== 'which')) return grammar
    const f0 = fleet()
    if (!f0) return grammar
    const { prompt, ids } = classifyPrompt(transcript, f0)
    const t0 = Date.now()
    let raw: string
    try {
      raw = await this.o.classifier.complete(prompt, this.o.classifyTimeoutMs)
    } catch (err) {
      this.o.log(`classify: kept the grammar's ${grammar.kind}: ${(err as Error).message}`)
      return grammar
    }
    const f1 = fleet()
    if (!f1) return grammar
    const v = validateClassified(parseClassified(raw), { grammar, ids, fleet: f1, now: now() })
    if (!v.ok) {
      this.o.log(`classify: kept the grammar's ${grammar.kind} after ${Date.now() - t0} ms: ${v.why}${v.why === 'malformed output' ? ` (${JSON.stringify(raw.slice(0, 120))})` : ''}`)
      return grammar
    }
    this.o.log(`classify: ${grammar.kind} -> ${v.i.kind} in ${Date.now() - t0} ms`)
    return v.i
  }

  // ------------------------------------------------------------ speaking up

  /**
   * Called on every fleet read. Sessions that start asking, fail or finish
   * are gathered and, at most once per `announceGapMs`, become one line. The
   * line is pushed to the HUD to be spoken; nothing parses it.
   */
  fleetChanged(prev: Fleet | null, next: Fleet): void {
    if (!this.cur) return
    const events = fleetEvents(prev, next)
    if (!events.length) return
    for (const e of events) {
      this.pending = this.pending.filter(p => p.sessionId !== e.sessionId)
      this.pending.push(e)
    }
    this.schedule(next)
  }

  private latestFleet: Fleet | null = null

  private schedule(fleet: Fleet): void {
    this.latestFleet = fleet
    if (this.timer) return
    const now = Date.now()
    const at = Math.max(now + this.o.coalesceMs, this.lastSpokeAt + this.o.announceGapMs, this.lastVoiceAt + this.o.quietAfterVoiceMs)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, at - now)
  }

  private async flush(): Promise<void> {
    const c = this.cur
    if (!c || !this.pending.length) return
    const a = this.o.audience?.() ?? { listening: true, holding: false }
    if (!a.listening) {
      this.o.log(`speak-up: nobody listening, dropped ${this.pending.length} event(s)`)
      this.pending = []
      return
    }
    // Holding to talk, or spoke a moment ago: try again shortly.
    if (a.holding || Date.now() < this.lastVoiceAt + this.o.quietAfterVoiceMs) {
      this.schedule(this.latestFleet!)
      return
    }
    const events = this.pending.splice(0)
    this.lastSpokeAt = Date.now()
    const facts = announcementFacts(events)
    const id = randomBytes(8).toString('hex')
    const line = await this.write(id, c, () => linePrompt(facts, this.latestFleet, Date.now()), facts.plain, { timeoutMs: this.o.lineTimeoutMs, max: 280, sentences: 2 })
    for (const l of this.announceListeners) l(line)
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer)
    for (const u of this.unsub) u()
    this.o.frontMan.close()
    this.o.classifier.close()
  }
}
