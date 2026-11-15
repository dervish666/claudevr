// Pairing this browser. By default the page shows a short code, the person
// types it on the Mac's approval page, and the next poll brings this device
// its own token. Typing a token by hand is kept behind a
// small link, for recovery.

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { checkToken, cleanToken, keepTicket, pollTicket, requestTicket, savedTicket, saveToken, type ShownTicket } from '../pairing.ts'
import { useNow } from './useBridge.ts'

const POLL_MS = 2000

export function Pairing({ onPaired, reason }: { onPaired: (t: string) => void; reason?: string }) {
  const [manual, setManual] = useState(false)
  return manual ? <TokenEntry onPaired={onPaired} reason={reason} onBack={() => setManual(false)} /> : <CodePairing onPaired={onPaired} reason={reason} onManual={() => setManual(true)} />
}

type View = { kind: 'asking' } | { kind: 'code'; ticket: ShownTicket; trouble: string | null } | { kind: 'expired' } | { kind: 'failed'; error: string }

function CodePairing({ onPaired, reason, onManual }: { onPaired: (t: string) => void; reason?: string; onManual: () => void }) {
  const [view, setView] = useState<View>(() => {
    const kept = savedTicket()
    return kept ? { kind: 'code', ticket: kept, trouble: null } : { kind: 'asking' }
  })
  const now = useNow(1000)
  const asking = useRef(false)
  const paired = useRef(onPaired)
  paired.current = onPaired

  const ask = async (replaces: ShownTicket | null) => {
    if (asking.current) return
    asking.current = true
    setView({ kind: 'asking' })
    const r = await requestTicket(replaces)
    asking.current = false
    if (r.ok) {
      keepTicket(r.ticket)
      setView({ kind: 'code', ticket: r.ticket, trouble: null })
    } else if (replaces && replaces.deadline > Date.now()) {
      // No new code (too many asked for, say), but the old one still works, so keep showing it.
      setView({ kind: 'code', ticket: replaces, trouble: `No new code: ${r.error}` })
    } else setView({ kind: 'failed', error: r.error })
  }

  // The first code, once; the ref keeps a development double render from asking twice.
  useEffect(() => {
    if (view.kind === 'asking' && !asking.current) void ask(null)
    // Only on mount: later asks come from the buttons.
  }, [])

  // While a code shows, ask every 2 s whether the Mac has approved it.
  const ticket = view.kind === 'code' ? view.ticket : null
  useEffect(() => {
    if (!ticket) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      const r = await pollTicket(ticket)
      if (!live) return
      if (r.state === 'approved') {
        keepTicket(null)
        saveToken(r.token)
        paired.current(r.token)
        return
      }
      if (r.state === 'gone') {
        keepTicket(null)
        setView({ kind: 'expired' })
        return
      }
      const trouble = r.state === 'error' ? `Cannot check with the bridge: ${r.error}` : null
      setView(v => (v.kind === 'code' && v.ticket === ticket && v.trouble !== trouble ? { ...v, trouble } : v))
      timer = setTimeout(() => void tick(), POLL_MS)
    }
    void tick()
    return () => {
      live = false
      if (timer) clearTimeout(timer)
    }
  }, [ticket])

  const alt = (
    <p className="muted pair-alt">
      <button className="link" onClick={onManual}>
        Enter a token instead
      </button>{' '}
      · <a href="/probe">Headset probe</a>
    </p>
  )
  const head = (
    <>
      <h1>Pair this device</h1>
      {reason && <div className="alarm">{reason}</div>}
    </>
  )

  if (view.kind === 'asking')
    return (
      <main className="pairing">
        {head}
        <p className="pair-lead">Asking the bridge for a code…</p>
        {alt}
      </main>
    )
  if (view.kind === 'failed' || view.kind === 'expired' || (view.kind === 'code' && view.ticket.deadline <= now))
    return (
      <main className="pairing">
        {head}
        {view.kind === 'failed' ? <div className="alarm">Could not get a code: {view.error}</div> : <p className="pair-lead">That code expired before it was entered on the Mac.</p>}
        <button className="big" onClick={() => void ask(null)}>
          New code
        </button>
        {alt}
      </main>
    )

  const t = view.ticket
  // Read the clock here, since the ticking `now` can be a second behind a code that just arrived.
  const left = Math.max(0, Math.floor((t.deadline - Date.now()) / 1000))
  return (
    <main className="pairing">
      {head}
      <p className="pair-lead">Enter this code on your Mac:</p>
      <div className="pair-code" aria-label={`Pairing code ${t.code.split('').join(' ')}`}>
        {t.code}
      </div>
      <p className="pair-where">
        at <strong>{t.approveUrl}</strong>
      </p>
      <p className="pair-expiry">
        expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} · waiting for the Mac
      </p>
      {view.trouble && <div className="alarm">{view.trouble}</div>}
      <button className="big" onClick={() => void ask(t)}>
        New code
      </button>
      {alt}
    </main>
  )
}

/** The old way, typing a token by hand, kept for recovery. */
function TokenEntry({ onPaired, reason, onBack }: { onPaired: (t: string) => void; reason?: string; onBack: () => void }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(reason ?? null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const t = cleanToken(value)
    setBusy(true)
    const r = await checkToken(t)
    setBusy(false)
    if (!r.ok) return setError(r.error)
    saveToken(t)
    onPaired(t)
  }
  return (
    <main className="pairing">
      <h1>Enter a token</h1>
      <p>For recovery: type the legacy token kept in the bridge's state folder (pairing-token). A pairing code is easier.</p>
      <form onSubmit={submit}>
        <input aria-label="Token" value={value} onChange={e => setValue(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} autoFocus />
        <button className="big" type="submit" disabled={busy || !value.trim()}>
          {busy ? 'Checking…' : 'Pair'}
        </button>
      </form>
      {error && <div className="alarm">{error}</div>}
      <p className="muted pair-alt">
        <button className="link" onClick={onBack}>
          Use a pairing code instead
        </button>
      </p>
    </main>
  )
}
