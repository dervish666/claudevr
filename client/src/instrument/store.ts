// The XR session store and the renderer patches it needs.

import { createXRStore } from '@react-three/xr'
import type { WebGLRenderer } from 'three'

/** Re-entry only: three reads it when a session starts. 1.3 is what the research note settles on for text. */
export const FRAMEBUFFER_SCALE = 1.3

export const store = createXRStore({
  // Text at the edge of view stays sharp: no fixed foveation.
  foveation: 0,
  frameBufferScaling: FRAMEBUFFER_SCALE,
  // The budget is 72 Hz (13.9 ms). Ask for exactly that where offered.
  frameRate: rates => (Array.from(rates).includes(72) ? 72 : false),
  // Only what the spike uses. Plane, mesh, anchor and hit-test requests
  // bring Quest's spatial-data prompt; none of them is needed here.
  anchors: false,
  meshDetection: false,
  planeDetection: false,
  hitTest: false,
  domOverlay: false,
  layers: true,
  handTracking: true,
  // Passthrough shows the real controllers and hands, so no models: they
  // would be fetched from a CDN the page's policy refuses anyway. The
  // controller layouts (which button is which) are served from this origin.
  controller: { model: false, grabPointer: false, teleportPointer: false },
  hand: { model: false, grabPointer: false, teleportPointer: false },
  baseAssetPath: `${location.origin}/xr-profiles/`,
  // On localhost with no headset, Meta's emulator (IWER) stands in. No
  // synthetic room: it would be fetched from elsewhere.
  emulate: { type: 'metaQuest3', syntheticEnvironment: false },
  offerSession: false,
  enterGrantedSession: false,
})

/**
 * GL textures the page has created, counted at the context. pmndrs/xr #501
 * reports an XRLayer leaking a depth texture a frame; the headless replay in
 * leakprobe.ts does not reproduce it against three 0.187, so nothing is
 * patched. This counter, logged every few seconds in the session, settles it
 * on the headset: flat means no leak, climbing with the frame count means one.
 */
export const glTextures = { created: 0, deleted: 0 }

export function countTextures(renderer: WebGLRenderer): void {
  const gl = renderer.getContext() as (WebGL2RenderingContext | WebGLRenderingContext) & { __claudevrCounted?: true }
  if (gl.__claudevrCounted) return
  gl.__claudevrCounted = true
  const create = gl.createTexture.bind(gl)
  const del = gl.deleteTexture.bind(gl)
  gl.createTexture = () => {
    glTextures.created++
    return create()
  }
  gl.deleteTexture = t => {
    glTextures.deleted++
    del(t)
  }
}
