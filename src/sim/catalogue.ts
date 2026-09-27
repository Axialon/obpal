/**
 * The sim catalogue (/sim/): every sim a phone can drive, as cards. The device sims come from their registry
 * (./devices/registry.ts); the arms, the arena and the Viewer are sims of their own; the rest are proposed, shown so
 * people see what's coming. Each card names the controllers that suit it, best first (CATALOGUE §9.1), which is what
 * the catalogue filters by.
 */
import { Controller, CONTROLLERS, type ControllerId } from '@obpal/core'
import { DEVICES } from './devices/registry'
import { ARM_CARDS } from './arms'
import type { Preview } from './devices/view'

export interface SimCard {
  id: string
  name: string
  /** Where it groups: Vehicle, Flyer, Camera, Home, Game, Arm, Scene. */
  kind: string
  category?: CategoryId
  featured?: boolean
  fresh?: boolean
  blurb: string
  teaches?: string
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
  category: d.spec.category,
  blurb: d.spec.blurb,
  teaches: d.spec.teaches,
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
]

/** Every sim to try, in the catalogue's order: the devices, the arms, then the arena and the Viewer. */
export const CATEGORIES = [
  { id: 'robotics', name: 'Robotics' },
  { id: 'vehicles', name: 'Vehicles' },
  { id: 'flying', name: 'Flying' },
  { id: 'home', name: 'Home' },
  { id: 'camera-stage', name: 'Camera and stage' },
  { id: 'games', name: 'Games' },
  { id: 'industrial', name: 'Industrial' },
  { id: 'music', name: 'Music' },
  { id: 'space-science', name: 'Space & science' },
] as const
export type CategoryId = typeof CATEGORIES[number]['id']
export type CollectionId = CategoryId | 'featured' | 'new'

const categories: Record<string, CategoryId> = {
  football: 'games',
  marblerun: 'games',
  planetary: 'space-science',
  telescope: 'space-science',
  pendulum: 'space-science',
  trebuchet: 'space-science',
  slider: 'camera-stage',
  jib: 'camera-stage',
  rover: 'vehicles', drone: 'flying', maze: 'games', ptz: 'camera-stage', lamp: 'home', claw: 'games',
  boat: 'vehicles', spotlights: 'camera-stage', vacuum: 'home', tank: 'vehicles', excavator: 'industrial',
  forklift: 'industrial', painter: 'camera-stage', gimbal: 'camera-stage', plane: 'flying', slotcars: 'games',
  dog: 'robotics', sorting: 'industrial', kart: 'vehicles', helicopter: 'flying', submarine: 'vehicles',
  smarthome: 'home', pinball: 'games', airhockey: 'games', studio: 'music', arena: 'games', viewer: 'space-science',
}
const fresh = new Set(['football', 'marblerun', 'planetary', 'telescope', 'pendulum', 'trebuchet', 'slider', 'jib', 'dog', 'sorting', 'kart', 'helicopter', 'submarine', 'smarthome', 'pinball', 'airhockey', 'studio'])
const featured = new Set(['dog', 'kart', 'pinball', 'drone', 'arm-so101', 'lamp', 'studio'])

export const SIMS: SimCard[] = [...deviceCards, ...ARM_CARDS, ...SCENES].map(c => ({
  ...c,
  category: c.category ?? categories[c.id] ?? (c.id.startsWith('studio') ? 'music' : 'robotics'),
  fresh: c.fresh ?? fresh.has(c.id),
  featured: c.featured ?? featured.has(c.id),
}))

export interface SimFilters { category: CollectionId | null; face: ControllerId | null; q: string }

/** Read a shareable view, accepting the original short and full controller ids. */
export function filtersFrom(search: string): SimFilters {
  const params = new URLSearchParams(search)
  const category = params.get('category')
  return {
    category: category === 'featured' || category === 'new' || CATEGORIES.some(c => c.id === category) ? category as CollectionId : null,
    face: faceParam(params.get('face')),
    q: (params.get('q') ?? '').trim().slice(0, 160),
  }
}

/** Keep unrelated query parameters and fragments when the visitor changes a filter. */
export function filtersUrl(base: URL, filters: SimFilters): URL {
  const url = new URL(base)
  const entries: [string, string | null | undefined][] = [['category', filters.category], ['face', filters.face?.slice(5)], ['q', filters.q.trim()]]
  for (const [key, value] of entries) {
    if (value) url.searchParams.set(key, value)
    else url.searchParams.delete(key)
  }
  return url
}

/** Category, controller and search narrow the same list; every search word must match. */
export function filterSims(cards: readonly SimCard[], { category, face, q }: SimFilters): SimCard[] {
  const words = q.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  return cards.filter(c => {
    if (face && !c.controllers.includes(face)) return false
    if (category === 'featured' ? !c.featured : category === 'new' ? !c.fresh : category && c.category !== category) return false
    const text = [c.name, c.blurb, c.teaches, c.kind, CATEGORIES.find(k => k.id === c.category)?.name,
      ...c.controllers.flatMap(id => [id, CONTROLLERS[id].name, c.how?.[id]])].join(' ').toLocaleLowerCase()
    return words.every(word => text.includes(word))
  })
}

/** Cards that suit a controller (all of them for none). */
export const suiting = (cards: readonly SimCard[], face: string | null) => (face ? cards.filter((c) => c.controllers.includes(face as ControllerId)) : [...cards])

/** A controller from the page's ?face= (the full id, or its short name: `wii`, `face.wii`). */
export function faceParam(v: string | null): ControllerId | null {
  if (!v) return null
  const id = v.startsWith('face.') ? v : `face.${v}`
  return (Object.values(Controller) as string[]).includes(id) ? (id as ControllerId) : null
}
