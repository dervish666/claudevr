// The limits strip, pinned to the top of the HUD in the fleet view and the
// reader alike, and the context badge on cards and in the reader's header.
// A figure the backend does not have reads "not available"; one from a
// source gone quiet keeps its value, dimmed, with its age.

import type { ContextUse, Figure, LimitWindow, Usage } from '../../../shared/protocol.ts'
import { age } from './useBridge.ts'

/** Colour steps for a percentage used: under 60 calm, 60 to 79 amber, 80 and over red. */
export function level(pct: number): 'ok' | 'warn' | 'bad' {
  return pct >= 80 ? 'bad' : pct >= 60 ? 'warn' : 'ok'
}

/** How long until `t`: "47m", "3h 12m", "5d". */
export function until(t: number, now: number): string {
  const m = Math.max(0, Math.round((t - now) / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  return `${Math.round(h / 24)}d`
}

const SHORT: Record<string, string> = { five_hour: '5H', seven_day: 'WEEK' }

function Tile({ label, value, cls, sub, title }: { label: string; value: string; cls: string; sub: string | null; title?: string }) {
  return (
    <div className={`lim ${cls}`} title={title}>
      <span className="lim-label">{label}</span>
      <span className="lim-value">{value}</span>
      {sub && <span className="lim-sub">{sub}</span>}
    </div>
  )
}

const staleSub = (f: Figure<unknown>, now: number) => (f.stale ? (f.at === null ? 'age unknown' : `${age(f.at, now)} old`) : null)

export function LimitsStrip({ usage, now }: { usage: Usage | undefined; now: number }) {
  // A bridge from before this field existed sends none: say so, never 0%.
  if (!usage) {
    return (
      <section className="limits" aria-label="Usage limits">
        <Tile label="LIMITS" value="not available" cls="na" sub="this bridge sends no usage figures" />
      </section>
    )
  }
  const { limits, todayUsd } = usage
  const windows: (LimitWindow | null)[] = limits.value ?? []
  const fiveKnown = windows.some(w => w?.kind === 'five_hour')
  // The 5-hour slot always shows, so its absence reads as absence.
  const shown = fiveKnown ? windows : [null, ...windows]
  return (
    <section className={`limits${limits.stale || todayUsd.stale ? ' has-stale' : ''}`} aria-label="Usage limits">
      {shown.map(w =>
        w === null ? (
          <Tile key="five-na" label="5H" value="not available" cls="na" sub={limits.note} />
        ) : (
          <Tile
            key={w.kind}
            label={SHORT[w.kind] ?? w.label.toUpperCase()}
            value={`${Math.round(w.usedPct)}%`}
            cls={`lv-${level(w.usedPct)}${limits.stale ? ' stale' : ''}`}
            sub={staleSub(limits, now) ?? (w.resetsAt !== null ? `resets in ${until(w.resetsAt, now)}` : 'reset time unknown')}
            title={limits.note ?? undefined}
          />
        ),
      )}
      {todayUsd.value === null ? (
        <Tile label="TODAY" value="not available" cls="na" sub={todayUsd.note} />
      ) : (
        <Tile label="TODAY" value={`$${todayUsd.value.toFixed(2)}`} cls={`spend${todayUsd.stale ? ' stale' : ''}`} sub={staleSub(todayUsd, now) ?? 'API-rate cost'} title={todayUsd.note ?? undefined} />
      )}
    </section>
  )
}

/** "CTX 91%", coloured; nothing at all when the context is not known. */
export function ContextBadge({ c, big = false }: { c: ContextUse | null | undefined; big?: boolean }) {
  if (!c) return null
  const pct = Math.round(c.usedPct)
  const of = c.tokens !== null && c.windowTokens !== null ? ` (${Math.round(c.tokens / 1000)}k of ${Math.round(c.windowTokens / 1000)}k tokens)` : ''
  return (
    <span className={`ctx lv-${level(pct)}${big ? ' ctx-big' : ''}`} title={`context ${pct}% full${of}`}>
      <span className="ctx-bar" aria-hidden="true">
        <span style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
      </span>
      CTX {pct}%
    </span>
  )
}
