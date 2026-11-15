// One AudioContext for the page: the mic level meter, instrument mode's
// blips and chime, and its positional replies. A browser starts a context
// suspended until a user gesture, so `unlockAudio` is called from one (the
// first hold to talk, the Enter instrument press).

let ctx: AudioContext | null = null

export function audioContext(): AudioContext | null {
  if (ctx) return ctx
  if (typeof AudioContext === 'undefined') return null
  try {
    ctx = new AudioContext()
  } catch (err) {
    console.error('audio: cannot create an AudioContext:', err)
    return null
  }
  return ctx
}

/** Call from inside a user gesture. */
export function unlockAudio(): void {
  const c = audioContext()
  if (c && c.state !== 'running') c.resume().catch((err: unknown) => console.error('audio: resume refused:', err))
}
