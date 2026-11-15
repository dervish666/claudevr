// A theme's eleven palette colours spread over the forty-odd colours the
// scene really draws with: the dark plate behind each kind of panel, the
// dim and faint steps of the structure colour, the hot white of a working
// bar. Plain numbers, no three.js, so the bridge's test runner can check it.
//
// Each derived colour is today's literal while the palette colours it is
// made from are the defaults, and a formula of them otherwise. So the
// default palette gives exactly what the scene drew before themes, and a
// pack that changes only its accent leaves the plates alone.

import { DEFAULT_THEME, type Palette } from '../../../../shared/theme.ts'

export type RGB = readonly [number, number, number]

export type PlateRole = 'stream' | 'tile' | 'tileSel' | 'hover' | 'readout' | 'card' | 'button' | 'buttonHover' | 'rail' | 'railSel' | 'railHover' | 'toggleOn' | 'which' | 'alarm' | 'error'

export interface Colours {
  cyan: string
  cyanDim: string
  cyanFaint: string
  amber: string
  red: string
  purple: string
  green: string
  white: string
  body: string
  muted: string
  plate: string
  backing: string
}

export interface Tints {
  /** A working tile's sliding bar. */
  workBar: string
  /** A tile's brackets while its reply card is up. */
  lit: string
  /** Code block text. */
  code: string
  /** The voice arc while the mic is open, and its loudest cells. */
  mic: string
  micHot: string
  alarmText: string
  /** The iris's smoked disc, and the same while recording. */
  pupil: string
  pupilRec: string
}

export interface Roles {
  c: Colours
  plates: Record<PlateRole, RGB>
  x: Tints
}

/** What the scene drew with before themes. */
export const TODAY: Roles = {
  c: { cyan: '#38d8ff', cyanDim: '#1d6a80', cyanFaint: '#123a47', amber: '#ffb020', red: '#ff4d4d', purple: '#c084fc', green: '#4ade80', white: '#eef3f7', body: '#e4e8ec', muted: '#9aaab8', plate: '#0e1216', backing: '#000000' },
  plates: {
    stream: [14, 18, 22],
    tile: [10, 14, 17],
    tileSel: [18, 34, 42],
    hover: [24, 44, 54],
    readout: [5, 8, 10],
    card: [6, 9, 11],
    button: [8, 12, 15],
    buttonHover: [30, 45, 55],
    rail: [8, 10, 14],
    railSel: [28, 20, 40],
    railHover: [30, 30, 48],
    toggleOn: [20, 70, 90],
    which: [10, 8, 16],
    alarm: [40, 6, 6],
    error: [40, 8, 8],
  },
  x: { workBar: '#d8f8ff', lit: '#e8fbff', code: '#cfe6ee', mic: '#ff7a7a', micHot: '#ffe1e1', alarmText: '#ffe1e1', pupil: '#06090b', pupilRec: '#2a0a0e' },
}

export const toRgb = (hex: string): RGB => {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const byte = (v: number) => Math.round(Math.max(0, Math.min(255, v)))
export const toHex = (c: RGB): string => `#${c.map(v => byte(v).toString(16).padStart(2, '0')).join('')}`
const mix = (a: RGB, b: RGB, t: number): RGB => [byte(a[0] + (b[0] - a[0]) * t), byte(a[1] + (b[1] - a[1]) * t), byte(a[2] + (b[2] - a[2]) * t)]
const scale = (a: RGB, k: number): RGB => [byte(a[0] * k), byte(a[1] * k), byte(a[2] * k)]
const WHITE: RGB = [255, 255, 255]
const BLACK: RGB = [0, 0, 0]

type Key = keyof Omit<Palette, 'glow' | 'glowStrength'>

/** The scene's colours for a palette. */
export function rolesFor(p: Palette): Roles {
  const d = DEFAULT_THEME.palette
  const same = (...ks: Key[]) => ks.every(k => p[k] === d[k])
  const rgb = (k: Key) => toRgb(p[k])
  // Today's literal while every colour it depends on is unchanged, else the formula.
  const plate = (role: PlateRole, deps: Key[], f: () => RGB): RGB => (same(...deps) ? TODAY.plates[role] : f())
  const hex = (today: string, deps: Key[], f: () => RGB): string => (same(...deps) ? today : toHex(f()))
  const P = () => rgb('panel')
  const A = () => rgb('accent')
  const A2 = () => rgb('accent2')
  const B = () => rgb('bad')
  const t = TODAY
  return {
    c: {
      cyan: p.accent,
      cyanDim: p.line,
      cyanFaint: hex(t.c.cyanFaint, ['line'], () => scale(rgb('line'), 0.57)),
      amber: p.warn,
      red: p.bad,
      purple: p.accent2,
      green: p.ok,
      white: p.text,
      body: hex(t.c.body, ['text'], () => scale(rgb('text'), 0.955)),
      muted: p.dim,
      plate: p.plate,
      backing: t.c.backing,
    },
    plates: {
      stream: plate('stream', ['plate'], () => rgb('plate')),
      tile: plate('tile', ['panel'], P),
      tileSel: plate('tileSel', ['panel', 'accent'], () => mix(P(), A(), 0.1)),
      hover: plate('hover', ['panel', 'accent'], () => mix(P(), A(), 0.16)),
      readout: plate('readout', ['panel'], () => scale(P(), 0.5)),
      card: plate('card', ['panel'], () => scale(P(), 0.62)),
      button: plate('button', ['panel'], () => scale(P(), 0.82)),
      buttonHover: plate('buttonHover', ['panel', 'accent'], () => mix(P(), A(), 0.14)),
      rail: plate('rail', ['panel'], () => scale(P(), 0.8)),
      railSel: plate('railSel', ['panel', 'accent2'], () => mix(P(), A2(), 0.12)),
      railHover: plate('railHover', ['panel', 'accent2'], () => mix(P(), A2(), 0.16)),
      toggleOn: plate('toggleOn', ['panel', 'accent'], () => mix(P(), A(), 0.3)),
      which: plate('which', ['panel', 'accent2'], () => mix(scale(P(), 0.6), A2(), 0.04)),
      alarm: plate('alarm', ['bad'], () => mix(BLACK, B(), 0.16)),
      error: plate('error', ['bad'], () => mix(BLACK, B(), 0.16)),
    },
    x: {
      workBar: hex(t.x.workBar, ['accent'], () => mix(WHITE, A(), 0.15)),
      lit: hex(t.x.lit, ['accent'], () => mix(WHITE, A(), 0.08)),
      code: hex(t.x.code, ['text', 'accent'], () => mix(rgb('text'), A(), 0.15)),
      mic: hex(t.x.mic, ['bad'], () => mix(B(), WHITE, 0.3)),
      micHot: hex(t.x.micHot, ['bad'], () => mix(B(), WHITE, 0.85)),
      alarmText: hex(t.x.alarmText, ['bad'], () => mix(B(), WHITE, 0.85)),
      pupil: hex(t.x.pupil, ['panel'], () => scale(P(), 0.6)),
      pupilRec: hex(t.x.pupilRec, ['bad'], () => mix(BLACK, B(), 0.16)),
    },
  }
}

/** The 2D page's CSS custom properties for a palette: only those it changes from the default, so the page keeps its own look elsewhere. */
export function paletteCss(p: Palette): Record<string, string> {
  const d = DEFAULT_THEME.palette
  const map: [Key, string][] = [
    ['plate', '--bg'],
    ['panel', '--panel'],
    ['line', '--line'],
    ['text', '--text'],
    ['dim', '--muted'],
    ['accent', '--accent'],
    ['accent2', '--ask'],
    ['warn', '--warn'],
    ['bad', '--bad'],
    ['ok', '--ok'],
  ]
  const out: Record<string, string> = {}
  for (const [k, v] of map) if (p[k] !== d[k]) out[v] = p[k]
  // The raised panel follows the panel, a step lighter, as the page's own pair does.
  if (p.panel !== d.panel) out['--panel-2'] = toHex(mix(toRgb(p.panel), toRgb(p.line), 0.18))
  return out
}
