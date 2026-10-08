/** Authored metre-scale linkage, not coupled sling or counterweight dynamics. Downrange is -Z. */
export const AXLE_HEIGHT = 1.85
export const READY_ARM = .65
export const WIND_SECONDS = .65
export const SLING_Y = -.4
export const SLING_Z = 2.12
export const LOAD_RADIUS = .12
export const LOAD_HEIGHT = .15
/** Decreasing X rotation lifts the rear load and sends it towards the targets. */
export const releaseArm = (degrees: number) => degrees * Math.PI / 180 - Math.PI / 2 - Math.atan2(-SLING_Y, SLING_Z)
export function loadPosition(arm: number): [number, number, number] {
  return [0, AXLE_HEIGHT + SLING_Y * Math.cos(arm) - SLING_Z * Math.sin(arm) + LOAD_HEIGHT, SLING_Y * Math.sin(arm) + SLING_Z * Math.cos(arm)]
}
/** World tangent for decreasing arm rotation; the upright pouch adds no rotating offset. */
export function loadTangent(arm: number): [number, number, number] {
  return [0, SLING_Y * Math.sin(arm) + SLING_Z * Math.cos(arm), -SLING_Y * Math.cos(arm) + SLING_Z * Math.sin(arm)]
}
