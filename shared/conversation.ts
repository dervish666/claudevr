// Where the character's lines sit among a session's turns. Shared by the
// bridge (which names the turn a line follows) and both front ends (which
// draw the dispatcher's stream). Turns carry no time, so a line is anchored
// to the text of the turn it follows instead.

import type { ConversationEntry, Turn } from './protocol.ts'

/** A turn's identity for anchoring: its first words, whitespace folded. Two turns that open the same way share a key; the later one wins. */
export function turnKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 120)
}

export type StreamItem = { kind: 'turn'; turn: Turn } | { kind: 'character'; entry: ConversationEntry }

/**
 * The turns, oldest first, with the character's lines put in after the turn
 * each one follows. The anchor is the line's own `after` when that turn is
 * on screen, else `seen` (the last turn on screen when the HUD first saw the
 * line). A line whose anchors have both scrolled out of the turn window is
 * older than every turn shown, so it goes first; one with no anchor at all
 * goes last.
 */
export function mergeConversation(turns: Turn[], lines: ConversationEntry[], seen: ReadonlyMap<string, string | null>): StreamItem[] {
  const keys = turns.map(t => turnKey(t.text))
  const lastIndex = (k: string | null | undefined) => (k ? keys.lastIndexOf(k) : -1)
  const head: ConversationEntry[] = []
  const tail: ConversationEntry[] = []
  const at = new Map<number, ConversationEntry[]>()
  for (const e of lines) {
    let i = lastIndex(e.after)
    if (i < 0) i = lastIndex(seen.get(e.id))
    if (i >= 0) at.set(i, [...(at.get(i) ?? []), e])
    else if (e.after || seen.get(e.id)) head.push(e)
    else tail.push(e)
  }
  const out: StreamItem[] = head.map(entry => ({ kind: 'character', entry }))
  turns.forEach((turn, i) => {
    out.push({ kind: 'turn', turn })
    for (const entry of at.get(i) ?? []) out.push({ kind: 'character', entry })
  })
  for (const entry of tail) out.push({ kind: 'character', entry })
  return out
}
