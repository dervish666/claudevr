<img src="assets/icon.svg" width="64" height="64" alt="">

# ClaudeVR

A HUD for running Claude sessions, opened in a headset's browser. The page talks over a WebSocket to a bridge on your machine, and the bridge talks to the sessions through a `SessionBackend` adapter.

Created in [T3 Code](https://t3.codes).

## Run it

Node 22.18 or later (the bridge runs its TypeScript directly).

```sh
npm install
npm run stt:setup  # once: speech-to-text in .local/stt-venv, model in .local/models
npm start          # build the client, start the bridge
npm run dev        # rebuild on change; open HUDs reload themselves
npm run demo       # the same on the fake backend, no sessions needed
npm test           # bridge tests
npm run typecheck
npm run cert       # make a new self-signed certificate now
```

`stt:setup` needs `uv` and `ffmpeg`. It installs nothing globally: a virtualenv under `.local/` with `parakeet-mlx` (Apple silicon), and about 2.3 GB of weights. `node scripts/setup-stt.mjs whisper` adds faster-whisper instead, for machines without MLX.

On start the bridge prints the HUD and probe URLs for each address it has, and the pairing token. Open the probe at `https://<this machine's LAN IP>:8443/probe`, accept the certificate warning once, and press the big button. With `autoPair` on the page pairs itself; otherwise it asks for the token once. Results land in `.local/probe.log`.

## Configuration

Defaults, then `.local/config.json`, then environment variables. `config.example.json` shows the file. Everything under `.local/` stays out of git: certificate, key, pairing token, probe log, config.

| Setting | Environment | Default |
|---|---|---|
| `backend` | `CLAUDEVR_BACKEND` | `fake` |
| `port` | `CLAUDEVR_PORT` | `8443` |
| `host` | `CLAUDEVR_HOST` | `0.0.0.0` |
| `allowIps` | `CLAUDEVR_ALLOW_IPS` (comma list) | none: loopback only |
| `autoPair` | `CLAUDEVR_AUTO_PAIR` | `false` |
| `sendsPerMinute`, `sendsPerHour` | `CLAUDEVR_SENDS_PER_MINUTE`, `CLAUDEVR_SENDS_PER_HOUR` | 6, 60 |
| `dashweb.url` | `CLAUDEVR_DASHWEB_URL` | required for `dashweb` |
| `dashweb.t3Bin` | `CLAUDEVR_T3_BIN` | required for `dashweb` |
| `dashweb.t3BaseDir` | `CLAUDEVR_T3_BASE_DIR` | required for `dashweb` |
| state directory | `CLAUDEVR_STATE_DIR` | `.local` |
| `stt.provider` | `CLAUDEVR_STT` | `parakeet`; or `whisper`, `off` |
| `stt.model` | `CLAUDEVR_STT_MODEL` | `mlx-community/parakeet-tdt-0.6b-v3`, or `small.en` for whisper |
| `stt.python` | `CLAUDEVR_STT_PYTHON` | `.local/stt-venv/bin/python` |
| `stt.maxSeconds`, `stt.maxBytes` | `CLAUDEVR_STT_MAX_SECONDS` | 30 s, 2 MB |
| `tts.provider`, `tts.voice` | `CLAUDEVR_TTS`, `CLAUDEVR_TTS_VOICE` | `say`, `Daniel` (macOS); or `fish`, `off` |
| `tts.fish.model`, `tts.fish.voices` | `CLAUDEVR_FISH_MODEL` | `s2.1-pro`; voices required for `fish` |
| fish.audio API key | `FISH_API_KEY` | the one line in `.local/fish-api-key` |
| `callsigns` | | none |
| `characters` | | none: operator mode only |
| `character` (the one to start with) | `CLAUDEVR_CHARACTER` | none; a choice made by voice, kept in `.local/character`, wins |
| `frontMan.provider` | `CLAUDEVR_FRONTMAN` | `cli`; or `off` (every line is the plain one) |
| `frontMan.bin`, `frontMan.model` | `CLAUDEVR_CLAUDE_BIN`, `CLAUDEVR_FRONTMAN_MODEL` | `claude` on the PATH, `haiku` |
| `frontMan.lineTimeoutMs`, `classifyTimeoutMs`, `announceGapMs` | | 4000, 3000, 20000 |
| `ffmpeg` | `CLAUDEVR_FFMPEG` | `ffmpeg` on the PATH |
| client build to serve | `CLAUDEVR_CLIENT_DIR` | `client/dist` (`npm run dev` builds there too) |
| fake backend's fleet | `CLAUDEVR_FAKE_FLEET` | `demo-fleet.json`, a file name inside `fixtures/` |
| fake backend's demo motion | `CLAUDEVR_FAKE_LIVE_MS` | off; every N ms one session changes state or posts a new line |

The dashweb backend reads everything under `dashweb.url`: `GET /api/board` and `GET /api/t3` for the fleet, `GET /api/state/office` for the usage limits and each session's context, and it holds `GET /api/sub/office` open for today's spend. It never posts to dashweb.

`callsigns` names sessions outright, keyed by project name or session id, with what speech-to-text is known to hear instead:

```json
"callsigns": { "my-project": { "callsign": "Atlas", "heardAs": ["Atlass"] }, "other": "Juniper" }
```

## Voice

Hold the big button (or Space on a desktop) and speak; release to finish. The bridge converts the clip with ffmpeg, checks it is not silent, and runs speech-to-text in a helper process it keeps loaded (`bridge/stt/helper.py`). A silent clip, an unreadable one, a dead or missing model each come back as their own reason on the HUD, never as an empty transcript.

| Say | Does |
|---|---|
| `status` | reads the fleet back, from the data the bridge holds, naming any session whose context is 80% full or more |
| `limits`, `usage`, `what are my limits` | reads back the 5-hour and weekly limits, today's spend and any nearly full context |
| `read X`, `what's X doing` | reads that session's state, question and last message |
| `switch to X`, or just `X` | shows that session |
| `tell X <message>`, `ask X ...` | a read-back card: "To X: message", Send or Cancel |
| anything else, 3 words or more | a card for the dispatcher session, or "who is it for?" when there is none |
| anything else, with a session open in the reader | a card for that session, however short ("yes", "go ahead"), never the dispatcher |
| `send`, `yes` / `cancel`, `no` | confirm or cancel the armed card |
| `voice X`, `change voice to X`, `use the X voice` | changes the speaking voice (fish.audio only), and answers in it |
| `voices` | lists the voices and names the current one |
| `be X`, `character X`, `X mode` | turns on character X, and its voice (see Character mode) |
| `operator mode`, `plain mode`, `drop the character` | back to plain replies and the 5 s card |
| `characters` | lists the characters and names the current one |
| `<character>, ...` (the current character's name first) | a command after the name still runs; anything else is a question the character answers aloud from the fleet facts, sent to no session |
| `belay that`, `stop` | cancel the armed card, as `cancel` does |

Callsigns match by spelling and by sound. A weak match, or two near-equal ones, asks which instead of guessing. No callsign starts with a command word. A transcript never sends on its own: the card shows on screen, not spoken, and counts down 5 s, then sends itself. Send now (button, Enter, or "send" on the next hold) skips the wait; Cancel (button, or "cancel" on the next hold) stops it; holding to talk pauses the countdown. A sent or cancelled card clears itself after 2.5 s; one that was refused or rate limited stays until dismissed. The parse lives in the bridge (`bridge/src/voice/grammar.ts`), next to the fleet and the private callsign config; a speech-to-text provider in the browser would post its text to `/api/interpret` and get the same parse.

Replies are spoken by the bridge, fetched with the token and played from a `blob:` URL. The default is macOS `say`, converted to WebM/Opus, which never leaves the machine.

`tts.provider: "fish"` speaks with [fish.audio](https://fish.audio) instead, so every spoken line, session text included, is sent to their API. Name the voices you want by their fish.audio id and pick one:

```json
"tts": { "provider": "fish", "voice": "atlas", "fish": { "model": "s2.1-pro", "voices": { "atlas": "<32-hex id>", "juniper": { "id": "<32-hex id>", "heardAs": ["jupiter"] } } } }
```

A voice chosen by speech is kept in `.local/tts-voice` and wins over `tts.voice` on the next start. Each phrase is cached per voice, so "Sent to X." is bought once. When fish.audio fails (no key, no credit, no network) the bridge logs why, speaks with `say` on macOS, and the HUD's voice status carries the reason. The HUD has a mute button. Session text is untrusted: it reaches `say` on stdin, capped, with `[[...]]` commands stripped.

Under `npm run dev` the bridge watches the built `index.html` and pushes a new build id on the WebSocket; an open HUD reloads itself when it sees one.

## Character mode

Operator mode is everything above: plain replies, the 5 s card. Character mode puts a character between him and the fleet. Same commands, same actions, same card; what changes is who talks back. A character is configured, never built in:

```json
"characters": { "bosun": { "voice": "atlas", "prompt": "You are the Bosun ...", "confirm": "quick", "heardAs": ["boatswain"], "accent": "#f5a524" } }
```

`config.example.json` ships one, the Bosun. `voice` must be one of `tts.fish.voices` when the provider is fish (with `say` the character speaks in the one `say` voice). `confirm` is `card` (the 5 s card) or `quick` (see below). `accent` is a `#rrggbb` colour the HUD picks up while the character is on. Characters you write for yourself belong in `.local/config.json`, which git ignores. Turning one on by voice ("be bosun") changes the voice to it and is remembered across restarts in `.local/character`; "operator mode" writes it empty.

**The front man.** The character lives in a model inside the bridge, never in the sessions: nothing about a character is put in a session's prompt or sent to a session, and a session gets your words as you said them. The model is a long-lived `claude -p` child on your Claude subscription (no API key), with no tools, no MCP servers, none of your user settings or hooks, no saved session, run in an empty directory under `.local/frontman/`, with every `CLAUDE_CODE*` variable removed. It starts when a character is turned on and stops in operator mode. When it dies it restarts with backoff (1 s up to 60 s); after 16 turns, or once its context passes 14,000 tokens, it is replaced, so its context stays small. Its stderr goes to the bridge log, and its state (starting, ready, unavailable and why) shows on the HUD. `bridge/src/persona/frontman.ts` has the `FrontMan` interface, so an API client can replace the CLI.

**Lines.** In character mode the bridge acts at once, exactly as in operator mode, and answers the HUD with a line id; the HUD plays a short double tone so you know you were heard, and fetches the line from `GET /api/line`. The bridge gives the model the facts (what you said, what was done, the plain line, and a compact fleet snapshot: who is working, failed or asking and for how long, the usage limits, any context at 80% or more) and the character says it in a sentence or two, pushing back on the real facts. If the line is not ready in 4 s, or the model is down, or what it wrote is not speakable, the plain line is spoken instead and the log says why. Measured on Haiku with the CLI: the line is ready 1.5 to 2 s after the request (median 1.6 s over 15 turns), 2.8 s for the first line after turning a character on. A sent message gets a tone, not "Sent to X.", since the character has already spoken about it; refusals and rate limits are still spoken plainly. A message for a session gets no line at all: the countdown on screen is the read-back, and the character does not remark on everything you send.

**Free-form commands.** When the grammar answers `unknown` or "which one?", the bridge asks a second front man (a separate conversation with a plain classifier prompt) which command you meant: status, limits, read X, switch to X, tell X, or none. It waits at most 3 s, then keeps the grammar's answer. The output is untrusted: it must be a JSON object naming one of the listed kinds, its session must still be in the fleet, `tell` needs a session that can be sent to and a message the grammar already took from your words (the model never writes what is sent), and an ambiguous name may only resolve to one of the grammar's own candidates. Anything else falls back to the grammar.

**Quick confirm.** A character with `confirm: "quick"` arms a 2 s countdown, shown as a slim line instead of the card, cancellable by its button or by "cancel", "belay that" or "stop". It never sends with no delay: speech-to-text mishears, the sessions have full access to the machine, and a sent message cannot be recalled. The send rate limits are the same.

**Speaking up.** In character mode the character says, in its own words, when a session starts asking, fails or finishes a turn, and may read out a short version of what it said. At most one unprompted line every 20 s; events in between are gathered into the next one. The HUD tells the bridge over the WebSocket whether it is muted and whether you are holding to talk: nothing is generated for a muted HUD or no HUD, nothing is spoken while you hold to talk or while a reply is playing, and a line held back for 15 s is dropped.

**Safety.** Character mode adds words, never actions. Only `POST /api/send` sends, and only when the card's countdown ends or you press Send; nothing under `bridge/src/persona/` can reach the backend (a test checks that). Session text is untrusted: it can appear in a line's prompt, and a line is only ever spoken, never parsed. The classifier, whose output is parsed, sees your words and the sessions' callsigns, kinds and states, never anything a session wrote, and the most it can do is arm the same card the grammar would have. `bridge/test/persona.test.ts` runs a fleet full of prompt injections against a model that answers every turn with an injection, and checks that nothing is sent.

**What leaves the machine.** In character mode your transcripts, the plain lines and the fleet snapshots (callsigns, states, waiting questions and, for lines, what sessions said) go to Anthropic through the `claude` CLI on your subscription, on top of the spoken text that goes to fish.audio when that provider is on. Operator mode sends nothing to the front man.

**On the HUD.** The 2D page shows the character, its confirm mode and any front man trouble above the voice row, the line once spoken, and takes the accent for its `--accent` colour. Instrument mode takes the accent for the Core's rings, the dispatcher's iris and the resting voice arc, shows the line under the Stream, and draws a quick send as a slim bar. The tiles, rail, gauges and cards keep their own colours.

## Limits and context

A strip pinned to the top of the HUD, in the fleet view and the reader alike, shows the account's usage windows (5-hour, weekly) as big percentages with when each resets, and today's spend. The numbers turn amber at 60% and red at 80%. Each fleet card, and the reader's header, shows how full that session's context window is, with the same colours, and shows nothing when the backend cannot tell. The strip ends with the local time, 24-hour.

A figure the backend does not have reads "not available" with the reason, never 0% or $0.00. A figure from a source that has gone quiet stays on screen, dimmed with a dashed border and its age.

On dashweb these come from the sessions running the status-dash mod, which post Claude Code's status-line figures to dashweb's office channel: the freshest reading of each window wins, a reading of a window that has reset since is dropped, and one older than 15 minutes is marked stale. Context prefers the `/context` breakdown over the status line, as dashweb's own cards do, so a session without the mod (a T3 Codex thread, say) has no context figure. Today's spend is dashweb's own running total, sent only on its live stream; it counts costs at API rates, so on a subscription it is a measure of use, not a bill. The bridge reconnects to the stream with backoff, and past 20 s with no byte (dashweb pings every 5 s) the spend shows as stale.

## The reader

Tap a session's card (or a needs-you item, or say `switch to X`) and that session fills the window: its last 12 turns in full, newest first, with headings, bullets, bold and code laid out for reading at arm's length. A big Fleet button goes back. The fleet itself only carries short clips, so the reader asks the backend for full turns (`GET /api/transcript`, the `transcript` capability) and re-reads them every few seconds while open. The dashweb adapter gets them from `t3 thread show --json`; a session with no T3 thread behind it shows its clips and says so.

## Instrument mode

The immersive view (Enter instrument on the HUD). The selected session's turns sit in the core, with the usage gauges and a 24-hour clock (`LOCAL`) in the arc above it. The clock reads a signal that ticks on the minute, so it costs no re-render.

- **Tiles.** Up to 10 sessions, five a side: an inner column of three, then an outer column used once there are more than six. A tile keeps its slot while the fleet changes (stored in `localStorage`). Past 10, the last slot becomes a "+N" tile; picking it cycles through the sessions without a tile. Fewer than 3 sessions are padded with demo tiles. The maths is in `client/src/instrument/layout.ts` and has no React in it.
- **Needs-you rail.** Above the arc, one card per `Fleet.needs` entry, oldest first: who is asking, the question, any options, and how long it has waited. Picking a card selects its session; there are no answer buttons. Past 4, the oldest 3 show with a "+N more waiting" card. No needs, no rail.
- **Reply cards.** When a session you are not looking at posts a new line, or stops working (idle or needs you), a card pops over its tile's column with the callsign and the first lines, for 8 s. At most 3 show; the rest queue. Picking one opens that session. They are never spoken, and nothing fires on the first fleet read.
- **Preview.** `/?instrument=preview` renders the scene on a desktop without a headset. `yaw`, `pitch` and `fov` (degrees) aim the camera; `head=1` puts it at the eye so a view turns like a head would. The preview renders the mesh Stream only.
- **Telemetry.** In a headset session the page posts to `.local/instrument.log`: a `frames` line every 5 s with frame times, dropped frames, `drawCalls` (mean and max per frame, every render pass counted), tile and card counts, line-work vertex counts and React `renders` per component; a `draw-census` line 10 s in and then every minute, splitting a frame's draws by scene part; and a `reply-cards` line when cards pop. Frame time on the headset can only be read from there.

Draw calls are kept down by batching: every ring, bracket, gauge and tether is one line-work mesh plus one glow mesh, and each tile column, the rail and each reply stack is one uikit root.

## The gate

The bridge listens on the LAN and its send path reaches agents with full access to the machine. Every request must come from loopback or an address in `allowIps`. Every API call and WebSocket must also carry the pairing token (`Authorization: Bearer`, or a `token.<t>` WebSocket subprotocol), and a request from another origin is refused. Sends share one rate limit. The token is made on first run in `.local/pairing-token`; delete the file to make a new one.

The voice routes (`/api/transcribe`, `/api/interpret`, `/api/speak`, `/api/voice`, `/api/line`) sit behind the same gate. None of them sends anything; only `POST /api/send` does.

Typing 32 hex characters on a headset keyboard is miserable, so `autoPair: true` makes the bridge hand the token to any allowed address that asks (`POST /api/pair`), and the pages pair themselves on first load. The cost: with it on, the allow list is the only gate, so whoever holds an allowed IP can send. Keep it for a LAN you trust, and leave it off anywhere else.

## Layout

- `bridge/` HTTPS server, gate, certificate, backends (`backend/dashweb`: the board normaliser, `usage.ts` for limits and context, `stream.ts` for the live spend; `backend/fake.ts`), voice (`src/voice/`: grammar, ffmpeg decode, speech-to-text and text-to-speech providers; `stt/helper.py`), character mode (`src/persona/`: `frontman.ts` the provider, `prompt.ts` the prompts and the validation, `persona.ts` lines, classification and speaking up)
- `client/` Vite and React: the HUD (`/`) with its voice dock (`src/hud/Voice.tsx`, `src/hud/voice/`), instrument mode (`src/instrument/`: `layout.ts` and `cards.ts` pure, `linework.tsx` the batch), and the headset probe (`/probe`)
- `shared/protocol.ts` the normalised session shape, the usage figures and the WebSocket messages
- `fixtures/` a scrubbed dashweb capture for tests, and demo fleets for the fake backend (`demo-fleet.json`, and `demo-fleet-10.json` with ten sessions and five needs)
