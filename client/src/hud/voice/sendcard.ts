// The read-back card's safety logic, kept out of React so it can be tested
// with a fake clock: arm a card, count down, send it once, and land the
// answer only on the card it belongs to. useVoice.ts owns one of these and
// draws what it says; nothing else decides when a message goes.
//
// The rules it keeps:
// - A countdown is never zero: 5 s for the card, 2 s for a character's quick
//   line, and the quick line only when the whole message fits on it.
// - The automatic send fires for the card it was set for, once its own
//   deadline has passed, and never while he holds to talk.
// - A send's answer lands on that card only. A newer card is never
//   overwritten; the late answer is reported to the hook instead.
// - Cancel, and every new clip, start a new intent: an interpretation from
//   an older one arms nothing.
// - A clip that ends without usable words while a card is armed holds the
//   card: he may have been saying "cancel". A held card has no countdown and
//   goes only on Send or a confirm word.
// - When the bridge may have taken a message but did not say so, the card
//   says the outcome is unknown and nothing is retried.

/** How long a card shows before it sends itself: the window to read it and cancel. */
export const SEND_COUNTDOWN_MS = 5_000
/** A character with confirm "quick": shorter, never zero, since speech-to-text mishears and a sent message cannot be recalled. */
export const QUICK_COUNTDOWN_MS = 2_000
/** How long a sent or cancelled card stays up before it clears itself. */
export const DISMISS_MS = 2_500
/**
 * The longest message the quick line takes. On the headset the line gives
 * its text about 300 px beside the callsign, the countdown and Cancel, and
 * Inter 600 at 19 px averages 8.8 px a character, so 60 characters is two
 * lines, which sit inside the 64 px Cancel button's height. Anything longer
 * gets the full card, its whole text and the 5 s countdown.
 */
export const QUICK_MAX_CHARS = 60
/** How long the HUD waits for /api/send. The bridge's slowest path (T3 link, then the CLI) takes about 42 s. */
export const SEND_TIMEOUT_MS = 60_000
/** What the card says when the bridge may have taken the message but never said so. */
export const UNKNOWN_DETAIL = 'Not known whether it was sent. Check the session before sending again.'

export type CardState = 'armed' | 'sending' | 'sent' | 'refused' | 'limited' | 'unknown' | 'expired' | 'cancelled'

export interface Card {
  /** Which card this is, in this page. */
  id: number
  /** Sent with the message, so a repeat of the same request returns the first one's outcome instead of sending twice. */
  requestId: string
  sessionId: string
  callsign: string
  text: string
  viaDispatcher: boolean
  viaFocus: boolean
  /** When the countdown ends and the card sends itself. */
  sendAt: number
  /** The whole countdown, restarted in full after he talks. */
  countdownMs: number
  /** Shown as a slim line rather than the full card. */
  quick: boolean
  /** Armed with no countdown: a clip since it armed was not understood. It goes only on Send or a confirm word. */
  held: boolean
  state: CardState
  detail: string | null
}

export type SendOutcome =
  | { kind: 'sent'; said: string | null }
  | { kind: 'limited'; retryAfterS: number | null }
  | { kind: 'refused'; status: number; error: string | null }
  | { kind: 'unknown'; why: string }

/** How a send started: the countdown's timer, the frame loop's tick, or a press or "send". */
export type SendHow = 'countdown' | 'tick' | 'manual'

export interface ArmRequest {
  sessionId: string
  callsign: string
  text: string
  viaDispatcher: boolean
  viaFocus?: boolean
  /** The selected character asks for the quick line. It is used only when the whole message fits on it. */
  quickConfirm: boolean
}

export interface CardDeps {
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  newRequestId(): string
  /** Posts the card. A rejection is taken as an unknown outcome, since the request may have gone. */
  post(card: Card): Promise<SendOutcome>
  /** The card shown, after every change. */
  onChange(card: Card | null): void
  /** A send started. */
  onSending?(card: Card, how: SendHow): void
  /** A send's answer. `current` is false when the card was replaced or dismissed before it came: it was not shown. */
  onOutcome?(card: Card, outcome: SendOutcome, current: boolean): void
}

/** The whole message fits on the quick line. */
export const fitsQuickLine = (text: string): boolean => text.length <= QUICK_MAX_CHARS && !text.includes('\n')

/** What arming needs from a `tell`, or from a name picked for a waiting message. */
export interface TellToArm {
  sessionId: string
  callsign: string
  text: string
  viaDispatcher: boolean
  viaFocus?: boolean
  /** The front man's classifier, not the grammar, chose the target or the kind. */
  viaClassifier?: boolean
}

/**
 * The card a tell arms. A character's quick line is only for what the
 * grammar placed: when a model chose the target, he gets the full card and
 * its 5 s to read who it is for.
 */
export function armRequestFor(t: TellToArm, confirm: 'card' | 'quick' | null | undefined): ArmRequest {
  return { sessionId: t.sessionId, callsign: t.callsign, text: t.text, viaDispatcher: t.viaDispatcher, viaFocus: t.viaFocus === true, quickConfirm: confirm === 'quick' && t.viaClassifier !== true }
}

/** What the card says once its send has an answer. */
export function outcomeDetail(o: SendOutcome): string {
  switch (o.kind) {
    case 'sent':
      return o.said ? `Sent. ${o.said}` : 'Sent.'
    case 'limited':
      return `Rate limited: not sent. Try again in ${o.retryAfterS ?? '?'} s.`
    case 'refused':
      return `Refused (HTTP ${o.status}): ${o.error ?? 'no reason given'}. Not sent.`
    case 'unknown':
      return `${UNKNOWN_DETAIL} ${o.why}`
  }
}

const STATE_OF: Record<SendOutcome['kind'], CardState> = { sent: 'sent', limited: 'limited', refused: 'refused', unknown: 'unknown' }

export class SendCards {
  private readonly d: CardDeps
  private current: Card | null = null
  private seq = 0
  private intent = 0
  /** Why the countdown is paused: holding to talk or a clip being read ('talking'), typed words being read ('typing'). */
  private readonly pauses = new Set<string>()
  private get talking(): boolean {
    return this.pauses.size > 0
  }
  private countdown: unknown = null
  /** The card the countdown timer was set for. */
  private countdownFor: number | null = null
  private clearing: unknown = null

  constructor(deps: CardDeps) {
    this.d = deps
  }

  get card(): Card | null {
    return this.current
  }

  /** The current intent. An interpretation started under an older one is stale. */
  get generation(): number {
    return this.intent
  }

  /** A new clip: anything still being worked out for the last one is stale. */
  newIntent(): number {
    return ++this.intent
  }

  isCurrent(generation: number): boolean {
    return generation === this.intent
  }

  /** Shows a card and starts its countdown, unless he is talking (then it starts when he stops). Null when `generation` is stale. */
  arm(r: ArmRequest, generation?: number): Card | null {
    if (generation !== undefined && !this.isCurrent(generation)) return null
    const quick = r.quickConfirm && fitsQuickLine(r.text)
    const countdownMs = quick ? QUICK_COUNTDOWN_MS : SEND_COUNTDOWN_MS
    const card: Card = {
      id: ++this.seq,
      requestId: this.d.newRequestId(),
      sessionId: r.sessionId,
      callsign: r.callsign,
      text: r.text,
      viaDispatcher: r.viaDispatcher,
      viaFocus: r.viaFocus === true,
      sendAt: this.d.now() + countdownMs,
      countdownMs,
      quick,
      held: false,
      state: 'armed',
      detail: null,
    }
    this.set(card)
    if (!this.talking) this.schedule(card.id, countdownMs)
    return card
  }

  /** Holding to talk (or the mic prompt, or transcribing) pauses the countdown; it restarts in full when that ends, unless the card is held. */
  setTalking(talking: boolean): void {
    this.pause('talking', talking)
  }

  /**
   * Pauses the countdown for one reason, or ends that reason. It restarts in
   * full only when no reason is left: a clip ending while typed words are
   * still being read leaves it paused, since those words may be "cancel".
   */
  pause(reason: 'talking' | 'typing', on: boolean): void {
    const was = this.talking
    if (on) this.pauses.add(reason)
    else this.pauses.delete(reason)
    const now = this.talking
    if (now === was) return
    const c = this.current
    if (now) return this.stopCountdown()
    if (c?.state !== 'armed' || c.held) return
    const restarted = { ...c, sendAt: this.d.now() + c.countdownMs }
    this.set(restarted)
    this.schedule(restarted.id, restarted.countdownMs)
  }


  /**
   * A clip ended without usable words while a card was armed: stop its
   * countdown for good. He may have been saying "cancel", so the card waits
   * for Send, a confirm word, Cancel, or a new card. False when no card is armed.
   */
  hold(): boolean {
    const c = this.current
    if (c?.state !== 'armed') return false
    this.stopCountdown()
    if (!c.held) this.set({ ...c, held: true })
    return true
  }

  /** Send now: the button, Enter, or "send". Starts at most one send per card, held or not. */
  sendNow(): boolean {
    const c = this.current
    if (c?.state !== 'armed') return false
    void this.start(c, 'manual')
    return true
  }

  /** From a frame loop, where timers may be throttled: sends the armed card if its own countdown has run out. */
  tick(now = this.d.now()): void {
    const c = this.current
    if (c?.state === 'armed' && !c.held && !this.talking && now >= c.sendAt) void this.start(c, 'tick')
  }

  /** Stops the armed card, and makes anything still being transcribed or interpreted stale. */
  cancel(why: string): boolean {
    this.intent++
    const c = this.current
    if (c?.state !== 'armed') return false
    this.stopCountdown()
    this.set({ ...c, state: 'cancelled', held: false, detail: why })
    this.clearLater(c.id, 'cancelled')
    return true
  }

  dismiss(): void {
    this.stopCountdown()
    this.set(null)
  }

  /**
   * The HUD is going (unmount, unpair): stops the timers, makes anything
   * still being transcribed or read stale, and drops an armed card, so neither
   * a late answer nor a pause lifting afterwards (an abandoned read settles a
   * moment later) can send a card nobody can see. Clearing the pauses is for
   * the remount: a hold still open at unmount must not leave every later card
   * paused.
   * Not a one-way switch: React's StrictMode unmounts and mounts again in
   * development, and the controller must still work after.
   */
  dispose(): void {
    this.intent++
    this.stopCountdown()
    this.pauses.clear()
    if (this.current?.state === 'armed') this.set(null)
    if (this.clearing !== null) this.d.clearTimer(this.clearing)
    this.clearing = null
  }

  private set(c: Card | null): void {
    this.current = c
    if (this.clearing !== null && c?.state !== 'sent' && c?.state !== 'cancelled') {
      this.d.clearTimer(this.clearing)
      this.clearing = null
    }
    this.d.onChange(c)
  }

  private stopCountdown(): void {
    if (this.countdown !== null) this.d.clearTimer(this.countdown)
    this.countdown = null
    this.countdownFor = null
  }

  private schedule(id: number, ms: number): void {
    this.stopCountdown()
    this.countdown = this.d.setTimer(() => this.due(id), Math.max(1, ms))
    this.countdownFor = id
  }

  /** The countdown's timer, for card `id`: it sends only that card, only once its deadline has passed, and never while he talks. */
  private due(id: number): void {
    // A timer for an older card must not forget the current card's timer.
    if (this.countdownFor === id) {
      this.countdown = null
      this.countdownFor = null
    }
    const c = this.current
    if (c?.id !== id || c.state !== 'armed' || c.held || this.talking) return
    const left = c.sendAt - this.d.now()
    if (left > 0) return this.schedule(id, left)
    void this.start(c, 'countdown')
  }

  private async start(c: Card, how: SendHow): Promise<void> {
    this.stopCountdown()
    const sending: Card = { ...c, state: 'sending', held: false, detail: null }
    this.set(sending)
    this.d.onSending?.(sending, how)
    let outcome: SendOutcome
    try {
      outcome = await this.d.post(sending)
    } catch (err) {
      outcome = { kind: 'unknown', why: `The send failed in the HUD (${err instanceof Error ? err.message : String(err)}).` }
    }
    const now = this.current
    const current = now?.id === c.id && now.state === 'sending'
    if (current) {
      const state = STATE_OF[outcome.kind]
      this.set({ ...sending, state, detail: outcomeDetail(outcome) })
      if (state === 'sent') this.clearLater(c.id, 'sent')
    }
    this.d.onOutcome?.(sending, outcome, current)
  }

  /** A card that has done its job (sent, cancelled) clears itself; one that failed or whose outcome is unknown stays until dismissed. */
  private clearLater(id: number, state: CardState): void {
    if (this.clearing !== null) this.d.clearTimer(this.clearing)
    this.clearing = this.d.setTimer(() => {
      this.clearing = null
      if (this.current?.id === id && this.current.state === state) this.set(null)
    }, DISMISS_MS)
  }
}

// ---------------------------------------------------------------- the request

/** The least of fetch this needs, so tests can stand in for it. */
export type SendFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; cache: 'no-store'; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>

/** A request id the bridge accepts: 8 to 64 of [A-Za-z0-9_-]. Random, so it means this card and no other. */
export function randomRequestId(): string {
  const c = globalThis.crypto
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  return Array.from(c.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')
}

export const sendBody = (c: Card): string => JSON.stringify({ sessionId: c.sessionId, text: c.text, requestId: c.requestId })

/**
 * What an answer from /api/send means. The bridge's own refusals (4xx, and
 * 501 and 502 for a backend that said no) were not sent; a reply that says
 * the outcome is unknown, or a 5xx the bridge does not use for a refusal,
 * may have been.
 */
export function classifySend(status: number, ok: boolean, body: { error?: unknown; said?: unknown; outcome?: unknown } | null, retryAfter: string | null): SendOutcome {
  const error = typeof body?.error === 'string' ? body.error : null
  if (body?.outcome === 'unknown' || (error !== null && /not known whether/i.test(error))) return { kind: 'unknown', why: error ? `The bridge says: ${error}` : `The bridge answered HTTP ${status}.` }
  if (ok) return { kind: 'sent', said: typeof body?.said === 'string' && body.said ? body.said : null }
  if (status === 429) {
    const wait = Number(retryAfter)
    return { kind: 'limited', retryAfterS: Number.isFinite(wait) && wait > 0 ? wait : null }
  }
  if (status >= 500 && status !== 501 && status !== 502) return { kind: 'unknown', why: `The bridge answered HTTP ${status}${error ? `: ${error}` : ''}.` }
  if (body === null && status >= 500) return { kind: 'unknown', why: `The bridge answered HTTP ${status} with something unreadable.` }
  return { kind: 'refused', status, error }
}

/**
 * POST /api/send for a card. fetch rejects alike for a bridge that refused
 * the connection and for one that broke after the message went, so any
 * rejection, the timeout included, is an unknown outcome.
 */
export async function postSend(fetchFn: SendFetch, token: string, c: Card, timeoutMs = SEND_TIMEOUT_MS): Promise<SendOutcome> {
  let r: Awaited<ReturnType<SendFetch>>
  try {
    r = await fetchFn('/api/send', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: sendBody(c), cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    const e = err as { name?: string; message?: string }
    console.error('voice: send got no answer:', err)
    return { kind: 'unknown', why: e?.name === 'TimeoutError' ? `No answer from the bridge in ${Math.round(timeoutMs / 1000)} s.` : `The connection to the bridge failed (${e?.message ?? String(err)}).` }
  }
  let body: { error?: unknown; said?: unknown; outcome?: unknown } | null
  try {
    body = (await r.json()) as typeof body
  } catch (err) {
    console.error(`voice: unreadable /api/send reply (HTTP ${r.status}):`, err)
    body = null
  }
  return classifySend(r.status, r.ok, body, r.headers.get('retry-after'))
}
