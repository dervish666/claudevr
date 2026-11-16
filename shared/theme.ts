// Theme packs: how the immersive HUD looks while a character is on. A pack
// is a folder holding a theme.json and at most three images. The bridge
// validates and serves it (bridge/src/themes.ts), instrument mode draws with
// it (client/src/instrument/themes/), and the 2D page takes its palette.
//
// Every field is optional. A field a pack leaves out keeps today's look, so
// DEFAULT_THEME is operator mode exactly. A pack with any bad value is
// refused whole, with every problem listed, rather than half applied: a typo
// that silently does nothing is harder to find than a refusal that names it.
//
// Plain data, no three.js and no Node: the bridge and the client import it.

export const THEME_SCHEMA = 1

/** A pack's folder name, and a character's `theme`: lowercase letters, digits and inner hyphens. */
export const PACK_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
/** An image a pack lists: a plain lowercase file name in the pack's own folder. */
export const ASSET_FILE = /^[a-z0-9][a-z0-9_-]{0,62}\.(?:png|webp|jpg|jpeg)$/
export const ASSET_MAX_BYTES = 400 * 1024
export const ASSET_MAX_PX = 1024
/** theme.json itself. */
export const THEME_JSON_MAX_BYTES = 64 * 1024

export type FontName = 'rajdhani' | 'inter'
export type TextCase = 'as-is' | 'upper' | 'lower' | 'title'
export type Corner = 'square' | 'chamfer' | 'round' | 'bracket'
export type CoreRenderer = 'rings' | 'lens' | 'scanner' | 'bars' | 'image'
export type BaseRenderer = Exclude<CoreRenderer, 'image'>
export type Sweep = 'none' | 'scanner' | 'pulse'
export type Transition = 'wipe' | 'flash' | 'cut'

export interface Palette {
  /** The Stream's plate, the biggest dark surface. */
  plate: string
  /** Tiles, cards, buttons and the smaller plates. */
  panel: string
  /** Panel rules, scrollbars and the dim parts of the rings. */
  line: string
  text: string
  /** Labels, ages, anything secondary. */
  dim: string
  /** Structure: the rings, a working session, links. */
  accent: string
  /** Questions, your own turns, a session asking you. */
  accent2: string
  warn: string
  bad: string
  ok: string
  /** One colour for every glow; null keeps each glow in its own line's colour. */
  glow: string | null
  /** Multiplies every glow: 0 none, 1 today, 2 at most. */
  glowStrength: number
}

export interface TextRole {
  font: FontName
  /** Extra space between letters, as a fraction of the font size. */
  letterSpacing: number
  case: TextCase
}

export interface Typography {
  /** Callsigns, titles, big numbers. */
  heading: TextRole
  /** State words, captions, button text. */
  label: TextRole
  /** Session text and sentences. */
  body: { font: FontName }
}

export interface Frame {
  /** How the line work draws a tile's, a sub-agent box's and the Stream's corners. `bracket` is corners only, today's look. */
  corner: Corner
  /** Line thickness, times today's. */
  weight: number
  /** A second, fainter line just inside the first. */
  double: boolean
  /** Short marks at the middle of each edge. */
  ticks: boolean
  /** Draw the frame round the Stream too (today it has none). */
  stream: boolean
}

export interface CoreStyle {
  /** What surrounds the talk button. `rings` is today's look. */
  renderer: CoreRenderer
  /** For `image`: a renderer drawn under the hologram, or null for the image alone. */
  under: BaseRenderer | null
  /** Keep today's decorative rings round the Stream behind any other renderer. */
  keepRings: boolean
}

export interface Motion {
  /** The rings' spin, times today's; 0 holds them still. */
  ringSpeed: number
  /** A moving accent on the top arc. */
  sweep: Sweep
  /** How the HUD changes when this theme comes on. */
  transition: Transition
}

export interface Assets {
  /** The `image` renderer's picture. */
  core: string | null
  /** A small picture beside the label on the top arc. */
  emblem: string | null
  /** A texture laid over the Stream's plate. */
  panel: string | null
  panelOpacity: number
}

export interface ThemeText {
  /** A name for the HUD on the top arc: a ship, a lab, a station. */
  label: string | null
  /** Shown in place of the "hold the grip" hint until something is heard. */
  greeting: string | null
}

export interface Theme {
  palette: Palette
  typography: Typography
  frame: Frame
  core: CoreStyle
  motion: Motion
  assets: Assets
  text: ThemeText
}

/** Today's look. Every value here is the one the code drew with before themes existed. */
export const DEFAULT_THEME: Theme = {
  palette: { plate: '#0e1216', panel: '#0a0e11', line: '#1d6a80', text: '#eef3f7', dim: '#9aaab8', accent: '#38d8ff', accent2: '#c084fc', warn: '#ffb020', bad: '#ff4d4d', ok: '#4ade80', glow: null, glowStrength: 1 },
  typography: { heading: { font: 'rajdhani', letterSpacing: 0, case: 'as-is' }, label: { font: 'rajdhani', letterSpacing: 0, case: 'as-is' }, body: { font: 'inter' } },
  frame: { corner: 'bracket', weight: 1, double: false, ticks: false, stream: false },
  core: { renderer: 'rings', under: null, keepRings: false },
  motion: { ringSpeed: 1, sweep: 'none', transition: 'wipe' },
  assets: { core: null, emblem: null, panel: null, panelOpacity: 0.12 },
  text: { label: null, greeting: null },
}

/** A valid pack as GET /api/themes lists it: the theme with defaults filled in, and what was dropped from it. */
export interface ThemePack {
  name: string
  theme: Theme
  /** Problems that did not refuse the pack: an image too big or missing, and what stood in for it. */
  notes: string[]
}

/** GET /api/themes. */
export interface ThemeListing {
  themes: ThemePack[]
  /** Folders that hold no usable pack, and why. */
  invalid: { name: string; error: string }[]
}

export type ThemeParse = { ok: true; theme: Theme } | { ok: false; errors: string[] }

// ---------------------------------------------------------------- validation

const HEX = /^#[0-9a-fA-F]{6}$/
const FONTS: readonly FontName[] = ['rajdhani', 'inter']
const CASES: readonly TextCase[] = ['as-is', 'upper', 'lower', 'title']
const CORNERS: readonly Corner[] = ['square', 'chamfer', 'round', 'bracket']
const RENDERERS: readonly CoreRenderer[] = ['rings', 'lens', 'scanner', 'bars', 'image']
const SWEEPS: readonly Sweep[] = ['none', 'scanner', 'pulse']
const TRANSITIONS: readonly Transition[] = ['wipe', 'flash', 'cut']
const COLOUR_KEYS = ['plate', 'panel', 'line', 'text', 'dim', 'accent', 'accent2', 'warn', 'bad', 'ok'] as const

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Reads one section: unknown keys are errors, each known key goes through its reader. */
class Reader {
  readonly errors: string[] = []
  section(v: unknown, path: string, keys: readonly string[]): Obj {
    if (v === undefined) return {}
    if (!isObj(v)) {
      this.errors.push(`${path}: an object, got ${kind(v)}`)
      return {}
    }
    for (const k of Object.keys(v)) if (!keys.includes(k)) this.errors.push(`${path}.${k}: not a theme setting (known: ${keys.join(', ')})`)
    return v
  }
  colour(v: unknown, path: string, fallback: string): string {
    if (v === undefined) return fallback
    if (typeof v === 'string' && HEX.test(v)) return v.toLowerCase()
    this.errors.push(`${path}: a colour as #rrggbb, got ${show(v)}`)
    return fallback
  }
  number(v: unknown, path: string, fallback: number, min: number, max: number): number {
    if (v === undefined) return fallback
    if (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max) return v
    this.errors.push(`${path}: a number from ${min} to ${max}, got ${show(v)}`)
    return fallback
  }
  bool(v: unknown, path: string, fallback: boolean): boolean {
    if (v === undefined) return fallback
    if (typeof v === 'boolean') return v
    this.errors.push(`${path}: true or false, got ${show(v)}`)
    return fallback
  }
  oneOf<T extends string>(v: unknown, path: string, allowed: readonly T[], fallback: T): T {
    if (v === undefined) return fallback
    if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T
    this.errors.push(`${path}: one of ${allowed.join(', ')}, got ${show(v)}`)
    return fallback
  }
  text(v: unknown, path: string, max: number): string | null {
    if (v === undefined || v === null) return null
    // Printable text only: it is drawn, and a control character would draw as a box.
    if (typeof v === 'string' && v.trim() && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v)) return v.trim()
    this.errors.push(`${path}: text of 1 to ${max} characters on one line, got ${show(v)}`)
    return null
  }
  file(v: unknown, path: string): string | null {
    if (v === undefined || v === null) return null
    if (typeof v === 'string' && ASSET_FILE.test(v)) return v
    this.errors.push(`${path}: a file in the pack's folder, lowercase, ending .png, .webp, .jpg or .jpeg, got ${show(v)}`)
    return null
  }
}

// ---------------------------------------------------------------- contrast

/** WCAG 2 relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(i => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

/** The WCAG contrast ratio of two #rrggbb colours, from 1 (the same) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

/** The least contrast text and dim text need against both surfaces they sit on: WCAG AA for body text, and for large or secondary text. */
export const MIN_CONTRAST = { text: 4.5, dim: 3 } as const

/** Why a palette's text would be hard to read on its own plates, one line per pair; empty when it reads. */
export function contrastErrors(p: Pick<Palette, 'text' | 'dim' | 'plate' | 'panel'>): string[] {
  const out: string[] = []
  for (const fg of ['text', 'dim'] as const) {
    for (const bg of ['plate', 'panel'] as const) {
      const ratio = contrastRatio(p[fg], p[bg])
      if (ratio < MIN_CONTRAST[fg]) out.push(`palette.${fg}: ${p[fg]} on palette.${bg} ${p[bg]} has a contrast of ${ratio.toFixed(2)}:1; ${fg} needs at least ${MIN_CONTRAST[fg]}:1 against the plate and the panel`)
    }
  }
  return out
}

const kind = (v: unknown) => (Array.isArray(v) ? 'a list' : v === null ? 'null' : typeof v)
const show = (v: unknown) => {
  const s = JSON.stringify(v)
  return s === undefined ? kind(v) : s.length > 60 ? `${s.slice(0, 57)}...` : s
}

/**
 * A theme.json's contents as a Theme, defaults filled in, or every problem
 * with it. The shape is checked here, and that text and dim text read on the
 * plate and the panel (MIN_CONTRAST); whether the listed images exist and
 * are small enough is the bridge's business.
 */
export function parseTheme(raw: unknown): ThemeParse {
  const r = new Reader()
  const d = DEFAULT_THEME
  if (!isObj(raw)) return { ok: false, errors: [`theme.json: an object, got ${kind(raw)}`] }
  const top = r.section(raw, 'theme', ['schema', 'description', 'palette', 'typography', 'frame', 'core', 'motion', 'assets', 'text'])
  if (top.schema !== undefined && top.schema !== THEME_SCHEMA) r.errors.push(`schema: ${THEME_SCHEMA}, the only version there is, got ${show(top.schema)}`)
  if (top.description !== undefined && (typeof top.description !== 'string' || top.description.length > 400)) r.errors.push('description: text of at most 400 characters')

  const p = r.section(top.palette, 'palette', [...COLOUR_KEYS, 'glow', 'glowStrength'])
  const palette = { ...d.palette }
  for (const k of COLOUR_KEYS) palette[k] = r.colour(p[k], `palette.${k}`, d.palette[k])
  palette.glow = p.glow === null ? null : r.colour(p.glow, 'palette.glow', '') || null
  palette.glowStrength = r.number(p.glowStrength, 'palette.glowStrength', d.palette.glowStrength, 0, 2)
  // Measured only on colours that parsed: a bad one stands in as the default, and its error already says so.
  if ((['text', 'dim', 'plate', 'panel'] as const).every(k => p[k] === undefined || (typeof p[k] === 'string' && HEX.test(p[k])))) r.errors.push(...contrastErrors(palette))

  const ty = r.section(top.typography, 'typography', ['heading', 'label', 'body'])
  const role = (v: unknown, path: string, def: TextRole): TextRole => {
    const o = r.section(v, path, ['font', 'letterSpacing', 'case'])
    return { font: r.oneOf(o.font, `${path}.font`, FONTS, def.font), letterSpacing: r.number(o.letterSpacing, `${path}.letterSpacing`, def.letterSpacing, -0.05, 0.3), case: r.oneOf(o.case, `${path}.case`, CASES, def.case) }
  }
  const body = r.section(ty.body, 'typography.body', ['font'])
  const typography: Typography = {
    heading: role(ty.heading, 'typography.heading', d.typography.heading),
    label: role(ty.label, 'typography.label', d.typography.label),
    body: { font: r.oneOf(body.font, 'typography.body.font', FONTS, d.typography.body.font) },
  }

  const f = r.section(top.frame, 'frame', ['corner', 'weight', 'double', 'ticks', 'stream'])
  const frame: Frame = {
    corner: r.oneOf(f.corner, 'frame.corner', CORNERS, d.frame.corner),
    weight: r.number(f.weight, 'frame.weight', d.frame.weight, 0.5, 3),
    double: r.bool(f.double, 'frame.double', d.frame.double),
    ticks: r.bool(f.ticks, 'frame.ticks', d.frame.ticks),
    stream: r.bool(f.stream, 'frame.stream', d.frame.stream),
  }

  const c = r.section(top.core, 'core', ['renderer', 'under', 'keepRings'])
  const renderer = r.oneOf(c.renderer, 'core.renderer', RENDERERS, d.core.renderer)
  const under = c.under === undefined || c.under === null ? null : r.oneOf(c.under, 'core.under', RENDERERS.filter((x): x is BaseRenderer => x !== 'image'), 'rings')
  if (under !== null && renderer !== 'image') r.errors.push('core.under: only the image renderer draws over another one')
  const core: CoreStyle = { renderer, under, keepRings: r.bool(c.keepRings, 'core.keepRings', d.core.keepRings) }

  const m = r.section(top.motion, 'motion', ['ringSpeed', 'sweep', 'transition'])
  const motion: Motion = {
    ringSpeed: r.number(m.ringSpeed, 'motion.ringSpeed', d.motion.ringSpeed, 0, 4),
    sweep: r.oneOf(m.sweep, 'motion.sweep', SWEEPS, d.motion.sweep),
    transition: r.oneOf(m.transition, 'motion.transition', TRANSITIONS, d.motion.transition),
  }

  const a = r.section(top.assets, 'assets', ['core', 'emblem', 'panel', 'panelOpacity'])
  const assets: Assets = { core: r.file(a.core, 'assets.core'), emblem: r.file(a.emblem, 'assets.emblem'), panel: r.file(a.panel, 'assets.panel'), panelOpacity: r.number(a.panelOpacity, 'assets.panelOpacity', d.assets.panelOpacity, 0, 0.4) }
  if (renderer === 'image' && !assets.core) r.errors.push('core.renderer: "image" needs assets.core, the picture to show')

  const t = r.section(top.text, 'text', ['label', 'greeting'])
  const text: ThemeText = { label: r.text(t.label, 'text.label', 40), greeting: r.text(t.greeting, 'text.greeting', 120) }

  if (r.errors.length) return { ok: false, errors: r.errors }
  return { ok: true, theme: { palette, typography, frame, core, motion, assets, text } }
}

/** The files a theme lists, by role. */
export function assetFiles(t: Theme): string[] {
  return [t.assets.core, t.assets.emblem, t.assets.panel].filter((x): x is string => x !== null)
}

/** The pack a character uses when it names none: its own name, spaces as hyphens. Null when that is no pack name. */
export function packFor(characterName: string): string | null {
  const slug = characterName.trim().toLowerCase().replace(/\s+/g, '-')
  return PACK_NAME.test(slug) ? slug : null
}
