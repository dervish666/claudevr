// Where the tiles go: plain numbers, no three.js, so the bridge's test
// runner can import it. Positions are in the rig's frame (the eye at the
// origin, looking down -Z, metres).
//
// Up to six sessions sit in two inner columns of three, either side of the
// Core. From seven, a second, slightly smaller column opens outside each
// one. Ten real tiles at most: past that a "+N" tile takes the next slot and
// names the sessions without one, so nobody is dropped from view. Slots are
// sticky, so a session keeps its place (and the direction its sounds come
// from) while it is in the fleet. A small fleet gets only its own tiles.

import type { SessionState } from '../../../shared/protocol.ts'

const DEG = Math.PI / 180

/** The Stream's centre height, which the Core and the wings share. */
export const CORE_Y = -0.12
export const TILE_W = 0.3
export const TILE_H = 0.19
/**
 * A tile's state line, in px: 22, or smaller for a long one ("THINKING ·
 * READ ONLY"), so it stays on one line in the 190 px beside the context
 * gauge even with a pack's 0.1 em label spacing.
 */
export const stateSize = (line: string) => (line.length <= 12 ? 22 : line.length <= 16 ? 19 : 16)
/**
 * How much of a session's title the tile's foot has room for, in
 * characters. The foot is 262 px less the age beside it ("59M AGO" at
 * 18 px), with 4 px spare, in 16 px capitals averaging 7.75 px; a pack's
 * label spacing widens both, so a wider-spaced pack gets fewer.
 */
export function subjectChars(labelSpacingEm: number): number {
  const room = 262 - 7 * (9.2 + 18 * labelSpacingEm) - 4
  return Math.max(8, Math.floor(room / (7.75 + 16 * labelSpacingEm)))
}
/** Outer columns draw at this scale of an inner tile. */
export const OUTER_SCALE = 0.88
export const TILE_DIST = 1.25
export const INNER_AZ = 37 * DEG
/** Angular gap between an inner and an outer column. */
const COLUMN_GAP = 1.8 * DEG

// Sub-agent boxes: a lane beside each tile, on its outer side, in the tile's
// own plane. Three boxes stack in a tile's height; a "+N" box for the rest
// sits under the lane, in the gap between rows. Sizes are for an inner tile;
// an outer tile's lane scales with it.
export const SUB_W = TILE_W / 2
/** Three boxes and two gaps make a tile's height. */
export const SUB_GAP = 0.005
export const SUB_H = (TILE_H - 2 * SUB_GAP) / 3
/**
 * What a box's text is cut to, in characters. Its rows are 14 px and more
 * (about 0.64 degrees at 1.25 m) in the 138 px inside its padding: the type
 * leaves room for "RUNNING" beside it, and a line of Inter at 14 px holds
 * about 18 (both measured from the atlases in the tests).
 */
export const SUB_TYPE_CHARS = 8
export const SUB_LINE_CHARS = 18
/** The "+N" box's height, under the lane. */
export const SUB_MORE_H = 0.024
/** From the tile's edge to the lane. */
export const LANE_GAP = 0.008
/** Boxes a lane holds. */
export const SUB_ROOM = 3
/** How far the lane reaches past the tile's edge, in the tile's plane. */
const LANE_REACH = LANE_GAP + SUB_W

/** The outer columns sit past the inner columns' lanes, so a lane never runs under an outer tile. */
export const OUTER_AZ = INNER_AZ + Math.atan((TILE_W / 2 + LANE_REACH) / TILE_DIST) + COLUMN_GAP + Math.atan((TILE_W * OUTER_SCALE) / 2 / TILE_DIST)
/** Row centres above the Core's centre line: upper, middle, lower. */
export const ROW_DY = [0.23, 0, -0.23] as const

/** Real tiles at most; past this a "+N" tile stands for the rest. */
export const REAL_TILES = 10
/** The slot the "+N" tile takes. */
export const MORE_SLOT = 10
export const SLOT_COUNT = 12
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

export type PlannedTile = { slot: number; kind: 'session'; id: string } | { slot: number; kind: 'more'; id: string; hidden: string[] }

export const MORE_ID = 'more-tile'

/** The tiles to draw for a slot assignment: the agents' own, and a "+N" tile for the rest. */
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
  return { tiles: tiles.sort((a, b) => a.slot - b.slot), hidden }
}

/** Angular extent of a tile: [left az, right az, bottom y, top y], for overlap checks. */
export function tileExtent(slot: number): [number, number, number, number] {
  const p = slotPose(slot)
  const half = Math.atan((TILE_W * p.scale) / 2 / TILE_DIST)
  const h = (TILE_H * p.scale) / 2
  return [p.az - half, p.az + half, p.y - h, p.y + h]
}

// ---------------------------------------------------------------- sub-agent boxes

/** The lane's centre, across the tile's plane from the tile's centre (metres, signed outward). */
export function laneDx(slot: number): number {
  const p = slotPose(slot)
  return p.side * (TILE_W / 2 + LANE_GAP + SUB_W / 2) * p.scale
}

/** A box's centre in the tile's plane, from the tile's centre: box `i` of the lane, top first, or the "+N" box under it. */
export function subBoxOffset(slot: number, i: number | 'more'): { dx: number; dy: number; h: number } {
  const p = slotPose(slot)
  const dy = i === 'more' ? -TILE_H / 2 - SUB_GAP - SUB_MORE_H / 2 : TILE_H / 2 - SUB_H / 2 - i * (SUB_H + SUB_GAP)
  return { dx: laneDx(slot), dy: dy * p.scale, h: (i === 'more' ? SUB_MORE_H : SUB_H) * p.scale }
}

/** Whether the "+N" box fits in the gap under the tile without reaching the next row's tile. */
export function moreFitsBelow(slot: number): boolean {
  const p = slotPose(slot)
  if (p.row === 2) return true
  const gap = ROW_DY[0] - TILE_H * p.scale
  return gap >= (2 * SUB_GAP + SUB_MORE_H) * p.scale + 0.004
}

export interface SubBoxPlan {
  /** Boxes drawn in the lane. */
  boxes: number
  /** The "+N" count; 0 draws no "+N" box. */
  more: number
  /** Where the "+N" box goes: under the lane, or in the lane's last place when there is no room under it. */
  moreAt: 'below' | 'lane' | null
}

/**
 * How many of a tile's sub-agents get a box. `shown` are the ones worth
 * showing (running, or finished a moment ago), `hidden` those the bridge
 * left out. When there is no room for the "+N" box under the lane, it takes
 * the lane's last place and one box fewer is drawn.
 */
export function planSubBoxes(shown: number, hidden: number, moreBelow = true): SubBoxPlan {
  const count = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0)
  const total = count(shown)
  const extra = count(hidden)
  let boxes = Math.min(total, SUB_ROOM)
  if (total - boxes + extra === 0) return { boxes, more: 0, moreAt: null }
  if (moreBelow) return { boxes, more: total - boxes + extra, moreAt: 'below' }
  boxes = Math.min(boxes, SUB_ROOM - 1)
  return { boxes, more: total - boxes + extra, moreAt: 'lane' }
}

/** Angular extent of a sub-agent box, as tileExtent gives a tile's: [left az, right az, bottom y, top y]. */
export function subBoxExtent(slot: number, i: number | 'more'): [number, number, number, number] {
  const p = slotPose(slot)
  const o = subBoxOffset(slot, i)
  const half = (SUB_W / 2) * p.scale
  // A point dx across the plane of a tile at azimuth az sits at az + atan(dx / distance).
  const a = p.az + Math.atan((o.dx - half) / TILE_DIST)
  const b = p.az + Math.atan((o.dx + half) / TILE_DIST)
  return [Math.min(a, b), Math.max(a, b), p.y + o.dy - o.h / 2, p.y + o.dy + o.h / 2]
}

/** The top edge of the wings, above which reply cards stack. */
export const WING_TOP = CORE_Y + ROW_DY[0] + TILE_H / 2
