// The bridge's settings: built-in defaults, then the local config file, then
// environment variables, each overriding the one before. Nothing personal
// lives in this file: a machine's paths, ports and URLs go in the local file
// (gitignored, under the state directory) or the environment.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { COMMAND_WORDS, type CallsignOverride } from './backend/callsign.ts'
import { FILLERS, normalise } from './voice/grammar.ts'
import type { Character } from './persona/prompt.ts'
import { PACK_NAME } from '../../shared/theme.ts'

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..')

export interface DashwebConfig {
  /** dashweb's base URL, e.g. http://127.0.0.1:<port>. */
  url: string
  /** The T3 CLI. */
  t3Bin: string
  /** T3's home, passed as --base-dir. */
  t3BaseDir: string
  pollMs: number
  /** Working directories whose sessions are the bridge's own and stay out of the fleet. */
  hideCwds?: string[]
  /**
   * t3.delivery. "auto": with a T3 link, a send starts an idle thread or goes
   * into the running turn. "queue": always the CLI, which queues.
   */
  t3Delivery?: 'auto' | 'queue'
  /** Where npm run t3-link keeps the link; no MCP sends without it. */
  t3LinkFile?: string
}

/** The t3 backend: T3 Code alone, read and sent to over its MCP endpoint with the link. */
export interface T3Config {
  /** T3's home, where userdata/server-runtime.json names its origin. */
  t3BaseDir: string
  pollMs: number
  /** t3.activeHours: a thread shows when it changed this recently, or is running or waiting now. */
  activeHours: number
  /** Where npm run t3-link keeps the link; nothing is read or sent without it. */
  t3LinkFile: string
}

/** The mod listener the claude backend is fed by (docs/mod-protocol.md). */
export interface ModConfig {
  /** Plain HTTP on 127.0.0.1; 0 for off. */
  port: number
  /** The discovery file the mods read: ~/.claudevr/bridge.json, or CLAUDEVR_BRIDGE_FILE. */
  bridgeFile: string
}

export interface SttConfig {
  /** "parakeet" (parakeet-mlx, Apple silicon), "whisper" (faster-whisper) or "off". */
  provider: 'parakeet' | 'whisper' | 'off'
  /** The Python that runs bridge/stt/helper.py, with the engine installed. */
  python: string
  model: string
  /** Where model weights are downloaded; null for the library's default cache. */
  cacheDir: string | null
  maxSeconds: number
  maxBytes: number
}

export interface FishConfig {
  /** fish.audio's speech model, sent as the `model` header. */
  model: string
  voices: { name: string; id: string; heardAs: string[] }[]
  /** From FISH_API_KEY, or the key file. Null when neither has one. */
  apiKey: string | null
  /** Where the key was looked for, for the message when there is none. */
  keyHint: string
}

export interface TtsConfig {
  provider: 'say' | 'fish' | 'off'
  /** A macOS voice for `say`; the name of one of fish.voices for `fish`. */
  voice: string
  maxChars: number
  fish: FishConfig | null
}

export interface FrontManConfig {
  /** "cli": a long-lived `claude -p` on the subscription. "off": every line is the plain one. */
  provider: 'cli' | 'off'
  /** The `claude` binary. */
  bin: string
  model: string
  /** Longest wait for a spoken line before the plain one is used. */
  lineTimeoutMs: number
  /** Longest wait for a free-form command to be classified before the grammar's reading stands. */
  classifyTimeoutMs: number
  /** At most one unprompted line per this many ms. */
  announceGapMs: number
}

const STT_MODELS = { parakeet: 'mlx-community/parakeet-tdt-0.6b-v3', whisper: 'small.en' }
/** parakeet-mlx needs MLX, so Apple silicon; everything else gets faster-whisper. */
export const DEFAULT_STT: 'parakeet' | 'whisper' = process.platform === 'darwin' && process.arch === 'arm64' ? 'parakeet' : 'whisper'

export interface Config {
  backend: 'fake' | 'dashweb' | 't3' | 'claude'
  host: string
  port: number
  /** Client IPs allowed besides loopback. */
  allowIps: string[]
  /** Names the server certificate covers besides localhost, 127.0.0.1 and this machine's addresses (a .local hostname). */
  certNames: string[]
  stateDir: string
  /** Theme packs, one folder each: <stateDir>/themes unless CLAUDEVR_THEMES_DIR names another (the repo's themes/ for a demo). */
  themesDir: string
  clientDir: string
  fixturesDir: string
  /** The fake backend's fleet: a file name inside fixturesDir. */
  fakeFleet: string
  /** The fake backend's demo motion, one change every this many ms; 0 for none. */
  fakeLiveMs: number
  sendsPerMinute: number
  sendsPerHour: number
  dashweb: DashwebConfig | null
  t3: T3Config | null
  mod: ModConfig
  stt: SttConfig
  tts: TtsConfig
  ffmpeg: string
  /** Project or session -> spoken callsign, from the private config. */
  callsigns: CallsignOverride[]
  /** Character mode's characters; none means operator mode only. */
  characters: Character[]
  /** The character to start with when nothing was chosen by voice; null for operator mode. */
  character: string | null
  frontMan: FrontManConfig
  /** Set by npm run dev: the HUD reloads itself when the client is rebuilt. */
  dev: boolean
}

type Env = Record<string, string | undefined>

const expandHome = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)
/** Absolute and normalised: "/x/client/dist/" and "/x/a/../client/dist" both give "/x/client/dist", which the static file check relies on. */
const absolute = (p: string, base: string) => {
  const e = expandHome(p)
  return isAbsolute(e) ? resolve(e) : resolve(base, e)
}

function readLocal(path: string, log: (...a: unknown[]) => void): Record<string, unknown> {
  try {
    const d: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof d !== 'object' || d === null || Array.isArray(d)) throw new Error('not a JSON object')
    log('config file:', path)
    return d as Record<string, unknown>
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      log('no config file at', path, '(defaults and environment only)')
      return {}
    }
    // A config file that is there but broken must stop the bridge, not be skipped.
    throw new Error(`${path}: ${e.message}`)
  }
}

const list = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string').map(s => s.trim()).filter(Boolean)
    : typeof v === 'string'
      ? v.split(',').map(s => s.trim()).filter(Boolean)
      : []

function int(v: unknown, fallback: number, name: string): number {
  if (v === undefined || v === '') return fallback
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(v)}`)
  return n
}

/**
 * Every poll pushes to the open HUDs, and a HUD drops a socket that has heard
 * nothing for 15 s (client/src/hud/link.ts). Past 10 s a quiet fleet would
 * make every HUD reconnect over and over.
 */
export const MAX_POLL_MS = 10_000
function pollMs(n: number, name = 'dashweb.pollMs'): number {
  if (n > MAX_POLL_MS) throw new Error(`${name}: at most ${MAX_POLL_MS} ms, got ${n}; every poll is what keeps the HUD's link alive, and a HUD drops a link that is silent for 15 s`)
  return n
}

/** A TCP port, or 0 for off. */
function port(v: unknown, fallback: number, name: string): number {
  if (v === undefined || v === '') return fallback
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${name} must be a port number, or 0 for off, got ${JSON.stringify(v)}`)
  return n
}

function bool(v: unknown, fallback: boolean, name: string): boolean {
  if (v === undefined || v === '') return fallback
  if (v === true || v === 'true' || v === '1') return true
  if (v === false || v === 'false' || v === '0') return false
  throw new Error(`${name} must be true or false, got ${JSON.stringify(v)}`)
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/**
 * The first word of a name as the grammar will hear it, if that is a command,
 * a confirm or a cancel: "Send" or "Yep" would confirm an armed card, "Status
 * Board" would answer status. The grammar drops fillers first, so "Please
 * Status" is heard as "status" (refused) and "Hey Jose" as "jose" (fine); a
 * name of fillers alone could never be heard. Derived callsigns already step
 * round these words (callsign.ts); an override is taken as written, so it is
 * checked here.
 */
function commandWordIn(name: string): string | null {
  const words = normalise(name).split(' ').filter(Boolean)
  const first = words.find(w => !FILLERS.has(w))
  if (first === undefined) return words[0] ?? name
  return COMMAND_WORDS.has(first) ? first : null
}

/**
 * "callsigns": { "claudevr": "Claude" } or
 * "callsigns": { "claudevr": { "callsign": "Claude", "heardAs": ["Jose"] } }.
 * The key is a project name or a session id.
 */
export function parseCallsigns(v: unknown): CallsignOverride[] {
  if (v === undefined) return []
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('callsigns must be an object of project or session id -> callsign')
  return Object.entries(v as Record<string, unknown>).map(([match, val]) => {
    const o = typeof val === 'string' ? { callsign: val } : obj(val)
    const callsign = typeof o.callsign === 'string' ? o.callsign.trim() : ''
    if (!/^[A-Za-z][A-Za-z ]{0,30}$/.test(callsign)) throw new Error(`callsigns.${match}: a callsign is one to a few plain words, got ${JSON.stringify(o.callsign)}`)
    const word = commandWordIn(callsign)
    if (word) throw new Error(`callsigns.${match}: the callsign ${JSON.stringify(callsign)} starts with "${word}", which the voice grammar hears as a command; pick a name that does not`)
    const heardAs = list(o.heardAs)
    for (const h of heardAs) {
      const w = commandWordIn(h)
      if (w) throw new Error(`callsigns.${match}.heardAs: ${JSON.stringify(h)} starts with "${w}", which the voice grammar hears as a command; leave it out`)
    }
    return { match, callsign, heardAs }
  })
}

/**
 * "fish": { "model": "s2.1-pro", "voices": { "atlas": "<id>", "juniper": { "id": "<id>", "heardAs": ["jupiter"] } } }
 * The key comes from FISH_API_KEY or a one-line file (fish.apiKeyFile,
 * default <state dir>/fish-api-key), never from the config file itself.
 */
export function parseFish(f: Record<string, unknown>, env: Env, stateDir: string): FishConfig {
  const voices = Object.entries(obj(f.voices)).map(([raw, val]) => {
    const name = raw.trim().toLowerCase()
    const o = typeof val === 'string' ? { id: val } : obj(val)
    const id = typeof o.id === 'string' ? o.id.trim() : ''
    if (!/^[a-z][a-z ]{0,30}$/.test(name)) throw new Error(`tts.fish.voices: a voice name is one to a few plain words, got ${JSON.stringify(raw)}`)
    if (!/^[0-9a-f]{32}$/.test(id)) throw new Error(`tts.fish.voices.${name}: the id is fish.audio's 32 hex characters for the voice, got ${JSON.stringify(o.id)}`)
    return { name, id, heardAs: list(o.heardAs) }
  })
  if (!voices.length) throw new Error('the fish text-to-speech provider needs tts.fish.voices: { "name": "<fish.audio voice id>" }')
  const keyFile = absolute(typeof f.apiKeyFile === 'string' ? f.apiKeyFile : join(stateDir, 'fish-api-key'), REPO_ROOT)
  let apiKey = (env.CLAUDEVR_FISH_API_KEY ?? env.FISH_API_KEY ?? '').trim() || null
  if (!apiKey) {
    try {
      apiKey = readFileSync(keyFile, 'utf8').trim() || null
    } catch (err) {
      // A missing key file is reported by the provider, with this path; anything else is a real fault.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${keyFile}: ${(err as Error).message}`)
    }
  }
  return { model: String(env.CLAUDEVR_FISH_MODEL ?? f.model ?? 's2.1-pro'), voices, apiKey, keyHint: `set FISH_API_KEY or put the key in ${keyFile}` }
}

const NAME = /^[a-z][a-z ]{0,30}$/

/**
 * "characters": { "bosun": { "voice": "atlas", "prompt": "...", "confirm": "quick", "heardAs": ["boatswain"], "accent": "#f5a524", "theme": "bosun" } }
 * With the fish provider, `voice` must be one of tts.fish.voices; with any
 * other the character speaks in that provider's one voice. `theme` names a
 * pack under <state dir>/themes (false: none); without it the pack named
 * after the character is used when there is one.
 */
export function parseCharacters(v: unknown, fishVoices: readonly string[] | null): Character[] {
  if (v === undefined) return []
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('characters must be an object of name -> { voice, prompt, confirm }')
  return Object.entries(v as Record<string, unknown>).map(([raw, val]) => {
    const name = raw.trim().toLowerCase()
    if (!NAME.test(name)) throw new Error(`characters: a character name is one to a few plain words, got ${JSON.stringify(raw)}`)
    const o = obj(val)
    const voice = typeof o.voice === 'string' ? o.voice.trim().toLowerCase() : ''
    if (!NAME.test(voice)) throw new Error(`characters.${name}.voice: the name of a voice, got ${JSON.stringify(o.voice)}`)
    if (fishVoices && !fishVoices.includes(voice)) throw new Error(`characters.${name}.voice is ${JSON.stringify(voice)}, which is not one of tts.fish.voices (${fishVoices.join(', ')})`)
    const prompt = typeof o.prompt === 'string' ? o.prompt.trim() : ''
    if (!prompt || prompt.length > 6000) throw new Error(`characters.${name}.prompt: who the character is, 1 to 6000 characters`)
    const confirm = oneOf(o.confirm, ['card', 'quick'] as const, 'card', `characters.${name}.confirm`)
    const accent = o.accent === undefined || o.accent === null ? null : typeof o.accent === 'string' && /^#[0-9a-f]{6}$/i.test(o.accent) ? o.accent.toLowerCase() : null
    if (o.accent !== undefined && o.accent !== null && accent === null) throw new Error(`characters.${name}.accent: a colour as #rrggbb, got ${JSON.stringify(o.accent)}`)
    const theme = o.theme === undefined || o.theme === null ? null : o.theme === false ? false : typeof o.theme === 'string' && PACK_NAME.test(o.theme) ? o.theme : undefined
    if (theme === undefined) throw new Error(`characters.${name}.theme: a theme pack's folder name (lowercase letters, digits and hyphens), or false for none, got ${JSON.stringify(o.theme)}`)
    return { name, voice, prompt, confirm, heardAs: list(o.heardAs), accent, theme }
  })
}

function fixtureName(v: string): string {
  if (!/^[\w.-]+\.json$/.test(v) || v.startsWith('.')) throw new Error(`CLAUDEVR_FAKE_FLEET must be a .json file name inside the fixtures directory, got ${JSON.stringify(v)}`)
  return v
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T, name: string): T {
  if (v === undefined || v === '') return fallback
  if (!allowed.includes(v as T)) throw new Error(`${name} must be one of ${allowed.join(', ')}, got ${JSON.stringify(v)}`)
  return v as T
}

export function loadConfig(env: Env = process.env, log: (...a: unknown[]) => void = () => {}): Config {
  const stateDir = absolute(env.CLAUDEVR_STATE_DIR ?? '.local', REPO_ROOT)
  const file = readLocal(env.CLAUDEVR_CONFIG ? absolute(env.CLAUDEVR_CONFIG, REPO_ROOT) : join(stateDir, 'config.json'), log)
  // autoPair handed the legacy token to any allowed address. It is gone, and an old
  // file or environment that still names it must not quietly mean something else.
  if ('autoPair' in file) throw new Error('autoPair was removed: pairing is by code only. Delete the "autoPair" key from the config file.')
  if (env.CLAUDEVR_AUTO_PAIR !== undefined) throw new Error('CLAUDEVR_AUTO_PAIR was removed: pairing is by code only. Unset it.')
  const fileDash = (typeof file.dashweb === 'object' && file.dashweb ? file.dashweb : {}) as Record<string, unknown>

  const backend = String(env.CLAUDEVR_BACKEND ?? file.backend ?? 'fake')
  if (backend !== 'fake' && backend !== 'dashweb' && backend !== 't3' && backend !== 'claude') throw new Error(`backend must be "fake", "dashweb", "t3" or "claude", got "${backend}"`)

  let dashweb: DashwebConfig | null = null
  if (backend === 'dashweb') {
    const url = env.CLAUDEVR_DASHWEB_URL ?? (fileDash.url as string | undefined)
    const t3Bin = env.CLAUDEVR_T3_BIN ?? (fileDash.t3Bin as string | undefined)
    const t3BaseDir = env.CLAUDEVR_T3_BASE_DIR ?? (fileDash.t3BaseDir as string | undefined)
    const missing = [!url && 'dashweb.url (CLAUDEVR_DASHWEB_URL)', !t3Bin && 'dashweb.t3Bin (CLAUDEVR_T3_BIN)', !t3BaseDir && 'dashweb.t3BaseDir (CLAUDEVR_T3_BASE_DIR)'].filter(Boolean)
    if (missing.length) throw new Error(`the dashweb backend needs ${missing.join(', ')}`)
    dashweb = {
      url: String(url).replace(/\/+$/, ''),
      t3Bin: absolute(String(t3Bin), REPO_ROOT),
      t3BaseDir: absolute(String(t3BaseDir), REPO_ROOT),
      pollMs: pollMs(int(env.CLAUDEVR_DASHWEB_POLL_MS ?? fileDash.pollMs, 2000, 'dashweb.pollMs')),
      hideCwds: [join(stateDir, 'frontman')],
      t3Delivery: oneOf(env.CLAUDEVR_T3_DELIVERY ?? obj(file.t3).delivery, ['auto', 'queue'] as const, 'auto', 't3.delivery'),
      t3LinkFile: join(stateDir, 't3-link.json'),
    }
  }

  let t3: T3Config | null = null
  if (backend === 't3') {
    const fileT3 = obj(file.t3)
    t3 = {
      t3BaseDir: absolute(String(env.CLAUDEVR_T3_BASE_DIR ?? fileT3.baseDir ?? '~/.t3'), REPO_ROOT),
      pollMs: pollMs(int(env.CLAUDEVR_T3_POLL_MS ?? fileT3.pollMs, 2000, 't3.pollMs'), 't3.pollMs'),
      activeHours: int(env.CLAUDEVR_T3_ACTIVE_HOURS ?? fileT3.activeHours, 24, 't3.activeHours'),
      t3LinkFile: join(stateDir, 't3-link.json'),
    }
  }

  const fileMod = obj(file.mod)
  const mod: ModConfig = {
    port: port(env.CLAUDEVR_MOD_PORT ?? fileMod.port, 8444, 'mod.port'),
    bridgeFile: absolute(env.CLAUDEVR_BRIDGE_FILE ?? '~/.claudevr/bridge.json', REPO_ROOT),
  }

  const fileStt = obj(file.stt)
  const fileTts = obj(file.tts)
  const sttProvider = oneOf(env.CLAUDEVR_STT ?? fileStt.provider, ['parakeet', 'whisper', 'off'] as const, DEFAULT_STT, 'stt.provider')
  const sttCache = env.CLAUDEVR_STT_CACHE ?? (fileStt.cacheDir as string | undefined)
  // Tools, not state: the venv and the weights stay in the repo's .local/
  // whatever CLAUDEVR_STATE_DIR says, so a test bridge shares them.
  const stt: SttConfig = {
    provider: sttProvider,
    python: absolute(env.CLAUDEVR_STT_PYTHON ?? (fileStt.python as string | undefined) ?? '.local/stt-venv/bin/python', REPO_ROOT),
    model: String(env.CLAUDEVR_STT_MODEL ?? fileStt.model ?? (sttProvider === 'whisper' ? STT_MODELS.whisper : STT_MODELS.parakeet)),
    cacheDir: sttCache !== undefined ? absolute(sttCache, REPO_ROOT) : sttProvider === 'parakeet' ? join(REPO_ROOT, '.local', 'models') : null,
    maxSeconds: int(env.CLAUDEVR_STT_MAX_SECONDS ?? fileStt.maxSeconds, 30, 'stt.maxSeconds'),
    maxBytes: int(fileStt.maxBytes, 2_000_000, 'stt.maxBytes'),
  }
  const ttsProvider = oneOf(env.CLAUDEVR_TTS ?? fileTts.provider, ['say', 'fish', 'off'] as const, process.platform === 'darwin' ? 'say' : 'off', 'tts.provider')
  const fish = ttsProvider === 'fish' ? parseFish(obj(fileTts.fish), env, stateDir) : null
  const tts: TtsConfig = {
    provider: ttsProvider,
    voice: String(env.CLAUDEVR_TTS_VOICE ?? fileTts.voice ?? (fish ? fish.voices[0]!.name : 'Daniel')),
    maxChars: int(fileTts.maxChars, 600, 'tts.maxChars'),
    fish,
  }
  if (fish && !fish.voices.some(v => v.name === tts.voice)) throw new Error(`tts.voice is ${JSON.stringify(tts.voice)}, which is not one of tts.fish.voices (${fish.voices.map(v => v.name).join(', ')})`)

  const characters = parseCharacters(file.characters, fish ? fish.voices.map(v => v.name) : null)
  const characterRaw = env.CLAUDEVR_CHARACTER ?? (file.character as string | undefined)
  const character = characterRaw === undefined || characterRaw === '' || characterRaw === null ? null : String(characterRaw).trim().toLowerCase()
  if (character !== null && !characters.some(c => c.name === character)) throw new Error(`character is ${JSON.stringify(character)}, which is not one of characters (${characters.map(c => c.name).join(', ') || 'none configured'})`)
  const fileFm = obj(file.frontMan)
  const frontMan: FrontManConfig = {
    provider: oneOf(env.CLAUDEVR_FRONTMAN ?? fileFm.provider, ['cli', 'off'] as const, 'cli', 'frontMan.provider'),
    bin: String(env.CLAUDEVR_CLAUDE_BIN ?? fileFm.bin ?? 'claude'),
    model: String(env.CLAUDEVR_FRONTMAN_MODEL ?? fileFm.model ?? 'haiku'),
    lineTimeoutMs: int(fileFm.lineTimeoutMs, 4000, 'frontMan.lineTimeoutMs'),
    classifyTimeoutMs: int(fileFm.classifyTimeoutMs, 3000, 'frontMan.classifyTimeoutMs'),
    announceGapMs: int(fileFm.announceGapMs, 20_000, 'frontMan.announceGapMs'),
  }
  if (!/^[\w.:\[\]-]{1,80}$/.test(frontMan.model)) throw new Error(`frontMan.model must be a model name such as haiku, got ${JSON.stringify(frontMan.model)}`)

  return {
    backend,
    host: env.CLAUDEVR_HOST ?? (file.host as string | undefined) ?? '0.0.0.0',
    port: int(env.CLAUDEVR_PORT ?? file.port, 8443, 'port'),
    allowIps: env.CLAUDEVR_ALLOW_IPS !== undefined ? list(env.CLAUDEVR_ALLOW_IPS) : list(file.allowIps),
    certNames: env.CLAUDEVR_CERT_NAMES !== undefined ? list(env.CLAUDEVR_CERT_NAMES) : list(file.certNames),
    stateDir,
    themesDir: env.CLAUDEVR_THEMES_DIR ? absolute(env.CLAUDEVR_THEMES_DIR, REPO_ROOT) : join(stateDir, 'themes'),
    clientDir: absolute(env.CLAUDEVR_CLIENT_DIR ?? 'client/dist', REPO_ROOT),
    fixturesDir: absolute(env.CLAUDEVR_FIXTURES ?? 'fixtures', REPO_ROOT),
    fakeFleet: fixtureName(env.CLAUDEVR_FAKE_FLEET ?? 'demo-fleet.json'),
    fakeLiveMs: int(env.CLAUDEVR_FAKE_LIVE_MS, 0, 'CLAUDEVR_FAKE_LIVE_MS'),
    sendsPerMinute: int(env.CLAUDEVR_SENDS_PER_MINUTE ?? file.sendsPerMinute, 6, 'sendsPerMinute'),
    sendsPerHour: int(env.CLAUDEVR_SENDS_PER_HOUR ?? file.sendsPerHour, 60, 'sendsPerHour'),
    dashweb,
    t3,
    mod,
    stt,
    tts,
    ffmpeg: String(env.CLAUDEVR_FFMPEG ?? file.ffmpeg ?? 'ffmpeg'),
    callsigns: parseCallsigns(file.callsigns),
    characters,
    character,
    frontMan,
    dev: bool(env.CLAUDEVR_DEV, false, 'CLAUDEVR_DEV'),
  }
}
