// What the HUD does with an interpretation, decided apart from React so the
// rule can be tested: which answers arm a card, which send or cancel the one
// that is armed, and which only move the view or speak. useVoice.ts carries
// the step out. Free of the DOM, so the tests can load it.
//
// With a card armed, an answer that does nothing never lets it go: words
// that came to nothing ("um", "tell Tally" with no message, the character's
// bare name) hold the card, as a failed clip does, since they may have been
// "cancel"; and a new message still waiting for its target replaces the
// card, so the answer to "who is it for?" is read as a name.

import type { Interpretation } from '../../../../shared/protocol.ts'
import type { SendCards, TellToArm } from './sendcard.ts'

export type Step =
  /** Show a card for this message; the card on screen is the read-back, so nothing is spoken. */
  | { do: 'arm'; tell: TellToArm }
  /** Send the armed card now. */
  | { do: 'send' }
  | { do: 'cancel'; say: string }
  /**
   * Ask "who is it for?", keeping the words for the answer. With a card
   * armed, `armed` says what happens to it: a new message replaces it, a
   * name that matched nothing holds it.
   */
  | { do: 'which'; which: Extract<Interpretation, { kind: 'which' }>; armed: 'replace' | 'hold' | null }
  /** Show this session; `clearWhich` drops a "who is it for?" that this answered with no words kept. */
  | { do: 'select'; sessionId: string; say: string; clearWhich: boolean }
  /** Back to the dispatcher. */
  | { do: 'home'; say: string }
  /** Speak; `hold` stops an armed card's countdown until Send or Cancel. */
  | { do: 'say'; say: string; hold: boolean }

/**
 * The step for `i`. `kept` is the message waiting on a "who is it for?", if
 * any: a name given in answer arms that message for the named session, and
 * with nothing kept the name only shows the session. `armed`: a card is
 * armed and counting down.
 */
export function route(i: Interpretation, kept: { text: string } | null, armed = false): Step {
  switch (i.kind) {
    case 'tell':
      return { do: 'arm', tell: { sessionId: i.sessionId, callsign: i.callsign, text: i.text, viaDispatcher: i.viaDispatcher, viaFocus: i.viaFocus, viaClassifier: i.viaClassifier } }
    case 'confirm':
      return { do: 'send' }
    case 'cancel':
      return { do: 'cancel', say: i.say }
    case 'which':
      return { do: 'which', which: i, armed: !armed ? null : i.text ? 'replace' : 'hold' }
    case 'target':
      return kept?.text ? { do: 'arm', tell: { sessionId: i.sessionId, callsign: i.callsign, text: kept.text, viaDispatcher: false } } : { do: 'select', sessionId: i.sessionId, say: i.say, clearWhich: true }
    case 'switch':
    case 'read':
      return { do: 'select', sessionId: i.sessionId, say: i.say, clearWhich: false }
    case 'dispatcher':
      return { do: 'home', say: i.say }
    case 'ask':
    case 'unknown':
      return { do: 'say', say: i.say, hold: armed }
    case 'status':
    case 'limits':
    case 'voice':
    case 'character':
      return { do: 'say', say: i.say, hold: false }
  }
}

/** What an armed card that a new message replaced says. */
export const REPLACED_DETAIL = 'Replaced by a new message. Nothing sent.'

/**
 * The part of a step that acts on the armed card under the armed-card rule:
 * a replacing `which` cancels it, and words that came to nothing hold it.
 * Kept here, not in the hook, so a test can run it against a real SendCards.
 * Returns what it did, or null when the step leaves the card alone.
 */
export function applyArmedRule(step: Step, cards: Pick<SendCards, 'cancel' | 'hold'>): 'replaced' | 'held' | null {
  if (step.do === 'which' && step.armed === 'replace') return cards.cancel(REPLACED_DETAIL) ? 'replaced' : null
  if ((step.do === 'which' && step.armed === 'hold') || (step.do === 'say' && step.hold)) return cards.hold() ? 'held' : null
  return null
}
