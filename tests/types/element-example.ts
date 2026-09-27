/**
 * The typed example in packages/host/README.md, kept compiling: the typecheck fails when the element's types drift from
 * what the README tells people to write. Not run.
 */
import { defineObpalRemote, type ObpalRemote } from '@obpal/host/element'
import { Controller, Remote, type Frame } from '@obpal/host'

declare const cube: { position: { x: number; y: number }; scale: { multiplyScalar(k: number): void } }
declare function resetCube(): void
declare function turnCube(q: readonly number[]): void
declare function resetView(): void
declare function applyRotation(q: readonly number[]): void
declare function orbit(d: readonly number[]): void

export function element() {
  defineObpalRemote()
  const pal: ObpalRemote = document.querySelector('obpal-remote')!
  pal.setScene({ nodes: [{ id: 'cube', name: 'Cube', kind: 'object' }] })
  pal.layout = { tray: [{ id: 'reset', label: 'Reset', icon: 'reset' }] }
  pal.addEventListener('obpal-join', (e) => {
    const { name, controller } = e.detail.participant
    console.log(`${name} joined, using ${controller ?? 'a phone'}`)
    if (!pal.holder('cube')) pal.setScene({ held: { ...pal.held, cube: e.detail.participant.id } })
  })
  pal.addEventListener('obpal-button', (e) => {
    if (e.detail.id === 'reset') resetCube()
  })
  pal.addEventListener('obpal-status', (e) => { if (e.detail.status === 'unsupported') console.log(e.detail.reason) })
  function loop(now: number) {
    for (const p of pal.participants) {
      const f: Frame = pal.frame(now, p.id)
      if (pal.holding(p.id) !== 'cube') continue
      cube.position.x += f.pad1[0] * 0.01
      cube.position.y -= f.pad1[1] * 0.01
      cube.scale.multiplyScalar(2 ** f.zoom)
      if (f.clutch) turnCube(f.qRel)
    }
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
}

export async function sdk() {
  const remote = await Remote.create({
    appName: 'My viewer',
    layout: { v: 1, controllers: [Controller.trackpad, Controller.wii], tray: [{ id: 'reset', label: 'Reset' }] },
  })
  remote.mountPairing(document.getElementById('pair')!, { variant: 'compact' })
  remote.on('button', ({ id }) => { if (id === 'reset') resetView() })
  remote.on('mode', (_mode, who) => console.log(`${who.name} uses ${who.controller}`))
  requestAnimationFrame(function frame(now) {
    const f = remote.consume(now)
    if (f.clutch) applyRotation(f.qRel)
    orbit(f.pad1)
    requestAnimationFrame(frame)
  })
}
