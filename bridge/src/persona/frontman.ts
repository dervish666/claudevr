// The front man: the model that writes character mode's spoken lines and
// classifies speech the grammar could not parse. It only ever sees what the
// bridge puts in a prompt and only ever returns text; it has no tools, and
// nothing it says is sent to a session.
//
// FrontMan is the seam: CliFrontMan runs a long-lived `claude -p` on the
// owner's subscription; an API client can replace it later. StubFrontMan is
// for tests and for machines without the CLI.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import type { FrontManStatus } from '../../../shared/protocol.ts'

export interface FrontMan {
  readonly name: string
  status(): FrontManStatus
  /**
   * Sets the system prompt. A CLI provider restarts its child with it; null
   * stops the child, so operator mode runs nothing and spends nothing.
   */
  configure(systemPrompt: string | null): void
  /** One turn: the prompt in, the model's text out. Rejects on timeout, a dead model or an error result. */
  complete(prompt: string, timeoutMs: number): Promise<string>
  onStatus(l: (s: FrontManStatus) => void): () => void
  close(): void
}

export class FrontManUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrontManUnavailable'
  }
}

export class FrontManTimeout extends Error {
  constructor(ms: number) {
    super(`no line within ${ms} ms`)
    this.name = 'FrontManTimeout'
  }
}

// ---------------------------------------------------------------- the CLI

export interface CliOptions {
  /** The `claude` binary. */
  bin: string
  model: string
  /** An empty directory the child runs in, so no project settings or CLAUDE.md are found. */
  cwd: string
  /** Restart the child after this many turns, so its context stays small. */
  maxTurns?: number
  /** ... or once a turn's input (fresh plus cached) passes this many tokens. */
  maxContextTokens?: number
  /** A turn still unanswered after this long means the child is stuck: it is killed and restarted. */
  stuckMs?: number
  /** A replaced child gets this long after SIGTERM before SIGKILL; the next child waits for it to go. */
  retireGraceMs?: number
  /** Turns that may wait for the model; past this a turn is refused at once instead of queueing. */
  maxQueue?: number
  log?: (...a: unknown[]) => void
  /** For tests: what to run instead of the real CLI. */
  spawnChild?: (args: string[], env: NodeJS.ProcessEnv, cwd: string) => ChildProcessWithoutNullStreams
  env?: NodeJS.ProcessEnv
}

interface Turn {
  prompt: string
  deadline: number
  ok: (s: string) => void
  fail: (e: Error) => void
  settled: boolean
  /** Text deltas so far. */
  text: string
  sentAt: number
}

/** The flags, each one load-bearing: no tools, no MCP, no user settings (so no global hooks or CLAUDE.md), no session files. */
export function cliArgs(model: string, systemPrompt: string): string[] {
  return ['-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--model', model, '--system-prompt', systemPrompt, '--tools', '', '--strict-mcp-config', '--setting-sources', 'project,local', '--no-session-persistence']
}

/** Variables that would point the child at an API key or another endpoint instead of the subscription the CLI is logged in to. */
const API_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']

/**
 * The bridge's environment minus anything that would make the child think it
 * runs inside another Claude Code session, and minus any API credentials, so
 * its turns bill the subscription and never an API key.
 */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env }
  for (const k of Object.keys(out)) if (/^CLAUDE(CODE|_CODE|_AGENT)/.test(k) || API_ENV.includes(k)) delete out[k]
  return out
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000]

/**
 * A supervised `claude -p` child in stream-json mode, one turn at a time.
 * Started lazily on the first turn after configure(). When it dies it is
 * restarted with backoff (1 s, 2 s, 5 s ... 60 s), reset once it has answered
 * a turn, so a CLI that cannot start never spins. Turns queue; one whose
 * caller has already timed out is dropped before it reaches the model.
 */
export class CliFrontMan implements FrontMan {
  readonly name: string
  private readonly o: Required<Omit<CliOptions, 'spawnChild' | 'env'>> & Pick<CliOptions, 'spawnChild' | 'env'>
  private prompt: string | null = null
  private child: ChildProcessWithoutNullStreams | null = null
  private st: FrontManStatus
  private readonly listeners = new Set<(s: FrontManStatus) => void>()
  private queue: Turn[] = []
  private current: Turn | null = null
  private turns = 0
  private failures = 0
  private retryAt = 0
  private retryTimer: NodeJS.Timeout | null = null
  private stuckTimer: NodeJS.Timeout | null = null
  private buf = ''
  private inited = false
  private closed = false
  /** Bumped per child, so events from a child already replaced are ignored. */
  private gen = 0
  /**
   * Children told to stop that have not exited yet, with their kill timer.
   * A new child is not started while any is here, so at most one CLI runs
   * at a time however often the persona changes.
   */
  private readonly retiring = new Map<ChildProcessWithoutNullStreams, NodeJS.Timeout>()

  constructor(o: CliOptions) {
    this.o = { maxTurns: 16, maxContextTokens: 14_000, stuckMs: 30_000, retireGraceMs: 2_000, maxQueue: 8, log: (...a) => console.log('[frontman]', ...a), ...o }
    this.name = `claude cli (${o.model})`
    this.st = { provider: this.name, state: 'off', error: null }
  }

  status(): FrontManStatus {
    return this.st
  }

  onStatus(l: (s: FrontManStatus) => void): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  private set(state: FrontManStatus['state'], error: string | null): void {
    if (this.st.state === state && this.st.error === error) return
    this.st = { provider: this.name, state, error }
    for (const l of this.listeners) l(this.st)
  }

  configure(systemPrompt: string | null): void {
    if (systemPrompt === this.prompt) return
    this.prompt = systemPrompt
    this.stopChild('the persona changed')
    this.failures = 0
    this.retryAt = 0
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    for (const t of this.queue.splice(0)) this.settle(t, new FrontManUnavailable('the persona changed'))
    if (systemPrompt === null) this.set('off', null)
    // Start now rather than on the first turn: the first line is then warm.
    else this.start()
  }

  complete(prompt: string, timeoutMs: number): Promise<string> {
    return new Promise((ok, fail) => {
      if (this.closed || this.prompt === null) return fail(new FrontManUnavailable(this.closed ? 'closed' : 'no persona configured'))
      if (!this.child && Date.now() < this.retryAt) return fail(new FrontManUnavailable(this.st.error ?? 'restarting'))
      // Every turn waits its whole timeout at worst, so a flood would hold a long queue; it gets the plain line instead.
      if (this.queue.length >= this.o.maxQueue) return fail(new FrontManUnavailable(`busy: ${this.queue.length} turns already waiting for the model`))
      const t: Turn = { prompt, deadline: Date.now() + timeoutMs, ok, fail, settled: false, text: '', sentAt: 0 }
      const timer = setTimeout(() => this.settle(t, new FrontManTimeout(timeoutMs)), timeoutMs)
      const done = (fn: () => void) => () => {
        clearTimeout(timer)
        fn()
      }
      t.ok = s => done(() => ok(s))()
      t.fail = e => done(() => fail(e))()
      this.queue.push(t)
      if (!this.child) this.start()
      this.pump()
    })
  }

  private settle(t: Turn, r: string | Error): void {
    if (t.settled) return
    t.settled = true
    if (typeof r === 'string') t.ok(r)
    else t.fail(r)
  }

  private start(): void {
    if (this.child || this.closed || this.prompt === null) return
    if (Date.now() < this.retryAt) return
    // The old child is still going; the last one of those to exit starts this one.
    if (this.retiring.size) return
    const gen = ++this.gen
    const args = cliArgs(this.o.model, this.prompt)
    const env = childEnv(this.o.env ?? process.env)
    let child: ChildProcessWithoutNullStreams
    try {
      mkdirSync(this.o.cwd, { recursive: true })
      child = this.o.spawnChild ? this.o.spawnChild(args, env, this.o.cwd) : spawn(this.o.bin, args, { cwd: this.o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      this.died(gen, `could not start ${this.o.bin}: ${(err as Error).message}`)
      return
    }
    this.child = child
    this.buf = ''
    this.turns = 0
    this.inited = false
    this.set('starting', null)
    this.o.log(`starting ${this.name} in ${this.o.cwd}`)
    child.on('error', err => {
      const e = err as NodeJS.ErrnoException
      this.died(gen, e.code === 'ENOENT' ? `no ${this.o.bin} on the PATH (set frontMan.bin)` : e.message)
    })
    child.on('exit', (code, sig) => this.died(gen, `the CLI exited (${sig ?? `code ${code}`})`))
    child.stdin.on('error', err => this.o.log(`stdin: ${err.message}`))
    let errTail = ''
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString('utf8')
      errTail = (errTail + s).slice(-400)
      for (const line of s.split('\n')) if (line.trim()) this.o.log(`stderr: ${line.trim().slice(0, 300)}`)
    })
    child.stdout.on('data', (d: Buffer) => {
      if (gen !== this.gen) return
      this.buf += d.toString('utf8')
      let n: number
      while ((n = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, n)
        this.buf = this.buf.slice(n + 1)
        if (line.trim()) this.onLine(line)
      }
    })
    this.pump()
  }

  private onLine(line: string): void {
    let m: Record<string, any>
    try {
      m = JSON.parse(line) as Record<string, any>
    } catch (err) {
      this.o.log(`unreadable line from the CLI (${(err as Error).message}): ${line.slice(0, 160)}`)
      return
    }
    if (m.type === 'system' && m.subtype === 'init') {
      // The CLI sends init with every turn; only the first one per child says anything new.
      if (this.inited) return
      this.inited = true
      if (this.st.state !== 'ready') this.set('ready', null)
      this.o.log(`ready: model ${m.model}, ${m.tools?.length ?? '?'} tools, ${m.mcp_servers?.length ?? '?'} MCP servers, key source ${m.apiKeySource ?? '?'}`)
      return
    }
    const t = this.current
    if (!t) return
    if (m.type === 'stream_event' && m.event?.type === 'content_block_delta' && m.event.delta?.type === 'text_delta') {
      t.text += String(m.event.delta.text ?? '')
      return
    }
    // Only the result settles a turn. The text is complete at message_stop,
    // but the result that follows can still say the turn failed (is_error),
    // and a failed turn's text must not be spoken as if it were a line.
    if (m.type === 'result') {
      if (this.stuckTimer) clearTimeout(this.stuckTimer)
      this.stuckTimer = null
      this.current = null
      this.turns++
      const u = (m.usage ?? {}) as Record<string, number>
      const context = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      if (m.is_error) {
        const why = String(m.result ?? m.subtype ?? 'error result').slice(0, 200)
        this.o.log(`turn failed: ${why}`)
        this.set('ready', `last turn failed: ${why}`)
        this.settle(t, new FrontManUnavailable(why))
      } else {
        this.failures = 0
        this.set('ready', null)
        this.settle(t, typeof m.result === 'string' && m.result.trim() ? m.result : t.text)
      }
      // Bounded: a fresh child before the context grows, started now so the next turn is warm.
      if (this.turns >= this.o.maxTurns || context >= this.o.maxContextTokens) {
        this.o.log(`restarting after ${this.turns} turns (${context} tokens of context)`)
        this.stopChild('bounded')
        this.start()
      }
      this.pump()
    }
  }

  private pump(): void {
    const c = this.child
    if (!c || this.current) return
    while (this.queue.length) {
      const t = this.queue.shift()!
      if (t.settled || Date.now() >= t.deadline) {
        this.settle(t, new FrontManTimeout(0))
        continue
      }
      this.current = t
      t.sentAt = Date.now()
      c.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: t.prompt } }) + '\n')
      const gen = this.gen
      this.stuckTimer = setTimeout(() => {
        if (gen !== this.gen) return
        this.o.log(`no result after ${this.o.stuckMs} ms; killing the CLI`)
        this.child?.kill('SIGKILL')
      }, this.o.stuckMs)
      return
    }
  }

  private died(gen: number, why: string): void {
    if (gen !== this.gen) return
    this.gen++
    const t = this.current
    this.current = null
    if (this.stuckTimer) clearTimeout(this.stuckTimer)
    this.stuckTimer = null
    this.child = null
    if (t) this.settle(t, new FrontManUnavailable(why))
    if (this.closed || this.prompt === null) return
    const wait = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)]!
    this.failures++
    this.retryAt = Date.now() + wait
    this.o.log(`${why}; restarting in ${wait / 1000} s`)
    this.set('unavailable', `${why}; restarting in ${wait / 1000} s`)
    for (const q of this.queue.splice(0)) this.settle(q, new FrontManUnavailable(why))
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.start()
    }, wait)
  }

  private stopChild(why: string): void {
    const c = this.child
    if (!c) return
    this.gen++
    this.child = null
    if (this.stuckTimer) clearTimeout(this.stuckTimer)
    this.stuckTimer = null
    if (this.current) this.settle(this.current, new FrontManUnavailable(why))
    this.current = null
    this.retire(c, why)
  }

  /**
   * Asks a replaced child to stop and keeps track of it until it has: SIGTERM
   * (and its stdin closed) first, SIGKILL after the grace period, and if even
   * that leaves it standing, the bridge stops waiting so the front man is not
   * held down by one wedged process.
   */
  private retire(c: ChildProcessWithoutNullStreams, why: string): void {
    // Already gone, or never started (a failed spawn has no pid and no exit to wait for).
    if (c.exitCode !== null || c.signalCode !== null || c.pid === undefined) return
    const grace = this.o.retireGraceMs
    const gone = () => {
      const timer = this.retiring.get(c)
      if (timer) clearTimeout(timer)
      if (!this.retiring.delete(c)) return
      if (!this.retiring.size) this.start()
    }
    c.once('exit', gone)
    const kill = setTimeout(() => {
      this.o.log(`the replaced CLI (pid ${c.pid}) did not exit ${grace} ms after SIGTERM; sending SIGKILL`)
      c.kill('SIGKILL')
      const giveUp = setTimeout(() => {
        this.o.log(`the replaced CLI (pid ${c.pid}) is still there after SIGKILL; carrying on without waiting for it`)
        gone()
      }, grace)
      giveUp.unref()
      this.retiring.set(c, giveUp)
    }, grace)
    // A retiring child never keeps the bridge (or a test) from exiting.
    kill.unref()
    this.retiring.set(c, kill)
    this.o.log(`stopping the CLI (pid ${c.pid}): ${why}`)
    c.stdin.end()
    c.kill('SIGTERM')
  }

  close(): void {
    this.closed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.stopChild('closed')
    for (const t of this.queue.splice(0)) this.settle(t, new FrontManUnavailable('closed'))
    this.set('off', null)
  }
}

// ---------------------------------------------------------------- off and stub

/** No front man: every line is the plain one. */
export class NoFrontMan implements FrontMan {
  readonly name = 'off'
  private readonly why: string
  constructor(why = 'the front man is off in the bridge config (frontMan.provider)') {
    this.why = why
  }
  status(): FrontManStatus {
    return { provider: 'off', state: 'unavailable', error: this.why }
  }
  configure(): void {}
  complete(): Promise<string> {
    return Promise.reject(new FrontManUnavailable(this.why))
  }
  onStatus(): () => void {
    return () => {}
  }
  close(): void {}
}

/** For tests: answers with `reply(prompt)` after `delayMs`, and records every prompt. */
export class StubFrontMan implements FrontMan {
  readonly name = 'stub'
  prompts: string[] = []
  system: string | null = null
  delayMs = 0
  dead: string | null = null
  reply: (prompt: string) => string = () => 'A line.'
  status(): FrontManStatus {
    return { provider: 'stub', state: this.dead ? 'unavailable' : this.system === null ? 'off' : 'ready', error: this.dead }
  }
  configure(p: string | null): void {
    this.system = p
  }
  complete(prompt: string, timeoutMs: number): Promise<string> {
    this.prompts.push(prompt)
    if (this.dead) return Promise.reject(new FrontManUnavailable(this.dead))
    return new Promise((ok, fail) => {
      const tooSlow = this.delayMs >= timeoutMs
      setTimeout(() => (tooSlow ? fail(new FrontManTimeout(timeoutMs)) : ok(this.reply(prompt))), tooSlow ? timeoutMs : this.delayMs)
    })
  }
  onStatus(): () => void {
    return () => {}
  }
  close(): void {}
}
