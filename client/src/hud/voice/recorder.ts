// The microphone and one clip at a time. The mic stream is opened on the
// first press and kept, so later presses start recording at once instead of
// losing the first word to getUserMedia; it is released when the page is hidden
// (except inside an immersive session, where the page can report hidden while
// the headset shows the scene).

import { audioContext } from './audio-context.ts'

export type MicFailure = 'denied' | 'no-mic' | 'insecure' | 'unsupported' | 'busy' | 'error'

export class MicError extends Error {
  readonly kind: MicFailure
  constructor(kind: MicFailure, message: string) {
    super(message)
    this.name = 'MicError'
    this.kind = kind
  }
}

/** The headset recorded these; the first one supported wins. */
const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4']

export interface Clip {
  blob: Blob
  ms: number
}

/** The mic track as the browser reports it, for the instrument log. */
export interface MicState {
  stream: boolean
  readyState: MediaStreamTrackState | 'none'
  muted: boolean | null
  enabled: boolean | null
  label: string | null
}

export class Recorder {
  private stream: MediaStream | null = null
  private rec: MediaRecorder | null = null
  private chunks: Blob[] = []
  private startedAt = 0
  private aborted = false
  private analyser: AnalyserNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private samples: Float32Array<ArrayBuffer> | null = null
  /** Told when the mic track ends, mutes or unmutes: the evidence for "does the mic survive". */
  onTrackEvent: ((type: string, state: MicState) => void) | null = null

  get hasMic(): boolean {
    return !!this.stream && this.stream.getAudioTracks().some(t => t.readyState === 'live')
  }

  get recording(): boolean {
    return this.rec?.state === 'recording'
  }

  async ensureMic(): Promise<void> {
    if (this.hasMic) return
    if (!window.isSecureContext) throw new MicError('insecure', 'this page is not on HTTPS, so the browser will not offer the microphone')
    if (!navigator.mediaDevices?.getUserMedia) throw new MicError('unsupported', 'this browser has no getUserMedia')
    if (typeof MediaRecorder === 'undefined') throw new MicError('unsupported', 'this browser has no MediaRecorder')
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })
    } catch (err) {
      const e = err as DOMException
      console.error('voice: getUserMedia failed:', e)
      if (e.name === 'NotAllowedError' || e.name === 'SecurityError') throw new MicError('denied', 'microphone permission refused. Allow it for this site in the browser settings, then reload.')
      if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') throw new MicError('no-mic', 'the browser found no microphone')
      if (e.name === 'NotReadableError' || e.name === 'AbortError') throw new MicError('busy', `the microphone is in use or failed to start (${e.message})`)
      throw new MicError('error', `${e.name}: ${e.message}`)
    }
    for (const t of this.stream.getAudioTracks()) for (const type of ['ended', 'mute', 'unmute']) t.addEventListener(type, () => this.onTrackEvent?.(type, this.micState()))
  }

  micState(): MicState {
    const t = this.stream?.getAudioTracks()[0]
    if (!t) return { stream: !!this.stream, readyState: 'none', muted: null, enabled: null, label: null }
    return { stream: true, readyState: t.readyState, muted: t.muted, enabled: t.enabled, label: t.label || null }
  }

  /**
   * How loud the mic is right now, 0 to 1 (-60 dBFS and below is 0, -12 and
   * above is 1). Null when there is no live mic or no audio context.
   */
  level(): number | null {
    if (!this.hasMic) return null
    if (!this.analyser) {
      const c = audioContext()
      if (!c || !this.stream) return null
      try {
        this.source = c.createMediaStreamSource(this.stream)
        this.analyser = c.createAnalyser()
        this.analyser.fftSize = 1024
        this.source.connect(this.analyser)
        this.samples = new Float32Array(this.analyser.fftSize)
      } catch (err) {
        console.error('voice: no level meter:', err)
        return null
      }
    }
    const buf = this.samples!
    this.analyser.getFloatTimeDomainData(buf)
    let sum = 0
    for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!
    const db = 10 * Math.log10(sum / buf.length + 1e-12)
    return Math.max(0, Math.min(1, (db + 60) / 48))
  }

  start(): void {
    if (!this.stream) throw new MicError('error', 'no microphone stream')
    const mimeType = TYPES.find(t => MediaRecorder.isTypeSupported(t))
    this.chunks = []
    this.aborted = false
    this.rec = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined)
    this.rec.ondataavailable = e => {
      if (e.data.size) this.chunks.push(e.data)
    }
    this.startedAt = performance.now()
    this.rec.start()
  }

  /** Ends the clip and hands it over; null if it was aborted. */
  stop(): Promise<Clip | null> {
    const rec = this.rec
    if (!rec || rec.state === 'inactive') return Promise.resolve(null)
    return new Promise(ok => {
      rec.onstop = () => {
        this.rec = null
        if (this.aborted) return ok(null)
        ok({ blob: new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' }), ms: Math.round(performance.now() - this.startedAt) })
      }
      rec.onerror = ev => {
        console.error('voice: MediaRecorder error:', ev)
        this.rec = null
        ok({ blob: new Blob([], { type: rec.mimeType }), ms: Math.round(performance.now() - this.startedAt) })
      }
      rec.stop()
    })
  }

  abort(): void {
    this.aborted = true
    void this.stop()
  }

  release(): void {
    this.abort()
    this.source?.disconnect()
    this.source = null
    this.analyser = null
    for (const t of this.stream?.getTracks() ?? []) t.stop()
    this.stream = null
  }
}
