import { assert } from './sim-node.mjs'
export function humanoidAcceptanceCases(test: (name: string, run: () => unknown | Promise<unknown>) => unknown) {
  test('acceptance: missing, nonfinite, incomplete, hovering and unsupported rows cannot pass', async () => {
    const { stancePass, anatomyPass } = await import('../src/sim/humanoid/physics/acceptance')
    const good = { completedTicks: 7200, expectedTicks: 7200, maxPenetrationMm: 4, maxHoverMm: 4, slipMm: 0,
      minPelvisHeightM: .85, standingHeightM: .9, minUp: .99, supportedSamples: 6720, settledSamples: 6720,
      maxAnchorErrorMm: 1, maxLimitSurfaceErrorMm: 1, maxConeErrorRad: .001, maxEffortRatio: 1,
      p95TickWallMs: 1, p99TickWallMs: 2, droppedSeconds: 0, invalidFrames: 0, error: null }
    assert.equal(stancePass(good), true)
    for (const bad of [{ ...good, maxHoverMm: 5.1 }, { ...good, completedTicks: 7199 }, { ...good, p95TickWallMs: NaN },
      { ...good, supportedSamples: 0 }, { ...good, maxPenetrationMm: Infinity }, { ...good, maxEffortRatio: 1.01 }, { ...good, error: 'native abort' }]) assert.equal(stancePass(bad), false)
    assert.equal(anatomyPass({ rows: [] }), false)
  })
}
