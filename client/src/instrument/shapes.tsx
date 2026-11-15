// Line work as real geometry. WebGL draws lines one pixel wide whatever
// `linewidth` says, so every ring, arc, tick and bracket here is a band of
// triangles with a width in metres (3 mm is about 3 display pixels at 1.3 m).
// Each one can sit on a darker backing so it survives a bright room, and
// carry a soft additive glow behind it (never behind text, never a
// post-process).

import { useEffect, useMemo, type DependencyList } from 'react'
import { BufferAttribute, BufferGeometry, Color, CustomBlending, OneFactor, ShaderMaterial, ZeroFactor, AddEquation } from 'three'
import { useSettings } from './settings.ts'

/** An annular sector in the XY plane, angles in radians from +X, counter-clockwise. `aBand` runs -1 (inner edge) to 1 (outer). */
export function arcGeometry(r: number, width: number, from: number, to: number, segments?: number): BufferGeometry {
  const n = segments ?? Math.max(4, Math.ceil((Math.abs(to - from) / (Math.PI * 2)) * 128))
  const pos = new Float32Array((n + 1) * 2 * 3)
  const band = new Float32Array((n + 1) * 2)
  const idx: number[] = []
  for (let i = 0; i <= n; i++) {
    const a = from + ((to - from) * i) / n
    const c = Math.cos(a)
    const s = Math.sin(a)
    const ri = r - width / 2
    const ro = r + width / 2
    pos.set([c * ri, s * ri, 0, c * ro, s * ro, 0], i * 6)
    band.set([-1, 1], i * 2)
    if (i < n) {
      const k = i * 2
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2)
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.setAttribute('aBand', new BufferAttribute(band, 1))
  g.setIndex(idx)
  return g
}

/** Several sectors in one geometry: dashes along an arc, ticks, a segmented gauge. */
export function arcsGeometry(parts: { r: number; width: number; from: number; to: number }[]): BufferGeometry {
  const geos = parts.map(p => arcGeometry(p.r, p.width, p.from, p.to))
  return merge(geos)
}

/** Axis-aligned rectangles [x, y, w, h] (x, y the centre) in one geometry: brackets, bars. */
export function rectsGeometry(rects: [number, number, number, number][]): BufferGeometry {
  const pos = new Float32Array(rects.length * 4 * 3)
  const band = new Float32Array(rects.length * 4)
  const idx: number[] = []
  rects.forEach(([x, y, w, h], i) => {
    pos.set([x - w / 2, y - h / 2, 0, x + w / 2, y - h / 2, 0, x + w / 2, y + h / 2, 0, x - w / 2, y + h / 2, 0], i * 12)
    band.set([0, 0, 0, 0], i * 4)
    const k = i * 4
    idx.push(k, k + 1, k + 2, k, k + 2, k + 3)
  })
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.setAttribute('aBand', new BufferAttribute(band, 1))
  g.setIndex(idx)
  return g
}

/** Corner brackets for a w by h box: four L shapes, arms `len` long and `t` thick. */
export function bracketRects(w: number, h: number, len: number, t: number): [number, number, number, number][] {
  const x = w / 2
  const y = h / 2
  const out: [number, number, number, number][] = []
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) {
      out.push([sx * (x - len / 2), sy * (y - t / 2), len, t])
      out.push([sx * (x - t / 2), sy * (y - len / 2), t, len])
    }
  return out
}

/** `n` radial ticks from `inner` to `inner + len`, `w` wide, spread evenly over a full turn (or from..to). */
export function ticksGeometry(inner: number, len: number, w: number, n: number, from = 0, to = Math.PI * 2): BufferGeometry {
  const full = Math.abs(to - from - Math.PI * 2) < 1e-6
  const pos = new Float32Array(n * 4 * 3)
  const band = new Float32Array(n * 4)
  const idx: number[] = []
  for (let i = 0; i < n; i++) {
    const a = from + ((to - from) * i) / (full ? n : Math.max(1, n - 1))
    const c = Math.cos(a)
    const s = Math.sin(a)
    // perpendicular half-width
    const px = -s * (w / 2)
    const py = c * (w / 2)
    const x0 = c * inner
    const y0 = s * inner
    const x1 = c * (inner + len)
    const y1 = s * (inner + len)
    pos.set([x0 - px, y0 - py, 0, x0 + px, y0 + py, 0, x1 + px, y1 + py, 0, x1 - px, y1 - py, 0], i * 12)
    const k = i * 4
    idx.push(k, k + 1, k + 2, k, k + 2, k + 3)
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.setAttribute('aBand', new BufferAttribute(band, 1))
  g.setIndex(idx)
  return g
}

function merge(geos: BufferGeometry[]): BufferGeometry {
  let verts = 0
  let count = 0
  for (const g of geos) {
    verts += g.getAttribute('position').count
    count += g.getIndex()!.count
  }
  const pos = new Float32Array(verts * 3)
  const band = new Float32Array(verts)
  const idx = new Uint32Array(count)
  let v = 0
  let i = 0
  for (const g of geos) {
    pos.set(g.getAttribute('position').array as Float32Array, v * 3)
    band.set(g.getAttribute('aBand').array as Float32Array, v)
    const gi = g.getIndex()!.array
    for (let k = 0; k < gi.length; k++) idx[i + k] = gi[k]! + v
    v += g.getAttribute('position').count
    i += gi.length
    g.dispose()
  }
  const out = new BufferGeometry()
  out.setAttribute('position', new BufferAttribute(pos, 3))
  out.setAttribute('aBand', new BufferAttribute(band, 1))
  out.setIndex(new BufferAttribute(idx, 1))
  return out
}

/** A geometry made from deps and disposed when they change or the component goes. */
export function useGeometry<T extends BufferGeometry | null>(make: () => T, deps: DependencyList): T {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const g = useMemo(make, deps)
  useEffect(() => () => g?.dispose(), [g])
  return g
}

// ---------------------------------------------------------------- glow

/**
 * Pure additive light: colour added to what is behind, alpha untouched, so
 * over passthrough it brightens the room and over a plate it brightens the
 * plate. The band fades from the centre line out.
 */
export function glowMaterial(colour: string, strength: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uColor: { value: new Color(colour) }, uStrength: { value: strength } },
    vertexShader: 'attribute float aBand; varying float vBand; void main() { vBand = aBand; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 uColor; uniform float uStrength; varying float vBand; void main() { float a = pow(max(0.0, 1.0 - abs(vBand)), 2.4) * uStrength; gl_FragColor = vec4(uColor * a, 0.0); }',
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
}

/**
 * A ring sector drawn three ways: a dark backing a little wider than the
 * line, the line itself, and (with glow on) a wide soft additive band behind.
 */
export function Arc({ r, width, from, to, colour, opacity = 1, backing = true, glow = true, z = 0 }: { r: number; width: number; from: number; to: number; colour: string; opacity?: number; backing?: boolean; glow?: boolean; z?: number }) {
  const s = useSettings()
  const line = useGeometry(() => arcGeometry(r, width, from, to), [r, width, from, to])
  const back = useGeometry(() => (backing ? arcGeometry(r, width * 3, from, to) : null), [backing, r, width, from, to])
  const halo = useGeometry(() => (glow ? arcGeometry(r, width * 9, from, to) : null), [glow, r, width, from, to])
  const haloMat = useMemo(() => (glow ? glowMaterial(colour, 0.35) : null), [glow, colour])
  useEffect(() => () => haloMat?.dispose(), [haloMat])
  return (
    <group position-z={z}>
      {halo && haloMat && s.glow && <mesh geometry={halo} material={haloMat} position-z={-0.004} renderOrder={-20} />}
      {back && (
        <mesh geometry={back} position-z={-0.002} renderOrder={-10}>
          <meshBasicMaterial color="#000" transparent opacity={0.55} depthWrite={false} toneMapped={false} />
        </mesh>
      )}
      <mesh geometry={line}>
        <meshBasicMaterial color={colour} transparent={opacity < 1} opacity={opacity} toneMapped={false} />
      </mesh>
    </group>
  )
}
