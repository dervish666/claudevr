// Speech-to-text as the HUD sees it: a clip and the context in, a VoiceReply
// out. Today the bridge does the work (bridgeStt uploads the clip). An
// in-browser provider (Whisper or Moonshine on WebGPU) would implement the
// same interface: transcribe locally, then post the text to /api/interpret
// for the parse, so the HUD around it would not change.

import type { Interpretation, SpokenLine, VoiceContext, VoiceReply } from '../../../../shared/protocol.ts'

export interface ClientSttProvider {
  readonly name: string
  /** `focusId`: the session open in the reader, which unaddressed speech goes to. `signal` abandons the upload (Cancel). */
  transcribe(clip: Blob, context: VoiceContext, focusId: string | null, signal?: AbortSignal): Promise<VoiceReply>
}

const failed = (error: string): VoiceReply => ({ transcript: { ok: false, reason: 'failed', error, provider: null, audioMs: null, peakDb: null }, interpretation: null })

export function bridgeStt(token: string): ClientSttProvider {
  return {
    name: 'bridge',
    async transcribe(clip, context, focusId, signal) {
      let r: Response
      try {
        r = await fetch(`/api/transcribe?context=${context}${focusId ? `&focus=${encodeURIComponent(focusId)}` : ''}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': clip.type || 'application/octet-stream' }, body: clip, cache: 'no-store', signal })
      } catch (err) {
        if (signal?.aborted) {
          console.info('voice: upload abandoned by Cancel')
          return failed('cancelled')
        }
        console.error('voice: upload failed:', err)
        return failed(`bridge unreachable: ${err instanceof Error ? err.message : String(err)}`)
      }
      let body: Partial<VoiceReply> & { error?: string }
      try {
        body = (await r.json()) as Partial<VoiceReply> & { error?: string }
      } catch (err) {
        console.error('voice: unreadable transcribe reply:', err)
        return failed(`the bridge answered HTTP ${r.status} with something unreadable`)
      }
      // Gate refusals (401, 403) carry { error } rather than a transcript.
      if (!body.transcript) return failed(body.error ?? `HTTP ${r.status}`)
      return { transcript: body.transcript, interpretation: body.interpretation ?? null, line: body.line ?? null }
    },
  }
}

/** Text from a provider that transcribes on its own, parsed by the bridge. */
export async function interpretText(token: string, text: string, context: VoiceContext, focusId: string | null = null): Promise<Interpretation> {
  const r = await fetch('/api/interpret', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text, context, focus: focusId }), cache: 'no-store' })
  const body = (await r.json()) as { interpretation?: Interpretation; error?: string }
  if (!body.interpretation) throw new Error(body.error ?? `HTTP ${r.status}`)
  return body.interpretation
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
