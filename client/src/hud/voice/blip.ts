// Short tones for the 2D page and character mode, on the page's one
// AudioContext. Instrument mode has its own set in instrument/sound.ts; this
// file stays free of three.js so the 2D bundle does not pull it in.

import { audioContext } from './audio-context.ts'

function tone(freqs: [number, number], ms: number, gain = 0.1, at = 0): void {
  const ctx = audioContext()
  if (!ctx || ctx.state !== 'running') return
  const t0 = ctx.currentTime + at
  const osc = ctx.createOscillator()
  const g = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(freqs[0], t0)
  osc.frequency.exponentialRampToValueAtTime(freqs[1], t0 + ms / 1000)
  g.gain.setValueAtTime(0, t0)
  g.gain.linearRampToValueAtTime(gain, t0 + 0.008)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000)
  osc.connect(g).connect(ctx.destination)
  osc.start(t0)
  osc.stop(t0 + ms / 1000 + 0.02)
}

export const ui = {
  /** Heard and understood: the action has been taken, the character's words follow. */
  heard: () => {
    tone([520, 780], 60, 0.09)
    tone([780, 1040], 70, 0.08, 0.07)
  },
  /** A card went out. */
  sent: () => {
    tone([660, 660], 70, 0.09)
    tone([990, 990], 110, 0.09, 0.08)
  },
}
