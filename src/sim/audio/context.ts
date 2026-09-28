/** A sim owns one context. The studio borrows it without changing its instrument scheduler. */
let context: AudioContext | null = null
const previous = new Float64Array(16).fill(NaN)
export const audioContext = () => context ??= new AudioContext({ latencyHint: 'interactive' })
export const currentContext = () => context

/** The render camera's world matrix also works for cameras parented to a vehicle or XR rig. */
export function listenFrom(matrix: ArrayLike<number>) {
  const c = context
  if (!c || c.state !== 'running') return
  const l = c.listener, t = c.currentTime
  if (l.positionX) {
    if (matrix[12] !== previous[12]) l.positionX.setTargetAtTime(matrix[12], t, 0.015)
    if (matrix[13] !== previous[13]) l.positionY.setTargetAtTime(matrix[13], t, 0.015)
    if (matrix[14] !== previous[14]) l.positionZ.setTargetAtTime(matrix[14], t, 0.015)
    if (matrix[8] !== previous[8]) l.forwardX.setTargetAtTime(-matrix[8], t, 0.015)
    if (matrix[9] !== previous[9]) l.forwardY.setTargetAtTime(-matrix[9], t, 0.015)
    if (matrix[10] !== previous[10]) l.forwardZ.setTargetAtTime(-matrix[10], t, 0.015)
    if (matrix[4] !== previous[4]) l.upX.setTargetAtTime(matrix[4], t, 0.015)
    if (matrix[5] !== previous[5]) l.upY.setTargetAtTime(matrix[5], t, 0.015)
    if (matrix[6] !== previous[6]) l.upZ.setTargetAtTime(matrix[6], t, 0.015)
    for (let i = 0; i < 16; i++) previous[i] = matrix[i]
  } else {
    l.setPosition(matrix[12], matrix[13], matrix[14])
    l.setOrientation(-matrix[8], -matrix[9], -matrix[10], matrix[4], matrix[5], matrix[6])
  }
}
