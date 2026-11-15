// The Stream: the Core's conversation, newest at the bottom, block-level
// formatting only. The same uikit tree draws on a cylinder compositor layer
// (XRLayer) or on a plain uikit mesh panel in the same place, so Sam can
// compare the two by pressing one button.
//
// Design units are millimetres at 1.3 m: the panel is 907 by 505 "px",
// 40 by 22 degrees. Body text is 30 px, about 1.3 degrees, about 55
// characters a line.

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree, type RootState } from '@react-three/fiber'
import { Container, Text } from '@react-three/uikit'
import { XRLayer, useXRSessionFeatureEnabled } from '@react-three/xr'
import { signal } from '@preact/signals-core'
import { OrthographicCamera, SRGBColorSpace, type WebGLRenderTarget } from 'three'
import type { Session, SessionTranscript, Turn } from '../../../shared/protocol.ts'
import { blocks, fit, type Block } from './text.ts'
import { C, DEG, FONTS, STATE_WORDS, stateColour, rgba } from './theme.ts'
import { log } from './telemetry.ts'

export const STREAM_W = 907
export const STREAM_H = 505
export const STREAM_ANGLE = 40 * DEG
export const RADIUS = 1.3
/** The Stream's height in metres, and the flat mesh panel's width: a chord that subtends the same 40 degrees. */
export const STREAM_HEIGHT_M = 0.505
export const MESH_WIDTH_M = 2 * RADIUS * Math.tan(STREAM_ANGLE / 2)
/** Layer render target: about 2.26 layer pixels per design pixel, 51 per degree. */
export const LAYER_W = 2048
export const LAYER_H = Math.round((LAYER_W * STREAM_H) / STREAM_W / 2) * 2

const REFRESH_MS = 6000
const TURNS = 12

/** Who the Core is talking to. A demo tile has no conversation behind it. */
export type Target = { kind: 'dispatcher'; session: Session | null } | { kind: 'session'; session: Session } | { kind: 'demo'; id: string; callsign: string }

export interface StreamData {
  key: string
  turns: Turn[] | null
  problem: string | null
  loaded: boolean
  at: number | null
}

/** The target's last turns from GET /api/transcript, re-read every few seconds and whenever it says something. */
export function useTranscript(token: string, target: Target): StreamData {
  const session = target.kind === 'demo' ? null : target.session
  const id = session?.id ?? null
  const key = target.kind === 'demo' ? `demo:${target.id}` : `s:${id ?? 'none'}`
  const changed = session ? `${session.lastLine ?? ''}|${session.state}` : ''
  const [data, setData] = useState<StreamData>({ key, turns: null, problem: null, loaded: false, at: null })
  useEffect(() => {
    if (!id) {
      setData({ key, turns: null, problem: null, loaded: true, at: null })
      return
    }
    let live = true
    setData(d => (d.key === key ? d : { key, turns: null, problem: null, loaded: false, at: null }))
    const read = async () => {
      try {
        const r = await fetch(`/api/transcript?session=${encodeURIComponent(id)}&limit=${TURNS}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
        const body = (await r.json()) as Partial<SessionTranscript> & { error?: string }
        if (!live) return
        if (r.ok && Array.isArray(body.turns)) {
          const next = body.turns
          // A re-read that says the same thing keeps the same array, so the panel does not lay itself out again every few seconds.
          setData(d => ({ key, turns: d.key === key && d.turns && sameTurns(d.turns, next) ? d.turns : next, problem: null, loaded: true, at: Date.now() }))
        }
        else setData(d => ({ ...d, key, loaded: true, problem: `${r.status === 404 || r.status === 501 ? 'Short clips only' : 'FULL REPLIES UNAVAILABLE'}: ${body.error ?? `HTTP ${r.status}`}` }))
      } catch (err) {
        console.error('instrument: transcript read failed:', err)
        if (live) setData(d => ({ ...d, key, loaded: true, problem: `FULL REPLIES UNAVAILABLE: ${err instanceof Error ? err.message : String(err)}` }))
      }
    }
    void read()
    const t = setInterval(() => void read(), REFRESH_MS)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [token, id, key, changed])
  return data
}

function sameTurns(a: Turn[], b: Turn[]): boolean {
  return a.length === b.length && a.every((t, i) => t.role === b[i]!.role && t.text === b[i]!.text && t.clipped === b[i]!.clipped)
}

/** Scroll requests from the thumbsticks, in design px; the Stream applies them on its next frame. */
export const streamScroll = { pending: 0 }

const plateColour = (opacity: number) => rgba(14, 18, 22, opacity)

interface ContentProps {
  target: Target
  data: StreamData
  plate: number
  sizeX: number
  sizeY: number
  pixelSize: number
}

/** The uikit tree both views draw. */
export const StreamContent = memo(function StreamContent({ target, data, plate, sizeX, sizeY, pixelSize }: ContentProps) {
  const scrollRef = useRef<any>(null)
  const stick = useRef(true)
  const opacity = useMemo(() => signal(0), [])
  const shownKey = useRef<string | null>(null)

  const who = target.kind === 'dispatcher' ? 'DISPATCHER' : target.kind === 'demo' ? target.callsign : target.session.callsign.toUpperCase()
  const session = target.kind === 'demo' ? null : target.session
  const turns: Turn[] =
    target.kind === 'demo'
      ? [{ role: 'other', text: 'A demo tile, here so the layout can be judged with fewer than three sessions in the fleet. It has no conversation behind it, and nothing said while it is selected is sent anywhere.\n\nPick a real tile, press the iris, or say "dispatcher" to go back.', clipped: false }]
      : (data.turns ?? session?.messages.map(m => ({ role: 'session' as const, text: m.text, clipped: false })) ?? [])
  const parsed = useMemo(() => turns.map(t => ({ t, b: blocks(t.text) })), [turns])
  const note = target.kind === 'dispatcher' && !target.session ? 'No dispatcher session in the fleet.' : data.problem ? data.problem : !data.loaded ? 'Reading the full replies…' : null

  // A new target fades in; new content on the same target sticks to the bottom.
  useEffect(() => {
    if (shownKey.current !== data.key) {
      shownKey.current = data.key
      opacity.value = 0
      stick.current = true
    }
  }, [data.key, opacity])
  // Nothing else re-arms the stick: once Sam scrolls up, only scrolling back
  // to the bottom (or a new target) makes the Stream follow new turns again.

  useFrame((_, dt) => {
    if (opacity.value < 1) opacity.value = Math.min(1, opacity.value + dt / 0.18)
    const el = scrollRef.current
    if (!el?.scrollPosition || !el?.maxScrollPosition) return
    const maxY = el.maxScrollPosition.value?.[1] ?? 0
    const pos = el.scrollPosition.value as [number, number] | undefined
    if (streamScroll.pending) {
      const y = Math.max(0, Math.min(maxY, (pos?.[1] ?? 0) + streamScroll.pending))
      streamScroll.pending = 0
      el.scrollPosition.value = [0, y]
      stick.current = y >= maxY - 4
      return
    }
    if (stick.current && maxY > 0 && (pos?.[1] ?? 0) !== maxY) el.scrollPosition.value = [0, maxY]
  })

  return (
    <Container sizeX={sizeX} sizeY={sizeY} pixelSize={pixelSize} fontFamilies={FONTS} flexDirection="column" backgroundColor={plateColour(plate)} borderRadius={6} overflow="hidden" opacity={opacity}>
      <Container flexDirection="row" alignItems="center" gap={16} paddingX={28} height={54} flexShrink={0} borderBottomWidth={2} borderColor={C.cyanDim}>
        <Text fontFamily="rajdhani" fontWeight="bold" fontSize={28} color={target.kind === 'demo' ? C.amber : C.cyan}>
          {fit(who, 'rajdhani-700')}
        </Text>
        {session && (
          <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={22} color={stateColour(session.state)}>
            {STATE_WORDS[session.state]}
          </Text>
        )}
        <Container flexGrow={1} />
        <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={20} color={C.muted}>
          {target.kind === 'demo' ? 'DEMO · NOT SENDABLE' : `${turns.length} TURN${turns.length === 1 ? '' : 'S'} · NEWEST AT THE BOTTOM`}
        </Text>
      </Container>
      {note && (
        <Text fontFamily="inter" fontSize={22} color={data.problem?.startsWith('FULL') ? C.red : C.amber} paddingX={28} paddingTop={10} flexShrink={0}>
          {fit(note)}
        </Text>
      )}
      <Container ref={scrollRef} flexGrow={1} flexDirection="column" overflow="scroll" paddingX={28} paddingY={16} gap={22} scrollbarColor={C.cyanDim} scrollbarWidth={6} onScroll={(_x: number, y: number) => void (stick.current = y >= (scrollRef.current?.maxScrollPosition?.value?.[1] ?? 0) - 4)}>
        {parsed.length === 0 ? (
          <Text fontFamily="inter" fontSize={26} color={C.muted} flexShrink={0}>
            Nothing said yet.
          </Text>
        ) : (
          parsed.map(({ t, b }, i) => <TurnView key={`${data.key}-${i}-${t.role}`} turn={t} blocks={b} who={t.role === 'you' ? 'YOU' : t.role === 'session' ? fit(who, 'rajdhani-600') : 'NOTE'} />)
        )}
      </Container>
    </Container>
  )
})

function TurnView({ turn, blocks: bs, who }: { turn: Turn; blocks: Block[]; who: string }) {
  const you = turn.role === 'you'
  const size = you ? 26 : 30
  const colour = you ? C.muted : turn.role === 'other' ? C.muted : C.body
  return (
    <Container flexDirection="column" flexShrink={0} gap={6} paddingLeft={16} borderLeftWidth={4} borderColor={you ? C.purple : C.cyanDim}>
      <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={18} color={you ? C.purple : C.muted} flexShrink={0}>
        {who}
      </Text>
      {bs.map((b, i) => (
        <BlockView key={i} b={b} size={size} colour={colour} />
      ))}
      {turn.clipped && (
        <Text fontFamily="inter" fontSize={20} color={C.amber} flexShrink={0}>
          Cut here. The rest is on the Mac.
        </Text>
      )}
    </Container>
  )
}

function BlockView({ b, size, colour }: { b: Block; size: number; colour: string }) {
  switch (b.kind) {
    case 'gap':
      return <Container height={4} flexShrink={0} />
    case 'h':
      return (
        <Text fontFamily="inter" fontWeight="semi-bold" fontSize={size * 1.1} lineHeight={1.3} color={C.white} marginTop={6} flexShrink={0}>
          {b.text}
        </Text>
      )
    case 'li':
      return (
        <Container flexDirection="row" gap={14} paddingLeft={b.depth ? 30 : 4} flexShrink={0} alignItems="flex-start">
          {/* The bullet is a drawn dot, not a glyph. */}
          <Container width={9} height={9} borderRadius={4.5} backgroundColor={C.cyan} marginTop={size * 0.55} flexShrink={0} />
          <Text fontFamily="inter" fontSize={size} lineHeight={1.4} color={colour} flexShrink={1} flexGrow={1}>
            {b.text}
          </Text>
        </Container>
      )
    case 'num':
      return (
        <Container flexDirection="row" gap={10} flexShrink={0} alignItems="flex-start">
          <Text fontFamily="rajdhani" fontWeight="bold" fontSize={size} lineHeight={1.4} color={C.cyan} width={size * 1.3} flexShrink={0}>
            {b.n}
          </Text>
          <Text fontFamily="inter" fontSize={size} lineHeight={1.4} color={colour} flexShrink={1} flexGrow={1}>
            {b.text}
          </Text>
        </Container>
      )
    case 'code':
      return (
        <Container backgroundColor={rgba(0, 0, 0, 0.45)} borderRadius={6} padding={12} flexShrink={0} borderLeftWidth={3} borderColor={C.cyanFaint}>
          <Text fontFamily="inter" fontSize={size * 0.8} lineHeight={1.35} color="#cfe6ee" wordBreak="break-all">
            {b.text}
          </Text>
        </Container>
      )
    case 'p':
      return (
        <Text fontFamily="inter" fontSize={size} lineHeight={1.4} color={colour} flexShrink={0}>
          {b.text}
        </Text>
      )
  }
}

/** The plain uikit mesh panel: flat, the same angular size and centre as the layer. */
export function StreamMesh({ y, ...p }: Omit<ContentProps, 'sizeX' | 'sizeY' | 'pixelSize'> & { y: number }) {
  const px = MESH_WIDTH_M / STREAM_W
  return (
    <group position={[0, y, -RADIUS]}>
      <StreamContent {...p} sizeX={MESH_WIDTH_M} sizeY={STREAM_H * px} pixelSize={px} />
    </group>
  )
}

/** Inside the layer: an orthographic camera in layer pixels, so the panel fills the target exactly. */
function LayerCamera() {
  const set = useThree(s => s.set)
  useLayoutEffect(() => {
    const cam = new OrthographicCamera(-LAYER_W / 2, LAYER_W / 2, LAYER_H / 2, -LAYER_H / 2, 0.1, 100)
    cam.position.z = 10
    set({ camera: cam })
  }, [set])
  return null
}

/**
 * The Stream on a cylinder compositor layer centred on the eye. With no
 * layers feature (the desktop emulator) @react-three/xr falls back to a
 * textured cylinder mesh; that is logged, and says nothing about the layer.
 */
export function StreamLayer({ y, ...p }: Omit<ContentProps, 'sizeX' | 'sizeY' | 'pixelSize'> & { y: number }) {
  const layers = useXRSessionFeatureEnabled('layers')
  useEffect(() => log('stream-layer', { layersFeature: layers, drawnAs: layers ? 'compositor cylinder layer' : 'fallback: render target on a cylinder mesh' }), [layers])
  // three only encodes sRGB (as its own projection layer does) for targets
  // flagged as XR targets. The layer's colour texture is shown as sRGB, so
  // flag it; the fallback samples the target as linear, so leave that alone.
  const render = useMemo(
    () => (rt: WebGLRenderTarget, state: RootState) => {
      if (layers) {
        ;(rt as WebGLRenderTarget & { isXRRenderTarget?: boolean }).isXRRenderTarget = true
        rt.texture.colorSpace = SRGBColorSpace
      }
      state.gl.render(state.scene, state.camera)
    },
    [layers],
  )
  return (
    <XRLayer
      shape="cylinder"
      centralAngle={STREAM_ANGLE}
      pixelWidth={LAYER_W}
      pixelHeight={LAYER_H}
      position={[0, y, 0]}
      scale={[RADIUS, STREAM_HEIGHT_M, RADIUS]}
      blendTextureSourceAlpha
      quality="text-optimized"
      customRender={render}
    >
      <LayerCamera />
      <StreamContent {...p} sizeX={LAYER_W} sizeY={LAYER_H} pixelSize={LAYER_W / STREAM_W} />
    </XRLayer>
  )
}
