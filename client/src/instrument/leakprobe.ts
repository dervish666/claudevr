// A replay of pmndrs/xr #501 that runs without a headset: drive a render
// target the way an XRLayer does (colour handed in from outside each frame,
// no depth argument, setXRLayerRenderTarget in @pmndrs/xr 6.6.32), render
// into it, and count the GL textures created. The count comes from wrapping
// the context's own createTexture, not from three's bookkeeping, which would
// not see orphaned handles.

import { DepthTexture, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, Scene, WebGLRenderer, WebGLRenderTarget } from 'three'

export function leakProbe(frames = 60): { warmup: number; created: number; frames: number } {
  const run = () => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 64
    const renderer = new WebGLRenderer({ canvas })
    const gl = renderer.getContext()
    let created = 0
    const create = gl.createTexture.bind(gl)
    gl.createTexture = () => {
      created++
      return create()
    }
    const rt = new WebGLRenderTarget(64, 64, { depthTexture: new DepthTexture(64, 64) })
    const scene = new Scene()
    scene.add(new Mesh(new PlaneGeometry(), new MeshBasicMaterial()))
    const camera = new PerspectiveCamera()
    camera.position.z = 2
    const colour = create()
    gl.bindTexture(gl.TEXTURE_2D, colour)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 64, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    // One warm-up frame so the first allocation is not counted.
    renderer.setRenderTargetTextures(rt, colour)
    renderer.setRenderTarget(rt)
    renderer.render(scene, camera)
    // The control: the warm-up frame allocates, so a zero below is the counter seeing nothing, not a blind counter.
    const warmup = created
    created = 0
    for (let i = 0; i < frames; i++) {
      renderer.setRenderTargetTextures(rt, colour)
      renderer.setRenderTarget(rt)
      renderer.render(scene, camera)
    }
    renderer.setRenderTarget(null)
    const n = created
    rt.dispose()
    renderer.dispose()
    renderer.forceContextLoss()
    return { warmup, created: n, frames }
  }
  return run()
}
