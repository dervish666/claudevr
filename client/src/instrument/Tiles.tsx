// A tile per agent, in two wings either side of the Core (layout.ts says
// where). Each wing column is one uikit root holding its tiles, so text and
// plates cost a few draw calls per column rather than per tile, and each
// tile's brackets, gauge and working bar go into the shared line batch.
// A tile renders again only when what it shows changes; its age ticks
// through a signal.

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { Container, Text } from '@react-three/uikit'
import { computed, signal, type Signal } from '@preact/signals-core'
import { CatmullRomCurve3, Color, PlaneGeometry, TubeGeometry, Vector3, type Group } from 'three'
import type { Session } from '../../../shared/protocol.ts'
import { age } from '../hud/useBridge.ts'
import { second } from './clock.ts'
import { arc, placed } from './Core.tsx'
import { CORE_Y, DEMO_PREFIX, MORE_ID, ROW_DY, TILE_H, TILE_W, assignSlots, columnKey, planTiles, slotPose } from './layout.ts'
import { useBatch, useLines } from './linework.tsx'
import { RING_R, RING_Z } from './Core.tsx'
import { arcGeometry, bracketRects, rectsGeometry } from './shapes.tsx'
import { useSettings } from './settings.ts'
import { countRender } from './telemetry.ts'
import { fit } from './text.ts'
import { C, DEG, FONTS, STATE_WORDS, levelColour, stateColour, rgba } from './theme.ts'

const SLOTS_KEY = 'claudevr.instrument.slots'
const MM = 0.001

export type TileItem = { slot: number; kind: 'session'; session: Session } | { slot: number; kind: 'demo'; id: string; callsign: string } | { slot: number; kind: 'more'; id: string; hidden: Session[] }

export const isDemoId = (id: string | null) => !!id && id.startsWith(DEMO_PREFIX)
export const itemId = (it: TileItem) => (it.kind === 'session' ? it.session.id : it.id)
export { slotPose }

function readSlots(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(SLOTS_KEY) ?? '{}') as unknown
    return typeof v === 'object' && v !== null ? (v as Record<string, number>) : {}
  } catch (err) {
    console.error('instrument: cannot read the tile slots, starting fresh:', err)
    return {}
  }
}

/** Sticky slots for the fleet's agents (the dispatcher has no tile: it is the Core's home), and the tiles to draw. */
export function useTiles(sessions: Session[] | undefined): TileItem[] {
  const [slots, setSlots] = useState(readSlots)
  const agents = useMemo(() => (sessions ?? []).filter(s => s.kind !== 'dispatcher'), [sessions])
  const ids = agents.map(s => s.id).join('|')
  useEffect(() => {
    if (!sessions) return
    const next = assignSlots(slots, agents)
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
    const byId = new Map(agents.map(a => [a.id, a]))
    return planTiles(slots, agents).tiles.map((t): TileItem => {
      if (t.kind === 'session') return { slot: t.slot, kind: 'session', session: byId.get(t.id)! }
      if (t.kind === 'more') return { slot: t.slot, kind: 'more', id: MORE_ID, hidden: t.hidden.map(id => byId.get(id)!) }
      return { slot: t.slot, kind: 'demo', id: t.id, callsign: `DEMO ${t.n}` }
    })
  }, [slots, agents])
}

// ---------------------------------------------------------------- what a tile shows

/** Everything a tile draws, as plain values, so an unchanged tile skips rendering. */
interface View {
  id: string
  slot: number
  kind: TileItem['kind']
  title: string
  /** What the session is about: its own title, when that says more than the callsign. Empty when it does not. */
  subject: string
  stateLine: string
  colour: string
  working: boolean
  action: string
  activeAt: number | null
  pct: number | null
  selected: boolean
}

const letters = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '')

/** The session's title for the tile's foot, cut to fit beside the age. Empty when it only repeats the callsign. */
function subjectOf(title: string, callsign: string): string {
  const t = title.trim()
  if (!t || letters(t) === letters(callsign)) return ''
  return (t.length > 27 ? `${t.slice(0, 26).trimEnd()}…` : t).toUpperCase()
}

function viewOf(it: TileItem, selected: boolean): View {
  const base = { id: itemId(it), slot: it.slot, kind: it.kind, selected }
  if (it.kind === 'demo') return { ...base, title: it.callsign, subject: '', stateLine: 'DEMO · NOT SENDABLE', colour: C.amber, working: false, action: 'Demo tile, not a session. Never sendable.', activeAt: null, pct: null }
  if (it.kind === 'more') {
    const names = it.hidden.map(s => s.callsign).join(', ')
    const asking = it.hidden.filter(s => s.state === 'asking').length
    return { ...base, title: `+${it.hidden.length}`, subject: '', stateLine: `MORE SESSIONS${asking ? ` · ${asking} ASKING` : ''}`, colour: asking ? C.purple : C.muted, working: false, action: names, activeAt: null, pct: null }
  }
  const s = it.session
  const action = s.asking?.text ?? s.action ?? s.lastLine ?? 'Nothing said yet.'
  return {
    ...base,
    title: s.callsign.toUpperCase(),
    subject: subjectOf(s.title, s.callsign),
    stateLine: `${STATE_WORDS[s.state]}${s.canSend ? '' : ' · READ ONLY'}`,
    colour: stateColour(s.state),
    working: s.state === 'working' || s.state === 'thinking',
    action,
    activeAt: s.activeAt,
    pct: s.context ? Math.round(s.context.usedPct) : null,
  }
}

/** Equal in everything drawn. `activeAt` is left out: it moves on every read of a busy session, and reaches the age line through a signal instead. */
const sameView = (a: View, b: View) => (Object.keys(a) as (keyof View)[]).every(k => k === 'activeAt' || a[k] === b[k])

/** The age line, off the shared second and the tile's last-active signal: a new string only when the shown age changes. */
function useAge(kind: View['kind'], at: Signal<number | null>) {
  return useMemo(
    () =>
      computed(() => {
        const t = at.value
        return kind === 'demo' ? 'DEMO' : kind === 'more' ? 'NO TILE · SAY THEIR NAME' : t === null ? 'AGE ?' : `${age(t, second.value).toUpperCase()} AGO`
      }),
    [kind, at],
  )
}

/** The tile's text and plate, inside its column's root. Rows sit `rowStep` px apart. */
const TileBody = memo(
  function TileBody({ v, at, top, onPick }: { v: View; at: Signal<number | null>; top: number; onPick: MutableRefObject<(id: string) => void> }) {
    countRender('tile')
    const s = useSettings()
    const ageText = useAge(v.kind, at)
    const more = v.kind === 'more'
    return (
      <Container
        positionType="absolute"
        positionTop={top}
        positionLeft={0}
        width={TILE_W * 1000}
        height={TILE_H * 1000}
        flexDirection="column"
        padding={14}
        gap={2}
        borderRadius={4}
        backgroundColor={v.selected ? rgba(18, 34, 42, s.plate) : rgba(10, 14, 17, s.plate)}
        hover={{ backgroundColor: rgba(24, 44, 54, Math.max(s.plate, 0.92)) }}
        onClick={e => {
          e.stopPropagation()
          onPick.current(v.id)
        }}
      >
        {/* The header keeps clear of the context gauge; the action line below runs the full width.
            minHeight holds a smaller title's action line below the gauge, level with the full-size title's. */}
        <Container flexDirection="column" paddingRight={more ? 0 : 82} minHeight={more ? 0 : 66} flexShrink={0}>
          {/* One line: a long callsign gets a smaller size rather than a second line. */}
          <Text fontFamily="rajdhani" fontWeight="bold" fontSize={v.title.length <= 8 ? 38 : v.title.length <= 11 ? 31 : 26} lineHeight={1.05} color={v.kind === 'demo' ? C.amber : C.white} wordBreak="keep-all">
            {fit(v.title.length > 15 ? `${v.title.slice(0, 14)}…` : v.title, 'rajdhani-700')}
          </Text>
          <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={22} color={v.colour}>
            {fit(v.stateLine, 'rajdhani-600')}
          </Text>
        </Container>
        {/* Two lines at most, about 30 characters a line at this size; the box clips a long word that wraps to a third. */}
        <Container height={45} overflow="hidden" marginTop={4} flexShrink={0} flexDirection="column">
          <Text fontFamily="inter" fontSize={17} lineHeight={1.3} color={C.body} flexShrink={0}>
            {fit(v.action.length > 54 ? `${v.action.slice(0, 52).trimEnd()}…` : v.action)}
          </Text>
        </Container>
        <Container flexGrow={1} />
        {/* The foot: what the session is about on the left, how long since it moved on the right. */}
        <Container flexDirection="row" alignItems="flex-end" justifyContent="space-between" gap={10} flexShrink={0}>
          <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={16} color={C.body} flexShrink={1} wordBreak="keep-all">
            {fit(v.subject, 'rajdhani-600')}
          </Text>
          <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={18} color={C.muted} flexShrink={0}>
            {ageText}
          </Text>
        </Container>
        {/* The context gauge's number sits inside the drawn arc, top right. */}
        {!more && (
          <Container positionType="absolute" positionTop={22} positionRight={14} width={72} height={72} justifyContent="center" alignItems="center" flexDirection="column">
            <Text fontFamily="rajdhani" fontWeight="bold" fontSize={v.pct === null ? 20 : 24} color={v.pct === null ? C.muted : levelColour(v.pct)}>
              {v.pct === null ? 'n/a' : `${v.pct}%`}
            </Text>
            <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={13} color={C.muted}>
              CTX
            </Text>
          </Container>
        )}
      </Container>
    )
  },
  (a, b) => a.top === b.top && a.onPick === b.onPick && a.at === b.at && sameView(a.v, b.v),
)

/** A tile's line work: corner brackets (tinted by slot), the bottom rule, the working bar and its glow, the context gauge. */
function TileLines({ v }: { v: View }) {
  useLines(
    `tile:${v.id}`,
    b => {
      const p = slotPose(v.slot)
      b.m = placed(b, [p.x, p.y, p.z], p.yaw, p.scale)
      const at = (x: number, y: number, z: number) => b.m.clone().multiply(placed(b, [x, y, z]))
      const tile = b.m
      b.m = at(0, 0, 0.002)
      b.group = v.slot
      b.add('line', rectsGeometry(bracketRects(TILE_W, TILE_H, 0.034, v.selected ? 0.006 : 0.004)), v.colour)
      b.group = -1
      b.add('line', rectsGeometry([[0, -TILE_H / 2 + 0.0015, TILE_W - 0.08, 0.0025]]), v.colour, 0.35)
      if (v.working) {
        b.m = tile.clone().multiply(placed(b, [-TILE_W / 2 + 0.03, -TILE_H / 2 + 0.0015, 0.003]))
        b.slide.set(TILE_W - 0.06, 0, 0)
        b.add('line', rectsGeometry([[0, 0, 0.045, 0.004]]), '#d8f8ff')
        b.add('glow', new PlaneGeometry(0.07, 0.016), C.cyan, 0.9)
        b.slide.set(0, 0, 0)
      }
      if (v.kind === 'more') return
      // Context fullness as a 270 degree arc gauge, or a dashed arc reading n/a when the backend cannot tell.
      const r = 0.03
      const from = 225 * DEG
      const to = -45 * DEG
      b.m = tile.clone().multiply(placed(b, [TILE_W / 2 - 0.014 - 0.036, TILE_H / 2 - 0.022 - 0.036, 0.002]))
      if (v.pct === null) {
        for (let i = 0; i < 9; i++) b.add('line', arcGeometry(r, 0.004, from + ((to - from) * i) / 9, from + ((to - from) * (i + 0.55)) / 9), C.muted)
        return
      }
      arc(b, { r, width: 0.006, from: to, to: from, colour: C.cyanFaint, glow: false, backing: false })
      const f = Math.max(0, Math.min(100, v.pct)) / 100
      if (f > 0) {
        b.m = b.m.clone().multiply(placed(b, [0, 0, 0.001]))
        b.add('line', arcGeometry(r, 0.006, from, from + (to - from) * f, Math.max(2, Math.round(72 * f))), levelColour(v.pct))
      }
    },
    [v.slot, v.colour, v.selected, v.working, v.pct, v.kind],
  )
  return null
}

const MemoTileLines = memo(TileLines, (a, b) => a.v.slot === b.v.slot && a.v.colour === b.v.colour && a.v.selected === b.v.selected && a.v.working === b.v.working && a.v.pct === b.v.pct && a.v.kind === b.v.kind && a.v.id === b.v.id)

/** One wing column: a uikit root at the column's middle row, holding up to three tiles. */
function Column({ views, ats, onPick, groupRefs }: { views: View[]; ats: Map<string, Signal<number | null>>; onPick: MutableRefObject<(id: string) => void>; groupRefs: MutableRefObject<(Group | null)[]> }) {
  const p = slotPose(views[0]!.slot)
  const px = MM * p.scale
  const rowStep = ROW_DY[0] / px
  const height = 2 * rowStep + TILE_H * 1000
  return (
    <group position={[p.x, CORE_Y, p.z]} rotation-y={p.yaw}>
      <Container pixelSize={px} fontFamilies={FONTS} width={TILE_W * 1000} height={height}>
        {views.map(v => (
          <TileBody key={v.id} v={v} at={ats.get(v.id)!} top={slotPose(v.slot).row * rowStep} onPick={onPick} />
        ))}
      </Container>
      {/* Anchors at each tile's centre, for sounds and reply cards. */}
      {views.map(v => (
        <group key={v.id} position-y={ROW_DY[slotPose(v.slot).row]} ref={g => void (groupRefs.current[v.slot] = g)} />
      ))}
    </group>
  )
}

// ---------------------------------------------------------------- the wings

const PULSE_MS = 2200
const PURPLE = new Color(C.purple).convertSRGBToLinear()
const LIT = new Color('#e8fbff').convertSRGBToLinear()

export function Tiles({ items, selected, pulse, lit, onPick, tileRefs }: { items: TileItem[]; selected: string | null; pulse: { slot: number; n: number } | null; lit: Set<number>; onPick: (id: string) => void; tileRefs: MutableRefObject<(Group | null)[]> }) {
  const pick = useRef(onPick)
  pick.current = onPick
  // Views are rebuilt each render, but each keeps its identity while nothing it shows has changed.
  const prev = useRef(new Map<string, View>())
  const views = items.map(it => {
    const v = viewOf(it, selected === itemId(it))
    const old = prev.current.get(v.id)
    return old && sameView(old, v) ? old : v
  })
  prev.current = new Map(views.map(v => [v.id, v]))
  // Each tile's last-active time as a signal, set after render: only the age text follows it.
  const ats = useRef(new Map<string, Signal<number | null>>()).current
  for (const it of items) if (!ats.has(itemId(it))) ats.set(itemId(it), signal(it.kind === 'session' ? it.session.activeAt : null))
  useLayoutEffect(() => {
    for (const it of items) ats.get(itemId(it))!.value = it.kind === 'session' ? it.session.activeAt : null
  })
  const columns = new Map<string, View[]>()
  for (const v of views) {
    const k = columnKey(v.slot)
    columns.set(k, [...(columns.get(k) ?? []), v])
  }

  // Bracket tints: the fake-need flash (purple, blinking), and a tile whose reply card is up (lit).
  const batch = useBatch()
  const flash = useRef({ slot: -1, until: 0 })
  useEffect(() => {
    if (pulse) flash.current = { slot: pulse.slot, until: performance.now() + PULSE_MS }
  }, [pulse])
  const litRef = useRef(lit)
  litRef.current = lit
  useFrame(() => {
    const now = performance.now()
    const f = flash.current
    for (let g = 0; g < 12; g++) {
      const t = batch.tint(g)
      if (g === f.slot && now < f.until) t.set(PURPLE.r, PURPLE.g, PURPLE.b, Math.floor(now / 250) % 2 === 0 ? 1 : 0)
      else if (litRef.current.has(g)) t.set(LIT.r, LIT.g, LIT.b, 0.55 + 0.25 * Math.sin(now / 300))
      else t.w = 0
    }
  })

  return (
    <>
      {[...columns.entries()].map(([k, vs]) => (
        <Column key={k} views={vs} ats={ats} onPick={pick} groupRefs={tileRefs} />
      ))}
      {views.map(v => (
        <MemoTileLines key={v.id} v={v} />
      ))}
    </>
  )
}

/** A curved line from the selected tile's inner edge to the side of the Core's circle. */
export const Tether = memo(function Tether({ slot }: { slot: number | null }) {
  useLines(
    'tether',
    b => {
      if (slot === null) return
      const { x, y, z, yaw, side, scale } = slotPose(slot)
      const inner = new Vector3(-side * ((TILE_W * scale) / 2), 0, 0).applyAxisAngle(new Vector3(0, 1, 0), yaw).add(new Vector3(x, y, z))
      const ring = new Vector3(side * (RING_R + 0.005), CORE_Y, RING_Z)
      const mid = inner.clone().lerp(ring, 0.5)
      mid.z += 0.06
      mid.y += 0.02
      const path = new CatmullRomCurve3([inner, mid, ring])
      b.add('back', new TubeGeometry(path, 32, 0.007, 6, false), '#000000', 0.45)
      b.add('line', new TubeGeometry(path, 32, 0.0022, 6, false), C.cyan)
    },
    [slot],
  )
  return null
})
