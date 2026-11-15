// Instrument mode: the immersive-ar HUD. This file is the lazy chunk's
// entry; the 2D page imports it in the background (hud/InstrumentEntry.tsx)
// and mounts <Instrument mode="xr"> once it arrives, so an Enter press can
// request the session inside the press. The scene itself mounts only while
// a session runs, or in the desktop preview at /?instrument=preview
// (add &theme=<name> to force a theme pack there).

import { memo, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { PointerEvents, XR, noEvents, useXR } from '@react-three/xr'
import { signal } from '@preact/signals-core'
import { BackSide, Euler, Quaternion, Vector3, type Group, type Object3D } from 'three'
import type { AgentInfo, Session } from '../../../shared/protocol.ts'
import type { BridgeState } from '../hud/useBridge.ts'
import { IN_INSTRUMENT_KEY } from '../hud/InstrumentEntry.tsx'
import { unlockAudio } from '../hud/voice/audio-context.ts'
import { voiceTap, type Voice } from '../hud/voice/useVoice.ts'
import { Controls } from './Controls.tsx'
import { Alarm, CardView, CORE_Y, HeardLine, Iris, RING_R, RING_Z, Rings, TopArc, VoiceArc, sameVoice } from './Core.tsx'
import { leakProbe } from './leakprobe.ts'
import { settings, setSetting, useSettings } from './settings.ts'
import { audioListener, blips, chime, routeFrom } from './sound.ts'
import { FRAMEBUFFER_SCALE, countTextures, glTextures, store } from './store.ts'
import { MESH_WIDTH_M, RADIUS, STREAM_HEIGHT_M, StreamLayer, StreamMesh, streamScroll, useTranscript, type Target } from './Stream.tsx'
import { countRender, flush, frameStats, frameTick, log, resetFrames, startTelemetry, takeRenders } from './telemetry.ts'
import { STATE_WORDS, characterAccent, stateColour } from './theme.ts'
import { Badge, StreamFrame, TopSweep } from './themes/faces.tsx'
import { ThemePart } from './themes/parts.tsx'
import { ThemeDriver } from './themes/runtime.tsx'
import { Tether, Tiles, itemId, slotPose, useTiles } from './Tiles.tsx'
import { Rail, ReplyCards, useReplies } from './Cards.tsx'
import { LineBatch, LineWork } from './linework.tsx'
import { CharacterButtons } from './Characters.tsx'
import { DispatcherStrip } from './SubAgents.tsx'

/** A press on the iris shorter than this is a tap (back to the dispatcher), not speech. */
const TAP_MS = 350
const STATS_MS = 5000
/** Thumbstick scroll speed, design px per second at full deflection. */
const SCROLL_PX_S = 700
const LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1'
/** The preview's forced theme pack (?instrument=preview&theme=<name>), or null for the character's own. */
const PREVIEW_THEME = new URLSearchParams(location.search).get('theme')

let pressedAt: number | null = null

/** On localhost with no WebXR, @react-three/xr installs Meta's emulator asynchronously; wait for it briefly. */
function emulatorReady(ms: number): Promise<void> {
  if (!LOCAL || store.getState().emulator) return Promise.resolve()
  return new Promise(done => {
    const t = setTimeout(() => {
      stop()
      done()
    }, ms)
    const stop = store.subscribe(st => {
      if (!st.emulator) return
      clearTimeout(t)
      stop()
      done()
    })
  })
}

/**
 * Desktop Chromium has a native navigator.xr that offers no sessions, and
 * IWER will not replace a native runtime unless forced, so the emulator
 * @react-three/xr starts stays inert. On localhost only, force it in.
 * `?emulatelayers=1` also installs IWER's WebXR Layers polyfill, which runs
 * the layer code path (drawn in WebGL, not by a compositor).
 */
function forceEmulator(): void {
  const em = store.getState().emulator as { installRuntime?: (o: { forceInstall: boolean; polyfillLayers: boolean }) => void; __claudevrForced?: true } | undefined
  if (!LOCAL || !em?.installRuntime || em.__claudevrForced) return
  em.__claudevrForced = true
  const polyfillLayers = new URLSearchParams(location.search).get('emulatelayers') === '1'
  em.installRuntime({ forceInstall: true, polyfillLayers })
  console.warn(`instrument: IWER emulator forced over the native runtime${polyfillLayers ? ', with the layers polyfill' : ''}`)
}

export async function arSupported(): Promise<boolean> {
  try {
    if (!(await navigator.xr?.isSessionSupported('immersive-ar'))) {
      await emulatorReady(5000)
      forceEmulator()
    }
    return (await navigator.xr?.isSessionSupported('immersive-ar')) ?? false
  } catch (err) {
    console.error('instrument: isSessionSupported failed:', err)
    return false
  }
}

/**
 * The Enter press. Everything that needs a user gesture happens here, in
 * the press: the audio context is resumed, the mic is asked for (not
 * awaited, so the session request stays inside the gesture), and the
 * session is requested.
 */
export function enterInstrument(voice: Voice): Promise<void> {
  pressedAt = performance.now()
  unlockAudio()
  log('enter-press', { micBefore: voice.recorder.micState(), visibility: document.visibilityState, focused: document.hasFocus() })
  voice.recorder.ensureMic().then(
    () => log('mic-ready', { mic: voice.recorder.micState(), sincePressMs: Math.round(performance.now() - (pressedAt ?? 0)) }),
    (err: unknown) => {
      console.error('instrument: microphone not available at entry:', err)
      log('mic-failed', { error: String(err) })
    },
  )
  return store.enterAR().then(
    () => undefined,
    (err: unknown) => {
      console.error('instrument: enterAR failed:', err)
      log('enter-failed', { error: String(err) })
      void flush()
      throw err
    },
  )
}

export interface InstrumentProps {
  mode: 'xr' | 'preview'
  token: string
  bridge: BridgeState
  voice: Voice
  alarms: string[]
  /** The selected tile's id (a session), null for the dispatcher. */
  selected: string | null
  onSelect: (id: string | null) => void
  /** Read by the voice hook: true while a session runs. */
  immersive: MutableRefObject<boolean>
  onSessionChange: (active: boolean) => void
}

/** What the scene needs that the props carry, plus the latest props for callbacks. */
interface GateProps extends InstrumentProps {
  latest: MutableRefObject<InstrumentProps>
}

/**
 * The 2D page renders every second (its clock) and builds a new voice
 * object each time; none of that should reach the scene. The scene renders
 * again only when something it draws changed: the fleet, the selection, an
 * alarm's text, or one of the voice fields shown (sameVoice). Callbacks are
 * read from `latest` when they run, so they are never stale.
 */
function sameGate(a: GateProps, b: GateProps): boolean {
  return a.mode === b.mode && a.token === b.token && a.bridge.fleet === b.bridge.fleet && a.bridge.conversation === b.bridge.conversation && a.selected === b.selected && a.immersive === b.immersive && a.latest === b.latest && a.alarms.join('\n') === b.alarms.join('\n') && sameVoice(a.voice, b.voice)
}

export function Instrument(p: InstrumentProps) {
  const preview = p.mode === 'preview'
  const latest = useRef(p)
  latest.current = p
  useEffect(() => {
    startTelemetry(p.token)
  }, [p.token])
  useEffect(() => {
    if (!preview) return
    log('preview-start', { ua: navigator.userAgent })
    voiceTap.emit = (type, data) => log(type, { ...data, mode: 'preview' })
    return () => {
      voiceTap.emit = null
    }
  }, [preview])
  return (
    <div className={preview ? 'instrument-preview' : 'instrument-host'} aria-hidden={!preview}>
      <Canvas
        flat
        frameloop={preview ? 'always' : 'demand'}
        events={noEvents}
        gl={{ alpha: true, antialias: true, powerPreference: 'high-performance' }}
        camera={{ position: [0, 0, 0], fov: 62, near: 0.05, far: 20 }}
        onCreated={({ gl, scene }) => {
          countTextures(gl)
          gl.setClearColor(0x000000, 0)
          scene.background = null
        }}
      >
        <PointerEvents />
        <XR store={store}>
          <Gate {...p} latest={latest} />
        </XR>
      </Canvas>
    </div>
  )
}

/** Mounts the scene only while a session runs (or always in the preview), and owns the session's bookkeeping. */
const Gate = memo(function Gate(p: GateProps) {
  const session = useXR(s => s.session)
  const gl = useThree(s => s.gl)
  const camera = useThree(s => s.camera)
  const preview = p.mode === 'preview'
  const latest = p.latest

  useEffect(() => {
    if (!session) return
    const started = performance.now()
    let reloadAt: number | null = null
    try {
      const v = sessionStorage.getItem('claudevr.reloadAt')
      reloadAt = v ? Number(v) : null
      sessionStorage.removeItem('claudevr.reloadAt')
      sessionStorage.setItem(IN_INSTRUMENT_KEY, '1')
    } catch (err) {
      console.error('instrument: sessionStorage unavailable:', err)
    }
    p.immersive.current = true
    latest.current.onSessionChange(true)
    const v = latest.current.voice
    voiceTap.emit = (type, data) => log(type, data)
    v.recorder.onTrackEvent = (type, state) => log(`mic-track-${type}`, { mic: state })
    const base = gl.xr.getBaseLayer?.() as XRWebGLLayer | XRProjectionLayer | undefined
    log('session-start', {
      enabledFeatures: (session as XRSession & { enabledFeatures?: string[] }).enabledFeatures ?? null,
      environmentBlendMode: session.environmentBlendMode ?? null,
      frameRate: session.frameRate ?? null,
      supportedFrameRates: session.supportedFrameRates ? Array.from(session.supportedFrameRates) : null,
      framebuffer: base ? { width: (base as XRWebGLLayer).framebufferWidth ?? (base as XRProjectionLayer).textureWidth ?? null, height: (base as XRWebGLLayer).framebufferHeight ?? (base as XRProjectionLayer).textureHeight ?? null, kind: base.constructor?.name ?? null } : null,
      framebufferScale: FRAMEBUFFER_SCALE,
      loadToSessionMs: Math.round(started),
      pressToSessionMs: pressedAt === null ? null : Math.round(started - pressedAt),
      reloadToSessionMs: reloadAt ? Date.now() - reloadAt : null,
      mic: v.recorder.micState(),
      settings: settings.current,
      inputSources: Array.from(session.inputSources).map(s => ({ hand: s.handedness, mode: s.targetRayMode, profiles: s.profiles })),
    })
    const micAt = (label: string) => log('mic', { at: label, mic: latest.current.voice.recorder.micState(), visibility: session.visibilityState })
    const t2 = setTimeout(() => micAt('+2s'), 2000)
    const t10 = setTimeout(() => micAt('+10s'), 10_000)
    const every = setInterval(() => micAt('every 30s'), 30_000)
    micAt('+0s')
    const onVis = () => log('xr-visibility', { state: session.visibilityState })
    const onSources = (e: XRInputSourcesChangeEvent) => log('xr-inputs', { added: e.added.map(s => `${s.handedness}/${s.targetRayMode}`), removed: e.removed.map(s => `${s.handedness}/${s.targetRayMode}`) })
    session.addEventListener('visibilitychange', onVis)
    session.addEventListener('inputsourceschange', onSources as EventListener)
    const l = audioListener(camera)
    log('audio', { listener: !!l })
    void flush()
    return () => {
      clearTimeout(t2)
      clearTimeout(t10)
      clearInterval(every)
      session.removeEventListener('visibilitychange', onVis)
      session.removeEventListener('inputsourceschange', onSources as EventListener)
      p.immersive.current = false
      voiceTap.emit = null
      latest.current.voice.recorder.onTrackEvent = null
      latest.current.voice.speaker.route = null
      try {
        sessionStorage.removeItem(IN_INSTRUMENT_KEY)
      } catch (err) {
        console.error('instrument: sessionStorage unavailable:', err)
      }
      log('session-end', { durationS: Math.round((performance.now() - started) / 100) / 10, mic: latest.current.voice.recorder.micState() })
      resetFrames()
      void flush()
      latest.current.onSessionChange(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  if (!session && !preview) return null
  return <Scene {...p} session={session ?? null} />
}, sameGate)

/** A stable function that always calls the latest `fn`. */
function useStable<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
  const r = useRef(fn)
  r.current = fn
  return useMemo(() => (...a: A) => r.current(...a), [])
}

/** A ref to the latest value, for callbacks handed to memoised children. */
function useLatest<T>(v: T): MutableRefObject<T> {
  const r = useRef(v)
  r.current = v
  return r
}

/** `value`, or the previous one when `key` has not changed: keeps identities steady across fleet reads. */
function useKeyed<T>(key: string, value: T): T {
  const r = useRef<{ key: string; value: T } | null>(null)
  if (!r.current || r.current.key !== key) r.current = { key, value }
  return r.current.value
}

function Scene(p: GateProps & { session: XRSession | null }) {
  countRender('scene')
  const { bridge, voice, session, latest } = p
  const preview = p.mode === 'preview'
  const s = useSettings()
  const fleet = bridge.fleet
  const rig = useRef<Group>(null)
  const irisRef = useRef<Group | null>(null)
  const tileRefs = useRef<(Group | null)[]>([])
  const level = useRef(0)
  const camera = useThree(st => st.camera)
  const gl = useThree(st => st.gl)
  const scene3 = useThree(st => st.scene)
  const batch = useMemo(() => new LineBatch(), [])
  const voiceRef = useMemo(() => ({ get current() { return latest.current.voice } }), [latest]) as MutableRefObject<Voice>
  const select = useStable((id: string | null) => latest.current.onSelect(id))

  // ------------------------------------------------------------ who the Core addresses
  const items = useTiles(fleet?.sessions)
  const dispatcher = fleet?.sessions.find(x => x.kind === 'dispatcher') ?? null
  const sel = p.selected
  const selSession = sel ? (fleet?.sessions.find(x => x.id === sel) ?? null) : null
  const tileSlots = useMemo(() => new Map(items.filter(it => it.kind === 'session').map(it => [itemId(it), it.slot])), [items])
  const hasMore = items.some(it => it.kind === 'more')
  const rawTarget: Target = selSession ? { kind: 'session', session: selSession } : { kind: 'dispatcher', session: dispatcher }
  // The Stream re-renders only when what it shows of the target changes, not on every fleet read.
  const ts = rawTarget.session
  const target = useKeyed(`${rawTarget.kind}|${ts?.id ?? ''}|${ts?.callsign ?? ''}|${ts?.state ?? ''}|${ts?.lastLine ?? ''}|${ts?.messages.map(m => m.text).join('\u0001') ?? ''}`, rawTarget)
  const data = useTranscript(p.token, target)

  // ------------------------------------------------------------ a picked sub-agent
  // Shown in the Stream, read-only. The talk target stays its parent: the
  // session it belongs to is selected with it (the dispatcher: no selection).
  const [agentSel, setAgentSel] = useState<{ sessionId: string; agentId: string } | null>(null)
  const agentOwner = agentSel ? (fleet?.sessions.find(x => x.id === agentSel.sessionId) ?? null) : null
  const rawAgent = agentSel ? (agentOwner?.agents?.find(a => a.id === agentSel.agentId) ?? null) : null
  const agentShown: AgentInfo | null = useKeyed(JSON.stringify(rawAgent), rawAgent)
  const agentOwnerName = agentOwner ? (agentOwner.kind === 'dispatcher' ? 'DISPATCHER' : agentOwner.callsign.toUpperCase()) : null
  // Dropped when the agent leaves the fleet, or the selection then moves off its parent. Only a change of
  // selection counts: the parent's selection arrives a render later (the 2D page's state, another renderer).
  const lastSel = useRef(sel)
  useEffect(() => {
    const moved = lastSel.current !== sel
    lastSel.current = sel
    if (!agentSel) return
    if (!rawAgent || !agentOwner) return setAgentSel(null)
    if (moved && sel !== (agentOwner.kind === 'dispatcher' ? null : agentOwner.id)) setAgentSel(null)
  }, [agentSel, agentOwner, rawAgent, sel])
  const pickAgent = useStable((sessionId: string, agentId: string | null) => {
    const owner = fleet?.sessions.find(x => x.id === sessionId) ?? null
    log('agent-pick', { sessionId, agentId, again: agentSel?.agentId === agentId })
    // The "+N" box, or the open agent picked again: back to the parent's own stream.
    const next = agentId && agentSel?.agentId !== agentId ? { sessionId, agentId } : null
    setAgentSel(next)
    select(owner?.kind === 'dispatcher' ? null : sessionId)
  })
  const fleetIds = useMemo(() => new Set((fleet?.sessions ?? []).map(x => x.id)), [fleet])
  const targetId = target.session?.id ?? null
  // With a character on, the dispatcher's iris reads "TALK TO <NAME>": he talks to the character, the dispatcher does the work.
  const character = voice.character
  const irisName = target.kind === 'dispatcher' ? (character ? character.name.toUpperCase() : 'DISPATCHER') : target.session.callsign.toUpperCase()
  const irisSub = target.kind === 'dispatcher' ? (dispatcher ? STATE_WORDS[dispatcher.state] : 'NOT IN FLEET') : STATE_WORDS[target.session.state]
  // A character's accent replaces cyan where the scene speaks for the bridge itself: the Core's rings and the dispatcher's iris.
  // A theme pack's own accent comes first (theme.ts).
  const accent = characterAccent(voice.character)
  // The theme follows the character (the bridge resolves which pack); the preview can force one.
  const wantTheme = (preview && PREVIEW_THEME) || character?.theme || null
  const irisColour = target.kind === 'dispatcher' ? accent : stateColour(target.session.state)

  // A selection whose session left the fleet falls back to the dispatcher.
  useEffect(() => {
    if (!fleet || !sel) return
    if (!fleetIds.has(sel)) select(null)
  }, [fleet, fleetIds, sel, select])
  useEffect(() => log('target', { kind: target.kind, id: p.selected }), [target.kind, p.selected])

  // ------------------------------------------------------------ cards
  const [replies, dismissReply] = useReplies(fleet, targetId)
  const lit = useMemo(() => new Set(replies.shown.map(c => tileSlots.get(c.id)).filter((x): x is number => x !== undefined)), [replies.shown, tileSlots])
  const openSession = useLatest((id: string) => {
    log('card-pick', { id })
    dismissReply(id)
    select(id)
  })
  const pickTile = useStable((id: string) => {
    const more = items.find(it => it.kind === 'more')
    if (more?.kind === 'more' && id === more.id) {
      // The "+N" tile steps through the sessions without a tile of their own.
      const i = more.hidden.findIndex(h => h.id === sel)
      const next = more.hidden[(i + 1) % more.hidden.length]
      log('more-pick', { to: next?.id ?? null, hidden: more.hidden.length })
      if (next) select(next.id)
      return
    }
    setAgentSel(null)
    select(sel === id ? null : id)
  })
  const pickRef = useLatest(pickTile)
  const pickAgentRef = useLatest(pickAgent)

  // ------------------------------------------------------------ sound
  useEffect(() => {
    const iris = irisRef.current
    if (!iris) return
    voice.speaker.route = routeFrom(iris, camera)
    return () => {
      voice.speaker.route = null
    }
  }, [voice.speaker, camera])
  const phaseKind = voice.phase.kind
  const lastPhase = useRef(phaseKind)
  useEffect(() => {
    if (phaseKind === 'recording' && lastPhase.current !== 'recording') blips.listenStart()
    if (lastPhase.current === 'recording' && phaseKind !== 'recording') blips.listenStop()
    lastPhase.current = phaseKind
  }, [phaseKind])
  const cardState = voice.card?.state
  useEffect(() => {
    if (cardState === 'sending') blips.send()
  }, [cardState])

  // ------------------------------------------------------------ hold to talk
  const hold = useRef<{ by: 'iris' | 'grip'; at: number } | null>(null)
  const startHold = useStable((by: 'iris' | 'grip') => {
    if (hold.current) return
    hold.current = { by, at: performance.now() }
    log('hold-start', { by })
    void voiceRef.current.begin()
  })
  const endHold = useStable((by: 'iris' | 'grip' | 'any') => {
    const h = hold.current
    if (!h || (by !== 'any' && by !== h.by)) return
    hold.current = null
    const ms = performance.now() - h.at
    log('hold-end', { by: h.by, ms: Math.round(ms) })
    if (ms < TAP_MS) {
      void voiceRef.current.end('tap')
      if (h.by === 'iris') {
        setAgentSel(null)
        select(null)
      }
    } else void voiceRef.current.end('release')
  })
  const irisHandlers = useLatest({ onDown: () => startHold('iris'), onUp: () => endHold('iris') })

  useEffect(() => {
    if (!session) {
      // The preview: a release anywhere on the page ends the hold.
      const up = () => endHold('any')
      addEventListener('pointerup', up)
      return () => removeEventListener('pointerup', up)
    }
    const sqStart = (e: XRInputSourceEvent) => {
      log('squeeze', { hand: e.inputSource.handedness })
      startHold('grip')
    }
    const sqEnd = () => endHold('grip')
    const selEnd = () => endHold('iris')
    session.addEventListener('squeezestart', sqStart as EventListener)
    session.addEventListener('squeezeend', sqEnd)
    session.addEventListener('selectend', selEnd)
    return () => {
      session.removeEventListener('squeezestart', sqStart as EventListener)
      session.removeEventListener('squeezeend', sqEnd)
      session.removeEventListener('selectend', selEnd)
    }
  }, [session, startHold, endHold])

  // ------------------------------------------------------------ fake a need
  const [pulse, setPulse] = useState<{ slot: number; n: number } | null>(null)
  const fakeNeed = useStable(() => {
    const slots = items.map(it => it.slot)
    const slot = slots.length ? slots[Math.floor(Math.random() * slots.length)]! : 0
    const from = tileRefs.current[slot]
    log('fake-need', { slot, side: slotPose(slot).side < 0 ? 'left' : 'right' })
    if (from) chime(from, camera)
    setPulse(q => ({ slot, n: (q?.n ?? 0) + 1 }))
  })

  // ------------------------------------------------------------ frame loop
  const centre = useRef(true)
  const perf = useMemo(() => signal(preview ? 'PREVIEW: no frame stats' : 'FRAMES: measuring…'), [preview])
  const mic = useMemo(() => signal('MIC: ?'), [])
  const lastStats = useRef(performance.now())
  const pos = useMemo(() => new Vector3(), [])
  const quat = useMemo(() => new Quaternion(), [])
  const eul = useMemo(() => new Euler(0, 0, 0, 'YXZ'), [])
  // What the scene holds, for the frame log: read in the frame loop without re-rendering.
  const counts = useLatest({ tiles: items.filter(it => it.kind === 'session').length, hiddenSessions: items.find(it => it.kind === 'more')?.kind === 'more' ? (items.find(it => it.kind === 'more') as { hidden: Session[] }).hidden.length : 0, rail: fleet?.needs.length ?? 0, replyCards: replies.shown.length, replyQueued: replies.waiting.length, selected: target.kind })

  // Draw calls per frame, all render passes counted (the scene, both eyes, and a layer's own render): three's
  // counter is reset here, first thing each frame, instead of at the start of every render() call.
  const draws = useMemo(() => ({ sum: 0, n: 0, max: 0, last: 0 }), [])
  useEffect(() => {
    gl.info.autoReset = false
    return () => void (gl.info.autoReset = true)
  }, [gl])
  useFrame(() => {
    const c = gl.info.render.calls
    draws.last = c
    draws.sum += c
    draws.n++
    if (c > draws.max) draws.max = c
    gl.info.reset()
  }, -1000)

  useFrame((_, dt, frame?: XRFrame) => {
    const now = performance.now()
    voiceRef.current.tick(Date.now())
    level.current = voiceRef.current.recorder.level() ?? 0
    const r = rig.current
    if (r && session && frame && centre.current) {
      const space = gl.xr.getReferenceSpace()
      const pose = space ? frame.getViewerPose(space) : undefined
      if (pose) {
        const t = pose.transform
        pos.set(t.position.x, t.position.y, t.position.z)
        quat.set(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w)
        eul.setFromQuaternion(quat, 'YXZ')
        r.position.copy(pos)
        r.rotation.set(0, eul.y, 0)
        r.visible = true
        centre.current = false
        log('centred', { at: [pos.x, pos.y, pos.z].map(n => Math.round(n * 1000) / 1000), yawDeg: Math.round((eul.y * 180) / Math.PI) })
      }
    }
    if (preview && now - lastStats.current >= STATS_MS) {
      lastStats.current = now
      perf.value = `PREVIEW · ${draws.n ? Math.round(draws.sum / draws.n) : 'n/a'} DRAWS A FRAME (MAX ${draws.max})`
      draws.sum = draws.n = draws.max = 0
    }
    if (!session) return
    frameTick(now)
    const sources = session.inputSources
    for (let i = 0; i < sources.length; i++) {
      const y = sources[i]!.gamepad?.axes[3] ?? 0
      if (Math.abs(y) > 0.2) streamScroll.pending += y * SCROLL_PX_S * dt
    }
    if (now - lastStats.current >= STATS_MS) {
      lastStats.current = now
      const st = frameStats()
      const info = gl.info
      const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null
      const m = voiceRef.current.recorder.micState()
      const perFrame = draws.n ? { mean: Math.round(draws.sum / draws.n), max: draws.max, frames: draws.n } : null
      log('frames', {
        ...(st ?? { n: 0 }),
        memory: { geometries: info.memory.geometries, textures: info.memory.textures },
        glTexturesCreated: glTextures.created,
        glTexturesDeleted: glTextures.deleted,
        // Every render pass in the frame, both eyes and the Stream layer included; null when no frame was counted.
        drawCalls: perFrame,
        render: { calls: draws.last, triangles: info.render.triangles },
        scene: counts.current,
        lineWork: batch.stats(),
        // React renders in the last few seconds, by component: these should follow fleet reads, not the clock.
        renders: takeRenders(),
        programs: info.programs?.length ?? null,
        jsHeap: heap,
        settings: settings.current,
        visibility: session.visibilityState,
      })
      draws.sum = draws.n = draws.max = 0
      if (st) perf.value = `FRAMES ${st.fps} FPS · P50 ${st.p50} · P99 ${st.p99} MS · ${st.dropped} SLOW · ${perFrame ? perFrame.mean : 'n/a'} DRAWS`
      mic.value = `MIC ${m.stream ? m.readyState.toUpperCase() : 'NOT OPEN'}${m.muted ? ' · MUTED' : ''}${voiceRef.current.phase.kind === 'recording' ? ' · RECORDING' : ''}`
    }
  })

  // Which objects draw, once 10 s into a session and every minute after, for the headset log.
  useEffect(() => {
    if (!session) return
    const run = () =>
      void censusOf(scene3, cb => session.requestAnimationFrame(() => cb())).then(
        c => log('draw-census', { byPart: c, scene: counts.current }),
        (err: unknown) => console.error('instrument: draw census failed:', err),
      )
    const first = setTimeout(run, 10_000)
    const every = setInterval(run, 60_000)
    return () => {
      clearTimeout(first)
      clearInterval(every)
    }
  }, [session, scene3, counts])

  // The preview has no head pose: the rig stays at the origin.
  useEffect(() => {
    if (rig.current) rig.current.visible = preview
    centre.current = !preview
  }, [preview])

  const layers = useXR(st => st.session?.enabledFeatures?.includes('layers') ?? false)
  const useLayer = !preview && s.stream === 'layer'
  const streamNote = preview ? 'PREVIEW: mesh Stream only' : useLayer ? (layers ? 'STREAM ON A COMPOSITOR LAYER' : 'NO LAYERS FEATURE: LAYER MODE IS A FALLBACK MESH') : 'STREAM AS A UIKIT MESH'
  const selectedSlot = sel ? (items.find(it => itemId(it) === sel)?.slot ?? null) : null
  const exit = useStable(() => {
    log('exit-press', {})
    if (preview) location.href = '/'
    else void session?.end()
  })
  const recenter = useStable(() => void (centre.current = true))
  const alarms = useKeyed(p.alarms.join('\n'), p.alarms)

  return (
    <group ref={rig} visible={preview}>
      <LineWork batch={batch}>
        {s.dimmer > 0 && (
          <mesh renderOrder={-1000} name="dimmer">
            <sphereGeometry args={[3, 32, 16]} />
            <meshBasicMaterial color="#000" side={BackSide} transparent opacity={s.dimmer} depthWrite={false} toneMapped={false} />
          </mesh>
        )}
        <ThemeDriver token={p.token} want={wantTheme} />
        <ThemePart part="core">
          <Rings accent={accent} />
        </ThemePart>
        <group name="top-arc">
          <ThemePart part="core">
            <TopArc usage={fleet?.usage} />
            <TopSweep r={RING_R} z={RING_Z + 0.003} />
            <Badge y={CORE_Y + 0.535} z={RING_Z + 0.01} />
          </ThemePart>
        </group>
        <group name="stream">
          <ThemePart part="stream">
            <StreamFrame w={MESH_WIDTH_M} h={STREAM_HEIGHT_M} z={-RADIUS + 0.002} />
          </ThemePart>
          {useLayer ? <StreamLayer y={CORE_Y} target={target} data={data} plate={s.plate} character={character} conversation={bridge.conversation} agent={agentShown} agentOwner={agentOwnerName} /> : <StreamMesh y={CORE_Y} target={target} data={data} plate={s.plate} character={character} conversation={bridge.conversation} agent={agentShown} agentOwner={agentOwnerName} />}
        </group>
        <group name="dispatcher-agents">
          <ThemePart part="rail">
            <DispatcherStrip session={dispatcher} selectedAgent={agentSel?.agentId ?? null} plate={s.plate} onPick={pickAgentRef} />
          </ThemePart>
        </group>
        <group name="characters">
          <ThemePart part="rail">
            <CharacterButtons voice={voice} />
          </ThemePart>
        </group>
        <ThemePart part="core">
          <group name="voice-arc">
            <VoiceArc voice={voice} level={level} />
          </group>
          <group name="iris">
            <Iris name={irisName} sub={irisSub} colour={irisColour} recording={voice.phase.kind === 'recording'} level={level} irisRef={irisRef} handlers={irisHandlers} voice={voiceRef} />
          </group>
          <group name="heard">
            <HeardLine voice={voice} />
          </group>
          <group name="send-card">
            <CardView voice={voice} voiceRef={voiceRef} fleetIds={fleetIds} />
          </group>
          <group name="alarm">
            <Alarm lines={alarms} above={!!fleet?.needs.length} />
          </group>
        </ThemePart>
        <group name="tiles">
          {/* Each wing keys itself by its side's part (Tiles.tsx). */}
          <Tiles items={items} selected={sel} selectedAgent={agentSel?.agentId ?? null} pulse={pulse} lit={lit} tileRefs={tileRefs} onPick={id => pickRef.current(id)} onPickAgent={pickAgent} />
          <ThemePart part="rail">
            <Tether slot={selectedSlot} />
          </ThemePart>
        </group>
        <group name="rail">
          <ThemePart part="rail">
            <Rail needs={fleet?.needs ?? []} selected={targetId} onPick={openSession} />
          </ThemePart>
        </group>
        <group name="replies">
          <ThemePart part="right">
            <ReplyCards cards={replies.shown} slots={tileSlots} hasMore={hasMore} onPick={openSession} />
          </ThemePart>
        </group>
        <group name="controls">
          <ThemePart part="controls">
            <Controls streamNote={streamNote} perf={perf} mic={mic} preview={preview} onRecenter={recenter} onFakeNeed={fakeNeed} onExit={exit} />
          </ThemePart>
        </group>
      </LineWork>
      {preview && <PreviewCamera />}
      <Hooks fakeNeed={fakeNeed} startHold={startHold} endHold={endHold} voice={voiceRef} draws={draws} batch={batch} />
    </group>
  )
}

/** Desktop preview: right-drag orbits about the Core, the wheel zooms. ?yaw=&pitch=&fov= set a view; ?head=1 turns from the eye instead. */
function PreviewCamera() {
  const camera = useThree(s => s.camera)
  const dom = useThree(s => s.gl.domElement)
  const view = useRef(initialView())
  useEffect(() => {
    let drag: { x: number; y: number } | null = null
    const down = (e: PointerEvent) => {
      if (e.button !== 2) return
      drag = { x: e.clientX, y: e.clientY }
    }
    const move = (e: PointerEvent) => {
      if (!drag) return
      view.current.yaw -= (e.clientX - drag.x) * 0.2
      view.current.pitch = Math.max(-60, Math.min(60, view.current.pitch - (e.clientY - drag.y) * 0.2))
      drag = { x: e.clientX, y: e.clientY }
    }
    const up = () => void (drag = null)
    const wheel = (e: WheelEvent) => {
      view.current.fov = Math.max(25, Math.min(100, view.current.fov + e.deltaY * 0.03))
    }
    const menu = (e: Event) => e.preventDefault()
    dom.addEventListener('pointerdown', down)
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    dom.addEventListener('wheel', wheel, { passive: true })
    dom.addEventListener('contextmenu', menu)
    return () => {
      dom.removeEventListener('pointerdown', down)
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      dom.removeEventListener('wheel', wheel)
      dom.removeEventListener('contextmenu', menu)
    }
  }, [dom])
  const pivot = useMemo(() => new Vector3(0, CORE_Y, -RADIUS), [])
  const offset = useMemo(() => new Vector3(), [])
  const e = useMemo(() => new Euler(0, 0, 0, 'YXZ'), [])
  useFrame(() => {
    const v = view.current
    e.set((v.pitch * Math.PI) / 180, (v.yaw * Math.PI) / 180, 0)
    // ?head=1: the camera stays at the eye and the view turns, as a head does in the headset.
    if (v.head) camera.position.set(0, 0, 0)
    else {
      offset.set(0, -CORE_Y, RADIUS).applyEuler(e)
      camera.position.copy(pivot).add(offset)
    }
    camera.quaternion.setFromEuler(e)
    const pc = camera as typeof camera & { fov?: number; updateProjectionMatrix?: () => void }
    if (pc.fov !== undefined && pc.fov !== v.fov) {
      pc.fov = v.fov
      pc.updateProjectionMatrix?.()
    }
  })
  return null
}

function initialView(): { yaw: number; pitch: number; fov: number; head: boolean } {
  const q = new URLSearchParams(location.search)
  const n = (k: string, d: number) => {
    const v = Number(q.get(k))
    return q.has(k) && Number.isFinite(v) ? v : d
  }
  return { yaw: n('yaw', 0), pitch: n('pitch', 0), fov: n('fov', 62), head: q.get('head') === '1' }
}

/** Test hooks for the headless checks, on localhost only. */
function Hooks({ fakeNeed, startHold, endHold, voice, draws, batch }: { fakeNeed: () => void; startHold: (by: 'iris' | 'grip') => void; endHold: (by: 'iris' | 'grip' | 'any') => void; voice: MutableRefObject<Voice>; draws: { last: number }; batch: LineBatch }) {
  const gl = useThree(s => s.gl)
  const scene = useThree(s => s.scene)
  useEffect(() => {
    if (!LOCAL) return
    ;(window as unknown as { __instrument?: unknown }).__instrument = {
      fakeNeed,
      holdStart: (by: 'iris' | 'grip' = 'grip') => startHold(by),
      holdEnd: (by: 'iris' | 'grip' | 'any' = 'any') => endHold(by),
      setSetting,
      settings: () => settings.current,
      session: () => store.getState().session ?? null,
      flush: () => flush(),
      leakProbe,
      /** Drops the open mic, so the next hold opens it afresh (Chrome's fake mic file restarts with each capture). */
      releaseMic: () => voice.current.recorder.release(),
      /** Draw calls in the last whole frame, every render pass counted. */
      drawCalls: () => draws.last,
      /** React renders by component since the last call. */
      renders: () => takeRenders(),
      lineWork: () => batch.stats(),
      census: () => censusOf(scene, cb => requestAnimationFrame(() => cb())),
      gl: () => gl,
    }
  }, [fakeNeed, startHold, endHold, voice, draws, batch, scene, gl])
  return null
}

/**
 * What the next frame draws, object by object, counted against the nearest
 * named group (the rig's parts are named: rings, tiles, rail...). Settles
 * after one frame; `raf` is the window's or the XR session's.
 */
function censusOf(scene: Object3D | null, raf: (cb: () => void) => void): Promise<Record<string, number>> {
  if (!scene) return Promise.reject(new Error('no scene to count'))
  const counts: Record<string, number> = {}
  const restore: (() => void)[] = []
  scene.traverse(o => {
    let named: Object3D | null = o
    while (named && !named.name) named = named.parent
    const label = named?.name || 'unnamed'
    const prev = o.onBeforeRender
    o.onBeforeRender = function (...a: Parameters<typeof prev>) {
      counts[label] = (counts[label] ?? 0) + 1
      return prev.apply(this, a)
    }
    restore.push(() => void (o.onBeforeRender = prev))
  })
  // Called between frames, so the render loop's callback (queued first) draws once before this one runs.
  return new Promise(done =>
    raf(() => {
      for (const r of restore) r()
      done(counts)
    }),
  )
}
