/** Optional sim messages share the authenticated ctl channel; older peers ignore them. */
export type SimValue = null | boolean | number | string | SimValue[] | { [key: string]: SimValue }
export interface SimMessage { t: 'sim'; v: 1; kind: 'watch' | 'input' | 'camera' | 'drop' | 'drops' | 'frame' | 'room' | 'handover' | 'seat' | 'audience'; seq: number; data: SimValue }
/** Bound work before dispatch. Prototype keys and non-finite data never reach a scene adapter. */
export function validSimMessage(value: unknown): value is SimMessage {
  const m = value as SimMessage | null
  if (!m || m.t !== 'sim' || m.v !== 1 || !['watch', 'input', 'camera', 'drop', 'drops', 'frame', 'room', 'handover', 'seat', 'audience'].includes(m.kind) || !Number.isSafeInteger(m.seq) || m.seq < 0) return false
  if (['audience', 'seat', 'handover'].includes(m.kind)) {
    if (!m.data || typeof m.data !== 'object' || Array.isArray(m.data)) return false
    const d = m.data
    if (m.kind === 'handover') return Object.keys(d).every(k => ['op', 'to'].includes(k)) && typeof d.op === 'string' && ['ask', 'cancel', 'accept', 'decline', 'give', 'demote'].includes(d.op) && (d.to === undefined || typeof d.to === 'string' && d.to.length <= 64)
    if (m.kind === 'audience' && typeof d.op === 'string' && ['join', 'leave'].includes(d.op)) return Object.keys(d).length === 1
    return Object.keys(d).every(k => (m.kind === 'seat' ? ['x', 'y', 'rx', 'ry', 'action'] : ['x', 'y']).includes(k)) && ['x', 'y'].every(k => typeof d[k] === 'number' && Number.isFinite(d[k]) && Math.abs(d[k] as number) <= 1) && ['rx', 'ry'].every(k => d[k] === undefined || typeof d[k] === 'number' && Number.isFinite(d[k]) && Math.abs(d[k] as number) <= 1) && (d.action === undefined || m.kind === 'seat' && typeof d.action === 'string' && d.action.length <= 32)
  }
  let count = 0
  function valid(v: unknown, depth: number): boolean {
    if (++count > 16000 || depth > 12) return false
    if (v === null || typeof v === 'boolean') return true
    if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) <= 1e9
    if (typeof v === 'string') return v.length <= 2048
    if (Array.isArray(v)) return v.length <= 4096 && v.every(x => valid(x, depth + 1))
    if (typeof v === 'object') return Object.entries(v).every(([k, x]) => k.length <= 64 && !['__proto__', 'prototype', 'constructor'].includes(k) && valid(x, depth + 1))
    return false
  }
  return valid(m.data, 0)
}
