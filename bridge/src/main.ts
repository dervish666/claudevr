// Starts the bridge: config, certificate, pairing token, backend, server.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, REPO_ROOT } from './config.ts'
import { ensureCert } from './cert.ts'
import { loadOrCreateToken } from './gate.ts'
import { createBridge } from './server.ts'
import { DashwebAdapter } from './backend/dashweb/adapter.ts'
import { FakeAdapter } from './backend/fake.ts'
import type { SessionBackend } from './backend/types.ts'
import { HelperStt, NoStt, type SttProvider } from './voice/stt.ts'
import { FishTts, NoTts, SayTts, type TtsProvider } from './voice/tts.ts'
import { CliFrontMan, NoFrontMan, type FrontMan } from './persona/frontman.ts'
import { Persona } from './persona/persona.ts'

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a)

function main(): void {
  const cfg = loadConfig(process.env, log)
  const certs = ensureCert(join(cfg.stateDir, 'certs'), log)
  const { token, created } = loadOrCreateToken(join(cfg.stateDir, 'pairing-token'), log)

  let backend: SessionBackend
  if (cfg.backend === 'dashweb' && cfg.dashweb) backend = new DashwebAdapter(cfg.dashweb)
  else {
    const fake = FakeAdapter.fromFixtures(cfg.fixturesDir, { file: cfg.fakeFleet })
    if (cfg.fakeLiveMs > 0) fake.startLive(cfg.fakeLiveMs)
    log(`fake backend: ${cfg.fakeFleet}${cfg.fakeLiveMs > 0 ? `, a demo change every ${cfg.fakeLiveMs} ms` : ''}`)
    backend = fake
  }

  const stt: SttProvider =
    cfg.stt.provider === 'off'
      ? new NoStt()
      : new HelperStt({ engine: cfg.stt.provider, python: cfg.stt.python, script: join(REPO_ROOT, 'bridge', 'stt', 'helper.py'), model: cfg.stt.model, cacheDir: cfg.stt.cacheDir, log: (...a) => log('[stt]', ...a) })
  let tts: TtsProvider = new NoTts()
  if (cfg.tts.provider === 'say') {
    const say = new SayTts({ voice: cfg.tts.voice, maxChars: cfg.tts.maxChars, ffmpeg: cfg.ffmpeg, log: (...a) => log('[tts]', ...a) })
    void say.check().then(st => log(`[tts] ${st.provider}: ${st.ok ? 'ready' : `unavailable: ${st.error}`}`))
    tts = say
  } else if (cfg.tts.provider === 'fish' && cfg.tts.fish) {
    const f = cfg.tts.fish
    // macOS `say` stands in when fish.audio cannot speak.
    let fallback: SayTts | undefined
    if (process.platform === 'darwin') {
      fallback = new SayTts({ voice: 'Daniel', maxChars: cfg.tts.maxChars, ffmpeg: cfg.ffmpeg, log: (...a) => log('[tts]', ...a) })
      void fallback.check()
    }
    // The voice last chosen by speech wins over the config, so it survives a restart.
    const voiceFile = join(cfg.stateDir, 'tts-voice')
    let voice = cfg.tts.voice
    try {
      const kept = readFileSync(voiceFile, 'utf8').trim()
      if (f.voices.some(v => v.name === kept)) voice = kept
      else log(`[tts] ${voiceFile} names ${JSON.stringify(kept)}, which is not a configured voice; using ${voice}`)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log(`[tts] could not read ${voiceFile}: ${(err as Error).message}`)
    }
    const remember = (name: string) => {
      try {
        writeFileSync(voiceFile, name + '\n')
      } catch (err) {
        log(`[tts] could not save the voice choice to ${voiceFile}: ${(err as Error).message}`)
      }
    }
    const fishTts = new FishTts({ apiKey: f.apiKey, keyHint: f.keyHint, model: f.model, voices: f.voices, voice, maxChars: cfg.tts.maxChars, fallback, remember, log: (...a) => log('[tts]', ...a) })
    const st = fishTts.status()
    log(`[tts] ${st.provider}${st.ok ? '' : `: unavailable: ${st.error}`}; voices: ${f.voices.map(v => v.name).join(', ')}`)
    tts = fishTts
  }

  // Character mode, only when characters are configured. The choice made by
  // voice is kept in <state>/character (empty for operator mode) and wins
  // over the config's `character` on the next start.
  let persona: Persona | undefined
  if (cfg.characters.length) {
    const characterFile = join(cfg.stateDir, 'character')
    let initial = cfg.character
    try {
      const kept = readFileSync(characterFile, 'utf8').trim()
      if (!kept) initial = null
      else if (cfg.characters.some(c => c.name === kept)) initial = kept
      else log(`[persona] ${characterFile} names ${JSON.stringify(kept)}, which is not a configured character; using ${initial ?? 'operator mode'}`)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log(`[persona] could not read ${characterFile}: ${(err as Error).message}`)
    }
    const fm = cfg.frontMan
    const make = (role: string): FrontMan =>
      fm.provider === 'cli' ? new CliFrontMan({ bin: fm.bin, model: fm.model, cwd: join(cfg.stateDir, 'frontman', role), log: (...a) => log(`[frontman:${role}]`, ...a) }) : new NoFrontMan()
    persona = new Persona({ warmUp: true,
      characters: cfg.characters,
      frontMan: make('lines'),
      classifier: make('classify'),
      tts,
      stateFile: characterFile,
      initial,
      lineTimeoutMs: fm.lineTimeoutMs,
      classifyTimeoutMs: fm.classifyTimeoutMs,
      announceGapMs: fm.announceGapMs,
      log: (...a) => log('[persona]', ...a),
    })
    log(`[persona] characters: ${cfg.characters.map(c => c.name).join(', ')}; ${persona.current() ? `character: ${persona.current()!.name}` : 'operator mode'}; front man: ${fm.provider === 'cli' ? `${fm.bin} (${fm.model})` : 'off'}`)
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
    persona,
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
      `  speech-to-text: ${cfg.stt.provider === 'off' ? 'off' : `${cfg.stt.provider} (${cfg.stt.model}), loading in the background`}   text-to-speech: ${tts.status().provider}`,
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
    persona?.close()
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
