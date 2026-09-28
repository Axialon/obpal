/** Consecutive framebuffer samples. Only the test context preserves the drawing buffer for readPixels. */
import { readFile } from 'node:fs/promises'

export async function prepareTemporal(context) {
  const core = await readFile(new URL('../../node_modules/three/build/three.core.js', import.meta.url), 'utf8')
  await context.route('**/__temporal_three.js', route => route.fulfill({ contentType: 'text/javascript', body: core }))
  await context.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (kind, options) {
      return get.call(this, kind, kind.startsWith('webgl') ? { ...options, preserveDrawingBuffer: true } : options)
    }
  })
}

/** Track opaque planar surfaces in world space, so ordinary camera travel is not mistaken for a flash. */
export async function measureTemporal(page, { captures = false } = {}) {
  return page.evaluate(async ({ captures }) => {
    const { Raycaster, Vector2, Vector3, Matrix3 } = await import('/__temporal_three.js')
    const experience = window.__presence.experience
    const { renderer, scene, overview: camera } = experience
    const controls = window.__device?.stage.controls ?? window.__viewer?.controls ?? experience.orbit
    const canvas = renderer.domElement, gl = renderer.getContext()
    const next = () => new Promise(requestAnimationFrame)
    for (let i = 0; i < 75; i++) await next()
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight
    const pixels = new Uint8Array(w * h * 4), previous = new Uint8Array(pixels.length), heat = new Uint8Array(pixels.length)
    const read = () => {
      if (gl.drawingBufferWidth !== w || gl.drawingBufferHeight !== h) throw new Error('drawing buffer resized during measurement')
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
      if (gl.getError() !== gl.NO_ERROR) throw new Error('framebuffer read failed')
    }
    read()
    let lit = 0
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 12) lit++
    if (lit < w * h * .02) throw new Error('empty framebuffer; cannot prove stability')
    const luminance = (x, y) => {
      let sum = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const i = ((y + dy) * w + x + dx) * 4
        sum += pixels[i] * .2126 + pixels[i + 1] * .7152 + pixels[i + 2] * .0722
      }
      return sum / 9
    }
    scene.updateMatrixWorld(true); camera.updateMatrixWorld(true)
    const meshes = []
    scene.traverseVisible(o => { if (o.isMesh && !o.isInstancedMesh) meshes.push(o) })
    const ray = new Raycaster(), normalMatrix = new Matrix3(), normal = new Vector3(), ndc = new Vector2()
    const tracks = []
    for (let y = 20; y < h - 20; y += 24) for (let x = 20; x < w - 20; x += 24) {
      ray.setFromCamera(ndc.set((x + .5) / w * 2 - 1, (y + .5) / h * 2 - 1), camera)
      const hit = ray.intersectObjects(meshes, false).find(hit => {
        const m = Array.isArray(hit.object.material) ? hit.object.material[hit.face.materialIndex] : hit.object.material
        return m.visible && (!m.transparent || m.isShaderMaterial && m.uniforms.uColor)
      })
      if (!hit?.face) continue
      const object = hit.object, material = Array.isArray(object.material) ? object.material[hit.face.materialIndex] : object.material
      normal.copy(hit.face.normal).applyNormalMatrix(normalMatrix.getNormalMatrix(object.matrixWorld))
      if (Math.max(Math.abs(normal.x), Math.abs(normal.y), Math.abs(normal.z)) < .995 || material.emissiveIntensity > 0 && material.emissive?.getHex()) continue
      // Avoid silhouettes, seams and shadow boundaries: the test follows surface interiors.
      let low = 255, high = 0
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const i = ((y + dy) * w + x + dx) * 4
        const value = pixels[i] * .2126 + pixels[i + 1] * .7152 + pixels[i + 2] * .0722
        low = Math.min(low, value); high = Math.max(high, value)
      }
      if (high - low > 10) continue
      tracks.push({ object, material, matrix: object.matrixWorld.elements.slice(), point: hit.point.clone(), x, y,
        kind: normal.y > .995 && hit.point.y < .3 ? 'floor' : Math.abs(normal.y) < .005 ? 'wall' : 'prop',
        previous: luminance(x, y), moving: false })
    }
    if (tracks.length < 20) throw new Error(`only ${tracks.length} measurable surface interiors`)
    const target = controls?.target?.clone() ?? controls?.getTarget?.(new Vector3()) ?? new Vector3(0, 0, .15)
    const start = camera.position.clone(), delta = start.clone().sub(target), radius = Math.hypot(delta.x, delta.z), angle = Math.atan2(delta.x, delta.z)
    const projected = new Vector3(), frames = [], shots = []
    const image = document.createElement('canvas'); image.width = 640; image.height = Math.round(h / w * 640)
    const ctx = image.getContext('2d')
    const memory = () => ({ ...renderer.info.memory, programs: renderer.info.programs.length })
    const before = memory()
    let sample = 0
    for (const phase of ['rest', 'orbit', 'settle', 'rest-again']) for (let n = 0; n < 64; n++) {
      if (phase === 'orbit') {
        if (controls?.rotate && !controls.target) controls.rotate(.0004, 0, false)
        else {
          const a = angle + (n + 1) * .0004
          camera.position.set(target.x + radius * Math.sin(a), start.y, target.z + radius * Math.cos(a))
          camera.lookAt(target); controls?.update()
        }
      }
      await next(); read()
      const differences = [], kinds = { floor: [], wall: [], prop: [] }
      for (const track of tracks) {
        // Exclude intentional animation by its transform, never by its pixel variance.
        if (track.moving || track.object.matrixWorld.elements.some((v, i) => Math.abs(v - track.matrix[i]) > 1e-5)) { track.moving = true; continue }
        projected.copy(track.point).project(camera)
        const x = Math.round((projected.x + 1) * .5 * w - .5), y = Math.round((projected.y + 1) * .5 * h - .5)
        if (x < 5 || x >= w - 5 || y < 5 || y >= h - 5) continue
        const value = luminance(x, y), difference = Math.abs(value - track.previous)
        track.previous = value
        differences.push(difference); kinds[track.kind].push(difference)
      }
      differences.sort((a, b) => a - b)
      const percentile = (values, p) => values[Math.floor((values.length - 1) * p)] ?? 0
      frames.push({ phase, n, samples: differences.length, p95: percentile(differences, .95), p99: percentile(differences, .99),
        spikes: differences.filter(d => d > 12).length / differences.length,
        kinds: Object.fromEntries(Object.entries(kinds).map(([kind, ds]) => [kind, { count: ds.length, p95: percentile(ds.sort((a, b) => a - b), .95) }])),
        still: window.__gfx?.().still ?? null })
      if (captures) {
        if (sample) for (let i = 0; i < pixels.length; i += 4) {
          const difference = Math.max(Math.abs(pixels[i] - previous[i]), Math.abs(pixels[i + 1] - previous[i + 1]), Math.abs(pixels[i + 2] - previous[i + 2]))
          heat[i] = Math.max(heat[i], difference); heat[i + 3] = 255
        }
        previous.set(pixels)
        if (phase === 'orbit' || n === 63 && phase === 'rest-again') {
          ctx.clearRect(0, 0, image.width, image.height); ctx.drawImage(canvas, 0, 0, image.width, image.height)
          shots.push({ phase, n, image: image.toDataURL('image/png') })
        }
      }
      sample++
    }
    let heatmap = null
    if (captures) {
      image.width = w; image.height = h
      ctx.putImageData(new ImageData(new Uint8ClampedArray(heat), w, h), 0, 0)
      heatmap = image.toDataURL('image/png')
    }
    return { width: w, height: h, frames, shots, heatmap, before, after: memory(), gfx: window.__gfx?.(),
      surfaces: Object.fromEntries(['floor', 'wall', 'prop'].map(kind => [kind, tracks.filter(t => t.kind === kind && !t.moving).length])) }
  }, { captures })
}

/** A few occlusions or animated shadows may cross a probe; a broad surface must not flash. Values are 8-bit luminance. */
export function temporalFailure(result) {
  for (const phase of ['rest', 'orbit', 'settle', 'rest-again']) {
    if (result.frames.filter(frame => frame.phase === phase).length < 64) return `${phase}: fewer than 64 consecutive frames`
  }
  for (const frame of result.frames) {
    if (frame.samples < 20) return `${frame.phase}: only ${frame.samples} static surface samples`
    if (!Number.isFinite(frame.p95) || !Number.isFinite(frame.spikes)) return `${frame.phase}: invalid pixel measurement`
    if (frame.phase === 'settle' || frame.phase === 'orbit' && frame.n < 2) continue
    const tolerance = frame.phase === 'orbit' ? 3 : 2
    if (frame.p95 > tolerance || frame.spikes > .05) return `${frame.phase} frame ${frame.n}: p95 ${frame.p95.toFixed(2)}/255, ${(frame.spikes * 100).toFixed(1)}% flashed`
  }
  return null
}
