// The bridge's settings: built-in defaults, then the local config file, then
// environment variables, each overriding the one before. Nothing personal
// lives in this file: a machine's paths, ports and URLs go in the local file
// (gitignored, under the state directory) or the environment.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { CallsignOverride } from './backend/callsign.ts'

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..')

export interface DashwebConfig {
  /** dashweb's base URL, e.g. http://127.0.0.1:<port>. */
  url: string
  /** The T3 CLI. */
  t3Bin: string
  /** T3's home, passed as --base-dir. */
  t3BaseDir: string
  pollMs: number
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

export interface TtsConfig {
  provider: 'say' | 'off'
  voice: string
  maxChars: number
}

const STT_MODELS = { parakeet: 'mlx-community/parakeet-tdt-0.6b-v3', whisper: 'small.en' }

export interface Config {
  backend: 'fake' | 'dashweb'
  host: string
  port: number
  /** Client IPs allowed besides loopback. */
  allowIps: string[]
  /**
   * Give the pairing token to any allowed address that asks, so a headset
   * pairs with no typing. Off by default: with it on, the allow list is the
   * only thing between the LAN and the send path.
   */
  autoPair: boolean
  stateDir: string
  clientDir: string
  fixturesDir: string
  sendsPerMinute: number
  sendsPerHour: number
  dashweb: DashwebConfig | null
  stt: SttConfig
  tts: TtsConfig
  ffmpeg: string
  /** Project or session -> spoken callsign, from the private config. */
  callsigns: CallsignOverride[]
  /** Set by npm run dev: the HUD reloads itself when the client is rebuilt. */
  dev: boolean
}

type Env = Record<string, string | undefined>

const expandHome = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)
const absolute = (p: string, base: string) => {
  const e = expandHome(p)
  return isAbsolute(e) ? e : resolve(base, e)
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

function bool(v: unknown, fallback: boolean, name: string): boolean {
  if (v === undefined || v === '') return fallback
  if (v === true || v === 'true' || v === '1') return true
  if (v === false || v === 'false' || v === '0') return false
  throw new Error(`${name} must be true or false, got ${JSON.stringify(v)}`)
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

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
    const heardAs = list(o.heardAs)
    return { match, callsign, heardAs }
  })
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T, name: string): T {
  if (v === undefined || v === '') return fallback
  if (!allowed.includes(v as T)) throw new Error(`${name} must be one of ${allowed.join(', ')}, got ${JSON.stringify(v)}`)
  return v as T
}

export function loadConfig(env: Env = process.env, log: (...a: unknown[]) => void = () => {}): Config {
  const stateDir = absolute(env.CLAUDEVR_STATE_DIR ?? '.local', REPO_ROOT)
  const file = readLocal(env.CLAUDEVR_CONFIG ? absolute(env.CLAUDEVR_CONFIG, REPO_ROOT) : join(stateDir, 'config.json'), log)
  const fileDash = (typeof file.dashweb === 'object' && file.dashweb ? file.dashweb : {}) as Record<string, unknown>

  const backend = String(env.CLAUDEVR_BACKEND ?? file.backend ?? 'fake')
  if (backend !== 'fake' && backend !== 'dashweb') throw new Error(`backend must be "fake" or "dashweb", got "${backend}"`)

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
      pollMs: int(env.CLAUDEVR_DASHWEB_POLL_MS ?? fileDash.pollMs, 2000, 'dashweb.pollMs'),
    }
  }

  const fileStt = obj(file.stt)
  const fileTts = obj(file.tts)
  const sttProvider = oneOf(env.CLAUDEVR_STT ?? fileStt.provider, ['parakeet', 'whisper', 'off'] as const, 'parakeet', 'stt.provider')
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
  const tts: TtsConfig = {
    provider: oneOf(env.CLAUDEVR_TTS ?? fileTts.provider, ['say', 'off'] as const, process.platform === 'darwin' ? 'say' : 'off', 'tts.provider'),
    voice: String(env.CLAUDEVR_TTS_VOICE ?? fileTts.voice ?? 'Daniel'),
    maxChars: int(fileTts.maxChars, 600, 'tts.maxChars'),
  }

  return {
    backend,
    host: env.CLAUDEVR_HOST ?? (file.host as string | undefined) ?? '0.0.0.0',
    port: int(env.CLAUDEVR_PORT ?? file.port, 8443, 'port'),
    allowIps: env.CLAUDEVR_ALLOW_IPS !== undefined ? list(env.CLAUDEVR_ALLOW_IPS) : list(file.allowIps),
    autoPair: bool(env.CLAUDEVR_AUTO_PAIR ?? file.autoPair, false, 'autoPair'),
    stateDir,
    clientDir: absolute(env.CLAUDEVR_CLIENT_DIR ?? 'client/dist', REPO_ROOT),
    fixturesDir: absolute(env.CLAUDEVR_FIXTURES ?? 'fixtures', REPO_ROOT),
    sendsPerMinute: int(env.CLAUDEVR_SENDS_PER_MINUTE ?? file.sendsPerMinute, 6, 'sendsPerMinute'),
    sendsPerHour: int(env.CLAUDEVR_SENDS_PER_HOUR ?? file.sendsPerHour, 60, 'sendsPerHour'),
    dashweb,
    stt,
    tts,
    ffmpeg: String(env.CLAUDEVR_FFMPEG ?? file.ffmpeg ?? 'ffmpeg'),
    callsigns: parseCallsigns(file.callsigns),
    dev: bool(env.CLAUDEVR_DEV, false, 'CLAUDEVR_DEV'),
  }
}
