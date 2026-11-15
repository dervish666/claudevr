// A SessionBackend on fixtures, for tests and for demo mode
// (CLAUDEVR_BACKEND=fake). Nothing leaves the process: a send is kept in
// `sent` and shows up in the session's messages.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Fleet, Need, SessionTranscript } from '../../../shared/protocol.ts'
import { capabilities, Poller, SendRefused, UnsupportedError, type FleetUpdate, type SendResult, type SessionBackend } from './types.ts'

export interface FakeSent {
  id: string
  text: string
  at: number
}

export class FakeAdapter implements SessionBackend {
  readonly name = 'fake'
  readonly capabilities = capabilities(['list', 'subscribe', 'send', 'pending', 'transcript'])
  readonly sent: FakeSent[] = []
  private fleet: Fleet
  private down: string | null = null
  private readonly poller: Poller
  private readonly now: () => number

  private live: NodeJS.Timeout | null = null
  private liveStep = 0

  constructor(fleet: Fleet, opts: { pollMs?: number; now?: () => number; log?: (...a: unknown[]) => void; file?: string } = {}) {
    this.fleet = structuredClone(fleet)
    this.now = opts.now ?? Date.now
    this.poller = new Poller(() => this.list(), opts.pollMs ?? 2000, opts.log ?? ((...a) => console.log('[fake]', ...a)))
  }

  /**
   * A demo fleet from fixtures/ (`demo-fleet.json` unless `opts.file` names
   * another), with its times moved to just now so ages read sensibly.
   */
  static fromFixtures(dir: string, opts: ConstructorParameters<typeof FakeAdapter>[1] = {}): FakeAdapter {
    const fleet = JSON.parse(readFileSync(join(dir, opts.file ?? 'demo-fleet.json'), 'utf8')) as Fleet
    const shift = (opts.now ?? Date.now)() - fleet.at
    const move = (t: number | null) => (t === null ? null : t + shift)
    fleet.at += shift
    for (const s of fleet.sessions) {
      s.activeAt = move(s.activeAt)
      s.startedAt = move(s.startedAt)
      for (const m of s.messages) m.at = move(m.at)
      if (s.context) s.context.at = move(s.context.at)
    }
    for (const n of fleet.needs) n.since = move(n.since)
    if (fleet.ledger) fleet.ledger.changedAt = move(fleet.ledger.changedAt)
    const u = fleet.usage
    u.todayUsd.at = move(u.todayUsd.at)
    u.limits.at = move(u.limits.at)
    for (const w of u.limits.value ?? []) w.resetsAt = move(w.resetsAt)
    return new FakeAdapter(fleet, opts)
  }

  /** Make every read fail until `null` is passed, to show the HUD's outage state. */
  setDown(reason: string | null): void {
    this.down = reason
  }

  async list(): Promise<Fleet> {
    if (this.down) throw new Error(this.down)
    const f = structuredClone(this.fleet)
    f.at = this.now()
    for (const s of f.sessions) if (s.state === 'working' || s.state === 'thinking') s.activeAt = f.at
    // The demo's spend is live; its limits were read a moment ago.
    if (f.usage.todayUsd.value !== null) f.usage.todayUsd.at = f.at
    return f
  }

  subscribe(listener: (u: FleetUpdate) => void): () => void {
    return this.poller.subscribe(listener)
  }

  async send(id: string, text: string): Promise<SendResult> {
    if (this.down) throw new Error(this.down)
    if (typeof text !== 'string' || !text.trim()) throw new SendRefused('nothing to send', 400)
    const s = this.fleet.sessions.find(x => x.id === id)
    if (!s) throw new SendRefused(`no session ${id.slice(0, 40)}`)
    if (!s.canSend) throw new SendRefused(`session ${s.callsign} cannot be sent to`)
    const at = this.now()
    this.sent.push({ id, text, at })
    s.messages = [...s.messages, { at, text: `(sent from ClaudeVR) ${text}` }].slice(-6)
    return { ok: true, said: `queued for ${s.callsign} (fake backend, nothing left this process)` }
  }

  async transcript(id: string, limit: number): Promise<SessionTranscript> {
    if (this.down) throw new Error(this.down)
    const s = this.fleet.sessions.find(x => x.id === id)
    if (!s) throw new SendRefused(`no session ${id.slice(0, 40)}`)
    const sentMark = '(sent from ClaudeVR) '
    const turns = s.messages.map(m => (m.text.startsWith(sentMark) ? { role: 'you' as const, text: m.text.slice(sentMark.length), clipped: false } : { role: 'session' as const, text: m.text, clipped: false }))
    return { sessionId: id, at: this.now(), turns: turns.slice(-Math.max(1, limit)) }
  }

  async pending(): Promise<Need[]> {
    return (await this.list()).needs
  }

  interrupt(): Promise<void> {
    return Promise.reject(new UnsupportedError(this.name, 'interrupt'))
  }
  respond(): Promise<void> {
    return Promise.reject(new UnsupportedError(this.name, 'respond'))
  }
  approve(): Promise<void> {
    return Promise.reject(new UnsupportedError(this.name, 'approve'))
  }

  /**
   * Demo motion: every `everyMs` one session that is not the dispatcher
   * says something new, and every third step one stops working or starts
   * again, so the instrument's reply cards have something to show. Off
   * unless asked for (CLAUDEVR_FAKE_LIVE_MS).
   */
  startLive(everyMs: number): void {
    if (this.live) return
    this.live = setInterval(() => this.step(), everyMs)
    this.live.unref()
  }

  /** One step of the demo motion; public so a test can drive it without a timer. */
  step(): void {
    const agents = this.fleet.sessions.filter(s => s.kind !== 'dispatcher')
    if (!agents.length) return
    const n = this.liveStep++
    const s = agents[n % agents.length]!
    const at = this.now()
    if (n % 3 === 2 && (s.state === 'working' || s.state === 'thinking')) {
      s.state = 'idle'
      s.action = null
    } else if (n % 3 === 2 && s.state === 'idle') {
      s.state = 'working'
      s.action = 'Bash: Run the tests again'
    }
    // Offset by the lap, so a session does not get the same line on each pass.
    const line = LIVE_LINES[(n + Math.floor(n / agents.length)) % LIVE_LINES.length]!
    s.messages = [...s.messages, { at, text: line }].slice(-6)
    s.lastLine = line.split('\n')[0]!
    s.activeAt = at
  }

  close(): void {
    this.poller.stop()
    if (this.live) clearInterval(this.live)
    this.live = null
  }
}

const LIVE_LINES = [
  'Tests pass: 214 of 214.\nPushed the branch; the PR is up for review.',
  'Found the cause: the cache key ignored the locale.\nFixing it now, then a regression test.',
  'Two flaky tests in the suite, both timing out on CI only.\nI marked them and opened an issue.',
  'Done. The export now streams instead of building the file in memory.\nPeak memory went from 1.4 GB to 90 MB.',
  'I need the staging credentials to go further.\nThey are not in the vault.',
]
