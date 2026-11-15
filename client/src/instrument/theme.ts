// The look: cyan for structure, amber for warnings, red for faults, purple
// for questions, neutral white body text. Fonts are MSDF atlases made from the
// bundled TTFs (scripts/make-fonts.mjs) and served by the bridge itself.
//
// A character's theme pack (shared/theme.ts) replaces all of it. The tables
// below are the ones every component reads when it renders; applyTheme
// rewrites them in place and the scene's parts are then rebuilt one at a
// time (themes/parts.ts), since uikit leaves ghost text behind when a live
// root's children change. With no pack they hold exactly today's values.

import type { Texture } from 'three'
import type { CharacterInfo, SessionState } from '../../../shared/protocol.ts'
import { DEFAULT_THEME, type FontName, type Theme } from '../../../shared/theme.ts'
import { TODAY, rolesFor, type PlateRole, type RGB } from './themes/palette.ts'

export const C = { ...TODAY.c }

/** The dark plates behind each kind of panel, as [r, g, b]; plate() adds the alpha. */
export const PLATES: Record<PlateRole, RGB> = { ...TODAY.plates }

/** Tints made from the palette: a working bar's hot white, the mic's red, the iris's smoked disc. */
export const X = { ...TODAY.x }

const ATLAS: Record<'inter-400' | 'inter-600' | 'rajdhani-600' | 'rajdhani-700', string> = {
  'inter-400': '/fonts/inter-400.json',
  'inter-600': '/fonts/inter-600.json',
  'rajdhani-600': '/fonts/rajdhani-600.json',
  'rajdhani-700': '/fonts/rajdhani-700.json',
}

type Weights = { normal?: string; 'semi-bold'?: string; bold?: string }

/**
 * uikit font families. Text asks for "rajdhani" (headings in bold, labels in
 * semi-bold) or "inter" (body text); the theme decides which atlas each of
 * those draws with, so a pack can set headings in Inter without any Text
 * changing.
 */
export const FONTS: { inter: Weights; rajdhani: Weights } = {
  inter: { normal: ATLAS['inter-400'], 'semi-bold': ATLAS['inter-600'] },
  rajdhani: { 'semi-bold': ATLAS['rajdhani-600'], bold: ATLAS['rajdhani-700'] },
}

export interface ThemeTextures {
  core: Texture | null
  emblem: Texture | null
  panel: Texture | null
}

/** The theme on screen now: its name ("default" for none), its settings, its images, and why a pack asked for could not be used. */
export const T: { name: string; theme: Theme; packAccent: boolean; textures: ThemeTextures; note: string | null } = {
  name: 'default',
  theme: DEFAULT_THEME,
  packAccent: false,
  textures: { core: null, emblem: null, panel: null },
  note: null,
}

/** Puts a theme on the tables above. Whatever renders next draws with it. */
export function applyTheme(name: string, theme: Theme, textures: ThemeTextures, note: string | null): void {
  const r = rolesFor(theme.palette)
  Object.assign(C, r.c)
  Object.assign(PLATES, r.plates)
  Object.assign(X, r.x)
  const ty = theme.typography
  const heavy = (f: FontName) => (f === 'rajdhani' ? ATLAS['rajdhani-700'] : ATLAS['inter-600'])
  FONTS.rajdhani = { 'semi-bold': ty.label.font === 'rajdhani' ? ATLAS['rajdhani-600'] : ATLAS['inter-600'], bold: heavy(ty.heading.font) }
  FONTS.inter = ty.body.font === 'inter' ? { normal: ATLAS['inter-400'], 'semi-bold': ATLAS['inter-600'] } : { normal: ATLAS['rajdhani-600'], 'semi-bold': ATLAS['rajdhani-700'] }
  T.name = name
  T.theme = theme
  T.packAccent = theme.palette.accent !== DEFAULT_THEME.palette.accent
  T.textures = textures
  T.note = note
}

/**
 * The colour for what speaks for the bridge itself (the rings, the
 * dispatcher's iris, the character's lines): a pack's own accent when it
 * sets one, else the character's `accent`, else the structure colour.
 */
export function characterAccent(c: CharacterInfo | null | undefined): string {
  return T.packAccent ? C.cyan : (c?.accent ?? C.cyan)
}

export const STATE_WORDS: Record<SessionState, string> = { working: 'WORKING', thinking: 'THINKING', asking: 'ASKING', idle: 'IDLE', failed: 'FAILED', done: 'DONE', unknown: 'UNKNOWN' }

export function stateColour(s: SessionState): string {
  if (s === 'working' || s === 'thinking') return C.cyan
  if (s === 'asking') return C.purple
  if (s === 'failed') return C.red
  return C.muted
}

/** Under 60 calm, 60 to 79 amber, 80 and over red: the same steps as the 2D page. */
export function levelColour(pct: number): string {
  return pct >= 80 ? C.red : pct >= 60 ? C.amber : C.cyan
}

export const DEG = Math.PI / 180

const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0')
/**
 * A colour with alpha for uikit, as #rrggbbaa. uikit 1.0.78 reads an
 * rgba() string as raw values in the linear working space (its hex path
 * converts from sRGB, its rgba path does not), so every dark rgba() plate
 * came out a washed grey. Hex with alpha goes through the converting path.
 */
export const rgba = (r: number, g: number, b: number, a: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}${hex2(a * 255)}`

/** A theme plate at `a` opacity. */
export const plateOf = (role: PlateRole, a: number) => {
  const p = PLATES[role]
  return rgba(p[0], p[1], p[2], a)
}

/**
 * A uikit panel's corner radius under the theme's frame: today's `r` for
 * brackets, larger for round, small for chamfer (uikit cannot cut a
 * corner, so a tight radius stands in) and none for square.
 */
export function corner(r: number): number {
  const c = T.theme.frame.corner
  return c === 'bracket' ? r : c === 'round' ? r * 2 : c === 'chamfer' ? Math.min(r, 2) : 0
}

/** A border width or line thickness scaled by the theme's line weight. */
export const weight = (w: number) => w * T.theme.frame.weight

/** `hex` darkened toward black by `f` (0 none, 1 black): the dim and faint steps of an accent, as cyanDim and cyanFaint are of cyan. */
export function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16)
  const k = 1 - f
  return `#${hex2(((n >> 16) & 255) * k)}${hex2(((n >> 8) & 255) * k)}${hex2((n & 255) * k)}`
}
