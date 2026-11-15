// The needs-you rail above the Core, and the reply cards that pop up over a
// tile's wing when a session other than the Core's target says something.
// Neither answers anything: the bridge cannot respond or approve, so
// picking a card only puts that session in the Core, and the person answers
// by voice. The logic (ordering, overflow, triggers, the queue) is in
// cards.ts; this file draws it.

import { memo, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { Container } from '@react-three/uikit'
import { Text } from './ui.tsx'
import { computed } from '@preact/signals-core'
import type { Fleet, Need, NeedKind } from '../../../shared/protocol.ts'
import { age } from '../hud/useBridge.ts'
import { EMPTY_QUEUE, dismissReply, expireReplies, nextExpiry, pushReplies, railItems, replyTriggers, snapshot, type ReplyCard, type ReplyQueue, type ReplyWhy, type Snapshot } from './cards.ts'
import { second } from './clock.ts'
import { MORE_SLOT, WING_TOP, columnKey, slotPose } from './layout.ts'
import { log } from './telemetry.ts'
import { fit } from './text.ts'
import { C, FONTS, corner, plateOf, weight } from './theme.ts'

const MM = 0.001
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

// ---------------------------------------------------------------- needs-you rail

/** The rail's bottom edge, just above the Core's outer ring, and its distance. */
const RAIL_BASE_Y = 0.575
const RAIL_Z = -1.28
const RAIL_TILT = Math.atan2(RAIL_BASE_Y + 0.07, -RAIL_Z)
const CARD_W = 262

// Getters, so each card reads the theme's colours when it is built rather than the ones loaded with the module.
const KIND: Record<NeedKind, { word: string; readonly colour: string }> = {
  question: { word: 'QUESTION', get colour() { return C.purple } },
  approval: { word: 'APPROVAL', get colour() { return C.amber } },
  'needs-sam': { word: 'NEEDS YOU', get colour() { return C.purple } },
  failed: { word: 'FAILED', get colour() { return C.red } },
}

function NeedCard({ n, selected, onPick }: { n: Need; selected: boolean; onPick: MutableRefObject<(id: string) => void> }) {
  const k = KIND[n.kind]
  const waited = useMemo(() => computed(() => (n.since === null ? 'WAITING ?' : `WAITING ${age(n.since, second.value).toUpperCase()}`)), [n.since])
  const pickable = n.sessionId !== null
  const opts = n.options.slice(0, 3)
  return (
    <Container
      width={CARD_W}
      flexDirection="column"
      gap={4}
      padding={12}
      paddingLeft={14}
      borderRadius={corner(6)}
      borderLeftWidth={5}
      borderTopWidth={selected ? 2 : 0}
      borderRightWidth={selected ? 2 : 0}
      borderBottomWidth={selected ? 2 : 0}
      borderColor={k.colour}
      backgroundColor={selected ? plateOf('railSel', 0.95) : plateOf('rail', 0.92)}
      // uikit cannot take hover={undefined}: pass the hover and click props only when the card can be picked.
      {...(pickable
        ? {
            hover: { backgroundColor: plateOf('railHover', 0.97) },
            onClick: (e: { stopPropagation: () => void }) => {
              e.stopPropagation()
              onPick.current(n.sessionId!)
            },
          }
        : {})}
    >
      <Container flexDirection="row" alignItems="center" gap={8}>
        <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={17} color={k.colour}>
          {k.word}
        </Text>
        <Container flexGrow={1} />
        <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={16} color={C.muted}>
          {waited}
        </Text>
      </Container>
      <Text fontFamily="rajdhani" fontWeight="bold" fontSize={26} lineHeight={1.05} color={C.white}>
        {fit(clip((n.callsign ?? n.label).toUpperCase(), 18), 'rajdhani-700')}
      </Text>
      <Text fontFamily="inter" fontSize={17} lineHeight={1.3} color={C.body}>
        {fit(clip(n.text, 110))}
      </Text>
      {opts.length > 0 && (
        <Container flexDirection="row" flexWrap="wrap" gap={6} marginTop={2}>
          {opts.map(o => (
            <Container key={o} borderWidth={weight(2)} borderColor={C.cyanDim} borderRadius={corner(4)} paddingX={7} paddingY={1}>
              <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={16} color={C.body}>
                {fit(clip(o, 26), 'rajdhani-600')}
              </Text>
            </Container>
          ))}
          {n.options.length > opts.length && (
            <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={16} color={C.muted}>
              {`+${n.options.length - opts.length}`}
            </Text>
          )}
        </Container>
      )}
      <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={16} color={pickable ? C.cyan : C.muted} marginTop={2}>
        {fit(pickable ? 'PICK TO OPEN, THEN SPEAK' : clip(`ANSWER IN ${n.source.toUpperCase()}`, 30), 'rajdhani-600')}
      </Text>
    </Container>
  )
}

const needSig = (n: Need) => `${n.id}|${n.kind}|${n.sessionId}|${n.callsign}|${n.label}|${n.text}|${n.options.join('\u0001')}|${n.since}|${n.source}`

/**
 * Sessions waiting on the person, oldest first, in a row above the Core.
 * One uikit root for the lot. Empty draws nothing; more than fit shows the
 * oldest and a "+N more" card.
 */
export const Rail = memo(
  function Rail({ needs, selected, onPick }: { needs: Need[]; selected: string | null; onPick: MutableRefObject<(id: string) => void> }) {
    const { shown, more } = railItems(needs)
    if (!shown.length && !more) return null
    return (
      <group position={[0, RAIL_BASE_Y, RAIL_Z]} rotation-x={RAIL_TILT}>
        <Container pixelSize={MM} fontFamilies={FONTS} anchorY="bottom" flexDirection="column" alignItems="center" gap={6}>
          <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={20} color={C.purple}>
            {`NEEDS YOU · ${needs.length} WAITING`}
          </Text>
          <Container flexDirection="row" alignItems="flex-end" gap={14}>
            {shown.map(n => (
              <NeedCard key={n.id} n={n} selected={!!n.sessionId && n.sessionId === selected} onPick={onPick} />
            ))}
            {more > 0 && (
              <Container width={150} flexDirection="column" alignItems="center" justifyContent="center" padding={12} borderRadius={corner(6)} borderWidth={weight(2)} borderColor={C.purple} backgroundColor={plateOf('rail', 0.92)}>
                <Text fontFamily="rajdhani" fontWeight="bold" fontSize={44} lineHeight={1} color={C.purple}>
                  {`+${more}`}
                </Text>
                <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={16} color={C.muted} textAlign="center">
                  MORE WAITING
                </Text>
                <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={16} color={C.muted} textAlign="center">
                  OLDEST SHOWN
                </Text>
              </Container>
            )}
          </Container>
        </Container>
      </group>
    )
  },
  (a, b) => a.selected === b.selected && a.onPick === b.onPick && a.needs.length === b.needs.length && a.needs.every((n, i) => needSig(n) === needSig(b.needs[i]!)),
)

// ---------------------------------------------------------------- reply cards

/**
 * The reply-card queue for a fleet. The first fleet seen is the baseline:
 * nothing fires for it. After that each new fleet is compared with the one
 * before; a card for the current target is dropped as soon as it becomes
 * the target.
 */
export function useReplies(fleet: Fleet | null, targetId: string | null): [ReplyQueue, (id: string) => void] {
  const [q, setQ] = useState<ReplyQueue>(EMPTY_QUEUE)
  const seen = useRef<Snapshot | null>(null)
  const target = useRef(targetId)
  target.current = targetId
  useEffect(() => {
    if (!fleet) return
    const cards = replyTriggers(seen.current, fleet.sessions, target.current)
    seen.current = snapshot(fleet.sessions)
    if (!cards.length) return
    log('reply-cards', { cards: cards.map(c => ({ id: c.id, why: c.why })) })
    setQ(old => pushReplies(old, cards, Date.now()))
  }, [fleet])
  useEffect(() => {
    if (targetId) setQ(old => dismissReply(old, targetId, Date.now()))
  }, [targetId])
  useEffect(() => {
    const t = nextExpiry(q)
    if (t === null) return
    const h = setTimeout(() => setQ(old => expireReplies(old, Date.now())), Math.max(0, t - Date.now()) + 15)
    return () => clearTimeout(h)
  }, [q])
  const dismiss = useMemo(() => (id: string) => setQ(old => dismissReply(old, id, Date.now())), [])
  return [q, dismiss]
}

const WHY: Record<ReplyWhy, { word: string; readonly colour: string }> = {
  said: { word: 'NEW REPLY', get colour() { return C.cyan } },
  finished: { word: 'STOPPED WORKING', get colour() { return C.muted } },
  asking: { word: 'ASKING YOU', get colour() { return C.purple } },
  failed: { word: 'FAILED', get colour() { return C.red } },
}

/** As wide as a tile, so stacks over neighbouring columns never overlap. */
const REPLY_W = 300

function ReplyView({ c, onPick }: { c: ReplyCard; onPick: MutableRefObject<(id: string) => void> }) {
  const w = WHY[c.why]
  return (
    <Container
      width={REPLY_W}
      flexDirection="column"
      gap={4}
      padding={12}
      borderRadius={corner(6)}
      borderWidth={weight(2)}
      borderColor={w.colour}
      backgroundColor={plateOf('card', 0.95)}
      hover={{ backgroundColor: plateOf('hover', 0.97) }}
      onClick={e => {
        e.stopPropagation()
        onPick.current(c.id)
      }}
    >
      <Container flexDirection="row" alignItems="center" gap={10}>
        <Text fontFamily="rajdhani" fontWeight="bold" fontSize={26} lineHeight={1.05} color={C.white} flexShrink={0}>
          {fit(clip(c.callsign.toUpperCase(), 16), 'rajdhani-700')}
        </Text>
        <Container flexGrow={1} />
        <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={17} color={w.colour} flexShrink={0}>
          {w.word}
        </Text>
      </Container>
      {c.lines.map((l, i) => (
        <Text key={i} fontFamily="inter" fontSize={17} lineHeight={1.3} color={C.body}>
          {fit(clip(l, 76))}
        </Text>
      ))}
      <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={15} color={C.muted}>
        PICK TO OPEN
      </Text>
    </Container>
  )
}

/** Where a session's card goes: its tile's column, the "+N" tile's for one without a tile, the left inner column for the dispatcher. */
export function anchorSlot(id: string, tileSlots: Map<string, number>, hasMore: boolean): number {
  return tileSlots.get(id) ?? (hasMore ? MORE_SLOT : 0)
}

/** The cards on screen, stacked over their wing columns, newest nearest the tiles. One uikit root per column in use. */
export const ReplyCards = memo(function ReplyCards({ cards, slots, hasMore, onPick }: { cards: ReplyCard[]; slots: Map<string, number>; hasMore: boolean; onPick: MutableRefObject<(id: string) => void> }) {
  const byColumn = new Map<string, { slot: number; cards: ReplyCard[] }>()
  for (const c of cards) {
    const slot = anchorSlot(c.id, slots, hasMore)
    const k = columnKey(slot)
    const e = byColumn.get(k) ?? { slot, cards: [] }
    e.cards.push(c)
    byColumn.set(k, e)
  }
  return (
    <>
      {[...byColumn.entries()].map(([k, { slot, cards: cs }]) => {
        const p = slotPose(slot)
        // Keyed by the cards it holds, so any change rebuilds the root. Adding or
        // removing a card inside a live root (uikit 1.0.78) dropped panels and left
        // orphan glyphs on screen in the preview.
        return (
          <group key={`${k}:${cs.map(c => `${c.id}@${c.shownAt}`).join(',')}`} position={[p.x, WING_TOP + 0.025, p.z]} rotation-y={p.yaw}>
            <Container pixelSize={MM * p.scale} fontFamilies={FONTS} anchorY="bottom" flexDirection="column-reverse" gap={10}>
              {cs.map(c => (
                <ReplyView key={c.id} c={c} onPick={onPick} />
              ))}
            </Container>
          </group>
        )
      })}
    </>
  )
})
