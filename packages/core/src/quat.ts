/** Quaternion as [x, y, z, w]. Hamilton product; q maps local -> parent frame. */
export type Quat = [number, number, number, number]
export type Vec3 = [number, number, number]

export const qIdentity = (): Quat => [0, 0, 0, 1]

export function qMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a
  const [bx, by, bz, bw] = b
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}

export const qConj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]]

export function qNorm(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]
}

export function qAxisAngle(x: number, y: number, z: number, rad: number): Quat {
  const s = Math.sin(rad / 2)
  return [x * s, y * s, z * s, Math.cos(rad / 2)]
}

/** Rotate vector v by q (q v q*). */
export function qRotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q
  const tx = 2 * (y * v[2] - z * v[1])
  const ty = 2 * (z * v[0] - x * v[2])
  const tz = 2 * (x * v[1] - y * v[0])
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ]
}

export function qSlerp(a: Quat, b: Quat, t: number): Quat {
  let [bx, by, bz, bw] = b
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw }
  if (cos > 0.9995) {
    return qNorm([a[0] + (bx - a[0]) * t, a[1] + (by - a[1]) * t, a[2] + (bz - a[2]) * t, a[3] + (bw - a[3]) * t])
  }
  const th = Math.acos(Math.min(1, cos))
  const s = Math.sin(th)
  const wa = Math.sin((1 - t) * th) / s
  const wb = Math.sin(t * th) / s
  return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb]
}

/** Scale a rotation's angle by k (k > 1 amplifies). */
export function qScale(q: Quat, k: number): Quat {
  const n = q[3] < 0 ? ([-q[0], -q[1], -q[2], -q[3]] as Quat) : q
  const s = Math.hypot(n[0], n[1], n[2])
  if (s < 1e-9) return qIdentity()
  const angle = 2 * Math.atan2(s, n[3]) * k
  return qAxisAngle(n[0] / s, n[1] / s, n[2] / s, angle)
}

/** Quaternion of the rotation whose matrix columns are the images of the x, y, z axes. */
export function qFromBasis(x: Vec3, y: Vec3, z: Vec3): Quat {
  const m00 = x[0], m10 = x[1], m20 = x[2]
  const m01 = y[0], m11 = y[1], m21 = y[2]
  const m02 = z[0], m12 = z[1], m22 = z[2]
  const tr = m00 + m11 + m22
  let q: Quat
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s]
  }
  return qNorm(q)
}

const D2R = Math.PI / 180

/**
 * W3C DeviceOrientation (alpha, beta, gamma in degrees, intrinsic Z-X'-Y'') to a quaternion
 * mapping the screen frame (x right, y up, z out of the screen) to Earth (x east, y north, z up).
 * screenDeg compensates for the current screen orientation angle.
 */
export function quatFromDeviceOrientation(alpha: number, beta: number, gamma: number, screenDeg = 0): Quat {
  const q = qMul(qMul(qAxisAngle(0, 0, 1, alpha * D2R), qAxisAngle(1, 0, 0, beta * D2R)), qAxisAngle(0, 1, 0, gamma * D2R))
  return qNorm(qMul(q, qAxisAngle(0, 0, 1, -screenDeg * D2R)))
}

/**
 * "View frame" at the moment the user engages: x = user's right, y = up (gravity), z = toward the user.
 * Forward (toward the screen being controlled) is the phone's back face when it faces the user, or its
 * top edge when it lies flat. This holds in portrait and landscape, including with rotation lock on.
 * Returns the quaternion mapping view frame -> Earth frame.
 */
export function viewFrameAt(q0: Quat): Quat {
  const yW = qRotate(q0, [0, 1, 0])
  const zW = qRotate(q0, [0, 0, 1])
  const hz = Math.hypot(zW[0], zW[1])
  const hy = Math.hypot(yW[0], yW[1]) || 1
  const t = Math.min(1, Math.max(0, (hz - 0.25) / 0.2))
  const w = t * t * (3 - 2 * t)
  let fx = (hz > 1e-6 ? (-zW[0] / hz) * w : 0) + (yW[0] / hy) * (1 - w)
  let fy = (hz > 1e-6 ? (-zW[1] / hz) * w : 0) + (yW[1] / hy) * (1 - w)
  const l = Math.hypot(fx, fy) || 1
  fx /= l; fy /= l
  return qFromBasis([fy, -fx, 0], [0, 0, 1], [-fx, -fy, 0])
}

/** Rotation since grab (q0 -> q), expressed in the view frame R (view -> Earth). */
export function relativeInView(q0: Quat, q: Quat, R: Quat): Quat {
  const deltaWorld = qMul(q, qConj(q0))
  return qNorm(qMul(qMul(qConj(R), deltaWorld), R))
}
