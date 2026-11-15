// Sub-agents as small boxes: a lane beside each session's tile (its outer
// side; layout.ts has the numbers), and a strip above the Stream for the
// dispatcher's own. A box shows the agent's type, a state mark, its job in
// one line and, while it runs, what it is doing. Picking a box shows the
// agent in the Stream, read-only; talking still goes to the parent session.
//
// Lanes live inside their column's uikit root (Tiles.tsx), so they cost no
// extra draw calls of their own; their frames go into the shared line batch.

import { memo, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { Container, Text } from '@react-three/uikit'
import type { AgentInfo, AgentState, Session } from '../../../shared/protocol.ts'
import { shownAgents } from '../../../shared/agents.ts'
import { placed } from './Core.tsx'
import { CORE_Y, LANE_GAP, SUB_GAP, SUB_H, SUB_MORE_H, SUB_W, TILE_H, TILE_W, planSubBoxes, slotPose } from './layout.ts'
import { useLines } from './linework.tsx'
import { bracketRects, rectsGeometry } from './shapes.tsx'
import { MESH_WIDTH_M, RADIUS, STREAM_HEIGHT_M } from './Stream.tsx'
import { fit } from './text.ts'
import { C, FONTS, rgba } from './theme.ts'

const MM = 0.001
export const SUB_W_PX = SUB_W * 1000
export const SUB_H_PX = SUB_H * 1000
export const SUB_GAP_PX = SUB_GAP * 1000
export const SUB_MORE_H_PX = SUB_MORE_H * 1000

/** Everything one box draws, as plain values, so an unchanged box is equal by value. */
export interface SubView {
  id: string
  sessionId: string
  type: string
  description: string
  state: AgentState
  now: string
  /** Finished: drawn dim until it drops off. */
  dim: boolean
  selected: boolean
}

/** One session's boxes: what goes in the lane, and the "+N". */
export interface LaneView {
  sessionId: string
  boxes: SubView[]
  more: number
  moreAt: 'below' | 'lane' | null
}

const MARK: Record<AgentState, string> = { running: 'RUNNING', done: 'DONE', failed: 'FAILED', unknown: '?' }
const clipTo = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t)

export function stateTint(s: AgentState): string {
  return s === 'running' ? C.cyan : s === 'failed' ? C.red : C.muted
}

function subView(a: AgentInfo, sessionId: string, selected: string | null): SubView {
  return {
    id: a.id,
    sessionId,
    type: clipTo(a.type.toUpperCase(), 12),
    description: clipTo(a.description, 22),
    state: a.state,
    now: a.state === 'running' && a.now ? clipTo(a.now, 22) : '',
    dim: a.state !== 'running',
    selected: a.id === selected,
  }
}

/** A session's lane: the agents worth showing now, as many as fit, and the "+N" count. Null when it has none. */
export function laneOf(s: Session, now: number, selectedAgent: string | null, moreBelow: boolean): LaneView | null {
  const { agents, hiddenRunning } = shownAgents(s, now)
  if (!agents.length && !hiddenRunning) return null
  const plan = planSubBoxes(agents.length, hiddenRunning, moreBelow)
  return { sessionId: s.id, boxes: agents.slice(0, plan.boxes).map(a => subView(a, s.id, selectedAgent)), more: plan.more, moreAt: plan.moreAt }
}

/** What changes the lane's set of uikit children; a new one rebuilds its root. */
export const laneShape = (l: LaneView | null) => (l ? `${l.boxes.length}${l.moreAt ? `+${l.moreAt}` : ''}` : '-')

// ---------------------------------------------------------------- boxes (uikit)

/** One box, absolutely placed in its root. */
const SubBox = memo(function SubBox({ v, top, left, plate, onPick }: { v: SubView; top: number; left: number; plate: number; onPick: MutableRefObject<(sessionId: string, agentId: string | null) => void> }) {
  const text = v.dim ? C.muted : C.body
  return (
    <Container
      positionType="absolute"
      positionTop={top}
      positionLeft={left}
      width={SUB_W_PX}
      height={SUB_H_PX}
      flexDirection="column"
      paddingX={8}
      paddingY={5}
      borderRadius={3}
      backgroundColor={v.selected ? rgba(18, 34, 42, plate) : rgba(10, 14, 17, v.dim ? plate * 0.7 : plate)}
      hover={{ backgroundColor: rgba(24, 44, 54, Math.max(plate, 0.92)) }}
      onClick={e => {
        e.stopPropagation()
        onPick.current(v.sessionId, v.id)
      }}
    >
      <Container flexDirection="row" justifyContent="space-between" alignItems="center" gap={6} height={17} flexShrink={0}>
        <Text fontFamily="rajdhani" fontWeight="bold" fontSize={15} color={v.dim ? C.muted : C.white} wordBreak="keep-all" flexShrink={1}>
          {fit(v.type, 'rajdhani-700')}
        </Text>
        <Text fontFamily="rajdhani" fontWeight="bold" fontSize={13} color={stateTint(v.state)} flexShrink={0}>
          {MARK[v.state]}
        </Text>
      </Container>
      <Container height={16} overflow="hidden" flexShrink={0}>
        <Text fontFamily="inter" fontSize={12} color={text} wordBreak="keep-all">
          {fit(v.description)}
        </Text>
      </Container>
      {/* Always in the tree, hidden when finished: a child coming and going inside a live root leaves ghost text. */}
      <Container height={16} overflow="hidden" flexShrink={0} display={v.now ? 'flex' : 'none'}>
        <Text fontFamily="inter" fontSize={12} color={C.cyan} wordBreak="keep-all">
          {fit(v.now || ' ')}
        </Text>
      </Container>
    </Container>
  )
}, (a, b) => a.top === b.top && a.left === b.left && a.plate === b.plate && a.onPick === b.onPick && JSON.stringify(a.v) === JSON.stringify(b.v))

function MoreBox({ n, top, left, height, sessionId, onPick }: { n: number; top: number; left: number; height: number; sessionId: string; onPick: MutableRefObject<(sessionId: string, agentId: string | null) => void> }) {
  return (
    <Container
      positionType="absolute"
      positionTop={top}
      positionLeft={left}
      width={SUB_W_PX}
      height={height}
      justifyContent="center"
      alignItems="center"
      borderRadius={3}
      backgroundColor={rgba(10, 14, 17, 0.8)}
      hover={{ backgroundColor: rgba(24, 44, 54, 0.92) }}
      onClick={e => {
        e.stopPropagation()
        onPick.current(sessionId, null)
      }}
    >
      <Text fontFamily="rajdhani" fontWeight="bold" fontSize={14} color={C.muted}>
        {`+${n} MORE AGENT${n === 1 ? '' : 'S'}`}
      </Text>
    </Container>
  )
}

/** A lane's boxes inside a column root: `tileTop` is the tile's top edge in the root, `left` the lane's left edge. */
export function LaneBoxes({ lane, tileTop, left, plate, onPick }: { lane: LaneView; tileTop: number; left: number; plate: number; onPick: MutableRefObject<(sessionId: string, agentId: string | null) => void> }) {
  const step = SUB_H_PX + SUB_GAP_PX
  return (
    <>
      {lane.boxes.map((v, i) => (
        <SubBox key={v.id} v={v} top={tileTop + i * step} left={left} plate={plate} onPick={onPick} />
      ))}
      {lane.moreAt === 'below' && <MoreBox n={lane.more} top={tileTop + TILE_H * 1000 + SUB_GAP_PX} left={left} height={SUB_MORE_H_PX} sessionId={lane.sessionId} onPick={onPick} />}
      {lane.moreAt === 'lane' && <MoreBox n={lane.more} top={tileTop + lane.boxes.length * step} left={left} height={SUB_H_PX} sessionId={lane.sessionId} onPick={onPick} />}
    </>
  )
}

// ---------------------------------------------------------------- frames (line work)

/** Corner brackets round each box, in its state's colour, dim when finished. One batch entry per lane. */
function frameRects(add: (cx: number, cy: number, w: number, h: number, colour: string, alpha: number, thick: number) => void, lane: LaneView, cx: number, topY: number): void {
  const step = SUB_H + SUB_GAP
  lane.boxes.forEach((v, i) => add(cx, topY - SUB_H / 2 - i * step, SUB_W, SUB_H, v.selected ? C.white : stateTint(v.state), v.dim ? 0.45 : 1, v.selected ? 0.003 : 0.002))
  if (lane.moreAt === 'below') add(cx, topY - TILE_H - SUB_GAP - SUB_MORE_H / 2, SUB_W, SUB_MORE_H, C.muted, 0.6, 0.0015)
  if (lane.moreAt === 'lane') add(cx, topY - SUB_H / 2 - lane.boxes.length * step, SUB_W, SUB_H, C.muted, 0.6, 0.0015)
}

export const LaneLines = memo(
  function LaneLines({ slot, lane }: { slot: number; lane: LaneView }) {
    useLines(
      `lane:${slot}`,
      b => {
        const p = slotPose(slot)
        const tile = placed(b, [p.x, p.y, p.z], p.yaw, p.scale)
        const cx = p.side * (TILE_W / 2 + LANE_GAP + SUB_W / 2)
        frameRects(
          (x, y, w, h, colour, alpha, thick) => {
            b.m = tile.clone().multiply(placed(b, [x, y, 0.002]))
            b.add('line', rectsGeometry(bracketRects(w, h, Math.min(0.02, h / 2), thick)), colour, alpha)
          },
          lane,
          cx,
          TILE_H / 2,
        )
      },
      [slot, JSON.stringify(lane)],
    )
    return null
  },
  (a, b) => a.slot === b.slot && JSON.stringify(a.lane) === JSON.stringify(b.lane),
)

// ---------------------------------------------------------------- the dispatcher's strip

/** The strip sits on the Stream's top edge, left of centre: clear of the 5H readout above it and the clock to the right. */
const STRIP_LEFT = -MESH_WIDTH_M / 2
const STRIP_BOTTOM = CORE_Y + STREAM_HEIGHT_M / 2 + 0.008
const STRIP_Z = -RADIUS + 0.004
const STRIP_GAP_PX = 8

export const DispatcherAgents = memo(
  function DispatcherAgents({ lane, plate, onPick }: { lane: LaneView | null; plate: number; onPick: MutableRefObject<(sessionId: string, agentId: string | null) => void> }) {
    useLines(
      'dispatcher-agents',
      b => {
        if (!lane) return
        const n = lane.boxes.length + (lane.moreAt ? 1 : 0)
        for (let i = 0; i < n; i++) {
          const more = i >= lane.boxes.length
          const v = lane.boxes[i]
          const x = STRIP_LEFT + SUB_W / 2 + i * (SUB_W + STRIP_GAP_PX * MM)
          b.m = placed(b, [x, STRIP_BOTTOM + SUB_H / 2, STRIP_Z + 0.002])
          b.add('line', rectsGeometry(bracketRects(SUB_W, SUB_H, 0.02, v?.selected ? 0.003 : 0.002)), more ? C.muted : v!.selected ? C.white : stateTint(v!.state), more ? 0.6 : v!.dim ? 0.45 : 1)
        }
      },
      [JSON.stringify(lane)],
    )
    if (!lane) return null
    const n = lane.boxes.length + (lane.moreAt ? 1 : 0)
    const width = n * SUB_W_PX + (n - 1) * STRIP_GAP_PX
    const step = SUB_W_PX + STRIP_GAP_PX
    return (
      <group position={[STRIP_LEFT, STRIP_BOTTOM, STRIP_Z]}>
        <Container key={laneShape(lane)} pixelSize={MM} fontFamilies={FONTS} anchorX="left" anchorY="bottom" width={width} height={SUB_H_PX}>
          {lane.boxes.map((v, i) => (
            <SubBox key={v.id} v={v} top={0} left={i * step} plate={plate} onPick={onPick} />
          ))}
          {lane.moreAt && <MoreBox n={lane.more} top={0} left={lane.boxes.length * step} height={SUB_H_PX} sessionId={lane.sessionId} onPick={onPick} />}
        </Container>
      </group>
    )
  },
  (a, b) => a.plate === b.plate && a.onPick === b.onPick && JSON.stringify(a.lane) === JSON.stringify(b.lane),
)

/** The dispatcher's lane: up to three boxes in a row, and the "+N" in a fourth place. */
export const dispatcherLane = (d: Session | null, now: number, selectedAgent: string | null) => (d ? laneOf(d, now, selectedAgent, true) : null)

/** The dispatcher's strip, looking every few seconds for a finished agent to drop, since no fleet read says when. */
export function DispatcherStrip({ session, selectedAgent, plate, onPick }: { session: Session | null; selectedAgent: string | null; plate: number; onPick: MutableRefObject<(sessionId: string, agentId: string | null) => void> }) {
  const lane = dispatcherLane(session, Date.now(), selectedAgent)
  const shown = useRef('')
  shown.current = JSON.stringify(lane)
  const latest = useRef({ session, selectedAgent })
  latest.current = { session, selectedAgent }
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => {
      const l = latest.current
      if (JSON.stringify(dispatcherLane(l.session, Date.now(), l.selectedAgent)) !== shown.current) setTick(n => n + 1)
    }, 5000)
    return () => clearInterval(t)
  }, [])
  return <DispatcherAgents lane={lane} plate={plate} onPick={onPick} />
}
