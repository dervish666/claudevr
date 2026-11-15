// What a theme draws beyond colour and frames: the face that stands in for
// the iris (lens, scanner, bars, a hologram image), the light that runs
// along the top arc, the badge inside the top of the circle, and the frame
// round the Stream. Each face is one quad with one small fragment shader,
// so a theme costs the same draw as the iris blades it replaces; the
// shaders do a few multiplies and one texture read at most, cheap enough
// for a Quest 3 in passthrough. Nothing here allocates per frame.

import { useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { Container } from '@react-three/uikit'
import { AddEquation, Color, CustomBlending, NormalBlending, OneFactor, ShaderMaterial, Vector2, ZeroFactor, type Mesh, type Texture } from 'three'
import type { BaseRenderer } from '../../../../shared/theme.ts'
import type { Voice } from '../../hud/voice/useVoice.ts'
import { arcGeometry, arcsGeometry, addFrame, glowMaterial, useGeometry } from '../shapes.tsx'
import { useLines } from '../linework.tsx'
import { CORE_Y } from '../layout.ts'
import { settings } from '../settings.ts'
import { speechLevel } from '../sound.ts'
import { fit } from '../text.ts'
import { C, DEG, FONTS, T, X, corner, plateOf } from '../theme.ts'
import { Image, Text } from '../ui.tsx'

const MM = 0.001

/** A quad in metres: its size and its centre's height above the iris spot. */
interface Box {
  w: number
  h: number
  y: number
}

/**
 * Each face is a hero element, meant to read from across the room, so it
 * takes the whole gap between the character row (its top 0.12 m below the
 * iris spot) and the heard line (its foot about 0.23 m above it).
 */
const BOXES: Record<Exclude<BaseRenderer, 'rings'>, Box> = {
  lens: { w: 0.22, h: 0.22, y: 0.035 },
  scanner: { w: 0.46, h: 0.13, y: 0.005 },
  bars: { w: 0.46, h: 0.26, y: 0.04 },
}
/** The hologram fits inside this box and keeps its own shape. */
const IMAGE_BOX: Box = { w: 0.34, h: 0.24, y: 0.04 }
/** How far from the centre line the bars' outer columns start, and the centre column's half width. */
const BARS_OUTER = 0.12
const BARS_MID = 0.055
/** How far below the bars face's top edge the stacked label's centre sits. */
const BARS_LABEL_DROP = 0.045

export interface FaceBox {
  base: Box | null
  image: Box | null
  /** The hold-to-talk target round both. */
  hit: Box
  /** The label's centre height; `inside` stacks it between the bars' outer columns, over the centre one. */
  label: { y: number; inside: boolean }
  /** Bars only: the centre column's top, as a share of the face's height, so it stops under the label. */
  cut: number
}

/** Where a face, its hologram, its label and its hit target sit, from the theme's renderer and picture. */
export function faceBox(base: Exclude<BaseRenderer, 'rings'> | null, image: Texture | null): FaceBox {
  const b = base ? BOXES[base] : null
  let im: Box | null = null
  if (image) {
    const img = image.image as { width?: number; height?: number } | undefined
    const aspect = img?.width && img.height ? img.width / img.height : 1
    const w = Math.min(IMAGE_BOX.w, IMAGE_BOX.h * aspect)
    im = { w, h: w / aspect, y: IMAGE_BOX.y }
  }
  const parts = [b, im].filter((p): p is Box => p !== null)
  if (!parts.length) parts.push(IMAGE_BOX)
  const top = Math.max(...parts.map(p => p.y + p.h / 2))
  const bottom = Math.min(...parts.map(p => p.y - p.h / 2))
  const w = Math.max(...parts.map(p => p.w))
  const inside = base === 'bars' && !im
  const labelY = inside ? top - BARS_LABEL_DROP : top + 0.024
  // The centre column stops a centimetre under the stacked label's foot (the label is about 64 mm tall).
  const cut = inside && b ? (labelY - 0.032 - 0.01 - (b.y - b.h / 2)) / b.h : 1
  return { base: b, image: im, hit: { w: w + 0.02, h: top - bottom + 0.02, y: (top + bottom) / 2 }, label: { y: labelY, inside }, cut }
}

/**
 * What the theme draws at the talk button: null for today's iris alone,
 * else a base renderer (`rings` keeps today's iris under a hologram) and
 * the hologram's picture. An image whose picture did not load falls back to
 * what it was drawn over, and to today's iris when it was over nothing.
 */
export function coreFace(): { base: BaseRenderer | null; image: Texture | null } | null {
  const core = T.theme.core
  if (core.renderer === 'rings') return null
  if (core.renderer !== 'image') return { base: core.renderer, image: null }
  const image = T.textures.core
  if (!image) return core.under && core.under !== 'rings' ? { base: core.under, image: null } : null
  return { base: core.under, image }
}

/** Whether today's decorative rings round the Stream still draw. */
export function ringsShown(): boolean {
  const f = coreFace()
  return !f || f.base === 'rings' || T.theme.core.keepRings
}

// ---------------------------------------------------------------- face shaders

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

/** One program per renderer (MODE), each a handful of steps and smoothsteps over the quad. */
const FRAG = /* glsl */ `
uniform float uTime;
uniform float uLevel;
uniform float uState;
uniform vec3 uColor;
uniform vec3 uPlate;
uniform float uAspect;
uniform vec2 uSize;
uniform float uCut;
uniform sampler2D uTex;
varying vec2 vUv;
void main() {
#if MODE == 0
  // The lens is a dark glass disc, a rim, a light at the centre that swells with the voice, ripples running out.
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0) * 2.0;
  float d = length(p);
  float inside = 1.0 - smoothstep(0.94, 1.0, d);
  float rim = smoothstep(0.84, 0.9, d) * inside;
  float r = 0.22 + 0.4 * uLevel;
  float core = exp(-(d * d) / (r * r));
  float ripple = (0.5 + 0.5 * sin(d * 18.0 - uTime * (2.0 + uState * 3.0))) * 0.2 * (1.0 - d);
  float shine = exp(-length(p - vec2(-0.38, 0.42)) * 9.0) * 0.3;
  vec3 col = uPlate + uColor * (core * (0.35 + 0.9 * uLevel) + rim * 0.85 + ripple * (0.4 + uLevel)) + vec3(shine);
  gl_FragColor = vec4(col, inside * 0.94);
#elif MODE == 1
  // The scanner is eleven cells between two rails, one light running end to end with a fading trail; faster while listening.
  float n = 11.0;
  float cx = (floor(vUv.x * n) + 0.5) / n;
  float y = abs(vUv.y - 0.5);
  float cell = step(abs(fract(vUv.x * n) - 0.5), 0.38) * step(y, 0.3);
  float rail = step(0.4, y) * step(y, 0.47);
  float speed = uState > 0.5 && uState < 1.5 ? 1.4 : (uState > 1.5 ? 0.9 : 0.4);
  float ph = fract(uTime * speed);
  float at = ph < 0.5 ? ph * 2.0 : 2.0 - ph * 2.0;
  float behind = (at - cx) * (ph < 0.5 ? 1.0 : -1.0);
  float lit = (behind >= 0.0 ? exp(-behind * n * 0.55) : exp(behind * n * 4.0)) * (0.7 + 0.6 * uLevel);
  vec3 col = uPlate + uColor * (cell * (0.14 + lit) + rail * 0.55) + vec3(0.5) * cell * smoothstep(0.7, 1.0, lit);
  gl_FragColor = vec4(col, step(y, 0.47) * 0.9);
#elif MODE == 2
  // The bars are three columns of segments rising from the foot with the voice. The outer pair stand either side
  // of the label and the centre one under it; uCut is the centre one's top, as a share of the height.
  vec2 m = vUv * uSize;
  float off = m.x - 0.5 * uSize.x;
  float ax = abs(off);
  float outer = step(${BARS_OUTER.toFixed(3)}, ax);
  float top = mix(uSize.y * uCut, uSize.y, outer) - 0.005;
  float inCol = mix(step(ax, ${BARS_MID.toFixed(3)}), step(ax, 0.5 * uSize.x - 0.005), outer) * step(0.005, m.y) * step(m.y, top);
  float pitch = 0.0165;
  float f = (m.y - 0.005) / pitch;
  float rows = floor((top - 0.005) / pitch);
  float row = floor(f);
  float seg = inCol * step(abs(fract(f) - 0.5), 0.34) * step(row + 1.0, rows);
  float which = outer * sign(off);
  float jitter = 0.84 + 0.16 * sin(uTime * (5.0 + which * 1.7) + which * 2.1);
  float h = clamp((0.08 + 0.92 * uLevel) * mix(1.0, 0.82, outer) * jitter, 0.0, 1.0) * rows;
  float lit = step(row + 0.5, h);
  float peak = lit * step(h - 1.5, row);
  vec3 col = uPlate + uColor * seg * mix(0.16, 0.75 + 0.45 * row / max(rows, 1.0), lit) + vec3(0.45) * seg * peak;
  gl_FragColor = vec4(col, inCol * mix(0.8, 1.0, lit * seg));
#else
  // The image is a hologram, added to what is behind it. Scan lines, a slight flicker, faded top and bottom.
  vec4 t = texture2D(uTex, vUv);
  float scan = 0.72 + 0.28 * sin(vUv.y * 260.0 - uTime * 7.0);
  float flick = 0.92 + 0.08 * sin(uTime * 41.0) * sin(uTime * 17.0);
  float edge = smoothstep(0.0, 0.08, vUv.y) * smoothstep(1.0, 0.92, vUv.y);
  vec3 tint = mix(t.rgb, uColor * dot(t.rgb, vec3(0.333)) * 1.6, 0.35);
  gl_FragColor = vec4(tint * t.a * scan * flick * edge * (0.85 + 0.3 * uLevel), 0.0);
#endif
  #include <colorspace_fragment>
}`

const MODES: Record<Exclude<BaseRenderer, 'rings'> | 'image', number> = { lens: 0, scanner: 1, bars: 2, image: 3 }

function faceMaterial(mode: keyof typeof MODES, colour: string, tex: Texture | null, box: Box, cut: number): ShaderMaterial {
  const additive = mode === 'image'
  return new ShaderMaterial({
    defines: { MODE: MODES[mode] },
    uniforms: {
      uTime: { value: 0 },
      uLevel: { value: 0 },
      uState: { value: 0 },
      uColor: { value: new Color(colour) },
      uPlate: { value: new Color(X.pupil) },
      uAspect: { value: box.w / box.h },
      uSize: { value: new Vector2(box.w, box.h) },
      uCut: { value: cut },
      uTex: { value: tex },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    ...(additive ? { blending: CustomBlending, blendEquation: AddEquation, blendSrc: OneFactor, blendDst: OneFactor, blendSrcAlpha: ZeroFactor, blendDstAlpha: OneFactor } : { blending: NormalBlending }),
  })
}

/**
 * The face: the base renderer and, over it, the hologram, each one quad.
 * Idle it breathes; listening it follows the mic level; speaking it follows
 * the reply's loudness where the reply is routed through the scene, and a
 * pulse where it is not.
 */
export function CoreFace({ box, base, image, colour, recording, level, voice }: { box: FaceBox; base: Exclude<BaseRenderer, 'rings'> | null; image: Texture | null; colour: string; recording: boolean; level: MutableRefObject<number>; voice: MutableRefObject<Voice> }) {
  const baseMat = useMemo(() => (base && box.base ? faceMaterial(base, colour, null, box.base, box.cut) : null), [base, box, colour])
  const imageMat = useMemo(() => (image && box.image ? faceMaterial('image', colour, image, box.image, 1) : null), [image, box, colour])
  useEffect(() => () => baseMat?.dispose(), [baseMat])
  useEffect(() => () => imageMat?.dispose(), [imageMat])
  const holo = useRef<Mesh>(null)
  const lv = useRef(0)
  const rec = useRef(recording)
  rec.current = recording
  const holoY = box.image?.y ?? 0
  useFrame((_, dt) => {
    const t = performance.now() / 1000
    const speaking = !rec.current && voice.current.speaker.busy()
    const target = rec.current ? level.current : speaking ? (speechLevel() ?? 0.5 + 0.4 * Math.abs(Math.sin(t * 9))) : 0.15 + 0.08 * Math.sin(t * 2)
    lv.current += (target - lv.current) * Math.min(1, dt * 12)
    const state = rec.current ? 1 : speaking ? 2 : 0
    for (const m of [baseMat, imageMat]) {
      if (!m) continue
      m.uniforms.uTime!.value = t
      m.uniforms.uLevel!.value = lv.current
      m.uniforms.uState!.value = state
    }
    if (holo.current) holo.current.position.y = holoY + Math.sin(t * 1.4) * 0.004
  })
  return (
    <group position-z={0.001}>
      {baseMat && box.base && (
        <mesh material={baseMat} position-y={box.base.y} name="core-face">
          <planeGeometry args={[box.base.w, box.base.h]} />
        </mesh>
      )}
      {imageMat && box.image && (
        <mesh ref={holo} material={imageMat} position={[0, holoY, 0.002]} name="core-hologram">
          <planeGeometry args={[box.image.w, box.image.h]} />
        </mesh>
      )}
    </group>
  )
}

/**
 * The face's label: who is addressed and their state. A pill above the
 * face, or for bars stacked between the outer columns, as today's iris
 * stacks it.
 */
export function FaceLabel({ name, sub, colour, recording, at }: { name: string; sub: string; colour: string; recording: boolean; at: FaceBox['label'] }) {
  const word = recording ? 'LISTENING' : 'TALK TO'
  if (at.inside)
    return (
      <group position={[0, at.y, 0.003]}>
        <Container pixelSize={MM} fontFamilies={FONTS} flexDirection="column" alignItems="center" width={Math.round((BARS_OUTER * 2 - 0.02) / MM)} paddingY={3} borderRadius={corner(6)} backgroundColor={plateOf('readout', 0.9)} pointerEvents="none">
          <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={16} color={C.muted}>
            {word}
          </Text>
          <Text fontFamily="rajdhani" fontWeight="bold" fontSize={name.length > 10 ? 18 : 22} color={colour} textAlign="center">
            {fit(name, 'rajdhani-700')}
          </Text>
          <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={15} color={C.muted} textAlign="center">
            {fit(sub, 'rajdhani-600')}
          </Text>
        </Container>
      </group>
    )
  return (
    <group position={[0, at.y, 0.003]}>
      <Container pixelSize={MM} fontFamilies={FONTS} flexDirection="row" alignItems="center" gap={8} paddingX={10} paddingY={3} borderRadius={corner(6)} backgroundColor={plateOf('readout', 0.9)} pointerEvents="none">
        <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={16} color={C.muted}>
          {word}
        </Text>
        <Text fontFamily="rajdhani" fontWeight="bold" fontSize={22} color={colour}>
          {fit(name, 'rajdhani-700')}
        </Text>
        <Text fontFamily="rajdhani" fontWeight="semi-bold" fontSize={15} color={C.muted}>
          {fit(sub, 'rajdhani-600')}
        </Text>
      </Container>
    </group>
  )
}

// ---------------------------------------------------------------- the top arc's sweep

/** The scanner's cells: how many, where along the top arc (degrees), how far outside it, how wide. */
const SWEEP_CELLS = 11
const SWEEP_FROM = 40
const SWEEP_TO = 140
const SWEEP_OUT = 0.023
const SWEEP_WIDTH = 0.012
/** One full back-and-forth, in seconds. */
const SWEEP_PERIOD = 1.6

const SWEEP_VERT = /* glsl */ `
attribute float aBand;
varying vec2 vP;
varying float vBand;
void main() {
  vP = position.xy;
  vBand = aBand;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

/** Each fragment finds its cell from its angle, so the whole row is one mesh and the head is two uniforms. */
const SWEEP_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uHead;
uniform float uDir;
varying vec2 vP;
varying float vBand;
void main() {
  // 0 at the row's left end, 1 at its right.
  float u = (SWEEP_TO - atan(vP.y, vP.x)) / (SWEEP_TO - SWEEP_FROM);
#ifdef GLOW
  float c = u;
#else
  float c = (floor(u * SWEEP_N) + 0.5) / SWEEP_N;
#endif
  float behind = (uHead - c) * uDir;
  // A sharp leading edge, a trail fading over about two cells.
  float lit = behind >= 0.0 ? exp(-behind * SWEEP_N * 0.5) : exp(behind * SWEEP_N * 6.0);
#ifdef GLOW
  float a = pow(max(0.0, 1.0 - abs(vBand)), 2.0) * lit * lit * 0.7;
  gl_FragColor = vec4(uColor * a, 0.0);
#else
  vec3 col = mix(uColor * (0.3 + 0.9 * lit), vec3(1.0), smoothstep(0.75, 1.0, lit) * 0.55);
  gl_FragColor = vec4(col, 0.3 + 0.7 * lit);
  #include <colorspace_fragment>
#endif
}`

function sweepMaterial(glow: boolean, uniforms: Record<string, { value: unknown }>): ShaderMaterial {
  return new ShaderMaterial({
    defines: { SWEEP_N: SWEEP_CELLS.toFixed(1), SWEEP_FROM: (SWEEP_FROM * DEG).toFixed(5), SWEEP_TO: (SWEEP_TO * DEG).toFixed(5), ...(glow ? { GLOW: '' } : {}) },
    uniforms,
    vertexShader: SWEEP_VERT,
    fragmentShader: SWEEP_FRAG,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    ...(glow ? { blending: CustomBlending, blendEquation: AddEquation, blendSrc: OneFactor, blendDst: OneFactor, blendSrcAlpha: ZeroFactor, blendDstAlpha: OneFactor } : { blending: NormalBlending }),
  })
}

/**
 * The `scanner` sweep is a row of cells just outside the top arc, a bright
 * head running back and forth once every 1.6 s with a fading trail, in the
 * palette's accent, plus a soft glow round the head while glow is on. Two
 * meshes.
 */
function ScannerSweep({ r, z }: { r: number; z: number }) {
  const R = r + SWEEP_OUT
  const cells = useGeometry(() => {
    const span = (SWEEP_TO - SWEEP_FROM) / SWEEP_CELLS
    return arcsGeometry(Array.from({ length: SWEEP_CELLS }, (_, i) => ({ r: R, width: SWEEP_WIDTH, from: (SWEEP_FROM + (i + 0.14) * span) * DEG, to: (SWEEP_FROM + (i + 0.86) * span) * DEG })))
  }, [R])
  const band = useGeometry(() => arcGeometry(R, SWEEP_WIDTH * 6, SWEEP_FROM * DEG, SWEEP_TO * DEG, 64), [R])
  // Both materials share the head's uniforms, so one write a frame moves both. The colour is read at mount; a theme change remounts this.
  const [line, glow, head, dir] = useMemo(() => {
    const u = { uColor: { value: new Color(C.cyan) }, uHead: { value: 0 }, uDir: { value: 1 } }
    return [sweepMaterial(false, u), sweepMaterial(true, u), u.uHead, u.uDir] as const
  }, [])
  useEffect(
    () => () => {
      line.dispose()
      glow.dispose()
    },
    [line, glow],
  )
  const glowMesh = useRef<Mesh>(null)
  const clock = useRef(0)
  useFrame((_, dt) => {
    // It holds still while rotation is off.
    if (settings.current.rotation) clock.current += dt
    const w = (clock.current / SWEEP_PERIOD) * Math.PI * 2
    head.value = 0.5 - 0.5 * Math.cos(w)
    dir.value = Math.sin(w) >= 0 ? 1 : -1
    if (glowMesh.current) glowMesh.current.visible = settings.current.glow
  })
  return (
    <group position={[0, CORE_Y, z]}>
      <mesh ref={glowMesh} geometry={band} material={glow} position-z={-0.002} renderOrder={-25} name="top-sweep-glow" />
      <mesh geometry={cells} material={line} name="top-sweep" />
    </group>
  )
}

/** The `pulse` sweep breathes the whole top arc. One additive mesh; it holds still while rotation is off. */
function PulseSweep({ r, z }: { r: number; z: number }) {
  const geo = useGeometry(() => arcGeometry(r, 0.05, 36 * DEG, 144 * DEG), [r])
  const mat = useMemo(() => glowMaterial(C.cyan, 0.3), [])
  useEffect(() => () => mat.dispose(), [mat])
  const clock = useRef(0)
  useFrame((_, dt) => {
    if (settings.current.rotation) clock.current += dt
    mat.uniforms.uStrength!.value = 0.12 + 0.22 * (0.5 + 0.5 * Math.sin(clock.current * 2.2))
  })
  return <mesh geometry={geo} material={mat} position={[0, CORE_Y, z]} renderOrder={-25} name="top-sweep" />
}

/** The light along the top arc, mounted only when the theme asks for it. */
export function TopSweep({ r, z }: { r: number; z: number }) {
  const mode = T.theme.motion.sweep
  if (mode === 'scanner') return <ScannerSweep r={r} z={z} />
  if (mode === 'pulse') return <PulseSweep r={r} z={z} />
  return null
}

// ---------------------------------------------------------------- badge

/**
 * The pack's emblem and label just inside the top of the circle, above the
 * week readout and below the needs-you rail and the alarms, so nothing
 * there ever has to hide it. (Core.tsx's HeardLine, under the Stream, says
 * why a pack was not used.)
 */
export function Badge({ y, z }: { y: number; z: number }) {
  const emblem = T.textures.emblem
  const label = T.theme.text.label
  if (!emblem && !label) return null
  // A long label steps down a size so its pill stays inside the top arc (at 40 characters it is about 45 cm wide).
  const size = !label || label.length <= 16 ? 30 : label.length <= 28 ? 24 : 20
  return (
    <group position={[0, y, z]}>
      <Container pixelSize={MM} fontFamilies={FONTS} flexDirection="row" alignItems="center" gap={10} paddingX={12} paddingY={4} borderRadius={corner(6)} backgroundColor={plateOf('readout', 0.9)} pointerEvents="none">
        {emblem && <Image src={emblem} width={36} height={36} />}
        {label && (
          <Text fontFamily="rajdhani" fontWeight="bold" fontSize={size} color={C.cyan} wordBreak="keep-all">
            {fit(label, 'rajdhani-700')}
          </Text>
        )}
      </Container>
    </group>
  )
}

// ---------------------------------------------------------------- the Stream's frame

/** The theme's frame round the Stream, kept just clear of the dispatcher's strip on its top edge. */
export function StreamFrame({ w, h, z }: { w: number; h: number; z: number }) {
  const on = T.theme.frame.stream
  useLines(
    'stream-frame',
    b => {
      if (!on) return
      b.m.makeTranslation(0, CORE_Y, z)
      addFrame(b, w + 0.012, h + 0.012, 0.06, 0.003, C.cyanDim)
    },
    [on, w, h, z],
  )
  return null
}
