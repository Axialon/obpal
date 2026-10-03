import { describe, expect, it } from 'vitest'
import { EXCLUSIVE_SIMS_GROUPS, FULL_SIMS_GROUPS, gpuModeForSuite, gpuRuns } from '../scripts/lib/gpu-policy.mjs'

describe('GPU ownership by measured suite gates', () => {
  it('shares ordinary suites and keeps wall-time budgets exclusive', () => {
    for (const suite of ['code', 'embed', 'phone', 'extension', 'pages', 'orientation', 'contact', 'catalogue']) {
      expect(gpuModeForSuite(suite)).toBe('shared')
    }
    for (const suite of ['home', 'camera', 'shared']) expect(gpuModeForSuite(suite)).toBe('exclusive')
  })
  it('preserves the full sims group order, measurement scope and boundaries', () => {
    const runs = gpuRuns('sims')
    expect(runs.flatMap(run => run.env.OBPAL_E2E_SIMS_GROUPS.split(','))).toEqual(FULL_SIMS_GROUPS)
    expect(runs.find(run => run.env.OBPAL_E2E_SIMS_GROUPS.includes('core'))?.env.OBPAL_E2E_SIMS_GROUPS).toBe('core')
    for (const run of runs) {
      const groups = run.env.OBPAL_E2E_SIMS_GROUPS.split(',')
      expect(groups.every(group => EXCLUSIVE_SIMS_GROUPS.includes(group) === (run.mode === 'exclusive'))).toBe(true)
    }
  })
  it('honours isolated sims groups and home profiles', () => {
    for (const group of EXCLUSIVE_SIMS_GROUPS) {
      expect(gpuRuns('sims', { OBPAL_E2E_SIMS_ONLY: group })).toEqual([{ suite: 'sims', label: 'sims', mode: 'exclusive', env: {} }])
    }
    for (const group of ['buttons', 'temporal', 'panels', 'audio', 'vr', 'graphics-recovery', 'local-control']) {
      expect(gpuModeForSuite('sims', { OBPAL_E2E_SIMS_ONLY: group })).toBe('shared')
    }
    for (const group of ['warm-up', 'viewport field', 'viewport field 1280px', 'surface and pacing', 'knock against', 'pacing', 'viewport', 'cached obstacles', 'contact audit', 'seeded ledges', 'solid cards sweep']) {
      expect(gpuModeForSuite('home', { OBPAL_E2E_HOME_ONLY: group })).toBe('exclusive')
    }
    expect(gpuModeForSuite('home', { OBPAL_E2E_HOME_ONLY: 'remote' })).toBe('shared')
    expect(gpuModeForSuite('home', { OBPAL_E2E_HOME_ONLY: 'surface audit' })).toBe('shared')
    expect(gpuModeForSuite('sims', { OBPAL_E2E_SIMS_ONLY: 'unsupported-selector' })).toBe('exclusive')
    for (const group of ['tracking', 'core', 'arm-live', 'control-views']) {
      expect(gpuModeForSuite('sims', { OBPAL_E2E_SIMS_ONLY: group })).toBe('exclusive')
    }
  })
})
