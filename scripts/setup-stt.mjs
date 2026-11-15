// npm run stt:setup: the speech-to-text helper's Python, in the repo's
// ignored .local/ (nothing installed globally), and the model weights.
//
//   node scripts/setup-stt.mjs            parakeet-mlx (Apple silicon), the default
//   node scripts/setup-stt.mjs whisper    faster-whisper, the fallback
//
// Needs uv (https://docs.astral.sh/uv/) and ffmpeg on the PATH.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../bridge/src/config.ts'

const engine = process.argv[2] ?? 'parakeet'
if (!['parakeet', 'whisper'].includes(engine)) {
  console.error(`engine must be parakeet or whisper, got ${engine}`)
  process.exit(2)
}
const venv = join(REPO_ROOT, '.local', 'stt-venv')
const python = join(venv, 'bin', 'python')

function run(cmd, args, env = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: REPO_ROOT, env: { ...process.env, ...env } })
  if (r.error) {
    console.error(`cannot run ${cmd}: ${r.error.message}`)
    process.exit(1)
  }
  if (r.status !== 0) process.exit(r.status ?? 1)
}

for (const tool of ['uv', 'ffmpeg']) {
  const r = spawnSync(tool, ['--version'], { stdio: 'ignore' })
  if (r.error || r.status !== 0) {
    console.error(`${tool} is not on the PATH; install it first`)
    process.exit(1)
  }
}
if (!existsSync(python)) run('uv', ['venv', venv, '--python', '3.12'])
run('uv', ['pip', 'install', engine === 'parakeet' ? 'parakeet-mlx' : 'faster-whisper'], { VIRTUAL_ENV: venv })

// Load the model once, which downloads it, so the bridge's first start is not a download.
const model = engine === 'parakeet' ? 'mlx-community/parakeet-tdt-0.6b-v3' : 'small.en'
const cache = engine === 'parakeet' ? join(REPO_ROOT, '.local', 'models') : null
const code =
  engine === 'parakeet'
    ? `from parakeet_mlx import from_pretrained; from_pretrained(${JSON.stringify(model)}, cache_dir=${JSON.stringify(cache)}); print("model ready")`
    : `from faster_whisper import WhisperModel; WhisperModel(${JSON.stringify(model)}, device="cpu", compute_type="int8"); print("model ready")`
run(python, ['-c', code])
console.log(`\nDone. The bridge finds ${python} by default${engine === 'whisper' ? '; set "stt": { "provider": "whisper" } in .local/config.json to use it' : ''}.`)
