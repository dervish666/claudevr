// A session's last turns from GET /api/transcript, for the 2D reader and the
// instrument Stream alike: read now, again every few seconds, and at once
// when the session says or does something. The rules (one read in flight,
// the newest wins, unchanged turns keep their identity) are in
// transcript-poll.ts.

import { useEffect, useMemo, useState } from 'react'
import type { SessionTranscript } from '../../../shared/protocol.ts'
import { Poller, blankTranscript, landProblem, landTurns, transcriptKey, type TranscriptRead, type TranscriptState } from './transcript-poll.ts'

export const TRANSCRIPT_REFRESH_MS = 6000
export const TRANSCRIPT_TURNS = 12
/** A read with no answer by now is reported as failed, and the next interval tries again. */
const TRANSCRIPT_TIMEOUT_MS = 20_000

/**
 * `changed`: anything that means the session said or did something new (its
 * last line and state). A change reads again at once and abandons the read
 * in flight, whose answer would be older.
 */
export function useTranscriptPoll(token: string, sessionId: string | null, changed: string): TranscriptState {
  const key = transcriptKey(sessionId)
  const [state, setState] = useState<TranscriptState>(() => blankTranscript(key, sessionId === null))
  useEffect(() => {
    if (!sessionId) {
      setState(d => (d.key === key && d.loaded && !d.turns && !d.problem ? d : blankTranscript(key, true)))
      return
    }
    setState(d => (d.key === key ? d : blankTranscript(key, false)))
    const poller = new Poller<TranscriptRead>({
      read: async signal => {
        const r = await fetch(`/api/transcript?session=${encodeURIComponent(sessionId)}&limit=${TRANSCRIPT_TURNS}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store', signal })
        const body = (await r.json()) as Partial<SessionTranscript> & { error?: string }
        if (r.ok && Array.isArray(body.turns)) return { ok: true, turns: body.turns }
        return { ok: false, problem: { kind: r.status === 404 || r.status === 501 ? 'none' : 'failed', why: body.error ?? `HTTP ${r.status}` } }
      },
      onResult: v => setState(d => (v.ok ? landTurns(d, key, v.turns, Date.now()) : landProblem(d, key, v.problem))),
      onError: err => {
        console.error('transcript: read failed:', err)
        setState(d => landProblem(d, key, { kind: 'failed', why: err instanceof Error ? err.message : String(err) }))
      },
      everyMs: TRANSCRIPT_REFRESH_MS,
      timeoutMs: TRANSCRIPT_TIMEOUT_MS,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: h => clearTimeout(h as ReturnType<typeof setTimeout>),
      setRepeat: (fn, ms) => setInterval(fn, ms),
      clearRepeat: h => clearInterval(h as ReturnType<typeof setInterval>),
    })
    poller.start()
    return () => poller.stop()
  }, [token, sessionId, key, changed])
  // Until the effect catches up with a new session, show nothing of the last one.
  return useMemo(() => (state.key === key ? state : blankTranscript(key, sessionId === null)), [state, key, sessionId])
}
