// The 2D page takes only a theme pack's palette: each colour the pack
// changes becomes the matching CSS custom property on the root, and the
// rest of the page keeps its own look. With no pack the page is exactly as
// it was, apart from the character's accent, which it always took.

import { useEffect, useState } from 'react'
import type { ThemeListing } from '../../../shared/theme.ts'
import { paletteCss } from '../instrument/themes/palette.ts'

export function useThemeCss(token: string, theme: string | null | undefined, accent: string | null): void {
  const [vars, setVars] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!theme) return setVars({})
    let live = true
    fetch('/api/themes', { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
      .then(async r => {
        if (!r.ok) throw new Error(`GET /api/themes: HTTP ${r.status}`)
        const l = (await r.json()) as ThemeListing
        const pack = l.themes.find(t => t.name === theme)
        if (!pack) console.error(`theme: pack ${theme} not usable: ${l.invalid.find(t => t.name === theme)?.error ?? 'no such pack'}`)
        if (live) setVars(pack ? paletteCss(pack.theme.palette) : {})
      })
      .catch((err: unknown) => {
        console.error('theme: could not read the theme packs for the page:', err)
        if (live) setVars({})
      })
    return () => {
      live = false
    }
  }, [token, theme])
  useEffect(() => {
    const root = document.documentElement
    const all = { ...vars }
    // The pack's accent wins over the character's, as in the immersive view (instrument/theme.ts).
    if (!all['--accent'] && accent) all['--accent'] = accent
    for (const [k, v] of Object.entries(all)) root.style.setProperty(k, v)
    return () => {
      for (const k of Object.keys(all)) root.style.removeProperty(k)
    }
  }, [vars, accent])
}
