// The pairing token, entered once and kept in this browser. Both pages share
// it (same origin). A link ending in #pair=<token> pairs without typing; the
// fragment never reaches the server or its logs, and is removed at once.

const KEY = 'claudevr.pairing-token'

export function readToken(): string | null {
  takeFromFragment()
  try {
    return localStorage.getItem(KEY)
  } catch (err) {
    console.error('pairing: cannot read localStorage:', err)
    return memory
  }
}

let memory: string | null = null

export function saveToken(token: string): void {
  memory = token
  try {
    localStorage.setItem(KEY, token)
  } catch (err) {
    console.error('pairing: cannot write localStorage, the token lasts until this page closes:', err)
  }
}

export function forgetToken(): void {
  memory = null
  try {
    localStorage.removeItem(KEY)
  } catch (err) {
    console.error('pairing: cannot clear localStorage:', err)
  }
}

function takeFromFragment(): void {
  const m = /[#&]pair=([0-9a-f]{32,})/i.exec(location.hash)
  if (!m) return
  saveToken(m[1]!.toLowerCase())
  history.replaceState(null, '', location.pathname + location.search)
}

/**
 * Asks the bridge for the token. It answers only when its autoPair setting is
 * on, and only to addresses it already allows. Null means "not this way":
 * the caller falls back to the typed token.
 */
export async function autoPair(): Promise<string | null> {
  try {
    const r = await fetch('/api/pair', { method: 'POST', cache: 'no-store' })
    if (r.status === 403) return null // auto-pairing is off on this bridge
    if (!r.ok) {
      console.error(`pairing: auto-pair answered HTTP ${r.status}`)
      return null
    }
    const body = (await r.json()) as { token?: unknown }
    if (typeof body.token !== 'string' || !body.token) {
      console.error('pairing: auto-pair reply held no token')
      return null
    }
    saveToken(body.token)
    return body.token
  } catch (err) {
    console.error('pairing: auto-pair failed:', err)
    return null
  }
}

/** Strips spaces and dashes a person might type; the token is hex. */
export function cleanToken(input: string): string {
  return input.replace(/[\s-]/g, '').toLowerCase()
}

export type HealthResult = { ok: true } | { ok: false; status: number; error: string }

export async function checkToken(token: string): Promise<HealthResult> {
  try {
    const r = await fetch('/api/health', { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
    if (r.ok) return { ok: true }
    const body = (await r.json().catch((err: unknown) => ({ error: `unreadable reply: ${String(err)}` }))) as { error?: string }
    return { ok: false, status: r.status, error: body.error ?? `HTTP ${r.status}` }
  } catch (err) {
    return { ok: false, status: 0, error: `bridge unreachable: ${err instanceof Error ? err.message : String(err)}` }
  }
}
