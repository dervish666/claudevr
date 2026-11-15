// The voice logic both views share: hold to talk, what was heard, what it
// meant, and the read-back card. The 2D dock (Voice.tsx) and instrument mode
// each draw it their own way; there is one recorder, one card and one set of
// window listeners, owned by the HUD.
//
// A `tell` becomes a card ("To Tally: ...") shown on screen, not spoken, with
// a short countdown. When the countdown ends the card sends itself through
// POST /api/send; "Send now" skips the wait and "Cancel" (button or voice)
// stops it. Talking pauses the countdown. When a card sends, and what its
// answer may change, is decided in sendcard.ts, which has its own tests; this
// hook feeds it the phase and draws what it says.
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
import { MicError, Recorder } from './recorder.ts'
import { Speaker } from './speaker.ts'
import { bridgeStt, fetchLine, type ClientSttProvider } from './stt.ts'
import { SendCards, UNKNOWN_DETAIL, postSend, randomRequestId, type Card, type SendOutcome } from './sendcard.ts'

export { DISMISS_MS, QUICK_COUNTDOWN_MS, QUICK_MAX_CHARS, SEND_COUNTDOWN_MS, type Card, type CardState } from './sendcard.ts'

/** How long a "who is it for?" waits for its answer. */
export const CARD_TTL_MS = 60_000
/** An unprompted line that could not be spoken for this long (he was talking, a reply was playing) is dropped. */
const ANNOUNCE_STALE_MS = 15_000
/** A press shorter than this is a slip, not an utterance. */
export const MIN_CLIP_MS = 350
const MUTE_KEY = 'claudevr.muted'
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

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)

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
  /** Bumped by every new hold and every new answer, so a line that arrives late is not spoken over newer words. */
  const lineSeq = useRef(0)
  const lineWaitingRef = useRef<string | null>(null)
  lineWaitingRef.current = lineWaiting
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
  useEffect(() => () => cards.dispose(), [cards])
  /** The intent a clip was recorded under: a Cancel since then makes what it says stale. */
  const clipIntent = useRef(0)
  /** The clip upload in flight, so Cancel can abandon it. */
  const upload = useRef<AbortController | null>(null)
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

  const speak = useCallback(
    (text: string) => {
      if (mutedRef.current || !text) return
      setVoiceOutError(null)
      speaker.say(text).catch((err: unknown) => {
        console.error('voice: speech failed:', err)
        setVoiceOutError(err instanceof Error ? err.message : String(err))
      })
    },
    [speaker],
  )

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
      if (cards.cancel(why)) tap('voice-cancelled')
      if (whichRef.current) setWhich(null)
    },
    [cards],
  )

  /** Arms a card. `generation`: the intent the words came under; a stale one arms nothing. */
  const arm = (sessionId: string, callsign: string, text: string, viaDispatcher: boolean, viaFocus = false, generation?: number) => {
    if (generation !== undefined && !cards.isCurrent(generation)) return tap('voice-arm-dropped', { why: 'cancelled since' })
    setWhich(null)
    const quickConfirm = characterRef.current?.confirm === 'quick'
    const c = cards.arm({ sessionId, callsign, text, viaDispatcher, viaFocus, quickConfirm }, generation)
    if (c) tap('voice-armed', { chars: text.length, viaDispatcher, viaFocus, quick: c.quick, quickConfirm })
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
      const seq = ++lineSeq.current
      setLineWaiting(p.character)
      const t0 = Date.now()
      const land = (text: string, isPlain: boolean, how: Record<string, unknown>) => {
        if (seq !== lineSeq.current) return tap('voice-line-dropped', { why: 'overtaken', ...how })
        setLineWaiting(null)
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
    [token, speak],
  )

  // ---------------------------------------------------------------- meaning
  const act = useCallback(
    (i: Interpretation, line: PendingLine | null = null, generation?: number) => {
      setReply({ say: i.say, lines: i.kind === 'status' || i.kind === 'limits' ? i.lines : null, spoken: null })
      tap('voice-meaning', { kind: i.kind, line: !!line })
      // In character the bridge writes the spoken line; the action below is taken now and does not wait for it.
      if (line) {
        ui.heard()
        speakLine(line, i.kind === 'tell' ? `Message for ${i.callsign}.` : i.say)
      } else lineSeq.current++
      const say = (t: string) => {
        if (!line) speak(t)
      }
      switch (i.kind) {
        case 'tell':
          // Shown, not spoken: the card on screen is the read-back.
          arm(i.sessionId, i.callsign, i.text, i.viaDispatcher, i.viaFocus === true, generation)
          return
        case 'confirm':
          send()
          return
        case 'cancel':
          cancel('Cancelled by voice. Nothing sent.')
          say(i.say)
          return
        case 'which':
          setWhich({ text: i.text, heard: i.heard, why: i.why, candidates: i.candidates, say: i.say, expiresAt: Date.now() + CARD_TTL_MS })
          say(i.say)
          return
        case 'target': {
          const w = whichRef.current
          if (w?.text) {
            arm(i.sessionId, i.callsign, w.text, false, false, generation)
          } else {
            setWhich(null)
            selectRef.current(i.sessionId)
            say(i.say)
          }
          return
        }
        case 'switch':
        case 'read':
          selectRef.current(i.sessionId)
          say(i.say)
          return
        case 'dispatcher':
          homeRef.current()
          say(i.say)
          return
        case 'status':
        case 'limits':
        case 'voice':
        case 'character':
        case 'ask':
        case 'unknown':
          say(i.say)
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
    holding.current = true
    // A new clip is a new intent: whatever Cancel happens from here on makes this clip stale.
    clipIntent.current = cards.newIntent()
    unlockAudio()
    speaker.stop()
    // He is talking again: a line still being written for his last words is not spoken over these.
    lineSeq.current++
    setLineWaiting(null)
    tap('voice-begin', { mic: recorder.micState() })
    if (!recorder.hasMic) {
      go({ kind: 'mic' })
      try {
        await recorder.ensureMic()
      } catch (err) {
        holding.current = false
        const e = err instanceof MicError ? err : new MicError('error', String(err))
        tap('voice-mic-failed', { kind: e.kind, message: e.message })
        go({ kind: 'failed', title: e.kind === 'denied' ? 'MICROPHONE REFUSED' : 'NO MICROPHONE', detail: e.message })
        return
      }
      // Released while the permission prompt was up: nothing recorded, and say so.
      if (!holding.current) return go({ kind: 'idle', note: 'Microphone ready. Hold again and speak.' })
    }
    try {
      recorder.start()
    } catch (err) {
      console.error('voice: recorder failed to start:', err)
      holding.current = false
      return go({ kind: 'failed', title: 'RECORDER FAILED', detail: err instanceof Error ? err.message : String(err) })
    }
    go({ kind: 'recording', since: Date.now() })
  }, [recorder, speaker, cards])

  const end = useCallback(
    async (how: EndHow) => {
      if (!holding.current) return
      holding.current = false
      if (phaseRef.current.kind !== 'recording') return
      tap('voice-end', { how })
      if (how === 'cancel' || how === 'tap') {
        recorder.abort()
        return go({ kind: 'idle', note: how === 'tap' ? null : 'Recording cancelled: the browser took the pointer away. Nothing was sent.' })
      }
      const clip = await recorder.stop()
      if (!clip) return go({ kind: 'idle', note: 'Recording cancelled.' })
      if (!clip.blob.size) {
        setHeard({ ok: false, title: 'EMPTY CLIP', detail: 'The recorder captured nothing. Is the microphone muted?' })
        return go({ kind: 'failed', title: 'EMPTY CLIP', detail: 'The recorder captured nothing. Is the microphone muted?' })
      }
      if (clip.ms < MIN_CLIP_MS) return go({ kind: 'idle', note: `Too short (${clip.ms} ms): hold while you speak.` })
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
        return go({ kind: 'failed', title, detail: t.error })
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

  // The keyboard, for testing on a desktop: hold Space to talk, Enter sends, Escape cancels.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return
      if (e.code === 'Space') {
        e.preventDefault()
        if (!e.repeat) void begin()
      } else if (e.key === 'Enter' && cards.card?.state === 'armed') {
        e.preventDefault()
        send()
      } else if (e.key === 'Escape') cancel('Cancelled. Nothing sent.')
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTyping(e.target)) {
        e.preventDefault()
        void end('release')
      }
    }
    // Losing focus mid-hold means the key-up never comes: end the clip there.
    // Inside an immersive session the window may lose focus to the session
    // itself, while the hold goes on through the controller: leave it be.
    const blur = () => {
      const xr = immersive.current
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
    if (talkingRef.current || lineWaitingRef.current || speaker.busy()) return
    held.current = null
    setAnnounced(h.line)
    tap('voice-announce', { source: h.line.source, ms: h.line.ms })
    speak(h.line.text)
  }, [speaker, speak])
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
  const frontManProblem = !character || !fm ? null : fm.state === 'starting' ? `${character.name}: front man starting` : fm.state === 'unavailable' || fm.state === 'off' ? `${character.name} speaking plain lines: ${fm.error ?? fm.state}` : fm.error ? `${character.name}: ${fm.error}` : null

  const toggleMute = useCallback(() => {
    const m = !mutedRef.current
    setMuted(m)
    writeMuted(m)
    if (m) speaker.stop()
  }, [speaker])

  const pick = (c: Candidate) => {
    const w = whichRef.current
    if (w?.text) arm(c.sessionId, c.callsign, w.text, false)
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
  }
}
