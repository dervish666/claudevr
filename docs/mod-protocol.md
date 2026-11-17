# The ClaudeVR mod protocol, version 1

The `claudevr` mod runs inside each Claude Code session and tells the bridge what that session is doing. The bridge's `claude` backend builds the fleet from those reports and sends messages back through the same mod. Nothing else is needed: no T3, no dashweb.

## Finding the bridge

On start the bridge writes `~/.claudevr/bridge.json`, mode 0600, directory mode 0700:

```json
{ "v": 1, "url": "http://127.0.0.1:8444", "token": "<64 hex chars>", "pid": 12345, "startedAt": 1794736094111 }
```

- The mod port is plain HTTP on 127.0.0.1 only, separate from the HUD's HTTPS port. Config `mod.port`, env `CLAUDEVR_MOD_PORT`, default 8444. `0` turns the mod listener off.
- The token is new on every bridge start. The bridge keeps it in memory and in that file only, never in a log line.
- The mod reads the file when it has no token, and again after any 401. It refuses a `url` whose host is not `127.0.0.1`, `localhost` or `[::1]`, so the token never leaves the machine.
- `CLAUDEVR_BRIDGE_FILE` points both sides at another file (tests, a second bridge).

Every request carries `x-claudevr-token: <token>`. A missing or wrong token gets 401 and nothing else. Bodies are JSON, at most 64 KiB; past that, 413.

## Endpoints

All take `?src=<session id>`, the Claude Code session id (`$.session.id()`), at most 128 characters of `[A-Za-z0-9._:-]`. Anything else gets 400.

| Method and path | What it does | Answers |
|---|---|---|
| `POST /mod/v1/session` | The session's report, below. Sent within 2 s of a change and every 10 s regardless. | 204 |
| `DELETE /mod/v1/session` | The session ended (`session.end`). The bridge drops it at once. | 204 |
| `GET /mod/v1/inbox` | Long poll for messages to this session, held up to 25 s. | 204 nothing; 200 `{ "items": [{ "id", "text" }] }` |
| `POST /mod/v1/ack` | `{ "id", "ok": true, "delivery": "started" or "queued" }` once the mod has submitted the message, or `{ "id", "ok": false, "reason" }` when it could not. | 204 |

The bridge drops a session it has not heard from in 30 s. A dropped session leaves the fleet and cannot be sent to.

## The report

```ts
interface ModReport {
  v: 1
  sessionId: string            // same as src
  project: string              // basename of $.session.root()
  title: string                // the /rename title, or "" for none
  cwd: string
  transcriptPath: string | null // the session's .jsonl under ~/.claude/projects, when known
  state: 'working' | 'thinking' | 'asking' | 'idle' | 'failed'
  action: string | null        // what it is doing now, one line: "Bash: npm test", "thinking"
  lastLine: string | null      // the last thing the assistant said, one line
  activeAt: number             // epoch ms of the last sign of life
  startedAt: number            // $.session.usage().startedAt
  asking: { text: string; options: string[] } | null // an AskUserQuestion, or a permission prompt ("Allow Bash: npm test?"), waiting on the person
  messages: { role: 'you' | 'session'; text: string; at: number }[] // newest last, at most 6, each at most 500 chars
  agents: {
    id: string; type: string; description: string; model: string | null
    state: 'running' | 'done' | 'failed'
    startedAt: number | null; endedAt: number | null
    now: string | null         // current or newest action
  }[]                          // at most 12: running first, then newest finished
  context: { usedPct: number; tokens: number | null; windowTokens: number | null } | null
  rateLimits: { kind: string; usedPct: number; resetsAt: number | null }[] // resetsAt in epoch ms; [] off a subscription
  costUsd: number | null       // the session's cost so far, as /cost totals it
}
```

Every string the bridge shows is clipped again on its side, whatever the mod sent. The bridge treats the whole report as untrusted: unknown keys are ignored, wrong types make the report a 400, and nothing in it is ever run.

## Sending

The HUD's send goes to the backend, which queues `{ id, text }` for that session and answers any open inbox poll at once.

- The mod submits it with `$.prompt.submit({ text, asUser: true })`, which resolves only when the message's turn starts. So an idle session is acked once the submit resolves, with `"delivery": "started"`. A busy session is acked at once with `"delivery": "queued"` and takes the message after the current turn; a refusal after that point reaches only the mod's debug log.
- `ok: true` gives the HUD "Started." or "Queued behind the current turn." (plain "Delivered." without `delivery`). `ok: false` gives a 502 with the mod's reason, and nothing was sent.
- A message the mod never collects within 30 s is withdrawn and refused (502). A collected message with no ack in 30 s gives a 504 with outcome unknown.
- The bridge never re-queues a message on its own.
- A message waiting in the queue when its session drops is refused (nothing was sent). One the mod had already collected becomes outcome unknown.
- The mod remembers the last 50 ids it submitted and acks a repeat without submitting it again, so a message never lands twice.

## Account figures

- Limits: the freshest reading of each rate-limit window across live sessions, as dashweb does. A window whose `resetsAt` has passed is dropped. Readings older than 15 minutes show as stale.
- Today's spend: the sum of `costUsd` over sessions seen today. It counts at API rates, so on a subscription it measures use, not a bill.

## Transcripts

The reader's full turns come from `transcriptPath`. The bridge reads it only if its real path sits under `~/.claude/projects/` and ends `.jsonl`, and only the tail (the last 2 MiB).
