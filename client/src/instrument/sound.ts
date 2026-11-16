// Sound for instrument mode: short synthesised blips for listen start,
// listen stop, a card arming and send; a positional chime from a tile's direction; and the
// spoken reply routed through a panner at the iris. Everything runs on the
// page's one AudioContext (hud/voice/audio-context.ts), unlocked by the
// Enter press.

import { AudioContext as ThreeAudioContext, AudioListener, PositionalAudio, type Object3D } from 'three'
import { audioContext } from '../hud/voice/audio-context.ts'
import { log } from './telemetry.ts'

let listener: AudioListener | null = null

/** The listener, on the camera so it follows the head. Null when the page has no audio. */
export function audioListener(camera: Object3D): AudioListener | null {
  const ctx = audioContext()
  if (!ctx) return null
  if (!listener) {
    ThreeAudioContext.setContext(ctx)
    listener = new AudioListener()
  }
  if (listener.parent !== camera) camera.add(listener)
  return listener
}

function tone(freqs: [number, number], ms: number, gain = 0.12, at = 0): void {
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

export const blips = {
  listenStart: () => tone([700, 1150], 70),
  listenStop: () => tone([1150, 620], 80),
  /**
   * A card armed and is counting down: two short pips on one pitch, so a card
   * armed by words he did not mean for it is heard even when he is looking
   * elsewhere. Unlike the others it neither slides nor climbs. The 2D page's
   * hud/voice/blip.ts plays the same idea.
   */
  armed: () => {
    tone([880, 880], 45, 0.11)
    tone([880, 880], 45, 0.11, 0.09)
  },
  send: () => {
    tone([660, 660], 70, 0.1)
    tone([990, 990], 110, 0.1, 0.08)
  },
}

/** A two-note chime from `from`'s position, panned in the head's frame. */
export function chime(from: Object3D, camera: Object3D): void {
  const l = audioListener(camera)
  const ctx = audioContext()
  if (!l || !ctx || ctx.state !== 'running') {
    log('chime-skipped', { why: !ctx ? 'no audio context' : `audio context ${ctx.state}` })
    return
  }
  const pa = new PositionalAudio(l)
  pa.setRefDistance(0.6)
  pa.panner.panningModel = 'HRTF'
  const g = ctx.createGain()
  g.gain.value = 0
  const t0 = ctx.currentTime
  for (const [f, at] of [
    [880, 0],
    [1320, 0.12],
  ] as const) {
    const o = ctx.createOscillator()
    o.type = 'triangle'
    o.frequency.value = f
    o.connect(g)
    o.start(t0 + at)
    o.stop(t0 + at + 0.6)
  }
  g.gain.setValueAtTime(0, t0)
  g.gain.linearRampToValueAtTime(0.5, t0 + 0.01)
  g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.7)
  pa.setNodeSource(g as unknown as AudioBufferSourceNode)
  from.add(pa)
  setTimeout(() => {
    pa.disconnect()
    from.remove(pa)
  }, 900)
}

/**
 * How loud the spoken reply is right now, for a theme's core to move with:
 * an analyser on the routed reply, read into a buffer made once. Null when
 * no reply is routed (a flat reply, the preview), so the caller falls back
 * to a pulse instead of reading silence as a quiet voice.
 */
const meter: { analyser: AnalyserNode | null; buf: Uint8Array<ArrayBuffer>; live: number } = { analyser: null, buf: new Uint8Array(256), live: 0 }

export function speechLevel(): number | null {
  const a = meter.analyser
  if (!a || meter.live === 0) return null
  a.getByteTimeDomainData(meter.buf)
  let sum = 0
  for (let i = 0; i < meter.buf.length; i++) {
    const v = (meter.buf[i]! - 128) / 128
    sum += v * v
  }
  return Math.min(1, Math.sqrt(sum / meter.buf.length) * 4)
}

function analyserFor(ctx: AudioContext): AnalyserNode {
  if (!meter.analyser || meter.analyser.context !== ctx) {
    meter.analyser = ctx.createAnalyser()
    meter.analyser.fftSize = meter.buf.length
  }
  return meter.analyser
}

/**
 * Plays each spoken reply from `at` (the iris): the speaker's <audio>
 * element goes through a PositionalAudio instead of straight out.
 */
export function routeFrom(at: Object3D, camera: Object3D): ((audio: HTMLAudioElement) => void) | null {
  return audio => {
    const l = audioListener(camera)
    const ctx = audioContext()
    // Routed through a suspended context the reply would be silent: play it flat instead.
    if (!l || ctx?.state !== 'running') {
      log('reply-flat', { why: !l ? 'no audio listener' : `audio context ${ctx?.state ?? 'missing'}` })
      return
    }
    try {
      const pa = new PositionalAudio(l)
      pa.setRefDistance(0.8)
      pa.panner.panningModel = 'HRTF'
      pa.setMediaElementSource(audio)
      at.add(pa)
      // A second, silent branch off the same source: the analyser only listens.
      const src = pa.source as AudioNode | null
      const an = analyserFor(ctx)
      src?.connect(an)
      meter.live++
      // 'pause' fires as well as 'ended' when a reply finishes: tear down once.
      let gone = false
      const done = () => {
        if (gone) return
        gone = true
        meter.live = Math.max(0, meter.live - 1)
        try {
          src?.disconnect(an)
        } catch (err) {
          console.error('instrument: reply meter teardown failed:', err)
        }
        try {
          pa.disconnect()
        } catch (err) {
          console.error('instrument: reply audio teardown failed:', err)
        }
        at.remove(pa)
      }
      audio.addEventListener('ended', done, { once: true })
      audio.addEventListener('pause', done, { once: true })
    } catch (err) {
      // The reply still plays, just not from the iris.
      console.error('instrument: positional reply failed, playing it flat:', err)
      log('reply-route-failed', { error: String(err) })
    }
  }
}
