// Speech-to-text as the HUD sees it: a clip and the context in, a VoiceReply
// out. Today the bridge does the work (bridgeStt uploads the clip). An
// in-browser provider (Whisper or Moonshine on WebGPU) would implement the
// same interface: transcribe locally, then post the text to /api/interpret
// for the parse, so the HUD around it would not change.

import type { Interpretation, PendingLine, SpokenLine, VoiceContext, VoiceReply } from '../../../../shared/protocol.ts'

export interface ClientSttProvider {
  readonly name: string
  /** `focusId`: the session open in the reader, which unaddressed speech goes to. `signal` abandons the upload (Cancel). */
  transcribe(clip: Blob, context: VoiceContext, focusId: string | null, signal?: AbortSignal): Promise<VoiceReply>
}

const failed = (error: string): VoiceReply => ({ transcript: { ok: false, reason: 'failed', error, provider: null, audioMs: null, peakDb: null }, interpretation: null })

/**
 * How long a clip may take, upload to answer. The bridge's own bounds on one
 * clip come to about 40 s (decode 15 s, the helper 20 s, the classifier at
 * its default 3 s), so this is above them with some room for a short queue,
 * not a worst case for two clips at once. Without it a link
 * that dies mid-request would leave the HUD transcribing, and every card's
 * countdown paused, until the browser gave up.
 */
export const CLIP_TIMEOUT_MS = 60_000

export function bridgeStt(token: string, timeoutMs = CLIP_TIMEOUT_MS): ClientSttProvider {
  return {
    name: 'bridge',
    async transcribe(clip, context, focusId, signal) {
      // The deadline and Cancel both stop the request, in its headers or its
      // body; only Cancel reads as cancelled. The race settles it even if a
      // fetch ignores its signal part way through.
      const ctl = new AbortController()
      const late = new Error(`no answer from the bridge in ${Math.round(timeoutMs / 1000)} s`)
      const stopped = new Promise<VoiceReply>(settle =>
        ctl.signal.addEventListener(
          'abort',
          () => {
            if (ctl.signal.reason === late) {
              console.error(`voice: ${late.message} for a clip`)
              settle(failed(late.message))
            } else {
              console.info('voice: upload abandoned by Cancel')
              settle(failed('cancelled'))
            }
          },
          { once: true },
        ),
      )
      const timer = setTimeout(() => ctl.abort(late), timeoutMs)
      const cancel = () => ctl.abort(new Error('cancelled'))
      if (signal?.aborted) cancel()
      else signal?.addEventListener('abort', cancel, { once: true })
      const request = async (): Promise<VoiceReply> => {
        let r: Response
        try {
          r = await fetch(`/api/transcribe?context=${context}${focusId ? `&focus=${encodeURIComponent(focusId)}` : ''}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': clip.type || 'application/octet-stream' }, body: clip, cache: 'no-store', signal: ctl.signal })
        } catch (err) {
          // Stopped: the abort's own answer above wins the race.
          if (ctl.signal.aborted) throw err
          console.error('voice: upload failed:', err)
          return failed(`bridge unreachable: ${err instanceof Error ? err.message : String(err)}`)
        }
        let body: Partial<VoiceReply> & { error?: string }
        try {
          body = (await r.json()) as Partial<VoiceReply> & { error?: string }
        } catch (err) {
          if (ctl.signal.aborted) throw err
          console.error('voice: unreadable transcribe reply:', err)
          return failed(`the bridge answered HTTP ${r.status} with something unreadable`)
        }
        // Gate refusals (401, 403) carry { error } rather than a transcript.
        if (!body.transcript) return failed(body.error ?? `HTTP ${r.status}`)
        return { transcript: body.transcript, interpretation: body.interpretation ?? null, line: body.line ?? null }
      }
      try {
        return await Promise.race([request(), stopped])
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
      }
    },
  }
}

/**
 * Text parsed by the bridge, as a clip's transcript would be: typed into the
 * fallback field, or from a provider that transcribes on its own. Rejects
 * with the bridge's reason when there is no interpretation. `signal` covers
 * the reply body as well (typed.ts gives it a deadline and Cancel).
 */
export async function interpretText(token: string, text: string, context: VoiceContext, focusId: string | null = null, signal?: AbortSignal): Promise<{ interpretation: Interpretation; line: PendingLine | null }> {
  const r = await fetch('/api/interpret', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text, context, focus: focusId }), cache: 'no-store', signal })
  let body: { interpretation?: Interpretation; line?: PendingLine; error?: string }
  try {
    body = (await r.json()) as typeof body
  } catch (err) {
    throw new Error(`the bridge answered HTTP ${r.status} with something unreadable (${err instanceof Error ? err.message : String(err)})`)
  }
  if (!body.interpretation) throw new Error(body.error ?? `HTTP ${r.status}`)
  return { interpretation: body.interpretation, line: body.line ?? null }
}

/**
 * Character mode: the spoken line for an answer. The bridge holds the
 * request until the line is ready or its timeout passes, then answers with
 * the plain line; this rejects only when the bridge cannot be reached.
 */
export async function fetchLine(token: string, id: string): Promise<SpokenLine> {
  const r = await fetch(`/api/line?id=${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
  const body = (await r.json()) as Partial<SpokenLine> & { error?: string }
  if (!r.ok || typeof body.text !== 'string') throw new Error(body.error ?? `HTTP ${r.status}`)
  return body as SpokenLine
}
