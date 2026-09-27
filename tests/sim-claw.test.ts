import { describe, expect, it } from 'vitest'
import { Mode, PadButton, qIdentity } from '@obpal/core'
import { CABINETS, CLAW, ClawLogic, clawIntent } from '../src/sim/devices/claw'
import { restInput, type DeviceInput } from '../src/sim/devices/types'

const pad = (axes: [number, number, number, number], buttons = 0) => ({ flags: 0, seq: 0, t: 0, buttons, axes, triggers: [0, 0] as [number, number] })
const idle = (over: Partial<DeviceInput> = {}): DeviceInput => ({ ...restInput('face.trackpad', Mode.hold), ...over })
const run = (logic: ClawLogic, inp: () => DeviceInput | null, seconds: number) => { for (let t = 0; t < seconds; t += 1 / 60) logic.step([inp()], 1 / 60) }
/** Point the Wii remote at a spot in cabinet 1's pit (the room's coordinates). */
const pointAt = (x: number, z: number, presses: string[] = []) => ({ ...restInput('face.wii', Mode.point), point: { x: 0, y: 0, yaw: 0, pitch: 0, off: false }, spot: [x + CABINETS[0][0], z + CABINETS[0][1]] as [number, number], presses })

describe('claw machine: each controller moves the claw', () => {
  it('Wii remote: the claw rides to where the phone points in the pit, never past its walls', () => {
    const logic = new ClawLogic(1)
    const c = logic.claws[0]
    run(logic, () => pointAt(0.2, -0.1), 3)
    expect(c.x).toBeCloseTo(0.2, 3)
    expect(c.z).toBeCloseTo(-0.1, 3)
    run(logic, () => pointAt(3, 3), 3)
    expect(c.x).toBeLessThanOrEqual(CLAW.half)
    expect(c.z).toBeLessThanOrEqual(CLAW.half)
  })

  it('gamepad: the left stick moves it at the gantry’s speed; A drops it', () => {
    const logic = new ClawLogic(1)
    const c = logic.claws[0]
    const x0 = c.x
    run(logic, () => idle({ pad: pad([1, 0, 0, 0]) }), 0.5)
    expect(c.x - x0).toBeCloseTo(CLAW.speed * 0.5, 1)
    logic.step([idle({ pad: pad([0, 0, 0, 0]), padPressed: 1 << PadButton.A })], 1 / 60)
    expect(c.phase).toBe('drop')
  })

  it('trackpad: a drag moves it with the thumb, a tap drops it', () => {
    const c = new ClawLogic(1).claws[0]
    const i = clawIntent(idle({ touching: true, drag: [100, 0] }), c, CABINETS[0], { anchor: null })
    expect(i.goal![0]).toBeCloseTo(c.x + 0.22)
    expect(clawIntent(idle({ presses: ['pad'] }), c, CABINETS[0], { anchor: null }).drop).toBe(true)
  })

  it('3D hand: it follows the hand while the thumb is down', () => {
    const c = new ClawLogic(1).claws[0]
    const hand = { anchor: null }
    const pose = (p: [number, number, number]) => ({ ...restInput('face.hand', Mode.track), pose: { p, q: qIdentity(), tracked: true, touching: true, gen: 3 } })
    clawIntent(pose([0, 0, 0]), c, CABINETS[0], hand)
    const i = clawIntent(pose([0.1, 0, 0]), c, CABINETS[0], hand)
    expect(i.goal![0]).toBeCloseTo(c.x + 0.12)
  })
})

describe('claw machine: a go', () => {
  it('dropped right over a prize: down, closes, lifts, carries it to the chute, and it’s won', () => {
    const logic = new ClawLogic(1)
    const c = logic.claws[0]
    const p = logic.prizes[0][5]
    run(logic, () => pointAt(p.x, p.z), 3)
    logic.step([pointAt(p.x, p.z, ['wii-a'])], 1 / 60)
    const phases = new Set<string>()
    let won = false
    for (let t = 0; t < 12 && !won; t += 1 / 60) {
      logic.step([null], 1 / 60)
      phases.add(c.phase)
      won = logic.drain().some((e) => e.kind === 'score')
    }
    expect([...phases]).toEqual(expect.arrayContaining(['drop', 'close', 'lift', 'carry', 'open']))
    expect(won).toBe(true)
    expect(c.won).toBe(1)
    run(logic, () => null, 0.5)
    expect(c.phase).toBe('idle')
  })

  it('dropped on nothing: it closes on air and says so', () => {
    const logic = new ClawLogic(1)
    const c = logic.claws[0]
    logic.prizes[0].length = 0
    logic.step([idle({ presses: ['drop'] })], 1 / 60)
    let missed = false
    for (let t = 0; t < 6 && !missed; t += 1 / 60) { logic.step([null], 1 / 60); missed = logic.drain().some((e) => e.text === 'Missed') }
    expect(missed).toBe(true)
    run(logic, () => null, 5)
    expect(c.phase).toBe('idle')
    expect(c.y).toBeCloseTo(CLAW.top)
  })

  it('caught well off centre, it slips on the way up', () => {
    const logic = new ClawLogic(1)
    const p = logic.prizes[0][5]
    run(logic, () => pointAt(p.x + CLAW.catch * 0.7, p.z), 3)
    logic.step([pointAt(p.x + CLAW.catch * 0.7, p.z, ['wii-a'])], 1 / 60)
    let slipped = false
    for (let t = 0; t < 10 && !slipped; t += 1 / 60) { logic.step([null], 1 / 60); slipped = logic.drain().some((e) => e.text === 'It slipped!') }
    expect(slipped).toBe(true)
    expect(p.held).toBe(false)
    expect(logic.claws[0].held).toBe(-1)
  })

  it('never drops below the pit’s floor, and Home brings the claw back over the chute, open', () => {
    const logic = new ClawLogic(1)
    const c = logic.claws[0]
    logic.step([idle({ presses: ['drop'] })], 1 / 60)
    let low = Infinity
    for (let t = 0; t < 3; t += 1 / 60) { logic.step([null], 1 / 60); low = Math.min(low, c.y) }
    expect(low - CLAW.reach).toBeGreaterThanOrEqual(CLAW.floor)
    logic.home(0)
    expect([c.x, c.z, c.y, c.close, c.phase]).toEqual([CLAW.chute.x, CLAW.chute.z, CLAW.top, 0, 'idle'])
    expect(logic.readout(0)).toBe('0 won')
  })
})
