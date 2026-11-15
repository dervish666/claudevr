// Line work as real geometry. WebGL draws lines one pixel wide whatever
// `linewidth` says, so every ring, arc, tick and bracket here is a band of
// triangles with a width in metres (3 mm is about 3 display pixels at 1.3 m).
// Each one can sit on a darker backing so it survives a bright room, and
// carry a soft additive glow behind it (never behind text, never a
// post-process).

import { useEffect, useMemo, type DependencyList } from 'react'
import { BufferAttribute, BufferGeometry, Color, CustomBlending, OneFactor, ShaderMaterial, ZeroFactor, AddEquation } from 'three'
import type { ShapeBuilder } from './linework.tsx'
import { useSettings } from './settings.ts'
import { T } from './theme.ts'

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

/**
 * A closed band `t` wide inside the polygon `pts` (counter-clockwise, x y
 * pairs): its outer edge is the outline, mitred at each corner, so a frame
 * keeps the same outside size as the brackets it stands in for.
 */
export function outlineGeometry(pts: [number, number][], t: number): BufferGeometry {
  const n = pts.length
  const pos = new Float32Array(n * 2 * 3)
  const band = new Float32Array(n * 2)
  const idx: number[] = []
  for (let i = 0; i < n; i++) {
    const [px, py] = pts[(i + n - 1) % n]!
    const [x, y] = pts[i]!
    const [nx, ny] = pts[(i + 1) % n]!
    // Inward normals of the edges in and out of this corner (left of the direction of travel).
    let ax = x - px
    let ay = y - py
    let bx = nx - x
    let by = ny - y
    const la = Math.hypot(ax, ay) || 1
    const lb = Math.hypot(bx, by) || 1
    ax /= la
    ay /= la
    bx /= lb
    by /= lb
    const n1x = -ay
    const n1y = ax
    let mx = n1x - by
    let my = n1y + bx
    const lm = Math.hypot(mx, my) || 1
    mx /= lm
    my /= lm
    const k = t / Math.max(0.2, mx * n1x + my * n1y)
    pos.set([x, y, 0, x + mx * k, y + my * k, 0], i * 6)
    band.set([0, 0], i * 2)
    const o = i * 2
    const q = ((i + 1) % n) * 2
    idx.push(o, q, o + 1, o + 1, q, q + 1)
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.setAttribute('aBand', new BufferAttribute(band, 1))
  g.setIndex(idx)
  return g
}

/** The outline of a w by h box with its corners cut (`chamfer`), rounded (`round`) or square, counter-clockwise. */
export function framePoints(w: number, h: number, corner: 'square' | 'chamfer' | 'round', c: number): [number, number][] {
  const x = w / 2
  const y = h / 2
  if (corner === 'square') return [[-x, -y], [x, -y], [x, y], [-x, y]]
  if (corner === 'chamfer')
    return [[-x + c, -y], [x - c, -y], [x, -y + c], [x, y - c], [x - c, y], [-x + c, y], [-x, y - c], [-x, -y + c]]
  const out: [number, number][] = []
  const corners: [number, number, number][] = [[x - c, -y + c, -90], [x - c, y - c, 0], [-x + c, y - c, 90], [-x + c, -y + c, 180]]
  for (const [cx, cy, a0] of corners)
    for (let s = 0; s <= 6; s++) {
      const a = ((a0 + (s * 90) / 6) * Math.PI) / 180
      out.push([cx + Math.cos(a) * c, cy + Math.sin(a) * c])
    }
  return out
}

/**
 * A panel's frame in the theme's style: today's corner brackets (`len`
 * long, `t` thick) or a full outline with square, cut or rounded corners,
 * the line scaled by the theme's weight, with an optional second, finer
 * line inside and tick marks standing out from the middle of the top and
 * bottom edges (outside the box, clear of its text and of the lanes beside
 * a tile). `alpha` is the
 * main line's; the second line and the ticks draw fainter. `extras` false
 * leaves them off a box too small to carry them.
 */
export function addFrame(b: ShapeBuilder, w: number, h: number, len: number, t: number, colour: string, alpha = 1, extras = true): void {
  const f = T.theme.frame
  const tw = t * f.weight
  const one = (fw: number, fh: number, fl: number, ft: number) =>
    f.corner === 'bracket' ? rectsGeometry(bracketRects(fw, fh, fl, ft)) : outlineGeometry(framePoints(fw, fh, f.corner, Math.min(fl * 0.45, fw / 4, fh / 4)), ft)
  b.add('line', one(w, h, len, tw), colour, alpha)
  if (f.double && extras) {
    const inset = tw * 1.8
    b.add('line', one(w - 2 * inset, h - 2 * inset, len * 0.75, Math.max(0.001, tw * 0.5)), colour, alpha * 0.55)
  }
  if (f.ticks && extras) {
    const tl = Math.min(len * 0.2, 0.007)
    const tt = Math.max(0.0012, tw * 0.6)
    const y = h / 2 + tl / 2 + 0.001
    const gap = Math.min(w * 0.06, 0.012)
    b.add('line', rectsGeometry([[-gap, y, tt, tl], [gap, y, tt, tl], [-gap, -y, tt, tl], [gap, -y, tt, tl]]), colour, alpha * 0.7)
  }
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
