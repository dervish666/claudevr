// npm run dev: rebuild the client on change and restart the bridge on change.
// The bridge serves the built client over HTTPS, so the page is always on the
// same secure origin as the WebSocket, as it will be in the headset.
//
// CLAUDEVR_DEV=1 makes the bridge watch the built index.html and push a new
// build id over the WebSocket; an open HUD reloads itself when it sees one,
// so nobody has to reload a page in the headset with a controller.
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

// One build directory for both: the watch writes it, the bridge serves it.
const env = { ...process.env, CLAUDEVR_DEV: process.env.CLAUDEVR_DEV ?? '1' }
if (env.CLAUDEVR_CLIENT_DIR) env.CLAUDEVR_CLIENT_DIR = resolve(env.CLAUDEVR_CLIENT_DIR)

const procs = [
  ['client', 'npm', ['run', 'watch', '-w', 'client']],
  ['bridge', process.execPath, ['--watch-path=bridge/src', '--watch-path=bridge/stt', '--watch-path=shared', 'bridge/src/main.ts']],
].map(([name, cmd, args]) => {
  const p = spawn(cmd, args, { stdio: 'inherit', env })
  p.on('exit', code => {
    console.log(`[dev] ${name} exited with ${code}; stopping`)
    stopAll()
  })
  return p
})

let stopping = false
function stopAll() {
  if (stopping) return
  stopping = true
  for (const p of procs) if (p.exitCode === null) p.kill('SIGTERM')
  setTimeout(() => process.exit(0), 500).unref()
}
process.on('SIGINT', stopAll)
process.on('SIGTERM', stopAll)
