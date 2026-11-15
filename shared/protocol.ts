// What the bridge sends the HUD, and what every SessionBackend produces.
// Types only, so the client and the bridge can both import it with nothing
// left over at runtime.

export type SessionState = 'working' | 'thinking' | 'asking' | 'idle' | 'failed' | 'done' | 'unknown'

/** One question or request waiting on the person, as a session shows it. */
export interface Ask {
  text: string
  options: string[]
  /** Where it has to be answered when this HUD can't: a URL, or null. */
  answerAt: string | null
}

export interface Message {
  at: number | null
  text: string
}

/** A session as the HUD shows it. Every adapter maps its own data to this. */
export interface Session {
  /** Stable id inside this backend. `send(id, text)` takes it. */
  id: string
  /** Short spoken name, unique across the fleet ("Tally", "Claude Two"). */
  callsign: string
  title: string
  project: string | null
  /** What runs it: "interactive", "T3 codex", "dispatcher"... free text from the adapter. */
  kind: string
  state: SessionState
  /** What it is doing right now, one line, or null when idle. */
  action: string | null
  /** The last thing it said, one line, clipped. */
  lastLine: string | null
  /** Epoch ms of the last sign of life, for the age shown on the card. */
  activeAt: number | null
  startedAt: number | null
  asking: Ask | null
  /** The last few things it said, newest last, for the focus panel. */
  messages: Message[]
  /** Whether `send` can reach this session through this backend. */
  canSend: boolean
  /** How full its context window is; null when the backend cannot tell. */
  context: ContextUse | null
}

/** One turn of a session's conversation, in full (up to a cap), for the reader. */
export interface Turn {
  /** Who said it: the person, the session, or something else (a system note). */
  role: 'you' | 'session' | 'other'
  text: string
  /** True when the text was cut at the cap. */
  clipped: boolean
}

/** The last few turns of one session, oldest first. */
export interface SessionTranscript {
  sessionId: string
  at: number
  turns: Turn[]
}

export type NeedKind = 'question' | 'approval' | 'needs-sam' | 'failed'

/** One entry in the needs-you queue. */
export interface Need {
  id: string
  kind: NeedKind
  /** The session it belongs to, when the backend can tell. */
  sessionId: string | null
  callsign: string | null
  /** A short label: a task id, a session title. */
  label: string
  text: string
  options: string[]
  /** Epoch ms since it has been waiting, or null when the source doesn't say. */
  since: number | null
  /** Where the item came from, in the backend's words ("ledger table", "dialog", "T3"). */
  source: string
}

export interface LedgerRow {
  task: string
  repo: string
  status: string
  lastReport: string
  verdict: 'DONE' | 'NEEDS SAM' | 'FAILED' | null
  opened: string
}

export interface Ledger {
  ok: boolean
  error: string | null
  /** Epoch ms the ledger file last changed, when known. */
  changedAt: number | null
  rows: LedgerRow[]
  closed: string[]
}

/**
 * A figure the backend may or may not know. `value` null means not
 * available, never zero; `note` says why. A value from a source that has
 * gone quiet keeps showing, marked `stale`, with `at` giving its age.
 */
export interface Figure<T> {
  value: T | null
  /** Epoch ms the value was measured, or last confirmed by a live source. */
  at: number | null
  stale: boolean
  /** Why it is missing or stale, in words for the HUD. */
  note: string | null
}

/** One of the account's usage windows: the 5-hour limit, the weekly one. */
export interface LimitWindow {
  /** The backend's name for it: "five_hour", "seven_day", or another. */
  kind: string
  /** Short and spoken: "5-hour", "Weekly". */
  label: string
  usedPct: number
  /** Epoch ms the window resets, when known. */
  resetsAt: number | null
}

/** The subscription's limits and today's spend, account-wide. */
export interface Usage {
  todayUsd: Figure<number>
  /** Shortest window first. */
  limits: Figure<LimitWindow[]>
}

/** How full a session's context window is. */
export interface ContextUse {
  usedPct: number
  tokens: number | null
  windowTokens: number | null
  /** Epoch ms of the reading. */
  at: number | null
}

export interface Fleet {
  /** Epoch ms the backend data was read. */
  at: number
  sessions: Session[]
  needs: Need[]
  ledger: Ledger | null
  usage: Usage
  /** Things the adapter could read but did not trust; shown on the HUD. */
  warnings: string[]
}

export const OPERATIONS = ['list', 'subscribe', 'send', 'interrupt', 'pending', 'respond', 'approve', 'transcript'] as const
export type Operation = (typeof OPERATIONS)[number]
export type Capabilities = Record<Operation, boolean>

/** The backend's health as the bridge last saw it. */
export interface BackendStatus {
  name: string
  capabilities: Capabilities
  ok: boolean
  error: string | null
  /** Epoch ms of the last good read, or null if there has never been one. */
  lastOkAt: number | null
}

// ---------------------------------------------------------------- voice

/** Why a clip produced no transcript. Each one is shown as itself, never as an empty transcript. */
export type SttFailure =
  /** No speech-to-text provider is running: missing, still loading, or its helper died. */
  | 'unavailable'
  | 'too-big'
  | 'too-long'
  /** ffmpeg could not decode the upload. */
  | 'bad-audio'
  /** The clip decoded to no samples at all. */
  | 'empty'
  /** The clip is quieter than speech anywhere in it. */
  | 'silent'
  /** There was sound, and the model found no words in it. */
  | 'no-words'
  | 'busy'
  | 'failed'

export type Transcript =
  | { ok: true; text: string; provider: string; audioMs: number; sttMs: number; totalMs: number }
  | { ok: false; reason: SttFailure; error: string; provider: string | null; audioMs: number | null; peakDb: number | null }

/** What the HUD has open, which changes what a short reply means. */
export type VoiceContext = 'none' | 'confirm' | 'target'

export interface Candidate {
  sessionId: string
  callsign: string
}

/**
 * What the bridge made of an utterance. `say` is the short answer the HUD
 * shows and speaks. Nothing here sends anything: a `tell` becomes a card the
 * person confirms, and only then does the HUD call POST /api/send.
 */
export type Interpretation =
  | { kind: 'status'; say: string; lines: string[] }
  /** The usage limits and today's spend, read back. */
  | { kind: 'limits'; say: string; lines: string[] }
  | { kind: 'read'; sessionId: string; callsign: string; say: string }
  | { kind: 'switch'; sessionId: string; callsign: string; say: string }
  /** "Dispatcher" on its own: drop the selection and go back to the dispatcher, the Core's home. */
  | { kind: 'dispatcher'; say: string }
  /** `viaFocus`: no session was named, so it goes to the one open in the reader. */
  | { kind: 'tell'; sessionId: string; callsign: string; text: string; viaDispatcher: boolean; viaFocus?: boolean; say: string }
  /** Who is it for? `text` waits for the answer; a `target` reply supplies it. */
  | { kind: 'which'; why: 'ambiguous' | 'no-match' | 'no-dispatcher'; heard: string | null; text: string; candidates: Candidate[]; say: string }
  | { kind: 'target'; sessionId: string; callsign: string; say: string }
  | { kind: 'confirm'; say: string }
  | { kind: 'cancel'; say: string }
  | { kind: 'unknown'; say: string }

/** POST /api/transcribe answers this, whatever went wrong. */
export interface VoiceReply {
  transcript: Transcript
  /** Null when there was no transcript to interpret. */
  interpretation: Interpretation | null
}

export interface SttStatus {
  provider: string
  state: 'loading' | 'ready' | 'unavailable' | 'off'
  /** Why it is not ready, in words for the HUD. */
  error: string | null
  model: string | null
  loadMs: number | null
}

export interface TtsStatus {
  provider: string
  ok: boolean
  error: string | null
}

export interface VoiceStatus {
  stt: SttStatus
  tts: TtsStatus
}

/** The built client the bridge is serving. In dev the HUD reloads when `id` changes. */
export interface BuildInfo {
  id: string | null
  reload: boolean
}

/** Bridge to HUD, over the WebSocket. */
export type ServerMessage =
  | { type: 'hello'; status: BackendStatus; build: BuildInfo; voice: VoiceStatus }
  | { type: 'fleet'; fleet: Fleet; status: BackendStatus }
  | { type: 'status'; status: BackendStatus }
  | { type: 'build'; build: BuildInfo; status: BackendStatus }
  | { type: 'voice'; voice: VoiceStatus; status: BackendStatus }
