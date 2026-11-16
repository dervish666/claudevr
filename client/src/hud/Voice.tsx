// The voice dock: the 2D page's view of the shared voice logic in
// voice/useVoice.ts. Hold to talk, what was heard, the answer, and the
// read-back card with its countdown, Send now and Cancel. Below the voice
// row, a small "Type instead" field for when speech cannot be used.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { Fleet } from '../../../shared/protocol.ts'
import type { CardState, Reply, Voice } from './voice/useVoice.ts'
import { displayName } from './conversation.ts'
import { afterTyped, replyIsUpdate, showSpoken } from './dock.ts'

/** What a held card says in place of its countdown. */
const HELD_NOTE = 'Paused. Say send, or cancel.'
/** The bridge reads at most this many characters (TEXT_MAX in bridge/src/server.ts). */
const TYPED_MAX = 2000
/** The typed field, which the row's Type button scrolls to and focuses. */
const TYPE_INPUT_ID = 'voice-type-input'

export function VoiceDock({ v, fleet, now, focusId }: { v: Voice; fleet: Fleet | null; now: number; focusId: string | null }) {
  const focused = focusId ? (fleet?.sessions.find(s => s.id === focusId) ?? null) : null
  // In character mode the dispatcher's panel is the character's, so speech there is "to" the character.
  const focusCallsign = focused ? (focused.kind === 'dispatcher' && v.character ? displayName(v.character.name) : focused.callsign) : null
  const { phase, heard, reply, card, which, muted, voiceOutError, talking, sttProblem, ttsProblem, character, lineWaiting, announced, frontManProblem } = v

  // The pointer: the Quest's controller ray and trigger arrive as pointer
  // events. Capture keeps the hold going if the ray drifts off the button;
  // where capture is not granted, leaving the button ends the clip and sends
  // it for transcription (still only to a card, never straight out).
  const onDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch (err) {
      console.warn('voice: no pointer capture, leaving the button will end the clip:', err)
    }
    void v.begin()
  }
  const onLeave = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) void v.end('leave')
  }

  const label =
    phase.kind === 'recording' ? 'LISTENING… release to finish' : phase.kind === 'transcribing' ? 'TRANSCRIBING…' : phase.kind === 'mic' ? 'ASKING FOR THE MIC…' : 'HOLD TO TALK'

  const armed = card?.state === 'armed'
  // A held card waits for Send, which the quick line has no button for, so it shows as the full card.
  const quickLine = card?.quick === true && !card.held
  // Typed words being read pause the countdown as talking does.
  const paused = talking || v.textPending
  const fleetIds = new Set(fleet?.sessions.map(s => s.id) ?? [])

  // Each new answer gets a number, so a dismiss (or the next hold) hides that
  // answer only: the character's line landing on it later does not bring it
  // back, and the next answer shows. Adjusted during render, as React advises
  // for state that follows a prop.
  const [replyTrack, setReplyTrack] = useState<{ reply: Reply | null; n: number }>({ reply: null, n: 0 })
  let replyN = replyTrack.n
  if (reply !== replyTrack.reply) {
    replyN = reply && replyIsUpdate(replyTrack.reply, reply) ? replyTrack.n : replyTrack.n + 1
    setReplyTrack({ reply, n: replyN })
  }
  const [hiddenReply, setHiddenReply] = useState(0)
  const holding = phase.kind === 'mic' || phase.kind === 'recording'
  const [wasHolding, setWasHolding] = useState(holding)
  if (holding !== wasHolding) {
    setWasHolding(holding)
    if (holding) setHiddenReply(replyN)
  }
  const shownReply = reply !== null && replyN !== hiddenReply ? reply : null
  // The card in play (or the which-one question) wins the pin outright: under
  // it the answer had a 24 px sliver at 1280x720. The answer shows in full once
  // the card clears; meanwhile, beside a card that has done its work, its first
  // line sits in the row. Beside an armed card it is the card's own words.
  const pinBusy = card !== null || which !== null
  const replyInRow = shownReply !== null && pinBusy && which === null && card?.state !== 'armed' && card?.state !== 'sending'

  const health = [sttProblem, ttsProblem].filter(Boolean).join('  ·  ')
  const healthBad = (sttProblem !== null && !v.sttLoading) || ttsProblem !== null

  return (
    <section className="voice" aria-label="Voice">
      {/* The whole of it, at the end of the page from 901 px; the pinned row carries it as one line. */}
      {health && <div className={`voice-health${healthBad ? ' bad' : ''}`}>{health}</div>}

      {character && (
        <div className={`voice-character${frontManProblem ? ' warn' : ''}`} role="status">
          <strong>{character.name}</strong>
          <span className="muted"> · {character.confirm === 'quick' ? '2 s sends' : '5 s cards'} · say "operator mode" to drop it</span>
          {frontManProblem && <span> · {frontManProblem}</span>}
        </div>
      )}

      {v.characters.length > 0 && <CharacterButtons v={v} />}

      {/* Pinned above the voice row from 901 px: the card in play, or when there is none, the answer. */}
      {(shownReply || pinBusy) && (
        <div className="dock-pin">
          {shownReply && !pinBusy && <ReplyBlock reply={shownReply} onDismiss={() => setHiddenReply(replyN)} />}

          {/* The quick line takes a message only when the whole of it fits (sendcard.ts), so its text wraps and is never cut. */}
          {card && quickLine && (
            <div className={`quickline rb-${card.state}`} aria-live="assertive">
              <span className="ql-to">
                To <strong>{card.callsign}</strong>
                {!fleetIds.has(card.sessionId) && <span className="rb-warn"> · gone</span>}
              </span>
              <span className="ql-text">{card.text}</span>
              {armed ? (
                <>
                  {paused ? <span className="rb-left">Paused</span> : <Countdown key={card.sendAt} sendAt={card.sendAt} total={card.countdownMs} slim />}
                  <button className="ql-cancel" onClick={() => v.cancel('Cancelled. Nothing sent.')}>
                    Cancel
                  </button>
                </>
              ) : (
                <span className="rb-result">
                  <span className="rb-state">{stateWord(card.state)}</span> {card.state === 'sent' || card.state === 'sending' ? '' : card.detail}
                  {card.state !== 'sending' && card.state !== 'sent' && (
                    <button className="link" onClick={v.dismissCard}>
                      dismiss
                    </button>
                  )}
                </span>
              )}
            </div>
          )}

          {card && !quickLine && (
            <div className={`readback rb-${card.state}${card.held ? ' rb-held' : ''}`} aria-live="assertive">
              <div className="rb-to">
                To <strong>{card.callsign}</strong>
                {card.viaDispatcher && <span className="muted"> (no session named, so the dispatcher)</span>}
                {card.viaFocus && <span className="muted"> (the session you have open)</span>}
                {!fleetIds.has(card.sessionId) && <span className="rb-warn"> · no longer in the fleet</span>}
              </div>
              <div className="rb-text">{card.text}</div>
              {armed ? (
                <div className="rb-actions">
                  <button className="big rb-send" onClick={() => void v.send()}>
                    Send now
                  </button>
                  <button className="big rb-cancel" onClick={() => v.cancel('Cancelled. Nothing sent.')}>
                    Cancel
                  </button>
                  {card.held ? <span className="rb-left">{HELD_NOTE}</span> : paused ? <span className="rb-left">{talking ? 'Paused while you talk' : 'Paused while your words are read'}</span> : <Countdown key={card.sendAt} sendAt={card.sendAt} total={card.countdownMs} />}
                </div>
              ) : (
                <div className="rb-result">
                  <span className="rb-state">{stateWord(card.state)}</span> {card.detail}
                  {card.state !== 'sending' && (
                    <button className="link" onClick={v.dismissCard}>
                      dismiss
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {which && (
            <div className="which" aria-live="assertive">
              <div className="which-q">{which.say}</div>
              {which.text && <div className="which-text">“{which.text}”</div>}
              <div className="which-opts">
                {which.candidates.map(c => (
                  <button
                    key={c.sessionId}
                    className="big"
                    onClick={() => v.pick(c)}
                  >
                    {c.callsign}
                  </button>
                ))}
                <button className="big rb-cancel" onClick={v.dismissWhich}>
                  Never mind
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="voice-row">
        <button
          className={`talk talk-${phase.kind}`}
          onPointerDown={onDown}
          onPointerUp={() => void v.end('release')}
          onPointerCancel={() => void v.end('cancel')}
          onLostPointerCapture={() => void v.end('release')}
          onPointerLeave={onLeave}
          onContextMenu={e => e.preventDefault()}
          onClick={e => e.preventDefault()}
          onKeyDown={e => e.code === 'Space' && e.preventDefault()}
          disabled={phase.kind === 'transcribing'}
          aria-label="Hold to talk"
          data-hold-to-talk=""
        >
          {label}
          <span className="talk-hint">{phase.kind === 'recording' ? `${Math.max(0, Math.round((now - phase.since) / 1000))} s` : focusCallsign ? `straight to ${focusCallsign}` : 'or hold Space'}</span>
        </button>
        <div className="voice-out">
          {health && (
            <div className={`dock-health${healthBad ? ' bad' : ''}`} role="status" title={health}>
              {health}
            </div>
          )}
          <div className="heard">
            <span className="heard-label">Heard</span>
            {heard === null ? (
              <span className="muted">nothing yet</span>
            ) : heard.ok ? (
              <>
                <span className="heard-text">“{heard.text}”</span>
                <span className="heard-detail">{heard.detail}</span>
              </>
            ) : (
              <>
                <span className="heard-fail">{heard.title}: no transcript</span>
                <span className="heard-detail">{heard.detail}</span>
              </>
            )}
          </div>
          {phase.kind === 'failed' && heard?.ok !== false && (
            <div className="voice-fail">
              <strong>{phase.title}</strong> {phase.detail}
            </div>
          )}
          {phase.kind === 'idle' && phase.note && <div className="voice-note">{phase.note}</div>}
          {replyInRow && (
            <div className="reply-line" title={replyText(shownReply)}>
              {replyText(shownReply)}
            </div>
          )}
          {lineWaiting && <div className="voice-note muted">{displayName(lineWaiting)} is answering…</div>}
          {announced && (
            <div className="spoken announced">
              <span className="spoken-who">{announced.character}</span> {announced.text}
            </div>
          )}
          {voiceOutError && !muted && <div className="voice-note">Voice out failed: {voiceOutError}</div>}
        </div>
        <div className="voice-side">
          <button className={`big mute${muted ? ' on' : ''}`} onClick={v.toggleMute} aria-pressed={muted}>
            {muted ? 'Muted' : 'Sound on'}
          </button>
          <button className="big type-jump" onClick={typeHere} aria-controls={TYPE_INPUT_ID}>
            Type
          </button>
        </div>
      </div>

      <TypeInstead v={v} />
    </section>
  )
}

/**
 * The fallback for when speech cannot be used: words typed here are read
 * by the bridge as a transcript would be, so a message arms the same card
 * with the same countdown. Enter submits (the window's Enter-sends key
 * leaves a text field alone); Escape clears it, and as everywhere also
 * cancels an armed card.
 */
function TypeInstead({ v }: { v: Voice }) {
  const [text, setText] = useState('')
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!text.trim() || v.textPending) return
    // The field stays editable while the words are read, so what was typed meanwhile is kept.
    const sent = text
    void v.submitText(sent).then(used => setText(current => afterTyped(current, sent, used)))
  }
  return (
    <form className="voice-type" onSubmit={submit}>
      <label className="heard-label" htmlFor={TYPE_INPUT_ID}>
        Type instead
      </label>
      <input
        id={TYPE_INPUT_ID}
        type="text"
        value={text}
        maxLength={TYPED_MAX}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Escape') setText('')
        }}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="send"
        placeholder="tell Harbour run the tests"
        aria-describedby="voice-type-hint"
      />
      <button type="submit" className="big" disabled={!text.trim() || v.textPending}>
        {v.textPending ? 'Reading…' : 'Go'}
      </button>
      <span id="voice-type-hint" hidden>
        Read as if spoken. A message shows its card before it is sent.
      </span>
    </form>
  )
}

/**
 * The row's Type button: from 901 px the typed field sits at the end of the
 * page, so this brings it into view (the nearest edge, so a field already in
 * view stays put) and puts the caret in it.
 */
function typeHere() {
  const el = document.getElementById(TYPE_INPUT_ID)
  if (!(el instanceof HTMLInputElement)) return console.error('voice: the typed field is not on the page')
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  el.focus({ preventScroll: true })
}

/** The answer in one line, for the row while a card holds the pin: the character's line when it shows, else what the bridge said. */
const replyText = (r: Reply) => (showSpoken(r) && r.spoken ? `${displayName(r.spoken.character)}: ${r.spoken.text}` : r.say)

/**
 * The answer: a list (status, limits) or a line, and in character mode the
 * character's line. Taller than about 40% of the window it scrolls inside,
 * and fades at the bottom edge while there is more below.
 */
function ReplyBlock({ reply, onDismiss }: { reply: Reply; onDismiss: () => void }) {
  const body = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState(false)
  useLayoutEffect(() => {
    const el = body.current
    if (!el) return
    const check = () => setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 2)
    check()
    el.addEventListener('scroll', check, { passive: true })
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', check)
      ro.disconnect()
    }
  }, [reply])
  const spoken = showSpoken(reply) ? reply.spoken : null
  return (
    <div className="reply" aria-live="polite">
      <div className={`reply-body${more ? ' more' : ''}`} ref={body}>
        {reply.lines ? (
          <ul>
            {reply.lines.map(l => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        ) : reply.spoken ? null : (
          <div>{reply.say}</div>
        )}
        {spoken && (
          <div className="spoken">
            <span className="spoken-who">{spoken.character}</span> {spoken.text}
            {spoken.plain && <span className="muted"> (plain line)</span>}
          </div>
        )}
      </div>
      <button className="link reply-dismiss" onClick={onDismiss}>
        dismiss
      </button>
    </div>
  )
}

const stateWord = (s: CardState) => (s === 'sending' ? 'SENDING…' : s === 'unknown' ? 'OUTCOME UNKNOWN' : s.toUpperCase())

/** One button per configured character, and Operator. The lit one is on; a press waits for the bridge, and a refusal shows as text. */
function CharacterButtons({ v }: { v: Voice }) {
  const current = v.character?.name ?? null
  const buttons = [...v.characters.map(c => ({ name: c.name as string | null, label: displayName(c.name), accent: c.accent })), { name: null, label: 'Operator', accent: null }]
  return (
    <div className="char-row" role="group" aria-label="Character">
      {buttons.map(b => {
        const on = b.name === current
        const pending = v.characterPending !== null && v.characterPending.name === b.name
        return (
          <button
            key={b.name ?? 'operator'}
            className={`char-btn${on ? ' on' : ''}${pending ? ' pending' : ''}`}
            style={b.accent ? ({ '--char-accent': b.accent } as CSSProperties) : undefined}
            aria-pressed={on}
            disabled={v.characterPending !== null}
            onClick={() => v.chooseCharacter(b.name)}
          >
            {b.label}
            {pending && <span className="char-pending"> …</span>}
          </button>
        )
      })}
      {v.characterError && (
        <span className="char-error" role="alert">
          {v.characterError}
        </span>
      )}
    </div>
  )
}

/** The seconds left before an armed card sends itself, with a bar that drains. */
function Countdown({ sendAt, total, slim }: { sendAt: number; total: number; slim?: boolean }) {
  const [left, setLeft] = useState(() => Math.max(0, sendAt - Date.now()))
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, sendAt - Date.now())), 100)
    return () => clearInterval(t)
  }, [sendAt])
  return (
    <span className={`rb-count${slim ? ' slim' : ''}`} role="timer" aria-label={`Sends in ${Math.ceil(left / 1000)} seconds`}>
      <span className="rb-count-n">{slim ? Math.ceil(left / 1000) : `Sends in ${Math.ceil(left / 1000)}`}</span>
      <span className="rb-bar">
        <span className="rb-bar-fill" style={{ transform: `scaleX(${Math.min(1, left / total)})` }} />
      </span>
    </span>
  )
}
