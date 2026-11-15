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
  /**
   * Sub-agents it started, running first, then the most recently finished,
   * capped by the adapter. Absent when the backend does not report them.
   */
  agents?: AgentInfo[]
  /** Sub-agents left out by the cap, and how many of those were running. */
  moreAgents?: number
  moreRunning?: number
}

/** A sub-agent's state, folded from the backend's own words into a small fixed set. */
export type AgentState = 'running' | 'done' | 'failed' | 'unknown'

/** One line of what a sub-agent did lately: a tool call or something it said. */
export interface AgentActivity {
  at: number | null
  text: string
}

/** A sub-agent of a session, trimmed for the HUD. Read-only: nothing can be sent to one. */
export interface AgentInfo {
  id: string
  /** The agent's kind ("general-purpose", "Explore"). */
  type: string
  /** What it was asked to do, one line. */
  description: string
  state: AgentState
  model: string | null
  startedAt: number | null
  endedAt: number | null
  /** What it is doing right now, or the newest thing it did; null when unknown. */
  now: string | null
  /** 1 for an agent the session started itself, 2 for one an agent started. */
  depth: number
  /** The start of what it was told, clipped. */
  brief: string | null
  /** Its last few actions, oldest first, clipped. */
  recent: AgentActivity[]
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

/**
 * POST /api/send's body. `requestId` makes a retry safe: 8 to 64 characters
 * of A-Z, a-z, 0-9, "-" and "_", unique per message (the card's id). The
 * bridge remembers each one for 10 minutes; a repeat with the same session
 * and text gets the first answer again, with `repeat: true`, and nothing is
 * sent twice. The same id with a different session or text is refused (409).
 * Only a send that reached the backend, or may have, is remembered. One
 * refused before it went out (rate limit, unknown session) can be retried.
 * When the bridge cannot know whether the message arrived, the reply is a
 * 504 whose body has `outcome: "unknown"` beside `error`; 501 and 502 always
 * mean nothing was sent.
 */
export interface SendRequest {
  sessionId: string
  text: string
  requestId?: string
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
  /** "voice X": the bridge has already changed its speaking voice to `voice`. Null: no change, `say` lists the voices or says why not. */
  | { kind: 'voice'; voice: string | null; say: string }
  /**
   * "be X", "X mode", "operator mode", "characters". `character` is the one
   * now selected (null: operator mode); `changed` says whether this utterance
   * changed it. The bridge has already acted on it.
   */
  | { kind: 'character'; character: string | null; changed: boolean; say: string }
  /** "Bosun, ...": said to the character by name, not a command. Nothing is done; the character's line is the answer, and `say` is what is spoken if it has none. */
  | { kind: 'ask'; character: string; question: string; say: string }
  | { kind: 'unknown'; say: string }

/**
 * In character mode the spoken answer is written by the front man after the
 * reply has gone back. `id` fetches it from GET /api/line, which answers
 * within the bridge's line timeout, with the plain `say` when the model was
 * slow or down.
 */
export interface PendingLine {
  id: string
  character: string
}

/** POST /api/transcribe answers this, whatever went wrong. */
export interface VoiceReply {
  transcript: Transcript
  /** Null when there was no transcript to interpret. */
  interpretation: Interpretation | null
  /** Set only in character mode. Absent or null: speak `interpretation.say` as before. */
  line?: PendingLine | null
}

/** A line to speak: an answer from GET /api/line, or an unprompted one pushed on the WebSocket. */
export interface SpokenLine {
  id: string
  text: string
  character: string
  /** `character`: the front man wrote it. `fallback`: the plain line, because the model was slow, down or said nothing usable. */
  source: 'character' | 'fallback'
  /** Why it fell back, for the HUD and the log. */
  reason: string | null
  /** From the request (or the event) to the line being ready. */
  ms: number
}

/**
 * One entry in the character's conversation: what he said to the dispatcher
 * (or to the character), what the dispatcher answered, and what the
 * character said. Kept by the bridge in memory only.
 */
export interface ConversationEntry {
  id: string
  at: number
  who: 'user' | 'dispatcher' | 'character'
  text: string
  /** For `user`: whether he sent it to the dispatcher or asked the character by name. */
  to?: 'dispatcher' | 'character'
  /** For `character`: the front man wrote it, or it is the plain fallback. */
  source?: SpokenLine['source']
  /** For `character`: the key (turnKey) of the dispatcher turn it follows, when the bridge knows it. */
  after?: string | null
}

/** The character's conversation, served by GET /api/conversation and pushed on the WebSocket when it changes. */
export interface Conversation {
  /** The character it belongs to; null in operator mode, with no entries. */
  character: string | null
  /** Oldest first. */
  entries: ConversationEntry[]
}

export interface CharacterInfo {
  name: string
  /** `quick`: a 2 s countdown on a slim line. `card`: the full card and 5 s, as in operator mode. */
  confirm: 'card' | 'quick'
  /** #rrggbb the HUD picks up while this character is selected, or null. */
  accent: string | null
}

/** POST /api/character answers this: the same shape the voice routes give for "be X". */
export interface CharacterReply {
  interpretation: Extract<Interpretation, { kind: 'character' }>
  line?: PendingLine | null
}

export interface FrontManStatus {
  /** What writes the lines: "claude cli (haiku)", or "off". */
  provider: string
  state: 'off' | 'starting' | 'ready' | 'unavailable'
  /** Why it is not ready, or what the last turn failed with. */
  error: string | null
}

export interface PersonaStatus {
  /** Null: operator mode. */
  character: CharacterInfo | null
  characters: CharacterInfo[]
  frontMan: FrontManStatus
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
  /** Absent from a bridge older than character mode. */
  persona?: PersonaStatus
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
  /** Character mode speaking up unprompted: a session needs you, failed, or finished. Speak it, never act on it. */
  | { type: 'line'; line: SpokenLine; status: BackendStatus }
  /** The character's conversation changed (or a HUD just connected). Shown, never acted on. */
  | { type: 'conversation'; conversation: Conversation; status: BackendStatus }

/**
 * HUD to bridge, over the WebSocket. The bridge speaks up only to a HUD that
 * is not muted, and holds its tongue while the person holds to talk.
 */
export type ClientMessage = { type: 'presence'; muted: boolean; holding: boolean }

/**
 * POST /api/pair/request: a code for a browser with no token to show, and
 * what it needs to poll for its token. The secret goes in the
 * x-pair-secret header of each poll and nowhere else.
 */
export interface PairTicket {
  id: string
  secret: string
  /** "ACD-347": shown large on the device, typed on this machine's approval page. */
  code: string
  /** What the approval page will call this device: "Quest browser". */
  label: string
  /** Time left, not a clock time, so a headset with a wrong clock still counts down right. */
  expiresInMs: number
  /** The approval page, on this machine: https://localhost:<port>/pair. */
  approveUrl: string
}

/** GET /api/pair/status?id=<id>: still waiting, or the device's own token (given once), or gone (expired, unknown, or already collected). */
export type PairStatus = { state: 'pending'; expiresInMs: number } | { state: 'approved'; token: string; label: string } | { state: 'gone'; error: string }
