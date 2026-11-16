import { useEffect, useRef, useState } from 'react'
import type { Fleet, Need, Session, SessionState } from '../../../shared/protocol.ts'
import { forgetToken, readToken, unpair } from '../pairing.ts'
import { alarmLine, alarmsOf } from './alarms.ts'
import { VoiceFocus } from './focus.ts'
import { Pairing } from './Pairing.tsx'
import { age, useBridge, useNow } from './useBridge.ts'
import { Reader } from './Reader.tsx'
import { VoiceDock } from './Voice.tsx'
import { useVoice } from './voice/useVoice.ts'
import { ContextBadge, LimitsStrip } from './Usage.tsx'
import { AGENT_WORDS, runTime, shownAgents } from '../../../shared/agents.ts'
import { TEXT_SIZES, useTextSize, type TextSize } from './textsize.ts'
import { EnterInstrument, useInstrumentModule } from './InstrumentEntry.tsx'
import { useThemeCss } from './themeCss.ts'

/** How long the unpair link waits for its second press, as the Revoke button on /pair does. */
const UNPAIR_CONFIRM_MS = 4000
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
  // Why the token may still work after an unpair, shown on the pairing screen that follows.
  const [unpairNote, setUnpairNote] = useState<string | null>(null)
  if (!token) return <Pairing onPaired={t => setToken(t)} reason={unpairNote ?? undefined} />
  return (
    <Hud
      token={token}
      onUnpair={async () => {
        const r = await unpair(token)
        // Forgotten here whatever the bridge said: he asked for this browser to stop using it.
        forgetToken()
        setUnpairNote(r.revoked ? null : `Unpaired here, but the bridge did not revoke the token, so it may still work: ${r.reason}`)
        setToken(null)
      }}
    />
  )
}

function Hud({ token, onUnpair }: { token: string; onUnpair: () => Promise<void> }) {
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
  // Voice keeps a selection whose session has gone, so the bridge refuses
  // words meant for it instead of handing them to the dispatcher (focus.ts).
  const voiceFocus = useRef(new VoiceFocus()).current
  const fleetIds = fleet ? fleet.sessions.map(s => s.id) : null
  const voice = useVoice({
    token,
    voice: bridge.voice,
    focusId: voiceFocus.focus(instrumentOn ? xrSel : open, fleetIds),
    onSelect: instrumentOn ? setXrSel : pick,
    onHome: instrumentOn ? () => setXrSel(null) : () => setOpen(null),
    immersive,
    announce: bridge.announce,
    post: bridge.post,
  })

  // A character's accent colours the page while it is selected, and its theme pack's palette (if it has one)
  // replaces the page's colours; operator mode keeps the page's own.
  useThemeCss(token, voice.character?.theme, voice.character?.accent ?? null)

  useEffect(() => {
    if (!fleet) return
    if (!selected || !fleet.sessions.some(s => s.id === selected)) {
      const first = fleet.sessions.find(s => s.state === 'asking') ?? fleet.sessions.find(s => s.state === 'working') ?? fleet.sessions[0]
      setSelected(first?.id ?? null)
    }
  }, [fleet, selected])

  // A refused token was revoked: pair again with a code.
  // Not while he is unpairing: the revoke closes this page's socket before the answer lands.
  const [unpairing, setUnpairing] = useState(false)
  const refused = bridge.link === 'unauthorized' && !unpairing

  if (refused) return <Pairing onPaired={() => location.reload()} reason={`The bridge refused this browser's token (${bridge.linkError}). Pair again.`} />

  const alarms = alarmsOf(bridge, now)
  const stale = alarms.length > 0
  const mod = instrument.mod
  const instrumentProps = { token, bridge, voice, alarms: alarms.map(alarmLine), selected: xrSel, onSelect: setXrSel, immersive, onSessionChange: setXrActive }

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
      {/* Keyed by kind, and only what is wrong is in the alert: the ticking age beside it is not read out again every second. */}
      {alarms.map(a => (
        <div key={a.kind} className="alarm">
          <span role="alert">{a.text}</span>
          {a.age && <span className="alarm-age"> {a.age}</span>}
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
        <Reader key={reading.id} s={reading} token={token} now={now} stateWord={STATE_WORDS[reading.state]} waiting={fleet.needs.length} onClose={() => setOpen(null)} character={voice.character} conversation={bridge.conversation} />
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
        <UnpairButton
          onUnpair={() => {
            // A card must not send while the bridge is asked, or after.
            voice.cancel('Unpairing. Nothing sent.')
            setUnpairing(true)
            return onUnpair()
          }}
        />
      </footer>
    </div>
  )
}

/** Two presses within 4 s, so one slip of the ray does not unpair the headset. */
function UnpairButton({ onUnpair }: { onUnpair: () => Promise<void> }) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), UNPAIR_CONFIRM_MS)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <button
      className={`link${armed ? ' unpair-armed' : ''}`}
      disabled={busy}
      onClick={() => {
        if (!armed) return setArmed(true)
        setBusy(true)
        void onUnpair()
      }}
    >
      {busy ? 'Unpairing…' : armed ? 'Unpair? Press again' : 'unpair'}
    </button>
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
      <SubAgents s={s} now={now} />
      <span className="card-open">Open to read ›</span>
    </button>
  )
}

/** The session's sub-agents, one compact row each: running ones, and finished ones for a couple of minutes. Read only. */
function SubAgents({ s, now }: { s: Session; now: number }) {
  const { agents, hiddenRunning } = shownAgents(s, now)
  if (!agents.length && !hiddenRunning) return null
  return (
    <span className="subagents" role="list" aria-label="Sub-agents">
      {agents.map(a => (
        <span key={a.id} role="listitem" className={`subagent ${a.state}`}>
          <span className="sa-type">{a.type}</span>
          <span className="sa-desc">{a.description}</span>
          <span className="sa-state">
            {AGENT_WORDS[a.state]}
            {runTime(a, now) ? ` · ${runTime(a, now)}` : ''}
          </span>
          {a.state === 'running' && a.now && <span className="sa-now">{a.now}</span>}
        </span>
      ))}
      {hiddenRunning > 0 && <span className="subagents-more">+{hiddenRunning} more running</span>}
    </span>
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
