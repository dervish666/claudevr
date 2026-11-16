// Speech-to-text on the bridge, behind SttProvider. The HUD has a provider
// interface of its own (client/src/hud/voice/stt.ts) that uploads clips here;
// an in-browser provider would implement that one instead and post its text
// to /api/interpret, so nothing on this side would change.
//
// HelperStt keeps one Python process running with the model loaded, because a
// cold load per utterance (several seconds) would make voice unusable. The
// bridge starts it, restarts it with a backoff when it dies, and reports its
// state, so the HUD can say "transcription unavailable: <why>" instead of
// showing an empty transcript.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import type { SttStatus } from '../../../shared/protocol.ts'

export interface SttProvider {
  readonly name: string
  status(): SttStatus
  /** Called whenever status() changes. Returns an unsubscribe. */
  onStatus(listener: (s: SttStatus) => void): () => void
  /** 16 kHz mono s16le PCM in, text out. Rejects with SttUnavailable when it cannot run at all. */
  transcribe(pcm: Buffer): Promise<{ text: string; ms: number }>
  close(): void
}

export class SttUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SttUnavailable'
  }
}

export class SttBusy extends Error {
  constructor() {
    super('still transcribing the last clips; try again in a moment')
    this.name = 'SttBusy'
  }
}

/** Speech-to-text switched off in the config. */
export class NoStt implements SttProvider {
  readonly name = 'off'
  private readonly why: string
  constructor(why = 'speech-to-text is off in the bridge config (stt.provider)') {
    this.why = why
  }
  status(): SttStatus {
    return { provider: 'off', state: 'off', error: this.why, model: null, loadMs: null }
  }
  onStatus(): () => void {
    return () => {}
  }
  transcribe(): Promise<{ text: string; ms: number }> {
    return Promise.reject(new SttUnavailable(this.why))
  }
  close(): void {}
}

export interface HelperOptions {
  /** "parakeet" or "whisper": the helper's --engine, and the provider's name. */
  engine: string
  python: string
  script: string
  model: string
  cacheDir: string | null
  /** Per-request limit; past it the helper is assumed stuck and restarted. */
  timeoutMs?: number
  /** How many clips may wait behind the one being transcribed. */
  maxQueue?: number
  /** Longest wait for the model to load; past it the helper is assumed stuck and restarted. */
  loadTimeoutMs?: number
  log?: (...a: unknown[]) => void
  /** For tests: what to run instead of python. */
  spawnHelper?: (python: string, args: string[]) => ChildProcess
}

interface Job {
  id: number
  pcm: Buffer
  ok: (r: { text: string; ms: number }) => void
  fail: (e: Error) => void
  timer: NodeJS.Timeout | null
}

const BACKOFF_MS = [1000, 2000, 5000, 15_000, 60_000]

export class HelperStt implements SttProvider {
  readonly name: string
  private readonly o: Required<Omit<HelperOptions, 'spawnHelper' | 'cacheDir'>> & Pick<HelperOptions, 'spawnHelper' | 'cacheDir'>
  private st: SttStatus
  private readonly listeners = new Set<(s: SttStatus) => void>()
  private child: ChildProcess | null = null
  private queue: Job[] = []
  private current: Job | null = null
  private nextId = 1
  private failures = 0
  private restartTimer: NodeJS.Timeout | null = null
  private loadTimer: NodeJS.Timeout | null = null
  private closed = false
  private stderrTail: string[] = []
  private loadError: string | null = null

  constructor(o: HelperOptions) {
    this.o = { timeoutMs: 20_000, maxQueue: 2, loadTimeoutMs: 180_000, log: (...a) => console.log('[stt]', ...a), ...o }
    this.name = o.engine
    this.st = { provider: o.engine, state: 'loading', error: null, model: o.model, loadMs: null }
    this.start()
  }

  status(): SttStatus {
    return this.st
  }

  onStatus(listener: (s: SttStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(s: Partial<SttStatus>): void {
    this.st = { ...this.st, ...s }
    for (const l of this.listeners) l(this.st)
  }

  private start(): void {
    if (this.closed) return
    if (!this.o.spawnHelper && !existsSync(this.o.python)) {
      // Nothing to supervise: say exactly what is missing and how to fix it.
      this.set({ state: 'unavailable', error: `no Python at ${this.o.python}; run npm run stt:setup on the bridge machine, then restart the bridge` })
      this.o.log(this.st.error)
      return
    }
    // HF_HUB_OFFLINE: the weights come from npm run stt:setup, so the bridge
    // makes no network calls at run time; a missing model says so in its error.
    const args = [this.o.script, '--engine', this.o.engine, '--model', this.o.model, ...(this.o.cacheDir ? ['--cache-dir', this.o.cacheDir] : [])]
    this.set({ state: 'loading', error: null, loadMs: null })
    this.o.log(`starting ${this.o.engine} helper (${this.o.model})`)
    const child = this.o.spawnHelper ? this.o.spawnHelper(this.o.python, args) : spawn(this.o.python, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1', HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE ?? '1' } })
    this.child = child
    this.stderrTail = []
    const started = Date.now()
    // A helper that never says ready (a hung import, a download that stalls)
    // would leave the state at loading for good, with nothing restarting it.
    // Past the deadline it is killed, and the exit takes the usual backoff.
    this.clearLoadTimer()
    this.loadTimer = setTimeout(() => {
      this.loadTimer = null
      if (this.child !== child) return
      this.loadError = `the ${this.o.engine} model did not load in ${Math.round(this.o.loadTimeoutMs / 1000)} s`
      this.o.log(`${this.loadError}; killing the helper`)
      this.set({ state: 'unavailable', error: this.loadError })
      child.kill('SIGKILL')
    }, this.o.loadTimeoutMs)

    createInterface({ input: child.stdout! }).on('line', line => this.onLine(line, started))
    createInterface({ input: child.stderr! }).on('line', line => {
      this.stderrTail = [...this.stderrTail, line].slice(-5)
      this.o.log(`helper: ${line.slice(0, 300)}`)
    })
    child.stdin!.on('error', err => this.o.log('helper stdin:', err.message))
    child.on('error', err => {
      this.o.log('helper failed to start:', err.message)
      this.onExit(child, `could not start ${this.o.python}: ${err.message}`)
    })
    child.on('exit', (code, signal) => this.onExit(child, `helper exited (${signal ?? `code ${code}`})${this.stderrTail.length ? `: ${this.stderrTail.at(-1)!.slice(0, 200)}` : ''}`))
  }

  private onLine(line: string, started: number): void {
    let m: { ready?: boolean; error?: string; id?: number; text?: string; ms?: number; loadMs?: number }
    try {
      m = JSON.parse(line)
    } catch (err) {
      this.o.log(`helper wrote a line that is not JSON (${(err as Error).message}): ${line.slice(0, 200)}`)
      return
    }
    if (m.ready === true) {
      this.clearLoadTimer()
      this.failures = 0
      this.set({ state: 'ready', error: null, loadMs: m.loadMs ?? Date.now() - started })
      this.o.log(`${this.o.engine} ready in ${this.st.loadMs} ms`)
      this.pump()
      return
    }
    if (m.ready === false) {
      this.clearLoadTimer()
      this.loadError = `the ${this.o.engine} model failed to load: ${m.error ?? 'no reason given'}`
      this.set({ state: 'unavailable', error: this.loadError })
      return
    }
    const job = this.current
    if (!job || m.id !== job.id) {
      this.o.log(`helper answered request ${m.id}, which is not the one in flight`)
      return
    }
    this.current = null
    if (job.timer) clearTimeout(job.timer)
    if (typeof m.text === 'string') job.ok({ text: m.text, ms: m.ms ?? 0 })
    else job.fail(new Error(`the ${this.o.engine} helper failed on this clip: ${m.error ?? 'no reason given'}`))
    this.pump()
  }

  private onExit(child: ChildProcess, why: string): void {
    if (this.child !== child) return
    this.child = null
    this.clearLoadTimer()
    const err = new SttUnavailable(`${this.o.engine} ${why}`)
    if (this.current) {
      if (this.current.timer) clearTimeout(this.current.timer)
      this.current.fail(err)
      this.current = null
    }
    for (const j of this.queue.splice(0)) j.fail(err)
    if (this.closed) return
    // A load failure keeps its own message; anything else becomes the reason.
    const why2 = this.loadError ?? err.message
    this.loadError = null
    const wait = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)]!
    this.failures++
    this.set({ state: 'unavailable', error: `${why2}; restarting in ${Math.round(wait / 1000)} s` })
    this.o.log(this.st.error)
    this.restartTimer = setTimeout(() => this.start(), wait)
  }

  transcribe(pcm: Buffer): Promise<{ text: string; ms: number }> {
    if (this.st.state !== 'ready' || !this.child) return Promise.reject(new SttUnavailable(this.st.state === 'loading' ? `the ${this.o.engine} model is still loading` : (this.st.error ?? `${this.o.engine} is not running`)))
    if (this.queue.length >= this.o.maxQueue) return Promise.reject(new SttBusy())
    return new Promise((ok, fail) => {
      this.queue.push({ id: this.nextId++, pcm, ok, fail, timer: null })
      this.pump()
    })
  }

  private pump(): void {
    if (this.current || !this.child || this.st.state !== 'ready') return
    const job = this.queue.shift()
    if (!job) return
    this.current = job
    const child = this.child
    job.timer = setTimeout(() => {
      this.o.log(`helper took over ${this.o.timeoutMs / 1000} s on one clip; restarting it`)
      child.kill('SIGKILL')
    }, this.o.timeoutMs)
    child.stdin!.write(JSON.stringify({ id: job.id, pcm: job.pcm.toString('base64') }) + '\n')
  }

  private clearLoadTimer(): void {
    if (this.loadTimer) clearTimeout(this.loadTimer)
    this.loadTimer = null
  }

  close(): void {
    this.closed = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.clearLoadTimer()
    const c = this.child
    this.child = null
    if (c) {
      c.stdin?.end()
      c.kill('SIGTERM')
    }
    for (const j of [...(this.current ? [this.current] : []), ...this.queue.splice(0)]) {
      if (j.timer) clearTimeout(j.timer)
      j.fail(new SttUnavailable('the bridge is stopping'))
    }
    this.current = null
  }
}
