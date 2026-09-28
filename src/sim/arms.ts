/**
 * The robot arms on the sim catalogue: a card for each kind of arm the arm sim has (its registry, ./arm/kinds.ts),
 * each with its own pick and place playing on the card, and Try it opening the sim with that kind.
 */
import type { ControllerId } from '@obpal/core'
import { ARM_KINDS } from './arm/kinds'
import type { SimCard } from './catalogue'

/** How each controller drives an arm, whatever its kind (a badge's tooltip). */
const HOW: Partial<Record<ControllerId, string>> = {
  'face.wii': 'Point at a spot, hold B: it goes there · A picks up',
  'face.hand': 'Hold the pad and move: the gripper follows',
  'face.trackpad': 'Pick a part on the strip, then drag · gyro 1:1',
  'face.gamepad': 'Sticks move the tool · A grips · B home',
}

export const ARM_CARDS: SimCard[] = ARM_KINDS.map((k) => ({
  id: `arm-${k.id}`, name: k.name, kind: 'Arm', href: k.href, blurb: k.blurb,
  controllers: ['face.trackpad', 'face.hand', ...k.controllers.filter((c) => c !== 'face.trackpad' && c !== 'face.hand')], how: HOW,
  preview: () => import('./arm-preview').then((m) => m.armPreview(k)),
}))
