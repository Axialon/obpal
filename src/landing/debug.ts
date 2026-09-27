/**
 * ?debug=audio,gfx on the home page: a small readout in the corner, to read on a real device what the tests can't
 * hear or see there. audio: the audio context's state (and an iPhone's audio session: `playback` is heard with the
 * silent switch on), the output's level (what reaches the speakers, from a meter at the very end of the chain), the
 * hits played (of each kind: a wall is the edge of the screen) and skipped, the output's latency (the context's base
 * latency and the device's output latency, each as the browser reports it: a Bluetooth link shows here) and how long
 * after it happened the last knock reached the speakers (and how much of that was ours: nothing, but for keeping a
 * knock in step with an earlier one the same frame; below 0, it was foreseen and started ahead), the knocks foreseen
 * (how much of the lag that makes up, and how many were met by the knock itself, called off, or heard though the knock
 * never came), and the last few knocks: how fast each came in (em/s) and whether it was heard (how loud) or why not
 * (too soft, sound blocked or off, too many ringing). gfx: the canvas and its drawing buffer, the quality step the
 * governor chose, multisampling, and the GPU's time per frame where the browser can measure it. Loaded only when asked
 * for.
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
      lines.push(`audio  ${a.state}  (context: ${a.context ?? 'not made yet'}${a.session ? `, session: ${a.session}` : ''})`)
      lines.push(`level  ${dbs(a.levelDb)}   peak ${dbs(a.peakDb)}`)
      const kinds = Object.entries(a.kinds).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(', ')
      lines.push(`hits   ${a.played} played${kinds ? ` (${kinds})` : ''}, ${a.skipped} skipped`)
      if (a.rate) lines.push(`       ${a.rate} Hz, latency ${a.baseMs ?? '?'} ms base + ${a.outputMs ?? '?'} ms output`)
      if (a.behindMs !== null) lines.push(`       last knock at the speakers ${a.behindMs} ms after it happened (ours ${a.oursMs ?? 0} ms)`)
      const f = a.foreseen
      if (f.leadMs || f.met || f.calledOff || f.wrong) lines.push(`       foreseen ${f.leadMs} ms ahead: ${f.met} met, ${f.calledOff} called off, ${f.wrong} never came`)
      // Newest first: what, how fast, and what became of it.
      a.log.slice(-5).reverse().forEach((k, i) => {
        const what = k.verdict === 'heard' ? `heard, ${k.db} dB` : k.verdict
        lines.push(`${i ? '      ' : 'knock '} ${k.kind.padEnd(6)} ${k.speed.toFixed(2)} em/s  ${what}`)
      })
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
