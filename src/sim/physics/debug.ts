import type { PhysicsDiagnostics } from './world'

/** A local opt-in readout; no timer, telemetry, network or hardware access. */
export function physicsOverlay(host: HTMLElement, read: () => PhysicsDiagnostics) {
  const output = document.createElement('output')
  output.setAttribute('aria-label', 'Simulation physics diagnostics')
  output.style.cssText = 'position:absolute;left:12px;bottom:12px;z-index:2;pointer-events:none;white-space:pre;font:11px/1.5 monospace;padding:8px 10px;border-radius:8px;color:inherit;background:var(--panel-bg,#151b20)'
  host.append(output)
  let last = -Infinity
  return {
    update(now: number) {
      if (now - last < .25) return
      last = now
      const s = read()
      output.textContent = `${s.backend} · ${s.bodies} bodies · ${s.sleeping} sleeping\ntick ${s.tick} · ${s.steps} steps · blend ${s.alpha.toFixed(2)}\ndropped ${s.droppedSeconds.toFixed(3)} s · invalid frames ${s.invalidFrames}`
    },
    dispose() { output.remove() },
  }
}
