/**
 * The hero's sound: glass marbles, synthesized (nothing to download). A marble that comes down on a letter or the
 * floor, knocks into a letter's side, or clinks against another marble makes the sound of it: louder and brighter the
 * harder it hit, a heavier knock on a letter than a tick on the floor, a ring of glass on glass, and each one heard
 * from where it happened, left to right. Browsers let a page make sound only after a click or a tap, so it starts
 * from one, and a person can switch it off (remembered on this device).
 */
export type GlassHit = 'letter' | 'floor' | 'marble'

export interface Glass {
  /** Switch sound on (from a click or a tap, or where the page already had one) or off. Resolves whether it's on. */
  set(on: boolean): Promise<boolean>
  readonly on: boolean
  /** Whether the person switched it off here before. */
  readonly muted: boolean
  /** A hit: on what, how hard (0…1), and where (-1 left … 1 right). */
  hit(kind: GlassHit, strength: number, pan: number): void
}

/** The partials of each kind of hit: frequency ratios to its pitch, their loudness, and how long each rings (s). */
const VOICES: Record<GlassHit, { pitch: [number, number]; modes: [number, number, number][]; body: number; click: number }> = {
  letter: { pitch: [1350, 1650], modes: [[1, 1, 0.07], [2.41, 0.45, 0.045], [3.98, 0.25, 0.03], [5.93, 0.12, 0.02]], body: 0.55, click: 0.5 },
  floor: { pitch: [2100, 2500], modes: [[1, 1, 0.05], [2.76, 0.4, 0.035], [5.4, 0.2, 0.02]], body: 0.25, click: 0.6 },
  marble: { pitch: [2900, 3500], modes: [[1, 1, 0.22], [2.76, 0.55, 0.14], [5.4, 0.3, 0.08], [8.93, 0.14, 0.05]], body: 0, click: 0.35 },
}
const STORE = 'obpal.sound'
/** At most this many hits a second (a tumble of marbles stays a sound, not a roar). */
const MAX_RATE = 28

export function createGlass(): Glass {
  let ctx: AudioContext | null = null
  let out: GainNode | null = null
  let noise: AudioBuffer | null = null
  let on = false
  const recent: number[] = []
  const read = () => { try { return localStorage.getItem(STORE) } catch { return null } }
  const write = (v: string) => { try { localStorage.setItem(STORE, v) } catch { /* private mode: not remembered */ } }

  function ready(): AudioContext | null {
    if (ctx) return ctx
    const AC = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    ctx = new AC()
    // Loud hits together are held under the ceiling rather than clipped.
    const limit = ctx.createDynamicsCompressor()
    limit.threshold.value = -14
    limit.ratio.value = 8
    limit.attack.value = 0.002
    limit.release.value = 0.12
    out = ctx.createGain()
    out.gain.value = 0.55
    out.connect(limit).connect(ctx.destination)
    // A short burst of noise: the click of the contact itself.
    noise = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.03), ctx.sampleRate)
    const d = noise.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (d.length * 0.18))
    return ctx
  }

  return {
    get on() { return on },
    get muted() { return read() === 'off' },
    async set(want) {
      if (!want) {
        on = false
        write('off')
        await ctx?.suspend().catch(() => undefined)
        return false
      }
      const c = ready()
      if (!c) return false
      // Asked for, so heard: on an iPhone, the silent switch would otherwise mute a page's sound.
      const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession
      if (session) try { session.type = 'playback' } catch { /* older Safari */ }
      try { await c.resume() } catch { /* not allowed yet */ }
      on = c.state === 'running'
      if (on) write('on')
      return on
    },
    hit(kind, strength, pan) {
      if (!on || !ctx || !out || ctx.state !== 'running') return
      const now = ctx.currentTime
      while (recent.length && now - recent[0] > 1) recent.shift()
      if (recent.length >= MAX_RATE) return
      recent.push(now)
      const s = Math.max(0, Math.min(1, strength))
      const v = VOICES[kind]
      const t = now + 0.005
      const hit = ctx.createGain()
      hit.gain.value = 0.08 + 0.62 * s * s
      // Harder hits are brighter: more of the high partials get through.
      const tone = ctx.createBiquadFilter()
      tone.type = 'lowpass'
      tone.frequency.value = 2600 + 12000 * s
      let last: AudioNode = hit
      if (typeof ctx.createStereoPanner === 'function') {
        const p = ctx.createStereoPanner()
        p.pan.value = Math.max(-0.85, Math.min(0.85, pan))
        hit.connect(p)
        last = p
      }
      last.connect(tone).connect(out)
      const pitch = v.pitch[0] + Math.random() * (v.pitch[1] - v.pitch[0])
      for (const [ratio, amp, ring] of v.modes) {
        const o = ctx.createOscillator()
        o.frequency.value = pitch * ratio * (1 + (Math.random() - 0.5) * 0.012)
        const g = ctx.createGain()
        const len = ring * (0.7 + 0.6 * s)
        g.gain.setValueAtTime(0, t)
        g.gain.linearRampToValueAtTime(amp, t + 0.0015)
        g.gain.exponentialRampToValueAtTime(1e-4, t + len)
        o.connect(g).connect(hit)
        o.start(t)
        o.stop(t + len + 0.02)
      }
      // The weight of it: a short low knock under the ring (none for glass on glass).
      if (v.body > 0) {
        const o = ctx.createOscillator()
        o.type = 'sine'
        o.frequency.setValueAtTime(210 + 60 * s, t)
        o.frequency.exponentialRampToValueAtTime(110, t + 0.05)
        const g = ctx.createGain()
        g.gain.setValueAtTime(0, t)
        g.gain.linearRampToValueAtTime(v.body * (0.4 + 0.6 * s), t + 0.002)
        g.gain.exponentialRampToValueAtTime(1e-4, t + 0.06)
        o.connect(g).connect(hit)
        o.start(t)
        o.stop(t + 0.08)
      }
      if (noise && v.click > 0) {
        const n = ctx.createBufferSource()
        n.buffer = noise
        const hp = ctx.createBiquadFilter()
        hp.type = 'highpass'
        hp.frequency.value = 2400
        const g = ctx.createGain()
        g.gain.value = v.click * (0.3 + 0.7 * s)
        n.connect(hp).connect(g).connect(hit)
        n.start(t)
      }
    },
  }
}
