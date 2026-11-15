// The door to instrument mode, in the 2D bundle. Everything three.js lives
// in a separate chunk (../instrument/main.tsx) that this loads in the
// background once the HUD is up, so the 2D page's own bundle stays the size
// it was and the Enter press is ready when Sam reaches for it: an immersive
// session has to be requested inside the press, with no download in between.

import { useEffect, useState } from 'react'

export type InstrumentModule = typeof import('../instrument/main.tsx')

/** Set while an immersive session runs, so a reload that cuts one is noticed on the next load. */
export const IN_INSTRUMENT_KEY = 'claudevr.inInstrument'

let loading: Promise<InstrumentModule> | null = null
export function loadInstrument(): Promise<InstrumentModule> {
  loading ??= import('../instrument/main.tsx')
  return loading
}

export function useInstrumentModule(delayMs: number): { mod: InstrumentModule | null; error: string | null } {
  const [mod, setMod] = useState<InstrumentModule | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const t = setTimeout(() => {
      loadInstrument().then(
        m => live && setMod(m),
        (err: unknown) => {
          console.error('instrument: the 3D chunk failed to load:', err)
          // Let a later press try again rather than holding a failed promise.
          loading = null
          if (live) setError(err instanceof Error ? err.message : String(err))
        },
      )
    }, delayMs)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [delayMs])
  return { mod, error }
}

function readFlag(): boolean {
  try {
    return sessionStorage.getItem(IN_INSTRUMENT_KEY) === '1'
  } catch (err) {
    console.error('instrument: cannot read sessionStorage:', err)
    return false
  }
}

/** The big button on the 2D HUD. */
export function EnterInstrument({ mod, error, active, onEnter }: { mod: InstrumentModule | null; error: string | null; active: boolean; onEnter: () => void }) {
  const [cut] = useState(readFlag)
  const [support, setSupport] = useState<'checking' | 'yes' | 'no'>('checking')
  useEffect(() => {
    if (!mod) return
    let live = true
    void mod.arSupported().then(ok => live && setSupport(ok ? 'yes' : 'no'))
    return () => {
      live = false
    }
  }, [mod])
  const ready = !!mod && support === 'yes' && !active
  const note = error
    ? `INSTRUMENT: ${error}`
    : !mod
      ? 'Loading the 3D view…'
      : support === 'checking'
        ? 'Checking for immersive AR…'
        : support === 'no'
          ? 'This browser offers no immersive-ar session. Open the HUD in the Quest browser, or on localhost for the emulator.'
          : active
            ? 'In instrument mode.'
            : cut
              ? 'The page reloaded and ended the last session. One press goes back in.'
              : 'Immersive AR with passthrough. Exit from the settings panel, or press the Meta button.'
  return (
    <section className={`enter-instrument${cut && ready ? ' cut' : ''}${error ? ' failed' : ''}`} aria-label="Instrument mode">
      <button className="big enter-btn" disabled={!ready} onClick={onEnter}>
        {cut && ready ? 'Re-enter instrument' : 'Enter instrument'}
      </button>
      <span className="enter-note">{note}</span>
      <a className="enter-preview" href="/?instrument=preview">
        desktop preview
      </a>
    </section>
  )
}
