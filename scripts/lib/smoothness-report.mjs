/** Gate only measured coverage. The first migration supplies pendulum-specific stability limits. */
export function smoothnessVerdict(result) {
  const failures = [], gaps = [], m = result.motion
  if (result.error) gaps.push(result.error)
  if (result.warmupFailure === undefined) gaps.push('warm-up was not measured')
  else if (result.warmupFailure) failures.push(`warm-up: ${result.warmupFailure}`)
  if (!m) gaps.push('motion was not measured')
  else {
    const numeric = ['frames', 'motionSeconds', 'motionFrames', 'renderedMotionFrames', 'p95', 'p99', 'maxGap', 'hidden', 'missingDraws', 'changedGeometry', 'nonFinite', 'rigidMeshes', 'unsupportedMeshes']
    if (numeric.some(k => !Number.isFinite(m[k]) || m[k] < 0)) failures.push('invalid motion measurements')
    if (m.motionSeconds < 10 || m.motionFrames < 120 || m.frames < 180) gaps.push('insufficient consecutive motion coverage')
    if (!m.rigidMeshes || m.unsupportedMeshes) gaps.push('not all selected parts have rigid geometry coverage')
    if (m.p95 > 25 || m.p99 > 50 || m.maxGap > 250) failures.push('frame pacing exceeds the provisional reference budget')
    if (m.renderedMotionFrames < m.motionFrames * .8) failures.push('too few moving frames were rendered')
    if (m.hidden || m.missingDraws || m.changedGeometry) failures.push('part visibility, draw submission or geometry identity changed')
    if (m.nonFinite) failures.push('non-finite scene transforms')
    const p = m.physics
    if (!p?.supported) gaps.push('physics probe not implemented for this sim')
    else if (['maxAngle', 'maxSpeed', 'restJitter', 'invalidFrames'].some(k => !Number.isFinite(p[k]) || p[k] < 0)) failures.push('invalid physics measurements')
    else if (p.maxAngle > 1.400001 || p.maxSpeed > 5.000001 || p.restJitter > .0001 || p.invalidFrames > 0) failures.push('pendulum stability bounds exceeded')
  }
  return { status: failures.length ? 'fail' : gaps.length ? 'incomplete' : 'pass', failures, gaps }
}
