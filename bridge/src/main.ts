// Starts the bridge: config, certificate, pairing token, backend, server.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, REPO_ROOT } from './config.ts'
import { ensureCert } from './cert.ts'
import { loadOrCreateToken } from './gate.ts'
import { createBridge } from './server.ts'
import { DashwebAdapter } from './backend/dashweb/adapter.ts'
import { FakeAdapter } from './backend/fake.ts'
import type { SessionBackend } from './backend/types.ts'
import { HelperStt, NoStt, type SttProvider } from './voice/stt.ts'
import { NoTts, SayTts, type TtsProvider } from './voice/tts.ts'

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a)

function main(): void {
  const cfg = loadConfig(process.env, log)
  const certs = ensureCert(join(cfg.stateDir, 'certs'), log)
  const { token, created } = loadOrCreateToken(join(cfg.stateDir, 'pairing-token'), log)

  const backend: SessionBackend = cfg.backend === 'dashweb' && cfg.dashweb ? new DashwebAdapter(cfg.dashweb) : FakeAdapter.fromFixtures(cfg.fixturesDir)

  const stt: SttProvider =
    cfg.stt.provider === 'off'
      ? new NoStt()
      : new HelperStt({ engine: cfg.stt.provider, python: cfg.stt.python, script: join(REPO_ROOT, 'bridge', 'stt', 'helper.py'), model: cfg.stt.model, cacheDir: cfg.stt.cacheDir, log: (...a) => log('[stt]', ...a) })
  let tts: TtsProvider = new NoTts()
  if (cfg.tts.provider === 'say') {
    const say = new SayTts({ voice: cfg.tts.voice, maxChars: cfg.tts.maxChars, ffmpeg: cfg.ffmpeg, log: (...a) => log('[tts]', ...a) })
    void say.check().then(st => log(`[tts] ${st.provider}: ${st.ok ? 'ready' : `unavailable: ${st.error}`}`))
    tts = say
  }

  const bridge = createBridge({
    backend,
    token,
    allowIps: cfg.allowIps,
    autoPair: cfg.autoPair,
    clientDir: cfg.clientDir,
    probeLog: join(cfg.stateDir, 'probe.log'),
    cert: readFileSync(certs.cert),
    key: readFileSync(certs.key),
    sendsPerMinute: cfg.sendsPerMinute,
    sendsPerHour: cfg.sendsPerHour,
    log,
    stt,
    tts,
    ffmpeg: cfg.ffmpeg,
    clipMaxSeconds: cfg.stt.maxSeconds,
    clipMaxBytes: cfg.stt.maxBytes,
    callsigns: cfg.callsigns,
    devReload: cfg.dev,
  })

  bridge.server.on('error', err => {
    log('server error:', err.message)
    process.exit(1)
  })
  bridge.server.listen(cfg.port, cfg.host, () => {
    const hosts = certs.names.filter(n => n !== 'localhost')
    const lines = [
      '',
      `ClaudeVR bridge on https://${cfg.host}:${cfg.port}  backend: ${backend.name}`,
      `  supports: ${Object.entries(backend.capabilities).filter(([, v]) => v).map(([k]) => k).join(', ')}`,
      `  allowed clients: loopback${cfg.allowIps.length ? ', ' + cfg.allowIps.join(', ') : ' only (set allowIps or CLAUDEVR_ALLOW_IPS for the headset)'}`,
      `  certificate covers: ${certs.names.join(', ')}`,
      `  speech-to-text: ${cfg.stt.provider === 'off' ? 'off' : `${cfg.stt.provider} (${cfg.stt.model}), loading in the background`}   text-to-speech: ${cfg.tts.provider === 'off' ? 'off' : `say -v ${cfg.tts.voice}`}`,
      ...(cfg.callsigns.length ? [`  callsign overrides: ${cfg.callsigns.map(c => `${c.match} -> ${c.callsign}`).join(', ')}`] : []),
      ...(cfg.dev ? ['  dev: open HUDs reload when the client is rebuilt'] : []),
      '',
      ...hosts.flatMap(h => [`  HUD    https://${h}:${cfg.port}/`, `  probe  https://${h}:${cfg.port}/probe`]),
      '',
      cfg.autoPair
        ? '  pairing: automatic for allowed clients, nothing to type. The allow list is the only gate.'
        : '  pairing: type the token below once per browser, or set autoPair to skip that.',
      `  pairing token${created ? ' (new)' : ''}: ${token}`,
      `  (kept in ${join(cfg.stateDir, 'pairing-token')}; delete that file to make a new one)`,
      '',
    ]
    console.log(lines.join('\n'))
  })

  const stop = (sig: string) => {
    log(`${sig}: stopping`)
    backend.close()
    stt.close()
    bridge.close().then(
      () => process.exit(0),
      err => {
        log('error while stopping:', err)
        process.exit(1)
      },
    )
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))
}

try {
  main()
} catch (err) {
  log('bridge failed to start:', err instanceof Error ? err.message : err)
  process.exit(1)
}
