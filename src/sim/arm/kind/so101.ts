/**
 * The SO-101 (LeRobot's open-source arm): five Feetech servos and a gripper, with its proportions, drawn two and a
 * half times its size so it works the same blocks as the other arms. Its joints turn as the real arm's do, one to
 * one, so it's the twin a real SO-101 follows (./drivers.ts: FeetechDriver). Procedural: printed white links and
 * black servos.
 */
import type { ArmKind } from '../kin'
import type { JointSpec } from '../model'
import { serialKin, type SerialSpec } from '../serial'
import { buildSerial } from '../serial3d'
import { stuffOf } from '../shapes3d'

export const SO101_JOINTS: JointSpec[] = [
  { key: 'base', name: 'Base', min: -110, max: 110, home: 0, vmax: 90, amax: 300, unit: '°' },
  { key: 'shoulder', name: 'Shoulder', min: -100, max: 100, home: -5, vmax: 90, amax: 300, unit: '°' },
  { key: 'elbow', name: 'Elbow', min: -100, max: 150, home: 95, vmax: 90, amax: 300, unit: '°' },
  { key: 'wrist', name: 'Wrist', min: -100, max: 100, home: 70, vmax: 120, amax: 400, unit: '°' },
  { key: 'roll', name: 'Wrist roll', min: -160, max: 160, home: 0, vmax: 150, amax: 500, unit: '°' },
  { key: 'gripper', name: 'Gripper', min: 0, max: 1, home: 1, vmax: 1.6, amax: 7, unit: '' },
]

const L1 = 0.28
const L2 = 0.34
export const SO101: SerialSpec = {
  geo: { H0: 0.26, L1, L2, LT: 0.26 },
  deck: 0.07,
  rollAt: 0.15,
  look: [
    ['root', { cyl: [0.14, 0.15, 0.07], axis: 'y', at: [0, 0.035, 0], stuff: 'shell' }],
    // The base's servo, and the bracket up to the shoulder.
    ['yaw', { box: [0.12, 0.09, 0.15], at: [0, 0.045, 0], stuff: 'black' }],
    ['yaw', { box: [0.13, 0.12, 0.16], at: [0, 0.13, 0], stuff: 'shell' }],
    ['yaw', { ring: [0.13, 0.01], axis: 'y', at: [0, 0.005, 0], joint: 0 }],
    ['shoulder', { box: [0.1, 0.1, 0.12], at: [0, 0, 0], stuff: 'black' }],
    ['shoulder', { box: [0.075, L1, 0.1], at: [0, L1 / 2, 0], stuff: 'shell' }],
    ['shoulder', { ring: [0.085, 0.01], axis: 'z', at: [0, 0, 0.07], joint: 1 }],
    ['elbow', { box: [0.09, 0.09, 0.11], at: [0, 0, 0], stuff: 'black' }],
    ['elbow', { box: [0.065, L2, 0.085], at: [0, L2 / 2, 0], stuff: 'shell' }],
    ['elbow', { ring: [0.075, 0.01], axis: 'z', at: [0, 0, 0.065], joint: 2 }],
    ['wrist', { box: [0.085, 0.085, 0.1], at: [0, 0, 0], stuff: 'black' }],
    ['wrist', { box: [0.06, 0.1, 0.07], at: [0, 0.07, 0], stuff: 'shell' }],
    ['wrist', { ring: [0.065, 0.009], axis: 'z', at: [0, 0, 0.06], joint: 3 }],
    // The roll's servo, and the gripper's palm the fingers hang from.
    ['roll', { box: [0.09, 0.05, 0.08], at: [0, -0.01, 0], stuff: 'black' }],
    ['roll', { box: [0.14, 0.035, 0.07], at: [0, 0.03, 0], stuff: 'shell' }],
    ['roll', { ring: [0.05, 0.008], axis: 'y', at: [0, -0.04, 0], joint: 4 }],
    ['roll', { ring: [0.03, 0.008], axis: 'y', at: [0, 0.05, 0], joint: 5 }],
  ],
  posts: [{ x: 0, z: 0, r: 0.15, y0: 0, y1: 0.07 }, { x: 0, z: 0, r: 0.12, y0: 0.07, y1: 0.26 }],
}

export const so101: ArmKind = {
  id: 'so101',
  kin: serialKin(SO101, SO101_JOINTS),
  build: (n, mats) => buildSerial(SO101, n, stuffOf(mats, '#eef1f5'), { plate: [0.24, 0.08, 0], plateRing: 0.17 }),
  cell: { stand: 0.55, fence: 1.35, blocks: [0.12, 0.2], camera: [1.55, 1.45, 2.15], look: 0.22 },
  drive: { reach: [0.12, 0.8], height: [0.06, 0.95], hover: [0.15, 0.06, 0.5], scale: 1 },
  hardware: true,
}
