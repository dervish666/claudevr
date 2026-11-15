// The reader: one session filling the window, its replies in full and large.
// Opened by tapping a card, a needs-you item, or by voice ("switch to X").
// The fleet's own messages are short clips; the full turns come from
// GET /api/transcript, re-read while the reader is open (transcript.ts, shared
// with the instrument Stream).

import { useMemo, type ReactNode } from 'react'
import type { CharacterInfo, Conversation, Session } from '../../../shared/protocol.ts'
import { age } from './useBridge.ts'
import { ContextBadge } from './Usage.tsx'
import { displayName, useStreamItems } from './conversation.ts'
import { useTranscriptPoll } from './transcript.ts'

export function Reader({ s, token, now, stateWord, waiting, onClose, character = null, conversation = null }: { s: Session; token: string; now: number; stateWord: string; waiting: number; onClose: () => void; character?: CharacterInfo | null; conversation?: Conversation | null }) {
  // A new last line or state means the session said or did something: read again now.
  const { turns, problem, loaded } = useTranscriptPoll(token, s.id, `${s.lastLine ?? ''}|${s.state}`)

  // With a character on, the dispatcher's panel is the character's: its name on top, its lines among the turns.
  const asCharacter = s.kind === 'dispatcher' && character !== null
  const base = useMemo(() => turns ?? s.messages.map(m => ({ role: 'session' as const, text: m.text, clipped: false })), [turns, s.messages])
  const items = useStreamItems(base, conversation, character, asCharacter)
  // Newest first, so the latest reply sits under the header with no scrolling.
  const shown = items.slice().reverse()

  return (
    <section className="reader" aria-label={`Reading ${s.callsign}`}>
      <header className="reader-head">
        <button className="big reader-back" onClick={onClose}>
          ← Fleet
          {waiting > 0 && <span className="reader-waiting">{waiting} waiting on you</span>}
        </button>
        <div className="reader-who">
          <span className="callsign">{asCharacter ? displayName(character.name) : s.callsign}</span>
          {asCharacter && <span className="reader-via">via dispatcher</span>}
          <span className={`state st-${s.state}`}>{stateWord}</span>
          <ContextBadge c={s.context} big />
          <span className="focus-meta">
            {s.title}
            {s.project ? ` · ${s.project}` : ''} · {age(s.activeAt, now)}
            {s.canSend ? '' : ' · no send route'}
          </span>
        </div>
      </header>
      {s.action && <div className="reader-action">{s.action}</div>}
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
      {problem?.kind === 'failed' && (
        <div className="alarm" role="alert">
          FULL REPLIES UNAVAILABLE: {problem.why}. {turns ? 'Showing the last ones read.' : 'Showing short clips instead.'}
        </div>
      )}
      {problem?.kind === 'none' && <div className="reader-note">Short clips only: {problem.why}.</div>}
      {!loaded && <div className="reader-note">Reading the full replies…</div>}
      {shown.length === 0 ? (
        <div className="empty">Nothing said yet.</div>
      ) : (
        <ol className="turns">
          {shown.map((it, i) =>
            it.kind === 'character' ? (
              <li key={`c-${it.entry.id}`} className="turn r-character">
                <span className="turn-who">{displayName(character?.name ?? 'character')}</span>
                <div className="turn-text">{it.entry.text}</div>
              </li>
            ) : (
              <li key={`${shown.length - i}-${it.turn.role}`} className={`turn r-${it.turn.role}`}>
                <span className="turn-who">{it.turn.role === 'you' ? 'You' : it.turn.role === 'session' ? s.callsign : 'Note'}</span>
                <div className="turn-text">{markdown(it.turn.text)}</div>
                {it.turn.clipped && <div className="reader-note">Cut here. The rest is on the Mac.</div>}
              </li>
            ),
          )}
        </ol>
      )}
    </section>
  )
}

// ---------------------------------------------------------------- markdown
// Enough Markdown to read a reply at arm's length: headings, bullets, bold,
// code. Built as elements, never as HTML, because session text is untrusted.

function inline(text: string): ReactNode[] {
  const plain = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  return plain.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>
    return part
  })
}

export function markdown(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let code: string[] | null = null
  text.split('\n').forEach((line, i) => {
    if (line.trimStart().startsWith('```')) {
      if (code) {
        out.push(
          <pre key={i} className="md-code">
            {code.join('\n')}
          </pre>,
        )
        code = null
      } else code = []
      return
    }
    if (code) return void code.push(line)
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) return void out.push(<div key={i} className="md-h">{inline(heading[1]!)}</div>)
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line)
    if (bullet) return void out.push(<div key={i} className={`md-li${bullet[1]!.length >= 2 ? ' md-li2' : ''}`}>{inline(bullet[2]!)}</div>)
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line)
    if (numbered) return void out.push(<div key={i} className="md-li md-num" data-n={`${numbered[1]}.`}>{inline(numbered[2]!)}</div>)
    if (!line.trim()) return void out.push(<div key={i} className="md-gap" />)
    out.push(<div key={i}>{inline(line)}</div>)
  })
  // An unclosed fence still shows what it held.
  if (code) out.push(<pre key="open-code" className="md-code">{(code as string[]).join('\n')}</pre>)
  return out
}
