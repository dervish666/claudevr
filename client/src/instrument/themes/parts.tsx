// The scene in six parts, rebuilt one at a time when the theme changes.
// uikit leaves ghost text behind when a live root's children or fonts
// change, so a theme never edits what is on screen: each part's React key
// carries the theme it was built with, and a new key builds the part again
// from the tables in theme.ts. The transition (runtime.tsx) moves the keys
// on as its front passes each part's place, one part a frame at most, so no
// frame pays for rebuilding the whole scene.

import { useSyncExternalStore, type ReactNode } from 'react'

export type Part = 'left' | 'stream' | 'core' | 'rail' | 'controls' | 'right'

/** Where each part sits across the view, in metres of rig x: the order a wipe meets them. */
export const PART_X: Record<Part, number> = { left: -0.85, stream: -0.3, core: 0, rail: 0.05, controls: 0.5, right: 0.85 }
export const PARTS: readonly Part[] = ['left', 'stream', 'core', 'rail', 'controls', 'right']

const keys: Record<Part, string> = { left: 'default', stream: 'default', core: 'default', rail: 'default', controls: 'default', right: 'default' }
const listeners = new Set<() => void>()

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

/** Moves one part on to `key` (a theme name and its epoch); the part rebuilds on the next render. */
export function flipPart(part: Part, key: string): void {
  if (keys[part] === key) return
  keys[part] = key
  for (const l of listeners) l()
}

export function partKey(part: Part): string {
  return keys[part]
}

/** The key a part was last built with, for components that key their own roots. */
export function usePartKey(part: Part): string {
  return useSyncExternalStore(subscribe, () => keys[part])
}

/** Its children, rebuilt whenever the part moves on to a new theme. */
export function ThemePart({ part, children }: { part: Part; children: ReactNode }) {
  const k = usePartKey(part)
  return <group key={k}>{children}</group>
}
