/**
 * The catalogue's controllers (CATALOGUE §9.1) as the sims show them: a glyph and a short name each, for the badges on
 * a device's card and panel and the catalogue's filter.
 */
import { CONTROLLER_IDS, CONTROLLERS, type ControllerId } from '@obpal/core'
import { CONTROLLER_ICON } from '../controller/ratings'
import { ICONS } from '../ui/icons'

/** Short names for a badge ("Wii remote" is "Wii"). */
const SHORT: Record<ControllerId, string> = {
  'face.drums': 'Drums',
  'face.keys': 'Keys',
  'face.gamepad': 'Gamepad', 'face.wheel': 'Wheel', 'face.wii': 'Wii', 'face.mouse': 'Mouse', 'face.trackpad': 'Trackpad', 'face.hand': '3D hand', 'face.keyboard': 'Keyboard',
}

export const FACES: readonly ControllerId[] = CONTROLLER_IDS
export const faceGlyph = (id: string) => ICONS[CONTROLLER_ICON[id as ControllerId] ?? 'phone'] ?? ''
export const faceShort = (id: string) => SHORT[id as ControllerId] ?? id
export const faceName = (id: string) => CONTROLLERS[id as ControllerId]?.name ?? id
