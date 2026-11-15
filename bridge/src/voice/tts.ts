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
