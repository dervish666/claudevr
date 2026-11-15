// The dispatcher's stream with the character's lines in it, for both front
// ends. The bridge keeps the conversation in memory and pushes it on the
// WebSocket; this places its `character` entries among the turns.

import { useMemo, useRef } from 'react'
import type { CharacterInfo, Conversation, ConversationEntry, Turn } from '../../../shared/protocol.ts'
import { mergeConversation, turnKey, type StreamItem } from '../../../shared/conversation.ts'

/** "bosun" -> "Bosun", for labels in running text. */
export const displayName = (name: string) => name.charAt(0).toUpperCase() + name.slice(1)

function sameItems(a: StreamItem[], b: StreamItem[]): boolean {
  return a.length === b.length && a.every((x, i) => {
    const y = b[i]!
    return x.kind === 'turn' ? y.kind === 'turn' && y.turn.role === x.turn.role && y.turn.text === x.turn.text && y.turn.clipped === x.turn.clipped : y.kind === 'character' && y.entry.id === x.entry.id
  })
}

/**
 * The turns with the character's lines placed in time order. `active` is
 * false for any stream but the dispatcher's, or in operator mode: then the
 * turns come back as they are. The result keeps its identity while nothing
 * in it changed, so a re-read does not lay the stream out again.
 */
export function useStreamItems(turns: Turn[], conversation: Conversation | null, character: CharacterInfo | null, active: boolean): StreamItem[] {
  // Where each line was first seen: the last turn on screen when it arrived.
  const seen = useRef(new Map<string, string | null>())
  const prev = useRef<StreamItem[]>([])
  const lines = useMemo<ConversationEntry[]>(
    () => (active && character && conversation?.character === character.name ? conversation.entries.filter(e => e.who === 'character') : []),
    [active, character, conversation],
  )
  return useMemo(() => {
    const last = turns.at(-1)
    for (const e of lines) if (!seen.current.has(e.id)) seen.current.set(e.id, last ? turnKey(last.text) : null)
    const next = lines.length ? mergeConversation(turns, lines, seen.current) : turns.map(turn => ({ kind: 'turn' as const, turn }))
    if (sameItems(prev.current, next)) return prev.current
    prev.current = next
    return next
  }, [turns, lines])
}
