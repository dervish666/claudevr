// Fetching a theme pack and changing over to it. The pack comes from
// GET /api/themes (already checked by the bridge), its pictures from
// /themes/<name>/<file> with the same token. Once all of it is here the
// change runs for about 600 ms: a light sweeps along the line work (or
// flashes once) and each part of the scene is rebuilt as the light passes
// it, one part a frame at most, so no single frame pays for the whole
// scene. A pack that cannot be used leaves today's look with a short note.

import { useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { SRGBColorSpace, TextureLoader, type Texture } from 'three'
import { DEFAULT_THEME, PACK_NAME, type Theme, type ThemeListing, type ThemePack, type Transition } from '../../../../shared/theme.ts'
import { useBatch, type LineBatch } from '../linework.tsx'
import { log } from '../telemetry.ts'
import { T, applyTheme, type ThemeTextures } from '../theme.ts'
import { PARTS, PART_X, flipPart } from './parts.tsx'

export interface LoadedTheme {
  name: string
  theme: Theme
  textures: ThemeTextures
  note: string | null
  /** What was loaded, as text: the pack's settings, its note and its pictures' sizes. Equal prints draw the same scene. */
  print: string
}

/** The print of a load: an edited pack, or another pack under the same name, prints differently. */
export const printOf = (name: string, theme: Theme, note: string | null, imageBytes: (number | null)[]) => JSON.stringify([name, theme, note, imageBytes])

/** The print of what is on screen now. Kept here, not on the scene, so a session that starts again knows what it ended on. */
let shownPrint = printOf('default', DEFAULT_THEME, null, [])

const NONE: ThemeTextures = { core: null, emblem: null, panel: null }
const TRANSITION_MS = 600

export async function fetchThemes(token: string): Promise<ThemeListing> {
  const r = await fetch('/api/themes', { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
  if (!r.ok) throw new Error(`GET /api/themes: HTTP ${r.status}`)
  return (await r.json()) as ThemeListing
}

/** The pack called `name`, or null and why not. */
export async function findPack(token: string, name: string): Promise<{ pack: ThemePack | null; note: string | null }> {
  const shout = name.toUpperCase()
  if (!PACK_NAME.test(name)) return { pack: null, note: `THEME "${name.slice(0, 40)}" NOT USED: not a pack name` }
  try {
    const l = await fetchThemes(token)
    const pack = l.themes.find(t => t.name === name)
    if (pack) return { pack, note: pack.notes[0] ? `THEME ${shout}: ${pack.notes[0]}` : null }
    const bad = l.invalid.find(t => t.name === name)
    return { pack: null, note: `THEME ${shout} NOT USED: ${bad ? bad.error : 'no such pack'}` }
  } catch (err) {
    console.error('theme: could not list the theme packs:', err)
    return { pack: null, note: `THEME ${shout} NOT LOADED: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function loadTexture(token: string, name: string, file: string): Promise<{ texture: Texture; bytes: number }> {
  const r = await fetch(`/themes/${name}/${file}`, { headers: { authorization: `Bearer ${token}` } })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const blob = await r.blob()
  const url = URL.createObjectURL(blob)
  try {
    const t = await new TextureLoader().loadAsync(url)
    t.colorSpace = SRGBColorSpace
    return { texture: t, bytes: blob.size }
  } finally {
    // The decoded image stays with the texture; the blob URL is not needed once it has loaded.
    URL.revokeObjectURL(url)
  }
}

/** A pack and its pictures, or today's look (with a note when `name` asked for a pack that is not usable). */
export async function loadTheme(token: string, name: string | null): Promise<LoadedTheme> {
  if (!name) return { name: 'default', theme: DEFAULT_THEME, textures: NONE, note: null, print: printOf('default', DEFAULT_THEME, null, []) }
  const { pack, note } = await findPack(token, name)
  if (!pack) return { name: 'default', theme: DEFAULT_THEME, textures: NONE, note, print: printOf('default', DEFAULT_THEME, note, []) }
  const textures: ThemeTextures = { core: null, emblem: null, panel: null }
  const notes = note ? [note] : []
  const bytes: (number | null)[] = []
  for (const k of ['core', 'emblem', 'panel'] as const) {
    const file = pack.theme.assets[k]
    if (!file) continue
    try {
      const got = await loadTexture(token, name, file)
      textures[k] = got.texture
      bytes.push(got.bytes)
    } catch (err) {
      console.error(`theme: ${name}/${file} did not load:`, err)
      notes.push(`THEME ${name.toUpperCase()}: ${file} did not load (${err instanceof Error ? err.message : String(err)})`)
      bytes.push(null)
    }
  }
  return { name, theme: pack.theme, textures, note: notes[0] ?? null, print: printOf(name, pack.theme, notes[0] ?? null, bytes) }
}

const texturesOf = (t: ThemeTextures): Texture[] => [t.core, t.emblem, t.panel].filter((x): x is Texture => x !== null)

interface Run {
  next: LoadedTheme
  key: string
  style: Transition
  t0: number
  flipped: number
  applied: boolean
  /** Pictures to free once every part has been rebuilt without them. */
  retire: Texture[]
}

let epoch = 0

function begin(next: LoadedTheme, prev: Run | null): Run {
  epoch++
  // What is on screen now goes at the end of this change, and so does anything a change cut short had loaded.
  const retire = [...(prev?.retire ?? []), ...(prev && !prev.applied ? texturesOf(prev.next.textures) : []), ...texturesOf(T.textures)]
  return { next, key: `${next.name}#${epoch}`, style: next.theme.motion.transition, t0: performance.now(), flipped: 0, applied: false, retire }
}

/** One frame of a change; true when it has finished. */
function step(run: Run, batch: LineBatch): boolean {
  const e = performance.now() - run.t0
  const k = Math.min(1, e / TRANSITION_MS)
  let ready = PARTS.length
  if (run.style === 'wipe') {
    const front = -1.2 + 2.4 * k
    ready = 0
    while (ready < PARTS.length && PART_X[PARTS[ready]!] < front) ready++
    batch.fx(k < 1 ? 1 : 0, front, false)
  } else if (run.style === 'flash') {
    batch.fx(k < 1 ? Math.sin(Math.PI * k) * 0.9 : 0, 0, true)
    ready = k >= 0.4 ? PARTS.length : 0
  }
  if (run.flipped < ready) {
    if (!run.applied) {
      const n = run.next
      applyTheme(n.name, n.theme, n.textures, n.note)
      shownPrint = n.print
      batch.look(n.theme.palette.glow, n.theme.palette.glowStrength)
      run.applied = true
    }
    flipPart(PARTS[run.flipped]!, run.key)
    run.flipped++
  }
  if (run.flipped < PARTS.length || (run.style !== 'cut' && k < 1)) return false
  batch.fx(0, 0, false)
  for (const t of run.retire) t.dispose()
  log('theme-applied', { name: run.next.name, note: run.next.note, ms: Math.round(e) })
  return true
}

/**
 * Keeps the scene on the theme `want` names (null: today's look). Lives
 * inside the line work, whose light it drives; renders nothing. The pack is
 * read again each time a character comes on, not only when the pack's name
 * changes: two characters can share a pack, and a pack can be edited while
 * its character is off. The change runs only when what was read differs
 * from what is on screen.
 */
export function ThemeDriver({ token, want, character }: { token: string; want: string | null; character: string | null }) {
  const batch = useBatch()
  const run = useRef<Run | null>(null)
  useEffect(() => {
    let live = true
    loadTheme(token, want).then(
      next => {
        // A newer request (or the scene going) has overtaken this one.
        if (!live) return texturesOf(next.textures).forEach(t => t.dispose())
        // Already on screen, as when a session starts again on the theme it ended on, or the next character wears the same pack unchanged.
        if (!run.current && next.print === shownPrint) return texturesOf(next.textures).forEach(t => t.dispose())
        batch.fxColour.set(next.theme.palette.accent).multiplyScalar(0.8)
        run.current = begin(next, run.current)
        log('theme-change', { from: T.name, to: next.name, style: run.current.style, note: next.note })
      },
      (err: unknown) => console.error('theme: loading failed:', err),
    )
    return () => {
      live = false
    }
    // `character` is read only as a trigger: a character coming on reads its pack again.
  }, [token, want, character, batch])
  useFrame(() => {
    if (run.current && step(run.current, batch)) run.current = null
  })
  return null
}
