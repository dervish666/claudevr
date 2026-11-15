// This browser's token, kept in localStorage. Both pages share it (same
// origin). It comes from the pairing handshake (a code shown here, typed on
// the Mac), from autoPair, or typed by hand for recovery. A link ending in
// #pair=<token> pairs without typing; the fragment never reaches the server
// or its logs, and is removed at once.

import type { PairStatus, PairTicket } from '../../shared/protocol.ts'

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

/**
 * Strips spaces a person might type. A hex token (the legacy one) also loses
 * dashes and case; any other token is kept as typed, since a device token's
 * case matters.
 */
export function cleanToken(input: string): string {
  const s = input.replace(/\s/g, '')
  return /^[0-9a-f-]+$/i.test(s) ? s.replace(/-/g, '').toLowerCase() : s
}

// ---------------------------------------------------------------- the handshake

const TICKET_KEY = 'claudevr.pair-ticket'

/** A code this tab shows, with the local time it runs out. */
export interface ShownTicket extends PairTicket {
  deadline: number
}

/** The code this tab was showing before a reload, if it has not run out, so a reload does not spend another. */
export function savedTicket(): ShownTicket | null {
  try {
    const raw = sessionStorage.getItem(TICKET_KEY)
    if (!raw) return null
    const t = JSON.parse(raw) as ShownTicket
    if (typeof t?.id !== 'string' || typeof t.secret !== 'string' || typeof t.code !== 'string' || typeof t.deadline !== 'number') return null
    return t.deadline > Date.now() ? t : null
  } catch (err) {
    console.error('pairing: cannot read the code kept for this tab:', err)
    return null
  }
}

export function keepTicket(t: ShownTicket | null): void {
  try {
    if (t) sessionStorage.setItem(TICKET_KEY, JSON.stringify(t))
    else sessionStorage.removeItem(TICKET_KEY)
  } catch (err) {
    console.error('pairing: cannot keep the code for this tab, a reload will ask for a new one:', err)
  }
}

const reasonOf = async (r: Response) => ((await r.json().catch((err: unknown) => ({ error: `unreadable reply: ${String(err)}` }))) as { error?: string }).error ?? `HTTP ${r.status}`

/** Asks the bridge for a code to show. `replaces` is this tab's previous code, dropped so "New code" does not hold two. */
export async function requestTicket(replaces: ShownTicket | null): Promise<{ ok: true; ticket: ShownTicket } | { ok: false; error: string }> {
  try {
    const r = await fetch('/api/pair/request', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', ...(replaces ? { 'x-pair-secret': replaces.secret } : {}) },
      body: JSON.stringify(replaces ? { replaces: replaces.id } : {}),
    })
    if (!r.ok) return { ok: false, error: await reasonOf(r) }
    const t = (await r.json()) as PairTicket
    if (typeof t.id !== 'string' || typeof t.code !== 'string' || typeof t.secret !== 'string' || typeof t.expiresInMs !== 'number') return { ok: false, error: 'the bridge answered without a code' }
    return { ok: true, ticket: { ...t, deadline: Date.now() + t.expiresInMs } }
  } catch (err) {
    return { ok: false, error: `bridge unreachable: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** One poll: still waiting, this device's token (handed over once), gone, or why the poll itself failed. */
export async function pollTicket(t: ShownTicket): Promise<PairStatus | { state: 'error'; error: string }> {
  try {
    const r = await fetch(`/api/pair/status?id=${encodeURIComponent(t.id)}`, { cache: 'no-store', headers: { 'x-pair-secret': t.secret } })
    if (r.status === 404) return { state: 'gone', error: await reasonOf(r) }
    if (!r.ok) return { state: 'error', error: await reasonOf(r) }
    const s = (await r.json()) as PairStatus
    if (s.state === 'approved' && (typeof s.token !== 'string' || !s.token)) return { state: 'error', error: 'the bridge approved this device but sent no token' }
    return s
  } catch (err) {
    return { state: 'error', error: `bridge unreachable: ${err instanceof Error ? err.message : String(err)}` }
  }
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
