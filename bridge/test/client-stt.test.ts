// A clip's trip to the bridge, from the client (client/src/hud/voice/stt.ts
// bridgeStt): a request that stalls in its headers or its body ends on the
// deadline with the reason, Cancel still reads as cancelled, and an answer in
// time comes through. fetch is stubbed; nothing leaves the process.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLIP_TIMEOUT_MS, bridgeStt } from '../../client/src/hud/voice/stt.ts'

const clip = new Blob([new Uint8Array(16)], { type: 'audio/webm' })

/** Runs `body` with fetch replaced by `fake`, and the signal each call was given. */
async function withFetch(fake: (signal: AbortSignal) => Promise<unknown>, body: (signals: AbortSignal[]) => Promise<void>) {
  const real = globalThis.fetch
  const signals: AbortSignal[] = []
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    signals.push(init.signal as AbortSignal)
    return fake(init.signal as AbortSignal)
  }) as typeof fetch
  try {
    await body(signals)
  } finally {
    globalThis.fetch = real
  }
}

const never = () => new Promise<never>(() => {})

test('clip: the deadline is a minute, past the bridge\'s own bounds on one clip', () => {
  assert.equal(CLIP_TIMEOUT_MS, 60_000)
})

test('clip: a request that never answers ends on the deadline with the reason, and the fetch is aborted', async () => {
  await withFetch(never, async signals => {
    const r = await bridgeStt('tok', 1_000).transcribe(clip, 'none', null)
    assert.equal(r.transcript.ok, false)
    assert.ok(!r.transcript.ok && r.transcript.reason === 'failed')
    assert.ok(!r.transcript.ok && /no answer from the bridge in 1 s/.test(r.transcript.error))
    assert.equal(r.interpretation, null)
    assert.equal(signals[0]?.aborted, true)
  })
})

test('clip: headers that arrive but a body that never does still end on the deadline', async () => {
  await withFetch(
    () => Promise.resolve({ status: 200, json: never }),
    async () => {
      const r = await bridgeStt('tok', 1_000).transcribe(clip, 'none', null)
      assert.ok(!r.transcript.ok && /no answer from the bridge/.test(r.transcript.error))
    },
  )
})

test('clip: Cancel while it is out reads as cancelled, not as the deadline', async () => {
  await withFetch(never, async signals => {
    const ctl = new AbortController()
    const pending = bridgeStt('tok', 60_000).transcribe(clip, 'confirm', null, ctl.signal)
    ctl.abort()
    const r = await pending
    assert.ok(!r.transcript.ok && r.transcript.error === 'cancelled')
    assert.equal(signals[0]?.aborted, true)
  })
})

test('clip: an answer in time comes through untouched', async () => {
  const transcript = { ok: true as const, text: 'status', provider: 'parakeet', audioMs: 900, sttMs: 250, totalMs: 300 }
  await withFetch(
    () => Promise.resolve({ status: 200, json: () => Promise.resolve({ transcript, interpretation: { kind: 'status', say: 'All quiet.', lines: [] } }) }),
    async () => {
      const r = await bridgeStt('tok', 1_000).transcribe(clip, 'none', null)
      assert.deepEqual(r.transcript, transcript)
      assert.equal(r.interpretation?.kind, 'status')
    },
  )
})
