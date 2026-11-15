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
import type { CharacterInfo, Conversation, ConversationEntry, Fleet, Interpretation, PendingLine, PersonaStatus, Session, SpokenLine, Turn } from '../../../shared/protocol.ts'
import { turnKey } from '../../../shared/conversation.ts'
import type { TtsProvider } from '../voice/tts.ts'
import type { FrontMan } from './frontman.ts'
import { announcementFacts, askPrompt, CLASSIFIER_PROMPT, classifyPrompt, fleetEvents, linePrompt, parseClassified, plainRelay, relayPrompt, speakableLine, systemPrompt, validateClassified, whatWasDone, type Character, type FleetEvent, type LineFacts, type Relay } from './prompt.ts'

export interface Audience {
  /** Some HUD is connected and not muted. */
  listening: boolean
  /** Someone is holding to talk right now. */
  holding: boolean
}

/**
 * Reads a session's last turns, oldest first, for a relay. The server sets
 * it, since only the server may touch the backend; null means the session
 * has no full turns to give, and the relay reads the fleet's clips instead.
 */
export type TurnReader = (sessionId: string) => Promise<Turn[] | null>

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
  /** Full turns for relays; without it a relay reads the fleet's clips. */
  readTurns?: TurnReader
  /** How long, after he sends the dispatcher something, its answer is waited for. */
  relayWaitMs?: number
  /** A relay that could not be spoken (he held to talk, nobody listening) for this long after the answer came is dropped. */
  relayStaleMs?: number
  /** The theme pack a character wears, by name, for the HUD (themes.ts resolves it on disk). Default: its own `theme` setting. */
  themeOf?: (c: Character) => string | null
  log?: (...a: unknown[]) => void
}

/** Conversation entries kept, and the longest text kept in one. */
const CONVERSATION_MAX = 30
const ENTRY_TEXT_MAX = 800
/** A relay check that finds no new answer yet (the transcript lags the board) is tried again on later fleet reads, this many times. */
const RELAY_RETRIES = 5

/** The newest thing a session said, as the fleet shows it, for telling whether it has said something since. */
const lastMessageKey = (s: Session): string | null => {
  const m = s.messages.at(-1)
  return m ? `${m.at ?? ''}|${turnKey(m.text)}` : null
}

const clipEntry = (t: string) => (t.length > ENTRY_TEXT_MAX ? `${t.slice(0, ENTRY_TEXT_MAX - 1)}…` : t)

interface Awaiting {
  /** When he last sent it something. */
  at: number
  sessionId: string
  sent: string
  /** The fleet's newest message from it at the send, and at the last read since. */
  baseMsg: string | null
  lastMsg: string | null
  /** Its newest turn of its own at the send, once read: an answer must be a different one. */
  baseTurn: string | null
  retries: number
}

const ownTheme = (c: Character): string | null => (typeof c.theme === 'string' ? c.theme : null)

/** The line spoken when the model cannot be: the grammar's own words, except where those were never meant to be spoken. */
export function plainLine(i: Interpretation): string {
  if (i.kind === 'tell') return `Message for ${i.callsign}.`
  return i.say
}

export class Persona {
  private readonly o: Required<Omit<PersonaOptions, 'stateFile' | 'initial' | 'audience' | 'readTurns'>> & Pick<PersonaOptions, 'stateFile' | 'audience' | 'readTurns'>
  private cur: Character | null = null
  private readonly lines = new Map<string, { at: number; line: Promise<SpokenLine> }>()
  private readonly listeners = new Set<(s: PersonaStatus) => void>()
  private readonly announceListeners = new Set<(l: SpokenLine) => void>()
  private pending: FleetEvent[] = []
  private timer: NodeJS.Timeout | null = null
  private lastSpokeAt = 0
  private lastVoiceAt = 0
  private readonly unsub: (() => void)[] = []
  // The conversation lives in memory only: a bridge restart loses it, and
  // that is fine, since it only feeds the prompts and the dispatcher panel.
  private convo: ConversationEntry[] = []
  private readonly convoListeners = new Set<(c: Conversation) => void>()
  private awaiting: Awaiting | null = null
  private checking = false
  private nextCheck: { d: Session; kind: Relay['kind'] } | null = null
  private closed = false

  constructor(o: PersonaOptions) {
    this.o = { warmUp: false, themeOf: ownTheme, lineTimeoutMs: 4_000, classifyTimeoutMs: 3_000, announceGapMs: 20_000, coalesceMs: 1_500, quietAfterVoiceMs: 6_000, relayWaitMs: 600_000, relayStaleMs: 60_000, log: (...a) => console.log('[persona]', ...a), ...o }
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
    const info = (c: Character): CharacterInfo => ({ name: c.name, confirm: c.confirm, accent: c.accent, theme: (this.o.themeOf ?? ownTheme)(c) })
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

  // ------------------------------------------------------------ conversation

  /** What he said to the dispatcher and to the character, what the dispatcher answered, and what the character said. */
  conversation(): Conversation {
    return { character: this.cur?.name ?? null, entries: this.convo.slice() }
  }

  onConversation(l: (c: Conversation) => void): () => void {
    this.convoListeners.add(l)
    return () => this.convoListeners.delete(l)
  }

  private record(e: Omit<ConversationEntry, 'id' | 'at'>): void {
    this.convo.push({ ...e, id: randomBytes(6).toString('hex'), at: Date.now(), text: clipEntry(e.text) })
    if (this.convo.length > CONVERSATION_MAX) this.convo.splice(0, this.convo.length - CONVERSATION_MAX)
    this.notifyConversation()
  }

  private clearConversation(): void {
    this.awaiting = null
    this.nextCheck = null
    this.convo = []
    this.notifyConversation()
  }

  private notifyConversation(): void {
    const c = this.conversation()
    for (const l of this.convoListeners) l(c)
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
      this.clearConversation()
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
    // A new character starts a new conversation: the old one's words are not its own.
    if (this.cur !== c) this.clearConversation()
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

  /** Where relays read full turns from; the server sets it. */
  setTurnReader(r: TurnReader): void {
    this.o.readTurns = r
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
    let line: Promise<SpokenLine>
    if (i.kind === 'ask') {
      // The conversation so far, before this question joins it, so the prompt does not carry the question twice.
      const history = this.convo.slice()
      if (i.question.trim()) this.record({ who: 'user', to: 'character', text: i.question })
      line = this.write(id, c, () => askPrompt(i.question, fleet(), Date.now(), history), plainLine(i), { timeoutMs: this.o.lineTimeoutMs + 3_000, max: 420, sentences: 3 })
      // Turns carry no time, so the HUD places an answer by where it first saw it (after: null).
      void line.then(l => {
        if (this.cur === c) this.record({ who: 'character', text: l.text, source: l.source, after: null })
      })
    } else line = this.write(id, c, () => linePrompt(facts, fleet(), Date.now()), plainLine(i), { timeoutMs: this.o.lineTimeoutMs, max: 280, sentences: 2 })
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
    let events = fleetEvents(prev, next)
    if (this.awaiting && Date.now() - this.awaiting.at > this.o.relayWaitMs) {
      this.o.log(`relay: no answer from the dispatcher in ${Math.round(this.o.relayWaitMs / 60_000)} min; stopped waiting`)
      this.awaiting = null
    }
    const a = this.awaiting
    if (a) {
      // While he waits on the dispatcher, its own events belong to the relay: one event, one line.
      const mine = events.filter(e => e.sessionId === a.sessionId)
      events = events.filter(e => e.sessionId !== a.sessionId)
      this.watchDispatcher(a, next, mine)
    }
    if (!events.length) return
    for (const e of events) {
      this.pending = this.pending.filter(p => p.sessionId !== e.sessionId)
      this.pending.push(e)
    }
    this.schedule(next)
  }

  private latestFleet: Fleet | null = null

  // ------------------------------------------------------------ relays

  /**
   * The server calls this once a message he sent the dispatcher has gone
   * (the send route answered ok). In character mode it joins the
   * conversation, and the dispatcher's next answer is relayed in the
   * character's voice. Returns whether a relay is now awaited.
   */
  noteSentToDispatcher(text: string, dispatcher: Session): boolean {
    if (!this.cur) return false
    this.record({ who: 'user', to: 'dispatcher', text })
    const at = Date.now()
    const a = this.awaiting
    if (a && a.sessionId === dispatcher.id) {
      a.at = at
      a.sent = text
      a.retries = 0
      return true
    }
    const msg = lastMessageKey(dispatcher)
    const next: Awaiting = { at, sessionId: dispatcher.id, sent: text, baseMsg: msg, lastMsg: msg, baseTurn: null, retries: 0 }
    this.awaiting = next
    void this.readBaseline(next)
    return true
  }

  /** The dispatcher's newest turn of its own at the send, so a transcript that lags the board is not taken for the answer. */
  private async readBaseline(a: Awaiting): Promise<void> {
    const turns = await this.turnsOf(a.sessionId)
    if (!turns || this.awaiting !== a) return
    const own = turns.filter(t => t.role === 'session').at(-1)
    a.baseTurn = own ? turnKey(own.text) : null
  }

  private async turnsOf(id: string): Promise<Turn[] | null> {
    if (!this.o.readTurns) return null
    try {
      return await this.o.readTurns(id)
    } catch (err) {
      this.o.log(`relay: could not read the dispatcher's turns, using the fleet's clips: ${(err as Error).message}`)
      return null
    }
  }

  private watchDispatcher(a: Awaiting, next: Fleet, mine: FleetEvent[]): void {
    const d = next.sessions.find(s => s.id === a.sessionId)
    if (!d) return
    const msg = lastMessageKey(d)
    const moved = msg !== a.lastMsg
    a.lastMsg = msg
    const stopped = mine.find(e => e.kind === 'asking' || e.kind === 'failed')
    if (stopped) return void this.checkRelay(d, stopped.kind as 'asking' | 'failed')
    if (d.state === 'working' || d.state === 'thinking') return
    if (moved || mine.length || (a.retries > 0 && a.retries <= RELAY_RETRIES)) void this.checkRelay(d, 'reply')
  }

  /** Reads the dispatcher's turns and, when it has answered, relays the answer. One check at a time; a trigger during one runs after it. */
  private async checkRelay(d: Session, kind: Relay['kind']): Promise<void> {
    if (this.checking) {
      if (!this.nextCheck || kind !== 'reply') this.nextCheck = { d, kind }
      return
    }
    this.checking = true
    try {
      const a = this.awaiting
      if (!a) return
      const turns = await this.turnsOf(d.id)
      if (this.awaiting !== a || !this.cur) return
      const found = this.answerIn(kind, d, turns, a)
      if (!found) {
        a.retries++
        return
      }
      this.awaiting = null
      await this.relay(found.relay, found.after, Date.now())
    } finally {
      this.checking = false
      const n = this.nextCheck
      this.nextCheck = null
      if (n && this.awaiting) void this.checkRelay(n.d, n.kind)
    }
  }

  /**
   * The dispatcher's answer, or null when it has not given one yet. With full
   * turns it is what it said after his last message, which must not be the
   * turn it had at the send; with clips only, a newest message that is new
   * and is not his own words coming back.
   */
  private answerIn(kind: Relay['kind'], d: Session, turns: Turn[] | null, a: Awaiting): { relay: Relay; after: string | null } | null {
    let said: string | null = null
    let after: string | null = null
    if (turns) {
      const lastYou = turns.map(t => t.role).lastIndexOf('you')
      const own = turns.slice(lastYou + 1).filter(t => t.role === 'session')
      const newest = own.at(-1)
      if (newest && turnKey(newest.text) !== a.baseTurn) said = own.map(t => t.text).join('\n\n')
      const last = turns.at(-1)
      after = last ? turnKey(last.text) : null
    } else {
      const m = d.messages.at(-1)
      if (m && lastMessageKey(d) !== a.baseMsg && !m.text.includes(a.sent)) said = m.text
      after = m ? turnKey(m.text) : null
    }
    if (kind === 'asking') return { relay: { kind, text: d.asking?.text ?? said ?? d.lastLine }, after }
    if (kind === 'failed') return { relay: { kind, text: said ?? d.lastLine }, after }
    return said ? { relay: { kind, text: said }, after } : null
  }

  /**
   * Writes and speaks the relay. It skips the speaking-up gap, since he is
   * waiting for this answer, and keeps every other courtesy: only to a
   * listening HUD, held while he holds to talk or has just spoken, dropped
   * once it is `relayStaleMs` old.
   */
  private async relay(r: Relay, after: string | null, seenAt: number): Promise<void> {
    const c = this.cur
    if (!c) return
    const history = this.convo.slice()
    if (r.text) this.record({ who: 'dispatcher', text: r.text })
    if (!(this.o.audience?.() ?? { listening: true }).listening) {
      this.o.log('relay: nobody listening; the answer is on screen, nothing spoken')
      return
    }
    const id = randomBytes(8).toString('hex')
    const line = await this.write(id, c, () => relayPrompt(r, history), plainRelay(r), { timeoutMs: this.o.lineTimeoutMs + 3_000, max: 420, sentences: 3 })
    for (;;) {
      if (this.closed || this.cur !== c) return void this.o.log('relay: dropped, the character changed')
      if (Date.now() - seenAt > this.o.relayStaleMs) return void this.o.log(`relay: dropped, held back for over ${Math.round(this.o.relayStaleMs / 1000)} s`)
      const au = this.o.audience?.() ?? { listening: true, holding: false }
      if (!au.listening) return void this.o.log('relay: dropped, nobody listening')
      if (!au.holding && Date.now() >= this.lastVoiceAt + this.o.quietAfterVoiceMs) break
      await new Promise(ok => setTimeout(ok, 250))
    }
    this.lastSpokeAt = Date.now()
    this.record({ who: 'character', text: line.text, source: line.source, after })
    this.o.log(`relay: ${r.kind}, ${line.source}`)
    for (const l of this.announceListeners) l(line)
  }

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
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    for (const u of this.unsub) u()
    this.o.frontMan.close()
    this.o.classifier.close()
  }
}
