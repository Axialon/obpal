/**
 * ?debug=audio,gfx on the home page: a small readout in the corner, to read on a real device what the tests can't
 * hear or see there. audio: the audio context's state, the output's level (what reaches the speakers, from a meter at
 * the very end of the chain) and the hits played (of each kind: a wall is the edge of the screen) and skipped. gfx:
 * the canvas and its drawing buffer, the quality step
 * the governor chose, multisampling, and the GPU's time per frame where the browser can measure it.
 * Loaded only when asked for.
 */
import type { GlassStats } from './glass'
import type { Hero } from './hero'

export function mountDebug(kinds: Set<string>, src: { audio: () => GlassStats; gfx: Hero['gfx'] }) {
  const box = document.createElement('pre')
  box.setAttribute('aria-hidden', 'true')
  Object.assign(box.style, {
    position: 'fixed', left: '10px', bottom: '10px', zIndex: '90', margin: '0', padding: '8px 10px', maxWidth: 'calc(100vw - 20px)',
    borderRadius: '10px', background: 'rgb(4 2 14 / 0.82)', border: '1px solid rgb(179 164 255 / 0.3)', color: '#e9e4ff',
    font: '500 11.5px/1.45 ui-monospace, "JetBrains Mono", monospace', whiteSpace: 'pre-wrap', pointerEvents: 'none',
  })
  document.body.appendChild(box)
  const dbs = (v: number | null) => (v === null ? 'n/a' : Number.isFinite(v) ? `${v.toFixed(1)} dBFS` : 'silent')
  const show = () => {
    const lines: string[] = []
    if (kinds.has('audio')) {
      const a = src.audio()
      lines.push(`audio  ${a.state}  (context: ${a.context ?? 'not made yet'})`)
      lines.push(`level  ${dbs(a.levelDb)}   peak ${dbs(a.peakDb)}`)
      const kinds = Object.entries(a.kinds).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(', ')
      lines.push(`hits   ${a.played} played${kinds ? ` (${kinds})` : ''}, ${a.skipped} skipped`)
      if (a.rate) lines.push(`       ${a.rate} Hz, ${a.latencyMs} ms latency`)
    }
    if (kinds.has('gfx')) {
      const g = src.gfx()
      if (!g) lines.push('gfx    no 3D field')
      else {
        const s = g.steps[g.level]
        lines.push(`gfx    step ${g.level + 1}/${g.steps.length}${g.pinned ? ' (held)' : ''}: ${s.pr}x pixels, glass ${s.glass}`)
        lines.push(`       canvas ${g.css.map((v) => Math.round(v)).join('x')} css, buffer ${g.buffer.join('x')} (${g.pr}x, dpr ${devicePixelRatio})`)
        lines.push(`       msaa ${g.samples}, behind ${g.behind.join('x')}, gpu ${g.gpuMs === null ? 'n/a' : `${g.gpuMs.toFixed(2)} ms`}`)
      }
    }
    box.textContent = lines.join('\n')
  }
  show()
  setInterval(show, 200)
}
