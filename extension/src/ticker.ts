/** Dedicated-worker clock for the offscreen sampler: worker timers keep a steady 60 Hz where a hidden document's may be throttled. */
const scope = self as unknown as { postMessage: (m: number) => void }
setInterval(() => scope.postMessage(0), 1000 / 60)
