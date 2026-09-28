/** ITU-R BS.1770 K weighting with 400 ms blocks, 100 ms hops and two-stage gating. */
export function integratedLoudness(channels: readonly Float32Array[], rate: number) {
  if (!channels.length || !channels[0].length) return -Infinity
  const length = channels[0].length, energy = new Float64Array(length)
  const filter = (data: Float64Array, f: number, q: number, gain?: number) => {
    const k = Math.tan(Math.PI * f / rate), k2 = k * k, norm = 1 / (1 + k / q + k2)
    const vh = gain === undefined ? 1 : 10 ** (gain / 20), vb = vh ** 0.4996667741545416
    const b0 = gain === undefined ? 1 : (vh + vb * k / q + k2) * norm
    const b1 = gain === undefined ? -2 : 2 * (k2 - vh) * norm
    const b2 = gain === undefined ? 1 : (vh - vb * k / q + k2) * norm
    const a1 = 2 * (k2 - 1) * norm, a2 = (1 - k / q + k2) * norm
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0
    for (let i = 0; i < data.length; i++) {
      const x = data[i], y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
      x2 = x1; x1 = x; y2 = y1; y1 = y; data[i] = y
    }
  }
  for (const channel of channels) {
    const data = Float64Array.from(channel, x => Number.isFinite(x) ? x : 0)
    filter(data, 1681.974450955533, 0.7071752369554196, 3.999843853973347)
    filter(data, 38.13547087602444, 0.5003270373238773)
    for (let i = 0; i < length; i++) energy[i] += data[i] * data[i]
  }
  const block = Math.min(length, Math.round(rate * 0.4)), hop = Math.round(rate * 0.1), powers: number[] = []
  let sum = 0
  for (let i = 0; i < length; i++) {
    sum += energy[i]
    if (i >= block) sum -= energy[i - block]
    if (i >= block - 1 && (i - block + 1) % hop === 0) powers.push(Math.max(0, sum / block))
  }
  const lufs = (power: number) => -0.691 + 10 * Math.log10(power)
  const absolute = powers.filter(p => lufs(p) > -70)
  if (!absolute.length) return -Infinity
  const relative = lufs(absolute.reduce((a, b) => a + b, 0) / absolute.length) - 10
  const gated = absolute.filter(p => lufs(p) >= relative)
  return lufs(gated.reduce((a, b) => a + b, 0) / gated.length)
}

/** Bounded offline gain: never raise silence, never exceed the sample-peak ceiling. */
export function normalisationGain(lufs: number, peak: number, target = -18, ceiling = -3) {
  if (!Number.isFinite(lufs) || !Number.isFinite(peak) || peak < 0.00001) return 1
  return Math.min(10 ** (Math.min(12, target - lufs) / 20), 10 ** (ceiling / 20) / peak)
}

export function normaliseBuffer(buffer: AudioBuffer, target: number) {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, n) => buffer.getChannelData(n))
  let peak = 0
  for (const data of channels) for (const x of data) peak = Math.max(peak, Math.abs(x))
  const gain = normalisationGain(integratedLoudness(channels, buffer.sampleRate), peak, target)
  for (const data of channels) for (let i = 0; i < data.length; i++) data[i] *= gain
  return buffer
}
