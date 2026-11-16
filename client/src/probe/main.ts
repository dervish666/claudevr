// The headset probe: what this browser can do for a voice HUD. Every check
// ends in one of these, and they mean different things:
//   yes           it works here
//   no            the browser does not have it, or refused it by policy
//   denied        it exists but permission was refused
//   could-not-run the check itself failed or timed out, so we do not know
//   needs-tap     it needs a user gesture; press the big button
// Results go on screen and to the bridge's probe log.

import '../theme.css'
import './probe.css'
import { checkToken, cleanToken, forgetToken, readToken, saveToken } from '../pairing.ts'

type Status = 'yes' | 'no' | 'denied' | 'could-not-run' | 'needs-tap' | 'running'
interface Result {
  status: Status
  detail: string
  data?: unknown
}
interface Check {
  id: string
  label: string
  gesture: boolean
  run: () => Promise<Result>
}

const TIMEOUT_MS = 8000
const results = new Map<string, Result>()

const yes = (detail: string, data?: unknown): Result => ({ status: 'yes', detail, data })
const no = (detail: string, data?: unknown): Result => ({ status: 'no', detail, data })
const failed = (err: unknown): Result => ({ status: 'could-not-run', detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err) })

function withTimeout<T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  return Promise.race([p, new Promise<T>((_, fail) => setTimeout(() => fail(new Error(`timed out after ${ms / 1000} s`)), ms))])
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------- checks

const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/aac', 'audio/mpeg', 'audio/wav']

/** A 0.2 s silent WAV, made here so no file or network is involved. */
function silentWav(): string {
  const rate = 8000
  const n = rate / 5
  const buf = new ArrayBuffer(44 + n)
  const v = new DataView(buf)
  const s = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  s(0, 'RIFF'); v.setUint32(4, 36 + n, true); s(8, 'WAVE'); s(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true)
  s(36, 'data'); v.setUint32(40, n, true)
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128)
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
}

async function tryPlay(): Promise<Result> {
  const audio = new Audio(silentWav())
  try {
    await withTimeout(audio.play(), 4000)
    return yes('audio.play() resolved')
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotAllowedError') return no('blocked by autoplay policy (NotAllowedError)')
    return failed(err)
  } finally {
    audio.pause()
  }
}

let micStream: MediaStream | null = null

const CHECKS: Check[] = [
  { id: 'userAgent', label: 'User agent', gesture: false, run: async () => yes(navigator.userAgent) },
  {
    id: 'secureContext',
    label: 'Secure context (HTTPS)',
    gesture: false,
    run: async () => (window.isSecureContext ? yes(location.origin) : no(`${location.origin} is not a secure context; the mic will not be offered`)),
  },
  {
    id: 'mediaRecorder',
    label: 'MediaRecorder formats',
    gesture: false,
    run: async () => {
      if (typeof MediaRecorder === 'undefined') return no('MediaRecorder is not defined')
      if (typeof MediaRecorder.isTypeSupported !== 'function') return no('MediaRecorder.isTypeSupported is missing')
      const ok = MIME_TYPES.filter(t => MediaRecorder.isTypeSupported(t))
      const map = Object.fromEntries(MIME_TYPES.map(t => [t, MediaRecorder.isTypeSupported(t)]))
      return ok.length ? yes(ok.join(', '), map) : no('none of the tried types', map)
    },
  },
  {
    id: 'autoplayNoGesture',
    label: 'Audio autoplay, before any tap',
    gesture: false,
    run: async () => {
      const r = await tryPlay()
      let ctx: string | null = null
      try {
        const c = new AudioContext()
        ctx = c.state
        await c.close()
      } catch (err) {
        ctx = `AudioContext failed: ${String(err)}`
      }
      return { ...r, detail: `${r.detail}; a new AudioContext starts "${ctx}"` }
    },
  },
  {
    id: 'speechRecognition',
    label: 'SpeechRecognition API present',
    gesture: false,
    run: async () => {
      const w = window as unknown as Record<string, unknown>
      const std = typeof w.SpeechRecognition === 'function'
      const webkit = typeof w.webkitSpeechRecognition === 'function'
      return std || webkit ? yes([std && 'SpeechRecognition', webkit && 'webkitSpeechRecognition'].filter(Boolean).join(' and ')) : no('neither SpeechRecognition nor webkitSpeechRecognition')
    },
  },
  {
    id: 'speechSynthesis',
    label: 'speechSynthesis voices',
    gesture: false,
    run: async () => {
      if (!('speechSynthesis' in window)) return no('speechSynthesis is not defined')
      let voices = speechSynthesis.getVoices()
      if (!voices.length) {
        await Promise.race([new Promise(r => speechSynthesis.addEventListener('voiceschanged', r, { once: true })), wait(3000)])
        voices = speechSynthesis.getVoices()
      }
      const list = voices.map(v => ({ name: v.name, lang: v.lang, local: v.localService, default: v.default }))
      if (!voices.length) return no('speechSynthesis exists but lists no voices after 3 s', list)
      const en = voices.filter(v => v.lang.toLowerCase().startsWith('en'))
      return yes(`${voices.length} voices, ${en.length} English: ${en.slice(0, 6).map(v => v.name).join(', ')}${en.length > 6 ? '…' : ''}`, list)
    },
  },
  {
    id: 'gamepad',
    label: 'Gamepad API',
    gesture: false,
    run: async () => {
      if (typeof navigator.getGamepads !== 'function') return no('navigator.getGamepads is missing')
      const read = () =>
        [...navigator.getGamepads()].filter((g): g is Gamepad => Boolean(g)).map(g => ({ id: g.id, mapping: g.mapping, buttons: g.buttons.length, axes: g.axes.length }))
      let pads = read()
      if (!pads.length) {
        await Promise.race([new Promise(r => window.addEventListener('gamepadconnected', r, { once: true })), wait(3000)])
        pads = read()
      }
      return yes(pads.length ? `${pads.length} connected: ${pads.map(p => p.id).join('; ')}` : 'API present, no gamepad seen in 3 s (press a controller button and re-run)', pads)
    },
  },
  {
    id: 'webgpu',
    label: 'WebGPU',
    gesture: false,
    run: async () => {
      const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<any> } }).gpu
      if (!gpu) return no('navigator.gpu is not defined')
      const adapter = await withTimeout(gpu.requestAdapter())
      if (!adapter) return no('navigator.gpu exists but requestAdapter() returned null')
      const info = adapter.info ?? {}
      const data = {
        vendor: info.vendor ?? null,
        architecture: info.architecture ?? null,
        device: info.device ?? null,
        description: info.description ?? null,
        features: [...(adapter.features ?? [])],
        maxBufferSize: adapter.limits?.maxBufferSize ?? null,
        maxStorageBufferBindingSize: adapter.limits?.maxStorageBufferBindingSize ?? null,
      }
      return yes(`adapter: ${[data.vendor, data.architecture, data.description].filter(Boolean).join(' ') || 'no info'}; shader-f16: ${data.features.includes('shader-f16')}`, data)
    },
  },
  {
    id: 'wasmThreads',
    label: 'WASM threads (SharedArrayBuffer, crossOriginIsolated)',
    gesture: false,
    run: async () => {
      if (typeof WebAssembly === 'undefined') return no('WebAssembly is not defined')
      const sab = typeof SharedArrayBuffer !== 'undefined'
      const isolated = window.crossOriginIsolated === true
      let shared = false
      let sharedErr: string | null = null
      try {
        shared = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }).buffer instanceof SharedArrayBuffer
      } catch (err) {
        sharedErr = String(err)
      }
      const simd = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]))
      const data = { SharedArrayBuffer: sab, crossOriginIsolated: isolated, sharedMemory: shared, sharedMemoryError: sharedErr, simd, hardwareConcurrency: navigator.hardwareConcurrency ?? null, deviceMemoryGB: (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? null }
      const detail = `SharedArrayBuffer ${sab}, crossOriginIsolated ${isolated}, shared memory ${shared}, SIMD ${simd}, ${data.hardwareConcurrency ?? '?'} cores`
      return sab && isolated && shared ? yes(detail, data) : no(detail, data)
    },
  },
  {
    id: 'webxr',
    label: 'WebXR (for later)',
    gesture: false,
    run: async () => {
      const xr = (navigator as unknown as { xr?: { isSessionSupported(m: string): Promise<boolean> } }).xr
      if (!xr) return no('navigator.xr is not defined')
      const [vr, ar] = await Promise.all([withTimeout(xr.isSessionSupported('immersive-vr')), withTimeout(xr.isSessionSupported('immersive-ar'))])
      return vr || ar ? yes(`immersive-vr ${vr}, immersive-ar ${ar}`, { vr, ar }) : no('navigator.xr exists but offers no immersive session', { vr, ar })
    },
  },
  // ---- after a tap
  {
    id: 'getUserMedia',
    label: 'Microphone (getUserMedia audio)',
    gesture: true,
    run: async () => {
      if (!navigator.mediaDevices?.getUserMedia) return no('navigator.mediaDevices.getUserMedia is missing (not a secure context?)')
      try {
        micStream = await withTimeout(navigator.mediaDevices.getUserMedia({ audio: true }), 30_000)
      } catch (err) {
        if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) return { status: 'denied', detail: `${err.name}: ${err.message}` }
        if (err instanceof DOMException && err.name === 'NotFoundError') return no('no microphone found (NotFoundError)')
        throw err
      }
      const track = micStream.getAudioTracks()[0]
      const settings = track?.getSettings() ?? {}
      return yes(`track "${track?.label ?? '?'}", ${settings.sampleRate ?? '?'} Hz, ${settings.channelCount ?? '?'} ch`, settings)
    },
  },
  {
    id: 'recordClip',
    label: 'Record a 2 s clip',
    gesture: true,
    run: async () => {
      if (!micStream) return { status: 'could-not-run', detail: 'no microphone stream (see the microphone check)' }
      if (typeof MediaRecorder === 'undefined') return no('MediaRecorder is not defined')
      const rec = new MediaRecorder(micStream)
      const chunks: Blob[] = []
      rec.ondataavailable = e => e.data.size && chunks.push(e.data)
      const stopped = new Promise(r => (rec.onstop = r))
      rec.start()
      await wait(2000)
      rec.stop()
      await withTimeout(stopped, 4000)
      const blob = new Blob(chunks, { type: rec.mimeType })
      return blob.size > 0 ? yes(`${blob.size} bytes of ${rec.mimeType || 'unknown type'}`, { bytes: blob.size, mimeType: rec.mimeType }) : no(`recorder produced 0 bytes (${rec.mimeType})`)
    },
  },
  { id: 'autoplayAfterTap', label: 'Audio playback, after a tap', gesture: true, run: tryPlay },
  {
    id: 'speechRecognitionRun',
    label: 'SpeechRecognition actually starts',
    gesture: true,
    run: async () => {
      const w = window as unknown as Record<string, new () => any>
      const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
      if (!Ctor) return no('no SpeechRecognition constructor')
      const r = new Ctor()
      r.lang = 'en-GB'
      const outcome = new Promise<Result>(done => {
        r.onaudiostart = () => done(yes('started and is receiving audio (onaudiostart)'))
        r.onerror = (e: { error?: string; message?: string }) => done(e.error === 'not-allowed' ? { status: 'denied', detail: 'error: not-allowed' } : { status: 'no', detail: `error: ${e.error ?? '?'} ${e.message ?? ''}`.trim() })
      })
      r.start()
      const res = await Promise.race([outcome, wait(5000).then((): Result => ({ status: 'could-not-run', detail: 'no start or error event in 5 s' }))])
      try {
        r.abort()
      } catch (err) {
        console.error('probe: SpeechRecognition.abort failed:', err)
      }
      return res
    },
  },
]

// ---------------------------------------------------------------- page

const root = document.getElementById('probe')!
root.innerHTML = `
  <h1>ClaudeVR headset probe</h1>
  <p class="lede">Checks run on load. Press the big button for the ones that need a tap. Everything is sent to the bridge log.</p>
  <button id="tap" class="big">Run tap checks (mic, recording, sound, speech)</button>
  <div id="post" class="post">Not sent yet</div>
  <ul id="list" class="checks"></ul>
  <form id="pair" class="pair" hidden>
    <label for="token">Token, from the bridge's pairing-token file (or pair with a code on the HUD page)</label>
    <input id="token" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="text" />
    <button class="big" type="submit">Pair and send</button>
  </form>
  <p class="foot"><a href="/">Open the HUD</a></p>
`
const list = root.querySelector<HTMLUListElement>('#list')!
const post = root.querySelector<HTMLDivElement>('#post')!
const pairForm = root.querySelector<HTMLFormElement>('#pair')!
const tapButton = root.querySelector<HTMLButtonElement>('#tap')!

const WORDS: Record<Status, string> = { yes: 'YES', no: 'NO', denied: 'DENIED', 'could-not-run': 'COULD NOT RUN', 'needs-tap': 'NEEDS TAP', running: 'RUNNING' }

function render(): void {
  list.innerHTML = ''
  for (const c of CHECKS) {
    const r = results.get(c.id) ?? { status: c.gesture ? 'needs-tap' : 'running', detail: '' }
    const li = document.createElement('li')
    li.className = `check s-${r.status}`
    const head = document.createElement('div')
    head.className = 'check-head'
    const label = document.createElement('span')
    label.textContent = c.label
    const word = document.createElement('span')
    word.className = 'word'
    word.textContent = WORDS[r.status]
    head.append(label, word)
    const detail = document.createElement('div')
    detail.className = 'detail'
    detail.textContent = r.detail
    li.append(head, detail)
    list.append(li)
  }
}

async function runChecks(gesture: boolean): Promise<void> {
  for (const c of CHECKS.filter(x => x.gesture === gesture)) {
    results.set(c.id, { status: 'running', detail: '' })
    render()
    try {
      results.set(c.id, await withTimeout(c.run(), c.id === 'getUserMedia' ? 35_000 : TIMEOUT_MS + 2000))
    } catch (err) {
      results.set(c.id, failed(err))
    }
    render()
  }
}

async function send(phase: string): Promise<void> {
  const token = readToken()
  if (!token) {
    post.className = 'post bad'
    post.textContent = 'NOT SENT: this browser is not paired yet. Pair it on the HUD page (/) with a code, or enter a token below.'
    pairForm.hidden = false
    return
  }
  const body = {
    phase,
    page: location.href,
    at: new Date().toISOString(),
    results: Object.fromEntries(CHECKS.map(c => [c.id, results.get(c.id) ?? { status: c.gesture ? 'needs-tap' : 'could-not-run', detail: 'not run' }])),
  }
  post.className = 'post'
  post.textContent = 'Sending…'
  try {
    const r = await fetch('/api/probe', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
    if (r.status === 401) {
      forgetToken()
      post.className = 'post bad'
      post.textContent = "NOT SENT: the bridge refused this browser's token. Pair again on the HUD page (/), or enter a token below."
      pairForm.hidden = false
      return
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    post.className = 'post good'
    post.textContent = `SENT to the bridge log (${phase} checks) at ${new Date().toLocaleTimeString()}`
    pairForm.hidden = true
  } catch (err) {
    post.className = 'post bad'
    post.textContent = `NOT SENT: ${err instanceof Error ? err.message : String(err)}`
  }
}

pairForm.addEventListener('submit', async e => {
  e.preventDefault()
  const token = cleanToken(root.querySelector<HTMLInputElement>('#token')!.value)
  const check = await checkToken(token)
  if (!check.ok) {
    post.className = 'post bad'
    post.textContent = `NOT PAIRED: ${check.error}`
    return
  }
  saveToken(token)
  await send('all')
})

tapButton.addEventListener('click', async () => {
  tapButton.disabled = true
  tapButton.textContent = 'Running… allow the microphone if asked'
  await runChecks(true)
  micStream?.getTracks().forEach(t => t.stop())
  micStream = null
  tapButton.disabled = false
  tapButton.textContent = 'Run tap checks again'
  await send('tap')
})

render()
runChecks(false).then(
  () => send('load'),
  err => {
    post.className = 'post bad'
    post.textContent = `probe failed: ${String(err)}`
  },
)
