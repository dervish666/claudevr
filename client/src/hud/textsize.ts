// Text size for the 2D page. The sizes were set for a headset browser, so
// "large" (today's look) is the default on the Quest and everything else
// starts compact. The choice sits on <html data-text> and hud.css scales
// from there; instrument mode never sets it.

import { useCallback, useEffect, useState } from 'react'

export type TextSize = 'compact' | 'normal' | 'large'
export const TEXT_SIZES: readonly TextSize[] = ['compact', 'normal', 'large']
const KEY = 'claudevr.hud.textsize'

const isSize = (v: unknown): v is TextSize => TEXT_SIZES.includes(v as TextSize)

function fallback(): TextSize {
  return /OculusBrowser/.test(navigator.userAgent) ? 'large' : 'compact'
}

export function readTextSize(): TextSize {
  try {
    const v = localStorage.getItem(KEY)
    if (isSize(v)) return v
  } catch (err) {
    console.error('hud: cannot read the saved text size:', err)
  }
  return fallback()
}

function saveTextSize(s: TextSize): void {
  try {
    localStorage.setItem(KEY, s)
  } catch (err) {
    console.error('hud: cannot save the text size:', err)
  }
}

export function useTextSize(): [TextSize, (s: TextSize) => void] {
  const [size, setSize] = useState<TextSize>(readTextSize)
  useEffect(() => {
    document.documentElement.dataset.text = size
  }, [size])
  const set = useCallback((s: TextSize) => {
    saveTextSize(s)
    setSize(s)
  }, [])
  return [size, set]
}
