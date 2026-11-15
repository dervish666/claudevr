// npm run t3-link              link the bridge to T3 Code (opens T3's approval page)
// npm run t3-link -- --status  say whether a link exists, when it was made and when it expires
// npm run t3-link -- --unlink  delete the link
//
// None of these print the token. The link lives in <state dir>/t3-link.json,
// mode 0600, and the bridge reads it on every send, so no restart is needed.

import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config.ts'
import { linkT3 } from './backend/t3oauth.ts'
import { linkExpired, linkFileIn, readLink, readT3Origin, removeLink } from './backend/t3mcp.ts'

const say = (line: string) => console.log(line)

function when(iso: string | null): string {
  if (iso === null) return 'never (T3 gave no lifetime)'
  const ms = Date.parse(iso) - Date.now()
  const days = Math.round(Math.abs(ms) / 86_400_000)
  return `${new Date(iso).toLocaleString()} (${ms < 0 ? `${days} days ago` : days === 0 ? 'today' : `in ${days} days`})`
}

function status(file: string): number {
  const link = readLink(file)
  if (!link) {
    say(`Not linked. Spoken messages queue behind a busy turn. Run npm run t3-link to link.`)
    return 0
  }
  say(`Linked to T3 at ${link.origin} as "${link.clientName || 'unnamed client'}".`)
  say(`  made:     ${when(link.linkedAt)}`)
  say(`  expires:  ${when(link.expiresAt)}`)
  if (link.scope) say(`  scope:    ${link.scope}`)
  if (linkExpired(link)) say('The link has expired: messages queue until you run npm run t3-link again.')
  say(`  (kept in ${file}; the token is not shown)`)
  return 0
}

async function main(argv: string[]): Promise<number> {
  const cfg = loadConfig(process.env)
  const file = linkFileIn(cfg.stateDir)
  if (argv.includes('--status')) return status(file)
  if (argv.includes('--unlink')) {
    say(removeLink(file) ? `Deleted ${file}. Spoken messages will queue. T3 keeps its side of the session until it expires.` : 'There was no link to delete.')
    return 0
  }
  const unknown = argv.filter(a => a !== '--link')
  if (unknown.length) {
    say(`Unknown option ${unknown[0]}. Use --status, --unlink, or nothing to link.`)
    return 2
  }
  const t3BaseDir = cfg.dashweb?.t3BaseDir ?? join(homedir(), '.t3')
  const origin = readT3Origin(t3BaseDir)
  mkdirSync(cfg.stateDir, { recursive: true })
  const out = await linkT3({
    origin,
    linkFile: file,
    say,
    openUrl: url =>
      new Promise<void>((ok, fail) => {
        // execFile with an argument: the URL never passes through a shell.
        execFile('open', [url], err => (err ? fail(err) : ok()))
      }),
  })
  say(`Linked. Saved to ${file} (readable by you only).`)
  say(`  expires: ${when(out.expiresAt)}`)
  if (out.scope) say(`  scope:   ${out.scope}`)
  say('Spoken messages now start an idle thread or go straight into a running turn. Set t3.delivery to "queue" to turn that off.')
  return 0
}

main(process.argv.slice(2)).then(
  code => process.exit(code),
  err => {
    // The message never holds the token: nothing in this flow puts it into an error.
    console.error(`t3-link failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  },
)
