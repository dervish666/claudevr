// The Stream: the Core's conversation, newest at the bottom, block-level
// formatting only. The same uikit tree draws on a cylinder compositor layer
// (XRLayer) or on a plain uikit mesh panel in the same place, so Sam can
// compare the two by pressing one button.
//
// Design units are millimetres at 1.3 m: the panel is 907 by 505 "px",
// 40 by 22 degrees. Body text is 30 px, about 1.3 degrees, about 55
// characters a line.

import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useFrame, useThree, type RootState } from '@react-three/fiber'
import { Container } from '@react-three/uikit'
import { Image, Text } from './ui.tsx'
import { XRLayer, useXRSessionFeatureEnabled } from '@react-three/xr'
import { signal } from '@preact/signals-core'
import { OrthographicCamera, SRGBColorSpace, type WebGLRenderTarget } from 'three'
import type { AgentInfo, CharacterInfo, Conversation, ConversationEntry, Session, Turn } from '../../../shared/protocol.ts'
import { AGENT_WORDS, runTime } from '../../../shared/agents.ts'
import { computed } from '@preact/signals-core'
import { second } from './clock.ts'
import { useStreamItems } from '../hud/conversation.ts'
import { useTranscriptPoll } from '../hud/transcript.ts'
import { blocks, fit, type Block } from './text.ts'
import { C, DEG, FONTS, STATE_WORDS, T, X, characterAccent, corner, plateOf, rgba, shade, stateColour } from './theme.ts'
import { ThemePart } from './themes/parts.tsx'
import { countRender, log } from './telemetry.ts'

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

/** Who the Core is talking to. */
export type Target = { kind: 'dispatcher'; session: Session | null } | { kind: 'session'; session: Session }

export interface StreamData {
  key: string
  turns: Turn[] | null
  problem: string | null
  loaded: boolean
  /** Epoch ms the turns last changed. */
  at: number | null
}

/**
 * The target's last turns from GET /api/transcript, re-read every few seconds and whenever it says something.
 * The polling is the 2D reader's too (hud/transcript.ts); this only words its problem for the panel.
 */
export function useTranscript(token: string, target: Target): StreamData {
  const session = target.session
  const changed = session ? `${session.lastLine ?? ''}|${session.state}` : ''
  const t = useTranscriptPoll(token, session?.id ?? null, changed)
  // Same object in, same object out: unchanged turns must not rebuild the uikit text.
  return useMemo(() => ({ key: t.key, turns: t.turns, problem: t.problem ? `${t.problem.kind === 'none' ? 'Short clips only' : 'FULL REPLIES UNAVAILABLE'}: ${t.problem.why}` : null, loaded: t.loaded, at: t.at }), [t])
}

/** Scroll requests from the thumbsticks, in design px; the Stream applies them on its next frame. */
export const streamScroll = { pending: 0 }

const plateColour = (opacity: number) => plateOf('stream', opacity)

interface ContentProps {
  target: Target
  data: StreamData
  plate: number
  sizeX: number
  sizeY: number
  pixelSize: number
  /** The selected character, or null in operator mode: with one, the dispatcher's stream is the character's. */
  character: CharacterInfo | null
  conversation: Conversation | null
  /** A picked sub-agent, shown read-only in place of the turns; null shows the target's turns. */
  agent?: AgentInfo | null
  /** Who the agent belongs to, as the header names it: the talk target stays that session. */
  agentOwner?: string | null
}

/** The uikit tree both views draw: the target's turns, or a picked sub-agent's detail. */
export const StreamContent = memo(function StreamContent(p: ContentProps) {
  // A different component, so the switch builds a new uikit root rather than swapping children inside a live one.
  if (p.agent) return <AgentDetail key={`agent:${p.agent.id}:${p.agent.recent.length}:${p.agent.brief ? 1 : 0}`} agent={p.agent} owner={p.agentOwner ?? 'ITS SESSION'} plate={p.plate} sizeX={p.sizeX} sizeY={p.sizeY} pixelSize={p.pixelSize} />
  return <Turns key="turns" {...p} />
})

// Getters: the theme's colours when the detail is built, not the ones loaded with the module.
const AGENT_TINT = {
  get running() { return C.cyan },
  get done() { return C.green },
  get failed() { return C.red },
  get unknown() { return C.muted },
}

/**
 * A sub-agent, read-only: what it is, its state and how long it has run,
 * the start of its brief and what it did lately. Nothing can be sent to it,
 * and the header says where talking goes instead.
 */
function AgentDetail({ agent: a, owner, plate, sizeX, sizeY, pixelSize }: { agent: AgentInfo; owner: string; plate: number; sizeX: number; sizeY: number; pixelSize: number }) {
  countRender('stream')
  useEffect(() => log('agent-detail', { agent: a.id, state: a.state, recent: a.recent.length }), [a.id, a.state, a.recent.length])
  // The running time ticks off the shared second; nothing else here moves without a fleet read.
  const ran = useMemo(() => computed(() => {
    const t = runTime(a, a.endedAt ?? second.value)
    return t ? `${a.endedAt ? 'RAN' : 'RUNNING FOR'} ${t.toUpperCase()}` : 'START TIME UNKNOWN'
  }), [a])
  return (
    <Container sizeX={sizeX} sizeY={sizeY} pixelSize={pixelSize} fontFamilies={FONTS} flexDirection="column" backgroundColor={plateColour(plate)} borderRadius={corner(6)} overflow="hidden">
      <PanelTexture />
      <Container flexDirection="row" alignItems="center" gap={16} paddingX={28} height={54} flexShrink={0} borderBottomWidth={2} borderColor={C.cyanDim}>
        <Text fontFamily="rajdhani" fontWeight="bold" fontSize={28} color={C.cyan} flexShrink={0}>
          {fit(`SUB-AGENT OF ${owner}`, 'rajdhani-700')}
        </Text>
        <Container flexGrow={1} />
        <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={20} color={C.amber} flexShrink={0}>
          {fit(`READ ONLY · TALK GOES TO ${owner}`, 'rajdhani-600')}
        </Text>
      </Container>
      <Container flexDirection="column" paddingX={28} paddingY={14} gap={10} flexGrow={1} overflow="hidden">
        <Container flexDirection="row" alignItems="baseline" gap={16} flexShrink={0}>
          <Text fontFamily="rajdhani" fontWeight="bold" fontSize={30} color={C.white} flexShrink={0}>
            {fit(a.type.toUpperCase(), 'rajdhani-700')}
          </Text>
          <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={22} color={AGENT_TINT[a.state]} flexShrink={0}>
            {AGENT_WORDS[a.state]}
          </Text>
          <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={20} color={C.muted} flexShrink={1}>
            {fit(a.model ? a.model.toUpperCase() : 'MODEL NOT REPORTED', 'rajdhani-600')}
          </Text>
          <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={20} color={C.muted} flexShrink={0}>
            {ran}
          </Text>
        </Container>
        <Text fontFamily="inter" fontWeight="semi-bold" fontSize={24} lineHeight={1.3} color={C.body} flexShrink={0}>
          {fit(a.description)}
        </Text>
        {a.brief && (
          <Container flexDirection="column" gap={4} paddingLeft={14} borderLeftWidth={4} borderColor={C.cyanDim} flexShrink={0}>
            <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={18} color={C.muted}>
              BRIEF, THE START OF IT
            </Text>
            <Text fontFamily="inter" fontSize={20} lineHeight={1.35} color={C.body}>
              {fit(a.brief)}
            </Text>
          </Container>
        )}
        <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={18} color={C.muted} flexShrink={0}>
          {a.recent.length ? 'LATELY, OLDEST FIRST' : 'NOTHING REPORTED YET'}
        </Text>
        {a.recent.map((r, i) => (
          <Text key={i} fontFamily="inter" fontSize={20} lineHeight={1.3} color={i === a.recent.length - 1 ? C.white : C.muted} flexShrink={0}>
            {fit(r.text)}
          </Text>
        ))}
      </Container>
    </Container>
  )
}

function Turns({ target, data, plate, sizeX, sizeY, pixelSize, character, conversation }: ContentProps) {
  countRender('stream')
  const scrollRef = useRef<any>(null)
  const stick = useRef(true)
  const opacity = useMemo(() => signal(0), [])
  const shownKey = useRef<string | null>(null)

  // With a character on, the dispatcher's stream is the character's: its name on top, the dispatcher doing the work.
  const asCharacter = target.kind === 'dispatcher' && character !== null
  const who = asCharacter ? character.name.toUpperCase() : target.kind === 'dispatcher' ? 'DISPATCHER' : target.session.callsign.toUpperCase()
  const sessionWho = target.kind === 'dispatcher' ? 'DISPATCHER' : who
  const accent = asCharacter ? characterAccent(character) : C.cyan
  const session = target.session
  const turns: Turn[] = data.turns ?? session?.messages.map(m => ({ role: 'session' as const, text: m.text, clipped: false })) ?? []
  const items = useStreamItems(turns, conversation, character, asCharacter)
  const parsed = useMemo(() => items.map(it => ({ it, b: blocks(it.kind === 'turn' ? it.turn.text : it.entry.text) })), [items])
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
    <Container sizeX={sizeX} sizeY={sizeY} pixelSize={pixelSize} fontFamilies={FONTS} flexDirection="column" backgroundColor={plateColour(plate)} borderRadius={corner(6)} overflow="hidden" opacity={opacity}>
      <PanelTexture />
      <Container flexDirection="row" alignItems="center" gap={16} paddingX={28} height={54} flexShrink={0} borderBottomWidth={2} borderColor={C.cyanDim}>
        <Text fontFamily="rajdhani" fontWeight="bold" fontSize={28} color={accent}>
          {fit(who, 'rajdhani-700')}
        </Text>
        {/* Always in the tree, hidden in operator mode: adding or removing a child inside a live uikit root leaves ghost text. */}
        <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={18} color={C.muted} flexShrink={0} display={asCharacter ? 'flex' : 'none'}>
          VIA DISPATCHER
        </Text>
        {session && (
          <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={22} color={stateColour(session.state)}>
            {STATE_WORDS[session.state]}
          </Text>
        )}
        <Container flexGrow={1} />
        <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={20} color={C.muted}>
          {`${turns.length} TURN${turns.length === 1 ? '' : 'S'} · NEWEST AT THE BOTTOM`}
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
          parsed.map(({ it, b }, i) =>
            it.kind === 'character' ? (
              <CharacterLineView key={`${data.key}-${i}-character`} entry={it.entry} blocks={b} who={fit(who, 'rajdhani-600')} accent={accent} />
            ) : (
              <TurnView key={`${data.key}-${i}-${it.turn.role}`} turn={it.turn} blocks={b} who={it.turn.role === 'you' ? 'YOU' : it.turn.role === 'session' ? fit(sessionWho, 'rajdhani-600') : 'NOTE'} />
            ),
          )
        )}
      </Container>
    </Container>
  )
}

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

/** A line the character spoke: its name in its accent, on a tinted plate, so it never reads as a dispatcher turn. */
function CharacterLineView({ entry, blocks: bs, who, accent }: { entry: ConversationEntry; blocks: Block[]; who: string; accent: string }) {
  return (
    <Container flexDirection="column" flexShrink={0} gap={6} paddingLeft={16} paddingY={8} borderLeftWidth={4} borderColor={accent} backgroundColor={shade(accent, 0.86)} borderRadius={corner(4)}>
      <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={18} color={accent} flexShrink={0}>
        {entry.source === 'fallback' ? `${who} · PLAIN` : who}
      </Text>
      {bs.map((b, i) => (
        <BlockView key={i} b={b} size={28} colour={C.white} />
      ))}
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
        <Container backgroundColor={rgba(0, 0, 0, 0.45)} borderRadius={corner(6)} padding={12} flexShrink={0} borderLeftWidth={3} borderColor={C.cyanFaint}>
          <Text fontFamily="inter" fontSize={size * 0.8} lineHeight={1.35} color={X.code} wordBreak="break-all">
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

/** The pack's panel texture, faint over the Stream's plate, under everything on it. One more draw, only with a pack that has one. */
function PanelTexture() {
  const tex = T.textures.panel
  if (!tex) return null
  return <Image src={tex} positionType="absolute" positionTop={0} positionLeft={0} width="100%" height="100%" keepAspectRatio={false} opacity={T.theme.assets.panelOpacity} pointerEvents="none" />
}

/** The plain uikit mesh panel: flat, the same angular size and centre as the layer. */
export function StreamMesh({ y, ...p }: Omit<ContentProps, 'sizeX' | 'sizeY' | 'pixelSize'> & { y: number }) {
  const px = MESH_WIDTH_M / STREAM_W
  return (
    <group position={[0, y, -RADIUS]}>
      <ThemePart part="stream">
        <StreamContent {...p} sizeX={MESH_WIDTH_M} sizeY={STREAM_H * px} pixelSize={px} />
      </ThemePart>
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
      <ThemePart part="stream">
        <StreamContent {...p} sizeX={LAYER_W} sizeY={LAYER_H} pixelSize={LAYER_W / STREAM_W} />
      </ThemePart>
    </XRLayer>
  )
}
