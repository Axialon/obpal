/** Soft roster, forms, swaps and face signatures in the actual scene. Evidence stays in the caller's temporary folder. */
import { join } from 'node:path'
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { rawRun } from './lib/distill.mjs'
import { prepareSmoothness } from './lib/smoothness-motion.mjs'
import { Vector3 } from 'three'

/** Every rendered practice frame, using loaded sole vertices rather than target angles or joint centres. */
export async function cairnGaitProof(browser, origin) {
  const out = join(process.env.OBPAL_E2E_EVIDENCE_ROOT, 'cairn-gait'), raw = rawRun(out), frames = []
  const report = { source: process.env.OBPAL_PILOT_SOURCE, scope: 'Classical visual practice; no loaded physical gait or physical-device certification', scenarios: [] }
  const capture = async (page, name) => {
    await mkdir(join(raw, name), { recursive: true })
    const sample = await page.evaluate(() => {
      const s = window.cairnGait, row = s.rows.at(-1)
      return { phase: s.phase, atSeconds: (performance.now() - s.start) / 1000, renderedFrameSeconds: row?.t, root: row?.root, lod: row?.lod }
    })
    await page.screenshot({ path: join(raw, name, 'frame.png') })
    frames.push({ path: `${name}/frame.png`, capturedAt: new Date().toISOString(), sampleBeforeScreenshot: sample, failed: false })
  }
  try {
    for (const [size, width, height] of [['desktop', 1440, 900], ['phone', 390, 844]]) for (const lod of [0, 1]) for (const traversal of ['pilot', 'directions', 'interruptions']) {
      const cameraPosition = traversal === 'pilot' ? [3.3, 1.5, -3.3] : [6, 4.5, -9]
      const context = await browser.newContext({ viewport: { width, height }, isMobile: size === 'phone', hasTouch: size === 'phone', deviceScaleFactor: 1, ignoreHTTPSErrors: true })
      let page
      const errors = [], actions = []
      try {
        page = await context.newPage()
        page.on('pageerror', e => errors.push(e.message))
        await page.goto(`${origin}/sim/humanoid/?test=humanoid&preview=soft`)
        await page.waitForFunction(() => window.__humanoid?.actors.every(a => a.rig.root.userData.lods === 2))
        await page.evaluate(() => window.__humanoid.changeRobot(0, 'cairn', 0))
        await page.waitForFunction(() => window.__humanoid.actors[0].rig.profile.model === 'cairn-i' && window.__humanoid.actors[0].rig.root.userData.lods === 2)
        const panel = page.locator('.sim-window[data-panel="controls"]')
        if (await panel.isVisible()) await panel.getByRole('button', { name: 'Close Controls', exact: true }).click()
        const pair = page.locator('.obpal-chip .pill')
        await pair.focus(); await pair.press('Escape'); await pair.evaluate(b => b.blur())
        await page.mouse.move(width - 3, 3)
        await page.evaluate(position => window.__humanoid.view(position, [0, .85, 0]), cameraPosition)
        await page.waitForTimeout(500)
        await page.evaluate(lod => {
          const h = window.__humanoid, actor = h.actors[0], rig = actor.rig, V = rig.root.position.constructor
          const camera = h.camera, position = camera.position.clone(), rotation = camera.quaternion.clone(), update = camera.updateMatrixWorld.bind(camera)
          camera.updateMatrixWorld = function(force) { this.position.copy(position); this.quaternion.copy(rotation); update(force) }
          const detail = rig.detail.bind(rig)
          rig.detail = () => detail(rig.root.position.clone().add(new V(0, 0, lod ? 8 : 2)))
          rig.detail(); rig.root.updateMatrixWorld(true)
          let floor = null, markings = null
          rig.root.parent.traverse(m => {
            if (!m.isMesh || !/arena_deck|arena_etch/.test(m.name)) return
            m.updateWorldMatrix(true, false)
            let top = -Infinity
            for (let i = 0; i < m.geometry.attributes.position.count; i++) top = Math.max(top, m.getVertexPosition(i, new V()).applyMatrix4(m.matrixWorld).y)
            if (/arena_deck/.test(m.name)) floor = top; else markings = top
          })
          if (floor === null) throw Error('Loaded deck not measured')
          const feet = {}
          for (const side of ['left', 'right']) {
            const pivot = rig.pivots.get(`${side}.leg.ankle.roll`), vertices = []
            pivot.traverse(m => {
              let visible = true
              for (let p = m; p && p !== rig.root; p = p.parent) visible &&= p.visible
              if (!m.isMesh || !visible) return
              for (let i = 0; i < m.geometry.attributes.position.count; i++) {
                const p = m.getVertexPosition(i, new V()).applyMatrix4(m.matrixWorld)
                vertices.push({ m, i, localY: pivot.worldToLocal(p).y })
              }
            })
            const low = Math.min(...vertices.map(v => v.localY))
            feet[side] = { vertices, sole: vertices.filter(v => v.localY <= low + .001) }
            if (!feet[side].sole.length) throw Error('No measured sole vertices')
          }
          const state = window.cairnGait = { start: performance.now(), rows: [], inputEvents: [], phase: 'start', floor, markings, active: true }
          for (const type of ['keydown', 'keyup']) addEventListener(type, e => {
            if (state.active) state.inputEvents.push({ type, key: e.key, t: (performance.now() - state.start) / 1000 })
          })
          const sample = t => {
            if (!state.active) return
            rig.root.updateMatrixWorld(true)
            const row = { t: (t - state.start) / 1000, phase: state.phase, q: { ...actor.control.q }, qSource: 'control targets', joints: [...rig.pivots].map(([id, p]) => ({ id, renderedLocalRotation: p.quaternion.toArray(), renderedWorldRotation: p.getWorldQuaternion(rig.root.quaternion.clone()).toArray() })), root: rig.root.position.toArray(), renderedRootRotation: rig.root.quaternion.toArray(), renderedRootMatrix: rig.root.matrixWorld.toArray(), yaw: actor.control.facing, stopped: actor.control.stopped, source: actor.source, owner: actor.owner, lod: rig.root.userData.lod, feet: {} }
            for (const side of ['left', 'right']) {
              const f = feet[side], points = f.sole.map(({m, i}) => m.getVertexPosition(i, new V()).applyMatrix4(m.matrixWorld))
              const minY = Math.min(...f.vertices.map(({m, i}) => m.getVertexPosition(i, new V()).applyMatrix4(m.matrixWorld).y))
              const gait = actor.control.visualGait?.feet?.[side]
              row.feet[side] = { gap: minY - floor, markingGap: minY - markings, centroid: points.reduce((a, p) => a.add(p), new V()).multiplyScalar(1 / points.length).toArray(), sole: points.map(p => p.toArray()), stance: gait?.stance ?? null, gaitPhase: gait?.phase ?? null, cycle: gait?.cycle ?? null, segmentStart: gait?.fromPhase ?? null, plannedFrom: gait?.from?.toArray() ?? null, plannedFromYaw: gait?.fromYaw ?? null, plannedLanding: gait?.to?.toArray() ?? null, plannedYaw: gait?.toYaw ?? null, phaseSource: gait ? 'Cairn visual helper' : 'unavailable after reset', vertexCount: f.vertices.length }
            }
            state.rows.push(row); requestAnimationFrame(sample)
          }
          requestAnimationFrame(sample)
        }, lod)
        const sequence = traversal === 'pilot'
          ? [null, 's', null, 'q', 'w', 'e', '6', null, null, null].map((key, second) => [`pilot-${second}`, key, 1000])
          : [['start', null, 600], ['forward', 'w', 2600], ['stop-settle', null, 700], ['backward', 's', 2600], ['stop-backward', null, 700], ['strafe', 'a', 2600], ['stop-strafe', null, 700], ['heading', 'e', 1000], ['reversal', 'd', 2600], ['settle', null, 1000]]
        const begun = Date.now()
        let scheduled = 0
        if (traversal === 'interruptions') {
          const middle = async side => {
            await page.waitForFunction(side => {
              const f = window.cairnGait.rows.at(-1)?.feet[side]
              return f?.stance === false && f.gaitPhase >= .7 && f.gaitPhase <= .8
            }, side, { timeout: 5000 })
            return page.evaluate(side => ({ side, row: window.cairnGait.rows.length - 1, t: window.cairnGait.rows.at(-1).t, foot: { phase: window.cairnGait.rows.at(-1).feet[side].gaitPhase, cycle: window.cairnGait.rows.at(-1).feet[side].cycle } }), side)
          }
          await page.evaluate(() => window.cairnGait.phase = 'deliberate-release')
          await page.keyboard.down('w')
          const release = await middle('left')
          await page.keyboard.up('w'); actions.push({ action: 'release w during left middle swing', observed: release, acknowledgedMs: Date.now() - begun })
          await capture(page, `${size}-lod${lod}-${traversal}-middle-release`)
          await page.waitForTimeout(1000)
          await capture(page, `${size}-lod${lod}-${traversal}-release-settle`)
          await page.evaluate(() => window.cairnGait.phase = 'deliberate-reversal')
          await page.keyboard.down('w'); await page.keyboard.down('e')
          const reverse = await middle('right')
          await page.keyboard.up('w'); await page.keyboard.up('e'); await page.keyboard.down('s'); await page.keyboard.down('q')
          actions.push({ action: 'reverse translation and heading during right middle swing', observed: reverse, acknowledgedMs: Date.now() - begun })
          await capture(page, `${size}-lod${lod}-${traversal}-middle-reversal`)
          await page.waitForTimeout(1000); await page.keyboard.up('s'); await page.keyboard.up('q')
          await page.waitForTimeout(1000)
          await page.keyboard.down('d'); await page.waitForTimeout(1000); await page.keyboard.up('d')
          actions.push({ action: 'resume with strafe then release', acknowledgedMs: Date.now() - begun })
          await page.waitForTimeout(1000)
          await capture(page, `${size}-lod${lod}-${traversal}-resumed-settle`)
        } else for (const [phase, key, duration] of sequence) {
          const action = { phase, key, scheduledStartMs: scheduled, durationMs: duration, acknowledgedStartMs: Date.now() - begun }
          await page.evaluate(phase => window.cairnGait.phase = phase, phase)
          if (key) await page.keyboard.down(key)
          // Match the original pilot's fixed deadlines; screenshot work is inside the phase, not extra held-input time.
          await page.waitForTimeout(Math.max(0, begun + scheduled + duration / 2 - Date.now()))
          if (traversal !== 'pilot' || [0, 2, 3, 5, 6, 8, 9].includes(Number(phase.slice(6)))) await capture(page, `${size}-lod${lod}-${traversal}-${phase}`)
          scheduled += duration
          await page.waitForTimeout(Math.max(0, begun + scheduled - Date.now()))
          if (key) await page.keyboard.up(key)
          actions.push({ ...action, acknowledgedEndMs: Date.now() - begun })
        }
        await page.keyboard.press('Space')
        await page.evaluate(() => window.cairnGait.phase = 'Stop')
        await page.waitForTimeout(400)
        if (traversal === 'directions') await capture(page, `${size}-lod${lod}-${traversal}-Stop`)
        const data = await page.evaluate(() => { window.cairnGait.active = false; const { rows, floor, markings, inputEvents } = window.cairnGait; return { rows, floor, markings, inputEvents } })
        for (const action of actions.filter(a => a.observed)) {
          action.actualEvents = cairnInputReceipts(data.rows, data.inputEvents, action)
        }
        const summary = cairnGaitSummary(data.rows), continuity = cairnContinuitySummary(data.rows, data.inputEvents)
        report.scenarios.push({ size, lod, traversal, camera: { position: cameraPosition, target: [0, .85, 0] }, actions, scheduledDurationMs: scheduled || null, errors, ...data, summary, continuity, markingEnvelope: { kind: 'Conservative global loaded marking top; no local footprint exemption', criterion: 'Every measured boot vertex >= top minus 1 mm', minGapM: Math.min(...data.rows.flatMap(r => Object.values(r.feet).map(f => f.markingGap))) } })
        await writeFile(join(out, 'gait.json'), JSON.stringify(report))
      } catch (error) {
        const partial = await page?.evaluate(() => { if (!window.cairnGait) return null; window.cairnGait.active = false; const { rows, floor, markings, inputEvents } = window.cairnGait; return { rows, floor, markings, inputEvents } }).catch(() => null)
        report.scenarios.push({ size, lod, traversal, partial: true, errors: [...errors, error.message], actions, ...partial })
        throw error
      } finally {
        await writeFile(join(out, 'gait.json'), JSON.stringify(report))
        await context.close()
      }
    }
    const failures = report.scenarios.flatMap(s => Object.entries(s.summary).flatMap(([side, m]) => [
      ...(m.minGapM < -.001 ? [`${s.size}/LOD${s.lod}/${side} penetration ${-m.minGapM}m`] : []),
      ...(m.maxStanceDisplacementM > .01 ? [`${s.size}/LOD${s.lod}/${side} planted displacement ${m.maxStanceDisplacementM}m`] : []),
      ...Object.entries(m.swingByDirection).filter(([, value]) => s.traversal === 'directions' && value < .01).map(([phase, value]) => `${s.size}/LOD${s.lod}/${side}/${phase} swing ${value}m`),
      ...Object.keys(m.swingByDirection).filter(phase => s.traversal === 'directions' && m.completedSwings.filter(c => c.phase === phase && c.endPhase === phase && c.middleSamples && c.minMiddleGapM >= .01).length < 2).map(phase => `${s.size}/LOD${s.lod}/${side}/${phase} fewer than two complete middle-clearance swings`),
      ...m.completedSwings.filter(c => !c.middleSamples || c.minMiddleGapM < .01).map(c => `${s.size}/LOD${s.lod}/${side}/${c.phase} middle swing clearance ${c.minMiddleGapM}m (${c.middleSamples} samples)`),
    ]))
    for (const s of report.scenarios) {
      for (const action of s.actions.filter(a => a.observed)) for (const receipt of action.actualEvents) if (!receipt.accepted) failures.push(`${s.size}/LOD${s.lod} input outside measured middle swing: ${JSON.stringify(receipt)}`)
      if (s.markingEnvelope.minGapM < -.001) failures.push(`${s.size}/LOD${s.lod} conservative marking penetration`)
      for (const f of s.continuity.failures) failures.push(`${s.size}/LOD${s.lod}/${s.traversal} discontinuity ${JSON.stringify(f)}`)
    }
    report.failures = failures
    await writeFile(join(out, 'gait.json'), JSON.stringify(report))
    if (failures.length || report.scenarios.some(s => s.errors.length)) throw Error(failures.join('; ') || 'Runtime errors')
    return report.scenarios.map(({ size, lod, summary }) => ({ size, lod, summary }))
  } finally {
    await writeFile(join(out, 'evidence-frames.json'), JSON.stringify({ expectedCount: 88, frames }, null, 2))
  }
}

/** Join the initiating native input to retained airborne rows, without substituting a release for a reversal. */
export function cairnInputReceipts(rows, inputEvents, action) {
  const expected = {
    'release w during left middle swing': [['keyup', 'w']],
    'reverse translation and heading during right middle swing': [['keydown', 's'], ['keydown', 'q']],
  }[action.action]
  if (!expected) throw Error(`Unknown observed Cairn action: ${action.action}`)
  return expected.map(([type, key]) => {
    const event = inputEvents.find(e => e.type === type && e.key === key && e.t >= action.observed.t) ?? null
    const row = event ? rows.findIndex(r => r.t >= event.t) : -1
    const previous = row > 0 ? rows[row - 1] : null, next = row > 0 ? rows[row] : null
    const foot = previous?.feet[action.observed.side], after = next?.feet[action.observed.side]
    const sameCycle = foot?.cycle != null && foot.cycle === after?.cycle && foot.cycle === action.observed.foot.cycle
    const bracketed = !!event && !!previous && previous.t < event.t && event.t <= next.t
    const phase = bracketed && sameCycle ? foot.gaitPhase + (after.gaitPhase - foot.gaitPhase) * (event.t - previous.t) / (next.t - previous.t) : null
    const accepted = Number.isFinite(phase) && phase >= .675 && phase <= .825 && foot.stance === false && after.stance === false
    return { expected: { type, key }, event, bracketRows: row > 0 ? [row - 1, row] : null, sameCycle, phase, phaseBefore: foot?.gaitPhase, phaseAfter: after?.gaitPhase, cycleBefore: foot?.cycle, cycleAfter: after?.cycle, stanceBefore: foot?.stance, stanceAfter: after?.stance, accepted, clock: 'Host performance.now; interpolated between retained rendered phase rows, not a forced pose' }
  })
}

export function cairnGaitSummary(rows) {
  const summary = {}
  for (const side of ['left', 'right']) {
    let anchor = null, maxStanceDisplacementM = 0, maxTangentialDisplacementM = 0, nearFloorTravelM = 0, cycle = null
    const swingByDirection = Object.fromEntries(['forward', 'backward', 'strafe', 'reversal'].map(p => [p, 0]))
    const completedSwings = [], incompleteSwings = []
    for (let i = 0; i < rows.length; i++) {
      const f = rows[i].feet[side], previous = rows[i - 1]?.feet[side]
      if (f.stance === true && previous?.stance === true && anchor) {
        for (let n = 0; n < f.sole.length; n++) {
          maxStanceDisplacementM = Math.max(maxStanceDisplacementM, Math.hypot(...f.sole[n].map((v, axis) => v - anchor[n][axis])))
          maxTangentialDisplacementM = Math.max(maxTangentialDisplacementM, Math.hypot(f.sole[n][0] - anchor[n][0], f.sole[n][2] - anchor[n][2]))
        }
      } else anchor = f.stance === true ? f.sole : null
      if (f.stance === false && previous?.stance !== false) cycle = { phase: rows[i].phase, start: rows[i].t, peakGapM: f.gap, middleSamples: 0, minMiddleGapM: null, partialStart: previous?.stance !== true }
      if (f.stance === false && cycle) {
        cycle.peakGapM = Math.max(cycle.peakGapM, f.gap)
        const u = f.gaitPhase === null || f.gaitPhase === undefined ? null : (f.gaitPhase - .5) * 2
        if (u !== null && u >= .35 && u <= .65) {
          cycle.middleSamples++
          cycle.minMiddleGapM = cycle.minMiddleGapM === null ? f.gap : Math.min(cycle.minMiddleGapM, f.gap)
        }
      }
      if (f.stance === true && cycle) {
        ;(cycle.partialStart ? incompleteSwings : completedSwings).push({ ...cycle, end: rows[i].t, endPhase: rows[i].phase })
        cycle = null
      }
      if (f.stance === null && cycle) {
        incompleteSwings.push({ ...cycle, end: rows[i].t, endPhase: rows[i].phase, reason: 'Helper reset; phase unavailable' }); cycle = null
      }
      if (previous && Math.abs(f.gap) <= .005 && Math.abs(previous.gap) <= .005) nearFloorTravelM += Math.hypot(f.centroid[0] - previous.centroid[0], f.centroid[2] - previous.centroid[2])
      if (f.stance === false && rows[i].phase in swingByDirection) swingByDirection[rows[i].phase] = Math.max(swingByDirection[rows[i].phase], f.gap)
    }
    const gaps = rows.map(r => r.feet[side].gap).sort((a, b) => a - b)
    summary[side] = { minGapM: gaps[0], maxGapM: gaps.at(-1), medianGapM: gaps[Math.floor(gaps.length * .5)], p95GapM: gaps[Math.floor(gaps.length * .95)], maxStanceDisplacementM, maxTangentialDisplacementM, nearFloorTravelM, swingByDirection, completedSwings, incompleteSwings, incompleteSwing: cycle, unavailablePhaseFrames: rows.filter(r => r.feet[side].gaitPhase == null).length, middleInterval: [.35, .65], frames: rows.length }
  }
  return summary
}

/** Adjacent rigid sole material points, including every lift-off, landing and native input edge. */
export function cairnContinuitySummary(rows, inputEvents = []) {
  const samples = [], failures = []
  const v = p => new Vector3(...p), distance = (a, b) => Math.hypot(...a.map((n, i) => n - b[i]))
  for (const side of ['left', 'right']) {
    const first = rows[0]?.feet[side].sole
    if (!first?.length) continue
    const a = v(first[0]), b = first.reduce((best, p, i) => v(p).distanceToSquared(a) > v(first[best]).distanceToSquared(a) ? i : best, 0)
    const edge = v(first[b]).sub(a)
    const c = first.reduce((best, p, i) => edge.clone().cross(v(p).sub(a)).lengthSq() > edge.clone().cross(v(first[best]).sub(a)).lengthSq() ? i : best, 0)
    const basis = points => {
      const x = v(points[b]).sub(v(points[0])).normalize(), z = x.clone().cross(v(points[c]).sub(v(points[0]))).normalize()
      return [x, z.clone().cross(x).normalize(), z]
    }
    let airborneInterruption = false
    for (let i = 1; i < rows.length; i++) {
      const before = rows[i - 1], after = rows[i], p = before.feet[side], f = after.feet[side], dt = after.t - before.t
      const materialDeltaM = Math.max(...f.sole.map((point, n) => distance(point, p.sole[n])))
      const x = basis(p.sole), y = basis(f.sole), orientationRad = Math.acos(Math.max(-1, Math.min(1, (x.reduce((n, axis, j) => n + axis.dot(y[j]), 0) - 1) / 2)))
      const inputs = inputEvents.filter(e => e.t > before.t && e.t <= after.t)
      const phaseEdge = p.stance !== f.stance || p.cycle !== f.cycle
      const planEdge = p.segmentStart !== f.segmentStart || JSON.stringify(p.plannedLanding) !== JSON.stringify(f.plannedLanding) || p.plannedYaw !== f.plannedYaw
      if (p.stance === false && (planEdge || inputs.length)) airborneInterruption = true
      const rootDeltaM = distance(after.root, before.root), rootYawDeltaRad = after.yaw - before.yaw
      const transition = phaseEdge || planEdge || inputs.length > 0 || rootDeltaM < 1e-9 || airborneInterruption
      // These are transition guards, not a nominal swing-speed budget: unchanged quintic easing plus root turn
      // can legitimately exceed 4m/s in the middle. Every adjacent metric remains recorded; near-zero-dt tests
      // independently cover that middle motion. Never discount a release, phase edge or landing rebase.
      const exceedsDiagnosticSpeed = materialDeltaM > 4 * dt + .001 || orientationRad > 8 * dt + Math.PI / 180
      const failed = dt <= 0 || transition && exceedsDiagnosticSpeed
      const sample = { side, row: i, t: after.t, dt, materialDeltaM, orientationRad, rootDeltaM, rootYawDeltaRad, phaseEdge, planEdge, airborneInterruption, planMetadataAvailable: p.segmentStart != null && f.segmentStart != null, transition, exceedsDiagnosticSpeed, beforePhase: p.gaitPhase ?? null, afterPhase: f.gaitPhase ?? null, beforeStance: p.stance, afterStance: f.stance, inputs, failed }
      samples.push(sample)
      if (failed) failures.push(sample)
      if (f.stance !== false) airborneInterruption = false
    }
  }
  return { criterion: 'At every input/phase/plan edge, stationary translation (including pure yaw), and an interruption beginning with the previous foot airborne through touchdown: material displacement <= 4m/s * dt + 1mm; rigid orientation <= 8rad/s * dt + 1deg. Ordinary middle-swing speed remains recorded separately.', samples, failures, ordinarySwingExceedances: samples.filter(s => !s.transition && s.exceedsDiagnosticSpeed), maxMaterialDeltaM: Math.max(0, ...samples.map(s => s.materialDeltaM)), maxOrientationRad: Math.max(0, ...samples.map(s => s.orientationRad)), transitions: samples.filter(s => s.transition) }
}

export async function softProof(browser, origin, directory) {
  const results = []
  for (const [size, width, height] of [['desktop', 1440, 900], ['phone', 390, 844]]) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: size === 'phone', hasTouch: size === 'phone', deviceScaleFactor: 1, ignoreHTTPSErrors: true })
    try {
      const page = await context.newPage()
      const requests = []
      const errors = []
      page.on('request', request => { if (/\/(cairn|rill|hush)-.*\.glb/.test(request.url())) requests.push(new URL(request.url()).pathname) })
      page.on('pageerror', error => errors.push(error.message))
      page.on('console', message => { if (message.type() === 'error' && /shader|WebGL|THREE/i.test(message.text())) errors.push(message.text()) })
      await page.goto(`${origin}/sim/humanoid/?test=humanoid`)
      await page.waitForFunction(() => window.__humanoid?.actors.every(a => a.rig.root.userData.lods === 2))
      if ((await page.locator('#robot-choice option').allTextContents()).join(',') !== 'Keel,Morrow') throw new Error('Default roster exposes preview robots')
      await page.evaluate(() => window.__humanoid.changeRobot(0, 'cairn', 0))
      if (!await page.evaluate(() => window.__humanoid.actors[0].rig.profile.id === 'keel-v1')) throw new Error('Default seat can select a hidden preview robot')
      await page.screenshot({ path: join(directory, `${size}-default-roster.png`) })
      await page.goto(`${origin}/sim/humanoid/?test=humanoid&preview=soft`)
      await page.waitForFunction(() => window.__humanoid?.actors.every(a => a.rig.root.userData.lods === 2))
      await page.goto(`${origin}/sim/humanoid/?test=humanoid`)
      await page.waitForFunction(() => window.__humanoid?.actors.every(a => a.rig.root.userData.lods === 2))
      if (await page.locator('meta[name="robots"]').getAttribute('content') !== 'noindex, follow') throw new Error('Preview is indexable')
      const pair = page.locator('.obpal-chip .pill')
      if (await pair.count()) { await pair.focus(); await pair.press('Escape'); await pair.evaluate(button => button.blur()); await page.mouse.move(2, 2) }
      if (requests.length) throw new Error('Unselected soft robots were downloaded')
      const panel = page.locator('.sim-window[data-panel="controls"]')
      const toggle = page.locator('[data-panel-toggle="controls"]')
      if (!await panel.isVisible()) { await toggle.focus(); await toggle.click() }
      if ((await page.locator('#robot-choice option').allTextContents()).join(',') !== 'Keel,Morrow,Cairn,Rill,Hush') throw new Error('Roster mismatch')
      for (const id of ['cairn', 'rill', 'hush']) {
        await page.locator('[data-seat="0"]').click()
        await page.getByRole('combobox', { name: 'Robot for this seat', exact: true }).click()
        await page.getByRole('option', { name: id[0].toUpperCase()+id.slice(1), exact: true }).click()
        await page.waitForFunction(id => window.__humanoid.actors[0].rig.profile.model === `${id}-i` && window.__humanoid.actors[0].rig.root.userData.lods === 2, id)
        await page.locator('[data-form="1"]').click()
        await page.waitForFunction(id => window.__humanoid.actors[0].rig.profile.model === `${id}-ii` && window.__humanoid.actors[0].rig.root.userData.lods === 2, id)
        const pressed = await page.locator('[data-form="1"]').getAttribute('aria-pressed')
        if (pressed !== 'true') throw new Error('Form choice is not exposed accessibly')
        const copy = await panel.innerText()
        if (/female|male|gender/i.test(copy)) throw new Error('Gender label exposed in controls')
        await page.screenshot({ path: join(directory, `${size}-${id}-form-controls.png`) })
        await page.evaluate(id => { window.__humanoid.changeRobot(0, id, 0); window.__humanoid.changeRobot(1, id, 1) }, id)
        await page.waitForFunction(id => window.__humanoid.actors.every((a, i) => a.rig.profile.model === `${id}-${i ? 'ii' : 'i'}` && a.rig.root.userData.lods === 2), id)
        if (await panel.isVisible()) await panel.getByRole('button', { name: 'Close Controls', exact: true }).click()
        await page.locator('[data-panel-toggle="controls"]').evaluate(button => button.blur())
        await page.mouse.move(width - 3, 3)
        await page.waitForTimeout(300)
        await page.evaluate(() => {
          const h = window.__humanoid, stage = h.inspect()
          const V = stage.camera.position.constructor
          h.actors.forEach((a, i) => {
            a.rig.pose({ 'left.arm.roll': .09, 'right.arm.roll': .09 }, new V(i ? .47 : -.47, 0, 0), i ? .12 : -.12)
            a.rig.grip({ left: 0, right: 0 })
            a.rig.face(0, false, true)
          })
          stage.controls.target.set(0, .88, 0)
          stage.camera.position.set(2.2, 1.8, innerWidth < innerHeight ? -6 : -4.0)
          stage.camera.clearViewOffset()
          stage.controls.update()
          h.actors.forEach(a => a.rig.detail(stage.camera.position))
          window.softStage = stage
        })
        await page.waitForTimeout(400)
        await page.screenshot({ path: join(directory, `${size}-${id}-forms-arena.png`) })
        const proof = await page.evaluate(() => {
          const stage = window.softStage, a = window.__humanoid.actors[0]
          const frozen = () => ({ blink: a.rig.faceLight.uniforms.blink.value, x: a.rig.faceLight.uniforms.glance.value.x, glow: a.rig.faceLight.uniforms.glow.value })
          a.rig.face(5.7, true, false)
          const blink = frozen()
          a.rig.face(123, true, true)
          const reduced = frozen()
          a.rig.face(456, true, true)
          const reducedAgain = frozen()
          a.rig.face(0, false, true)
          const covers = new Map()
          a.rig.root.traverse(mesh => { if (mesh.isMesh && mesh.material.name.endsWith('Cover')) covers.set(mesh.material.name, { physical: !!mesh.material.isMeshPhysicalMaterial, roughness: mesh.material.roughness, clearcoat: mesh.material.clearcoat ?? 0 }) })
          return { blink, reduced, reducedAgain, covers: [...covers.values()], memory: stage.renderer.info.memory, gfx: stage.view.gfx(), models: window.__humanoid.actors.map(a => a.rig.profile.model) }
        })
        if (proof.blink.blink >= 1 || JSON.stringify(proof.reduced) !== JSON.stringify(proof.reducedAgain) || proof.reduced.x !== 0) throw new Error('Face animation/reduced-motion mismatch')
        if (!proof.covers.length || proof.covers.some(cover => cover.physical !== (size === 'desktop') || cover.roughness < .8 || cover.clearcoat !== 0)) throw new Error('Wrong soft material tier')
        // Two rigs each retain hero and distant geometry, up to 51 batches per LOD,
        // plus the arena and stage. A third cached pair would exceed this bound.
        if (proof.gfx.calls > 120 || proof.gfx.triangles > 65000 || proof.memory.geometries > 230) throw new Error(`Soft scene budget or resource leak: ${JSON.stringify(proof)}`)
        results.push({ size, id, ...proof })
        for (const form of [0, 1]) {
          await page.evaluate(form => {
            const h = window.__humanoid, stage = window.softStage, V = stage.camera.position.constructor
            h.actors.forEach((a, i) => { a.rig.root.visible = i === form; a.rig.pose({ 'left.arm.roll': .09, 'right.arm.roll': .09 }, new V(), 0) })
            stage.controls.target.set(0, .88, 0)
            stage.camera.position.set(1.3, 1.3, -3.3)
            stage.camera.fov = 36
            stage.camera.updateProjectionMatrix()
            stage.controls.update()
            h.actors.forEach(a => a.rig.detail(stage.camera.position))
          }, form)
          await page.waitForTimeout(180)
          await page.screenshot({ path: join(directory, `${size}-${id}-${form ? 'ii' : 'i'}-arena.png`) })
        }
        if (!await panel.isVisible()) { await toggle.focus(); await toggle.click() }
      }
      await page.evaluate(() => { window.__humanoid.actors.forEach(a => a.control.stop()); window.__humanoid.changeRobot(0, 'cairn', 1) })
      await page.waitForFunction(() => window.__humanoid.actors[0].rig.root.userData.lods === 2)
      if (!await page.evaluate(() => window.__humanoid.actors[0].control.stopped)) throw new Error('Changing robot cleared Stop')
      if (errors.length) throw new Error(errors.join('\n'))
      if (requests.filter(url => url.endsWith('cairn-ii.glb')).length < 2) throw new Error('Unused soft geometry was retained instead of released')
    } finally { await context.close() }
  }
  const late = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true })
  try {
    const page = await late.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/models/cairn-i.glb', async route => { await new Promise(resolve => setTimeout(resolve, 1800)); await route.continue().catch(() => {}) })
    await page.goto(`${origin}/sim/humanoid/?test=humanoid&preview=soft`)
    await page.waitForFunction(() => window.__humanoid?.actors.every(a => a.rig.root.userData.lods === 2))
    await page.evaluate(() => { window.__humanoid.changeRobot(0, 'cairn', 0); window.__humanoid.changeRobot(0, 'rill', 1) })
    await page.waitForFunction(() => window.__humanoid.actors[0].rig.root.userData.lods === 2)
    await page.waitForTimeout(2200)
    if (!await page.evaluate(() => window.__humanoid.actors[0].rig.profile.model === 'rill-ii' && window.__humanoid.actors[0].rig.root.userData.prototype === 'blender') || errors.length) throw new Error(`Late old skin corrupted the replacement: ${errors.join('; ')}`)
    results.push({ lateSwap: 'A cancelled Cairn download cannot install into the replacement Rill rig' })
  } finally { await late.close() }
  await writeFile(join(directory, 'soft-roster-proof.json'), JSON.stringify(results, null, 2))
  if (process.env.OBPAL_CAIRN_PILOT === '1') await cairnPilot(browser, origin)
  return 'Default roster excludes previews; session-only opt-in, six forms, phone/desktop tiers, deterministic faces, Stop preservation and bounded resource swaps'
}

/** Matched pilot evidence. Scripted poses and classical visual walking are separate from physics. */
async function cairnPilot(browser, origin) {
  const out = join(process.env.OBPAL_E2E_EVIDENCE_ROOT, 'cairn-pilot'), raw = rawRun(out)
  const frames = [], report = { source: process.env.OBPAL_PILOT_SOURCE, baselineAssets: !!process.env.OBPAL_CAIRN_BASELINE_DIRECTORY, status: 'running', scenarios: [], physicalWalk: { status: 'unsupported', pass: false, reason: 'The physical walking demo accepts Keel and Morrow only; no Cairn physical gait is certified here.' } }
  const capture = async (page, name) => { const folder = join(raw, name); await mkdir(folder, { recursive: true }); await page.screenshot({ path: join(folder, 'frame.png') }); frames.push({ path: `${name}/frame.png`, capturedAt: new Date().toISOString(), failed: false }) }
  const baseline = async context => {
    if (process.env.OBPAL_CAIRN_BASELINE_DIRECTORY) for (const name of ['cairn-i', 'cairn-i-lod']) {
      const body = await readFile(join(process.env.OBPAL_CAIRN_BASELINE_DIRECTORY, `${name}.glb`))
      await context.route(`**/models/${name}.glb`, route => route.fulfill({ contentType: 'model/gltf-binary', body }))
    }
  }
  try {
    for (const [size, width, height] of [['desktop', 1440, 900], ['phone', 390, 844]]) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: size === 'phone', hasTouch: size === 'phone', ignoreHTTPSErrors: true })
      try {
        await prepareSmoothness(context)
        await baseline(context)
        const page = await context.newPage(), errors = []
        page.on('pageerror', error => errors.push(error.message))
        await page.goto(`${origin}/sim/humanoid/?test=humanoid&preview=soft`)
        await page.waitForFunction(() => window.__humanoid?.actors.every(a => a.rig.root.userData.lods === 2))
        await page.evaluate(() => window.__humanoid.changeRobot(0, 'cairn', 0))
        await page.waitForFunction(() => window.__humanoid.actors[0].rig.profile.model === 'cairn-i' && window.__humanoid.actors[0].rig.root.userData.lods === 2)
        const panel = page.locator('.sim-window[data-panel="controls"]')
        if (await panel.isVisible()) await panel.getByRole('button', { name: 'Close Controls', exact: true }).click()
        const pair = page.locator('.obpal-chip .pill')
        await pair.focus(); await pair.press('Escape'); await pair.evaluate(button => button.blur())
        await page.mouse.move(width - 3, 3)
        await page.evaluate(() => window.__humanoid.view([3.3, 1.5, -3.3], [0, .85, 0]))
        await page.waitForTimeout(500)
        // Record live pivot rotations before inspect(), which intentionally freezes practice stepping.
        await page.evaluate(() => {
          const h = window.__humanoid, start = performance.now(), rows = [], camera = h.camera
          const position = camera.position.clone(), rotation = camera.quaternion.clone(), update = camera.updateMatrixWorld.bind(camera)
          // Hold only the proof camera. Native source arbitration, practice stepping
          // and actual pivot/root motion keep running; inspect() has not been called.
          camera.updateMatrixWorld = function(force) { this.position.copy(position); this.quaternion.copy(rotation); update(force) }
          window.pilotLive = { start, rows, restoreCamera: () => { camera.updateMatrixWorld = update }, timer: setInterval(() => {
            const a = h.actors[0], V = a.rig.root.position.constructor
            a.rig.root.updateMatrixWorld(true)
            rows.push({ t: (performance.now() - start) / 1000, q: { ...a.control.q }, root: a.rig.root.position.toArray(), rootRotation: a.rig.root.quaternion.toArray(), yaw: a.control.yaw, camera: { position: camera.position.toArray(), rotation: camera.quaternion.toArray() },
              joints: [...a.rig.pivots].map(([id, p]) => ({ id, local: p.quaternion.toArray(), world: p.getWorldPosition(new V()).toArray() })) })
          }, 100) }
        })
        // Walk away from the second actor. Walking through it produces real
        // occlusion, which the retained first trial exposed rather than hiding.
        const keys = [null, 's', null, 'q', 'w', 'e', '6', null, null, null], begun = Date.now()
        for (let second = 0; second < 10; second++) {
          if (keys[second]) await page.keyboard.down(keys[second])
          if ([0, 2, 3, 5, 6, 8, 9].includes(second)) await capture(page, `${size}-live-${second}s`)
          await page.waitForTimeout(Math.max(0, begun + (second + 1) * 1000 - Date.now()))
          if (keys[second]) await page.keyboard.up(keys[second])
        }
        const live = await page.evaluate(() => { clearInterval(window.pilotLive.timer); return window.pilotLive.rows })
        const motion = cairnMotion(live)
        report.scenarios.push({ size, mode: 'native keyboard practice; fixed proof camera; visual gait, no physical ground/contact solver', seconds: 10, motion, live })
        await writeFile(join(out, 'pilot.json'), JSON.stringify(report, null, 2))
        if (live.length < 90 || live.at(-1).t < 9.8 || motion.legRad < .15 || motion.armRad < .4 || motion.cameraDelta > .000001 || !live.some(r => Math.abs(r.yaw) > .5)) throw new Error(`Cairn ${size}: live articulation or fixed camera failed`)
        await page.evaluate(() => { const h = window.__humanoid; window.pilotStage = h.inspect(); h.actors[1].rig.root.visible = true })
        for (const second of [2, 3, 6, 8]) {
          const row = live.reduce((a, b) => Math.abs(a.t - second) < Math.abs(b.t - second) ? a : b)
          await page.evaluate(row => { const a = window.__humanoid.actors[0]; a.rig.root.position.fromArray(row.root); a.rig.root.quaternion.fromArray(row.rootRotation); row.joints.forEach(j => a.rig.pivots.get(j.id).quaternion.fromArray(j.local)); a.rig.root.updateMatrixWorld(true) }, row)
          await page.waitForTimeout(100)
          const pixels = await page.evaluate(cairnTags)
          report.scenarios.push({ size, phase: `${second}s`, mode: 'replay of recorded native root and local pivot transforms; depth occluders retained', pixels })
          await capture(page, `${size}-live-replay-${second}s`)
          await writeFile(join(out, 'pilot.json'), JSON.stringify(report, null, 2))
          if (Object.values(pixels.parts).some(n => n === 0) || !pixels.restored) throw new Error(`Cairn ${size}: live replay ${second}s visibility ${JSON.stringify(pixels)}`)
        }
        const phases = [
          ['rest', {}],
          ['bend-reach', { 'spine.pitch': -.21, 'head.pitch': .35, 'left.arm.pitch': -.61, 'right.arm.pitch': -.61, 'left.arm.elbow': 1.05, 'right.arm.elbow': 1.05 }],
          ['stride', { 'left.leg.pitch': -.31, 'right.leg.pitch': .31, 'left.leg.knee': -.44, 'right.leg.knee': -.09, 'left.arm.pitch': .26, 'right.arm.pitch': -.26 }],
        ]
        for (const [phase, q] of phases) {
          await page.evaluate(q => { const a = window.__humanoid.actors[0], V = a.rig.root.position.constructor; a.rig.pose(q, new V(-.45, 0, 0), 0); a.rig.grip({ left: 0, right: 0 }); a.rig.face(0, false, true) }, q)
          await page.waitForTimeout(180)
          await capture(page, `${size}-scripted-${phase}`)
          const pixels = await page.evaluate(cairnTags)
          report.scenarios.push({ size, phase, mode: 'fixed authored visual pose; no root or ground motion', q, pixels })
          await writeFile(join(out, 'pilot.json'), JSON.stringify(report, null, 2))
          if (Object.values(pixels.parts).some(n => n === 0) || !pixels.restored) throw new Error(`Cairn ${size} ${phase}: missing part pixels or unrestored tag pass ${JSON.stringify(pixels)}`)
        }
        await page.evaluate(q => {
          const a = window.__humanoid.actors[0], V = a.rig.root.position.constructor, start = performance.now(), rows = []
          window.pilotBend = { start, rows }
          function frame() {
            const t = Math.min(10, (performance.now() - start) / 1000), weight = Math.sin(Math.PI * t / 10)
            a.rig.pose(Object.fromEntries(Object.entries(q).map(([id, value]) => [id, value * weight])), new V(-.45, 0, 0), 0)
            if (!rows.length || t - rows.at(-1).t >= .1 || t === 10) rows.push({ t, root: a.rig.root.position.toArray(), joints: [...a.rig.pivots].map(([id,p]) => ({ id, local: p.quaternion.toArray() })) })
            if (t < 10) requestAnimationFrame(frame)
          }
          requestAnimationFrame(frame)
        }, phases[1][1])
        const bendStart = Date.now()
        for (const ms of [0, 2500, 5000, 7500, 10000]) { await page.waitForTimeout(Math.max(0, bendStart + ms - Date.now())); await capture(page, `${size}-scripted-bend-${ms}ms`) }
        const bend = await page.evaluate(() => window.pilotBend.rows)
        report.scenarios.push({ size, mode: 'ten-second authored bend/reach/head nod; fixed root, actual rendered pivot rotations; no physical actuation', bend })
        if (bend.at(-1).t < 9.9 || Math.max(...bend.map(r => Math.abs(r.joints.find(j => j.id === 'spine.pitch').local[0]))) < .09) throw new Error(`Cairn ${size}: scripted bend did not render`)
        const lod = await page.evaluate(() => {
          const a = window.__humanoid.actors[0], V = a.rig.root.position.constructor, stamp = () => ({ joints: [...a.rig.pivots].map(([id, p]) => [id, p.position.toArray(), p.quaternion.toArray()]), root: a.rig.root.matrix.toArray(), materials: [...new Set((() => { const m=[]; a.rig.root.traverse(o => { if(o.isMesh) m.push(o.material.name) }); return m })())].sort(), memory: window.pilotStage.renderer.info.memory.geometries }), before = stamp(), levels = []
          for (let n = 0; n < 12; n++) { a.rig.detail(a.rig.root.position.clone().add(new V(0, 0, n % 2 ? 3 : 20))); levels.push(a.rig.root.userData.lod) }
          return { levels, before, after: stamp(), unchanged: JSON.stringify(before) === JSON.stringify(stamp()) }
        })
        report.scenarios.push({ size, lod, errors })
        if (!lod.unchanged || lod.levels.some((v, n) => v !== (n % 2 ? 0 : 1)) || errors.length) throw new Error(`Cairn ${size}: LOD graph or browser errors`)
        await page.evaluate(() => window.pilotLive.restoreCamera())
      } finally { await context.close() }
    }
    for (const mode of ['cold', 'warm', 'failed', 'late']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true })
      try {
        await baseline(context)
        if (mode !== 'warm') await context.route(/\/models\/cairn-i(?:-lod)?\.glb$/, async route => {
          if (mode === 'failed') return route.abort()
          await new Promise(resolve => setTimeout(resolve, mode === 'late' ? 6500 : 1300))
          await route.fallback().catch(() => {})
        })
        const page = await context.newPage(), requests = [], states = [], errors = []
        page.on('pageerror', e => errors.push(e.message))
        page.on('console', m => { if (m.type() === 'error' && /shader|WebGL|THREE/i.test(m.text())) errors.push(m.text()) })
        page.on('request', r => { if (/\/models\/cairn-i(?:-lod)?\.glb$/.test(r.url())) requests.push(new URL(r.url()).pathname) })
        const select = async () => {
          await page.goto(`${origin}/sim/humanoid/?test=humanoid&preview=soft`); await page.waitForFunction(() => !!window.__humanoid)
          await page.evaluate(() => {
            window.__humanoid.changeRobot(0, 'cairn', 0)
            const start = performance.now(); window.pilotLoad = { active: true, rows: [] }
            function frame() { const a=window.__humanoid.actors[0]; window.pilotLoad.rows.push({ t:(performance.now()-start)/1000, model:a.rig.profile.model, visible:a.rig.root.visible, prototype:a.rig.root.userData.prototype, lods:a.rig.root.userData.lods }); if(window.pilotLoad.active) requestAnimationFrame(frame) }
            requestAnimationFrame(frame)
          })
        }
        await select()
        if (mode === 'warm') { await page.waitForFunction(() => window.__humanoid.actors[0].rig.root.userData.lods === 2); await select() }
        await page.waitForFunction(() => window.__humanoid.actors[0].rig.root.visible)
        states.push(await page.evaluate(() => ({ visible: window.__humanoid.actors[0].rig.root.visible, ...window.__humanoid.actors[0].rig.root.userData })))
        if (mode === 'failed' || mode === 'late') {
          await page.waitForFunction(() => window.__humanoid.actors[0].rig.root.userData.prototype === 'procedural')
          await page.evaluate(() => window.__humanoid.actors[0].control.play('wave'))
          await page.waitForTimeout(300)
          const a = await page.evaluate(() => { const a=window.__humanoid.actors[0]; a.control.stop(); return { root:a.rig.root.position.toArray(), joints:[...a.rig.pivots].map(([id,p])=>[id,p.quaternion.toArray()]) } })
          if (!a.joints.some(([,q]) => Math.abs(q[0])+Math.abs(q[1])+Math.abs(q[2]) > .2)) throw new Error(`Cairn ${mode}: preservation pose stayed neutral`)
          if (mode === 'late') { await page.waitForFunction(() => window.__humanoid.actors[0].rig.root.userData.lods === 2, null, { timeout: 22000 }); const b=await page.evaluate(() => { const a=window.__humanoid.actors[0]; return { root:a.rig.root.position.toArray(), joints:[...a.rig.pivots].map(([id,p])=>[id,p.quaternion.toArray()]) } }); if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error('Late Cairn load changed stopped pose') }
        } else await page.waitForFunction(() => window.__humanoid.actors[0].rig.root.userData.lods === 2)
        states.push(await page.evaluate(() => ({ visible: window.__humanoid.actors[0].rig.root.visible, ...window.__humanoid.actors[0].rig.root.userData })))
        const trail = await page.evaluate(() => { window.pilotLoad.active=false; return window.pilotLoad.rows })
        const resources = await page.evaluate(() => performance.getEntriesByType('resource').filter(r => /cairn-i(?:-lod)?\.glb$/.test(r.name)).map(r => ({ path:new URL(r.name).pathname, transferSize:r.transferSize, encodedBodySize:r.encodedBodySize, decodedBodySize:r.decodedBodySize })))
        report.scenarios.push({ mode, scope: mode === 'warm' && process.env.OBPAL_CAIRN_BASELINE_DIRECTORY ? 'Same-context reload/decode; baseline fulfilment disables browser HTTP cache' : 'Native asset load with measured resource entries; no inferred cache hit', requests, states, trail, resources, errors }); await capture(page, `load-${mode}`)
        if (states.at(-1).prototype !== (mode === 'failed' ? 'procedural' : 'blender')) throw new Error(`Cairn ${mode} final reveal mismatch`)
        if (errors.length || (mode === 'cold' && trail.some(r => r.visible && r.prototype === 'procedural'))) throw new Error(`Cairn ${mode}: visible procedural flash or browser error`)
      } finally { await context.close() }
    }
    report.status = 'pass'
  } catch (error) { report.status = 'fail'; report.error = error.message; if(frames.length) frames.at(-1).failed=true; throw error }
  finally {
    await writeFile(join(out, 'pilot.json'), JSON.stringify(report, null, 2))
    await writeFile(join(out, 'evidence-frames.json'), JSON.stringify({ expectedCount: 42, frames, note: 'Fixed scripted poses and actual native-motion replay are separately labelled; images are browser emulation, not physical devices.' }, null, 2))
  }
}

/** Actual rendered quaternion changes; exported so recorder edits can replay retained traces without a browser. */
export function cairnMotion(rows) {
  const angle = id => Math.max(...rows.map(r => { const a=rows[0].joints.find(j=>j.id===id).local, b=r.joints.find(j=>j.id===id).local; return 2*Math.acos(Math.min(1, Math.abs(a.reduce((s,v,n)=>s+v*b[n],0)))) }))
  const cameraDelta = rows[0].camera ? Math.max(...rows.map(r => Math.max(...[...r.camera.position,...r.camera.rotation].map((v,n)=>Math.abs(v-[...rows[0].camera.position,...rows[0].camera.rotation][n]))))) : null
  return { legRad: angle('left.leg.pitch'), armRad: angle('left.arm.pitch'), cameraDelta }
}

/** Depth-tested, unlit part tags on the actual suit weights; black geometry remains an occluder. */
async function cairnTags() {
  const T = await import('/__smoothness_three.js'), stage = window.pilotStage, rig = window.__humanoid.actors[0].rig
  const names = ['head', 'torso', 'left-hand', 'right-hand', 'left-knee', 'right-knee', 'left-foot', 'right-foot']
  const colours = names.map((_, i) => [32 + i * 24, 64, 128]), parts = Object.fromEntries(names.map(n => [n, 0]))
  const target = new T.WebGLRenderTarget(512, 512), saved = [], disposable = []
  const { renderer, scene, camera } = stage, oldTarget = renderer.getRenderTarget(), fog = scene.fog, background = scene.background, mapping = renderer.toneMapping
  const id = name => name?.startsWith('head.') ? 0 : name === 'spine.roll' || name === 'pelvis' ? 1 : name?.startsWith('left.arm.wrist') ? 2 : name?.startsWith('right.arm.wrist') ? 3 : name === 'left.leg.ankle.roll' ? 6 : name === 'right.leg.ankle.roll' ? 7 : -1
  try {
    scene.traverse(mesh => {
      if (!mesh.isMesh) return
      saved.push([mesh, mesh.material, mesh.geometry])
      let tag = -1
      for (let p = mesh; p; p = p.parent) if (rig.pivots.get(p.name) === p) { tag = id(p.name); break }
      const material = new T.MeshBasicMaterial({ side: mesh.material.side, toneMapped: false, color: tag < 0 ? 0 : new T.Color().setRGB(...colours[tag].map(v => v / 255)) })
      disposable.push(material); mesh.material = material
      if (!mesh.isSkinnedMesh || !rig.root.getObjectById(mesh.id)) return
      const geometry = mesh.geometry.toNonIndexed(), position = geometry.attributes.position, weights = geometry.attributes.skinWeight, indices = geometry.attributes.skinIndex, colour = new Float32Array(position.count * 3)
      const kneeY = side => { let j = rig.profile.joints.find(j => j.id === `${side}.leg.knee`), y = 0; while (j) { y += j.offset[1]; j = rig.profile.joints.find(p => p.id === j.parent) } return y }
      for (let n = 0; n < position.count; n += 3) {
        const sums = new Map()
        for (let v = n; v < n + 3; v++) for (let k = 0; k < 4; k++) { const b = indices.getComponent(v, k); sums.set(b, (sums.get(b) ?? 0) + weights.getComponent(v, k)) }
        const owner = [...sums].sort((a, b) => b[1] - a[1])[0][0], bone = mesh.skeleton.bones[owner].name, y = (position.getY(n) + position.getY(n + 1) + position.getY(n + 2)) / 3
        let label = id(bone)
        for (const [side, index] of [['left', 4], ['right', 5]]) if (bone.startsWith(`${side}.leg.`) && Math.abs(y - kneeY(side)) < .065) label = index
        for (let v = n; v < n + 3; v++) if (label >= 0) colour.set(colours[label].map(v => v / 255), v * 3)
      }
      geometry.setAttribute('color', new T.BufferAttribute(colour, 3)); mesh.geometry = geometry; disposable.push(geometry)
      material.vertexColors = true; material.color.setRGB(1, 1, 1)
    })
    scene.fog = null; scene.background = new T.Color(0); renderer.toneMapping = T.NoToneMapping
    renderer.setRenderTarget(target); renderer.render(scene, camera)
    const data = new Uint8Array(512 * 512 * 4); renderer.readRenderTargetPixels(target, 0, 0, 512, 512, data)
    for (let p = 0; p < data.length; p += 4) for (let i = 0; i < colours.length; i++) if (colours[i].every((v, k) => Math.abs(v - data[p + k]) <= 1)) parts[names[i]]++
  } finally {
    for (const [mesh, material, geometry] of saved) { mesh.material = material; mesh.geometry = geometry }
    scene.fog = fog; scene.background = background; renderer.toneMapping = mapping; renderer.setRenderTarget(oldTarget)
    disposable.forEach(o => o.dispose()); target.dispose()
  }
  return { parts, restored: saved.every(([mesh, material, geometry]) => mesh.material === material && mesh.geometry === geometry), scope: 'Depth-tested tagged triangles; suit owner is greatest summed skin weight, knee band ±65mm around rest pivot; 512px target, 1-channel-value edge tolerance.' }
}
