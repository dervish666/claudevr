// The voice logic both views share: hold to talk, what was heard, what it
// meant, and the read-back card. The 2D dock (Voice.tsx) and instrument mode
// each draw it their own way; there is one recorder, one card and one set of
// window listeners, owned by the HUD.
//
// A `tell` becomes a card ("To Tally: ...") shown on screen, not spoken, with
// a short countdown. When the countdown ends the card sends itself through
// POST /api/send; "Send now" skips the wait and "Cancel" (button or voice)
// stops it. Talking pauses the countdown.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Candidate, Interpretation, Transcript, VoiceContext, VoiceStatus } from '../../../../shared/protocol.ts'
import { unlockAudio } from './audio-context.ts'
import { MicError, Recorder } from './recorder.ts'
import { Speaker } from './speaker.ts'
import { bridgeStt, type ClientSttProvider } from './stt.ts'

/** How long a "who is it for?" waits for its answer. */
export const CARD_TTL_MS = 60_000
/** How long a card shows before it sends itself: the window to read it and cancel. */
export const SEND_COUNTDOWN_MS = 5_000
/** How long a sent or cancelled card stays up before it clears itself. */
export const DISMISS_MS = 2_500
/** A press shorter than this is a slip, not an utterance. */
export const MIN_CLIP_MS = 350
const MUTE_KEY = 'claudevr.muted'

export type Phase =
  | { kind: 'idle'; note: string | null }
  | { kind: 'mic' }
  | { kind: 'recording'; since: number }
  | { kind: 'transcribing' }
  | { kind: 'failed'; title: string; detail: string }

export type CardState = 'armed' | 'sending' | 'sent' | 'refused' | 'limited' | 'expired' | 'cancelled'

export interface Card {
  id: number
  sessionId: string
  callsign: string
  text: string
  viaDispatcher: boolean
  viaFocus: boolean
  /** When the countdown ends and the card sends itself. */
  sendAt: number
  state: CardState
  detail: string | null
}

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
  /**
   * A reason this message may not be armed, or null. Instrument mode refuses
   * speech that would fall through to the dispatcher while a demo tile is
   * selected, so a demo tile can never send anything anywhere.
   */
  refuseSend?: { readonly current: ((m: { sessionId: string; viaDispatcher: boolean; viaFocus: boolean }) => string | null) | null }
}

export interface Voice {
  phase: Phase
  heard: Heard | null
  reply: { say: string; lines: string[] | null } | null
  card: Card | null
  which: Which | null
  muted: boolean
  voiceOutError: string | null
  talking: boolean
  sttProblem: string | null
  ttsProblem: string | null
  sttLoading: boolean
  recorder: Recorder
  speaker: Speaker
  begin: () => Promise<void>
  end: (how: EndHow) => Promise<void>
  send: () => Promise<void>
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
  const refuseSend = o.refuseSend
  const stt: ClientSttProvider = useMemo(() => bridgeStt(token), [token])
  const recorder = useMemo(() => new Recorder(), [])
  const speaker = useMemo(() => new Speaker(token), [token])
  const [phase, setPhase] = useState<Phase>({ kind: 'idle', note: null })
  const [heard, setHeard] = useState<Heard | null>(null)
  const [reply, setReply] = useState<{ say: string; lines: string[] | null } | null>(null)
  const [card, setCardState] = useState<Card | null>(null)
  const [which, setWhichState] = useState<Which | null>(null)
  const [muted, setMuted] = useState(readMuted)
  const [voiceOutError, setVoiceOutError] = useState<string | null>(null)
  // Refs mirror the state the event handlers read, so a handler bound on one
  // render never acts on a card that has since changed.
  const cardRef = useRef<Card | null>(null)
  const whichRef = useRef<Which | null>(null)
  const holding = useRef(false)
  const phaseRef = useRef<Phase>(phase)
  const mutedRef = useRef(muted)
  const cardSeq = useRef(0)
  const setCard = (c: Card | null) => {
    cardRef.current = c
    setCardState(c)
  }
  const setWhich = (w: Which | null) => {
    whichRef.current = w
    setWhichState(w)
  }
  const go = (p: Phase) => {
    phaseRef.current = p
    setPhase(p)
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
  const send = useCallback(async () => {
    const c = cardRef.current
    if (!c || c.state !== 'armed') return
    setCard({ ...c, state: 'sending', detail: null })
    tap('voice-send', { chars: c.text.length })
    let r: Response
    let body: { error?: string; said?: string } = {}
    try {
      r = await fetch('/api/send', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: c.sessionId, text: c.text }), cache: 'no-store' })
      body = (await r.json().catch((err: unknown) => ({ error: `unreadable reply: ${String(err)}` }))) as typeof body
    } catch (err) {
      console.error('voice: send failed:', err)
      setCard({ ...c, state: 'refused', detail: `Not sent: bridge unreachable (${err instanceof Error ? err.message : String(err)}).` })
      tap('voice-sent', { ok: false, why: 'unreachable' })
      speak('Not sent. The bridge is unreachable.')
      return
    }
    tap('voice-sent', { ok: r.ok, status: r.status })
    if (r.ok) {
      setCard({ ...c, state: 'sent', detail: body.said ? `Sent. ${body.said}` : 'Sent.' })
      speak(`Sent to ${c.callsign}.`)
    } else if (r.status === 429) {
      const wait = Number(r.headers.get('retry-after')) || null
      setCard({ ...c, state: 'limited', detail: `Rate limited: not sent. Try again in ${wait ?? '?'} s.` })
      speak(`Rate limited. Try again in ${wait ?? 'a few'} seconds.`)
    } else {
      setCard({ ...c, state: 'refused', detail: `Refused (HTTP ${r.status}): ${body.error ?? 'no reason given'}. Not sent.` })
      speak(`Refused. ${body.error ?? ''}`)
    }
  }, [token, speak])

  const cancel = useCallback((why: string) => {
    const c = cardRef.current
    if (c?.state === 'armed') {
      setCard({ ...c, state: 'cancelled', detail: why })
      tap('voice-cancelled')
    }
    if (whichRef.current) setWhich(null)
  }, [])

  const arm = (sessionId: string, callsign: string, text: string, viaDispatcher: boolean, viaFocus = false) => {
    setWhich(null)
    const refused = refuseSend?.current?.({ sessionId, viaDispatcher, viaFocus }) ?? null
    if (refused) {
      setReply({ say: refused, lines: null })
      tap('voice-refused', { why: refused })
      return
    }
    setCard({ id: ++cardSeq.current, sessionId, callsign, text, viaDispatcher, viaFocus, sendAt: Date.now() + SEND_COUNTDOWN_MS, state: 'armed', detail: null })
    tap('voice-armed', { chars: text.length, viaDispatcher, viaFocus })
  }

  // A "who is it for?" lapses on its own.
  useEffect(() => {
    const t = setInterval(() => {
      const w = whichRef.current
      if (w && Date.now() > w.expiresAt) setWhich(null)
    }, 1000)
    return () => clearInterval(t)
  }, [])

  // The countdown: an armed card sends itself when it ends. Holding to talk
  // (to say "cancel", or anything else) pauses it, and it starts again in
  // full afterwards if the card is still armed.
  const armedId = card?.state === 'armed' ? card.id : null
  const talking = phase.kind === 'recording' || phase.kind === 'transcribing' || phase.kind === 'mic'
  const talkingRef = useRef(talking)
  talkingRef.current = talking
  useEffect(() => {
    if (armedId === null || talking) return
    const c = cardRef.current
    if (!c || c.id !== armedId || c.state !== 'armed') return
    setCard({ ...c, sendAt: Date.now() + SEND_COUNTDOWN_MS })
    const t = setTimeout(() => void send(), SEND_COUNTDOWN_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armedId, talking, send])

  const tick = useCallback(
    (now: number) => {
      const c = cardRef.current
      if (c?.state === 'armed' && !talkingRef.current && now >= c.sendAt) void send()
    },
    [send],
  )

  // A card that has done its job (sent, or cancelled) clears itself. One
  // that failed (refused, rate limited) stays until it is dismissed, so a
  // message that did not go is never missed.
  const doneId = card && (card.state === 'sent' || card.state === 'cancelled') ? card.id : null
  useEffect(() => {
    if (doneId === null) return
    const t = setTimeout(() => {
      if (cardRef.current?.id === doneId) setCard(null)
    }, DISMISS_MS)
    return () => clearTimeout(t)
  }, [doneId])

  // ---------------------------------------------------------------- meaning
  const act = useCallback(
    (i: Interpretation) => {
      setReply({ say: i.say, lines: i.kind === 'status' || i.kind === 'limits' ? i.lines : null })
      tap('voice-meaning', { kind: i.kind })
      switch (i.kind) {
        case 'tell':
          // Shown, not spoken: the card on screen is the read-back.
          arm(i.sessionId, i.callsign, i.text, i.viaDispatcher, i.viaFocus === true)
          return
        case 'confirm':
          void send()
          return
        case 'cancel':
          cancel('Cancelled by voice. Nothing sent.')
          speak(i.say)
          return
        case 'which':
          setWhich({ text: i.text, heard: i.heard, why: i.why, candidates: i.candidates, say: i.say, expiresAt: Date.now() + CARD_TTL_MS })
          speak(i.say)
          return
        case 'target': {
          const w = whichRef.current
          if (w?.text) {
            arm(i.sessionId, i.callsign, w.text, false)
          } else {
            setWhich(null)
            selectRef.current(i.sessionId)
            speak(i.say)
          }
          return
        }
        case 'switch':
        case 'read':
          selectRef.current(i.sessionId)
          speak(i.say)
          return
        case 'dispatcher':
          homeRef.current()
          speak(i.say)
          return
        case 'status':
        case 'limits':
        case 'voice':
        case 'unknown':
          speak(i.say)
          return
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [send, cancel, speak],
  )

  const context = (): VoiceContext => (cardRef.current?.state === 'armed' ? 'confirm' : whichRef.current ? 'target' : 'none')

  // ---------------------------------------------------------------- hold to talk
  const begin = useCallback(async () => {
    if (holding.current || phaseRef.current.kind === 'transcribing' || phaseRef.current.kind === 'mic') return
    holding.current = true
    unlockAudio()
    speaker.stop()
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
  }, [recorder, speaker])

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
      go({ kind: 'transcribing' })
      const r = await stt.transcribe(clip.blob, context(), focusRef.current)
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
      if (r.interpretation) act(r.interpretation)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recorder, stt, act],
  )

  // The keyboard, for testing on a desktop: hold Space to talk, Enter sends, Escape cancels.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return
      if (e.code === 'Space') {
        e.preventDefault()
        if (!e.repeat) void begin()
      } else if (e.key === 'Enter' && cardRef.current?.state === 'armed') {
        e.preventDefault()
        void send()
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
  }, [begin, end, send, cancel, recorder, speaker, immersive])

  useEffect(() => () => recorder.release(), [recorder])

  const stt0 = voice?.stt
  const sttProblem = !stt0 ? null : stt0.state === 'ready' ? null : stt0.state === 'loading' ? `Speech model loading (${stt0.provider})…` : `TRANSCRIPTION UNAVAILABLE: ${stt0.error ?? stt0.state}`
  const ttsProblem = voice && !voice.tts.ok ? `Voice out unavailable: ${voice.tts.error ?? 'unknown'}` : null

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
    recorder,
    speaker,
    begin,
    end,
    send,
    cancel,
    dismissCard: () => setCard(null),
    pick,
    dismissWhich: () => setWhich(null),
    toggleMute,
    tick,
  }
}
