import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Fleet, Need, Session, SessionState } from '../../../shared/protocol.ts'
import { autoPair, checkToken, cleanToken, forgetToken, readToken, saveToken } from '../pairing.ts'
import { age, useBridge, useNow, type BridgeState } from './useBridge.ts'
import { Reader } from './Reader.tsx'
import { VoiceDock } from './Voice.tsx'
import { useVoice } from './voice/useVoice.ts'
import { ContextBadge, LimitsStrip } from './Usage.tsx'
import { TEXT_SIZES, useTextSize, type TextSize } from './textsize.ts'
import { EnterInstrument, isDemoTile, useInstrumentModule } from './InstrumentEntry.tsx'

/** No word from the bridge for this long and the HUD calls its data stale. */
const STALE_MS = 10_000
/** The 3D chunk loads this long after the HUD is up, so it never competes with the HUD's first paint. */
const INSTRUMENT_PRELOAD_MS = 1500
const PREVIEW = new URLSearchParams(location.search).get('instrument') === 'preview'
const XR_SEL_KEY = 'claudevr.instrument.selected'

function readSel(): string | null {
  try {
    return localStorage.getItem(XR_SEL_KEY)
  } catch (err) {
    console.error('instrument: cannot read the saved selection:', err)
    return null
  }
}
function saveSel(id: string | null): void {
  try {
    if (id) localStorage.setItem(XR_SEL_KEY, id)
    else localStorage.removeItem(XR_SEL_KEY)
  } catch (err) {
    console.error('instrument: cannot save the selection:', err)
  }
}

export function App() {
  const [token, setToken] = useState<string | null>(() => readToken())
  // With no stored token, ask the bridge for one before asking the person.
  // Tried once: after "unpair" the form shows instead of pairing straight back.
  const [asked, setAsked] = useState(false)
  useEffect(() => {
    if (token || asked) return
    let live = true
    void autoPair().then(t => {
      if (!live) return
      if (t) setToken(t)
      setAsked(true)
    })
    return () => {
      live = false
    }
  }, [token, asked])
  if (!token && !asked)
    return (
      <main className="pairing">
        <h1>Pairing…</h1>
      </main>
    )
  if (!token) return <Pairing onPaired={t => setToken(t)} />
  return (
    <Hud
      token={token}
      onUnpair={() => {
        forgetToken()
        setToken(null)
      }}
    />
  )
}

function Pairing({ onPaired, reason }: { onPaired: (t: string) => void; reason?: string }) {
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
      <h1>Pair this headset</h1>
      <p>Type the pairing token the bridge printed in its terminal. You only do this once per browser.</p>
      <form onSubmit={submit}>
        <input aria-label="Pairing token" value={value} onChange={e => setValue(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} autoFocus />
        <button className="big" type="submit" disabled={busy || !value.trim()}>
          {busy ? 'Checking…' : 'Pair'}
        </button>
      </form>
      {error && <div className="alarm">{error}</div>}
      <p className="muted">
        <a href="/probe">Headset probe</a>
      </p>
    </main>
  )
}

function Hud({ token, onUnpair }: { token: string; onUnpair: () => void }) {
  const bridge = useBridge(token)
  const [textSize, setTextSize] = useTextSize()
  const now = useNow()
  const [selected, setSelected] = useState<string | null>(null)
  // The session open in the reader, filling the window. Null shows the fleet.
  const [open, setOpen] = useState<string | null>(null)
  const fleet = bridge.fleet
  const pick = (id: string) => {
    setSelected(id)
    setOpen(id)
  }
  const immersive = useRef(false)
  const openId = open && fleet?.sessions.some(s => s.id === open) ? open : null

  // Instrument mode keeps its own selection (a tile, or null for the
  // dispatcher). While it is on, voice targets that instead of the reader.
  const instrument = useInstrumentModule(PREVIEW ? 0 : INSTRUMENT_PRELOAD_MS)
  const [xrActive, setXrActive] = useState(false)
  const [xrSel, setXrSelState] = useState<string | null>(readSel)
  const setXrSel = (id: string | null) => {
    setXrSelState(id)
    saveSel(id)
  }
  const [enterError, setEnterError] = useState<string | null>(null)
  const instrumentOn = xrActive || PREVIEW
  const xrFocus = xrSel && fleet?.sessions.some(s => s.id === xrSel) ? xrSel : null
  // A demo tile has nothing behind it: speech that would go to the selection
  // or fall through to the dispatcher is refused while one is selected.
  const refuseSend = useRef<((m: { sessionId: string; viaDispatcher: boolean; viaFocus: boolean }) => string | null) | null>(null)
  refuseSend.current = instrumentOn && isDemoTile(xrSel) ? m => (m.viaDispatcher || m.viaFocus ? 'A demo tile is selected, and demo tiles never send. Nothing was sent. Pick a real tile, or press the iris for the dispatcher.' : null) : null
  const voice = useVoice({
    token,
    voice: bridge.voice,
    focusId: instrumentOn ? xrFocus : openId,
    onSelect: instrumentOn ? setXrSel : pick,
    onHome: instrumentOn ? () => setXrSel(null) : () => setOpen(null),
    immersive,
    refuseSend,
    announce: bridge.announce,
    post: bridge.post,
  })

  // A character's accent colours the page while it is selected; operator mode keeps the theme's own.
  const accent = voice.character?.accent ?? null
  useEffect(() => {
    const root = document.documentElement
    if (accent) root.style.setProperty('--accent', accent)
    else root.style.removeProperty('--accent')
  }, [accent])

  useEffect(() => {
    if (!fleet) return
    if (!selected || !fleet.sessions.some(s => s.id === selected)) {
      const first = fleet.sessions.find(s => s.state === 'asking') ?? fleet.sessions.find(s => s.state === 'working') ?? fleet.sessions[0]
      setSelected(first?.id ?? null)
    }
  }, [fleet, selected])

  // A refused token usually means the bridge made a new one. Fetch it and
  // reload; if the bridge hands back the same token, the form below stays.
  const refused = bridge.link === 'unauthorized'
  useEffect(() => {
    if (!refused) return
    void autoPair().then(t => {
      if (t && t !== token) location.reload()
    })
  }, [refused, token])

  if (refused) return <Pairing onPaired={() => location.reload()} reason={`The bridge refused this browser's token (${bridge.linkError}). Pair again.`} />

  const alarms = alarmsOf(bridge, now)
  const stale = alarms.length > 0
  const mod = instrument.mod
  const instrumentProps = { token, bridge, voice, alarms, selected: xrSel, onSelect: setXrSel, immersive, onSessionChange: setXrActive }

  if (PREVIEW)
    return mod ? (
      <mod.Instrument mode="preview" {...instrumentProps} />
    ) : (
      <div className="empty-big">{instrument.error ? `INSTRUMENT PREVIEW FAILED TO LOAD: ${instrument.error}` : 'Loading the instrument preview…'}</div>
    )
  const focus = fleet?.sessions.find(s => s.id === selected) ?? null
  const reading = open ? (fleet?.sessions.find(s => s.id === open) ?? null) : null

  return (
    <div className={`hud${stale ? ' is-stale' : ''}`}>
      {alarms.map(a => (
        <div key={a} className="alarm" role="alert">
          {a}
        </div>
      ))}
      <EnterInstrument
        mod={mod}
        error={instrument.error ? `the 3D chunk failed to load: ${instrument.error}` : enterError}
        active={xrActive}
        onEnter={() => {
          if (!mod) return
          setEnterError(null)
          mod.enterInstrument(voice).catch((err: unknown) => setEnterError(`could not start the session: ${err instanceof Error ? err.message : String(err)}`))
        }}
      />
      {mod && <mod.Instrument mode="xr" {...instrumentProps} />}
      {fleet && <LimitsStrip usage={fleet.usage} now={now} extra={<TextSizePicker value={textSize} onPick={setTextSize} />} />}
      {!fleet ? (
        <div className="empty-big">{bridge.link !== 'open' ? 'No fleet data yet.' : bridge.status && !bridge.status.ok ? 'No fleet: the backend has not been read yet.' : 'Connected. Waiting for the first read of the fleet…'}</div>
      ) : reading ? (
        <Reader key={reading.id} s={reading} token={token} now={now} stateWord={STATE_WORDS[reading.state]} waiting={fleet.needs.length} onClose={() => setOpen(null)} />
      ) : (
        <>
          <NeedsQueue needs={fleet.needs} now={now} onPick={id => id && pick(id)} />
          {fleet.warnings.length > 0 && (
            <ul className="warnings">
              {fleet.warnings.map(w => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <div className="main">
            <section className="fleet" aria-label="Fleet">
              <h2>
                Fleet <span className="count">{fleet.sessions.length}</span>
              </h2>
              {fleet.sessions.length === 0 ? (
                <div className="empty">The backend reports no live sessions.</div>
              ) : (
                <div className="cards">
                  {fleet.sessions.map(s => (
                    <Card key={s.id} s={s} now={now} selected={s.id === selected} onPick={() => pick(s.id)} />
                  ))}
                </div>
              )}
            </section>
            <Focus s={focus} now={now} />
          </div>
          <div className="lower">
            <LedgerPanel fleet={fleet} now={now} />
          </div>
        </>
      )}
      <VoiceDock v={voice} fleet={fleet} now={now} focusId={reading?.id ?? null} />
      <footer className="foot">
        <span>
          {bridge.status ? `backend: ${bridge.status.name}` : 'backend: ?'} · {fleet ? `read ${age(fleet.at, now)} ago` : 'never read'}
          {bridge.build?.id ? ` · build ${bridge.build.id.slice(0, 7)}${bridge.build.reload ? ' (dev, reloads itself)' : ''}` : ''}
        </span>
        <a href="/probe">probe</a>
        <button className="link" onClick={onUnpair}>
          unpair
        </button>
      </footer>
    </div>
  )
}

const SIZE_LABEL: Record<TextSize, string> = { compact: 'S', normal: 'M', large: 'L' }

function TextSizePicker({ value, onPick }: { value: TextSize; onPick: (s: TextSize) => void }) {
  return (
    <div className="lim textsize">
      <span className="lim-label">TEXT</span>
      <span className="textsize-btns">
        {TEXT_SIZES.map(s => (
          <button key={s} aria-pressed={s === value} title={`${s} text`} onClick={() => onPick(s)}>
            {SIZE_LABEL[s]}
          </button>
        ))}
      </span>
    </div>
  )
}

function alarmsOf(b: BridgeState, now: number): string[] {
  const out: string[] = []
  if (b.link === 'down') out.push(`BRIDGE UNREACHABLE for ${age(b.downSince, now)}${b.linkError ? `: ${b.linkError.replace(/^bridge unreachable: /, '')}` : ''}. Showing the last fleet seen${b.fleet ? `, ${age(b.fleet.at, now)} old` : ''}.`)
  else if (b.link === 'connecting' && b.fleet) out.push('RECONNECTING to the bridge. The fleet below may be out of date.')
  else if (b.link === 'open' && b.heardAt && now - b.heardAt > STALE_MS) out.push(`NO WORD FROM THE BRIDGE for ${age(b.heardAt, now)}.`)
  if (b.status && !b.status.ok) out.push(`BACKEND UNREACHABLE (${b.status.name}): ${b.status.error ?? 'unknown error'}. ${b.status.lastOkAt ? `Last good read ${age(b.status.lastOkAt, now)} ago.` : 'No good read yet.'}`)
  return out
}

const NEED_WORDS: Record<Need['kind'], string> = { question: 'QUESTION', approval: 'APPROVAL', 'needs-sam': 'NEEDS YOU', failed: 'FAILED' }

function NeedsQueue({ needs, now, onPick }: { needs: Need[]; now: number; onPick: (sessionId: string | null) => void }) {
  return (
    <section className={`needs${needs.length ? ' has' : ''}`} aria-label="Needs you">
      <h2>
        Needs you <span className="count">{needs.length}</span>
      </h2>
      {needs.length === 0 ? (
        <div className="empty">Nothing is waiting on you.</div>
      ) : (
        <ul>
          {needs.map(n => (
            <li key={n.id}>
              <button className={`need k-${n.kind}`} onClick={() => onPick(n.sessionId)} disabled={!n.sessionId}>
                <span className="need-kind">{NEED_WORDS[n.kind]}</span>
                <span className="need-who">{n.callsign ?? n.label}</span>
                <span className="need-age">{n.since === null ? 'age ?' : age(n.since, now)}</span>
                <span className="need-text">{n.text}</span>
                {n.options.length > 0 && <span className="need-options">{n.options.join('  /  ')}</span>}
                {n.callsign && n.label !== n.callsign && <span className="need-label">{n.label}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const STATE_WORDS: Record<SessionState, string> = { working: 'WORKING', thinking: 'THINKING', asking: 'ASKING', idle: 'IDLE', failed: 'FAILED', done: 'DONE', unknown: 'UNKNOWN' }

function Card({ s, now, selected, onPick }: { s: Session; now: number; selected: boolean; onPick: () => void }) {
  return (
    <button className={`card st-${s.state}${selected ? ' selected' : ''}`} onClick={onPick} aria-pressed={selected}>
      <span className="card-top">
        <span className="callsign">{s.callsign}</span>
        <span className="state">{STATE_WORDS[s.state]}</span>
      </span>
      <ContextBadge c={s.context} />
      <span className="card-title">
        {s.title} · {age(s.activeAt, now)}
      </span>
      {s.action && <span className="action">{s.action}</span>}
      {s.asking && <span className="asking">{s.asking.text}</span>}
      <span className="last">{s.lastLine ?? 'Nothing said yet.'}</span>
      <span className="card-open">Open to read ›</span>
    </button>
  )
}

function Focus({ s, now }: { s: Session | null; now: number }) {
  if (!s) return <section className="focus empty">Pick a session.</section>
  return (
    <section className="focus" aria-label={`Focus: ${s.callsign}`}>
      <h2>
        {s.callsign} <span className="muted">{STATE_WORDS[s.state].toLowerCase()}</span>
      </h2>
      <div className="focus-meta">
        {s.title}
        {s.project ? ` · ${s.project}` : ''} · {s.kind}
        {s.canSend ? '' : ' · no send route'}
      </div>
      {s.asking && (
        <div className="focus-ask">
          <div>{s.asking.text}</div>
          {s.asking.options.length > 0 && (
            <ul>
              {s.asking.options.map(o => (
                <li key={o}>{o}</li>
              ))}
            </ul>
          )}
          {s.asking.answerAt && <div className="muted">Answer in T3.</div>}
        </div>
      )}
      {s.messages.length === 0 ? (
        <div className="empty">Nothing said yet.</div>
      ) : (
        <ol className="messages">
          {s.messages.map((m, i) => (
            <li key={`${m.at}-${i}`}>
              <span className="msg-age">{age(m.at, now)}</span>
              {m.text}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function LedgerPanel({ fleet, now }: { fleet: Fleet; now: number }) {
  const l = fleet.ledger
  return (
    <section className="ledger" aria-label="Dispatcher ledger">
      <h2>
        Dispatcher ledger {l?.changedAt ? <span className="muted">changed {age(l.changedAt, now)} ago</span> : null}
      </h2>
      {!l ? (
        <div className="empty">This backend has no ledger.</div>
      ) : !l.ok ? (
        <div className="alarm">LEDGER UNREADABLE: {l.error}</div>
      ) : l.rows.length === 0 ? (
        <div className="empty">No open tasks.</div>
      ) : (
        <table>
          <tbody>
            {l.rows.map(r => (
              <tr key={r.task} className={r.verdict ? `v-${r.verdict.replace(' ', '-').toLowerCase()}` : ''}>
                <th>{r.task}</th>
                <td>{r.repo}</td>
                <td>{r.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {l && l.closed.length > 0 && <div className="closed">Closed: {l.closed.length}</div>}
    </section>
  )
}
