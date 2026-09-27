import { describe, expect, it } from 'vitest'
import { blockBox, gap, restOf } from '../src/sim/arm/blocks'
import { fixtures, payloadSpeed, STOCK } from '../src/sim/arm/workspace'
import { KINDS } from '../src/sim/arm/kind'

describe('the arm workbench', () => {
  it('has stock of different sizes and weights, all small enough for the gripper', () => {
    expect(STOCK.length).toBe(12)
    expect(new Set(STOCK.map(s => s.half.join(','))).size).toBeGreaterThan(3)
    expect(new Set(STOCK.map(s => s.mass)).size).toBeGreaterThan(3)
    for (const s of STOCK) expect(s.half[0]).toBeLessThan(0.05)
    expect(payloadSpeed(0)).toBe(1)
    expect(payloadSpeed(0.09)).toBeLessThan(payloadSpeed(0.012))
  })

  it.each(Object.values(KINDS))('$id: trays, pegs and shelf support stock without overlapping arm bases', kind => {
    const parts = fixtures(kind.cell.stand)
    const top = parts.find(p => p.finish === 'shelf')!
    const b = { x: 0, y: 0.3, z: top.z, yaw: 0, half: [0.03, 0.03, 0.03] as [number, number, number] }
    expect(restOf(b, parts).y).toBeCloseTo(top.y + top.half[1] + b.half[1], 3)
    for (const p of parts) {
      expect(Math.hypot(p.x, p.z)).toBeLessThan(kind.cell.stand * 0.7)
      const base = { x: kind.cell.stand, y: 0.1, z: 0, yaw: 0, half: [0.14, 0.1, 0.14] as [number, number, number] }
      expect(gap(blockBox(p), blockBox(base))).toBeGreaterThan(0)
    }
  })
})
