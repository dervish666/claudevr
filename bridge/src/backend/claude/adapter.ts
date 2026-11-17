// A SessionBackend over the claudevr mod: every Claude Code session running
// the mod reports itself to the bridge's mod listener (mod-listener.ts) and
// collects messages from it (docs/mod-protocol.md). No T3, no dashweb.
//
// The fleet is whatever reported in the last 30 s. A changed report reaches
// the HUD at once; a tick every couple of seconds keeps the HUD's link alive
// and lets quiet sessions expire. Sending queues the text for the session's
// mod, which submits it as the person's next prompt and acks.
//
// Answering a question, approving and interrupting are left out: the mod
// protocol has no way to do them.

import type { Fleet, Need, SessionTranscript } from '../../../../shared/protocol.ts'
import { capabilities, SendRefused, UnsupportedError, type FleetUpdate, type SendResult, type SessionBackend } from '../types.ts'
import { DELIVERY_SAID, SEND_MAX, TURNS_MAX, t3RequestId } from '../dashweb/adapter.ts'
import type { ModHub } from './hub.ts'
import { normaliseClaude } from './normalise.ts'
import { confinedPath, DEFAULT_PROJECTS_DIR, readTail, turnsOfJsonl } from './transcript.ts'

/** How often the fleet is pushed when nothing changes. Under the HUD's 15 s silence limit. */
const TICK_MS = 2_000
/** Changes closer together than this go out as one push. */
const CHANGE_GAP_MS = 100

export const INSTALL_HINT = 'No Claude Code session has reported yet. Install the mod in each session: /plugin install claudevr --marketplace dervish666/claudevr'

export interface ClaudeDeps {
  log?: (...a: unknown[]) => void
  now?: () => number
  /** Where Claude Code keeps transcripts; tests point it at a temp folder. */
  projectsDir?: string
  /** Why the listener is not running, shown on the HUD; null when it is. */
  listenerProblem?: () => string | null
  tickMs?: number
}

export class ClaudeAdapter implements SessionBackend {
  readonly name = 'claude'
  readonly capabilities = capabilities(['list', 'subscribe', 'send', 'pending', 'transcript'])
  private readonly hub: ModHub
  private readonly log: (...a: unknown[]) => void
  private readonly now: () => number
  private readonly projectsDir: string
  private readonly listenerProblem: () => string | null
  private readonly tickMs: number
  private readonly listeners = new Set<(u: FleetUpdate) => void>()
  private timer: NodeJS.Timeout | null = null
  private soon: NodeJS.Timeout | null = null
  private offChange: (() => void) | null = null
  private lastCount: string | null = null

  constructor(hub: ModHub, deps: ClaudeDeps = {}) {
    this.hub = hub
    this.log = deps.log ?? ((...a) => console.log('[claude]', ...a))
    this.now = deps.now ?? Date.now
    this.projectsDir = deps.projectsDir ?? DEFAULT_PROJECTS_DIR
    this.listenerProblem = deps.listenerProblem ?? (() => null)
    this.tickMs = deps.tickMs ?? TICK_MS
  }

  private fleet(): Fleet {
    const warnings: string[] = []
    const problem = this.listenerProblem()
    if (problem) warnings.push(problem)
    else if (!this.hub.everReported) warnings.push(INSTALL_HINT)
    const fleet = normaliseClaude({ sessions: this.hub.live(), readings: this.hub.limitReadings(), spent: this.hub.spend(), warnings }, this.now())
    const count = `${fleet.sessions.length} sessions, ${fleet.needs.length} needs`
    if (count !== this.lastCount) this.log('fleet:', count)
    this.lastCount = count
    return fleet
  }

  async list(): Promise<Fleet> {
    return this.fleet()
  }

  private push(): void {
    let update: FleetUpdate
    try {
      update = { ok: true, fleet: this.fleet() }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this.log('fleet read failed:', error)
      update = { ok: false, error, at: this.now() }
    }
    for (const l of this.listeners) l(update)
  }

  subscribe(listener: (u: FleetUpdate) => void): () => void {
    this.listeners.add(listener)
    if (!this.timer) {
      this.timer = setInterval(() => this.push(), this.tickMs)
      this.offChange = this.hub.onChange(() => {
        if (this.soon) return
        this.soon = setTimeout(() => {
          this.soon = null
          this.push()
        }, CHANGE_GAP_MS)
      })
      setImmediate(() => this.push())
    }
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) this.stop()
    }
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.soon) clearTimeout(this.soon)
    this.offChange?.()
    this.timer = this.soon = this.offChange = null
  }

  /**
   * Queues `text` for the session's mod and waits for its ack. The message id
   * is made from the HUD's request id when there is one, so a retry after a
   * bridge restart reaches the mod under the same id and the mod's own
   * memory of submitted ids stops it landing twice.
   */
  async send(id: string, text: string, requestId?: string): Promise<SendResult> {
    if (typeof text !== 'string' || !text.trim()) throw new SendRefused('nothing to send', 400)
    if (text.length > SEND_MAX) throw new SendRefused(`at most ${SEND_MAX} characters`, 400)
    const msgId = t3RequestId(requestId)
    const r = await this.hub.send(id, msgId, text)
    if (r.ok) {
      this.log('delivered', text.length, 'chars to session', id.slice(0, 40))
      return { ok: true, said: r.delivery ? DELIVERY_SAID[r.delivery] : 'Delivered.' }
    }
    // The HUD reads 502 as "nothing was sent"; anything else from here becomes a 504 with the outcome unknown.
    if (r.refused) throw new SendRefused(`${r.reason}. Nothing was sent.`, 502)
    throw new Error(`${r.reason}; it may still arrive. Check the session before sending again.`)
  }

  async transcript(id: string, limit: number): Promise<SessionTranscript> {
    const s = this.hub.get(id)
    if (!s) throw new SendRefused(`no live Claude Code session ${id.slice(0, 40)}`)
    const p = s.report.transcriptPath
    if (!p) throw new SendRefused('the session has not reported where its transcript is')
    const n = Math.min(TURNS_MAX, Math.max(1, Math.floor(limit) || 1))
    const real = await confinedPath(p, this.projectsDir)
    const turns = turnsOfJsonl(await readTail(real))
    return { sessionId: id, at: this.now(), turns: turns.slice(-n) }
  }

  async pending(): Promise<Need[]> {
    return this.fleet().needs
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

  close(): void {
    this.stop()
    this.listeners.clear()
  }
}
