// Which session voice is aimed at, apart from React so the rule can be tested.
//
// The view drops a selection whose session has left the fleet, and shows the
// fleet (or the dispatcher) instead. Voice must not follow it there: words
// meant for that session would become a card for the dispatcher. So voice
// keeps the selection, and the bridge's grammar answers "the session you had
// open has gone" (grammar.ts) until he picks another or goes back to the
// dispatcher. A selection never seen in this page's fleet, such as a tile
// stored from days ago, counts as none, or every word would be refused for a
// session he cannot see and did not choose today.

export class VoiceFocus {
  private readonly seen = new Set<string>()

  /**
   * The id voice should carry for `selected` against the current fleet's ids,
   * or null for none. A null fleet (nothing read yet) proves nothing either way.
   */
  focus(selected: string | null, fleetIds: readonly string[] | null): string | null {
    if (!selected) return null
    if (fleetIds?.includes(selected)) this.seen.add(selected)
    return this.seen.has(selected) ? selected : null
  }
}
