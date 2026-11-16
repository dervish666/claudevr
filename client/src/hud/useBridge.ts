// The HUD's line to the bridge: one WebSocket, reconnecting, and a clear
// record of what is known and how old it is, so the page never passes off
// stale data as a quiet fleet. When to reconnect, and when a quiet socket is
// given up on, is decided in link.ts, which has its own tests.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BackendStatus, BuildInfo, ClientMessage, Conversation, Fleet, ServerMessage, SpokenLine, VoiceStatus } from '../../../shared/protocol.ts'
import { checkToken } from '../pairing.ts'
import { BridgeLink, SILENCE_MS } from './link.ts'

export type Link = 'connecting' | 'open' | 'down' | 'unauthorized'

export interface BridgeState {
  link: Link
  linkError: string | null
  fleet: Fleet | null
  status: BackendStatus | null
  /** Epoch ms of the last message from the bridge. */
  heardAt: number | null
  /** Epoch ms the WebSocket last went down. */
  downSince: number | null
  build: BuildInfo | null
  voice: VoiceStatus | null
  /** The last line character mode spoke up with, unprompted. */
  announce: SpokenLine | null
  /** Character mode's conversation, as the bridge last pushed it; null from a bridge that keeps none. */
  conversation: Conversation | null
  /** Sends to the bridge on the open socket; dropped while it is down, and the next open repeats what matters. */
  post: (m: ClientMessage) => void
}

const INITIAL: Omit<BridgeState, 'post'> = { link: 'connecting', linkError: null, fleet: null, status: null, heardAt: null, downSince: null, build: null, voice: null, announce: null, conversation: null }

/**
 * The build this page loaded with, as the bridge first named it. In dev
 * (build.reload) a different id later, on a push or after the bridge
 * restarts, means the client was rebuilt: reload to pick it up.
 */
let loadedBuild: string | null = null
function checkBuild(b: BuildInfo): void {
  if (!b.id) return
  if (loadedBuild === null) {
    loadedBuild = b.id
    return
  }
  if (b.reload && b.id !== loadedBuild) {
    console.log(`hud: client rebuilt (${loadedBuild} -> ${b.id}); reloading`)
    // Instrument mode logs how long getting back in takes after one of these.
    try {
      sessionStorage.setItem('claudevr.reloadAt', String(Date.now()))
    } catch (err) {
      console.error('hud: cannot mark the reload:', err)
    }
    location.reload()
  }
}

export function useBridge(token: string): BridgeState {
  const [state, setState] = useState<Omit<BridgeState, 'post'>>(INITIAL)
  const sock = useRef<WebSocket | null>(null)
  // The last presence sent, repeated on every new connection.
  const lastPresence = useRef<ClientMessage | null>(null)
  const post = useCallback((m: ClientMessage) => {
    if (m.type === 'presence') lastPresence.current = m
    const ws = sock.current
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m))
  }, [])

  useEffect(() => {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
    const link = new BridgeLink<WebSocket>({
      open: () => new WebSocket(url, ['claudevr', `token.${token}`]),
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: h => clearTimeout(h as ReturnType<typeof setTimeout>),
      onConnecting: () => setState(s => ({ ...s, link: s.link === 'down' ? 'down' : 'connecting' })),
      onOpen: ws => {
        sock.current = ws
        if (lastPresence.current) ws.send(JSON.stringify(lastPresence.current))
        setState(s => ({ ...s, link: 'open', linkError: null, downSince: null, heardAt: Date.now() }))
      },
      onMessage: data => {
        let m: ServerMessage
        try {
          m = JSON.parse(String(data)) as ServerMessage
        } catch (err) {
          console.error('hud: unreadable message from the bridge:', err)
          return
        }
        // A bridge from before voice sends a hello with no build or voice.
        if ((m.type === 'hello' || m.type === 'build') && m.build) checkBuild(m.build)
        setState(s => ({
          ...s,
          heardAt: Date.now(),
          status: m.status,
          fleet: m.type === 'fleet' ? m.fleet : s.fleet,
          build: m.type === 'hello' || m.type === 'build' ? (m.build ?? null) : s.build,
          voice: m.type === 'hello' || m.type === 'voice' ? (m.voice ?? null) : s.voice,
          announce: m.type === 'line' ? m.line : s.announce,
          conversation: m.type === 'conversation' ? m.conversation : s.conversation,
        }))
      },
      onDown: async d => {
        sock.current = null
        if (d.kind === 'unstarted') {
          setState(s => ({ ...s, link: 'down', linkError: d.error, downSince: s.downSince ?? Date.now() }))
          return 'retry'
        }
        if (d.kind === 'silent') {
          console.warn(`hud: nothing from the bridge in ${Math.round(d.quietMs / 1000)} s; dropped the socket and reconnecting`)
          setState(s => ({ ...s, link: 'down', linkError: `no word from the bridge in ${Math.round(SILENCE_MS / 1000)} s, reconnecting`, downSince: Date.now() }))
          return 'retry'
        }
        // A browser hides the HTTP status of a refused upgrade. Ask the API,
        // which answers 401 for a bad token, so the page can say which it is.
        if (!d.opened) {
          const h = await checkToken(token)
          if (!h.ok && h.status === 401) {
            setState(s => ({ ...s, link: 'unauthorized', linkError: h.error }))
            return 'stop'
          }
          setState(s => ({ ...s, link: 'down', linkError: h.ok ? `WebSocket refused (code ${d.code})` : h.error, downSince: s.downSince ?? Date.now() }))
        } else setState(s => ({ ...s, link: 'down', linkError: `connection closed (code ${d.code})`, downSince: Date.now() }))
        return 'retry'
      },
    })
    link.start()
    return () => {
      sock.current = null
      link.stop()
    }
  }, [token])

  return useMemo(() => ({ ...state, post }), [state, post])
}

export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return now
}

/** 42s, 7m, 3h, 2d. */
export function age(since: number | null, now: number): string {
  if (since === null) return 'age unknown'
  const s = Math.max(0, Math.round((now - since) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}
