// What instrument mode shows and plays for the send card, kept free of
// three.js and React so the bridge's test runner can import it. The card's
// rules live in hud/voice/sendcard.ts; this only reads them.

import type { Card } from '../hud/voice/sendcard.ts'

/**
 * Where the seconds go while a card is held. A held card is armed with no
 * countdown (a clip failed while it was up), so nothing goes until he says
 * send or presses it.
 */
export const HELD_LINE = 'PAUSED · SAY SEND OR CANCEL'
/** Where the seconds go while he holds to talk: the countdown restarts in full when he lets go. */
export const TALKING_LINE = 'PAUSED WHILE YOU TALK'

/**
 * What the countdown line shows, as a number that changes only when the
 * line should: the whole seconds left, -1 while he talks, -3 while held.
 * The frame loop builds a new string only when this changes.
 */
export function countdownStep(card: Pick<Card, 'held' | 'sendAt'>, talking: boolean, now: number): number {
  if (card.held) return -3
  if (talking) return -1
  return Math.max(0, Math.ceil((card.sendAt - now) / 1000))
}

export function countdownLine(step: number): string {
  return step === -3 ? HELD_LINE : step < 0 ? TALKING_LINE : `SENDS IN ${step}`
}

/** How much of the voice arc an armed card lights, 1 draining to 0; null for a held card, which has no countdown to drain. */
export function countdownLeft(card: Pick<Card, 'held' | 'sendAt' | 'countdownMs'>, now: number): number | null {
  if (card.held) return null
  return Math.max(0, Math.min(1, (card.sendAt - now) / card.countdownMs))
}

/**
 * The arming tone plays once per card, when it first arms: true when `card`
 * is armed and is not the card the tone last played for. A card that is
 * held, or re-armed after he talks, keeps its id and stays quiet.
 */
export function armsNow(lastArmed: number | null, card: Pick<Card, 'id' | 'state'> | null): boolean {
  return card !== null && card.state === 'armed' && card.id !== lastArmed
}
