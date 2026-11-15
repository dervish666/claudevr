// Voice out. The Quest browser has no speechSynthesis, so the bridge renders
// the speech. /api/speak needs the pairing token and an <audio> element
// cannot send headers, so the audio is fetched with the header and played
// from a blob: URL (the page's CSP allows media-src blob:).

export class Speaker {
  private readonly token: string
  private audio: HTMLAudioElement | null = null
  private url: string | null = null
  private seq = 0
  /**
   * Instrument mode routes each reply through a positional panner at the
   * iris. Null plays it straight out, as the 2D page does.
   */
  route: ((audio: HTMLAudioElement) => void) | null = null

  constructor(token: string) {
    this.token = token
  }

  /** Resolves once playback starts; rejects with a reason the HUD shows. */
  async say(text: string): Promise<void> {
    const n = ++this.seq
    const r = await fetch('/api/speak', { method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text }), cache: 'no-store' })
    if (!r.ok) {
      const body = (await r.json().catch((err: unknown) => ({ error: `HTTP ${r.status}, unreadable reply: ${String(err)}` }))) as { error?: string }
      throw new Error(body.error ?? `HTTP ${r.status}`)
    }
    const blob = await r.blob()
    // A newer reply, or stop(), overtook this one while it was fetching.
    if (n !== this.seq) return
    this.stop()
    this.url = URL.createObjectURL(blob)
    this.audio = new Audio(this.url)
    this.audio.onended = () => this.stop()
    this.route?.(this.audio)
    await this.audio.play()
  }

  /** True while a reply is playing. */
  busy(): boolean {
    return !!this.audio && !this.audio.paused && !this.audio.ended
  }

  stop(): void {
    this.seq++
    this.audio?.pause()
    this.audio = null
    if (this.url) URL.revokeObjectURL(this.url)
    this.url = null
  }
}
