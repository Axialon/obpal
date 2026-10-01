/** Render transforms use metres and xyzw unit quaternions, without a dependency on three.js. */
export interface Transform { p: readonly [number, number, number]; q: readonly [number, number, number, number] }
function rotation(q: Transform['q']): [number, number, number, number] {
  const length = Math.hypot(...q)
  if (!q.every(Number.isFinite) || length < 1e-12) throw new RangeError('Invalid physics rotation')
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length]
}
export function interpolateTransform(a: Transform, b: Transform, alpha: number): Transform {
  if (!Number.isFinite(alpha) || !a.p.every(Number.isFinite) || !b.p.every(Number.isFinite)) throw new RangeError('Invalid transform interpolation')
  const t = Math.max(0, Math.min(1, alpha)), qa = rotation(a.q), qb = rotation(b.q)
  let dot = qa.reduce((s, v, n) => s + v * qb[n], 0)
  if (dot < 0) { dot = -dot; for (let n = 0; n < 4; n++) qb[n] = -qb[n] }
  let x = 1 - t, y = t
  if (dot < .9995) {
    const angle = Math.acos(Math.min(1, dot)), sine = Math.sin(angle)
    x = Math.sin((1 - t) * angle) / sine; y = Math.sin(t * angle) / sine
  }
  return { p: [a.p[0] + (b.p[0] - a.p[0]) * t, a.p[1] + (b.p[1] - a.p[1]) * t, a.p[2] + (b.p[2] - a.p[2]) * t],
    q: rotation([qa[0] * x + qb[0] * y, qa[1] * x + qb[1] * y, qa[2] * x + qb[2] * y, qa[3] * x + qb[3] * y]) }
}
