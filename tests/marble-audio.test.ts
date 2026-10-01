import { afterEach, expect, it, vi } from 'vitest'
import { MarblerunLogic, marblePitch, marblePosition } from '../src/sim/devices/marblerun'
import { restInput } from '../src/sim/devices/types'
import { SoundBus, deviceEvent, type SoundEvent } from '../src/sim/audio/events'
import { DeviceSound } from '../src/sim/audio/devices'
import { SimSound } from '../src/sim/audio/engine'
import { profileOf } from '../src/sim/audio/profiles'
import { SoundBuffers } from '../src/sim/audio/synthesis'
import { glassDragParameters } from '../src/sim/audio/materials'
import { hapticOf } from '../src/sim/audio/haptics'
import { VoiceBudget } from '../src/sim/audio/budget'

function buffer(channels: number, length: number, sampleRate: number) {
  const data = Array.from({ length: channels }, () => new Float32Array(length))
  return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: (n: number) => data[n] } as AudioBuffer
}
const context = { sampleRate: 48000, createBuffer: buffer } as BaseAudioContext
function run() {
  const logic = new MarblerunLogic(), u = logic.units[0], input = restInput()
  u.track[12] = { kind: 0, turn: 0 }; u.running = true
  return { logic, u, input }
}

it('resolves real pairs using closing normal speed, gives each pair its own contact source and separates overlaps', () => {
  const { logic, u, input } = run()
  Object.assign(u, { x: -0.5, vx: 1 })
  Object.assign(u.marbles[0], { x: -0.395, vx: -0.5 })
  u.marbles[1].x = 0.5
  logic.step([input], (1 / 240))
  const hits = logic.drain().filter(e => e.audio?.glass === 'clack')
  expect(hits).toHaveLength(1)
  expect(hits[0].audio?.speed).toBeCloseTo(1.5, 1)
  expect(u.vx).toBeLessThan(u.marbles[0].vx)
  expect(u.marbles[0].x - u.x).toBeGreaterThanOrEqual(u.radius + u.marbles[0].radius - 1e-10)
  const e = deviceEvent(hits[0], 'marblerun0', [0, 0, 0], 'holder')
  expect(e).toMatchObject({ source: 'marblerun0:pair:0:1', glass: 'clack', materials: ['glass', 'glass'], who: 'holder' })
  expect(hapticOf(e)?.ms).toBeLessThan(35)
})

it('ignores tangential encounters and resting pairs, and does not chatter under a sustained queue push', () => {
  const { logic, u, input } = run()
  Object.assign(u, { x: -0.5, z: 0, vx: 0, vz: 0.5 })
  Object.assign(u.marbles[0], { x: -0.396, z: 0, vx: 0, vz: -0.5 })
  u.marbles[1].x = 0.5
  logic.step([input], (1 / 240))
  expect(logic.drain().filter(e => e.audio?.glass === 'clack')).toHaveLength(0)
  Object.assign(u, { x: -0.5, z: 0, vx: 0, vz: 0 })
  Object.assign(u.marbles[0], { x: -0.395, z: 0, vx: 0, vz: 0 })
  for (let n = 0; n < 80; n++) { u.vx = 0.2; logic.step([input], (1 / 240)) }
  expect(logic.drain().filter(e => e.audio?.glass === 'clack')).toHaveLength(0)
})

it('rearms a separated pair and keeps rail events separate from pairs and launch', () => {
  const { logic, u, input } = run()
  const collide = () => { Object.assign(u, { x: -0.5, vx: 1 }); Object.assign(u.marbles[0], { x: -0.395, vx: 0 }); u.marbles[1].x = 0.5; logic.step([input], (1 / 240)) }
  collide(); expect(logic.drain().filter(e => e.audio?.glass === 'clack')).toHaveLength(1)
  u.marbles[0].x = 0; logic.step([input], 0.05); logic.step([input], 0.05); logic.drain()
  collide(); expect(logic.drain().filter(e => e.audio?.glass === 'clack')).toHaveLength(1)
  Object.assign(u, { x: -0.7, z: 0.124, vz: 1 }); logic.step([input], 0.01)
  expect(logic.drain().some(e => e.audio?.glass === 'track' && e.audio?.source?.startsWith('rail:'))).toBe(true)
  logic.home(0); input.presses = ['run']; logic.step([input], 0.01)
  expect(logic.drain().some(e => e.audio?.action === 'glass-launch')).toBe(true)
})

it('derives singing from slip, suppresses loaded contacts, and continues quiet coasting when the holder is lost', () => {
  const { logic, u, input } = run()
  u.vx = 1; logic.step([input], 0.02)
  expect(u.slip).toBeGreaterThan(0.5)
  const heard: SoundEvent[] = [], bus = new SoundBus()
  bus.on(e => heard.push({ ...e }))
  const sound = { profile: profileOf('marblerun'), bus, tick: vi.fn() } as unknown as SimSound
  const adapter = new DeviceSound(logic, sound, () => 'holder')
  adapter.update(100, [])
  expect(heard.some(e => e.glass === 'drag' && e.strength > 0 && e.who === 'holder')).toBe(true)
  expect(glassDragParameters(0.1, 1).strength).toBe(0)
  expect(glassDragParameters(1, 2).strength).toBe(0)
  expect(glassDragParameters(100, 0).strength).toBe(0.2)
  logic.step([], 0.05)
  expect(u.slip).toBeGreaterThan(0)
  expect(u.vx).not.toBe(0)
  heard.length = 0; adapter.update(200, [])
  expect(heard.some(e => e.glass === 'roll' && e.strength > 0)).toBe(true)
})

it('sets pitch from size and mass with stable small per-marble detuning, and places sounds on the tilted board', () => {
  const { u } = run()
  expect(marblePitch({ ...u, radius: u.radius * 0.8 })).toBeGreaterThan(marblePitch(u))
  expect(marblePitch({ ...u, mass: u.mass * 2 })).toBeLessThan(marblePitch(u))
  expect(marblePitch(u)).toBe(marblePitch(u))
  expect(Math.abs(u.detune)).toBeLessThanOrEqual(0.0175)
  const at = marblePosition(1, u, 1, 0)
  expect(at[0]).toBeCloseTo(3.8 + u.x * Math.cos(-0.08) - u.radius * Math.sin(-0.08))
  expect(at[1]).toBeCloseTo(0.9 + u.x * Math.sin(-0.08) + u.radius * Math.cos(-0.08))
})

function energy(data: Float32Array, from: number, to: number) { return data.slice(from, to).reduce((s, v) => s + v * v, 0) }
function spectrum(data: Float32Array, rate: number, scale = 1) {
  const powers: { hz: number; power: number }[] = [], length = Math.min(4096, data.length)
  for (let hz = 100; hz < 11000; hz += 25) {
    let re = 0, im = 0
    for (let i = 0; i < length; i++) {
      const v = data[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / length)), phase = 2 * Math.PI * hz * i / (rate * scale)
      re += v * Math.cos(phase); im += v * Math.sin(phase)
    }
    powers.push({ hz, power: re * re + im * im })
  }
  return powers
}

it('keeps clack energy above 2 kHz with a fast tail, a distinct track resonance and bounded peaks', () => {
  const buffers = new SoundBuffers(context), clack = buffers.glassClack().getChannelData(0), track = buffers.glassTrack().getChannelData(0)
  const bins = spectrum(clack, 48000), high = bins.filter(b => b.hz > 2000).reduce((s, b) => s + b.power, 0), total = bins.reduce((s, b) => s + b.power, 0)
  expect(high / total).toBeGreaterThan(0.95)
  expect(energy(clack, 4800, clack.length) / energy(clack, 0, 2400)).toBeLessThan(0.0001)
  expect(bins.sort((a, b) => b.power - a.power)[0].hz).toBeCloseTo(3150, -1)
  expect(Math.abs(spectrum(track, 48000).sort((a, b) => b.power - a.power)[0].hz - 2240)).toBeLessThanOrEqual(25)
  for (const data of [clack, track, buffers.glassDrag().getChannelData(0), buffers.glassRoll().getChannelData(0)]) expect(data.every(v => Number.isFinite(v) && Math.abs(v) <= 10 ** (-3 / 20))).toBe(true)
})

it('moves the rendered singing spectrum upwards with slip without a low clank', () => {
  const drag = new SoundBuffers(context).glassDrag().getChannelData(0).slice(24000, 28096)
  const slow = glassDragParameters(0.2, 1), fast = glassDragParameters(1.2, 1)
  const peak = (scale: number) => spectrum(drag, 48000, scale).sort((a, b) => b.power - a.power)[0].hz
  expect(peak(fast.rate)).toBeGreaterThan(peak(slow.rate) * 1.4)
  expect(Math.abs(peak(slow.rate) - 2700 * slow.rate)).toBeLessThan(50)
  expect(hapticOf({ kind: 'sustain', source: 'drag', at: [0, 0, 0], strength: 1, glass: 'drag' })).toBeNull()
})

it('retains the loudest contacts regardless of burst order', () => {
  const budget = new VoiceBudget(4)
  for (const [n, level] of [0.7, 0.4, 0.8, 0.9, 0.1, 0.6, 0.2].entries()) budget.take(`pair${n}`, 4, level)
  expect(budget.active).toBe(4)
  expect(budget.slots.map(s => s.level).sort()).toEqual([0.6, 0.7, 0.8, 0.9])
})

afterEach(() => vi.unstubAllGlobals())

it('bounds singing to two voices in the real engine path and lets clicks displace the quiet layers', async () => {
  const parameter = () => ({ value: 0, setTargetAtTime: vi.fn(), setValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(), linearRampToValueAtTime: vi.fn() })
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: parameter(), frequency: parameter(), Q: parameter(), positionX: parameter(), positionY: parameter(), positionZ: parameter(), playbackRate: parameter(), start: vi.fn(), stop: vi.fn(), threshold: parameter(), knee: parameter(), ratio: parameter(), attack: parameter(), release: parameter(), stream: { getTracks: () => [] } })
  const c = { ...context, currentTime: 0, state: 'running', resume: async () => {}, createGain: node, createBiquadFilter: node, createConvolver: node, createDynamicsCompressor: node, createWaveShaper: node, createAnalyser: node, createMediaStreamDestination: node, createPanner: node, createBufferSource: node }
  vi.stubGlobal('AudioContext', function () { return c })
  vi.stubGlobal('document', { hidden: false })
  const sound = new SimSound(profileOf('marblerun'), vi.fn())
  await sound.start()
  for (let n = 0; n < 8; n++) sound.bus.emit({ kind: 'sustain', source: `marble${n}`, glass: 'drag', strength: 0.1 + n * 0.01, at: [n, 1, 0], pitch: 1 })
  expect(sound.budget.slots.filter(s => s.active && s.key.endsWith(':drag'))).toHaveLength(2)
  for (let n = 0; n < 50; n++) sound.bus.emit({ kind: 'contact', source: `pair${n}`, glass: 'clack', speed: 1, strength: 0.2, at: [0, 1, 0] })
  expect(sound.budget.active).toBe(32)
  expect(sound.budget.slots.every(s => s.key.startsWith('pair'))).toBe(true)
  sound.stop(); expect(sound.budget.active).toBe(0)
  sound.dispose()
})
