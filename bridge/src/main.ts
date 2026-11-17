// Starts the bridge: config, certificate, paired devices, backend, server.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, REPO_ROOT } from './config.ts'
import { ensureCert } from './cert.ts'
import { DeviceStore, notifyMac, PairingRequests } from './pairing.ts'
import { createBridge } from './server.ts'
import { DashwebAdapter } from './backend/dashweb/adapter.ts'
import { FakeAdapter } from './backend/fake.ts'
import { T3Adapter } from './backend/t3/adapter.ts'
import { ClaudeAdapter } from './backend/claude/adapter.ts'
import { ModHub } from './backend/claude/hub.ts'
import { ModListener } from './mod-listener.ts'
import type { SessionBackend } from './backend/types.ts'
import { HelperStt, NoStt, type SttProvider } from './voice/stt.ts'
import { FishTts, NoTts, SayTts, type TtsProvider } from './voice/tts.ts'
import { CliFrontMan, NoFrontMan, type FrontMan } from './persona/frontman.ts'
import { Persona } from './persona/persona.ts'
import { ThemeStore } from './themes.ts'

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a)

function main(): void {
  const cfg = loadConfig(process.env, log)
  const certs = ensureCert(join(cfg.stateDir, 'certs'), log)
  const legacyFile = join(cfg.stateDir, 'pairing-token')
  const devices = new DeviceStore({ file: join(cfg.stateDir, 'devices.json'), legacyFile, log })
  const pairing = new PairingRequests({ devices, log })

  let backend: SessionBackend
  // The mod listener runs only for the claude backend: no other backend reads
  // the reports, and a discovery file with nobody behind it would only lead
  // mods to post into nothing.
  let modListener: ModListener | null = null
  if (cfg.backend === 'dashweb' && cfg.dashweb) backend = new DashwebAdapter(cfg.dashweb)
  else if (cfg.backend === 'claude') {
    const hub = new ModHub({ log: (...a) => log('[claude]', ...a) })
    if (cfg.mod.port === cfg.port) throw new Error(`mod.port and port are both ${cfg.port}; the mod listener needs a port of its own`)
    if (cfg.mod.port) {
      const listener = new ModListener({ hub, port: cfg.mod.port, bridgeFile: cfg.mod.bridgeFile, log: (...a) => log('[mod]', ...a) })
      modListener = listener
      listener.start().catch((err: Error) => log('[mod] could not start:', err.message))
    }
    backend = new ClaudeAdapter(hub, {
      log: (...a) => log('[claude]', ...a),
      listenerProblem: () => (modListener ? modListener.problem : 'the mod listener is off (mod.port is 0), so no Claude Code session can report'),
    })
    log(`claude backend: sessions report to the mod listener ${cfg.mod.port ? `on 127.0.0.1:${cfg.mod.port}` : '(off: mod.port is 0)'}`)
  }
  else if (cfg.backend === 't3' && cfg.t3) {
    backend = new T3Adapter(cfg.t3, { log: (...a) => log('[t3]', ...a) })
    log(`t3 backend: ${cfg.t3.t3BaseDir}, threads changed in the last ${cfg.t3.activeHours} h, polled every ${cfg.t3.pollMs} ms`)
  } else {
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

  // Theme packs, private like the characters: <state dir>/themes/<name>/ (or CLAUDEVR_THEMES_DIR).
  const themes = new ThemeStore({ dir: cfg.themesDir, log })
  void themes.list().then(
    l => {
      log(`themes: ${l.themes.length ? l.themes.map(t => t.name).join(', ') : 'none'} in ${themes.dir}${l.invalid.length ? `; not usable: ${l.invalid.map(i => i.name).join(', ')}` : ''}`)
      for (const c of cfg.characters) {
        const want = themes.resolve(c)
        if (want && !l.themes.some(t => t.name === want)) log(`themes: character ${c.name} wears ${want}, which is not a usable pack; the HUD shows the default look and says why`)
      }
    },
    (err: unknown) => log('themes: cannot read', themes.dir, (err as Error).message),
  )

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
      themeOf: c => themes.resolve(c),
      log: (...a) => log('[persona]', ...a),
    })
    log(`[persona] characters: ${cfg.characters.map(c => c.name).join(', ')}; ${persona.current() ? `character: ${persona.current()!.name}` : 'operator mode'}; front man: ${fm.provider === 'cli' ? `${fm.bin} (${fm.model})` : 'off'}`)
  }

  const bridge = createBridge({
    backend,
    devices,
    pairing,
    notify: process.platform === 'darwin' ? text => notifyMac(text, log) : undefined,
    allowIps: cfg.allowIps,
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
    themes,
  })

  bridge.server.on('error', err => {
    log('server error:', err.message)
    process.exit(1)
  })
  bridge.server.listen(cfg.port, cfg.host, () => {
    const hosts = certs.names.filter(n => n !== 'localhost')
    const lan = hosts.find(h => !/^127\./.test(h) && h !== '::1') ?? "<this machine's LAN address>"
    const paired = devices.list().length
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
      // Never the token itself. This goes to a terminal and its scrollback.
      `  paired devices: ${paired}; legacy token: ${devices.legacyActive() ? `active (${legacyFile}); revoke it at https://localhost:${cfg.port}/pair` : 'none'}`,
      `  To pair a device: open https://${lan}:${cfg.port} on it and enter the code it shows at https://localhost:${cfg.port}/pair`,
      '',
    ]
    console.log(lines.join('\n'))
  })

  const stop = (sig: string) => {
    log(`${sig}: stopping`)
    backend.close()
    const modClosed = modListener?.close() ?? Promise.resolve()
    stt.close()
    persona?.close()
    Promise.all([bridge.close(), modClosed]).then(
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
