/** Include the sample before the requested window so any sampling cadence can prove a stationary span. */
export function settledWindow(samples, duration = 0.4, tolerance = 0.3) {
  const last = samples.at(-1)
  if (!last) return false
  let start = -1
  for (let n = samples.length - 1; n >= 0; n--) {
    if (samples[n].at <= last.at - duration) { start = n; break }
  }
  return start >= 0 && samples.slice(start).every(p => Math.hypot(p.x - last.x, p.y - last.y) < tolerance)
}
