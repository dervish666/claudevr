// npm run cert: make the bridge's self-signed certificate now, for
// localhost, 127.0.0.1 and this machine's current addresses. The bridge does
// this by itself on start when the certificate is missing or no longer
// covers this machine's addresses; this forces a new one.
import { join } from 'node:path'
import { loadConfig } from '../bridge/src/config.ts'
import { ensureCert } from '../bridge/src/cert.ts'

const cfg = loadConfig(process.env, console.log)
const dir = join(cfg.stateDir, 'certs')
const c = ensureCert(dir, console.log, process.argv.includes('--force'))
console.log(`certificate: ${c.cert}\nkey:         ${c.key}\ncovers:      ${c.names.join(', ')}`)
