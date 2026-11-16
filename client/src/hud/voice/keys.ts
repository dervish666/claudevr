// The desktop keys for voice: hold Space to talk, Enter sends the armed
// card, Escape cancels. Kept out of React so the rule can be tested.
//
// Space and Enter belong to whatever has focus when that is a control: Enter
// on a focused Cancel must press Cancel, not send the card, and Space on a
// focused button must press it, not start a recording. The hold-to-talk
// button keeps Space, since Space there can only mean voice; Enter on it is
// the button's own and never sends the armed card. Escape
// cancels from anywhere: it never sends anything. Free of the DOM, so the
// tests can load it; useVoice.ts turns an event target into a KeyTarget.

export type KeyAction = 'talk' | 'send' | 'cancel' | null

/** The parts of a key event the rule reads. */
export interface KeyPress {
  key: string
  code: string
  repeat: boolean
}

/** What had focus, as far as the rule needs. */
export interface KeyTarget {
  /** Upper-case tag name, as the DOM gives it. */
  tag: string
  role: string | null
  editable: boolean
  /** The hold-to-talk button itself. */
  talk: boolean
}

/** The attribute that marks the hold-to-talk button (Voice.tsx), so its own keys still talk. */
export const TALK_ATTR = 'data-hold-to-talk'

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA'])
const CONTROL_TAGS = new Set(['BUTTON', 'A', 'SELECT', 'SUMMARY'])
const CONTROL_ROLES = new Set(['button', 'link', 'checkbox', 'switch', 'radio', 'tab', 'menuitem', 'option', 'textbox', 'combobox', 'slider', 'spinbutton'])

/** Typing into a field: no key there is a voice key. */
export const isTyping = (t: KeyTarget | null): boolean => !!t && (TYPING_TAGS.has(t.tag) || t.editable)

/** A field or a control that takes Space and Enter for itself. */
export const ownsKeys = (t: KeyTarget | null): boolean => !!t && (isTyping(t) || CONTROL_TAGS.has(t.tag) || (t.role !== null && CONTROL_ROLES.has(t.role)))

/**
 * What a keydown means for voice. 'talk' is every Space that belongs to hold
 * to talk, repeats included, so the caller can stop the page scrolling; only
 * the first one starts a recording. A held-down Enter sends nothing: a card
 * that armed while it was held has not been read.
 */
export function keyAction(k: KeyPress, armed: boolean, target: KeyTarget | null): KeyAction {
  if (k.key === 'Escape') return 'cancel'
  // Space on the hold-to-talk button is still voice; Enter there is the
  // button's own, so pressing the labelled talk control never sends a card.
  if (k.code === 'Space' && target?.talk) return 'talk'
  if (ownsKeys(target)) return null
  if (k.code === 'Space') return 'talk'
  if (k.key === 'Enter' && armed && !k.repeat) return 'send'
  return null
}
