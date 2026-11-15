// Text-to-speech on the bridge, behind TtsProvider. The Quest browser has no
// speechSynthesis, so the bridge renders speech to a file and the HUD plays it.
//
// SayTts runs macOS `say` and converts its AIFF to WebM/Opus with ffmpeg,
// which the Quest browser plays (it records WebM/Opus, and Chromium plays
// what it records). The text is untrusted, since it includes what sessions
// said: it goes to `say` on stdin, never on a command line or through a
// shell, it is capped, and `say`'s embedded [[commands]] are stripped.

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TtsStatus } from '../../../shared/protocol.ts'
import { runProgram } from './audio.ts'

export interface Speech {
  audio: Buffer
  mime: string
}

export interface TtsProvider {
  readonly name: string
  status(): TtsStatus
  speak(text: string): Promise<Speech>
  /** Only a provider with more than one voice has these. */
  voices?(): { name: string; heardAs: string[] }[]
  voice?(): string
  select?(name: string): void
}

export class TtsUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TtsUnavailable'
  }
}

export class NoTts implements TtsProvider {
  readonly name = 'off'
  status(): TtsStatus {
    return { provider: 'off', ok: false, error: 'text-to-speech is off in the bridge config (tts.provider)' }
  }
  speak(): Promise<Speech> {
    return Promise.reject(new TtsUnavailable(this.status().error!))
  }
}

/** What reaches the speech engine: no control characters, no `say` commands, at most `max` characters. */
export function speakable(text: string, max: number): string {
  const t = text
    .replace(/\[\[[^\]]*\]\]/g, ' ')
    .replace(/[[\]]/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' '))
  return `${cut.slice(0, end > max / 2 ? end : max).trim()}…`
}

export interface SayOptions {
  voice: string
  maxChars: number
  say?: string
  ffmpeg?: string
  log?: (...a: unknown[]) => void
}

export class SayTts implements TtsProvider {
  readonly name = 'say'
  private readonly o: Required<SayOptions>
  private st: TtsStatus
  private readonly cache = new Map<string, Speech>()

  constructor(o: SayOptions) {
    this.o = { say: '/usr/bin/say', ffmpeg: 'ffmpeg', log: (...a) => console.log('[tts]', ...a), ...o }
    this.st = { provider: `say (${o.voice})`, ok: true, error: null }
  }

  /** Checks the voice and the encoder once, so a missing one shows on the HUD before anyone asks. */
  async check(): Promise<TtsStatus> {
    try {
      const voices = await runProgram(this.o.say, ['-v', '?'], { timeoutMs: 10_000 })
      if (voices.code !== 0) throw new Error(`say -v ? exited with ${voices.code}: ${voices.stderr.trim().slice(0, 200)}`)
      if (!voices.stdout.toString('utf8').split('\n').some(l => l.startsWith(`${this.o.voice} `))) throw new Error(`macOS has no voice called ${this.o.voice}; pick one from say -v '?'`)
      const enc = await runProgram(this.o.ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 10_000 })
      if (!/\blibopus\b/.test(enc.stdout.toString('utf8'))) throw new Error('ffmpeg has no libopus encoder')
      this.st = { ...this.st, ok: true, error: null }
    } catch (err) {
      this.st = { ...this.st, ok: false, error: (err as Error).message }
      this.o.log('unavailable:', this.st.error)
    }
    return this.st
  }

  status(): TtsStatus {
    return this.st
  }

  async speak(text: string): Promise<Speech> {
    if (!this.st.ok) throw new TtsUnavailable(this.st.error ?? 'text-to-speech is unavailable')
    const t = speakable(text, this.o.maxChars)
    if (!t) throw new TtsUnavailable('nothing to say')
    const key = createHash('sha256').update(`${this.o.voice}\0${t}`).digest('hex')
    const hit = this.cache.get(key)
    if (hit) return hit
    const dir = await mkdtemp(join(tmpdir(), 'claudevr-tts-'))
    try {
      const aiff = join(dir, 'speech.aiff')
      const webm = join(dir, 'speech.webm')
      // No message argument and -f -: say reads the text from stdin.
      const said = await runProgram(this.o.say, ['-v', this.o.voice, '-o', aiff, '-f', '-'], { input: t, timeoutMs: 20_000 })
      if (said.code !== 0) throw new Error(`say exited with ${said.code}: ${said.stderr.trim().slice(0, 200)}`)
      const enc = await runProgram(this.o.ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', aiff, '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '40k', '-f', 'webm', webm], { timeoutMs: 20_000 })
      if (enc.code !== 0) throw new Error(`ffmpeg exited with ${enc.code}: ${enc.stderr.trim().slice(0, 200)}`)
      const speech = { audio: await readFile(webm), mime: 'audio/webm;codecs=opus' }
      this.cache.set(key, speech)
      // Short phrases repeat ("Sent to Tally."); everything else need not stay.
      if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value!)
      return speech
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}

// ---------------------------------------------------------------- fish.audio
// A hosted voice: the text leaves this machine for api.fish.audio. Voices are
// named in the config and one is current; "voice X" by speech changes it.

export interface FishVoice {
  /** What it is called here and by voice: "atlas". */
  name: string
  /** fish.audio's id for the voice model (its reference_id). */
  id: string
  /** What speech-to-text is known to hear instead of the name. */
  heardAs: string[]
}

export interface FishOptions {
  /** Null when no key was found; `keyHint` says where one was looked for. */
  apiKey: string | null
  keyHint: string
  /** The speech model, sent as the `model` header: "s2.1-pro". */
  model: string
  voices: FishVoice[]
  /** The name of the voice to start with. */
  voice: string
  maxChars: number
  endpoint?: string
  /** Speaks when fish.audio cannot, so a dead network does not mean silence. */
  fallback?: TtsProvider
  /** Called when the voice changes, so the choice outlives a restart. */
  remember?: (name: string) => void
  fetch?: typeof fetch
  timeoutMs?: number
  log?: (...a: unknown[]) => void
}

export class FishTts implements TtsProvider {
  readonly name = 'fish'
  private readonly o: FishOptions
  private readonly log: (...a: unknown[]) => void
  private current: FishVoice
  /** Why the last request fell back, until one succeeds. */
  private failed: string | null = null
  private readonly cache = new Map<string, Speech>()

  constructor(o: FishOptions) {
    if (!o.voices.length) throw new Error('tts.fish.voices names no voice')
    const start = o.voices.find(v => v.name === o.voice)
    if (!start) throw new Error(`tts.voice is ${JSON.stringify(o.voice)}, which is not one of tts.fish.voices (${o.voices.map(v => v.name).join(', ')})`)
    this.o = o
    this.log = o.log ?? ((...a) => console.log('[tts]', ...a))
    this.current = start
  }

  voices(): FishVoice[] {
    return this.o.voices
  }

  voice(): string {
    return this.current.name
  }

  /** Changes the current voice. Throws for a name the config does not have. */
  select(name: string): void {
    const v = this.o.voices.find(x => x.name === name)
    if (!v) throw new Error(`no voice called ${name}`)
    this.current = v
    this.log(`voice: ${v.name}`)
    this.o.remember?.(v.name)
  }

  status(): TtsStatus {
    const label = `fish.audio (${this.current.name}, ${this.o.model})`
    if (!this.o.apiKey) {
      const why = `no fish.audio API key (${this.o.keyHint})`
      return this.o.fallback ? { provider: `${this.o.fallback.status().provider}; ${why}`, ok: this.o.fallback.status().ok, error: this.o.fallback.status().error } : { provider: label, ok: false, error: why }
    }
    if (this.failed && this.o.fallback) return { provider: `${this.o.fallback.status().provider}; fish.audio failed: ${this.failed}`, ok: this.o.fallback.status().ok, error: this.o.fallback.status().error }
    return { provider: label, ok: !this.failed, error: this.failed }
  }

  async speak(text: string): Promise<Speech> {
    const t = speakable(text, this.o.maxChars)
    if (!t) throw new TtsUnavailable('nothing to say')
    const v = this.current
    const key = createHash('sha256').update(`${this.o.model}\0${v.id}\0${t}`).digest('hex')
    const hit = this.cache.get(key)
    if (hit) return hit
    try {
      const speech = await this.request(t, v)
      this.failed = null
      this.cache.set(key, speech)
      // Each phrase costs money to make; the short ones repeat.
      if (this.cache.size > 80) this.cache.delete(this.cache.keys().next().value!)
      return speech
    } catch (err) {
      this.failed = (err as Error).message
      this.log(`fish.audio failed (${v.name}): ${this.failed}${this.o.fallback ? `; speaking with ${this.o.fallback.name} instead` : ''}`)
      if (this.o.fallback) return this.o.fallback.speak(text)
      throw err instanceof TtsUnavailable ? err : new Error(`fish.audio: ${this.failed}`)
    }
  }

  private async request(text: string, v: FishVoice): Promise<Speech> {
    if (!this.o.apiKey) throw new TtsUnavailable(`no fish.audio API key (${this.o.keyHint})`)
    const t0 = Date.now()
    const r = await (this.o.fetch ?? fetch)(`${this.o.endpoint ?? 'https://api.fish.audio'}/v1/tts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.o.apiKey}`, model: this.o.model, 'content-type': 'application/json' },
      // MP3, because the Quest browser plays it and fish.audio returns it fastest.
      body: JSON.stringify({ text, reference_id: v.id, format: 'mp3', mp3_bitrate: 128, latency: 'balanced' }),
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 20_000),
    })
    if (!r.ok) {
      const body = await r.text().catch((err: unknown) => `unreadable reply: ${String(err)}`)
      const why = r.status === 401 ? 'the API key was refused' : r.status === 402 ? 'the account is out of credit' : body.slice(0, 200)
      throw new Error(`HTTP ${r.status}: ${why}`)
    }
    const audio = Buffer.from(await r.arrayBuffer())
    if (audio.length < 200) throw new Error(`HTTP ${r.status} with ${audio.length} bytes of audio`)
    this.log(`fish.audio: ${v.name}, ${text.length} chars, ${audio.length} bytes in ${Date.now() - t0} ms`)
    return { audio, mime: 'audio/mpeg' }
  }
}
