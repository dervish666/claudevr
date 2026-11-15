// The Core: rings and arcs of one big circle round the Stream. The top arc
// carries the usage limits and today's spend, the bottom arc is the voice
// arc (live mic level while talking, then the 5 s send countdown), and the
// iris where it is thickest names who is being addressed and is the
// hold-to-talk target. The outgoing card slides forward over the lower Stream.

import { useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { Container, Text } from '@react-three/uikit'
import { signal } from '@preact/signals-core'
import { BufferAttribute, type BufferGeometry, type Group } from 'three'
import type { Figure, LimitWindow, Usage } from '../../../shared/protocol.ts'
import { until } from '../hud/Usage.tsx'
import { age } from '../hud/useBridge.ts'
import { SEND_COUNTDOWN_MS, type Voice } from '../hud/voice/useVoice.ts'
import { Arc, arcGeometry, arcsGeometry, glowMaterial, ticksGeometry, useGeometry } from './shapes.tsx'
import { settings, useSettings } from './settings.ts'
import { RADIUS, STREAM_HEIGHT_M } from './Stream.tsx'
import { fit } from './text.ts'
import { C, DEG, FONTS, levelColour, rgba } from './theme.ts'

/** The Stream's centre, in the rig's frame (the eye at the origin, looking down -Z). */
export const CORE_Y = -0.12
/** The circle the arcs belong to: 1.2 m across, 3 cm behind the panel plane. */
export const RING_R = 0.6
export const RING_Z = -RADIUS - 0.03
export const IRIS_R = 0.085
export const IRIS_Y = CORE_Y - RING_R
const MM = 0.001

const deg = (d: number) => d * DEG

// ---------------------------------------------------------------- rings

export function Rings() {
  const outer = useRef<Group>(null)
  const inner = useRef<Group>(null)
  const ticks = useGeometry(() => ticksGeometry(0.645, 0.014, 0.0035, 72), [])
  const majors = useGeometry(() => ticksGeometry(0.64, 0.026, 0.005, 8), [])
  useFrame((_, dt) => {
    if (!settings.current.rotation) return
    if (outer.current) outer.current.rotation.z += dt * deg(1.5)
    if (inner.current) inner.current.rotation.z -= dt * deg(2.5)
  })
  return (
    <group position={[0, CORE_Y, RING_Z]}>
      {/* Decorative, further back for stereo depth: a full ring with ticks. */}
      <group ref={outer} position-z={-0.03}>
        <Arc r={0.66} width={0.0035} from={0} to={Math.PI * 2} colour={C.cyanDim} glow={false} />
        <mesh geometry={ticks}>
          <meshBasicMaterial color={C.cyanDim} toneMapped={false} />
        </mesh>
        <mesh geometry={majors}>
          <meshBasicMaterial color={C.cyan} toneMapped={false} />
        </mesh>
      </group>
      <group ref={inner} position-z={-0.015}>
        {[0, 1, 2, 3].map(i => (
          <Arc key={i} r={0.575} width={0.004} from={deg(i * 90 + 12)} to={deg(i * 90 + 62)} colour={C.cyanDim} glow={false} />
        ))}
      </group>
      {/* The two arcs of the Core proper. */}
      <Arc r={RING_R} width={0.005} from={deg(36)} to={deg(144)} colour={C.cyan} />
      <Arc r={RING_R} width={0.004} from={deg(206)} to={deg(334)} colour={C.cyanDim} glow={false} />
    </group>
  )
}

// ---------------------------------------------------------------- top arc: limits and spend

function staleNote(f: Figure<unknown>, now: number): string | null {
  return f.stale ? (f.at === null ? 'STALE, AGE UNKNOWN' : `STALE ${age(f.at, now).toUpperCase()}`) : null
}

/** A gauge sector along the top arc whose fill is the real percentage. */
function GaugeSector({ from, to, pct, stale }: { from: number; to: number; pct: number | null; stale: boolean }) {
  const track = useGeometry(() => arcGeometry(RING_R, 0.014, deg(to), deg(from)), [from, to])
  const SEG = 64
  // Filled from the left end (larger angle) clockwise, by drawRange.
  const fill = useGeometry(() => arcGeometry(RING_R, 0.014, deg(from), deg(to), SEG), [from, to])
  const dashes = useGeometry(() => arcsGeometry(Array.from({ length: 8 }, (_, i) => ({ r: RING_R, width: 0.01, from: deg(from + ((to - from) * i) / 8), to: deg(from + ((to - from) * (i + 0.5)) / 8) }))), [from, to])
  const halo = useGeometry(() => arcGeometry(RING_R, 0.08, deg(from), deg(to), SEG), [from, to])
  const s = useSettings()
  const colour = pct === null ? C.muted : levelColour(pct)
  const haloMat = useMemo(() => glowMaterial(colour, 0.3), [colour])
  useEffect(() => () => haloMat.dispose(), [haloMat])
  const count = pct === null ? 0 : Math.round((Math.max(0, Math.min(100, pct)) / 100) * SEG) * 6
  useEffect(() => {
    fill.setDrawRange(0, count)
    halo.setDrawRange(0, count)
  }, [fill, halo, count])
  return (
    <group position-z={0.002}>
      {pct === null ? (
        <mesh geometry={dashes}>
          <meshBasicMaterial color={C.muted} toneMapped={false} />
        </mesh>
      ) : (
        <>
          <mesh geometry={track} renderOrder={-10}>
            <meshBasicMaterial color="#000" transparent opacity={0.6} depthWrite={false} toneMapped={false} />
          </mesh>
          {s.glow && !stale && <mesh geometry={halo} material={haloMat} position-z={-0.004} renderOrder={-20} />}
          <mesh geometry={fill} position-z={0.001}>
            <meshBasicMaterial color={colour} transparent={stale} opacity={stale ? 0.5 : 1} toneMapped={false} />
          </mesh>
        </>
      )}
    </group>
  )
}

const SHORT: Record<string, string> = { five_hour: '5H', seven_day: 'WEEK' }

function Readout({ x, y, label, value, sub, colour, warn }: { x: number; y: number; label: string; value: string; sub: string | null; colour: string; warn?: boolean }) {
  return (
    <group position={[x, y, 0.004]}>
      <Container pixelSize={MM} fontFamilies={FONTS} flexDirection="column" alignItems="center" paddingX={10} paddingY={4} borderRadius={6} backgroundColor={rgba(5, 8, 10, 0.9)}>
        <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={20} color={C.muted}>
          {label}
        </Text>
        <Text fontFamily="rajdhani" fontWeight="bold" fontSize={46} lineHeight={1} color={colour}>
          {value}
        </Text>
        {sub && (
          <Text fontFamily="inter" fontSize={15} color={warn ? C.amber : C.muted}>
            {fit(sub)}
          </Text>
        )}
      </Container>
    </group>
  )
}

/** The account's usage windows on the top arc. A figure the backend does not have reads n/a, never 0. */
export function TopArc({ usage, now }: { usage: Usage | undefined; now: number }) {
  const windows: LimitWindow[] = usage?.limits.value ?? []
  const five = windows.find(w => w.kind === 'five_hour') ?? null
  const week = windows.find(w => w.kind === 'seven_day') ?? windows.find(w => w !== five) ?? null
  const lim = usage?.limits
  const today = usage?.todayUsd
  const limStale = lim ? staleNote(lim, now) : null
  const sector = (w: LimitWindow | null, x: number, y: number, from: number, to: number, fallback: string) => {
    const pct = w ? Math.round(w.usedPct) : null
    return (
      <>
        <GaugeSector from={from} to={to} pct={pct} stale={!!lim?.stale} />
        <Readout
          x={x}
          y={y}
          label={w ? (SHORT[w.kind] ?? w.label.toUpperCase()) : fallback}
          value={pct === null ? 'n/a' : `${pct}%`}
          colour={pct === null ? C.muted : levelColour(pct)}
          sub={pct === null ? (lim?.note ?? 'not reported') : (limStale ?? (w!.resetsAt !== null ? `resets in ${until(w!.resetsAt, now)}` : 'reset time unknown'))}
          warn={!!limStale}
        />
      </>
    )
  }
  const spendStale = today ? staleNote(today, now) : null
  return (
    <group position={[0, CORE_Y, RING_Z]}>
      {sector(five, -0.27, 0.385, 142, 110, '5H')}
      {sector(week, 0, 0.455, 104, 76, 'WEEK')}
      <Arc r={RING_R} width={0.006} from={deg(40)} to={deg(70)} colour={today?.value == null ? C.muted : C.cyan} z={0.002} />
      <Readout
        x={0.27}
        y={0.385}
        label="TODAY"
        value={today?.value == null ? 'n/a' : `$${today.value.toFixed(2)}`}
        colour={today?.value == null ? C.muted : C.white}
        sub={today?.value == null ? (today?.note ?? 'not reported') : (spendStale ?? 'API-rate cost')}
        warn={!!spendStale}
      />
    </group>
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

export function VoiceArc({ voice, level }: { voice: Voice; level: MutableRefObject<number> }) {
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
}

// ---------------------------------------------------------------- iris

export interface IrisHandlers {
  onDown: () => void
  onUp: () => void
}

/** The iris: who is being addressed, and the hold-to-talk target (trigger or pinch while pointing at it). */
export function Iris({ name, sub, colour, voice, level, handlers, irisRef }: { name: string; sub: string; colour: string; voice: Voice; level: MutableRefObject<number>; handlers: IrisHandlers; irisRef: MutableRefObject<Group | null> }) {
  const blades = useRef<Group>(null)
  const bladeGeo = useGeometry(() => arcsGeometry(Array.from({ length: 12 }, (_, i) => ({ r: 0.074, width: 0.01, from: deg(i * 30 + 4), to: deg(i * 30 + 22) }))), [])
  const recording = voice.phase.kind === 'recording'
  useFrame((_, dt) => {
    const b = blades.current
    if (b) {
      b.rotation.z += dt * (recording ? 1.4 : settings.current.rotation ? 0.25 : 0)
      const s = 1 + (recording ? level.current * 0.12 : 0)
      b.scale.setScalar(s)
    }
  })
  const ringColour = recording ? C.red : colour
  return (
    <group ref={irisRef} position={[0, IRIS_Y, RING_Z + 0.02]}>
      <Arc r={IRIS_R} width={0.006} from={0} to={Math.PI * 2} colour={ringColour} />
      <group ref={blades} position-z={0.001}>
        <mesh geometry={bladeGeo}>
          <meshBasicMaterial color={recording ? C.red : C.cyanDim} toneMapped={false} />
        </mesh>
      </group>
      {/* The pupil: an opaque smoked disc behind the name. */}
      <mesh position-z={-0.002}>
        <circleGeometry args={[0.068, 48]} />
        <meshBasicMaterial color={recording ? '#2a0a0e' : '#06090b'} transparent opacity={0.95} toneMapped={false} />
      </mesh>
      {/* The hit target, a little larger than the iris; drawn invisibly. */}
      <mesh
        position-z={0.004}
        onPointerDown={e => {
          e.stopPropagation()
          handlers.onDown()
        }}
        onPointerUp={e => {
          e.stopPropagation()
          handlers.onUp()
        }}
      >
        <circleGeometry args={[IRIS_R + 0.02, 32]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
      </mesh>
      <group position-z={0.003}>
        <Container pixelSize={MM} fontFamilies={FONTS} flexDirection="column" alignItems="center" width={130}>
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
}

// ---------------------------------------------------------------- heard line, card, alarms

/** What was heard and what it meant, one or two lines between the Stream and the iris. */
export function HeardLine({ voice }: { voice: Voice }) {
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
}

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
export function CardView({ voice, fleetIds }: { voice: Voice; fleetIds: Set<string> }) {
  const card = voice.card
  const which = voice.which
  const countdown = useMemo(() => signal(''), [])
  const cardRef = useRef(card)
  cardRef.current = card
  const talking = voice.talking
  useFrame(() => {
    const c = cardRef.current
    if (c?.state !== 'armed') return
    const t = talking ? 'PAUSED WHILE YOU TALK' : `SENDS IN ${Math.max(0, Math.ceil((c.sendAt - Date.now()) / 1000))}`
    if (countdown.value !== t) countdown.value = t
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
              <Button key={c.sessionId} label={fit(c.callsign.toUpperCase(), 'rajdhani-700')} colour={C.cyan} onClick={() => voice.pick(c)} width={180} />
            ))}
            <Button label="NEVER MIND" colour={C.red} onClick={voice.dismissWhich} width={180} />
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
            <Button label="SEND NOW" colour={C.green} onClick={() => void voice.send()} />
            <Button label="CANCEL" colour={C.red} onClick={() => voice.cancel('Cancelled. Nothing sent.')} />
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
            {c.state !== 'sending' && <Button label="DISMISS" colour={C.muted} onClick={voice.dismissCard} width={150} />}
          </Container>
        )}
      </Container>
    </group>
  )
}

/** Outages, loud and red, above the top arc. */
export function Alarm({ lines }: { lines: string[] }) {
  if (!lines.length) return null
  return (
    <group position={[0, CORE_Y + RING_R + 0.09, RING_Z + 0.01]}>
      <Container pixelSize={MM} fontFamilies={FONTS} flexDirection="column" gap={4} width={900} padding={12} borderRadius={8} borderWidth={3} borderColor={C.red} backgroundColor={rgba(40, 6, 6, 0.95)}>
        {lines.map(l => (
          <Text key={l} fontFamily="inter" fontWeight="semi-bold" fontSize={20} color="#ffe1e1">
            {fit(l)}
          </Text>
        ))}
      </Container>
    </group>
  )
}
