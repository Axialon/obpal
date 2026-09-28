/** Optional sim messages share the authenticated ctl channel; older peers ignore them. */
export type SimValue = null | boolean | number | string | SimValue[] | { [key: string]: SimValue }
export interface SimMessage { t: 'sim'; v: 1; kind: 'watch' | 'input' | 'frame'; seq: number; data: SimValue }
/** Bound work before dispatch. Prototype keys and non-finite data never reach a scene adapter. */
export function validSimMessage(value: unknown): value is SimMessage {
  const m = value as SimMessage | null
  if (!m || m.t !== 'sim' || m.v !== 1 || !['watch', 'input', 'frame'].includes(m.kind) || !Number.isSafeInteger(m.seq) || m.seq < 0) return false
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
