/** Real backend lifecycle probes shared by Node and browser. No Node or test-framework imports. */
import { Simulation } from './runtime'
import { STEP, type BackendFactory, type SceneInput } from './schema'
import { norm, sub } from './math'
export interface Probe { name: string; passed: boolean; error: string | null }
const input = (): SceneInput => ({ gravity: { x: 0, y: 0, z: 0 }, bodies: [{ id: 'probe', shape: { kind: 'sphere', radius: .25 }, position: { x: 0, y: 2, z: 0 } }] })
function require(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
async function rejects(fn: () => unknown | Promise<unknown>) { let failed = false; try { await fn() } catch { failed = true }; require(failed, 'operation should reject') }
export async function lifecycleProbe(factory: BackendFactory): Promise<Probe[]> {
  const results: Probe[] = []
  const run = async (name: string, fn: () => Promise<void>) => { try { await fn(); results.push({ name, passed: true, error: null }) } catch (e) { results.push({ name, passed: false, error: String(e) }) } }
  await run('coalesced init, force-at-point, sleep/wake, reset/re-entry, terminal disposal', async () => {
    const s = new Simulation(input(), factory)
    try {
      const pending = s.init(); require(pending === s.init(), 'concurrent init allocated twice'); await pending
      s.sleep('probe'); const before = s.snapshot()[0]; s.advance(STEP)
      require(s.snapshot()[0].sleeping && norm(sub(before.position, s.snapshot()[0].position)) < 1e-7, 'sleep did not hold')
      s.applyForce('probe', { x: 1, y: 0, z: 0 }, { x: 0, y: 2.25, z: 0 }); s.advance(STEP)
      const forced = s.snapshot()[0]; require(!forced.sleeping && forced.velocity.x > 0 && forced.angularVelocity.z < 0, 'point force or wake failed')
      s.advance(STEP); require(Math.abs(s.snapshot()[0].velocity.x - forced.velocity.x) < 1e-6, 'force persisted')
      for (let n = 0; n < 3; n++) { await s.reset(); require(s.snapshot()[0].id === 'probe' && Math.abs(s.snapshot()[0].position.y - 2) < 1e-6, 'reset state/ID drift') }
      await rejects(() => s.applyForce('probe', { x: Infinity, y: 0, z: 0 })); require(s.status === 'ready', 'invalid input poisoned session')
    } finally { s.dispose() }
    await rejects(() => s.init()); await rejects(() => s.advance(STEP)); s.dispose()
  })
  await run('async init rejection/retry and late init disposal', async () => {
    let calls = 0, releases = 0
    const s = new Simulation(input(), async (scene, limits) => { if (!calls++) throw new Error('injected init rejection'); return factory(scene, limits) })
    try { await rejects(() => s.init()); require(s.status === 'faulted', 'init failure hidden'); await s.init(); require(s.status as string === 'ready', 'retry did not recover') } finally { s.dispose() }
    let resume!: () => void
    const wait = new Promise<void>(resolve => { resume = resolve })
    const late = new Simulation(input(), async (scene, limits) => { await wait; const b = await factory(scene, limits); return { ...b, dispose: () => { releases++; b.dispose() } } })
    const pending = late.init(); late.dispose(); resume(); await rejects(() => pending)
    require(releases === 1 && late.status === 'disposed', 'late init leaked or resurrected')
  })
  await run('backend fault freezes state and explicit reset recovers', async () => {
    let failNext = true
    const s = new Simulation(input(), async (scene, limits) => {
      const b = await factory(scene, limits)
      return { ...b, step: dt => { if (failNext) { failNext = false; throw new Error('injected step fault') }; b.step(dt) } }
    })
    try { await s.init(); const before = JSON.stringify(s.snapshot()); await rejects(() => s.advance(STEP)); require(s.status === 'faulted' && JSON.stringify(s.snapshot()) === before, 'fault changed published state'); await s.reset(); s.advance(STEP); require(s.status as string === 'ready', 'reset failed') }
    finally { s.dispose() }
  })
  return results
}
