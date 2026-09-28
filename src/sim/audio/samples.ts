import { normaliseBuffer } from './loudness'
import type { SampleSet } from './tuning'

export const SAMPLE_FILES = {
  latch: [new URL('./assets/latch.webm?no-inline', import.meta.url).href, new URL('./assets/latch.mp3?no-inline', import.meta.url).href],
  body: [new URL('./assets/body.webm?no-inline', import.meta.url).href, new URL('./assets/body.mp3?no-inline', import.meta.url).href],
  'foot-a': [new URL('./assets/foot-a.webm?no-inline', import.meta.url).href, new URL('./assets/foot-a.mp3?no-inline', import.meta.url).href],
  'foot-b': [new URL('./assets/foot-b.webm?no-inline', import.meta.url).href, new URL('./assets/foot-b.mp3?no-inline', import.meta.url).href],
  wood: [new URL('./assets/wood.webm?no-inline', import.meta.url).href, new URL('./assets/wood.mp3?no-inline', import.meta.url).href],
  suction: [new URL('./assets/suction.webm?no-inline', import.meta.url).href, new URL('./assets/suction.mp3?no-inline', import.meta.url).href],
} as const
export type SampleName = keyof typeof SAMPLE_FILES
export const SAMPLE_SETS: Record<SampleSet, readonly SampleName[]> = {
  mechanical: ['latch', 'body'], feet: ['foot-a', 'foot-b', 'body'], vacuum: ['suction', 'body', 'latch'], wood: ['wood'], none: [],
}

/** Rotate the seam through a crossfade. Unlike fading both ends, this never makes a hole each lap. */
export function seamlessLoop(c: BaseAudioContext, input: AudioBuffer, seconds = 0.25) {
  const fade = Math.min(Math.round(seconds * input.sampleRate), Math.floor(input.length / 4))
  const buffer = c.createBuffer(input.numberOfChannels, input.length - fade, input.sampleRate)
  for (let ch = 0; ch < input.numberOfChannels; ch++) {
    const from = input.getChannelData(ch), to = buffer.getChannelData(ch)
    for (let i = 0; i < to.length; i++) {
      const w = Math.min(1, i / Math.max(1, fade - 1)), mix = w * w * (3 - 2 * w)
      to[i] = i < fade ? from[to.length + i] * (1 - mix) + from[i] * mix : from[i]
    }
  }
  return buffer
}

/** Fetch after unlock, only this sim's set. Decode failure tries MP3, then synthesis remains available. */
export class SampleBank {
  private buffers = new Map<SampleName, AudioBuffer>()
  private pending = new Map<SampleName, Promise<AudioBuffer | null>>()
  private abort = new AbortController()
  bytes = 0
  constructor(private c: BaseAudioContext, private fetcher: typeof fetch = (url, init) => fetch(url, init)) {}
  get(name: SampleName) { return this.buffers.get(name) ?? null }
  preload(set: SampleSet) { return Promise.all(SAMPLE_SETS[set].map(name => this.load(name))) }
  load(name: SampleName): Promise<AudioBuffer | null> {
    const pending = this.pending.get(name)
    if (pending) return pending
    const task = (async () => {
      for (const url of SAMPLE_FILES[name]) {
        if (this.abort.signal.aborted) return null
        try {
          const response = await this.fetcher(url, { signal: this.abort.signal })
          if (!response.ok) continue
          const bytes = await response.arrayBuffer(); this.bytes += bytes.byteLength
          let buffer = await this.c.decodeAudioData(bytes)
          if (this.abort.signal.aborted) return null
          if (name === 'suction') buffer = seamlessLoop(this.c, buffer)
          normaliseBuffer(buffer, name === 'suction' ? -16 : -20)
          this.buffers.set(name, buffer)
          return buffer
        } catch { /* Try the portable encoding; the procedural voice is always ready. */ }
      }
      return null
    })()
    this.pending.set(name, task)
    return task
  }
  dispose() { this.abort.abort(); this.buffers.clear(); this.pending.clear() }
}
