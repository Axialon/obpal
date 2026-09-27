/**
 * The sim catalogue (/sim/): every sim a phone can drive, as cards. The device sims come from their registry
 * (./devices/registry.ts); the arms, the arena and the Viewer are sims of their own; the rest are proposed, shown so
 * people see what's coming. Each card names the controllers that suit it, best first (CATALOGUE §9.1), which is what
 * the catalogue filters by.
 */
import { Controller, type ControllerId } from '@obpal/core'
import { DEVICES } from './devices/registry'
import { ARM_CARDS } from './arms'
import type { Preview } from './devices/view'

export interface SimCard {
  id: string
  name: string
  /** Where it groups: Vehicle, Flyer, Camera, Home, Game, Arm, Scene. */
  kind: string
  blurb: string
  /** The controllers that suit it, best first. */
  controllers: ControllerId[]
  /** How each drives it, a few words (a badge's tooltip). */
  how?: Partial<Record<ControllerId, string>>
  /** Where to try it; null for a proposed one. */
  href: string | null
  /** Its live preview (three.js, loaded when the card comes into view). */
  preview?: () => Promise<Preview>
  /** A proposed card's glyph (an icon name). */
  glyph?: string
}

const deviceCards: SimCard[] = DEVICES.map((d) => ({
  id: d.spec.id,
  name: d.spec.name,
  kind: d.spec.kind,
  blurb: d.spec.blurb,
  controllers: d.spec.controllers,
  how: d.spec.how,
  href: `/sim/device/?d=${d.spec.id}`,
  preview: () => d.view().then((m) => m.preview()),
}))

/** The sims that aren't devices: the arena and the Viewer (the arms come from ./arms.ts). */
const SCENES: SimCard[] = [
  {
    id: 'arena', name: 'Faction arena', kind: 'Game', href: '/sim/arena/',
    blurb: 'Four players, a phone each: tilt to roll, tap to dash, knock the others off the ring.',
    controllers: [Controller.trackpad, Controller.gamepad],
    how: { 'face.trackpad': 'Tilt to roll · drag to push · tap to dash', 'face.gamepad': 'Left stick rolls · A dashes' },
    preview: () => import('./scene-previews').then((m) => m.arenaPreview()),
  },
  {
    id: 'viewer', name: 'Shared 3D scene', kind: 'Scene', href: '/view/',
    blurb: 'A model everyone holds a part of, each in their own colour.',
    controllers: [Controller.trackpad, Controller.wii, Controller.hand, Controller.gamepad],
    how: { 'face.trackpad': 'Turn it 1:1, or tilt', 'face.wii': 'Point at a part, A takes it', 'face.hand': 'Hold the pad and move', 'face.gamepad': 'Sticks orbit and zoom' },
    preview: () => import('./scene-previews').then((m) => m.viewerPreview()),
  },
]

/** Proposed devices: what each would show about the catalogue. */
export const PROPOSED: SimCard[] = [
  { id: 'boat', name: 'Boat', kind: 'Vehicle', glyph: 'wheel', href: null, blurb: 'Tilt to steer the rudder; it drifts and leaves a wake.', controllers: [Controller.wheel, Controller.gamepad, Controller.trackpad] },
  { id: 'spotlights', name: 'Stage spotlights', kind: 'Show', glyph: 'sun', href: null, blurb: 'Point your phone and the beam follows: a light show together.', controllers: [Controller.wii, Controller.trackpad] },
  { id: 'vacuum', name: 'Robot vacuum', kind: 'Home', glyph: 'point', href: null, blurb: 'Point where to clean; ⌂ sends it to its dock.', controllers: [Controller.wii, Controller.trackpad] },
  { id: 'tank', name: 'Tank', kind: 'Vehicle', glyph: 'gyro', href: null, blurb: 'Turn the phone to aim the turret (gyro Aim), the sticks drive.', controllers: [Controller.gamepad, Controller.trackpad] },
  { id: 'excavator', name: 'Excavator', kind: 'Machine', glyph: 'gamepad', href: null, blurb: 'Two sticks, four joints: dig and dump, or move the bucket by hand.', controllers: [Controller.gamepad, Controller.hand] },
  { id: 'forklift', name: 'Forklift', kind: 'Machine', glyph: 'gamepad', href: null, blurb: 'Drive with one stick, lift and tilt the forks with the other.', controllers: [Controller.gamepad, Controller.trackpad] },
  { id: 'painter', name: 'Light painter', kind: 'Toy', glyph: 'cursor', href: null, blurb: 'Draw on the screen by pointing, Left held; type, and it writes.', controllers: [Controller.mouse, Controller.keyboard] },
  { id: 'gimbal', name: 'Camera gimbal', kind: 'Camera', glyph: 'gyro', href: null, blurb: 'The camera turns exactly as your phone does (1:1).', controllers: [Controller.trackpad, Controller.hand] },
  { id: 'plane', name: 'RC plane', kind: 'Flyer', glyph: 'plane', href: null, blurb: 'Tilt like a yoke with the Flight profile.', controllers: [Controller.gamepad, Controller.trackpad] },
  { id: 'slotcars', name: 'Slot cars', kind: 'Game', glyph: 'wheel', href: null, blurb: 'Only a trigger each, eight players on one track.', controllers: [Controller.wheel, Controller.gamepad] },
]

/** Every sim to try, in the catalogue's order: the devices, the arms, then the arena and the Viewer. */
export const SIMS: SimCard[] = [...deviceCards, ...ARM_CARDS, ...SCENES]

/** Cards that suit a controller (all of them for none). */
export const suiting = (cards: readonly SimCard[], face: string | null) => (face ? cards.filter((c) => c.controllers.includes(face as ControllerId)) : [...cards])

/** A controller from the page's ?face= (the full id, or its short name: `wii`, `face.wii`). */
export function faceParam(v: string | null): ControllerId | null {
  if (!v) return null
  const id = v.startsWith('face.') ? v : `face.${v}`
  return (Object.values(Controller) as string[]).includes(id) ? (id as ControllerId) : null
}
