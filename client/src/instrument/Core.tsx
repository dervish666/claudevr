// The Core: rings and arcs of one big circle round the Stream. The top arc
// carries the usage limits and today's spend, the bottom arc is the voice
// arc (live mic level while talking, then the 5 s send countdown), and the
// iris where it is thickest names who is being addressed and is the
// hold-to-talk target. The outgoing card slides forward over the lower Stream.

import { memo, useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { Container, Text } from '@react-three/uikit'
import { computed, signal, type Signal } from '@preact/signals-core'
import { BufferAttribute, CircleGeometry, Matrix4, Quaternion, Vector3, type BufferGeometry, type Group } from 'three'
import type { Figure, LimitWindow, Usage } from '../../../shared/protocol.ts'
import { until } from '../hud/Usage.tsx'
import { age } from '../hud/useBridge.ts'
import { SEND_COUNTDOWN_MS, type Voice } from '../hud/voice/useVoice.ts'
import { clock, second } from './clock.ts'
import { CORE_Y } from './layout.ts'
import { useBatch, useLines, type ShapeBuilder } from './linework.tsx'
import { arcGeometry, arcsGeometry, ticksGeometry, useGeometry } from './shapes.tsx'
import { settings } from './settings.ts'
import { RADIUS, STREAM_HEIGHT_M } from './Stream.tsx'
import { fit } from './text.ts'
import { C, DEG, FONTS, levelColour, rgba } from './theme.ts'

/** The Stream's centre, in the rig's frame (the eye at the origin, looking down -Z). */
export { CORE_Y }
/** The circle the arcs belong to: 1.2 m across, 3 cm behind the panel plane. */
export const RING_R = 0.6
export const RING_Z = -RADIUS - 0.03
export const IRIS_R = 0.085
export const IRIS_Y = CORE_Y - RING_R
const MM = 0.001

const deg = (d: number) => d * DEG

// ---------------------------------------------------------------- line work helpers

/**
 * A ring sector three ways, as the spike drew it: a dark backing three
 * times the line's width, the line, and a soft additive band nine times as
 * wide (with glow on). `z` offsets the whole sector from the builder's frame.
 */
export function arc(b: ShapeBuilder, o: { r: number; width: number; from: number; to: number; colour: string; opacity?: number; backing?: boolean; glow?: number | false; z?: number }): void {
  const z = o.z ?? 0
  const at = (dz: number) => b.m.clone().multiply(new Matrix4().makeTranslation(0, 0, z + dz))
  const keep = b.m
  if (o.glow !== false) {
    b.m = at(-0.004)
    b.add('glow', arcGeometry(o.r, o.width * 9, o.from, o.to), o.colour, o.glow ?? 0.35)
  }
  if (o.backing !== false) {
    b.m = at(-0.002)
    b.add('back', arcGeometry(o.r, o.width * 3, o.from, o.to), '#000000', 0.55)
  }
  b.m = at(0)
  b.add('line', arcGeometry(o.r, o.width, o.from, o.to), o.colour, o.opacity ?? 1)
  b.m = keep
}

/** The builder's frame moved to `pos` (and turned by `yawY` about Y). */
export function placed(b: ShapeBuilder, pos: [number, number, number], yawY = 0, scale = 1): Matrix4 {
  return new Matrix4().compose(new Vector3(...pos), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yawY), new Vector3(scale, scale, scale))
}

// ---------------------------------------------------------------- rings

/** Spin rates, radians a second: the outer ring and its ticks one way, the inner dashes the other. */
const OUTER_SPIN = deg(1.5)
const INNER_SPIN = -deg(2.5)

export const Rings = memo(function Rings() {
  const batch = useBatch()
  useLayoutEffect(() => batch.setPivot(0, CORE_Y), [batch])
  useLines(
    'rings',
    b => {
      b.m = placed(b, [0, CORE_Y, RING_Z - 0.03])
      b.spin = OUTER_SPIN
      // Decorative, further back for stereo depth: a full ring with ticks.
      arc(b, { r: 0.66, width: 0.0035, from: 0, to: Math.PI * 2, colour: C.cyanDim, glow: false })
      b.add('line', ticksGeometry(0.645, 0.014, 0.0035, 72), C.cyanDim)
      b.add('line', ticksGeometry(0.64, 0.026, 0.005, 8), C.cyan)
      b.m = placed(b, [0, CORE_Y, RING_Z - 0.015])
      b.spin = INNER_SPIN
      for (let i = 0; i < 4; i++) arc(b, { r: 0.575, width: 0.004, from: deg(i * 90 + 12), to: deg(i * 90 + 62), colour: C.cyanDim, glow: false })
      // The two arcs of the Core proper, still.
      b.spin = 0
      b.m = placed(b, [0, CORE_Y, RING_Z])
      arc(b, { r: RING_R, width: 0.005, from: deg(36), to: deg(144), colour: C.cyan })
      arc(b, { r: RING_R, width: 0.004, from: deg(206), to: deg(334), colour: C.cyanDim, glow: false })
    },
    [],
  )
  return null
})

// ---------------------------------------------------------------- top arc: limits, spend and the clock

function staleNote(f: Figure<unknown>, now: number): string | null {
  return f.stale ? (f.at === null ? 'STALE, AGE UNKNOWN' : `STALE ${age(f.at, now).toUpperCase()}`) : null
}

/** A gauge sector along the top arc whose fill is the real percentage. */
function gauge(b: ShapeBuilder, from: number, to: number, pct: number | null, stale: boolean): void {
  const at = (dz: number) => placed(b, [0, CORE_Y, RING_Z + 0.002 + dz])
  if (pct === null) {
    b.m = at(0)
    b.add('line', arcsGeometry(Array.from({ length: 8 }, (_, i) => ({ r: RING_R, width: 0.01, from: deg(from + ((to - from) * i) / 8), to: deg(from + ((to - from) * (i + 0.5)) / 8) }))), C.muted)
    return
  }
  const colour = levelColour(pct)
  const p = Math.max(0, Math.min(100, pct)) / 100
  b.m = at(0)
  b.add('back', arcGeometry(RING_R, 0.014, deg(to), deg(from)), '#000000', 0.6)
  if (p > 0) {
    // Filled from the left end (the larger angle), clockwise.
    const end = from + (to - from) * p
    const segs = Math.max(2, Math.round(64 * p))
    if (!stale) {
      b.m = at(-0.004)
      b.add('glow', arcGeometry(RING_R, 0.08, deg(from), deg(end), segs), colour, 0.3)
    }
    b.m = at(0.001)
    b.add('line', arcGeometry(RING_R, 0.014, deg(from), deg(end), segs), colour, stale ? 0.5 : 1)
  }
}

const SHORT: Record<string, string> = { five_hour: '5H', seven_day: 'WEEK' }

/** The top arc's readouts share one uikit root: this box, in millimetres, centred this far above the Core's centre. */
const TOP_W = 1000
const TOP_H = 380
const TOP_CY = 0.36

function Readout({ x, y, label, value, sub, colour, warn }: { x: number; y: number; label: string; value: string | Signal<string>; sub: string | Signal<string> | null; colour: string; warn?: boolean }) {
  // Placed by its centre: a fixed box at (x, y) in metres, the plate sized to its text inside it.
  const left = (x * 1000 + TOP_W / 2) - 110
  const top = (TOP_CY + TOP_H / 2000 - y) * 1000 - 60
  return (
    <Container positionType="absolute" positionLeft={left} positionTop={top} width={220} height={120} alignItems="center" justifyContent="center">
      <Container flexDirection="column" alignItems="center" paddingX={10} paddingY={4} borderRadius={6} backgroundColor={rgba(5, 8, 10, 0.9)}>
        <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={20} color={C.muted}>
          {label}
        </Text>
        <Text fontFamily="rajdhani" fontWeight="bold" fontSize={46} lineHeight={1} color={colour}>
          {value}
        </Text>
        {sub !== null && (
          <Text fontFamily="inter" fontSize={15} color={warn ? C.amber : C.muted}>
            {sub}
          </Text>
        )}
      </Container>
    </Container>
  )
}

/** Where each readout sits, in metres from the Core's centre: under its own gauge, the clock at the right end. */
const AT = { five: [-0.27, 0.385], week: [0, 0.455], today: [0.205, 0.418], clock: [0.392, 0.322] } as const

/**
 * The account's usage windows, today's spend and the local time on the top
 * arc. A figure the backend does not have reads n/a, never 0. Times that
 * move ("resets in", "stale 2m") are signals off the shared second, so the
 * arc renders again only when the usage itself changes.
 */
export const TopArc = memo(
  function TopArc({ usage }: { usage: Usage | undefined }) {
    const windows: LimitWindow[] = usage?.limits.value ?? []
    const five = windows.find(w => w.kind === 'five_hour') ?? null
    const week = windows.find(w => w !== five && w.kind === 'seven_day') ?? windows.find(w => w !== five) ?? null
    const lim = usage?.limits
    const today = usage?.todayUsd
    const pct = (w: LimitWindow | null) => (w ? Math.round(w.usedPct) : null)
    const p5 = pct(five)
    const pw = pct(week)
    const limStaleFlag = !!lim?.stale
    useLines(
      'top-arc',
      b => {
        gauge(b, 142, 110, p5, limStaleFlag)
        gauge(b, 104, 76, pw, limStaleFlag)
        b.m = placed(b, [0, CORE_Y, RING_Z])
        arc(b, { r: RING_R, width: 0.006, from: deg(40), to: deg(70), colour: today?.value == null ? C.muted : C.cyan, z: 0.002 })
      },
      [p5, pw, limStaleFlag, today?.value == null],
    )
    const subs = useMemo(() => {
      const limSub = (w: LimitWindow | null) => computed(() => {
        const now = second.value
        if (!w) return fit(lim?.note ?? 'not reported')
        return fit(lim && staleNote(lim, now) ? staleNote(lim, now)! : w.resetsAt !== null ? `resets in ${until(w.resetsAt, now)}` : 'reset time unknown')
      })
      return {
        five: limSub(five),
        week: limSub(week),
        today: computed(() => fit(today?.value == null ? (today?.note ?? 'not reported') : today && staleNote(today, second.value) ? staleNote(today, second.value)! : 'API-rate cost')),
      }
    }, [usage])
    const limStale = lim?.stale ?? false
    return (
      <group position={[0, CORE_Y + TOP_CY, RING_Z + 0.004]}>
        <Container pixelSize={MM} fontFamilies={FONTS} width={TOP_W} height={TOP_H} pointerEvents="none">
          <Readout x={AT.five[0]} y={AT.five[1]} label={five ? (SHORT[five.kind] ?? five.label.toUpperCase()) : '5H'} value={p5 === null ? 'n/a' : `${p5}%`} colour={p5 === null ? C.muted : levelColour(p5)} sub={subs.five} warn={limStale} />
          <Readout x={AT.week[0]} y={AT.week[1]} label={week ? (SHORT[week.kind] ?? week.label.toUpperCase()) : 'WEEK'} value={pw === null ? 'n/a' : `${pw}%`} colour={pw === null ? C.muted : levelColour(pw)} sub={subs.week} warn={limStale} />
          <Readout x={AT.today[0]} y={AT.today[1]} label="TODAY" value={today?.value == null ? 'n/a' : `$${today.value.toFixed(2)}`} colour={today?.value == null ? C.muted : C.white} sub={subs.today} warn={!!today?.stale} />
          <Readout x={AT.clock[0]} y={AT.clock[1]} label="LOCAL" value={clock} colour={C.white} sub={null} />
        </Container>
      </group>
    )
  },
  (a, b) => a.usage === b.usage || JSON.stringify(a.usage) === JSON.stringify(b.usage),
)

/** The voice fields the scene draws; a new voice object with all of these unchanged draws nothing new. */
export function sameVoice(a: Voice, b: Voice): boolean {
  return (
    a.phase === b.phase &&
    a.heard === b.heard &&
    a.reply === b.reply &&
    a.card === b.card &&
    a.which === b.which &&
    a.muted === b.muted &&
    a.voiceOutError === b.voiceOutError &&
    a.talking === b.talking &&
    a.sttProblem === b.sttProblem &&
    a.ttsProblem === b.ttsProblem &&
    a.sttLoading === b.sttLoading &&
    a.recorder === b.recorder &&
    a.speaker === b.speaker
  )
}

// ---------------------------------------------------------------- voice arc

const CELLS = 33
const ARC_FROM = 214
const ARC_TO = 326

/** One geometry of CELLS sectors, thickest at the centre, coloured per vertex each frame. */
function cellsGeometry(): { geo: BufferGeometry; vertsPerCell: number } {
  const span = (ARC_TO - ARC_FROM) / CELLS
  const parts = Array.from({ length: CELLS }, (_, i) => {
    const t = Math.abs((i + 0.5) / CELLS - 0.5) * 2
    return { r: RING_R, width: 0.008 + 0.016 * (1 - t) ** 1.5, from: deg(ARC_FROM + i * span + span * 0.12), to: deg(ARC_FROM + (i + 1) * span - span * 0.12) }
  })
  const geo = arcsGeometry(parts)
  const verts = geo.getAttribute('position').count
  geo.setAttribute('color', new BufferAttribute(new Float32Array(verts * 3), 3))
  return { geo, vertsPerCell: verts / CELLS }
}

const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16)
  // Vertex colours are taken as linear; square the sRGB value as a close-enough decode.
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map(v => v * v) as [number, number, number]
}
const DIM = rgb(C.cyanFaint)
const IDLE = rgb(C.cyanDim)
const MIC = rgb('#ff7a7a')
const MIC_HOT = rgb('#ffe1e1')
const AMBER = rgb(C.amber)
const GREEN = rgb(C.green)
const RED = rgb(C.red)

export const VoiceArc = memo(function VoiceArc({ voice, level }: { voice: Voice; level: MutableRefObject<number> }) {
  const { geo, vertsPerCell } = useMemo(cellsGeometry, [])
  useEffect(() => () => geo.dispose(), [geo])
  const vRef = useRef(voice)
  vRef.current = voice
  const flash = useRef<{ colour: [number, number, number]; until: number } | null>(null)
  const lastCard = useRef<string | null>(null)
  useEffect(() => {
    const c = voice.card
    const k = c ? `${c.id}:${c.state}` : null
    if (k === lastCard.current) return
    lastCard.current = k
    if (c?.state === 'sent') flash.current = { colour: GREEN, until: performance.now() + 900 }
    if (c?.state === 'refused' || c?.state === 'limited') flash.current = { colour: RED, until: performance.now() + 1500 }
    if (c?.state === 'cancelled') flash.current = { colour: IDLE, until: performance.now() + 400 }
  }, [voice.card])
  useFrame(() => {
    const v = vRef.current
    const col = geo.getAttribute('color') as BufferAttribute
    const arr = col.array as Float32Array
    const now = performance.now()
    const mid = (CELLS - 1) / 2
    const card = v.card
    for (let i = 0; i < CELLS; i++) {
      const d = Math.abs(i - mid) / mid // 0 centre .. 1 ends
      let c: [number, number, number] = d < 0.15 ? IDLE : DIM
      if (v.phase.kind === 'recording') {
        const lit = level.current
        c = d <= lit ? (d < lit * 0.5 ? MIC_HOT : MIC) : DIM
      } else if (v.phase.kind === 'transcribing' || v.phase.kind === 'mic') {
        const sweep = (Math.sin(now / 160) + 1) / 2
        c = Math.abs(i / (CELLS - 1) - sweep) < 0.06 ? AMBER : DIM
      } else if (card?.state === 'armed') {
        const left = Math.max(0, Math.min(1, (card.sendAt - Date.now()) / SEND_COUNTDOWN_MS))
        c = d <= left ? AMBER : DIM
      } else if (card?.state === 'sending') {
        c = Math.sin(now / 90) > 0 ? AMBER : DIM
      } else if (v.phase.kind === 'failed') {
        c = d < 0.5 ? RED : DIM
      }
      if (flash.current && now < flash.current.until) c = flash.current.colour
      for (let k = 0; k < vertsPerCell; k++) arr.set(c, (i * vertsPerCell + k) * 3)
    }
    col.needsUpdate = true
  })
  return (
    <group position={[0, CORE_Y, RING_Z + 0.002]}>
      <mesh geometry={geo}>
        <meshBasicMaterial vertexColors toneMapped={false} />
      </mesh>
    </group>
  )
}, (a, b) => a.level === b.level && sameVoice(a.voice, b.voice))

// ---------------------------------------------------------------- iris

export interface IrisHandlers {
  onDown: () => void
  onUp: () => void
}

/** The iris: who is being addressed, and the hold-to-talk target (trigger or pinch while pointing at it). */
export const Iris = memo(function Iris({ name, sub, colour, recording, level, handlers, irisRef }: { name: string; sub: string; colour: string; recording: boolean; level: MutableRefObject<number>; handlers: MutableRefObject<IrisHandlers>; irisRef: MutableRefObject<Group | null> }) {
  const blades = useRef<Group>(null)
  const bladeGeo = useGeometry(() => arcsGeometry(Array.from({ length: 12 }, (_, i) => ({ r: 0.074, width: 0.01, from: deg(i * 30 + 4), to: deg(i * 30 + 22) }))), [])
  useFrame((_, dt) => {
    const b = blades.current
    if (b) {
      b.rotation.z += dt * (recording ? 1.4 : settings.current.rotation ? 0.25 : 0)
      b.scale.setScalar(1 + (recording ? level.current * 0.12 : 0))
    }
  })
  const ringColour = recording ? C.red : colour
  useLines(
    'iris',
    b => {
      b.m = placed(b, [0, IRIS_Y, RING_Z + 0.02])
      arc(b, { r: IRIS_R, width: 0.006, from: 0, to: Math.PI * 2, colour: ringColour })
      // The pupil: an opaque smoked disc behind the name.
      b.m = placed(b, [0, IRIS_Y, RING_Z + 0.018])
      b.add('back', new CircleGeometry(0.068, 48), recording ? '#2a0a0e' : '#06090b', 0.95)
    },
    [ringColour, recording],
  )
  return (
    <group ref={irisRef} position={[0, IRIS_Y, RING_Z + 0.02]}>
      <group ref={blades} position-z={0.001}>
        <mesh geometry={bladeGeo}>
          <meshBasicMaterial color={recording ? C.red : C.cyanDim} toneMapped={false} />
        </mesh>
      </group>
      {/* The hit target, a little larger than the iris. Its material never draws; rays still find it. */}
      <mesh
        position-z={0.004}
        onPointerDown={e => {
          e.stopPropagation()
          handlers.current.onDown()
        }}
        onPointerUp={e => {
          e.stopPropagation()
          handlers.current.onUp()
        }}
      >
        <circleGeometry args={[IRIS_R + 0.02, 32]} />
        <meshBasicMaterial visible={false} />
      </mesh>
      <group position-z={0.003}>
        <Container pixelSize={MM} fontFamilies={FONTS} flexDirection="column" alignItems="center" width={130} pointerEvents="none">
          <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={16} color={C.muted}>
            {recording ? 'LISTENING' : 'TALK TO'}
          </Text>
          <Text fontFamily="rajdhani" fontWeight="bold" fontSize={name.length > 10 ? 18 : 22} color={colour} textAlign="center">
            {fit(name, 'rajdhani-700')}
          </Text>
          <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={15} color={C.muted} textAlign="center">
            {fit(sub, 'rajdhani-600')}
          </Text>
        </Container>
      </group>
    </group>
  )
})

// ---------------------------------------------------------------- heard line, card, alarms

/** What was heard and what it meant, one or two lines between the Stream and the iris. */
export const HeardLine = memo(function HeardLine({ voice }: { voice: Voice }) {
  const { heard, reply, phase, sttProblem, ttsProblem, voiceOutError, muted } = voice
  const line = phase.kind === 'failed' && heard?.ok !== false ? { c: C.red, t: `${phase.title}: ${phase.detail}` } : phase.kind === 'idle' && phase.note ? { c: C.amber, t: phase.note } : null
  return (
    <group position={[0, CORE_Y - STREAM_HEIGHT_M / 2 - 0.075, -RADIUS + 0.01]}>
      <Container pixelSize={MM} fontFamilies={FONTS} flexDirection="column" alignItems="center" gap={4} width={820} paddingX={14} paddingY={6} borderRadius={6} backgroundColor={rgba(5, 8, 10, 0.9)}>
        {(sttProblem || ttsProblem) && (
          <Text fontFamily="inter" fontWeight="semi-bold" fontSize={18} color={voice.sttLoading ? C.amber : C.red} textAlign="center">
            {fit([sttProblem, ttsProblem].filter(Boolean).join('  ·  '))}
          </Text>
        )}
        <Text fontFamily="inter" fontSize={19} color={heard === null ? C.muted : heard.ok ? C.white : C.red} textAlign="center">
          {fit(heard === null ? 'Hold the grip, or point at the iris and hold the trigger, and speak.' : heard.ok ? `Heard: "${clip(heard.text, 120)}"` : `${heard.title}: no transcript. ${clip(heard.detail, 90)}`)}
        </Text>
        {line && (
          <Text fontFamily="inter" fontSize={17} color={line.c} textAlign="center">
            {fit(clip(line.t, 140))}
          </Text>
        )}
        {reply && !line && (
          <Text fontFamily="inter" fontSize={17} color={C.cyan} textAlign="center">
            {fit(clip(reply.lines ? reply.lines.join(' ') : reply.say, 160))}
          </Text>
        )}
        {voiceOutError && !muted && (
          <Text fontFamily="inter" fontSize={15} color={C.amber}>
            {fit(`Voice out failed: ${clip(voiceOutError, 80)}`)}
          </Text>
        )}
      </Container>
    </group>
  )
}, (a, b) => sameVoice(a.voice, b.voice))

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function Button({ label, colour, onClick, width = 210 }: { label: string; colour: string; onClick: () => void; width?: number }) {
  return (
    <Container width={width} height={64} borderRadius={8} borderWidth={3} borderColor={colour} backgroundColor={rgba(8, 12, 15, 0.95)} hover={{ backgroundColor: rgba(30, 45, 55, 0.98) }} justifyContent="center" alignItems="center" onClick={e => (e.stopPropagation(), onClick())}>
      <Text fontFamily="rajdhani" fontWeight="bold" fontSize={26} color={colour}>
        {label}
      </Text>
    </Container>
  )
}

/** The read-back card: the target and the exact text, Send now and Cancel, and what happened after. */
export const CardView = memo(function CardView({ voice, voiceRef, fleetIds }: { voice: Voice; voiceRef: MutableRefObject<Voice>; fleetIds: Set<string> }) {
  const card = voice.card
  const which = voice.which
  const countdown = useMemo(() => signal(''), [])
  const cardRef = useRef(card)
  cardRef.current = card
  const talking = voice.talking
  // The string is built only when the whole second changes, not every frame.
  const shown = useRef(-2)
  useFrame(() => {
    const c = cardRef.current
    if (c?.state !== 'armed') return
    const n = talking ? -1 : Math.max(0, Math.ceil((c.sendAt - Date.now()) / 1000))
    if (n === shown.current) return
    shown.current = n
    countdown.value = n < 0 ? 'PAUSED WHILE YOU TALK' : `SENDS IN ${n}`
  })
  if (!card && !which) return null
  const z = -RADIUS + 0.12
  if (!card && which) {
    return (
      <group position={[0, CORE_Y - 0.1, z]}>
        <Container pixelSize={MM} fontFamilies={FONTS} flexDirection="column" gap={10} width={640} padding={18} borderRadius={10} borderWidth={3} borderColor={C.purple} backgroundColor={rgba(10, 8, 16, 0.96)}>
          <Text fontFamily="inter" fontWeight="semi-bold" fontSize={24} color={C.purple}>
            {fit(which.say)}
          </Text>
          {which.text && (
            <Text fontFamily="inter" fontSize={22} color={C.white}>
              {fit(`"${clip(which.text, 200)}"`)}
            </Text>
          )}
          <Container flexDirection="row" flexWrap="wrap" gap={12}>
            {which.candidates.map(c => (
              <Button key={c.sessionId} label={fit(c.callsign.toUpperCase(), 'rajdhani-700')} colour={C.cyan} onClick={() => voiceRef.current.pick(c)} width={180} />
            ))}
            <Button label="NEVER MIND" colour={C.red} onClick={() => voiceRef.current.dismissWhich()} width={180} />
          </Container>
        </Container>
      </group>
    )
  }
  const c = card!
  const armed = c.state === 'armed'
  const border = c.state === 'sent' ? C.green : c.state === 'refused' || c.state === 'limited' ? C.red : c.state === 'cancelled' ? C.muted : C.amber
  return (
    <group position={[0, CORE_Y - 0.1, z]}>
      <Container pixelSize={MM} fontFamilies={FONTS} flexDirection="column" gap={10} width={640} padding={18} borderRadius={10} borderWidth={3} borderColor={border} backgroundColor={rgba(6, 9, 11, 0.96)}>
        <Container flexDirection="row" alignItems="center" gap={12}>
          <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={24} color={C.muted}>
            TO
          </Text>
          <Text fontFamily="rajdhani" fontWeight="bold" fontSize={32} color={C.cyan}>
            {fit(c.callsign.toUpperCase(), 'rajdhani-700')}
          </Text>
          <Text fontFamily="inter" fontSize={16} color={!fleetIds.has(c.sessionId) ? C.amber : C.muted} flexShrink={1}>
            {!fleetIds.has(c.sessionId) ? 'no longer in the fleet' : c.viaDispatcher ? 'no session named, so the dispatcher' : c.viaFocus ? 'the selected tile' : ''}
          </Text>
        </Container>
        <Container backgroundColor={rgba(255, 255, 255, 0.06)} borderRadius={6} padding={12}>
          <Text fontFamily="inter" fontWeight="semi-bold" fontSize={26} lineHeight={1.35} color={C.white}>
            {fit(clip(c.text, 400))}
          </Text>
        </Container>
        {armed ? (
          <Container flexDirection="row" alignItems="center" gap={16}>
            <Button label="SEND NOW" colour={C.green} onClick={() => void voiceRef.current.send()} />
            <Button label="CANCEL" colour={C.red} onClick={() => voiceRef.current.cancel('Cancelled. Nothing sent.')} />
            <Text fontFamily="rajdhani" fontWeight="bold" fontSize={28} color={C.amber}>
              {countdown}
            </Text>
          </Container>
        ) : (
          <Container flexDirection="row" alignItems="center" gap={14}>
            <Text fontFamily="rajdhani" fontWeight="bold" fontSize={26} color={border}>
              {c.state === 'sending' ? 'SENDING…' : c.state.toUpperCase()}
            </Text>
            <Text fontFamily="inter" fontSize={18} color={C.body} flexShrink={1}>
              {fit(c.detail ?? '')}
            </Text>
            {c.state !== 'sending' && <Button label="DISMISS" colour={C.muted} onClick={() => voiceRef.current.dismissCard()} width={150} />}
          </Container>
        )}
      </Container>
    </group>
  )
}, (a, b) => a.voiceRef === b.voiceRef && sameVoice(a.voice, b.voice) && (!a.voice.card || a.fleetIds === b.fleetIds))

/** Outages, loud and red, above the top arc; above the needs-you rail when that is up. */
export const Alarm = memo(function Alarm({ lines, above }: { lines: string[]; above: boolean }) {
  if (!lines.length) return null
  return (
    <group position={[0, above ? 0.86 : CORE_Y + RING_R + 0.09, above ? -1.26 : RING_Z + 0.01]} rotation-x={above ? Math.atan2(0.86, 1.26) : 0}>
      <Container pixelSize={MM} fontFamilies={FONTS} anchorY={above ? 'bottom' : 'center'} flexDirection="column" gap={4} width={900} padding={12} borderRadius={8} borderWidth={3} borderColor={C.red} backgroundColor={rgba(40, 6, 6, 0.95)}>
        {lines.map(l => (
          <Text key={l} fontFamily="inter" fontWeight="semi-bold" fontSize={20} color="#ffe1e1">
            {fit(l)}
          </Text>
        ))}
      </Container>
    </group>
  )
})
