# claudevr mod

A Claude Code mod that links a session to the ClaudeVR bridge running on the same machine. Each session it is loaded in tells the bridge what it is doing (working, thinking, asking, idle or failed, the tool it is running, its subagents, its context and rate-limit figures), and takes the messages you send it from the HUD as if you had typed them.

The bridge's `claude` backend builds its fleet from these reports, so with the mod installed you need neither T3 nor dashweb. The wire format is [docs/mod-protocol.md](../../docs/mod-protocol.md).

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install claudevr --marketplace dervish666/claudevr
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). From a shell, the same thing is:

```
claude plugin install claudevr --marketplace dervish666/claudevr
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `dervish666/claudevr`, then Add plugin.

Then start the bridge. The mod finds it on its own and links within ten seconds. Type `/claudevr` in a session to see whether it is linked, to which address, and the last error if it is not.

## How it finds the bridge

When the bridge starts it writes `~/.claudevr/bridge.json` (mode 0600) with its address and a token that is new on every start. The mod reads that file, checks that the address is plain `http` on `127.0.0.1`, `localhost` or `[::1]`, and refuses it otherwise. Every request carries the token in an `x-claudevr-token` header. When the bridge answers 401 (it restarted with a new token) the mod reads the file again.

With no bridge running the mod stays quiet: it tries again every 10 seconds and writes one line to the debug log when the link goes down and one when it comes back. `CLAUDEVR_BRIDGE_FILE` points it at another file.

## What it sends, and where

Everything goes to the bridge's loopback address and nowhere else. The token is never written to a log line, a status or an error.

Every 10 seconds, and within 2 seconds of a change, the mod posts one report for its session:

- the session id, the project folder's name, the `/rename` title and the current directory
- the path of the session's transcript under `~/.claude/projects`, which the bridge reads to show full turns
- the state, the current action (say `Bash: npm test`) and the last line the assistant wrote
- an open AskUserQuestion's question and option labels, or a waiting permission prompt
- the last six messages, yours and the session's, each cut to 500 characters
- up to twelve subagents: type, description, model, state, start and end times, latest action
- the context window's fill, the rate-limit windows as Claude Code reports them, and the session's cost as `/cost` totals it

When the session ends the mod tells the bridge to drop it.

## Messages from the HUD

The mod long-polls the bridge for messages addressed to its session and submits each one with `$.prompt.submit({ text, asUser: true })`, so the model reads it as your own words. A session in the middle of a turn takes it as its next turn. The mod then acks it, or acks a failure with the reason when a hook refused the prompt. It remembers the last 50 message ids it submitted and acks a repeat without submitting it again, so a message never lands twice.

## Developing

```
claude plugin validate mod/claudevr
claude plugin test mod/claudevr
```

`hooks/report.ts` builds the report and holds the link's checks; `hooks/register.ts` wires them to the session's events and runs the loop.
