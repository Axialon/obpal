import { describe, expect, it, vi } from 'vitest'
import { machineParameters, airCutoff, dopplerRate } from '../src/sim/audio/models'
import { TUNING } from '../src/sim/audio/tuning'
import { integratedLoudness, normalisationGain } from '../src/sim/audio/loudness'
import { SampleBank, seamlessLoop } from '../src/sim/audio/samples'
import { hapticOf } from '../src/sim/audio/haptics'
import { VoiceBudget } from '../src/sim/audio/budget'
import { PROFILES } from '../src/sim/audio/profiles'
import type { SoundEvent } from '../src/sim/audio/events'

const motor = (rpm: number, load: number): SoundEvent => ({ kind: 'motor', source: 'test', at: [0, 0, -1], strength: 0.7, rpm, load })
function buffer(length = 4800, rate = 48000) {
  const data = Float32Array.from({ length }, (_, i) => Math.sin(i / rate * 2 * Math.PI * 440) * 0.1)
  return { numberOfChannels: 1, length, sampleRate: rate, getChannelData: () => data } as unknown as AudioBuffer
}
const context = () => ({ createBuffer: (_: number, length: number, rate: number) => buffer(length, rate), decodeAudioData: vi.fn(async () => buffer()) })

describe('round two acoustic models', () => {
  it('gives all 41 profiles a deliberate acoustic identity, including silent props and the untouched studio', () => {
    expect(Object.keys(TUNING).sort()).toEqual(PROFILES.map(p => p.id).sort())
    expect(PROFILES.every(p => p.tuning === TUNING[p.id])).toBe(true)
    expect(TUNING.lamp.machine).toBe('passive'); expect(TUNING.studio.level).toBe(0)
    expect(new Set(['drone', 'helicopter', 'plane', 'rover', 'vacuum'].map(id => TUNING[id].machine)).size).toBe(5)
  })
  it('moves servo pitch with speed while load changes mesh energy, and stalls strain at low pitch', () => {
    const quiet = machineParameters(TUNING.arm5, motor(0.5, 0.1)), loaded = machineParameters(TUNING.arm5, motor(0.5, 1))
    expect(quiet.rate).toBe(loaded.rate); expect(loaded.body).toBeGreaterThan(quiet.body)
    const stall = machineParameters(TUNING.arm5, motor(0, 1)), fast = machineParameters(TUNING.arm5, motor(1, 1))
    expect(stall.stall).toBeCloseTo(1); expect(fast.stall).toBe(0); expect(fast.rate).toBeGreaterThan(stall.rate * 3)
  })
  it('adds rotor loading and slap on a bank without inventing throttle', () => {
    const steady = machineParameters(TUNING.drone, motor(0.7, 0.4)), bank = machineParameters(TUNING.drone, { ...motor(0.7, 0.4), bank: 1 })
    expect(bank.rate).toBe(steady.rate); expect(bank.body).toBeGreaterThan(steady.body); expect(bank.bodyRate).toBeGreaterThan(steady.bodyRate)
    expect(machineParameters(TUNING.tank, { ...motor(0.6, 0.5), kind: 'sustain', texture: 'tracks' }).machine).toBe('tracks')
  })
  it('bounds invalid telemetry and leaves passive things quiet', () => {
    for (const p of PROFILES) for (const v of [NaN, Infinity, -10, 100]) {
      const m = machineParameters(p.tuning, { ...motor(v, v), strength: v, bank: v })
      expect([m.rate, m.gain, m.cutoff, m.body].every(Number.isFinite)).toBe(true)
      expect(m.body).toBeGreaterThanOrEqual(0); expect(m.body).toBeLessThanOrEqual(1)
    }
    expect(machineParameters(TUNING.viewer, motor(1, 1)).gain).toBe(0)
  })
  it('raises approach pitch, lowers departure pitch and accounts for a following listener', () => {
    const p = [0, 0, -10] as const, moving = [0, 0, 20] as const, zero = [0, 0, 0] as const
    expect(dopplerRate(p, moving, zero, zero)).toBeGreaterThan(1)
    expect(dopplerRate(p, [0, 0, -20], zero, zero)).toBeLessThan(1)
    expect(dopplerRate(p, moving, zero, moving)).toBe(1)
    expect(dopplerRate(p, [0, 0, 10000], zero, zero)).toBeLessThanOrEqual(1.18)
    expect(airCutoff(40, 15000)).toBeLessThan(airCutoff(1, 15000))
    expect(airCutoff(40, 15000, true)).toBeLessThan(airCutoff(40, 15000))
  })
  it('keeps an owned motor audible when unowned scenery competes for all strips', () => {
    const budget = new VoiceBudget(2)
    const motor = budget.take('controlled', 3, 0.1)
    budget.take('scenery', 1, 0.5); budget.take('collision', 2, 1)
    expect(budget.slots[motor].key).toBe('controlled')
  })
  it('distinguishes a servo stall, a hard bank, a footstep and quiet hover on the phone', () => {
    const stall = hapticOf({ ...motor(0, 1), texture: 'servo' })!
    const bank = hapticOf({ ...motor(0.7, 0.7), texture: 'rotor', bank: 1 })!
    const foot = hapticOf({ ...motor(0.5, 0.6), kind: 'footstep' })!
    expect(stall.strong).toBeGreaterThan(stall.weak); expect(bank.weak).toBeGreaterThan(bank.strong)
    expect(new Set([stall.ms, bank.ms, foot.ms]).size).toBe(3)
    expect(hapticOf({ ...motor(0.7, 0.3), texture: 'rotor', bank: 0 })).toBeNull()
  })
})

describe('loudness and loop preparation', () => {
  it('measures a -20 dBFS 1 kHz sine at about -23 LUFS, and stereo energy 3 dB higher', () => {
    const tone = Float32Array.from({ length: 96000 }, (_, i) => 0.1 * Math.sin(i * 2 * Math.PI * 1000 / 48000))
    const mono = integratedLoudness([tone], 48000)
    expect(mono).toBeCloseTo(-23, 0)
    expect(integratedLoudness([tone, tone], 48000) - mono).toBeCloseTo(3.0103, 2)
    expect(integratedLoudness([new Float32Array(48000)], 48000)).toBe(-Infinity)
  })
  it('gates long silence instead of turning up quiet tails, and limits boosts and peaks', () => {
    const tone = buffer(96000).getChannelData(0), padded = new Float32Array(480000); padded.set(tone)
    expect(Math.abs(integratedLoudness([padded], 48000) - integratedLoudness([tone], 48000))).toBeLessThan(0.6)
    expect(normalisationGain(-30, 0.1, -24)).toBeCloseTo(10 ** (6 / 20))
    expect(normalisationGain(-60, 0.01, -18)).toBeLessThanOrEqual(10 ** (12 / 20))
    expect(normalisationGain(-30, 0.9, -18) * 0.9).toBeCloseTo(10 ** (-3 / 20))
    expect(normalisationGain(-Infinity, 0)).toBe(1)
  })
  it('crossfades a recording without a silent loop boundary', () => {
    const c = context(), input = buffer(48000)
    const loop = seamlessLoop(c as unknown as BaseAudioContext, input, 0.1), data = loop.getChannelData(0)
    expect(loop.length).toBe(43200)
    expect(Math.abs(data[data.length - 1] - data[0])).toBeLessThan(0.01)
    expect(Math.max(...data.slice(0, 1000).map(Math.abs))).toBeGreaterThan(0.08)
  })
})

describe('lazy sample loading', () => {
  it('fetches nothing at construction, shares in-flight work and fetches only the requested set', async () => {
    const c = context(), fetcher = vi.fn(async () => new Response(new ArrayBuffer(8)))
    const bank = new SampleBank(c as unknown as BaseAudioContext, fetcher)
    expect(fetcher).not.toHaveBeenCalled()
    await Promise.all([bank.preload('wood'), bank.load('wood')])
    expect(fetcher).toHaveBeenCalledTimes(1); expect(bank.get('wood')).not.toBeNull(); expect(bank.get('suction')).toBeNull()
  })
  it('tries MP3 if Opus decoding fails, and keeps the procedural fallback if both fail', async () => {
    const c = context(); c.decodeAudioData.mockRejectedValueOnce(new Error('codec'))
    const fetcher = vi.fn(async (_url: RequestInfo | URL) => new Response(new ArrayBuffer(8))), bank = new SampleBank(c as unknown as BaseAudioContext, fetcher)
    expect(await bank.load('body')).not.toBeNull()
    expect(fetcher.mock.calls[1]?.[0]).toContain('.mp3')
    const broken = new SampleBank(c as unknown as BaseAudioContext, vi.fn(async () => new Response('', { status: 404 })))
    expect(await broken.load('latch')).toBeNull()
  })
  it('does not retain a decode that finishes after disposal', async () => {
    const c = context(); let done!: (b: AudioBuffer) => void
    c.decodeAudioData.mockImplementation(() => new Promise(resolve => { done = resolve }))
    const bank = new SampleBank(c as unknown as BaseAudioContext, vi.fn(async () => new Response(new ArrayBuffer(8))))
    const task = bank.load('body')
    await vi.waitFor(() => expect(done).toBeTypeOf('function')); bank.dispose(); done(buffer())
    expect(await task).toBeNull(); expect(bank.get('body')).toBeNull()
  })
})
