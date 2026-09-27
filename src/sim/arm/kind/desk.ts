/**
 * A four-axis desk arm, as the Dobot Magician and the uArm are built: a base that turns, a rear arm and a forearm on
 * a parallelogram that keeps the tool pointing straight down, and a roll. Its IK is the serial arm's with the tool's
 * pitch held at 180 (./serial.ts: levelKin). Procedural, two and a half times a desk arm's size.
 */
import type { ArmKind } from '../kin'
import type { JointSpec } from '../model'
import { levelKin, type SerialSpec } from '../serial'
import { buildSerial } from '../serial3d'
import { stuffOf } from '../shapes3d'

export const DESK_JOINTS: JointSpec[] = [
  { key: 'base', name: 'Base', min: -135, max: 135, home: 0, vmax: 80, amax: 250, unit: '°' },
  { key: 'shoulder', name: 'Rear arm', min: -20, max: 85, home: 15, vmax: 60, amax: 200, unit: '°' },
  { key: 'elbow', name: 'Forearm', min: 15, max: 150, home: 95, vmax: 70, amax: 220, unit: '°' },
  { key: 'roll', name: 'Wrist roll', min: -150, max: 150, home: 0, vmax: 150, amax: 500, unit: '°' },
  { key: 'gripper', name: 'Gripper', min: 0, max: 1, home: 1, vmax: 1.4, amax: 6, unit: '' },
]

const L1 = 0.34
const L2 = 0.37
export const DESK: SerialSpec = {
  geo: { H0: 0.3, L1, L2, LT: 0.2 },
  deck: 0.08,
  rollAt: 0.09,
  look: [
    ['root', { box: [0.32, 0.08, 0.32], at: [0, 0.04, 0], stuff: 'shell' }],
    ['yaw', { cyl: [0.13, 0.14, 0.14], axis: 'y', at: [0, 0.07, 0], stuff: 'shell' }],
    ['yaw', { box: [0.2, 0.1, 0.22], at: [0, 0.17, 0], stuff: 'dark' }],
    ['yaw', { ring: [0.15, 0.01], axis: 'y', at: [0, 0.005, 0], joint: 0 }],
    // The rear arm and the forearm, each with the parallelogram's rod beside it.
    ['shoulder', { cyl: [0.06, 0.06, 0.2], axis: 'z', at: [0, 0, 0], stuff: 'dark' }],
    ['shoulder', { box: [0.07, L1, 0.05], at: [0, L1 / 2, 0], stuff: 'shell' }],
    ['shoulder', { box: [0.018, L1, 0.018], at: [0.045, L1 / 2, 0.06], stuff: 'metal' }],
    ['shoulder', { ring: [0.07, 0.01], axis: 'z', at: [0, 0, 0.105], joint: 1 }],
    ['elbow', { cyl: [0.05, 0.05, 0.14], axis: 'z', at: [0, 0, 0], stuff: 'dark' }],
    ['elbow', { box: [0.06, L2, 0.05], at: [0, L2 / 2, 0], stuff: 'shell' }],
    ['elbow', { box: [0.018, L2, 0.018], at: [0.04, L2 / 2, 0.05], stuff: 'metal' }],
    ['elbow', { ring: [0.06, 0.01], axis: 'z', at: [0, 0, 0.075], joint: 2 }],
    // The level mount at the forearm's end, the roll's servo under it, and the gripper's palm.
    ['wrist', { box: [0.08, 0.06, 0.08], at: [0, 0.03, 0], stuff: 'dark' }],
    ['roll', { box: [0.08, 0.05, 0.07], at: [0, -0.01, 0], stuff: 'black' }],
    ['roll', { box: [0.14, 0.035, 0.07], at: [0, 0.03, 0], stuff: 'shell' }],
    ['roll', { ring: [0.045, 0.008], axis: 'y', at: [0, -0.035, 0], joint: 3 }],
    ['roll', { ring: [0.03, 0.008], axis: 'y', at: [0, 0.05, 0], joint: 4 }],
  ],
  posts: [{ x: 0, z: 0, r: 0.2, y0: 0, y1: 0.08 }, { x: 0, z: 0, r: 0.15, y0: 0.08, y1: 0.22 }],
}

export const desk: ArmKind = {
  id: 'desk',
  kin: levelKin(DESK, DESK_JOINTS),
  build: (n, mats) => buildSerial(DESK, n, stuffOf(mats, '#3d4a5c'), { level: true, plate: [0.26, 0.1, 0], plateRing: 0.22 }),
  cell: { stand: 0.6, fence: 1.4, blocks: [0.12, 0.2], camera: [1.6, 1.5, 2.2], look: 0.22 },
  drive: { reach: [0.15, 0.75], height: [0.06, 0.8], hover: [0.15, 0.06, 0.45], scale: 1 },
  hardware: false,
}
