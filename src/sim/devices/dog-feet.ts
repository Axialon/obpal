/** Deterministic world-space foot plants and two-link IK, shared by the dog logic and its rig. Metres, y up. */
export const DOG_LEG = { upper: .34, lower: .34, sole: .08, width: .14, depth: .2, hipX: .3, hipZ: .36, restKnee: .8 }
export const DOG_PAD = { width: 1.25, depth: 1.55, height: .05, x: [-2.2, 2.2], z: 2.2, edge: .012 } as const
export interface FootPoint { x: number; y: number; z: number }
export interface DogLeg {
  hip: number; knee: number; abduction: number
  foot: FootPoint; from: FootPoint; to: FootPoint
  stance: boolean; swing: number; heading: number; previous: number
}
export interface WalkingDog { x: number; y: number; z: number; h: number; v: number; turn: number; sit: number; gait: number; legs: DogLeg[]; feetPose?: { x: number; z: number; h: number } }
export type HeightAt = (x: number, z: number) => number
const TAU = Math.PI * 2
const clamp = (x: number, low: number, high: number) => Math.max(low, Math.min(high, x))

export function dogGround(x: number, z: number) {
  return DOG_PAD.x.some(px => Math.abs(x - px) <= DOG_PAD.width / 2 && Math.abs(z - DOG_PAD.z) <= DOG_PAD.depth / 2) ? DOG_PAD.height / 2 : 0
}
export function hipAt(k: number) { return { x: (k % 2 ? 1 : -1) * DOG_LEG.hipX, z: k < 2 ? -DOG_LEG.hipZ : DOG_LEG.hipZ } }
const world = (x: number, z: number, h: number, p: { x: number; z: number }) => ({ x: x + Math.cos(h) * p.x + Math.sin(h) * p.z, z: z - Math.sin(h) * p.x + Math.cos(h) * p.z })

/** Plan a complete sole on a flat landing surface, rather than balancing on a pad's chamfer. */
export function footPlant(point: { x: number; z: number }, heading: number, terrain: HeightAt = dogGround): FootPoint {
  const p = { ...point }, c = Math.abs(Math.cos(heading)), s = Math.abs(Math.sin(heading))
  const ex = c * DOG_LEG.width / 2 + s * DOG_LEG.depth / 2, ez = s * DOG_LEG.width / 2 + c * DOG_LEG.depth / 2
  if (terrain === dogGround) for (const x of DOG_PAD.x) {
    const hx = DOG_PAD.width / 2, hz = DOG_PAD.depth / 2, edge = DOG_PAD.edge
    if (Math.abs(p.x - x) > hx + ex || Math.abs(p.z - DOG_PAD.z) > hz + ez) continue
    const choices = [
      { x: clamp(p.x, x - hx + ex + edge, x + hx - ex - edge), z: clamp(p.z, DOG_PAD.z - hz + ez + edge, DOG_PAD.z + hz - ez - edge) },
      { x: x - hx - ex - edge, z: p.z }, { x: x + hx + ex + edge, z: p.z },
      { x: p.x, z: DOG_PAD.z - hz - ez - edge }, { x: p.x, z: DOG_PAD.z + hz + ez + edge },
    ]
    choices.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))
    Object.assign(p, choices[0])
  }
  return { ...p, y: soleHeight(p.x, p.z, heading, terrain) }
}

/** A level sole rests on the highest terrain under its footprint, including the edge of a charging pad. */
export function soleHeight(x: number, z: number, heading: number, terrain: HeightAt = dogGround) {
  let y = terrain(x, z)
  for (const dx of [-DOG_LEG.width / 2, DOG_LEG.width / 2]) for (const dz of [-DOG_LEG.depth / 2, DOG_LEG.depth / 2]) {
    const p = world(x, z, heading, { x: dx, z: dz }); y = Math.max(y, terrain(p.x, p.z))
  }
  // A pad corner can pass under the middle of a swinging sole without containing one of its corners.
  if (terrain === dogGround) {
    const c = Math.cos(heading), s = Math.sin(heading), ac = Math.abs(c), as = Math.abs(s)
    const fw = DOG_LEG.width / 2, fd = DOG_LEG.depth / 2, pw = DOG_PAD.width / 2, pd = DOG_PAD.depth / 2
    for (const px of DOG_PAD.x) {
      const dx = x - px, dz = z - DOG_PAD.z
      if (Math.abs(dx) <= pw + ac * fw + as * fd && Math.abs(dz) <= pd + as * fw + ac * fd &&
        Math.abs(c * dx - s * dz) <= fw + ac * pw + as * pd && Math.abs(s * dx + c * dz) <= fd + as * pw + ac * pd) y = Math.max(y, DOG_PAD.height / 2)
    }
  }
  return y
}

/** Reach an ankle from its hip; abduction gives turning feet a third degree of freedom. */
export function legIK(x: number, y: number, z: number) {
  const { upper, lower } = DOG_LEG
  const distance = Math.hypot(x, y, z), reach = clamp(distance, .001, upper + lower - 1e-8)
  const knee = Math.acos(clamp((reach * reach - upper * upper - lower * lower) / (2 * upper * lower), -1, 1))
  const hip = Math.atan2(-z, Math.hypot(x, y)) - Math.atan2(lower * Math.sin(knee), upper + lower * Math.cos(knee))
  return { hip, knee, abduction: Math.atan2(x, -y), reached: distance <= upper + lower }
}

/** The ankle reconstructed from the same three rotations used by the view. */
export function legForward(leg: Pick<DogLeg, 'hip' | 'knee' | 'abduction'>): FootPoint {
  const y = -DOG_LEG.upper * Math.cos(leg.hip) - DOG_LEG.lower * Math.cos(leg.hip + leg.knee)
  return { x: -y * Math.sin(leg.abduction), y: y * Math.cos(leg.abduction), z: -DOG_LEG.upper * Math.sin(leg.hip) - DOG_LEG.lower * Math.sin(leg.hip + leg.knee) }
}

export function plantDog(u: WalkingDog, terrain: HeightAt = dogGround) {
  u.feetPose = { x: u.x, z: u.z, h: u.h }
  u.legs = Array.from({ length: 4 }, (_, k) => {
    const p = world(u.x, u.z, u.h, hipAt(k)), foot = footPlant(p, u.h, terrain)
    return { hip: 0, knee: 0, abduction: 0, foot, from: { ...foot }, to: { ...foot }, stance: true, swing: 0, heading: u.h, previous: k === 0 || k === 3 ? 0 : .5 }
  })
  stepFeet(u, 0, terrain)
}

export function stepFeet(u: WalkingDog, dt: number, terrain: HeightAt = dogGround) {
  // A fence can cancel commanded velocity after a small sideways displacement. Those steps still need a gait.
  const shifted = u.feetPose && (Math.hypot(u.x - u.feetPose.x, u.z - u.feetPose.z) > 1e-7 || Math.abs(u.h - u.feetPose.h) > 1e-7)
  const moving = (Math.abs(u.v) + Math.abs(u.turn) > .005 || shifted) && u.sit < .01
  u.feetPose = { x: u.x, z: u.z, h: u.h }
  const frequency = 2.2 + Math.abs(u.v) * .7, stanceTime = .6 / frequency, swingTime = .4 / frequency
  if (moving || u.legs.some(l => !l.stance)) u.gait = (u.gait + dt * frequency * TAU) % TAU
  u.legs.forEach((leg, k) => {
    const phase = (u.gait / TAU + (k === 0 || k === 3 ? 0 : .5)) % 1
    if (moving && leg.stance && phase >= .6 && leg.previous < .6) {
      leg.stance = false; leg.swing = 0; leg.from = { ...leg.foot }
      const ahead = swingTime + stanceTime / 2, h = u.h + u.turn * ahead
      const p = world(u.x - Math.sin(h) * u.v * ahead, u.z - Math.cos(h) * u.v * ahead, h, hipAt(k))
      leg.to = footPlant(p, h, terrain); leg.heading = h
    }
    if (!leg.stance) {
      leg.swing = Math.min(1, leg.swing + dt / swingTime)
      const t = leg.swing, ease = t * t * (3 - 2 * t)
      leg.foot = { x: leg.from.x + (leg.to.x - leg.from.x) * ease, y: 0, z: leg.from.z + (leg.to.z - leg.from.z) * ease }
      leg.foot.y = Math.max(soleHeight(leg.foot.x, leg.foot.z, leg.heading, terrain), leg.from.y + (leg.to.y - leg.from.y) * ease) + Math.sin(t * Math.PI) ** 2 * .11
      if (t === 1) { leg.foot = { ...leg.to }; leg.stance = true }
    }
    leg.previous = phase
  })
  // The neutral knee angle defines height. Terrain support and sitting set the actual hip plane.
  const ground = u.legs.reduce((sum, leg) => sum + terrain(leg.foot.x, leg.foot.z), 0) / 4
  const extension = (DOG_LEG.upper + DOG_LEG.lower) * Math.cos(DOG_LEG.restKnee / 2)
  u.y = ground + DOG_LEG.sole / 2 + extension - u.sit * .22
  // Keep even the farthest planted foot reachable during acceleration, braking and a turn.
  for (const [k, leg] of u.legs.entries()) {
    const hip = world(u.x, u.z, u.h, hipAt(k)), horizontal = Math.hypot(leg.foot.x - hip.x, leg.foot.z - hip.z)
    u.y = Math.min(u.y, leg.foot.y + DOG_LEG.sole / 2 + Math.sqrt(Math.max(.01, (DOG_LEG.upper + DOG_LEG.lower - .002) ** 2 - horizontal ** 2)))
  }
  for (const [k, leg] of u.legs.entries()) {
    const hip = world(u.x, u.z, u.h, hipAt(k)), dx = leg.foot.x - hip.x, dz = leg.foot.z - hip.z
    Object.assign(leg, legIK(Math.cos(u.h) * dx - Math.sin(u.h) * dz, leg.foot.y + DOG_LEG.sole / 2 - u.y, Math.sin(u.h) * dx + Math.cos(u.h) * dz))
  }
}
