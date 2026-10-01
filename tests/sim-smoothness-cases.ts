import { assert, readFileSync } from './sim-node.mjs'
import { smoothnessVerdict } from '../scripts/lib/smoothness-report.mjs'
import { SMOOTHNESS_SIMS } from '../scripts/lib/smoothness-catalogue.mjs'

export function smoothnessCases(test: (name: string, run: () => void) => unknown) {
  const good = () => ({ warmupFailure: null, error: null, motion: { frames: 720, motionSeconds: 10.1,
    motionFrames: 600, renderedMotionFrames: 590, p95: 17, p99: 20, maxGap: 25,
    hidden: 0, missingDraws: 0, changedGeometry: 0, nonFinite: 0, rigidMeshes: 21, unsupportedMeshes: 0,
    physics: { supported: true, maxAngle: .8, maxSpeed: 1.4, restJitter: 0, invalidFrames: 0 } } })
  test('smoothness: complete measured proof passes', () => assert.equal(smoothnessVerdict(good()).status, 'pass'))
  test('smoothness: missing data, short captures and unsupported physics cannot pass', () => {
    assert.equal(smoothnessVerdict({}).status, 'incomplete')
    for (const mutation of [
      (r: ReturnType<typeof good>) => { r.motion.motionSeconds = 0 },
      (r: ReturnType<typeof good>) => { r.motion.rigidMeshes = 0 },
      (r: ReturnType<typeof good>) => { r.motion.physics.supported = false },
      (r: ReturnType<typeof good>) => { r.motion.unsupportedMeshes = 1 },
    ]) { const r = good(); mutation(r); assert.notEqual(smoothnessVerdict(r).status, 'pass') }
  })
  test('smoothness: non-finite measurements and geometry replacement are failures', () => {
    const a = good(); a.motion.p95 = NaN; assert.equal(smoothnessVerdict(a).status, 'fail')
    const b = good(); b.motion.changedGeometry = 1; assert.equal(smoothnessVerdict(b).status, 'fail')
  })
  test('smoothness: flashes, missing submissions, speed explosions and rest jitter fail', () => {
    const mutations = [
      (r: any) => { r.warmupFailure = 'blank framebuffer' },
      (r: any) => { r.motion.missingDraws = 1 },
      (r: any) => { r.motion.hidden = 1 },
      (r: any) => { r.motion.physics.maxSpeed = 100 },
      (r: any) => { r.motion.physics.restJitter = .01 },
      (r: any) => { r.motion.renderedMotionFrames = 0 },
    ]
    for (const mutate of mutations) { const r = good(); mutate(r); assert.equal(smoothnessVerdict(r).status, 'fail') }
  })
  test('smoothness: catalogue covers every registered device and all six arm kinds without duplicate ids', () => {
    const source = readFileSync(new URL('../src/sim/devices/registry.ts', import.meta.url), 'utf8')
    const modules = [...source.matchAll(/view:\s*\(\)\s*=>\s*import\('\.\/([\w-]+)\.view'\)/g)].map(m => m[1])
    const ids = SMOOTHNESS_SIMS.map(([id]) => id)
    assert.equal(modules.length, 33); assert.equal(new Set(ids).size, ids.length)
    for (const id of modules) assert.ok(ids.includes(id), `missing ${id}`)
    for (const kind of ['arm5', 'so101', 'six', 'scara', 'delta', 'desk']) assert.ok(ids.includes(`arm-${kind}`))
    for (const id of ['arena', 'humanoid', 'humanoid-soft']) assert.ok(ids.includes(id))
  })
}
