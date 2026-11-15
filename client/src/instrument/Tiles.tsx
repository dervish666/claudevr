// A tile per agent, in two wings either side of the Core. Slots are sticky:
// a session keeps its place (and so the direction its sounds come from)
// for as long as it is in the fleet, across reloads. With fewer sessions
// than slots, the rest are clearly labelled demo tiles that can never send.

import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { Container, Text } from '@react-three/uikit'
import { signal } from '@preact/signals-core'
import { CatmullRomCurve3, TubeGeometry, Vector3, type Group, type Mesh } from 'three'
import type { Session } from '../../../shared/protocol.ts'
import { age } from '../hud/useBridge.ts'
import { Arc, arcGeometry, arcsGeometry, bracketRects, glowMaterial, rectsGeometry, useGeometry } from './shapes.tsx'
import { settings, useSettings } from './settings.ts'
import { fit } from './text.ts'
import { C, DEG, FONTS, STATE_WORDS, levelColour, stateColour, rgba } from './theme.ts'
import { CORE_Y, RING_R, RING_Z } from './Core.tsx'

export const MAX_TILES = 3
const TILE_W = 0.3
const TILE_H = 0.19
const TILE_DIST = 1.25
const TILE_AZ = 37 * DEG
const ROW_Y = [0.23, 0, -0.23]
/** The order free slots fill: middle left, middle right, then upper, then lower. */
const SLOT_ORDER: [side: -1 | 1, row: number][] = [
  [-1, 1],
  [1, 1],
  [-1, 0],
  [1, 0],
  [-1, 2],
  [1, 2],
]
const SLOTS_KEY = 'claudevr.instrument.slots'
const MM = 0.001

export type TileItem = { slot: number; kind: 'session'; session: Session } | { slot: number; kind: 'demo'; id: string; callsign: string }

import { DEMO_PREFIX, isDemoTile } from '../hud/InstrumentEntry.tsx'
export const isDemoId = isDemoTile

/** Where slot `i` sits in the rig, and which way it faces. */
export function slotPose(i: number): { pos: Vector3; yaw: number; side: -1 | 1 } {
  const [side, row] = SLOT_ORDER[i]!
  const a = side * TILE_AZ
  return { pos: new Vector3(Math.sin(a) * TILE_DIST, CORE_Y + ROW_Y[row]!, -Math.cos(a) * TILE_DIST), yaw: -a, side }
}

function readSlots(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(SLOTS_KEY) ?? '{}') as unknown
    return typeof v === 'object' && v !== null ? (v as Record<string, number>) : {}
  } catch (err) {
    console.error('instrument: cannot read the tile slots, starting fresh:', err)
    return {}
  }
}

const RANK: Record<Session['state'], number> = { asking: 0, working: 1, thinking: 1, failed: 2, idle: 3, done: 4, unknown: 5 }

/** Sticky slot assignment for the fleet's sessions (the dispatcher has no tile: it is the Core's home). */
export function useTiles(sessions: Session[] | undefined): TileItem[] {
  const [slots, setSlots] = useState(readSlots)
  const agents = useMemo(() => (sessions ?? []).filter(s => s.kind !== 'dispatcher'), [sessions])
  const ids = agents.map(s => s.id).join('|')
  useEffect(() => {
    if (!sessions) return
    const live = new Set(agents.map(s => s.id))
    const next: Record<string, number> = {}
    for (const [id, slot] of Object.entries(slots)) if (live.has(id) && slot < MAX_TILES) next[id] = slot
    const used = new Set(Object.values(next))
    const waiting = agents.filter(s => next[s.id] === undefined).sort((a, b) => RANK[a.state] - RANK[b.state] || (b.activeAt ?? 0) - (a.activeAt ?? 0))
    for (const s of waiting) {
      const free = Array.from({ length: MAX_TILES }, (_, i) => i).find(i => !used.has(i))
      if (free === undefined) break
      next[s.id] = free
      used.add(free)
    }
    if (JSON.stringify(next) !== JSON.stringify(slots)) {
      setSlots(next)
      try {
        localStorage.setItem(SLOTS_KEY, JSON.stringify(next))
      } catch (err) {
        console.error('instrument: cannot keep the tile slots:', err)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, !!sessions])
  return useMemo(() => {
    const out: TileItem[] = []
    let demo = 0
    for (let i = 0; i < MAX_TILES; i++) {
      const id = Object.entries(slots).find(([, v]) => v === i)?.[0]
      const s = id ? agents.find(a => a.id === id) : undefined
      if (s) out.push({ slot: i, kind: 'session', session: s })
      else out.push({ slot: i, kind: 'demo', id: `${DEMO_PREFIX}${i}`, callsign: `DEMO ${++demo}` })
    }
    return out
  }, [slots, agents])
}

// ---------------------------------------------------------------- one tile

function Tile({ item, selected, pulse, onPick, groupRef }: { item: TileItem; selected: boolean; pulse: number; onPick: () => void; groupRef: (g: Group | null) => void }) {
  const s = useSettings()
  const { pos, yaw } = useMemo(() => slotPose(item.slot), [item.slot])
  const session = item.kind === 'session' ? item.session : null
  const demo = item.kind === 'demo'
  const colour = demo ? C.amber : stateColour(session!.state)
  const working = session?.state === 'working' || session?.state === 'thinking'
  const brackets = useGeometry(() => rectsGeometry(bracketRects(TILE_W, TILE_H, 0.034, selected ? 0.006 : 0.004)), [selected])
  const frame = useGeometry(() => rectsGeometry([[0, -TILE_H / 2 + 0.0015, TILE_W - 0.08, 0.0025]]), [])
  const bar = useRef<Mesh>(null)
  const barGlow = useRef<Mesh>(null)
  const glowMat = useMemo(() => glowMaterial(C.cyan, 0.9), [])
  useEffect(() => () => glowMat.dispose(), [glowMat])
  const barGeo = useGeometry(() => rectsGeometry([[0, 0, 0.045, 0.004]]), [])
  const flashUntil = useRef(0)
  useEffect(() => {
    if (pulse) flashUntil.current = performance.now() + 2200
  }, [pulse])
  const bracketMat = useRef<{ color: { set: (c: string) => void } } | null>(null)
  useFrame(() => {
    const now = performance.now()
    if (bar.current) {
      bar.current.visible = working
      if (working) {
        // A bright segment travelling along the bottom edge: the one constant motion on a busy tile.
        const t = (now / 2400) % 1
        bar.current.position.x = -TILE_W / 2 + 0.03 + t * (TILE_W - 0.06)
      }
    }
    if (barGlow.current && bar.current) {
      barGlow.current.visible = working && settings.current.glow
      barGlow.current.position.x = bar.current.position.x
    }
    if (bracketMat.current) bracketMat.current.color.set(now < flashUntil.current && Math.floor(now / 250) % 2 === 0 ? C.purple : colour)
  })

  // Age as a signal, ticking without re-rendering the tile.
  const ageText = useMemo(() => signal(''), [])
  useEffect(() => {
    const at = session?.activeAt ?? null
    const set = () => void (ageText.value = demo ? 'DEMO' : at === null ? 'AGE ?' : `${age(at, Date.now()).toUpperCase()} AGO`)
    set()
    const t = setInterval(set, 1000)
    return () => clearInterval(t)
  }, [ageText, demo, session?.activeAt])

  const ctx = session?.context ?? null
  const pct = ctx ? Math.round(ctx.usedPct) : null
  const action = demo ? 'Demo tile, not a session. Never sendable.' : (session!.asking?.text ?? session!.action ?? session!.lastLine ?? 'Nothing said yet.')

  return (
    <group ref={groupRef} position={pos} rotation-y={yaw}>
      <group
        onClick={e => {
          e.stopPropagation()
          onPick()
        }}
      >
        <Container
          sizeX={TILE_W}
          sizeY={TILE_H}
          pixelSize={MM}
          fontFamilies={FONTS}
          flexDirection="column"
          padding={14}
          gap={2}
          borderRadius={4}
          backgroundColor={selected ? rgba(18, 34, 42, s.plate) : rgba(10, 14, 17, s.plate)}
          hover={{ backgroundColor: rgba(24, 44, 54, Math.max(s.plate, 0.92)) }}
        >
          {/* The header keeps clear of the context gauge; the action line below runs the full width. */}
          <Container flexDirection="column" paddingRight={82} flexShrink={0}>
            <Text fontFamily="rajdhani" fontWeight="bold" fontSize={38} lineHeight={1.05} color={demo ? C.amber : C.white}>
              {fit(demo ? item.callsign : session!.callsign.toUpperCase(), 'rajdhani-700')}
            </Text>
            <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={22} color={colour}>
              {demo ? 'DEMO · NOT SENDABLE' : `${STATE_WORDS[session!.state]}${session!.canSend ? '' : ' · NO SEND ROUTE'}`}
            </Text>
          </Container>
          {/* Two lines at most: about 30 characters a line at this size. */}
          <Text fontFamily="inter" fontSize={17} lineHeight={1.3} color={C.body} marginTop={4} flexShrink={0}>
            {fit(action.length > 58 ? `${action.slice(0, 56).trimEnd()}…` : action)}
          </Text>
          <Container flexGrow={1} />
          <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={18} color={C.muted}>
            {ageText}
          </Text>
          {/* The context gauge's number sits inside the drawn arc, top right. */}
          <Container positionType="absolute" positionTop={22} positionRight={14} width={72} height={72} justifyContent="center" alignItems="center" flexDirection="column">
            <Text fontFamily="rajdhani" fontWeight="bold" fontSize={pct === null ? 20 : 24} color={pct === null ? C.muted : levelColour(pct)}>
              {pct === null ? 'n/a' : `${pct}%`}
            </Text>
            <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={13} color={C.muted}>
              CTX
            </Text>
          </Container>
        </Container>
      </group>
      <group position-z={0.002}>
        <mesh geometry={brackets}>
          <meshBasicMaterial ref={m => void (bracketMat.current = m)} color={colour} toneMapped={false} />
        </mesh>
        <mesh geometry={frame}>
          <meshBasicMaterial color={colour} transparent opacity={0.35} toneMapped={false} />
        </mesh>
        <mesh ref={bar} geometry={barGeo} position-y={-TILE_H / 2 + 0.0015} position-z={0.001}>
          <meshBasicMaterial color="#d8f8ff" toneMapped={false} />
        </mesh>
        <mesh ref={barGlow} position-y={-TILE_H / 2 + 0.0015} position-z={-0.001} material={glowMat} renderOrder={-20}>
          <planeGeometry args={[0.07, 0.016]} />
        </mesh>
        <ContextGauge pct={pct} />
      </group>
    </group>
  )
}

/** Context fullness as a 270 degree arc gauge, or a dashed arc reading n/a when the backend cannot tell. */
function ContextGauge({ pct }: { pct: number | null }) {
  const r = 0.03
  const from = 225 * DEG
  const to = -45 * DEG
  const SEG = 72
  const fill = useGeometry(() => arcGeometry(r, 0.006, from, to, SEG), [])
  const dashes = useGeometry(() => arcsGeometry(Array.from({ length: 9 }, (_, i) => ({ r, width: 0.004, from: from + ((to - from) * i) / 9, to: from + ((to - from) * (i + 0.55)) / 9 }))), [])
  const count = pct === null ? 0 : Math.round((Math.max(0, Math.min(100, pct)) / 100) * SEG) * 6
  useEffect(() => fill.setDrawRange(0, count), [fill, count])
  return (
    <group position={[TILE_W / 2 - 0.014 - 0.036, TILE_H / 2 - 0.022 - 0.036, 0]}>
      {pct === null ? (
        <mesh geometry={dashes}>
          <meshBasicMaterial color={C.muted} toneMapped={false} />
        </mesh>
      ) : (
        <>
          <Arc r={r} width={0.006} from={to} to={from} colour={C.cyanFaint} glow={false} backing={false} />
          <mesh geometry={fill} position-z={0.001}>
            <meshBasicMaterial color={levelColour(pct)} toneMapped={false} />
          </mesh>
        </>
      )}
    </group>
  )
}

// ---------------------------------------------------------------- the wings and the tether

export function Tiles({ items, selected, pulse, onPick, tileRefs }: { items: TileItem[]; selected: string | null; pulse: { slot: number; n: number } | null; onPick: (id: string) => void; tileRefs: MutableRefObject<(Group | null)[]> }) {
  return (
    <>
      {items.map(it => {
        const id = it.kind === 'session' ? it.session.id : it.id
        return <Tile key={id} item={it} selected={selected === id} pulse={pulse?.slot === it.slot ? pulse.n : 0} onPick={() => onPick(id)} groupRef={g => void (tileRefs.current[it.slot] = g)} />
      })}
    </>
  )
}

/** A curved line from the selected tile's inner edge to the side of the Core's circle. */
export function Tether({ slot }: { slot: number | null }) {
  const geo = useGeometry(() => {
    if (slot === null) return null
    const { pos, yaw, side } = slotPose(slot)
    const inner = new Vector3(-side * (TILE_W / 2), 0, 0).applyAxisAngle(new Vector3(0, 1, 0), yaw).add(pos)
    const ring = new Vector3(side * (RING_R + 0.005), CORE_Y, RING_Z)
    const mid = inner.clone().lerp(ring, 0.5)
    mid.z += 0.06
    mid.y += 0.02
    return new TubeGeometry(new CatmullRomCurve3([inner, mid, ring]), 32, 0.0022, 6, false)
  }, [slot])
  const halo = useGeometry(() => {
    if (slot === null || !geo) return null
    return new TubeGeometry((geo as TubeGeometry).parameters.path, 32, 0.007, 6, false)
  }, [geo])
  if (!geo) return null
  return (
    <group>
      <mesh geometry={geo}>
        <meshBasicMaterial color={C.cyan} toneMapped={false} />
      </mesh>
      {halo && (
        <mesh geometry={halo} renderOrder={-10}>
          <meshBasicMaterial color="#000" transparent opacity={0.45} depthWrite={false} toneMapped={false} />
        </mesh>
      )}
    </group>
  )
}
