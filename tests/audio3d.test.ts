import { describe, expect, it, vi } from 'vitest'
import { DEVICES } from '../src/sim/devices/registry'
import { ARM_KINDS } from '../src/sim/arm/kinds'
import { PROFILES, profileOf } from '../src/sim/audio/profiles'
import { SoundBus, deviceEvent, type SoundEvent } from '../src/sim/audio/events'
import { impactGain, materialPair, MATERIALS } from '../src/sim/audio/materials'
import { HapticGate, hapticOf } from '../src/sim/audio/haptics'
import { VoiceBudget } from '../src/sim/audio/budget'
import { restInput } from '../src/sim/devices/types'
import { RoverLogic } from '../src/sim/devices/rover'
import { KartLogic } from '../src/sim/devices/kart'
import { PinballLogic } from '../src/sim/devices/pinball'
import { SubmarineLogic } from '../src/sim/devices/submarine'
import { DeviceSound } from '../src/sim/audio/devices'
import type { SimSound } from '../src/sim/audio/engine'

const contact = (strength = 0.7): SoundEvent => ({ kind: 'contact', source: 'body', at: [1, 0, -2], strength })

describe('sim audio', () => {
  it('covers every shipped device, arm, arena and Viewer exactly once', () => {
    const ids = [...DEVICES.map(d => d.spec.id), ...ARM_KINDS.map(a => a.id), 'arena', 'viewer'].sort()
    expect(PROFILES.map(p => p.id).sort()).toEqual(ids)
    expect(ids).toHaveLength(42)
    expect(() => profileOf('missing')).toThrow()
  })
  it('reads finite world positions and motion for every device, at rest and while stepping', () => {
    for (const d of DEVICES) {
      if (d.spec.id === 'studio') continue
      const logic = d.logic(), p = profileOf(d.spec.id)
      const input = restInput(); input.touching = true; input.drag = [8, -12]
      for (let t = 0; t < 30; t++) {
        logic.step(Array.from({ length: d.spec.units }, () => input), 0.016)
        for (let n = 0; n < d.spec.units; n++) {
          const out = new Float64Array(11).fill(NaN)
          p.read!(logic, n, out)
          expect([...out].every(Number.isFinite), `${d.spec.id} ${n}`).toBe(true)
        }
      }
    }
  })
  it('maps contacts and actions without losing the owner or physics data', () => {
    const e = deviceEvent({ unit: 0, kind: 'bump', audio: { speed: 2, impulse: 3, materials: ['metal', 'wood'] } }, 'arm', [0, 1, 0], 'phone')
    expect(e).toMatchObject({ kind: 'contact', who: 'phone', speed: 2, impulse: 3, materials: ['metal', 'wood'] })
    expect(deviceEvent({ unit: 1, kind: 'score' }, 'ball', [0, 0, 0]).action).toBe('score')
    expect(deviceEvent({ unit: 1, kind: 'tick', audio: { action: 'fire' } }, 'tank', [0, 0, 0]).action).toBe('fire')
  })
  it('dispatches once and detaches listeners', () => {
    const bus = new SoundBus(), hear = vi.fn(), stop = bus.on(hear)
    bus.emit(contact()); stop(); bus.emit(contact())
    expect(hear).toHaveBeenCalledTimes(1)
  })
  it('scales impact energy, bounds loud contacts and rejects invalid data', () => {
    expect(impactGain(4, 4)).toBeGreaterThan(impactGain(1, 1))
    expect(impactGain(4, 0.1)).toBeLessThan(impactGain(4, 2))
    for (const n of [-2, 0, NaN, Infinity]) expect(impactGain(n)).toBe(0)
    expect(impactGain(100, 100)).toBe(1)
  })
  it('makes material pairs symmetric, with rubber damping glass and metal', () => {
    expect(materialPair('rubber', 'tile')).toEqual(materialPair('tile', 'rubber'))
    expect(materialPair('rubber', 'metal').decay).toBeLessThan(MATERIALS.metal.decay)
    expect(materialPair('glass', 'glass').hz).toBeGreaterThan(materialPair('wood', 'wood').hz)
  })
  it('holds 32 voices through a burst and steals quiet movement before impacts', () => {
    const b = new VoiceBudget()
    b.take('engine', 1, 0.1)
    for (let n = 0; n < 31; n++) b.take(`hit${n}`, 3, 0.5)
    expect(b.take('next', 3, 1)).toBe(0)
    expect(b.take('quiet', 1, 0.01)).toBe(-1)
    for (let n = 0; n < 100; n++) b.take(`hit${n}`, 3, 0.5)
    expect(b.active).toBe(32); expect(b.stolen).toBe(101)
    b.release(4); expect(b.take('available', 0, 0.1)).toBe(4)
  })
  it('maps the same collision strength to feedback, independently of audio', () => {
    expect(hapticOf(contact(1))!.strong).toBeGreaterThan(hapticOf(contact(0.2))!.strong)
    expect(hapticOf(contact(0))).toBeNull()
    expect(hapticOf({ ...contact(), kind: 'motor', texture: 'servo' })!.ms).toBe(12)
  })
  it('limits a participant to ten contacts per second across multiple sources', () => {
    const gate = new HapticGate(), times: number[] = []
    for (let ms = 0; ms < 1000; ms++) if (gate.accept('one', { ...contact(), source: String(ms % 4) }, ms)) times.push(ms)
    expect(times).toHaveLength(10)
    expect(gate.accept('two', contact(), 1)).toBe(true)
    gate.drop('one'); expect(gate.accept('one', contact(), 1)).toBe(true)
  })
  it('gives motors a quieter 400 ms cadence, leaving room for contacts', () => {
    const gate = new HapticGate(), motor: SoundEvent = { ...contact(), kind: 'motor' }
    expect(gate.accept('one', motor, 0)).toBe(true)
    expect(gate.accept('one', motor, 100)).toBe(false)
    expect(gate.accept('one', contact(), 100)).toBe(true)
    expect(gate.accept('one', motor, 400)).toBe(true)
  })
  it('routes coasting motion and collisions from logic, with no controller input', () => {
    const logic = new RoverLogic(), bus = new SoundBus(), heard: SoundEvent[] = []
    bus.on(e => heard.push({ ...e }))
    const sound = { profile: profileOf('rover'), bus, tick: vi.fn() } as unknown as SimSound
    const adapter = new DeviceSound(logic, sound, n => n === 0 ? 'driver' : undefined)
    logic.rovers[0].v = 2
    adapter.update(100, [{ unit: 0, kind: 'bump', audio: { speed: 2 } }])
    expect(heard.some(e => e.kind === 'motor' && e.who === 'driver')).toBe(true)
    expect(heard.some(e => e.kind === 'contact' && e.speed === 2 && e.who === 'driver')).toBe(true)
  })
  it('emits measured contacts from kart, pinball and submarine physics', () => {
    const kart = new KartLogic(); Object.assign(kart.units[0], { x: 10.19, z: 0, vx: 4, vz: 0, v: 4, h: -Math.PI / 2 }); kart.step([], 0.05)
    expect(kart.drain().some(e => (e.audio?.speed ?? 0) > 0)).toBe(true)
    const pin = new PinballLogic(); Object.assign(pin.units[0], { active: true, x: 0.65, z: 0, vx: 4 }); pin.step([], 0.04)
    expect(pin.drain().some(e => (e.audio?.speed ?? 0) > 0)).toBe(true)
    const sub = new SubmarineLogic(); Object.assign(sub.units[0], { y: 0.66, vy: -1 }); sub.step([], 0.05)
    expect(sub.drain().some(e => (e.audio?.speed ?? 0) > 0)).toBe(true)
  })
})
