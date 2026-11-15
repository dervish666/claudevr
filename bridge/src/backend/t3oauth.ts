// The one-time OAuth approval that links the bridge to T3 Code's MCP endpoint
// (npm run t3-link). T3 offers dynamic client registration, the
// authorization_code grant with PKCE S256, and no refresh grant, so when the
// token runs out the user links again.
//
// The flow: read T3's origin, fetch its discovery document, register a
// public client with a loopback redirect, send the user's browser to the
// authorize URL, take the callback on 127.0.0.1 only, check `state`, trade
// the code and the PKCE verifier for a token, and save the token with mode
// 0600. T3's approval page, not this request, sets the access level.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { writeLink, type T3Link } from './t3mcp.ts'

export const CLIENT_NAME = 'ClaudeVR bridge'
const HTTP_TIMEOUT_MS = 10_000
/** How long the user has to approve in the browser. */
const APPROVAL_TIMEOUT_MS = 5 * 60_000

export interface LinkOptions {
  /** T3's origin, e.g. http://127.0.0.1:3773. */
  origin: string
  linkFile: string
  /** Opens the authorize URL; the default runs macOS `open`. */
  openUrl: (url: string) => void | Promise<void>
  /** Plain-words progress for the user. Never given the token. */
  say: (line: string) => void
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  approvalTimeoutMs?: number
  now?: () => number
}

export interface LinkOutcome {
  scope: string
  expiresAt: string | null
}

const b64url = (b: Buffer) => b.toString('base64url')

const sameText = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Fails unless `url` is on the same origin as T3: the code and verifier go nowhere else. */
function onOrigin(url: unknown, origin: string, what: string): string {
  if (typeof url !== 'string') throw new Error(`T3's discovery document has no ${what}`)
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error(`T3's ${what} is not a URL`)
  }
  if (u.origin !== origin) throw new Error(`T3's ${what} is on ${u.origin}, not ${origin}; refusing to link`)
  return u.href
}

async function readJson(res: Response, what: string): Promise<Record<string, unknown>> {
  const text = await res.text()
  let d: unknown
  try {
    d = JSON.parse(text)
  } catch {
    throw new Error(`${what}: T3 answered HTTP ${res.status} with something that is not JSON`)
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error(`${what}: T3 answered HTTP ${res.status} with no JSON object`)
  const o = d as Record<string, unknown>
  if (!res.ok) {
    // OAuth errors carry `error` and `error_description`; neither holds a secret.
    const why = [o.error, o.error_description ?? o.message].filter(v => typeof v === 'string').join(': ')
    throw new Error(`${what}: T3 answered HTTP ${res.status}${why ? ` (${why.slice(0, 300)})` : ''}`)
  }
  return o
}

/** Listens on 127.0.0.1 only, on a free port, for the one callback. */
function listenLoopback(): Promise<Server> {
  return new Promise((ok, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => ok(server))
  })
}

const PAGE = (title: string, line: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;padding:2rem"><h1>${title}</h1><p>${line}</p></body>`

/** Waits for GET /callback with the right `state`; resolves the code. */
function awaitCallback(server: Server, state: string, issuer: string, timeoutMs: number): Promise<string> {
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`no approval within ${Math.round(timeoutMs / 60_000)} minutes; run npm run t3-link again`)), timeoutMs)
    server.on('request', (req, res) => {
      // A raw client can send a target that is not a URL; that must not end the link flow with a throw.
      let url: URL
      try {
        url = new URL(req.url ?? '/', 'http://127.0.0.1')
      } catch (err) {
        console.error(`t3-link: ignored a request whose target is not a URL: ${(err as Error).message}`)
        res.writeHead(400, { 'content-type': 'text/plain' }).end('bad request')
        return
      }
      if (req.method !== 'GET' || url.pathname !== '/callback') {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not here')
        return
      }
      const p = url.searchParams
      const answer = (status: number, title: string, line: string) => res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(PAGE(title, line))
      // A request without our state is not the answer to our request: refuse it and keep waiting.
      if (!sameText(p.get('state') ?? '', state)) {
        answer(400, 'Not this link', 'This page was not opened by the link the bridge is waiting for.')
        return
      }
      const iss = p.get('iss')
      if (iss !== null && iss !== issuer) {
        answer(400, 'Wrong server', 'The answer came from a server the bridge did not ask.')
        clearTimeout(timer)
        fail(new Error(`the answer names ${iss.slice(0, 100)} as its issuer, not ${issuer}`))
        return
      }
      const error = p.get('error')
      if (error) {
        answer(200, 'Not linked', 'T3 did not approve the link. You can close this tab.')
        clearTimeout(timer)
        fail(new Error(error === 'access_denied' ? 'you declined the link on T3\'s page' : `T3 refused the link: ${error.slice(0, 80)} ${(p.get('error_description') ?? '').slice(0, 200)}`.trim()))
        return
      }
      const code = p.get('code')
      if (!code) {
        answer(400, 'Not linked', 'The answer carried no code. Run npm run t3-link again.')
        clearTimeout(timer)
        fail(new Error('the answer carried no authorization code'))
        return
      }
      answer(200, 'ClaudeVR is linked', 'You can close this tab and go back to the terminal.')
      clearTimeout(timer)
      ok(code)
    })
  })
}

export async function linkT3(o: LinkOptions): Promise<LinkOutcome> {
  const fetch = o.fetch ?? ((url, init) => globalThis.fetch(url, init))
  const now = o.now ?? Date.now
  const origin = new URL(o.origin).origin
  const timed = (init: RequestInit = {}): RequestInit => ({ ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })

  o.say(`Asking T3 at ${origin} how to sign in.`)
  const meta = await readJson(await fetch(`${origin}/.well-known/oauth-authorization-server`, timed()), 'discovery')
  const registration = onOrigin(meta.registration_endpoint, origin, 'registration endpoint')
  const authorize = onOrigin(meta.authorization_endpoint, origin, 'authorization endpoint')
  const tokenUrl = onOrigin(meta.token_endpoint, origin, 'token endpoint')
  const methods = Array.isArray(meta.code_challenge_methods_supported) ? meta.code_challenge_methods_supported : []
  if (!methods.includes('S256')) throw new Error('T3 does not offer PKCE S256; refusing to link without it')
  const issuer = typeof meta.issuer === 'string' ? meta.issuer : origin

  const server = await listenLoopback()
  try {
    const port = (server.address() as AddressInfo).port
    const redirectUri = `http://127.0.0.1:${port}/callback`

    const reg = await readJson(
      await fetch(registration, timed({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: CLIENT_NAME, redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }) })),
      'registration',
    )
    const clientId = reg.client_id
    if (typeof clientId !== 'string' || !clientId) throw new Error('registration: T3 gave no client id')
    o.say(`Registered "${CLIENT_NAME}" with T3.`)

    const verifier = b64url(randomBytes(32))
    const challenge = b64url(createHash('sha256').update(verifier).digest())
    const state = b64url(randomBytes(24))
    const url = new URL(authorize)
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      resource: `${origin}/mcp`,
    }).toString()

    const timeoutMs = o.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS
    // Settled into a value at once, so a refusal that lands while the browser opens is not an unhandled rejection.
    const callback = awaitCallback(server, state, issuer, timeoutMs).then(
      code => ({ code }),
      (error: Error) => ({ error }),
    )
    o.say('Opening T3\'s approval page in your browser. If it does not open, visit:')
    o.say(`  ${url.href}`)
    o.say('On that page choose "Full access" (threads that run in full access refuse a narrower link), then approve.')
    try {
      await o.openUrl(url.href)
    } catch (err) {
      o.say(`Could not open the browser (${(err as Error).message}); use the address above.`)
    }
    const answer = await callback
    if ('error' in answer) throw answer.error
    const code = answer.code
    o.say('T3 approved. Collecting the token.')

    const tok = await readJson(
      await fetch(
        tokenUrl,
        timed({
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource: `${origin}/mcp` }).toString(),
        }),
      ),
      'token',
    )
    const accessToken = tok.access_token
    if (typeof accessToken !== 'string' || !accessToken) throw new Error('token: T3 gave no access token')
    if (typeof tok.token_type === 'string' && tok.token_type.toLowerCase() !== 'bearer') throw new Error(`token: T3 gave a ${tok.token_type.slice(0, 20)} token, and the bridge only sends Bearer tokens`)
    const at = now()
    const expiresIn = typeof tok.expires_in === 'number' && tok.expires_in > 0 ? tok.expires_in : null
    const link: T3Link = {
      version: 1,
      origin,
      clientId,
      clientName: CLIENT_NAME,
      accessToken,
      scope: typeof tok.scope === 'string' ? tok.scope : '',
      linkedAt: new Date(at).toISOString(),
      expiresAt: expiresIn === null ? null : new Date(at + expiresIn * 1000).toISOString(),
    }
    writeLink(o.linkFile, link)
    return { scope: link.scope, expiresAt: link.expiresAt }
  } finally {
    server.closeAllConnections()
    server.close()
  }
}
