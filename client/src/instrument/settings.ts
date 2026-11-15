// The spike's toggles, set from the controls panel in the scene. React reads
// them with useSettings (a change re-renders, which is rare); frame loops read
// `settings.current` without re-rendering. Kept in localStorage so a reload
// comes back with the same comparison set up.

import { useSyncExternalStore } from 'react'

export interface Settings {
  /** Where the Stream is drawn: a cylinder compositor layer, or a plain uikit mesh panel. */
  stream: 'layer' | 'mesh'
  glow: boolean
  /** Room dimmer: the black sphere's opacity. */
  dimmer: 0 | 0.3 | 0.5
  rotation: boolean
  /** Opacity of the smoked plates behind body text. */
  plate: 0.92 | 0.7
  /** The settings panel folded down to a strip, out of the way. */
  minimised: boolean
}

const KEY = 'claudevr.instrument.settings'
const DEFAULTS: Settings = { stream: 'layer', glow: true, dimmer: 0.3, rotation: true, plate: 0.92, minimised: false }

function read(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    const v = JSON.parse(raw) as Partial<Settings>
    return {
      stream: v.stream === 'mesh' ? 'mesh' : 'layer',
      glow: v.glow !== false,
      dimmer: v.dimmer === 0 || v.dimmer === 0.5 ? v.dimmer : 0.3,
      rotation: v.rotation !== false,
      plate: v.plate === 0.7 ? 0.7 : 0.92,
      minimised: v.minimised === true,
    }
  } catch (err) {
    console.error('instrument: cannot read the saved toggles, using defaults:', err)
    return DEFAULTS
  }
}

export const settings: { current: Settings } = { current: read() }
const listeners = new Set<() => void>()

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  settings.current = { ...settings.current, [key]: value }
  try {
    localStorage.setItem(KEY, JSON.stringify(settings.current))
  } catch (err) {
    console.error('instrument: cannot keep the toggles:', err)
  }
  for (const l of listeners) l()
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    l => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => settings.current,
  )
}
