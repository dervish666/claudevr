// The look: cyan for structure, amber for warnings, red for faults, purple
// for questions, neutral white body text. Fonts are MSDF atlases made from the
// bundled TTFs (scripts/make-fonts.mjs) and served by the bridge itself.

import type { SessionState } from '../../../shared/protocol.ts'

export const C = {
  cyan: '#38d8ff',
  cyanDim: '#1d6a80',
  cyanFaint: '#123a47',
  amber: '#ffb020',
  red: '#ff4d4d',
  purple: '#c084fc',
  green: '#4ade80',
  white: '#eef3f7',
  body: '#e4e8ec',
  muted: '#9aaab8',
  plate: '#0e1216',
  backing: '#000000',
} as const

/** uikit font families. Rajdhani for callsigns, labels and numbers; Inter for body text. */
export const FONTS = {
  inter: { normal: '/fonts/inter-400.json', 'semi-bold': '/fonts/inter-600.json' },
  rajdhani: { 'semi-bold': '/fonts/rajdhani-600.json', bold: '/fonts/rajdhani-700.json' },
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
