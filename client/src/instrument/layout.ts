// Where the tiles go: plain numbers, no three.js, so the bridge's test
// runner can import it. Positions are in the rig's frame (the eye at the
// origin, looking down -Z, metres).
//
// Up to six sessions sit in two inner columns of three, either side of the
// Core. From seven, a second, slightly smaller column opens outside each
// one. Ten real tiles at most: past that a "+N" tile takes the next slot and
// names the sessions without one, so nobody is dropped from view. Slots are
// sticky, so a session keeps its place (and the direction its sounds come
// from) while it is in the fleet. Demo tiles pad the wings to three only
// when the fleet has fewer than three agents.

import type { SessionState } from '../../../shared/protocol.ts'

const DEG = Math.PI / 180

/** The Stream's centre height, which the Core and the wings share. */
export const CORE_Y = -0.12
export const TILE_W = 0.3
export const TILE_H = 0.19
/** Outer columns draw at this scale of an inner tile. */
export const OUTER_SCALE = 0.88
export const TILE_DIST = 1.25
export const INNER_AZ = 37 * DEG
/** Angular gap between an inner and an outer column. */
const COLUMN_GAP = 1.8 * DEG
export const OUTER_AZ = INNER_AZ + Math.atan(TILE_W / 2 / TILE_DIST) + COLUMN_GAP + Math.atan((TILE_W * OUTER_SCALE) / 2 / TILE_DIST)
/** Row centres above the Core's centre line: upper, middle, lower. */
export const ROW_DY = [0.23, 0, -0.23] as const

/** Real tiles at most; past this a "+N" tile stands for the rest. */
export const REAL_TILES = 10
/** The slot the "+N" tile takes. */
export const MORE_SLOT = 10
export const SLOT_COUNT = 12
/** Below this many agents, demo tiles fill the gaps. */
export const DEMO_MIN = 3
/** With this many agents or fewer, only the inner columns are used. */
const INNER_SLOTS = 6

export type Side = -1 | 1
export type Column = 0 | 1

/** The order free slots fill: middle left, middle right, upper, lower; inner columns first. */
const SLOTS: [side: Side, row: 0 | 1 | 2, column: Column][] = [
  [-1, 1, 0],
  [1, 1, 0],
  [-1, 0, 0],
  [1, 0, 0],
  [-1, 2, 0],
  [1, 2, 0],
  [-1, 1, 1],
  [1, 1, 1],
  [-1, 0, 1],
  [1, 0, 1],
  [-1, 2, 1],
  [1, 2, 1],
]

export interface SlotPose {
  x: number
  y: number
  z: number
  /** Rotation about Y that faces the tile to the eye. */
  yaw: number
  side: Side
  row: 0 | 1 | 2
  column: Column
  /** 1 for the inner columns, OUTER_SCALE for the outer ones. */
  scale: number
  /** Azimuth of the tile's centre, radians, negative to the left. */
  az: number
}

export function slotPose(slot: number): SlotPose {
  const def = SLOTS[slot]
  if (!def) throw new Error(`no tile slot ${slot}`)
  const [side, row, column] = def
  const az = side * (column === 0 ? INNER_AZ : OUTER_AZ)
  return { x: Math.sin(az) * TILE_DIST, y: CORE_Y + ROW_DY[row], z: -Math.cos(az) * TILE_DIST, yaw: -az, side, row, column, scale: column === 0 ? 1 : OUTER_SCALE, az }
}

/** One wing column: its side, which column, and the pose of its middle row (where its uikit root sits). */
export function columnKey(slot: number): string {
  const p = slotPose(slot)
  return `${p.side < 0 ? 'L' : 'R'}${p.column}`
}

export interface TileAgent {
  id: string
  state: SessionState
  activeAt: number | null
}

const RANK: Record<SessionState, number> = { asking: 0, working: 1, thinking: 1, failed: 2, idle: 3, done: 4, unknown: 5 }

/** Who gets a free slot first: sessions asking, then busy ones, then the most recently active. */
export function byClaim(a: TileAgent, b: TileAgent): number {
  return RANK[a.state] - RANK[b.state] || (b.activeAt ?? 0) - (a.activeAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/**
 * Sticky slot assignment. Agents keep the slot they had; newcomers take the
 * lowest free slot in claim order. While the fleet fits the inner columns,
 * anyone left in an outer slot (the fleet shrank) moves in, so a small fleet
 * never sits in the far columns with holes nearer the Core. Agents past the
 * ten real tiles get no slot; `planTiles` counts them on the "+N" tile.
 */
export function assignSlots(prev: Record<string, number>, agents: TileAgent[]): Record<string, number> {
  const limit = agents.length <= INNER_SLOTS ? INNER_SLOTS : REAL_TILES
  const live = new Map(agents.map(a => [a.id, a]))
  const next: Record<string, number> = {}
  const used = new Set<number>()
  const movers: TileAgent[] = []
  // Keep valid slots, in slot order so a duplicate keeps the lower claim stable.
  for (const [id, slot] of Object.entries(prev).sort((a, b) => a[1] - b[1])) {
    const a = live.get(id)
    if (!a || !Number.isInteger(slot) || slot < 0 || slot >= REAL_TILES || used.has(slot)) continue
    if (slot >= limit) {
      movers.push(a)
      continue
    }
    next[id] = slot
    used.add(slot)
  }
  const waiting = agents.filter(a => next[a.id] === undefined && !movers.includes(a)).sort(byClaim)
  for (const a of [...movers, ...waiting]) {
    let free = -1
    for (let i = 0; i < limit; i++)
      if (!used.has(i)) {
        free = i
        break
      }
    if (free < 0) break
    next[a.id] = free
    used.add(free)
  }
  return next
}

export type PlannedTile = { slot: number; kind: 'session'; id: string } | { slot: number; kind: 'demo'; id: string; n: number } | { slot: number; kind: 'more'; id: string; hidden: string[] }

export const DEMO_PREFIX = 'demo-tile-'
export const MORE_ID = 'more-tile'

/** The tiles to draw for a slot assignment: the agents' own, a "+N" tile for the rest, demo padding for a small fleet. */
export function planTiles(slots: Record<string, number>, agents: TileAgent[]): { tiles: PlannedTile[]; hidden: string[] } {
  const tiles: PlannedTile[] = []
  const used = new Set<number>()
  for (const a of agents) {
    const s = slots[a.id]
    if (s === undefined || used.has(s)) continue
    tiles.push({ slot: s, kind: 'session', id: a.id })
    used.add(s)
  }
  const hidden = agents.filter(a => !tiles.some(t => t.id === a.id)).sort(byClaim).map(a => a.id)
  if (hidden.length) tiles.push({ slot: MORE_SLOT, kind: 'more', id: MORE_ID, hidden })
  let demo = 0
  for (let i = 0; tiles.length < DEMO_MIN && i < DEMO_MIN; i++) {
    if (used.has(i)) continue
    tiles.push({ slot: i, kind: 'demo', id: `${DEMO_PREFIX}${i}`, n: ++demo })
    used.add(i)
  }
  return { tiles: tiles.sort((a, b) => a.slot - b.slot), hidden }
}

/** Angular extent of a tile: [left az, right az, bottom y, top y], for overlap checks. */
export function tileExtent(slot: number): [number, number, number, number] {
  const p = slotPose(slot)
  const half = Math.atan((TILE_W * p.scale) / 2 / TILE_DIST)
  const h = (TILE_H * p.scale) / 2
  return [p.az - half, p.az + half, p.y - h, p.y + h]
}

/** The top edge of the wings, above which reply cards stack. */
export const WING_TOP = CORE_Y + ROW_DY[0] + TILE_H / 2
