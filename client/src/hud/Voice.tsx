// The voice dock: the 2D page's view of the shared voice logic in
// voice/useVoice.ts. Hold to talk, what was heard, what it meant, and the
// read-back card with its countdown, Send now and Cancel.

import { useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Fleet } from '../../../shared/protocol.ts'
import { SEND_COUNTDOWN_MS, type Voice } from './voice/useVoice.ts'

export function VoiceDock({ v, fleet, now, focusId }: { v: Voice; fleet: Fleet | null; now: number; focusId: string | null }) {
  const focusCallsign = focusId ? (fleet?.sessions.find(s => s.id === focusId)?.callsign ?? null) : null
  const { phase, heard, reply, card, which, muted, voiceOutError, talking, sttProblem, ttsProblem } = v

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
  const fleetIds = new Set(fleet?.sessions.map(s => s.id) ?? [])

  return (
    <section className="voice" aria-label="Voice">
      {(sttProblem || ttsProblem) && (
        <div className={`voice-health${v.sttLoading ? '' : ' bad'}`} role="status">
          {[sttProblem, ttsProblem].filter(Boolean).join('  ·  ')}
        </div>
      )}

      {card && (
        <div className={`readback rb-${card.state}`} aria-live="assertive">
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
              {talking ? <span className="rb-left">Paused while you talk</span> : <Countdown key={card.sendAt} sendAt={card.sendAt} />}
            </div>
          ) : (
            <div className="rb-result">
              <span className="rb-state">{card.state === 'sending' ? 'SENDING…' : card.state.toUpperCase()}</span> {card.detail}
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
        >
          {label}
          <span className="talk-hint">{phase.kind === 'recording' ? `${Math.max(0, Math.round((now - phase.since) / 1000))} s` : focusCallsign ? `straight to ${focusCallsign}` : 'or hold Space'}</span>
        </button>
        <div className="voice-out">
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
          {reply && (
            <div className="reply">
              {reply.lines ? (
                <ul>
                  {reply.lines.map(l => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              ) : (
                reply.say
              )}
            </div>
          )}
          {voiceOutError && !muted && <div className="voice-note">Voice out failed: {voiceOutError}</div>}
        </div>
        <button className={`big mute${muted ? ' on' : ''}`} onClick={v.toggleMute} aria-pressed={muted}>
          {muted ? 'Muted' : 'Sound on'}
        </button>
      </div>
    </section>
  )
}

/** The seconds left before an armed card sends itself, with a bar that drains. */
function Countdown({ sendAt }: { sendAt: number }) {
  const [left, setLeft] = useState(() => Math.max(0, sendAt - Date.now()))
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, sendAt - Date.now())), 100)
    return () => clearInterval(t)
  }, [sendAt])
  return (
    <span className="rb-count" role="timer" aria-label={`Sends in ${Math.ceil(left / 1000)} seconds`}>
      <span className="rb-count-n">Sends in {Math.ceil(left / 1000)}</span>
      <span className="rb-bar">
        <span className="rb-bar-fill" style={{ width: `${Math.min(100, (left / SEND_COUNTDOWN_MS) * 100)}%` }} />
      </span>
    </span>
  )
}
