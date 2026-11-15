// Turning an uploaded clip into what a speech model reads (16 kHz mono
// signed 16-bit PCM) with ffmpeg, and measuring how loud it is, so silence is
// reported as silence instead of reaching a model that invents words for it.

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SttFailure } from '../../../shared/protocol.ts'

export const SAMPLE_RATE = 16_000

export class ClipError extends Error {
  readonly reason: SttFailure
  constructor(reason: SttFailure, message: string) {
    super(message)
    this.name = 'ClipError'
    this.reason = reason
  }
}

export interface RunResult {
  code: number | null
  stdout: Buffer
  stderr: string
}

/** Runs a program with an argument list (never a shell), optional stdin, and a time limit. */
export function runProgram(file: string, args: string[], opts: { input?: string | Buffer; timeoutMs: number; maxOut?: number }): Promise<RunResult> {
  return new Promise((ok, fail) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let outSize = 0
    let err = ''
    const max = opts.maxOut ?? 64 * 1024 * 1024
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      fail(new Error(`${file} timed out after ${opts.timeoutMs / 1000} s`))
    }, opts.timeoutMs)
    child.stdout.on('data', (c: Buffer) => {
      outSize += c.length
      if (outSize > max) child.kill('SIGKILL')
      else out.push(c)
    })
    child.stderr.on('data', (c: Buffer) => {
      if (err.length < 8000) err += c.toString('utf8')
    })
    child.on('error', e => {
      clearTimeout(timer)
      fail(new Error(`cannot run ${file}: ${e.message}`))
    })
    child.on('close', code => {
      clearTimeout(timer)
      ok({ code, stdout: Buffer.concat(out), stderr: err })
    })
    // A program that exits before reading stdin breaks the pipe; its exit code says why.
    child.stdin.on('error', e => console.error(`${file}: stdin:`, e.message))
    child.stdin.end(opts.input ?? '')
  })
}

/**
 * Decodes any clip ffmpeg can read to PCM. A clip longer than `maxSeconds`
 * is refused rather than cut, so the person never confirms half a sentence.
 */
export async function decodeClip(clip: Buffer, o: { ffmpeg: string; maxSeconds: number }): Promise<{ pcm: Buffer; ms: number }> {
  if (!clip.length) throw new ClipError('empty', 'the upload was empty: the recorder captured nothing')
  // A file, not a pipe: MP4 from a recorder can keep its index at the end, which a pipe cannot seek to.
  const dir = await mkdtemp(join(tmpdir(), 'claudevr-clip-'))
  const file = join(dir, 'clip')
  try {
    await writeFile(file, clip, { mode: 0o600 })
    const r = await runProgram(o.ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-t', String(o.maxSeconds + 1), '-i', file, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'], {
      timeoutMs: 15_000,
      maxOut: (o.maxSeconds + 2) * SAMPLE_RATE * 2,
    })
    if (r.code !== 0) {
      const why = r.stderr.trim().split('\n').filter(Boolean).at(-1) ?? `ffmpeg exited with ${r.code}`
      throw new ClipError('bad-audio', `ffmpeg could not read the clip: ${why.replace(file, 'clip').slice(0, 200)}`)
    }
    const pcm = r.stdout.subarray(0, r.stdout.length - (r.stdout.length % 2))
    const ms = Math.round((pcm.length / 2 / SAMPLE_RATE) * 1000)
    if (!pcm.length) throw new ClipError('empty', 'the clip decoded to no sound at all')
    if (ms > o.maxSeconds * 1000) throw new ClipError('too-long', `the clip is over ${o.maxSeconds} s; keep it shorter`)
    return { pcm, ms }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Peak and RMS level in dBFS (0 is full scale; digital silence is -Infinity). */
export function levels(pcm: Buffer): { peakDb: number; rmsDb: number } {
  const n = Math.floor(pcm.length / 2)
  let peak = 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768
    const a = Math.abs(v)
    if (a > peak) peak = a
    sum += v * v
  }
  const db = (x: number) => (x > 0 ? Math.round(20 * Math.log10(x) * 10) / 10 : -Infinity)
  return { peakDb: db(peak), rmsDb: db(n ? Math.sqrt(sum / n) : 0) }
}

/**
 * Below this peak the clip holds no speech. A headset mic a few centimetres
 * from the mouth peaks far above it; room noise sits well below.
 */
export const SILENCE_PEAK_DB = -40
