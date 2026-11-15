// uikit's Image under a name of its own, and uikit's Text with the theme's
// letter spacing and case applied to headings
// (Rajdhani bold) and labels (Rajdhani semi-bold). Body text passes straight
// through. The theme is read when the Text renders; a theme change rebuilds
// the part of the scene it is in (themes/parts.ts), so this never changes a
// string inside a live root on its own.

import { useMemo, type ComponentProps } from 'react'
import { Text as UikitText, VanillaImage, build, type ImageProperties } from '@react-three/uikit'
import { computed, type ReadonlySignal } from '@preact/signals-core'
import type { TextCase, TextRole } from '../../../shared/theme.ts'
import { T } from './theme.ts'

type TextProps = ComponentProps<typeof UikitText>

/**
 * uikit registers each component with three-fiber under its class's name,
 * and a minified build gives several classes the same one-letter name:
 * with uikit's own Image in the bundle, every Container came out an Image
 * ("the image component can not have any children"). Built here under an
 * explicit name, it cannot collide.
 */
export const Image = build<VanillaImage, ImageProperties>(VanillaImage as unknown as { new (): VanillaImage }, 'ThemeImage')

export function cased(s: string, c: TextCase): string {
  if (c === 'upper') return s.toUpperCase()
  if (c === 'lower') return s.toLowerCase()
  if (c === 'title') return s.toLowerCase().replace(/(^|[\s(/·-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase())
  return s
}

const isSignal = (v: unknown): v is ReadonlySignal<unknown> => typeof v === 'object' && v !== null && 'value' in v && 'peek' in v

/**
 * Every heading and label was sized for Rajdhani, a condensed face. Inter's
 * capitals average 0.66 em against Rajdhani's 0.52, lower case 0.54 against
 * 0.46 (measured from the atlases), so a role set in Inter steps down by that
 * ratio and keeps the width its tile, button or pill was laid out for.
 */
const INTER_SCALE = { upper: 0.79, other: 0.85 }

export function Text(p: TextProps) {
  const role: TextRole | null = p.fontFamily === 'rajdhani' ? (p.fontWeight === 'bold' ? T.theme.typography.heading : T.theme.typography.label) : null
  const how = role && role.case !== 'as-is' ? role.case : null
  const child = p.children
  // A signal child (a clock, a countdown) is cased as it changes, without a render.
  const casedSignal = useMemo(() => (how && isSignal(child) ? computed(() => cased(String(child.value), how)) : null), [how, child])
  const swapped = role?.font === 'inter' && typeof p.fontSize === 'number'
  if (!role || (role.letterSpacing === 0 && !how && !swapped)) return <UikitText {...p} />
  const asked = typeof p.fontSize === 'number' ? p.fontSize : 16
  const size = swapped ? asked * (how === 'upper' ? INTER_SCALE.upper : INTER_SCALE.other) : asked
  const children = !how ? child : casedSignal ?? (typeof child === 'string' ? cased(child, how) : Array.isArray(child) ? child.map(c => (typeof c === 'string' ? cased(c, how) : c)) : child)
  return (
    <UikitText {...p} fontSize={swapped ? size : p.fontSize} letterSpacing={role.letterSpacing * size}>
      {children}
    </UikitText>
  )
}
