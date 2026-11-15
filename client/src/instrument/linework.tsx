// All the scene's line work in two draw calls. Every ring, arc, tick,
// bracket, gauge fill, tether and backing is baked into rig space and
// merged into one mesh (backings first, then lines, one draw), and every
// soft glow into a second, additive one. Each component contributes a
// Shape under its own key; the batch re-merges only when a shape changes
// (a selection, a percentage, a state), never per frame.
//
// What moves does so in the vertex shader from uniforms the frame loop
// sets: the decorative rings spin about the Core's centre (aSpin), a
// working tile's bright segment slides along its bottom edge (aSlide), and
// a tile's brackets can be tinted by slot (aGroup: the fake-need flash, a
// reply card's highlight). Nothing in the frame loop allocates.
//
// A theme change sweeps a light along the line work (uFx: a front moving
// across, or one flash everywhere) while the parts rebuild behind it, and
// the theme can recolour and scale the glow (uGlow, uGlowGain). At rest
// those uniforms are neutral and the shaders compute exactly what they did
// before themes.

import { createContext, useContext, useEffect, useLayoutEffect, useMemo, type ReactNode } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  AddEquation,
  BufferAttribute,
  BufferGeometry,
  Color,
  CustomBlending,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Matrix4,
  Mesh,
  NormalBlending,
  OneFactor,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  ZeroFactor,
} from 'three'
import { settings } from './settings.ts'
import { T } from './theme.ts'

/** Floats per vertex: position 3, colour 4 (linear rgb, alpha or glow strength), band 1, spin 1, group 1, slide 3. */
const STRIDE = 13
export const GROUPS = 16

type Layer = 'back' | 'line' | 'glow'

class Buf {
  v: number[] = []
  i: number[] = []
  get count(): number {
    return this.v.length / STRIDE
  }
}

/** A baked piece of line work: three layers of interleaved vertices and local indices. */
export interface Shape {
  back: { v: Float32Array; i: Uint32Array }
  line: { v: Float32Array; i: Uint32Array }
  glow: { v: Float32Array; i: Uint32Array }
}

const tmp = new Vector3()
const col = new Color()

/**
 * Builds a Shape. Geometry is added in local coordinates under the current
 * transform `m`, with the current spin, group and slide applied to every
 * vertex added after they are set.
 */
export class ShapeBuilder {
  private layers: Record<Layer, Buf> = { back: new Buf(), line: new Buf(), glow: new Buf() }
  m = new Matrix4()
  spin = 0
  group = -1
  slide = new Vector3()

  /** Adds a geometry with `position` (and optionally `aBand`) and an index. The geometry is disposed. */
  add(layer: Layer, g: BufferGeometry, colour: string, alpha = 1): this {
    const b = this.layers[layer]
    const pos = g.getAttribute('position')
    const band = g.getAttribute('aBand') as BufferAttribute | undefined
    const index = g.getIndex()
    col.set(colour)
    const base = b.count
    // The slide vector is in local units too: carry its direction through the transform's rotation and scale.
    const sx = this.slide.x
    const sy = this.slide.y
    const sz = this.slide.z
    const slide = new Vector3(sx, sy, sz).transformDirection(this.m).multiplyScalar(this.slide.length() * this.scaleOf())
    for (let k = 0; k < pos.count; k++) {
      tmp.set(pos.getX(k), pos.getY(k), pos.getZ(k)).applyMatrix4(this.m)
      b.v.push(tmp.x, tmp.y, tmp.z, col.r, col.g, col.b, alpha, band ? band.getX(k) : 0, this.spin, this.group, slide.x, slide.y, slide.z)
    }
    if (index) for (let k = 0; k < index.count; k++) b.i.push(base + index.getX(k))
    else for (let k = 0; k < pos.count; k++) b.i.push(base + k)
    g.dispose()
    return this
  }

  private scaleOf(): number {
    const e = this.m.elements
    return Math.hypot(e[0]!, e[1]!, e[2]!)
  }

  done(): Shape {
    const pack = (b: Buf) => ({ v: new Float32Array(b.v), i: new Uint32Array(b.i) })
    return { back: pack(this.layers.back), line: pack(this.layers.line), glow: pack(this.layers.glow) }
  }
}

// ---------------------------------------------------------------- the batch

const VERT = /* glsl */ `
attribute vec4 aColor;
attribute float aBand;
attribute float aSpin;
attribute float aGroup;
attribute vec3 aSlide;
uniform float uSpinT;
uniform float uSlideT;
uniform vec2 uPivot;
uniform vec4 uTint[${GROUPS}];
uniform vec4 uFx;
varying vec4 vColor;
varying float vBand;
varying float vFx;
void main() {
  vec3 p = position;
  if (aSpin != 0.0) {
    float a = aSpin * uSpinT;
    float c = cos(a);
    float s = sin(a);
    vec2 d = p.xy - uPivot;
    p.xy = uPivot + vec2(c * d.x - s * d.y, s * d.x + c * d.y);
  }
  p += aSlide * uSlideT;
  vec4 colour = aColor;
  if (aGroup >= 0.0) {
    vec4 t = uTint[int(aGroup + 0.5)];
    colour.rgb = mix(colour.rgb, t.rgb, t.a);
  }
  vColor = colour;
  vBand = aBand;
  // uFx: amount, the front's x, its half width, and the mode (0 a moving front, 1 everywhere at once).
  vFx = uFx.w > 0.5 ? uFx.x : uFx.x * (1.0 - smoothstep(0.0, uFx.z, abs(p.x - uFx.y)));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`

const LINE_FRAG = /* glsl */ `
uniform vec3 uFxColor;
varying vec4 vColor;
varying float vFx;
void main() {
  gl_FragColor = vColor;
  // The transition's light lands on lines only: a black backing stays black.
  if (vFx > 0.0 && max(vColor.r, max(vColor.g, vColor.b)) > 0.02) gl_FragColor.rgb += uFxColor * vFx;
  #include <colorspace_fragment>
}`

/** The same falloff the old per-arc glow had: brightest on the centre line, linear colour added straight to the frame. */
const GLOW_FRAG = /* glsl */ `
uniform vec4 uGlow;
uniform float uGlowGain;
uniform vec3 uFxColor;
varying vec4 vColor;
varying float vBand;
varying float vFx;
void main() {
  float a = pow(max(0.0, 1.0 - abs(vBand)), 2.4) * vColor.a * uGlowGain;
  gl_FragColor = vec4((mix(vColor.rgb, uGlow.rgb, uGlow.a) + uFxColor * vFx) * a, 0.0);
}`

function uniforms() {
  return {
    uSpinT: { value: 0 },
    uSlideT: { value: 0 },
    uPivot: { value: new Vector2(0, 0) },
    uTint: { value: Array.from({ length: GROUPS }, () => new Vector4(0, 0, 0, 0)) },
    uFx: { value: new Vector4(0, 0, 0.25, 0) },
    uFxColor: { value: new Color(0, 0, 0) },
    uGlow: { value: new Vector4(0, 0, 0, 0) },
    uGlowGain: { value: 1 },
  }
}

class Layered {
  mesh: Mesh
  private capV = 0
  private capI = 0
  private data: Float32Array = new Float32Array(0)
  private index: Uint32Array = new Uint32Array(0)
  constructor(material: ShaderMaterial, renderOrder: number) {
    this.mesh = new Mesh(new BufferGeometry(), material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = renderOrder
    this.mesh.matrixAutoUpdate = false
  }
  /** Copies the parts in, end to end, into buffers that only grow. */
  fill(parts: { v: Float32Array; i: Uint32Array }[]): void {
    let nv = 0
    let ni = 0
    for (const p of parts) {
      nv += p.v.length / STRIDE
      ni += p.i.length
    }
    if (nv > this.capV || ni > this.capI) this.grow(Math.max(nv, this.capV * 2, 4096), Math.max(ni, this.capI * 2, 8192))
    let v = 0
    let i = 0
    for (const p of parts) {
      this.data.set(p.v, v * STRIDE)
      for (let k = 0; k < p.i.length; k++) this.index[i + k] = p.i[k]! + v
      v += p.v.length / STRIDE
      i += p.i.length
    }
    const g = this.mesh.geometry
    ;(g.getAttribute('position') as InterleavedBufferAttribute).data.needsUpdate = true
    g.getIndex()!.needsUpdate = true
    g.setDrawRange(0, ni)
    this.mesh.visible = ni > 0
  }
  private grow(v: number, i: number): void {
    this.capV = v
    this.capI = i
    this.data = new Float32Array(v * STRIDE)
    this.index = new Uint32Array(i)
    const ib = new InterleavedBuffer(this.data, STRIDE)
    const g = new BufferGeometry()
    g.setAttribute('position', new InterleavedBufferAttribute(ib, 3, 0))
    g.setAttribute('aColor', new InterleavedBufferAttribute(ib, 4, 3))
    g.setAttribute('aBand', new InterleavedBufferAttribute(ib, 1, 7))
    g.setAttribute('aSpin', new InterleavedBufferAttribute(ib, 1, 8))
    g.setAttribute('aGroup', new InterleavedBufferAttribute(ib, 1, 9))
    g.setAttribute('aSlide', new InterleavedBufferAttribute(ib, 3, 10))
    g.setIndex(new BufferAttribute(this.index, 1))
    this.mesh.geometry.dispose()
    this.mesh.geometry = g
  }
  dispose(): void {
    this.mesh.geometry.dispose()
  }
}

export class LineBatch {
  private shapes = new Map<string, Shape>()
  private dirty = true
  readonly uniforms = uniforms()
  readonly lines: Layered
  readonly glow: Layered
  /** Seconds of spin so far; only advances while rotation is on. */
  private spinT = 0
  constructor() {
    const lineMat = new ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: LINE_FRAG, transparent: true, depthWrite: true, blending: NormalBlending, toneMapped: false })
    const glowMat = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: GLOW_FRAG,
      transparent: true,
      depthWrite: false,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      blendSrcAlpha: ZeroFactor,
      blendDstAlpha: OneFactor,
      toneMapped: false,
    })
    // Glow first, then backings and lines, then every uikit panel (render order 0).
    this.glow = new Layered(glowMat, -30)
    this.lines = new Layered(lineMat, -20)
    this.glow.mesh.name = 'line-work glow'
    this.lines.mesh.name = 'line-work'
    // A scene built again (a new session) starts on the theme already applied.
    this.look(T.theme.palette.glow, T.theme.palette.glowStrength)
  }
  set(key: string, shape: Shape | null): void {
    if (shape) this.shapes.set(key, shape)
    else this.shapes.delete(key)
    this.dirty = true
  }
  setPivot(x: number, y: number): void {
    this.uniforms.uPivot.value.set(x, y)
  }
  tint(group: number): Vector4 {
    return this.uniforms.uTint.value[group]!
  }
  /** The theme's glow: its own colour over every line's (or none), and its strength. */
  look(glow: string | null, strength: number): void {
    const g = this.uniforms.uGlow.value
    if (glow) {
      col.set(glow)
      g.set(col.r, col.g, col.b, 1)
    } else g.set(0, 0, 0, 0)
    this.uniforms.uGlowGain.value = strength
  }
  /** The transition's light: `amount` 0 to 1, at rig x `front` (or everywhere), in `colour` (linear, set by the caller). */
  fx(amount: number, front: number, everywhere: boolean): void {
    this.uniforms.uFx.value.set(amount, front, 0.28, everywhere ? 1 : 0)
  }
  get fxColour(): Color {
    return this.uniforms.uFxColor.value
  }
  /** Per frame: re-merge if something changed, advance the motion. */
  frame(dt: number, now: number): void {
    if (this.dirty) {
      this.dirty = false
      const all = [...this.shapes.values()]
      this.lines.fill([...all.map(s => s.back), ...all.map(s => s.line)])
      this.glow.fill(all.map(s => s.glow))
    }
    if (settings.current.rotation) this.spinT += dt * T.theme.motion.ringSpeed
    this.uniforms.uSpinT.value = this.spinT
    this.uniforms.uSlideT.value = (now / 2400) % 1
    this.glow.mesh.visible = settings.current.glow && this.glow.mesh.geometry.drawRange.count > 0
  }
  /** What the batch holds, for the frame log. */
  stats(): { shapes: number; lineVerts: number; glowVerts: number } {
    let lv = 0
    let gv = 0
    for (const s of this.shapes.values()) {
      lv += (s.back.v.length + s.line.v.length) / STRIDE
      gv += s.glow.v.length / STRIDE
    }
    return { shapes: this.shapes.size, lineVerts: lv, glowVerts: gv }
  }
  dispose(): void {
    this.lines.dispose()
    this.glow.dispose()
    ;(this.lines.mesh.material as ShaderMaterial).dispose()
    ;(this.glow.mesh.material as ShaderMaterial).dispose()
  }
}

const BatchContext = createContext<LineBatch | null>(null)

/** Owns the batch and its two meshes; put it inside the rig so the line work moves with it. */
export function LineWork({ batch, children }: { batch: LineBatch; children: ReactNode }) {
  useEffect(() => () => batch.dispose(), [batch])
  useFrame((_, dt) => batch.frame(dt, performance.now()))
  return (
    <BatchContext.Provider value={batch}>
      <primitive object={batch.glow.mesh} />
      <primitive object={batch.lines.mesh} />
      {children}
    </BatchContext.Provider>
  )
}

export function useBatch(): LineBatch {
  const b = useContext(BatchContext)
  if (!b) throw new Error('useBatch outside <LineWork>')
  return b
}

/**
 * Puts a component's line work into the batch under `key`, rebuilt only
 * when `deps` change, and takes it out when the component goes.
 */
export function useLines(key: string, build: (b: ShapeBuilder) => void, deps: unknown[]): void {
  const batch = useBatch()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const shape = useMemo(() => {
    const b = new ShapeBuilder()
    build(b)
    return b.done()
  }, deps)
  useLayoutEffect(() => {
    batch.set(key, shape)
  }, [batch, key, shape])
  useLayoutEffect(() => () => batch.set(key, null), [batch, key])
}
