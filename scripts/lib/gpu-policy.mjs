/** GPU scheduling follows the groups the suite dispatchers actually execute. */
export const FULL_SIMS_GROUPS = [
  'physics-bench', 'humanoid-physics', 'core', 'smoothness', 'temporal', 'warm-up',
  'graphics-recovery', 'load', 'control', 'music', 'vr', 'control-views', 'audio',
  'panels', 'arm-live', 'humanoid', 'humanoid-live', 'buttons', 'local-control', 'octopus',
]

export const EXCLUSIVE_SIMS_GROUPS = [
  'physics-bench', 'humanoid-physics', 'smoothness', 'warm-up', 'load', 'control',
  'music', 'humanoid', 'humanoid-live', 'marble-mobile', 'p1-repairs',
]

const SHARED_SIMS_GROUPS = [
  'temporal', 'graphics-recovery', 'graphics-layouts', 'buttons', 'panels',
  'audio', 'vr', 'p1-gestures', 'local-control', 'local-control-before', 'local-faces', 'octopus',
]

// Home selectors are substrings of check names, rather than named groups.
const EXCLUSIVE_HOME_CHECKS = [
  ...[1280, 390].map(width => `viewport field ${width}px: full-page scroll, first clicks, cached obstacles and CLS`),
  'viewport field 390px: hero-only scroll, first clicks, cached obstacles and CLS',
  'viewport field: native GPU pacing under 4x CPU throttle',
  'viewport field contact audit: seeded ledges, visibility and every section',
  'viewport field moving contact audit: solid cards sweep, wake and stay visible',
  'on a phone, a knock against the edge of the screen is heard, and leaning on it is quiet',
]

/** An isolated selector retains its original suite behavior and measurement scope. */
export function gpuModeForSuite(suite, env = {}) {
  if (suite === 'sims') {
    const groups = env.OBPAL_E2E_SIMS_GROUPS?.split(',').filter(Boolean)
    if (groups) return groups.some(group => EXCLUSIVE_SIMS_GROUPS.includes(group)) ? 'exclusive' : 'shared'
    const only = env.OBPAL_E2E_SIMS_ONLY
    // Tracking runs the physics prefix; unknown selectors enter the full suite.
    return SHARED_SIMS_GROUPS.includes(only) ? 'shared' : 'exclusive'
  }
  if (suite === 'home') {
    const only = env.OBPAL_E2E_HOME_ONLY
    return !only || only === 'warm-up' || only === 'surface and pacing' ||
      EXCLUSIVE_HOME_CHECKS.some(name => name.includes(only))
      ? 'exclusive' : 'shared'
  }
  return suite === 'camera' || suite === 'shared' ? 'exclusive' : 'shared'
}

/** Split the full sims run at ownership boundaries without adding or dropping checks. */
export function gpuRuns(suite, env = {}) {
  if (suite !== 'sims' || env.OBPAL_E2E_SIMS_ONLY || env.OBPAL_E2E_SIMS_GROUPS) {
    return [{ suite, label: suite, mode: gpuModeForSuite(suite, env), env: {} }]
  }
  const runs = []
  for (const group of FULL_SIMS_GROUPS) {
    const mode = EXCLUSIVE_SIMS_GROUPS.includes(group) ? 'exclusive' : 'shared'
    const last = runs.at(-1)
    // Core owns the original inline arm/arena checks and must run by itself.
    if (last && last.mode === mode && group !== 'core' && !last.groups.includes('core')) last.groups.push(group)
    else runs.push({ suite, mode, groups: [group] })
  }
  return runs.map(({ suite, mode, groups }, i) => ({ suite, mode,
    label: `${suite}-${mode === 'shared' ? 'shared' : 'timing'}-${i + 1}`,
    env: { OBPAL_E2E_SIMS_GROUPS: groups.join(',') } }))
}
