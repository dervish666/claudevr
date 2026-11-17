// The bridge's certificates. The headset's mic needs a secure context, so the
// page has to come over HTTPS even on the LAN. openssl makes them.
//
// A local CA (ca.pem, ca-key.pem) is made once and kept. It signs the server
// certificate (cert.pem, key.pem), whose SANs cover localhost, 127.0.0.1 and
// every IPv4 address this machine has right now; only that one is made again
// when the addresses change. A device that pins the CA (the Godot client)
// keeps working across those changes; a browser that clicked through the
// warning sees it once more for each new server certificate.

import { execFileSync } from 'node:child_process'
import { randomBytes, X509Certificate } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

export function caPaths(dir: string): CertFiles {
  return { cert: join(dir, 'ca.pem'), key: join(dir, 'ca-key.pem') }
}

/** "AB:CD:..": SHA-256 of the certificate's DER, as browsers and openssl show it. */
export function fingerprint(pem: string | Buffer): string {
  return new X509Certificate(pem).fingerprint256
}

/** Whether `leafPem` was issued and signed by `caPem`. */
export function signedBy(leafPem: string | Buffer, caPem: string | Buffer): boolean {
  const leaf = new X509Certificate(leafPem)
  const ca = new X509Certificate(caPem)
  return leaf.checkIssued(ca) && leaf.verify(ca.publicKey)
}

/**
 * The CA in `dir`, made when there is none. One that is there but cannot be
 * read is an error, not a reason to make another: a new CA breaks every
 * device that pinned the old one, so that is for a person to decide (delete
 * ca.pem and ca-key.pem, then pair those devices again).
 */
export function ensureCa(dir: string, log: (...a: unknown[]) => void, now = Date.now()): CertFiles & { created: boolean } {
  const p = caPaths(dir)
  const have = existsSync(p.cert) && existsSync(p.key)
  if (have) {
    const x = new X509Certificate(readFileSync(p.cert))
    if (!x.ca) throw new Error(`${p.cert} is not a CA certificate; delete ca.pem and ca-key.pem to make a new CA (pinned devices then pair again)`)
    if (Date.parse(x.validTo) - now < 30 * 86_400_000) log(`the bridge CA expires ${x.validTo}; delete ${p.cert} and ${p.key} to make a new one, then pair pinned devices again`)
    return { ...p, created: false }
  }
  if (existsSync(p.cert) || existsSync(p.key)) throw new Error(`half a CA in ${dir} (one of ca.pem, ca-key.pem is missing); delete both to make a new one`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
      '-keyout', p.key, '-out', p.cert,
      '-days', '3650',
      '-subj', '/CN=ClaudeVR local CA',
      '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  chmodSync(p.key, 0o600)
  log(`made the bridge CA at ${p.cert} (SHA-256 ${fingerprint(readFileSync(p.cert))})`)
  return { ...p, created: true }
}

/** Why the certificate in `dir` will not do, or null if it will. With `caPem`, it must also be signed by that CA. */
export function certProblem(dir: string, want: string[], now = Date.now(), caPem?: string | Buffer): string | null {
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
  if (missing.length) return `certificate does not cover ${missing.join(', ')}`
  if (caPem && !signedBy(pem, caPem)) return 'certificate is not signed by the bridge CA'
  return null
}

const sanOf = (names: string[]) => names.map(n => (/^[\d.]+$/.test(n) || n.includes(':') ? `IP:${n}` : `DNS:${n}`)).join(',')

/**
 * The server certificate for `names`: signed by `ca` when given, else
 * self-signed (as before the CA; tests use that). Written beside the old
 * one and renamed over it, so a failure never leaves a key without its certificate.
 */
export function makeCert(dir: string, names: string[], ca?: CertFiles): CertFiles {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const p = certPaths(dir)
  if (ca) {
    const tag = randomBytes(4).toString('hex')
    const tmp = { cert: `${p.cert}.${tag}.tmp`, key: `${p.key}.${tag}.tmp`, csr: join(dir, `leaf.${tag}.csr`), ext: join(dir, `leaf.${tag}.ext`) }
    const serial = randomBytes(16)
    serial[0] = serial[0]! & 0x7f
    try {
      writeFileSync(tmp.ext, ['[v3]', `subjectAltName=${sanOf(names)}`, 'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth', 'subjectKeyIdentifier=hash', 'authorityKeyIdentifier=keyid', ''].join('\n'))
      execFileSync('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', tmp.key, '-out', tmp.csr, '-subj', '/CN=ClaudeVR bridge'], { stdio: ['ignore', 'ignore', 'pipe'] })
      chmodSync(tmp.key, 0o600)
      // Under 398 days, the most some browsers accept for a leaf certificate.
      execFileSync('openssl', ['x509', '-req', '-in', tmp.csr, '-CA', ca.cert, '-CAkey', ca.key, '-set_serial', `0x${serial.toString('hex')}`, '-days', '397', '-sha256', '-extfile', tmp.ext, '-extensions', 'v3', '-out', tmp.cert], { stdio: ['ignore', 'ignore', 'pipe'] })
      renameSync(tmp.key, p.key)
      renameSync(tmp.cert, p.cert)
    } finally {
      for (const f of Object.values(tmp)) rmSync(f, { force: true })
    }
    return p
  }
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
      '-keyout', p.key, '-out', p.cert,
      // Under 398 days, the most some browsers accept for a leaf certificate.
      '-days', '397',
      '-subj', '/CN=ClaudeVR bridge',
      '-addext', `subjectAltName=${sanOf(names)}`,
      '-addext', 'basicConstraints=critical,CA:FALSE',
      '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment',
      '-addext', 'extendedKeyUsage=serverAuth',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  execFileSync('chmod', ['600', p.key])
  return p
}

/**
 * The CA, and the server certificate to serve with: made or remade when it
 * is missing, expiring, no longer covers this machine's addresses (plus
 * `extraNames`), or is not signed by the CA. The last is the one-time move
 * from the self-signed certificate of older bridges.
 */
export function ensureCert(dir: string, log: (...a: unknown[]) => void, force = false, extraNames: string[] = [], addresses: string[] = lanAddresses()): CertFiles & { names: string[]; ca: string; caFingerprint: string } {
  const ca = ensureCa(dir, log)
  const caPem = readFileSync(ca.cert)
  const names = [...new Set(['localhost', '127.0.0.1', ...addresses, ...extraNames])]
  const problem = force ? 'asked for a new one' : certProblem(dir, names, Date.now(), caPem)
  if (problem) {
    log(`making a server certificate (${problem}) for ${names.join(', ')}, signed by the bridge CA`)
    log('a browser that accepted the old certificate shows the warning once more; devices that pin the CA are unaffected')
    makeCert(dir, names, ca)
  }
  return { ...certPaths(dir), names: sansOf(readFileSync(certPaths(dir).cert, 'utf8')), ca: ca.cert, caFingerprint: fingerprint(caPem) }
}
