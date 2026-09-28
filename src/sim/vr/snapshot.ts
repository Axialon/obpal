import type { SimValue } from '@obpal/core'
import type { DeviceLogic } from '../devices/types'

/** Only presentation state crosses the link, never private input filters, drivers or hardware connections. */
const keys = ['units', 'drones', 'rovers', 'boards', 'cams', 'lamps', 'claws', 'prizes', 'cones', 'pallets', 'hits', 'counts', 'last', 'puck', 'ball', 'rods', 'scores', 'sand', 'strokes', 'rocks', 'time', 'train', 'balls', 'targets', 'dust', 'temperature']
function plain(v: unknown): SimValue {
  if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>)
  if (Array.isArray(v)) return v.map(plain)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x !== 'function').map(([k, x]) => [k, plain(x)]))
  return v as SimValue
}
export function captureDevice(logic: DeviceLogic): SimValue {
  const data = logic as unknown as Record<string, unknown>
  return Object.fromEntries(keys.filter(k => data[k] !== undefined).map(k => [k, plain(data[k])]))
}
/** Preserve array and object references retained by a view. Only host snapshots enter here. */
function assign(to: unknown, from: SimValue): unknown {
  if (ArrayBuffer.isView(to) && Array.isArray(from)) { (to as unknown as Float32Array).set(from as number[]); return to }
  if (Array.isArray(to) && Array.isArray(from)) { from.forEach((v, i) => { to[i] = assign(to[i], v) }); to.length = from.length; return to }
  if (to && from && typeof to === 'object' && typeof from === 'object' && !Array.isArray(from)) {
    const target = to as Record<string, unknown>
    for (const [k, v] of Object.entries(from)) if (Object.hasOwn(target, k)) target[k] = assign(target[k], v)
    return to
  }
  return from
}
export function applyDevice(logic: DeviceLogic, state: SimValue) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return
  const data = logic as unknown as Record<string, unknown>
  for (const k of keys) if (Object.hasOwn(state, k) && Object.hasOwn(data, k)) data[k] = assign(data[k], state[k])
}
