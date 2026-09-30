/** Source-labelled motion plots and a two-actor CPU workload. Writes only to a fresh temporary folder. No browser or hardware. */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createServer } from 'vite'
import { Quaternion, Vector3 } from 'three'

const output = await mkdtemp(join(tmpdir(), 'obpal-continuum-proof-'))
// Load modules directly, without HTTP/HMR listeners or a repository cache.
const vite = await createServer({ configFile: false, cacheDir: join(output, 'vite-cache'), optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: 'custom' })
try {
  const { COVE, radiusAt } = await vite.ssrLoadModule('/src/sim/continuum/profile.ts'),
    { ArmKinematics } = await vite.ssrLoadModule('/src/sim/continuum/kinematics.ts'),
    { ArmTendons, ContinuumClock } = await vite.ssrLoadModule('/src/sim/continuum/tendons.ts'),
    { BendDynamics, REFERENCE_BEND, ReachPrimitive, JetMantle, REFERENCE_JET, stiffening, fetchSegments, recruitCrawl } = await vite.ssrLoadModule('/src/sim/continuum/primitives.ts'),
    { Sucker, ContactSurface, SupportSolver } = await vite.ssrLoadModule('/src/sim/continuum/contact.ts'),
    { stepBody } = await vite.ssrLoadModule('/src/sim/continuum/medium.ts')
  const sourceLinks = {
    'reach-velocity': 'https://pmc.ncbi.nlm.nih.gov/articles/PMC6793066/',
    'reach-stiffening': 'https://pmc.ncbi.nlm.nih.gov/articles/PMC6793066/',
    'fetch-ratio': 'https://doi.org/10.1016/j.cub.2006.02.069',
    'crawl-recruitment': 'https://pubmed.ncbi.nlm.nih.gov/25891406/',
    'jet-cycle': 'https://journals.sagepub.com/doi/10.5772/60143',
    'sucker-seal-peel': 'https://pmc.ncbi.nlm.nih.gov/articles/PMC3672162/',
    'hydrostat-volume': 'https://pmc.ncbi.nlm.nih.gov/articles/PMC6793066/',
  }
  const plots = [], raw = {},
    escape = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')

  async function plot(id, title, axis, data, note, bands = []) {
    const w = 860, h = 390, left = 70, top = 55, width = 745, height = 245,
      { xmin = 0, xmax = 1, ymin = 0, ymax = 1 } = axis,
      x = (v) => left + ((v - xmin) / (xmax - xmin)) * width,
      y = (v) => top + height - ((v - ymin) / (ymax - ymin)) * height,
      colors = ['#ccff6b', '#79b8eb', '#f2bd79'],
      pieces = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#11151a"/><g font-family="sans-serif" fill="#e4e8eb"><text x="${left}" y="30" font-size="18">${escape(title)}</text>`]
    for (const band of bands) pieces.push(`<rect x="${x(band[0])}" y="${top}" width="${x(band[1]) - x(band[0])}" height="${height}" fill="#aab9c7" opacity=".13"/>`)
    for (let i = 0; i <= 5; i++) {
      const vx = xmin + ((xmax - xmin) * i) / 5,
        vy = ymin + ((ymax - ymin) * i) / 5
      pieces.push(`<path d="M ${x(vx)} ${top} V ${top + height} M ${left} ${y(vy)} H ${left + width}" stroke="#34404c" stroke-width=".6"/><text x="${x(vx)}" y="${top + height + 20}" text-anchor="middle" font-size="12">${Number(vx.toFixed(3))}</text><text x="${left - 9}" y="${y(vy) + 4}" text-anchor="end" font-size="12">${Number(vy.toFixed(3))}</text>`)
    }
    data.forEach((series, i) => {
      const d = series.points.map(([vx, vy], n) => `${n ? 'L' : 'M'}${x(vx).toFixed(2)} ${y(vy).toFixed(2)}`).join(' ')
      pieces.push(`<path d="${d}" fill="none" stroke="${colors[i]}" stroke-width="${i ? 1.5 : 2.5}" ${series.reference ? 'stroke-dasharray="6 5"' : ''}/><text x="${left + i * 260}" y="${h - 15}" font-size="12" fill="${colors[i]}">${escape(series.name)}</text>`)
    })
    pieces.push(`<text x="${left + width / 2}" y="${top + height + 42}" text-anchor="middle" font-size="12">${escape(axis.x)}</text><text x="${left}" y="${top - 9}" font-size="12">${escape(axis.y)}</text></g></svg>`)
    await writeFile(join(output, `${id}.svg`), pieces.join(''))
    plots.push({ id, title, note })
    raw[id] = { source: sourceLinks[id], axis, data, note, bands }
  }

  const reach = new ReachPrimitive(COVE.arms[0]), strip = [],
    tendons = new ArmTendons(COVE, COVE.arms[0]), fk = new ArmKinematics(COVE.arms[0])
  for (let i = 0; i < 144; i++) {
    tendons.step(reach.step(1 / 120), 1 / 120, 0, reach.activation)
    if (i % 24 === 0 || i === 143) strip.push({ time: (i + 1) / 120, points: fk.update(tendons.pose).map((f) => f.position.toArray()) })
  }
  const referenceCurve = [], simCurve = [], sourceModel = new BendDynamics(),
    source = REFERENCE_BEND, h = 1 / 4800
  let rx = 0, rv = 0, positionError = 0, velocityError = 0
  const acceleration = (x, v) => {
    const taper = 1 - x / 0.26, mass = 0.025 * taper ** 3, dm = -3 * 0.025 * taper ** 2 / 0.26,
      muscle = x < 0.26 * 0.7 ? 0.108 * taper ** 2 : 0,
      area = Math.PI * 0.0085 * Math.hypot(0.26, 0.0085) * taper ** 2,
      drag = 0.5 * 1000 * 0.313 * area * v * v
    return (muscle - drag - 2 * dm * v * v) / (2 * mass)
  }
  for (let i = 0; i < 480; i++) {
    sourceModel.step(1 / 240)
    for (let n = 0; n < 20; n++) {
      const a = acceleration(rx, rv), b = acceleration(rx + rv * h / 2, rv + a * h / 2),
        c = acceleration(rx + (rv + a * h / 2) * h / 2, rv + b * h / 2),
        d = acceleration(rx + (rv + b * h / 2) * h, rv + c * h)
      rx += h / 6 * (rv + 2 * (rv + a * h / 2) + 2 * (rv + b * h / 2) + rv + c * h)
      rv += h / 6 * (a + 2 * b + 2 * c + d)
    }
    referenceCurve.push([(i + 1) / 240, rv])
    simCurve.push([(i + 1) / 240, sourceModel.velocity])
    positionError = Math.max(positionError, Math.abs(rx - sourceModel.position) / source.length)
    velocityError = Math.max(velocityError, Math.abs(rv - sourceModel.velocity) / 0.47)
  }
  await plot('reach-velocity', 'Reach: velocity from the published force model', { x: 'Time (s)', y: 'Bend velocity (m/s)', xmax: 2, ymax: 0.5 },
    [{ name: 'Sim midpoint / 960 Hz', points: simCurve }, { name: 'Published equations / RK4', reference: true, points: referenceCurve }],
    'Gutfreund 1998 Eq. 1–3 and EA.6/EA.10: cone mass transfer, area-dependent muscle force and Cd=0.313. Terminal force withdrawal at 70% is the paper’s explicitly arbitrary example. Both integrators use our selected initial force 0.108 N; this is not digitized Fig. 10 or an animal-data fit. Acceptance: max position difference <0.5% of reference length; max speed difference <2% of 0.47 m/s. Cove uses normalized material coordinates, not a claim that its mass/drag match the animal.')
  await plot('reach-stiffening', 'Stiffening ahead of the bend', { x: 'Time relative to bend arrival (ms)', y: 'Normalized muscle excitation', xmin: -400, xmax: 200 },
    [{ name: 'Simulation', points: Array.from({ length: 601 }, (_, i) => [i - 400, stiffening((400 - i) / 1000)]) }],
    'Gutfreund 1998: onset 200–300 ms before bend, peak 50–100 ms before bend. Shaded ranges are published timing constraints, not digitized EMG traces. The sim peaks at −75 ms and crosses its declared 1.2% onset threshold near −298 ms. Gaussian width and stiffness gain are sim choices.', [[-300, -200], [-100, -50]])
  await plot('fetch-ratio', 'Fetch: equal elbow segments', { x: 'Material grip position', y: 'Proximal / medial length', xmin: 0.25, xmax: 0.95, ymax: 1.2 },
    [{ name: 'Sim ratio', points: Array.from({ length: 71 }, (_, i) => {
      const grip = 0.25 + i / 100, s = fetchSegments(grip)
      return [grip, s.proximal / s.medial]
    }) }, { name: 'Published qualitative equality', reference: true, points: [[0.25, 1], [0.95, 1]] }],
    'Sumbre 2005/2006: two roughly equal load-bearing segments, elbow relocated by opposing activation waves. Literature nomenclature is proximal/medial plus a distal grasping hand. Exact equality is our reduced model; the source provides no numerical error tolerance used here.')
  const crawling = COVE.arms.map((arm) => ({ id: arm.id, direction: arm.position.clone().normalize(), attached: true, strain: 0, capacity: 10 }))
  await plot('crawl-recruitment', 'Crawl: directional recruitment, no fixed rhythm', { x: 'Travel heading (degrees)', y: 'Recruited pushing arms', xmax: 360, ymax: 8 },
    [{ name: 'Sim contact-dependent selection', points: Array.from({ length: 73 }, (_, i) => {
      const angle = i * Math.PI / 36
      return [i * 5, recruitCrawl(crawling, new Vector3(Math.sin(angle), 0, Math.cos(angle))).length]
    }) }], 'Levy 2015 establishes directional arm recruitment and elongation, with no apparent fixed rhythm. No published arm-count-versus-heading dataset is available here. Capacity, extension thresholds and selection tie-breaking are original sim choices; no walking gait is claimed at this boundary.')
  const jet = new JetMantle(), volumes = [], thrusts = []
  jet.pulse()
  let impulse = 0
  for (let i = 0; i < 150; i++) {
    jet.step(1 / 240)
    volumes.push([i / 150, jet.fraction])
    thrusts.push([i / 150, jet.thrust])
    impulse += jet.thrust / 240
  }
  await plot('jet-cycle', 'Jet: compliant contraction, elastic refill and glide', { x: 'Time / 0.625 s cycle', y: 'Volume / capacity or thrust (N)', ymax: 1.2 },
    [{ name: 'Sim mantle volume', points: volumes }, { name: 'Sim thrust (N)', points: thrusts }],
    'Renda 2015 reports the physical robot at 1.6 Hz and 35 ml. Its model example uses T=1.5 s and Tc=0.5 s (shaded normalized contraction window); our 1/3 duty borrows that ratio. The 35% target expulsion, stiffness, damping and nozzle radius are designer parameters. This is not an animal cycle trace or a reproduced experiment.', [[0, 1 / 3]])
  const floor = new ContactSurface('floor', 'plane', new Vector3(4, 4, 1), 1),
    cup = new Sucker(COVE.arms[0].cups[0], COVE.suction),
    cupInput = { point: new Vector3(0, 0, 0.001), facing: new Vector3(0, 0, -1), velocity: new Vector3(), attach: true },
    adhesion = [], theoretical = COVE.suction.pressure * Math.PI * cup.site.radius ** 2
  for (let i = 0; i < 72; i++) {
    if (i >= 48) { cupInput.attach = false; cupInput.point.z = 0 }
    cup.step(cupInput, [floor], 1 / 120)
    adhesion.push([i / 120, cup.limit])
  }
  await plot('sucker-seal-peel', 'Sucker: pressure × sealed area, then rim peel', { x: 'Time (s)', y: 'Pull-off bound (N)', xmax: 0.6, ymax: theoretical * 1.1 },
    [{ name: 'Sim seal/release', points: adhesion }, { name: 'ΔP × full cup area', reference: true, points: [[0, theoretical], [0.6, theoretical]] }],
    'Tramacere 2013 supports rim sealing and differential-pressure attachment, followed by muscular seal release. The dashed line is the pressure-area law, not measured animal pull-off data. 18 kPa, 120 ms seal, 90 ms peel and 40 ms pressure response are conservative sim design choices; the cited source supplies no universal attach/release timings.')
  await plot('hydrostat-volume', 'Hydrostat: elongation narrows the arm', { x: 'Length / rest length', y: 'Radius / rest radius', xmin: 0.9, xmax: 1.15, ymin: 0.9, ymax: 1.1 },
    [{ name: 'Sim section radius', points: Array.from({ length: 101 }, (_, i) => {
      const e = -0.1 + i * 0.0025
      return [1 + e, radiusAt(COVE.arms[0].sections[0], e) / COVE.arms[0].sections[0].radius]
    }) }, { name: 'Constant-volume law', reference: true, points: Array.from({ length: 101 }, (_, i) => {
      const length = 0.9 + i * 0.0025
      return [length, 1 / Math.sqrt(length)]
    }) }], 'Muscular hydrostat volume conservation is established by the cited biology. The dashed curve is its geometric law, not digitized radius measurements. Our strain range −10…+15% is a robot design envelope.')

  const metrics = {
    boundary: '6.1 continuum foundation only',
    sourceComparison: 'Published force-model reconstruction and reported timing/robot constraints; animal trace fits remain unverified.',
    reachPositionAt1_2s: reach.position, reachEquationPositionErrorFraction: positionError, reachEquationSpeedErrorFraction: velocityError,
    reachEquationWithinTolerance: positionError < 0.005 && velocityError < 0.02,
    jetImpulseNs: impulse, jetMinimumVolume: Math.min(...volumes.map((p) => p[1])),
    jetRefilledVolume: jet.fraction, robotReferenceFrequencyHz: 1 / REFERENCE_JET.period,
    robotReferenceCapacityMl: REFERENCE_JET.capacity * 1e6,
  }
  const inverseArm = new Quaternion().copy(COVE.arms[0].orientation).invert()
  const stripPaths = strip.map((item, i) => {
    const points = item.points.map((point) => {
      const local = new Vector3(...point).sub(COVE.arms[0].position).applyQuaternion(inverseArm)
      return `${30 + i * 170 + local.z * 130},${60 - local.y * 130}`
    }).join(' ')
    return `<polyline points="${points}" stroke="#ccff6b" stroke-width="4" fill="none"/><text x="${35 + i * 170}" y="230" fill="#ced7df" font-family="sans-serif">${item.time.toFixed(2)} s</text>`
  })
  await writeFile(join(output, 'reach-frame-strip.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="1220" height="260"><rect width="1220" height="260" fill="#11151a"/><text x="25" y="30" fill="#e4e8eb" font-family="sans-serif">Foundation FK samples: reach through tendon compliance (not an in-sim screenshot)</text>${stripPaths.join('')}</svg>`)
  await writeFile(join(output, 'profiles.json'), JSON.stringify(raw, null, 2))
  await writeFile(join(output, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Continuum foundation motion evidence</title><style>body{margin:40px auto;padding:0 20px;max-width:980px;background:#11151a;color:#e4e8eb;font:16px/1.6 system-ui}img{width:100%;height:auto}a{color:#ccff6b}p{max-width:80ch}figure{margin:36px 0}figcaption{padding:8px 0}</style><h1>Phase 6.1: continuum foundation</h1><p>These are numerical core plots, not visual model proof. Source constraints, robot reference numbers and simulation choices are labelled. No unavailable biological dataset is invented. See <a href="profiles.json">raw series</a>, <a href="metrics.json">measured metrics</a> and the repository's docs/OCTOPUS.md for primary citations.</p>${plots.map((p) => `<figure><img src="${p.id}.svg" alt="${escape(p.title)}"><figcaption>${escape(p.note)} <a href="${sourceLinks[p.id]}">Primary source</a>.</figcaption></figure>`).join('')}<figure><img src="reach-frame-strip.svg" alt="Seven kinematic reach frames"><figcaption>Numerical bend-plane FK frame strip. Cove renders, actual studio screenshots and a rendered two-actor run follow in phases 6.2–6.3.</figcaption></figure></html>`)

  // A real five-minute core workload measures CPU only. It does not stand in for a rendered phone or GPU budget.
  const actor = () => {
    const arms = COVE.arms.map((arm) => ({ arm, tendons: new ArmTendons(COVE, arm), fk: new ArmKinematics(arm), reach: new ReachPrimitive(arm),
      input: { point: new Vector3(), facing: new Vector3(0, 0, -1), velocity: new Vector3(), attach: true },
      cups: arm.cups.map((site) => new Sucker(site, COVE.suction)) }))
    return { arms, solver: new SupportSolver(arms.flatMap((arm) => arm.cups), COVE.support),
      body: { position: new Vector3(0, -1, 0), velocity: new Vector3(), radius: 0.15, mass: 1, volume: 0.001, airDrag: 0.1, waterDrag: 3 } }
  }
  const actors = [actor(), actor()], clock = new ContinuumClock(),
    waters = [{ id: 'tank', min: new Vector3(-4, -4, -4), max: new Vector3(4, 0, 4), density: 1000 }],
    samples = [], force = new Vector3(), load = new Vector3(0, 9.81, 0), surfaces = [floor],
    duration = process.argv.includes('--quick') ? 2000 : 300000
  let last = performance.now(), start = last, frames = 0, report = start, lostTicks = 0
  while (performance.now() - start < duration) {
    const now = performance.now(), elapsed = (now - last) / 1000, before = performance.now()
    last = now
    clock.advance(elapsed, (dt, time) => {
      for (const actor of actors) {
        for (const arm of actor.arms) {
          if (Math.floor(time / 2) > Math.floor((time - dt) / 2)) arm.reach.reset()
          arm.tendons.step(arm.reach.step(dt), dt, +(time % 8 > 4), arm.reach.activation)
          arm.input.attach = time % 2 < 1.6
          for (const cup of arm.cups) {
            arm.input.point.set(cup.site.fraction - 0.5, cup.site.row * 0.1, 0.001)
            cup.step(arm.input, surfaces, dt, 1)
          }
        }
        stepBody(actor.body, waters, force, dt)
        actor.solver.solve(actor.body.position, load, force)
      }
    })
    if (clock.paused) lostTicks++
    for (const actor of actors) for (const arm of actor.arms) arm.fk.update(arm.tendons.pose)
    if (frames > 60) samples.push(performance.now() - before)
    frames++
    if (now - report > 30000) { console.log(`Core workload ${Math.round((now - start) / 1000)} s; ${frames} presentation frames`); report = now }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, 1000 / 60 - (performance.now() - before))))
  }
  samples.sort((a, b) => a - b)
  metrics.performance = {
    kind: 'Desktop Node CPU core workload; no renderer or phone', durationMs: performance.now() - start, frames, fixedTicks: clock.ticks,
    actors: 2, sections: 64, cups: 256, skinFrames: 208, supportSolvers: 2, pausedFrames: lostTicks,
    workP50Ms: samples[Math.floor(samples.length * 0.5)], workP95Ms: samples[Math.floor(samples.length * 0.95)], workP99Ms: samples[Math.floor(samples.length * 0.99)], workMaxMs: samples.at(-1),
    budgetMs: 2, withinBudget: samples[Math.floor(samples.length * 0.95)] < 2,
    renderedFrameBudget: 'Unverified until playable studio and meshes', phoneFpsThermalLatency: 'Unverified',
  }
  await writeFile(join(output, 'metrics.json'), JSON.stringify(metrics, null, 2))
  console.log(JSON.stringify(metrics, null, 2))
  console.log(`Evidence: ${output}`)
  if (!metrics.performance.withinBudget || !metrics.reachEquationWithinTolerance) process.exitCode = 1
} finally { await vite.close() }
