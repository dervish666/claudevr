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

Callsigns match by spelling and by sound. A weak match, or two near-equal ones, asks which instead of guessing. No callsign starts with a command word. A transcript never sends on its own: the card shows on screen, not spoken, and counts down 5 s, then sends itself. Send now (button, Enter, or "send" on the next hold) skips the wait; Cancel (button, or "cancel" on the next hold) stops it; holding to talk pauses the countdown. A sent or cancelled card clears itself after 2.5 s; one that was refused or rate limited stays until dismissed. The parse lives in the bridge (`bridge/src/voice/grammar.ts`), next to the fleet and the private callsign config; a speech-to-text provider in the browser would post its text to `/api/interpret` and get the same parse.

Replies are spoken by the bridge, fetched with the token and played from a `blob:` URL. The default is macOS `say`, converted to WebM/Opus, which never leaves the machine.

`tts.provider: "fish"` speaks with [fish.audio](https://fish.audio) instead, so every spoken line, session text included, is sent to their API. Name the voices you want by their fish.audio id and pick one:

```json
"tts": { "provider": "fish", "voice": "atlas", "fish": { "model": "s2.1-pro", "voices": { "atlas": "<32-hex id>", "juniper": { "id": "<32-hex id>", "heardAs": ["jupiter"] } } } }
```

A voice chosen by speech is kept in `.local/tts-voice` and wins over `tts.voice` on the next start. Each phrase is cached per voice, so "Sent to X." is bought once. When fish.audio fails (no key, no credit, no network) the bridge logs why, speaks with `say` on macOS, and the HUD's voice status carries the reason. The HUD has a mute button. Session text is untrusted: it reaches `say` on stdin, capped, with `[[...]]` commands stripped.

Under `npm run dev` the bridge watches the built `index.html` and pushes a new build id on the WebSocket; an open HUD reloads itself when it sees one.

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

The voice routes (`/api/transcribe`, `/api/interpret`, `/api/speak`, `/api/voice`) sit behind the same gate. None of them sends anything; only `POST /api/send` does.

Typing 32 hex characters on a headset keyboard is miserable, so `autoPair: true` makes the bridge hand the token to any allowed address that asks (`POST /api/pair`), and the pages pair themselves on first load. The cost: with it on, the allow list is the only gate, so whoever holds an allowed IP can send. Keep it for a LAN you trust, and leave it off anywhere else.

## Layout

- `bridge/` HTTPS server, gate, certificate, backends (`backend/dashweb`: the board normaliser, `usage.ts` for limits and context, `stream.ts` for the live spend; `backend/fake.ts`), voice (`src/voice/`: grammar, ffmpeg decode, speech-to-text and text-to-speech providers; `stt/helper.py`)
- `client/` Vite and React: the HUD (`/`) with its voice dock (`src/hud/Voice.tsx`, `src/hud/voice/`), instrument mode (`src/instrument/`: `layout.ts` and `cards.ts` pure, `linework.tsx` the batch), and the headset probe (`/probe`)
- `shared/protocol.ts` the normalised session shape, the usage figures and the WebSocket messages
- `fixtures/` a scrubbed dashweb capture for tests, and demo fleets for the fake backend (`demo-fleet.json`, and `demo-fleet-10.json` with ten sessions and five needs)
