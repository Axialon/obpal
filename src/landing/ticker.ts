/**
 * One animation loop for the whole home page. Each actor draws a frame and says whether it's still busy; the loop
 * stops the moment none is, and never runs in a hidden tab, so a page left open costs nothing.
 */
export type Actor = (now: number, dt: number) => boolean

const actors = new Set<Actor>()
let running = false
let last = 0
let frame = 0

export function addActor(a: Actor) {
  actors.add(a)
  wake()
}

export function wake() {
  if (running || document.hidden) return
  running = true
  last = 0
  frame = requestAnimationFrame(tick)
}

function tick(now: number) {
  if (document.hidden) { running = false; last = 0; return }
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60
  last = now
  let busy = false
  // One actor failing mustn't stop the others, or leave the loop thinking it still runs.
  for (const a of actors) { try { busy = a(now, dt) || busy } catch (e) { console.error(e) } }
  if (busy && !document.hidden) frame = requestAnimationFrame(tick)
  else running = false
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { cancelAnimationFrame(frame); running = false; last = 0 }
  else wake()
})
