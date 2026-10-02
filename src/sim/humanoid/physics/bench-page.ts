/** Verifier-only entry: existing Rig/skins + real Rapier; no public route, fake camera, extra meshes or driver code. */
import * as THREE from 'three'
import { Rig } from '../rig'
import { rad, neutral } from '../profile'
import { STEP } from '../../physics/schema'
import { createSelectedSimulation } from '../../physics/selection'
import { jointMotionRad } from './observation'
import { HumanoidPilot } from './pilot'
import { ActuationGate } from './contract'
import { buildHumanoid, profileFor, targetsFromAngles, canonicalPoses, framesFromBodies } from './model'
import { percentile } from './acceptance'
import { measureStance, type stanceSample } from './measure'
const raf = () => new Promise<number>(resolve => requestAnimationFrame(resolve))
let active: Awaited<ReturnType<typeof setup>> | null = null
async function setup(profileId: string) {
  const model = buildHumanoid(profileId), pilot = await HumanoidPilot.create(model), profile = profileFor(profileId)
  let renderer: THREE.WebGLRenderer | undefined, rig: Rig | undefined
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    renderer.setPixelRatio(1); renderer.setSize(innerWidth, innerHeight); renderer.setClearColor(0x000000, 0)
    renderer.domElement.id = 'humanoid-proof'; document.body.append(renderer.domElement)
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, .01, 100)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x607080, 2))
    const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(2, 4, -3); scene.add(light)
    rig = new Rig(profile); scene.add(rig.root); rig.poseWorld(pilot.renderFrames()); rig.load()
    return { model, pilot, profile, renderer, rig, scene, camera, stanceGuides: [] as THREE.Line[] }
  } catch (e) { rig?.dispose(); renderer?.dispose(); renderer?.domElement.remove(); pilot.dispose(); throw e }
}
function alive() { if (!active) throw new Error('No pilot proof session'); return active }
function clearStanceGuides() {
  const a = alive()
  for (const line of a.stanceGuides) {
    a.scene.remove(line); line.geometry.dispose()
    for (const material of Array.isArray(line.material) ? line.material : [line.material]) material.dispose()
  }
  a.stanceGuides = []
}
function dispose() { if (!active) return; const a = active; clearStanceGuides(); active = null; a.pilot.dispose(); a.rig.dispose(); a.renderer.dispose(); a.renderer.forceContextLoss(); a.renderer.domElement.remove() }
function aim(distance = 3.5, phase = 0) {
  const a = alive(), p = a.rig.root.position
  distance /= Math.min(1, a.camera.aspect * 1.4) // preserve framing on narrow proof viewports, without reducing mesh quality.
  a.camera.position.set(p.x + Math.sin(phase) * distance, p.y + .15, p.z - Math.cos(phase) * distance)
  a.camera.lookAt(p.x, p.y + .05, p.z); a.camera.updateMatrixWorld()
}
async function pixels() {
  const { renderer } = alive(), gl = renderer.getContext(), width = gl.drawingBufferWidth, height = gl.drawingBufferHeight
  if (!(gl instanceof WebGL2RenderingContext)) throw new Error('F1a pixel proof requires WebGL2')
  const started = performance.now(), buffer = new Uint8Array(width * height * 4)
  // Snapshot this submitted frame into owned GPU storage. Polling a fence avoids a synchronous GPU finish;
  // later renders cannot replace these pixels, and no frame interval is discarded while evidence completes.
  const pack = gl.createBuffer()
  if (!pack) throw new Error('Pixel-pack buffer unavailable')
  let sync: WebGLSync | null = null, queued = started, copied = started
  try {
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack); gl.bufferData(gl.PIXEL_PACK_BUFFER, buffer.byteLength, gl.STREAM_READ)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0)
    sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); gl.flush(); queued = performance.now()
    if (!sync) throw new Error('Pixel-readback fence unavailable')
    for (;;) {
      const status = gl.clientWaitSync(sync, 0, 0)
      if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) break
      if (status === gl.WAIT_FAILED || gl.isContextLost()) throw new Error('Pixel-readback fence failed')
      if (performance.now() - started > 5000) throw new Error('Pixel-readback fence exceeded 5 s proof budget')
      await raf()
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, buffer)
    copied = performance.now()
  } finally {
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    if (sync) gl.deleteSync(sync)
    gl.deleteBuffer(pack)
  }
  let covered = 0
  for (let i = 3; i < buffer.length; i += 4) if (buffer[i]) covered++
  const counted = performance.now()
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))
  const hash = [...digest].map(b => b.toString(16).padStart(2, '0')).join('')
  return { width, height, coveredPixels: covered, coverage: covered / (width * height), hash,
    queueMs: queued - started, fenceAndCopyMs: copied - queued, alphaCountMs: counted - copied,
    hashWaitMs: performance.now() - counted, totalLatencyMs: performance.now() - started }
}
const api = {
  async begin(profileId: string) {
    dispose(); active = await setup(profileId); aim(); const a = alive(); a.renderer.render(a.scene, a.camera)
    const gl = a.renderer.getContext(), info = gl.getExtension('WEBGL_debug_renderer_info')
    return { metadata: a.pilot.metadata(), profileId, renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) as string : 'debug renderer unavailable' }
  },
  status() { const a = alive(); return { visible: a.rig.root.visible, prototype: a.rig.root.userData.prototype, lods: a.rig.root.userData.lods ?? 0 } },
  async loading(mode: 'cold' | 'slow' | 'failed') {
    const a = alive(), timeline: { ms: number; prototype: string; visible: boolean; lods: number; tick: number; pixels: Awaited<ReturnType<typeof pixels>> }[] = []
    let last = await raf(), first = last, previous = '', readyAt: number | null = null
    while (last - first < 25_000) { // ms: bounded loader/decoder proof budget, not a product timeout change.
      const now = await raf(), dt = (now - last) / 1000; last = now
      a.pilot.advance(dt); a.rig.poseWorld(a.pilot.renderFrames()); aim(); a.renderer.render(a.scene, a.camera)
      const status = api.status(), signature = JSON.stringify(status)
      if (signature !== previous) { previous = signature; timeline.push({ ms: now - first, ...status, tick: a.pilot.diagnostics().tick, pixels: await pixels() }) }
      const ready = status.visible && (mode === 'failed' ? status.prototype === 'procedural' : status.prototype === 'blender' && status.lods === 2)
      if (!ready) readyAt = null
      else if (readyAt === null) readyAt = now
      if (readyAt !== null && now - readyAt >= 400) return { pass: true, timeline, seconds: (now - first) / 1000, droppedSeconds: a.pilot.diagnostics().droppedSeconds }
    }
    return { pass: false, timeline, seconds: (last - first) / 1000, error: 'Authored model/LOD or expected fallback did not settle within 25 s' }
  },
  async motion() {
    const a = alive(); await a.pilot.reset()
    const times: number[] = [], tickWall: number[] = []
    const captures: Promise<{ frame: number; pixels?: Awaited<ReturnType<typeof pixels>>; error?: string }>[] = []
    const stages: { frame: number; intervalMs: number; dispatchLagMs: number;
      observationMs: number; rigMs: number; renderMs: number; auditMs: number; captureQueueMs: number; workMs: number }[] = []
    const physicsUpdates: { timeMs: number; intervalMs: number; targetsMs: number; advanceMs: number; steps: number; tick: number; droppedSeconds: number }[] = []
    const capture = (frame: number) => captures.push(pixels().then(pixels => ({ frame, pixels }), error => ({ frame, error: String(error) })))
    const expected = Object.values(a.model.parts).map(p => p.bodyId)
    const missingBodies = new Set<string>()
    let submitted = new Set<string>(), geometry = new Set<string>(), baseline: string[] | null = null, missingSubmissions = 0, geometryChanges = 0
    const watched = new WeakSet<THREE.Mesh>(), initial = a.pilot.observation()
    const motionJoint = a.model.scene.joints.find(j => j.child === a.model.parts.left_upper_arm.bodyId)!.id
    let movementRad = 0, last = await raf(), first = last, elapsed = 0, frames = 0, maxCalls = 0, maxTriangles = 0
    let physicsLast = first, clockError: unknown = null
    const advanceClock = () => {
      const now = performance.now(), dt = (now - physicsLast) / 1000, phase = (now - first) / 1000
      const targets = targetsFromAngles(a.model, { 'left.arm.roll': rad(20 + 15 * Math.sin(phase * Math.PI * .6)), 'right.arm.roll': rad(20 + 15 * Math.sin(phase * Math.PI * .6)) })
      const start = performance.now()
      a.pilot.advance(dt, o => ({ schema_version: 1, profileId: a.model.profileId, actorId: a.model.actorId, generation: o.generation, tick: o.stateTick, source: 'classical', targets }))
      const d = a.pilot.diagnostics(), finished = performance.now()
      if (d.steps) tickWall.push((finished - start) / d.steps)
      physicsUpdates.push({ timeMs: now, intervalMs: dt * 1000, targetsMs: start - now, advanceMs: finished - start,
        steps: d.steps, tick: d.tick, droppedSeconds: d.droppedSeconds })
      physicsLast = now
    }
    // Verifier-only wall timer: presentation callbacks may stop while the event loop can still advance physics.
    // Every actual timer interval reaches the unchanged 50 ms / 12-tick clock; a timer stall still drops and fails.
    const timer = setInterval(() => { try { advanceClock() } catch (e) { clockError = e; clearInterval(timer) } }, 1000 / 60)
    try {
    while (elapsed < 10) { // s: real animation/orbit window, not a static render-only loop.
      const now = await raf(), dt = (now - last) / 1000; last = now; elapsed = (now - first) / 1000
      if (clockError) throw clockError
      const entered = performance.now()
      times.push(dt * 1000)
      movementRad = Math.max(movementRad, jointMotionRad(initial, a.pilot.observation(), motionJoint))
      const observed = performance.now()
      a.rig.poseWorld(a.pilot.renderFrames()); aim(3.5, elapsed * .3); a.rig.detail(a.camera.position)
      submitted = new Set(); geometry = new Set()
      a.rig.root.traverse(o => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh || watched.has(mesh)) return
        watched.add(mesh); const old = mesh.onBeforeRender
        mesh.onBeforeRender = (...args) => {
          old.apply(mesh, args)
          let parent: THREE.Object3D | null = mesh
          while (parent && !a.rig.pivots.has(parent.name)) parent = parent.parent
          if (parent) submitted.add(a.model.frames[parent.name].bodyId)
          geometry.add(`${mesh.uuid}:${mesh.geometry.uuid}`)
        }
      })
      const prepared = performance.now()
      a.renderer.render(a.scene, a.camera)
      const rendered = performance.now()
      maxCalls = Math.max(maxCalls, a.renderer.info.render.calls); maxTriangles = Math.max(maxTriangles, a.renderer.info.render.triangles)
      const missing = expected.filter(id => !submitted.has(id))
      missing.forEach(id => missingBodies.add(id)); missingSubmissions += missing.length
      const keys = [...geometry].sort()
      if (!baseline) baseline = keys
      else if (JSON.stringify(keys) !== JSON.stringify(baseline)) geometryChanges++
      const audited = performance.now()
      if (frames % 30 === 0) capture(frames)
      const finished = performance.now()
      stages.push({ frame: frames, intervalMs: dt * 1000, dispatchLagMs: entered - now,
        observationMs: observed - entered, rigMs: prepared - observed,
        renderMs: rendered - prepared, auditMs: audited - rendered, captureQueueMs: finished - audited, workMs: finished - entered })
      frames++
    }
    advanceClock() // Account for the final real interval before stopping; never reset or truncate the trial's clock.
    } finally { clearInterval(timer) }
    capture(frames)
    const completedCaptures = await Promise.all(captures), coverages = completedCaptures.flatMap(c => c.pixels ? [c.pixels] : [])
    const captureErrors = completedCaptures.flatMap(c => c.error ? [c.error] : [])
    const d = a.pilot.diagnostics(), p95FrameMs = percentile(times, .95), p99FrameMs = percentile(times, .99)
    const failures = [elapsed < 10 && 'Motion window shorter than ten seconds', !d.tick && 'No completed physics ticks',
      d.droppedSeconds > 0 && `Clock dropped ${d.droppedSeconds} seconds`, d.invalidFrames > 0 && 'Invalid frame input',
      movementRad <= .05 && 'Insufficient joint-relative arm motion', missingSubmissions > 0 && `No skin submissions for ${[...missingBodies].join(', ')}`,
      geometryChanges > 0 && 'Mesh/geometry identities changed', coverages.some(c => !c.coveredPixels) && 'Empty alpha coverage',
      new Set(coverages.map(c => c.hash)).size <= 1 && 'Frame hashes did not change', ...captureErrors].filter(Boolean)
    return { profileId: a.model.profileId, seconds: elapsed, frames, p95FrameMs, p99FrameMs, p95TickWallMs: percentile(tickWall, .95), p99TickWallMs: percentile(tickWall, .99),
      p50FrameMs: percentile(times, .5), maxFrameMs: Math.max(...times), tickWallSamples: tickWall.length,
      p50TickWallMs: percentile(tickWall, .5), maxTickWallMs: Math.max(...tickWall), failures,
      frameIntervalsMs: times, tickWallMs: tickWall, frameStages: stages, physicsUpdates,
      physicsStartTimeMs: first, physicsEndTimeMs: physicsLast, physicsSeconds: (physicsLast - first) / 1000,
      captureFrames: completedCaptures.map(c => c.frame), captureErrors,
      completedTicks: d.tick, droppedSeconds: d.droppedSeconds, invalidFrames: d.invalidFrames, motionJoint, movementRad, maxCalls, maxTriangles, expectedParts: expected,
      missingSubmissions, missingBodies: [...missingBodies], geometryChanges, coverages, prototype: a.rig.root.userData.prototype, lod: a.rig.root.userData.lod ?? 0,
      hardwareConcurrency: navigator.hardwareConcurrency,
      pass: elapsed >= 10 && d.tick > 0 && d.droppedSeconds === 0 && d.invalidFrames === 0 && movementRad > .05 && !missingSubmissions && !geometryChanges &&
        !captureErrors.length && coverages.every(c => c.coveredPixels > 0) && new Set(coverages.map(c => c.hash)).size > 1,
      note: 'One actor only; verifier-only 60 Hz wall timer advances real elapsed physics independently of presentation callbacks, with unchanged 50 ms / 12-tick limits. Raw physics update intervals and animation intervals are separate. Instrumented preserveDrawingBuffer renderer, fixed LOD near orbit, periodic full-frame alpha snapshots via GPU buffers/fences and native hashes. Motion never awaits a capture; queue/copy/count work still affects actual intervals, completion latencies are separate and all evidence is awaited afterward. Not full-scene/two-actor/F1c performance acceptance or per-part pixel-occlusion proof.' }
  },
  async clockLimits() {
    const a = alive(); await a.pilot.reset(); a.pilot.advance(.15)
    const d = a.pilot.diagnostics()
    return { inputSeconds: .15, completedTicks: d.tick, droppedSeconds: d.droppedSeconds, invalidFrames: d.invalidFrames }
  },
  async pose(name: string, lod: number) {
    const a = alive(), poses = canonicalPoses(a.model.profileId)
    if (!Object.hasOwn(poses, name) || ![0, 1].includes(lod)) throw new RangeError('Unknown pose/LOD')
    if (lod && a.rig.root.userData.lods !== 2) throw new Error('Low-detail authored skin unavailable')
    const simulation = await createSelectedSimulation({ ...a.model.scene, gravity: { x: 0, y: 0, z: 0 } }), targets = targetsFromAngles(a.model, poses[name]), gate = new ActuationGate(a.model, 1)
    try {
      for (let tick = 0; tick < 480; tick++) {
        simulation.setMotorTargets(gate.accept({ schema_version: 1, profileId: a.model.profileId, actorId: a.model.actorId, generation: 1, tick, source: 'classical', targets }).targets)
        simulation.advance(STEP)
      }
      a.rig.poseWorld(framesFromBodies(a.model, simulation.snapshot())); aim()
      // Deliberate comparison: render both existing LODs at the same camera scale; no geometry substitution.
      a.rig.detail(a.rig.root.position.clone().add(new THREE.Vector3(lod ? 8 : 3, 0, 0)))
      a.renderer.render(a.scene, a.camera)
      return { name, lod: a.rig.root.userData.lod ?? 0, prototype: a.rig.root.userData.prototype, pixels: await pixels(),
        root: simulation.snapshot().find(b => b.id === a.model.root), gravity: 'zero: anatomical pose attempt, not supported balance', completedTicks: simulation.diagnostics().tick }
    } finally { simulation.dispose() }
  },
  async stance() { return measureStance(alive().model.profileId) },
  stanceFrame(sample: ReturnType<typeof stanceSample>) {
    const a = alive(); clearStanceGuides()
    a.rig.poseWorld(framesFromBodies(a.model, sample.bodies))
    // Verifier-only world guides show the unchanged floor and measured lower-face corners, not replacement skins.
    const grid = new THREE.GridHelper(3, 30, 0x80909d, 0x46525f)
    a.scene.add(grid); a.stanceGuides.push(grid)
    sample.feet.forEach((foot, i) => {
      const points = [0, 1, 3, 2].map(n => new THREE.Vector3().copy(foot.soleWorldCorners[n]))
      const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: i ? 0xffcc55 : 0x55ddff, depthTest: false }))
      a.scene.add(line); a.stanceGuides.push(line)
    })
    a.camera.position.set(2.7, 1.3, -3.8); a.camera.lookAt(0, .65, 0); a.camera.updateMatrixWorld()
    a.renderer.render(a.scene, a.camera)
    return { tick: sample.tick, timeS: sample.timeS, rootHeightM: sample.rootHeightM, rootUpY: sample.rootUpY }
  },
  legacyReset() {
    const a = alive(); a.rig.pose(neutral(a.profile)); a.rig.root.updateMatrixWorld(true)
    const p = a.rig.point(a.profile.root)
    return { rootRotationErrorRad: a.rig.root.quaternion.angleTo(new THREE.Quaternion()), pelvisHeightErrorM: Math.abs(p.y - a.profile.joints[0].offset[1]) }
  },
  dispose,
}
Object.defineProperty(window, '__humanoidPhysics', { value: api, writable: false, configurable: false })
