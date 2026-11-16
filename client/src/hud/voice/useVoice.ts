// The voice logic both views share: hold to talk, what was heard, what it
// meant, and the read-back card. The 2D dock (Voice.tsx) and instrument mode
// each draw it their own way; there is one recorder, one card and one set of
// window listeners, owned by the HUD.
//
// A `tell` becomes a card ("To Tally: ...") shown on screen, not spoken, with
// a short countdown. When the countdown ends the card sends itself through
// POST /api/send; "Send now" skips the wait and "Cancel" (button or voice)
// stops it. Talking pauses the countdown. A press that ends without usable
// words (a failed or empty clip, no mic) holds an armed card: no countdown,
// it waits for Send or a confirm word. When a card sends, and what its
// answer may change, is decided in sendcard.ts, which has its own tests; this
// hook feeds it the phase and draws what it says. Typed words (the "Type
// instead" field) go the same way as a transcript, to the same card.
//
// Character mode (a character selected on the bridge) changes the words and
// the wait, never what is done: the action is taken here at once, exactly as
// in operator mode, a short tone says he was heard, and the character's line
// is fetched and spoken when it is ready. A character with confirm "quick"
// arms a 2 s countdown shown as a slim line instead of the 5 s card, when the
// whole message fits on the line; a longer one gets the full card. The
// bridge may also push unprompted lines; they are spoken, never acted on,
// and held back while he talks or while muted.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Candidate, CharacterInfo, CharacterReply, ClientMessage, Interpretation, PendingLine, SpokenLine, Transcript, VoiceContext, VoiceStatus } from '../../../../shared/protocol.ts'
import { unlockAudio } from './audio-context.ts'
import { ui } from './blip.ts'
import { TALK_ATTR, keyAction, type KeyTarget } from './keys.ts'
import { MicError, Recorder } from './recorder.ts'
import { applyArmedRule, route } from './route.ts'
import { Speaker } from './speaker.ts'
import { bridgeStt, fetchLine, interpretText, type ClientSttProvider } from './stt.ts'
import { LineWait, TypedReader } from './typed.ts'
import { displayName } from '../conversation.ts'
import { SendCards, UNKNOWN_DETAIL, armRequestFor, postSend, randomRequestId, type Card, type SendOutcome, type TellToArm } from './sendcard.ts'

export { DISMISS_MS, QUICK_COUNTDOWN_MS, QUICK_MAX_CHARS, SEND_COUNTDOWN_MS, type Card, type CardState } from './sendcard.ts'

/** How long a "who is it for?" waits for its answer. */
export const CARD_TTL_MS = 60_000
/** An unprompted line that could not be spoken for this long (he was talking, a reply was playing) is dropped. */
const ANNOUNCE_STALE_MS = 15_000
/** A press shorter than this is a slip, not an utterance. */
export const MIN_CLIP_MS = 350
const MUTE_KEY = 'claudevr.muted'
/** Said when a press ends without usable words and holds the armed card. */
export const HELD_SAY = "Didn't catch that. Paused."
/** The arming tone waits this long (seconds) after the heard tone, so the two do not sound at once. */
const ARM_TONE_AFTER_HEARD_S = 0.16
const NO_CHARACTERS: CharacterInfo[] = []

export type Phase =
  | { kind: 'idle'; note: string | null }
  | { kind: 'mic' }
  | { kind: 'recording'; since: number }
  | { kind: 'transcribing' }
  | { kind: 'failed'; title: string; detail: string }

/** Holding to talk, waiting for the mic, or transcribing: the countdown waits. */
const isTalking = (p: Phase) => p.kind === 'recording' || p.kind === 'transcribing' || p.kind === 'mic'

export interface Which {
  text: string
  heard: string | null
  why: 'ambiguous' | 'no-match' | 'no-dispatcher'
  candidates: Candidate[]
  say: string
  expiresAt: number
}

/** What was heard: a transcript, or why there is none. Never an empty string standing in for either. */
export type Heard = { ok: true; text: string; detail: string } | { ok: false; title: string; detail: string }

/** How a hold ended. `tap` is a press too short to be speech, taken as a click: dropped without a note. */
export type EndHow = 'release' | 'leave' | 'cancel' | 'tap'

const FAILURE_TITLES: Record<Extract<Transcript, { ok: false }>['reason'], string> = {
  unavailable: 'TRANSCRIPTION UNAVAILABLE',
  'too-big': 'CLIP TOO BIG',
  'too-long': 'CLIP TOO LONG',
  'bad-audio': 'UNREADABLE CLIP',
  empty: 'EMPTY CLIP',
  silent: 'SILENT CLIP',
  'no-words': 'NO WORDS HEARD',
  busy: 'TRANSCRIBER BUSY',
  failed: 'TRANSCRIPTION FAILED',
}

/** The key rule's view of an event target. Null for anything that is not an element (the window, the document). */
function describeTarget(t: EventTarget | null): KeyTarget | null {
  if (!(t instanceof HTMLElement)) return null
  return { tag: t.tagName, role: t.getAttribute('role'), editable: t.isContentEditable, talk: t.hasAttribute(TALK_ATTR) }
}

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1'
  } catch (err) {
    console.error('voice: cannot read the mute setting:', err)
    return false
  }
}

function writeMuted(m: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, m ? '1' : '0')
  } catch (err) {
    console.error('voice: cannot keep the mute setting:', err)
  }
}

/**
 * Instrument mode listens here for the log: voice steps, and every window
 * blur and visibility change, with what the hook did about it. The 2D page
 * leaves it null.
 */
export const voiceTap: { emit: ((type: string, data?: Record<string, unknown>) => void) | null } = { emit: null }
const tap = (type: string, data?: Record<string, unknown>) => voiceTap.emit?.(type, data)

export interface VoiceOptions {
  token: string
  voice: VoiceStatus | null
  /** The session speech that names nobody goes to: the one open in the reader, or the selected tile. */
  focusId: string | null
  onSelect: (sessionId: string) => void
  /** "Dispatcher": drop the selection. */
  onHome: () => void
  /**
   * True while an immersive session runs. Then a window blur does not end
   * the clip and a hidden page does not release the mic, because the
   * headset may report either on entering the session while the scene, and
   * the person, carry on.
   */
  immersive: { readonly current: boolean }
  /** The last unprompted line the bridge pushed, to speak. */
  announce?: SpokenLine | null
  /** Tells the bridge whether this HUD is muted and whether he is holding to talk. */
  post?: (m: ClientMessage) => void
}

/** What was said back: the plain answer, and in character mode the character's line once it is in. */
export interface Reply {
  say: string
  lines: string[] | null
  /** The line spoken in character, or null in operator mode and while it is being written. */
  spoken: { character: string; text: string; plain: boolean } | null
}

export interface Voice {
  phase: Phase
  heard: Heard | null
  reply: Reply | null
  card: Card | null
  which: Which | null
  muted: boolean
  voiceOutError: string | null
  talking: boolean
  sttProblem: string | null
  ttsProblem: string | null
  sttLoading: boolean
  /** The selected character, or null in operator mode. */
  character: CharacterInfo | null
  /** Every configured character, for the character buttons; empty when there are none. */
  characters: CharacterInfo[]
  /** A character button press on its way to the bridge (name null: operator mode), or null. */
  characterPending: { name: string | null } | null
  /** Why the last character button press failed, or null. */
  characterError: string | null
  /** The character buttons: select a character, or null for operator mode. Answered as "be X" would be. */
  chooseCharacter: (name: string | null) => void
  /** The character whose line is being written, or null. */
  lineWaiting: string | null
  /** The last unprompted line, as spoken. */
  announced: SpokenLine | null
  /** Why character mode is speaking plain lines, or null. */
  frontManProblem: string | null
  recorder: Recorder
  speaker: Speaker
  begin: () => Promise<void>
  end: (how: EndHow) => Promise<void>
  send: () => void
  cancel: (why: string) => void
  dismissCard: () => void
  pick: (c: Candidate) => void
  dismissWhich: () => void
  toggleMute: () => void
  /** Called from a frame loop: sends an armed card whose countdown has run out, even where timers are throttled. */
  tick: (now: number) => void
  /**
   * Typed words, read by the bridge as a transcript would be and acted on
   * the same way (a tell arms the same card). True when they were used, so
   * the field can clear; false when refused, failed or cancelled meanwhile.
   */
  submitText: (text: string) => Promise<boolean>
  /** Typed words on their way to the bridge. */
  textPending: boolean
}

export function useVoice(o: VoiceOptions): Voice {
  const { token, focusId, voice } = o
  const focusRef = useRef(focusId)
  focusRef.current = focusId
  const selectRef = useRef(o.onSelect)
  selectRef.current = o.onSelect
  const homeRef = useRef(o.onHome)
  homeRef.current = o.onHome
  const immersive = o.immersive
  const stt: ClientSttProvider = useMemo(() => bridgeStt(token), [token])
  const recorder = useMemo(() => new Recorder(), [])
  const speaker = useMemo(() => new Speaker(token), [token])
  const [phase, setPhase] = useState<Phase>({ kind: 'idle', note: null })
  const [heard, setHeard] = useState<Heard | null>(null)
  const [reply, setReply] = useState<Reply | null>(null)
  const [lineWaiting, setLineWaiting] = useState<string | null>(null)
  const [announced, setAnnounced] = useState<SpokenLine | null>(null)
  const character = voice?.persona?.character ?? null
  const characters = voice?.persona?.characters ?? NO_CHARACTERS
  const [characterPending, setCharacterPending] = useState<{ name: string | null } | null>(null)
  const characterPendingRef = useRef(characterPending)
  characterPendingRef.current = characterPending
  const [characterError, setCharacterError] = useState<string | null>(null)
  const characterRef = useRef(character)
  characterRef.current = character
  /** The line awaited, if any. Every new hold and every new answer replaces or drops it, so a line that arrives late is not spoken over newer words. */
  const lines = useMemo(() => new LineWait(setLineWaiting), [])
  const [card, setCardState] = useState<Card | null>(null)
  const [which, setWhichState] = useState<Which | null>(null)
  const [muted, setMuted] = useState(readMuted)
  const [voiceOutError, setVoiceOutError] = useState<string | null>(null)
  // Refs mirror the state the event handlers read, so a handler bound on one
  // render never acts on a card that has since changed.
  const whichRef = useRef<Which | null>(null)
  const holding = useRef(false)
  const phaseRef = useRef<Phase>(phase)
  const mutedRef = useRef(muted)
  // The card itself lives in SendCards, which calls these through refs so it never holds a stale token or speaker.
  const postRef = useRef<(c: Card) => Promise<SendOutcome>>(() => Promise.reject(new Error('not ready')))
  postRef.current = c => postSend((url, init) => fetch(url, init), token, c)
  const outcomeRef = useRef<(c: Card, o: SendOutcome, current: boolean) => void>(() => {})
  const cards = useMemo(
    () =>
      new SendCards({
        now: () => Date.now(),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: h => clearTimeout(h as ReturnType<typeof setTimeout>),
        newRequestId: randomRequestId,
        post: c => postRef.current(c),
        onChange: setCardState,
        onSending: (c, how) => tap('voice-send', { chars: c.text.length, how }),
        onOutcome: (c, o, current) => outcomeRef.current(c, o, current),
      }),
    [],
  )
  const typed = useMemo(() => new TypedReader(cards, { setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: h => clearTimeout(h as ReturnType<typeof setTimeout>) }), [cards])
  /** The intent a clip was recorded under: a Cancel since then makes what it says stale. */
  const clipIntent = useRef(0)
  /** The clip upload in flight, so Cancel can abandon it. */
  const upload = useRef<AbortController | null>(null)
  // Going (unpair, or the page leaving the HUD): a clip or typed words still
  // out are given up, and dispose() makes their answers stale, so nothing
  // they say can arm a card behind the pairing screen.
  useEffect(
    () => () => {
      upload.current?.abort()
      upload.current = null
      typed.abandon()
      cards.dispose()
    },
    [cards, typed],
  )
  const setWhich = (w: Which | null) => {
    whichRef.current = w
    setWhichState(w)
  }
  const go = (p: Phase) => {
    phaseRef.current = p
    setPhase(p)
    cards.setTalking(isTalking(p))
  }
  mutedRef.current = muted

  // With voice out turned off in the config the banner already says so; trying
  // anyway would only add a failure under it. A provider that failed (fish.audio
  // with no fallback) is still tried: its status clears only on a good request,
  // so skipping it would keep the voice silent until the bridge restarts.
  const ttsOkRef = useRef(true)
  ttsOkRef.current = voice?.tts.provider !== 'off'
  const speak = useCallback(
    (text: string) => {
      if (mutedRef.current || !text || !ttsOkRef.current) return
      setVoiceOutError(null)
      speaker.say(text).catch((err: unknown) => {
        console.error('voice: speech failed:', err)
        setVoiceOutError(err instanceof Error ? err.message : String(err))
      })
    },
    [speaker],
  )

  /**
   * A press that ended without usable words: a failed, empty or too short
   * clip, no mic, no recorder. An armed card is held rather than left to
   * count down again, since he may have been saying "cancel".
   */
  const miss = (p: Phase) => {
    const held = cards.hold()
    go(p)
    if (!held) return
    tap('voice-card-held', { phase: p.kind, title: p.kind === 'failed' ? p.title : undefined })
    speak(HELD_SAY)
  }

  // ---------------------------------------------------------------- send
  const send = useCallback(() => {
    cards.sendNow()
  }, [cards])

  // What became of a send. Spoken in operator mode; in character mode a sent
  // message gets a tone (instrument mode plays its own on sending), since the
  // character has already spoken about it.
  outcomeRef.current = (c, o, current) => {
    tap('voice-sent', { ok: o.kind === 'sent', outcome: o.kind, status: o.kind === 'refused' ? o.status : undefined, late: current ? undefined : true })
    if (!current) {
      // A newer card took the screen while this one was on its way. Its
      // answer must not replace that card, and must not go unseen either.
      const what = o.kind === 'sent' ? 'sent.' : o.kind === 'unknown' ? UNKNOWN_DETAIL.replace(/^N/, 'n') : o.kind === 'limited' ? 'rate limited, not sent.' : `refused (HTTP ${o.status}), not sent.`
      const note = `Earlier message to ${c.callsign}: ${what}`
      console.warn(`voice: ${note}`)
      if (phaseRef.current.kind === 'idle') go({ kind: 'idle', note })
      if (!talkingRef.current && !(o.kind === 'sent' && characterRef.current)) speak(note)
      return
    }
    switch (o.kind) {
      case 'sent':
        if (characterRef.current) {
          if (!immersive.current) ui.sent()
        } else speak(`Sent to ${c.callsign}.`)
        return
      case 'limited':
        return speak(`Rate limited. Try again in ${o.retryAfterS ?? 'a few'} seconds.`)
      case 'refused':
        return speak(`Refused. ${o.error ?? ''}`)
      case 'unknown':
        return speak(UNKNOWN_DETAIL)
    }
  }

  const cancel = useCallback(
    (why: string) => {
      // A clip still being transcribed is abandoned with the card: what it says must not arm a fresh one.
      if (upload.current) {
        upload.current.abort()
        upload.current = null
        tap('voice-transcribe-abandoned')
      }
      // So are typed words still being read, which frees the field and the countdown at once.
      if (typed.abandon()) tap('voice-typed-abandoned')
      if (cards.cancel(why)) tap('voice-cancelled')
      if (whichRef.current) setWhich(null)
    },
    [cards, typed],
  )

  /**
   * Arms a card. `generation`: the intent the words came under; a stale one
   * arms nothing. `toneAt`: seconds until the 2D page's arming tone, so it
   * can follow the heard tone. Instrument mode plays its own.
   */
  const arm = (t: TellToArm, generation?: number, toneAt = 0) => {
    if (generation !== undefined && !cards.isCurrent(generation)) return tap('voice-arm-dropped', { why: 'cancelled since' })
    setWhich(null)
    const r = armRequestFor(t, characterRef.current?.confirm)
    const c = cards.arm(r, generation)
    if (!c) return
    tap('voice-armed', { chars: t.text.length, viaDispatcher: t.viaDispatcher, viaFocus: r.viaFocus, viaClassifier: t.viaClassifier === true, quick: c.quick, quickConfirm: r.quickConfirm })
    if (!immersive.current && !mutedRef.current) ui.armed(toneAt)
  }

  // A "who is it for?" lapses on its own.
  useEffect(() => {
    const t = setInterval(() => {
      const w = whichRef.current
      if (w && Date.now() > w.expiresAt) setWhich(null)
    }, 1000)
    return () => clearInterval(t)
  }, [])

  const talking = isTalking(phase)
  const talkingRef = useRef(talking)
  talkingRef.current = talking

  const tick = useCallback((now: number) => cards.tick(now), [cards])

  // ---------------------------------------------------------------- character lines
  /** Fetches the character's line and speaks it, unless newer words came first. The bridge answers within its timeout; only a dead link falls back here. */
  const speakLine = useCallback(
    (p: PendingLine, plain: string) => {
      const ticket = lines.start(p.character)
      const t0 = Date.now()
      const land = (text: string, isPlain: boolean, how: Record<string, unknown>) => {
        if (!lines.land(ticket)) return tap('voice-line-dropped', { why: 'overtaken', ...how })
        setReply(r => (r ? { ...r, spoken: { character: p.character, text, plain: isPlain } } : r))
        tap('voice-line', { ms: Date.now() - t0, ...how })
        if (talkingRef.current) return
        speak(text)
      }
      fetchLine(token, p.id).then(
        l => land(l.text, l.source === 'fallback', { source: l.source, bridgeMs: l.ms, reason: l.reason }),
        (err: unknown) => {
          console.error('voice: could not fetch the line, speaking the plain one:', err)
          land(plain, true, { source: 'client-fallback', error: String(err) })
        },
      )
    },
    [token, speak, lines],
  )

  // ---------------------------------------------------------------- meaning
  const act = useCallback(
    (i: Interpretation, line: PendingLine | null = null, generation?: number) => {
      const step = route(i, whichRef.current, cards.card?.state === 'armed')
      // A card is its own read-back, so the plain "To Tally: ..." would only
      // turn up under it once the card cleared. A character's line is kept.
      const cardOnly = (step.do === 'arm' || step.do === 'send') && !line
      setReply(cardOnly ? null : { say: i.say, lines: i.kind === 'status' || i.kind === 'limits' ? i.lines : null, spoken: null })
      tap('voice-meaning', { kind: i.kind, line: !!line })
      // In character the bridge writes the spoken line; the action below is taken now and does not wait for it.
      if (line) {
        ui.heard()
        speakLine(line, i.kind === 'tell' ? `Message for ${i.callsign}.` : i.say)
      } else lines.drop()
      const say = (t: string) => {
        if (!line) speak(t)
      }
      const toneAt = line ? ARM_TONE_AFTER_HEARD_S : 0
      switch (step.do) {
        case 'arm':
          // Shown, not spoken: the card on screen is the read-back.
          arm(step.tell, generation, toneAt)
          return
        case 'send':
          send()
          return
        case 'cancel':
          cancel('Cancelled. Nothing sent.')
          say(step.say)
          return
        case 'which': {
          const w = step.which
          // A new message waiting for its target replaces the armed card, so the
          // name he gives next is read as the answer, not as a switch. A name for
          // anything else that matched nothing holds the card.
          const done = applyArmedRule(step, cards)
          if (done) tap(done === 'held' ? 'voice-card-held' : 'voice-card-replaced', { phase: 'which' })
          setWhich({ text: w.text, heard: w.heard, why: w.why, candidates: w.candidates, say: w.say, expiresAt: Date.now() + CARD_TTL_MS })
          say(w.say)
          return
        }
        case 'select':
          if (step.clearWhich) setWhich(null)
          selectRef.current(step.sessionId)
          say(step.say)
          return
        case 'home':
          homeRef.current()
          say(step.say)
          return
        case 'say':
          // Words that came to nothing while a card was armed may have been
          // "cancel": the card waits for Send or Cancel, as after a failed clip.
          if (applyArmedRule(step, cards)) tap('voice-card-held', { phase: 'words', kind: i.kind })
          say(step.say)
          return
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [send, cancel, speak, speakLine],
  )

  // ---------------------------------------------------------------- character buttons
  const chooseCharacter = useCallback(
    (name: string | null) => {
      if (characterPendingRef.current) return
      const pending = { name }
      characterPendingRef.current = pending
      setCharacterPending(pending)
      setCharacterError(null)
      tap('character-press', { name })
      const fail = (why: string, err?: unknown) => {
        console.error(`voice: character button: ${why}`, err ?? '')
        setCharacterError(why)
        tap('character-failed', { name, why })
      }
      void (async () => {
        try {
          const r = await fetch('/api/character', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name }), cache: 'no-store' })
          const body = (await r.json().catch((err: unknown) => ({ error: `unreadable reply: ${String(err)}` }))) as Partial<CharacterReply> & { error?: string }
          if (!r.ok || body.interpretation?.kind !== 'character') return fail(`Could not change character (HTTP ${r.status}): ${body.error ?? 'no reason given'}.`)
          act(body.interpretation, body.line ?? null)
        } catch (err) {
          fail(`Could not change character: bridge unreachable (${err instanceof Error ? err.message : String(err)}).`, err)
        } finally {
          characterPendingRef.current = null
          setCharacterPending(null)
        }
      })()
    },
    [token, act],
  )

  const context = (): VoiceContext => (cards.card?.state === 'armed' ? 'confirm' : whichRef.current ? 'target' : 'none')

  // ---------------------------------------------------------------- hold to talk
  const begin = useCallback(async () => {
    if (holding.current || phaseRef.current.kind === 'transcribing' || phaseRef.current.kind === 'mic') return
    // Released a moment ago and the recorder has not handed over that clip
    // yet: starting now would take its audio, so this press waits it out.
    if (recorder.busy) return tap('voice-begin-busy')
    holding.current = true
    // A new clip is a new intent: whatever Cancel happens from here on makes this clip stale.
    clipIntent.current = cards.newIntent()
    unlockAudio()
    speaker.stop()
    // He is talking again: a line still being written for his last words is not spoken over these.
    lines.drop()
    tap('voice-begin', { mic: recorder.micState() })
    if (!recorder.hasMic) {
      go({ kind: 'mic' })
      try {
        await recorder.ensureMic()
      } catch (err) {
        holding.current = false
        const e = err instanceof MicError ? err : new MicError('error', String(err))
        tap('voice-mic-failed', { kind: e.kind, message: e.message })
        miss({ kind: 'failed', title: e.kind === 'denied' ? 'MICROPHONE REFUSED' : 'NO MICROPHONE', detail: e.message })
        return
      }
      // Released while the permission prompt was up: nothing recorded, and say so.
      if (!holding.current) return miss({ kind: 'idle', note: 'Microphone ready. Hold again and speak.' })
    }
    try {
      recorder.start()
    } catch (err) {
      console.error('voice: recorder failed to start:', err)
      holding.current = false
      return miss({ kind: 'failed', title: 'RECORDER FAILED', detail: err instanceof Error ? err.message : String(err) })
    }
    go({ kind: 'recording', since: Date.now() })
  }, [recorder, speaker, cards])

  const end = useCallback(
    async (how: EndHow) => {
      if (!holding.current) return
      holding.current = false
      if (phaseRef.current.kind !== 'recording') return
      tap('voice-end', { how })
      // A tap is a click, not an utterance, so it leaves a card as it was.
      if (how === 'tap') {
        recorder.abort()
        return go({ kind: 'idle', note: null })
      }
      if (how === 'cancel') {
        recorder.abort()
        return miss({ kind: 'idle', note: 'Recording cancelled: the browser took the pointer away. Nothing was sent.' })
      }
      const clip = await recorder.stop()
      if (!clip) return miss({ kind: 'idle', note: 'Recording cancelled.' })
      if (!clip.blob.size) {
        setHeard({ ok: false, title: 'EMPTY CLIP', detail: 'The recorder captured nothing. Is the microphone muted?' })
        return miss({ kind: 'failed', title: 'EMPTY CLIP', detail: 'The recorder captured nothing. Is the microphone muted?' })
      }
      if (clip.ms < MIN_CLIP_MS) return miss({ kind: 'idle', note: `Too short (${clip.ms} ms): hold while you speak.` })
      const generation = clipIntent.current
      if (!cards.isCurrent(generation)) {
        tap('voice-heard-dropped', { why: 'cancelled while recording' })
        return go({ kind: 'idle', note: 'Cancelled while you spoke: that clip was not used. Nothing sent.' })
      }
      go({ kind: 'transcribing' })
      const ctl = new AbortController()
      upload.current = ctl
      let r: Awaited<ReturnType<ClientSttProvider['transcribe']>>
      try {
        r = await stt.transcribe(clip.blob, context(), focusRef.current, ctl.signal)
      } finally {
        if (upload.current === ctl) upload.current = null
      }
      // Cancelled while it was being transcribed: what it says arms nothing.
      if (!cards.isCurrent(generation)) {
        tap('voice-heard-dropped', { why: 'cancelled while transcribing' })
        // The phase may have moved on during the await, which TS cannot see through the ref.
        if ((phaseRef.current as Phase).kind === 'transcribing') go({ kind: 'idle', note: 'Cancelled while transcribing: that clip was not used. Nothing sent.' })
        return
      }
      const t = r.transcript
      if (!t.ok) {
        const title = FAILURE_TITLES[t.reason]
        tap('voice-heard', { ok: false, reason: t.reason, audioMs: t.audioMs, peakDb: t.peakDb })
        setHeard({ ok: false, title, detail: t.error })
        return miss({ kind: 'failed', title, detail: t.error })
      }
      tap('voice-heard', { ok: true, words: t.text.split(/\s+/).length, audioMs: t.audioMs, totalMs: t.totalMs })
      const via = how === 'leave' ? ' Ended when the pointer left the button.' : ''
      setHeard({ ok: true, text: t.text, detail: `${(t.audioMs / 1000).toFixed(1)} s clip, ${t.totalMs} ms to text (${t.provider}).${via}` })
      go({ kind: 'idle', note: null })
      if (r.interpretation) act(r.interpretation, r.line ?? null, generation)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recorder, stt, act, cards],
  )

  // ---------------------------------------------------------------- typed instead
  // For when speech cannot be used: the words go to /api/interpret with the
  // same context and focus a clip would carry, and the answer goes through
  // act(), so a tell arms the same card with the same countdown.
  const [textPending, setTextPending] = useState(false)
  const submitText = useCallback(
    async (text: string): Promise<boolean> => {
      const words = text.trim()
      if (!words || typed.busy) return false
      setTextPending(true)
      const ctx = context()
      tap('voice-typed', { chars: words.length, context: ctx })
      // typed.ts: a new intent, as a clip is, and an armed card waits while the
      // words are read, so a typed "cancel" is not overtaken by the countdown.
      // The wait ends on the answer, after 10 s, or on Cancel.
      const m = await typed.read(signal => interpretText(token, words, ctx, focusRef.current, signal))
      setTextPending(false)
      if (!m) return false
      if (!m.ok) {
        if (m.abandoned) {
          console.info('voice: typed words abandoned by Cancel')
          return false
        }
        console.error('voice: typed words not read:', m.error)
        const detail = `The bridge could not read them: ${m.error instanceof Error ? m.error.message : String(m.error)}`
        tap('voice-typed-failed', { error: String(m.error) })
        // A clip or a Cancel since then owns what happens next; otherwise this is a press without usable words.
        if (cards.isCurrent(m.generation)) {
          // What was typed stays in view, with why it went nowhere under it.
          setHeard({ ok: true, text: words, detail: 'Typed, not spoken.' })
          miss({ kind: 'failed', title: 'TYPED WORDS NOT READ', detail })
        }
        return false
      }
      if (!cards.isCurrent(m.generation)) {
        tap('voice-typed-dropped', { why: 'cancelled or overtaken since' })
        return false
      }
      setHeard({ ok: true, text: words, detail: 'Typed, not spoken.' })
      if (!isTalking(phaseRef.current)) go({ kind: 'idle', note: null })
      act(m.value.interpretation, m.value.line, m.generation)
      return true
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token, act, cards, typed],
  )

  // The keyboard, for testing on a desktop: hold Space to talk, Enter sends,
  // Escape cancels. keys.ts decides, so a focused button keeps its own keys.
  /** The Space down that started a hold, so only its own key-up ends it. */
  const spaceHold = useRef(false)
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const a = keyAction(e, cards.card?.state === 'armed', describeTarget(e.target))
      if (a === 'talk') {
        e.preventDefault()
        if (e.repeat) return
        spaceHold.current = true
        void begin()
      } else if (a === 'send') {
        e.preventDefault()
        send()
      } else if (a === 'cancel') cancel('Cancelled. Nothing sent.')
    }
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !spaceHold.current) return
      spaceHold.current = false
      e.preventDefault()
      void end('release')
    }
    // Losing focus mid-hold means the key-up never comes: end the clip there.
    // Inside an immersive session the window may lose focus to the session
    // itself, while the hold goes on through the controller: leave it be.
    const blur = () => {
      const xr = immersive.current
      if (!xr) spaceHold.current = false
      tap('window-blur', { immersive: xr, holding: holding.current, action: xr ? 'ignored' : holding.current ? 'ended the clip' : 'none' })
      if (!xr) void end('release')
    }
    const focus = () => tap('window-focus', { immersive: immersive.current })
    const hide = () => {
      const xr = immersive.current
      const hidden = document.visibilityState === 'hidden'
      tap('document-visibility', { state: document.visibilityState, immersive: xr, action: hidden ? (xr ? 'ignored, mic kept' : 'released the mic') : 'none', mic: recorder.micState() })
      if (hidden && !xr) {
        void end('cancel')
        recorder.release()
        speaker.stop()
      }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    window.addEventListener('focus', focus)
    document.addEventListener('visibilitychange', hide)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      window.removeEventListener('focus', focus)
      document.removeEventListener('visibilitychange', hide)
    }
  }, [begin, end, send, cancel, recorder, speaker, immersive, cards])

  useEffect(() => () => recorder.release(), [recorder])

  // ---------------------------------------------------------------- speaking up
  // The bridge only speaks up to a HUD that says it is listening, and waits
  // while he holds to talk.
  const post = o.post
  useEffect(() => {
    post?.({ type: 'presence', muted, holding: talking })
  }, [post, muted, talking])

  // An unprompted line is spoken when nothing else is: not over him, not
  // over a reply, not while a line for his words is on its way. Muted drops it.
  const announce = o.announce ?? null
  const held = useRef<{ line: SpokenLine; until: number } | null>(null)
  const lastAnnounce = useRef<string | null>(null)
  const trySpeakHeld = useCallback(() => {
    const h = held.current
    if (!h) return
    if (Date.now() > h.until) {
      held.current = null
      tap('voice-announce-dropped', { why: 'stale' })
      return
    }
    if (mutedRef.current) {
      held.current = null
      return
    }
    if (talkingRef.current || lines.waiting || speaker.busy()) return
    held.current = null
    setAnnounced(h.line)
    tap('voice-announce', { source: h.line.source, ms: h.line.ms })
    speak(h.line.text)
  }, [speaker, speak, lines])
  useEffect(() => {
    if (!announce || announce.id === lastAnnounce.current) return
    lastAnnounce.current = announce.id
    if (mutedRef.current) return
    held.current = { line: announce, until: Date.now() + ANNOUNCE_STALE_MS }
    trySpeakHeld()
  }, [announce, trySpeakHeld])
  useEffect(() => {
    const t = setInterval(trySpeakHeld, 500)
    return () => clearInterval(t)
  }, [trySpeakHeld])

  const stt0 = voice?.stt
  const sttProblem = !stt0 ? null : stt0.state === 'ready' ? null : stt0.state === 'loading' ? `Speech model loading (${stt0.provider})…` : `TRANSCRIPTION UNAVAILABLE: ${stt0.error ?? stt0.state}`
  const ttsProblem = voice && !voice.tts.ok ? `Voice out unavailable: ${voice.tts.error ?? 'unknown'}` : null
  const fm = voice?.persona?.frontMan
  const who = character ? displayName(character.name) : ''
  const frontManProblem = !character || !fm ? null : fm.state === 'starting' ? `${who}: front man starting` : fm.state === 'unavailable' || fm.state === 'off' ? `${who} speaking plain lines: ${fm.error ?? fm.state}` : fm.error ? `${who}: ${fm.error}` : null

  const toggleMute = useCallback(() => {
    const m = !mutedRef.current
    setMuted(m)
    writeMuted(m)
    if (m) speaker.stop()
  }, [speaker])

  const pick = (c: Candidate) => {
    const w = whichRef.current
    if (w?.text) arm({ sessionId: c.sessionId, callsign: c.callsign, text: w.text, viaDispatcher: false })
    else {
      setWhich(null)
      selectRef.current(c.sessionId)
    }
  }

  return {
    phase,
    heard,
    reply,
    card,
    which,
    muted,
    voiceOutError,
    talking,
    sttProblem,
    ttsProblem,
    sttLoading: stt0?.state === 'loading',
    character,
    characters,
    characterPending,
    characterError,
    chooseCharacter,
    lineWaiting,
    announced,
    frontManProblem,
    recorder,
    speaker,
    begin,
    end,
    send,
    cancel,
    dismissCard: () => cards.dismiss(),
    pick,
    dismissWhich: () => setWhich(null),
    toggleMute,
    tick,
    submitText,
    textPending,
  }
}
