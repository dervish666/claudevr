// The HUDs' WebSockets once they are past the gate: how many are open (per
// address and in all), what each HUD says about itself (presence), the
// heartbeat that drops a dead one, closing a revoked device's sockets at
// once, and pushes that drop a client too far behind rather than buffer for
// it without end. The gate itself (address, origin, token) runs in server.ts
// before a socket reaches this file.

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { ClientMessage, ServerMessage } from '../../shared/protocol.ts'
import { WS_PROTOCOL } from './gate.ts'
import { sameCredential, type Credential, type DeviceStore } from './pairing.ts'
import type { Audience } from './persona/persona.ts'

/** The WebSocket close code for a socket whose device or token was just revoked. */
export const REVOKED_CLOSE = 4003

/**
 * Sends `data` unless the socket already has more than `max` bytes waiting
 * to go out. A client that stops reading is dropped rather than buffered
 * without end; the HUD reconnects and gets a fresh fleet.
 */
export function sendBounded(ws: Pick<WebSocket, 'readyState' | 'OPEN' | 'bufferedAmount' | 'send' | 'terminate'>, data: string, max: number, onDrop: (buffered: number) => void): boolean {
  if (ws.readyState !== ws.OPEN) return false
  if (ws.bufferedAmount > max) {
    onDrop(ws.bufferedAmount)
    ws.terminate()
    return false
  }
  ws.send(data)
  return true
}

export interface HubOptions {
  devices: DeviceStore
  /** Open sockets allowed per address and in all. */
  perIp: number
  total: number
  /** The unsent bytes past which a socket is dropped. */
  bufferMax: number
  log: (...a: unknown[]) => void
  /** The first messages a socket gets once it is open. */
  greet: (ws: WebSocket) => ServerMessage[]
}

const HEARTBEAT_MS = 15_000
/** Messages from a socket that were not presence: only the first few are logged, so one page cannot flood the log. */
const NOISE_LOGGED = 3

export class WsHub {
  private readonly o: HubOptions
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024,
    handleProtocols: protocols => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
  })
  /** Open sockets per address, for the per-address cap. */
  private readonly open = new Map<string, number>()
  private readonly ipOf = new WeakMap<WebSocket, string>()
  /** The token each socket came in with, so revoking a device closes its sockets at once. */
  private readonly credOf = new WeakMap<WebSocket, Credential>()
  private readonly alive = new WeakMap<WebSocket, boolean>()
  private readonly presence = new WeakMap<WebSocket, { muted: boolean; holding: boolean }>()
  private readonly noise = new WeakMap<WebSocket, number>()
  private readonly heartbeat: NodeJS.Timeout
  private readonly unRevoke: () => void

  constructor(o: HubOptions) {
    this.o = o
    this.unRevoke = o.devices.onRevoke(c => {
      let n = 0
      for (const ws of this.wss.clients) {
        const k = this.credOf.get(ws)
        if (!k || !sameCredential(k, c)) continue
        n++
        ws.close(REVOKED_CLOSE, 'pairing revoked')
        // A peer that never answers the close frame is cut off.
        setTimeout(() => ws.terminate(), 2000).unref()
      }
      if (n) o.log(`pair: closed ${n} WebSocket${n === 1 ? '' : 's'} that used the revoked ${c.kind === 'legacy' ? 'legacy token' : 'device'}`)
    })
    // A socket that misses a pong for a whole interval is dropped, so the HUD
    // reconnects instead of sitting on a dead connection.
    this.heartbeat = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (this.alive.get(ws) === false) {
          ws.terminate()
          continue
        }
        this.alive.set(ws, false)
        ws.ping()
      }
    }, HEARTBEAT_MS)
  }

  /** Why one more socket from `ip` would be too many, for the refusal's log line; null when there is room. */
  full(ip: string): string | null {
    const mine = this.open.get(ip) ?? 0
    if (this.wss.clients.size >= this.o.total) return `${this.wss.clients.size} WebSockets are open, the most the bridge takes`
    if (mine >= this.o.perIp) return `${mine} WebSockets are open from this address, the most one address may have`
    return null
  }

  /** Takes over an upgrade the gate has passed, with the credential it matched. */
  accept(req: IncomingMessage, socket: Duplex, head: Buffer, ip: string, cred: Credential): void {
    const { devices, log } = this.o
    this.wss.handleUpgrade(req, socket, head, ws => {
      // Revoked while the upgrade was in flight, so it is closed before it hears anything.
      if (!devices.valid(cred)) {
        log(`ws: ${ip} refused: its token was revoked during the upgrade`)
        ws.close(REVOKED_CLOSE, 'pairing revoked')
        return
      }
      this.credOf.set(ws, cred)
      devices.seen(cred)
      this.open.set(ip, (this.open.get(ip) ?? 0) + 1)
      this.ipOf.set(ws, ip)
      log(`ws: ${ip} connected (${this.wss.clients.size} open)`)
      this.alive.set(ws, true)
      // Muted until the HUD says otherwise, so a page that never reports is never spoken to unprompted.
      this.presence.set(ws, { muted: true, holding: false })
      ws.on('pong', () => this.alive.set(ws, true))
      ws.on('error', err => log(`ws: ${ip}:`, err.message))
      ws.on('close', () => {
        const n = (this.open.get(ip) ?? 1) - 1
        if (n > 0) this.open.set(ip, n)
        else this.open.delete(ip)
        log(`ws: ${ip} left (${this.wss.clients.size} open)`)
      })
      ws.on('message', data => this.onClientMessage(ws, ip, data))
      for (const m of this.o.greet(ws)) this.push(ws, m)
    })
  }

  private onClientMessage(ws: WebSocket, ip: string, data: unknown): void {
    const say = (line: string) => {
      const n = (this.noise.get(ws) ?? 0) + 1
      this.noise.set(ws, n)
      if (n <= NOISE_LOGGED) this.o.log(`ws: ${ip}: ${line}${n === NOISE_LOGGED ? ' (no more of these logged for this socket)' : ''}`)
    }
    let m: ClientMessage
    try {
      m = JSON.parse(String(data)) as ClientMessage
    } catch (err) {
      say(`unreadable message: ${(err as Error).message}`)
      return
    }
    if (m?.type === 'presence' && typeof m.muted === 'boolean' && typeof m.holding === 'boolean') this.presence.set(ws, { muted: m.muted, holding: m.holding })
    else say(`unknown message type ${JSON.stringify((m as { type?: unknown })?.type ?? null).slice(0, 40)}`)
  }

  /** The open sockets whose HUD is not muted: the only ones spoken to unprompted. */
  listeners(): WebSocket[] {
    return [...this.wss.clients].filter(ws => ws.readyState === ws.OPEN && this.presence.get(ws)?.muted === false)
  }

  audience(): Audience {
    const ls = this.listeners()
    return { listening: ls.length > 0, holding: ls.some(ws => this.presence.get(ws)?.holding === true) }
  }

  private dropped(ws: WebSocket): (buffered: number) => void {
    return buffered => this.o.log(`ws: ${this.ipOf.get(ws) ?? 'a client'} is ${Math.round(buffered / 1024)} kB behind, over the ${Math.round(this.o.bufferMax / 1024)} kB budget; dropped it, and the HUD will reconnect`)
  }

  push(ws: WebSocket, m: ServerMessage): void {
    sendBounded(ws, JSON.stringify(m), this.o.bufferMax, this.dropped(ws))
  }

  broadcast(m: ServerMessage): void {
    const data = JSON.stringify(m)
    for (const ws of this.wss.clients) sendBounded(ws, data, this.o.bufferMax, this.dropped(ws))
  }

  close(): void {
    this.unRevoke()
    clearInterval(this.heartbeat)
    for (const ws of this.wss.clients) ws.terminate()
    this.wss.close()
  }
}
