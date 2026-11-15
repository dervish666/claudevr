// A self-signed certificate for the bridge. The headset's mic needs a secure
// context, so the page has to come over HTTPS even on the LAN. openssl makes
// it; its SANs cover localhost, 127.0.0.1 and every IPv4 address this machine
// has right now, and it is made again when those change.

import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'

export interface CertFiles {
  cert: string
  key: string
}

/** This machine's IPv4 addresses other than loopback and link-local, LAN first. */
export function lanAddresses(): string[] {
  const out: string[] = []
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue
      out.push(a.address)
    }
  }
  const lan = (ip: string) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)
  return out.sort((a, b) => Number(lan(b)) - Number(lan(a)))
}

/** "DNS:localhost, IP Address:127.0.0.1" -> ["localhost", "127.0.0.1"]. */
export function sansOf(certPem: string): string[] {
  const alt = new X509Certificate(certPem).subjectAltName ?? ''
  return alt
    .split(',')
    .map(s => s.trim().replace(/^(DNS|IP Address):/, ''))
    .filter(Boolean)
}

export function certPaths(dir: string): CertFiles {
  return { cert: join(dir, 'cert.pem'), key: join(dir, 'key.pem') }
}

/** Why the certificate in `dir` will not do, or null if it will. */
export function certProblem(dir: string, want: string[], now = Date.now()): string | null {
  const p = certPaths(dir)
  if (!existsSync(p.cert) || !existsSync(p.key)) return 'no certificate yet'
  let pem: string
  try {
    pem = readFileSync(p.cert, 'utf8')
  } catch (err) {
    return `certificate unreadable: ${(err as Error).message}`
  }
  let x: X509Certificate
  try {
    x = new X509Certificate(pem)
  } catch (err) {
    return `certificate unparseable: ${(err as Error).message}`
  }
  if (Date.parse(x.validTo) - now < 7 * 86_400_000) return `certificate expires ${x.validTo}`
  const have = new Set(sansOf(pem))
  const missing = want.filter(w => !have.has(w))
  return missing.length ? `certificate does not cover ${missing.join(', ')}` : null
}

export function makeCert(dir: string, names: string[]): CertFiles {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const p = certPaths(dir)
  const san = names.map(n => (/^[\d.]+$/.test(n) || n.includes(':') ? `IP:${n}` : `DNS:${n}`)).join(',')
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
      '-keyout', p.key, '-out', p.cert,
      // Under 398 days, the most some browsers accept for a leaf certificate.
      '-days', '397',
      '-subj', '/CN=ClaudeVR bridge',
      '-addext', `subjectAltName=${san}`,
      '-addext', 'basicConstraints=critical,CA:FALSE',
      '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment',
      '-addext', 'extendedKeyUsage=serverAuth',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  execFileSync('chmod', ['600', p.key])
  return p
}

/** The certificate to serve with, made or remade when it is missing, expiring or no longer covers this machine's addresses. */
export function ensureCert(dir: string, log: (...a: unknown[]) => void, force = false): CertFiles & { names: string[] } {
  const names = ['localhost', '127.0.0.1', ...lanAddresses()]
  const problem = force ? 'asked for a new one' : certProblem(dir, names)
  if (problem) {
    log(`making a certificate (${problem}) for ${names.join(', ')}`)
    log('the headset will need to accept the new certificate once')
    makeCert(dir, names)
  }
  return { ...certPaths(dir), names: sansOf(readFileSync(certPaths(dir).cert, 'utf8')) }
}
