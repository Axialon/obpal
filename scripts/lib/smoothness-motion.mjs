/** Rigid-part identity and submission probes. No production renderer flags are changed. */
import { readFile } from 'node:fs/promises'

export async function prepareSmoothness(context) {
  const core = await readFile(new URL('../../node_modules/three/build/three.core.js', import.meta.url), 'utf8')
  await context.route('**/__smoothness_three.js', route => route.fulfill({ contentType: 'text/javascript', body: core }))
}

export async function measureSmoothnessMotion(page, { pendulum = false, marblerun = false } = {}) {
  return page.evaluate(async ({ pendulum, marblerun }) => {
    const { Box3, Frustum, Matrix4, Vector3 } = await import('/__smoothness_three.js')
    const experience = window.__presence?.experience
    if (!experience) throw new Error('No instrumentable sim experience')
    const { renderer, scene, overview: camera } = experience
    const controls = window.__device?.stage.controls ?? experience.orbit
    const logic = window.__device?.logic
    const physics = pendulum || marblerun
    if (physics && (!logic?.physicsDiagnostics || !logic?.renderState)) throw new Error('Fixed-step foundation probe is missing')
    const next = () => new Promise(requestAnimationFrame)
    if (physics) logic.units.forEach((_, n) => logic.home(n))
    for (let n = 0; n < 90; n++) await next()
    const marbleRoots = []
    if (marblerun) scene.traverse(o => { if (o.isMesh && (o.name === 'marble' || o.name.startsWith('companion-marble-'))) marbleRoots.push(o) })
    if (marblerun && marbleRoots.length !== 6) throw new Error('Expected six marble bodies')
    const roots = marblerun ? marbleRoots : pendulum ? [1, 2, 3].map(n => scene.getObjectByName(`pendulum-${n}`)) : [scene]
    if (roots.some(r => !r)) throw new Error('Expected model root is missing')
    function visible(o) {
      for (let p = o; p; p = p.parent) {
        if (!p.visible) return false
        if (p === scene) return true
      }
      return false
    }
    const selected = []
    roots.forEach(root => root.traverse(o => {
      if (o.isMesh && visible(o)) selected.push(o)
    }))
    const rigid = selected.filter(o => !o.isSkinnedMesh && !o.isInstancedMesh && o.geometry?.attributes.position)
    const drawn = new Set(), hooks = [], tracked = []
    for (const mesh of rigid) {
      const original = mesh.onBeforeRender
      const wrapper = function (...args) { drawn.add(mesh.uuid); return original.apply(this, args) }
      mesh.onBeforeRender = wrapper
      hooks.push({ mesh, original, wrapper })
      tracked.push({ mesh, geometry: mesh.geometry.uuid, box: new Box3().setFromBufferAttribute(mesh.geometry.attributes.position) })
    }
    const target = controls?.target?.clone() ?? controls?.getTarget?.(new Vector3()) ?? new Vector3()
    const start = camera.position.clone(), startQ = camera.quaternion.clone()
    const radius = Math.hypot(start.x - target.x, start.z - target.z), angle = Math.atan2(start.x - target.x, start.z - target.z)
    const projection = new Matrix4(), frustum = new Frustum(), box = new Box3(), corner = new Vector3()
    const frames = [], issues = [], gaps = []
    let hidden = 0, missingDraws = 0, changedGeometry = 0, nonFinite = 0, motionFrames = 0, renderedMotionFrames = 0, totalRotation = 0
    let maxExtent = 0, maxAngle = 0, maxSpeed = 0, restJitter = 0, motionSeconds = 0
    const invalidBefore = physics ? logic.physicsDiagnostics().invalidFrames : 0
    const note = (kind, mesh) => { if (issues.length < 100) issues.push({ kind, part: mesh.name || mesh.uuid, frame: frames.length }) }
    try {
      for (const [phase, duration] of [['rest', 1000], ['motion', 10000], ['rest-again', 1000]]) {
        if (pendulum) {
          if (phase === 'motion') logic.units.forEach(u => { u.omega = 1.4 })
          else logic.units.forEach((_, n) => logic.home(n))
        }
        if (marblerun) logic.units.forEach((_, n) => logic.home(n))
        const resting = marblerun ? logic.renderState() : null
        const begin = performance.now(); let previous = begin, pushes = 0
        // Include the RAF which reaches the duration; probe work between frames is not captured motion.
        while (previous - begin < duration) {
          if (marblerun && phase === 'motion') {
            const due = Math.min(20, Math.floor((performance.now() - begin) / 100) + 1)
            while (pushes < due) { logic.units.forEach((_, n) => logic.push(n)); pushes++ }
          }
          const beforeDraw = renderer.info.render.frame
          drawn.clear()
          if (phase === 'motion') {
            const desired = .45 * Math.min(1, (performance.now() - begin) / duration)
            if (controls?.rotate && !controls.target) controls.rotate(desired - totalRotation, 0, false)
            else { camera.position.set(target.x + radius * Math.sin(angle + desired), start.y, target.z + radius * Math.cos(angle + desired)); camera.lookAt(target); controls?.update() }
            totalRotation = desired
          }
          await next()
          const now = performance.now(), dt = now - previous; previous = now
          gaps.push(dt)
          const rendered = renderer.info.render.frame !== beforeDraw
          if (phase === 'motion') { motionFrames++; if (rendered) renderedMotionFrames++; motionSeconds = (now - begin) / 1000 }
          scene.updateMatrixWorld(true); camera.updateMatrixWorld(true)
          frustum.setFromProjectionMatrix(projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse))
          for (const t of tracked) {
            const m = t.mesh
            if (!m.matrixWorld.elements.every(Number.isFinite)) { nonFinite++; note('non-finite-transform', m); continue }
            if (!visible(m)) { hidden++; note('hidden-or-removed', m); continue }
            if (m.geometry.uuid !== t.geometry) { changedGeometry++; note('geometry-replaced', m); continue }
            if (!rendered || !m.layers.test(camera.layers)) continue
            const materials = Array.isArray(m.material) ? m.material : [m.material]
            if (!materials.some(mat => mat.visible && (!mat.transparent || mat.opacity > 0))) { hidden++; note('material-hidden', m); continue }
            // A part is required to submit only when its independently computed box is wholly inside the frustum.
            // Partial intersections are not proof of visibility. Skinned/instanced bounds need wave-specific probes.
            box.copy(t.box).applyMatrix4(m.matrixWorld)
            let inside = true
            for (let n = 0; n < 8; n++) {
              corner.set(n & 1 ? box.max.x : box.min.x, n & 2 ? box.max.y : box.min.y, n & 4 ? box.max.z : box.min.z)
              if (!frustum.containsPoint(corner)) { inside = false; break }
            }
            if (inside && !drawn.has(m.uuid)) { missingDraws++; note('not-submitted', m) }
          }
          if (pendulum) {
            const poses = logic.renderState()
            for (let n = 0; n < logic.units.length; n++) {
              const u = logic.units[n], p = poses[n]
              if (![u.angle, u.omega, u.length, p?.angle, p?.length].every(Number.isFinite)) nonFinite++
              maxAngle = Math.max(maxAngle, Math.abs(u.angle)); maxSpeed = Math.max(maxSpeed, Math.abs(u.omega))
              if (phase !== 'motion') restJitter = Math.max(restJitter, Math.abs(u.angle), Math.abs(u.omega), Math.abs(p.angle))
            }
          }
          if (marblerun) {
            const poses = logic.renderState()
            logic.units.forEach((u, n) => [u, ...u.marbles].forEach((m, j) => {
              const p = poses[n].marbles[j], home = resting[n].marbles[j]
              if (![m.x, m.z, m.vx, m.vz, m.rollX, m.rollZ, p.x, p.z, p.rollX, p.rollZ].every(Number.isFinite)) nonFinite++
              maxExtent = Math.max(maxExtent, Math.abs(m.x), Math.abs(m.z), Math.abs(p.x), Math.abs(p.z))
              maxSpeed = Math.max(maxSpeed, Math.hypot(m.vx, m.vz))
              if (phase !== 'motion') restJitter = Math.max(restJitter, Math.hypot(p.x - home.x, p.z - home.z), Math.hypot(m.vx, m.vz))
            }))
          }
          frames.push({ phase, dt, rendered })
          if (frames.length > 12000) throw new Error('Motion capture exceeded its bounded frame inventory')
        }
      }
    } finally {
      for (const { mesh, original, wrapper } of hooks) if (mesh.onBeforeRender === wrapper) mesh.onBeforeRender = original
      if (controls?.rotate && !controls.target) controls.rotate(-totalRotation, 0, false)
      else { camera.position.copy(start); camera.quaternion.copy(startQ); controls?.update() }
      if (physics) logic.units.forEach((_, n) => logic.home(n))
    }
    gaps.sort((a, b) => a - b)
    const percentile = p => gaps[Math.floor((gaps.length - 1) * p)] ?? NaN
    return { frames: frames.length, motionSeconds, motionFrames, renderedMotionFrames,
      p95: percentile(.95), p99: percentile(.99), maxGap: gaps.at(-1) ?? NaN,
      hidden, missingDraws, changedGeometry, nonFinite, rigidMeshes: rigid.length, unsupportedMeshes: selected.length - rigid.length,
      physics: { supported: physics, model: marblerun ? 'marblerun' : 'pendulum', maxExtent, maxAngle, maxSpeed, restJitter, invalidFrames: physics ? logic.physicsDiagnostics().invalidFrames - invalidBefore : 0 },
      samples: frames, issues, scope: marblerun ? 'Six moving glass spheres and their rigid colour ribbons; static instanced track outside this motion probe.' : 'Authored model roots',
      instrumentation: 'RAF timing and rigid mesh submissions; no framebuffer preservation. Not per-part pixel visibility or skinned vertex coverage.' }
  }, { pendulum, marblerun })
}
