/**
 * The five-axis arm the sim began with (./model.ts, ./kinematics.ts): a base that turns, a shoulder, an elbow and a
 * wrist that bend in its plane, a roll, and a gripper. Metal and dark, 1.4 m out at full stretch. It can be the twin
 * of a real arm with the same joints (./drivers.ts).
 */
import { armFrames, armParts, FINGERS } from '../blocks'
import { forward, inverse, lowest, stepAboveFloor, toolFloor, type ArmPose } from '../kinematics'
import type { ArmKind, Pose } from '../kin'
import { headingFor } from '../layout'
import { buildArm, JOINTS } from '../model'

const asArm = (p: Pose) => p as ArmPose

export const arm5: ArmKind = {
  id: 'arm5',
  kin: {
    keys: ['yaw', 'shoulder', 'elbow', 'wrist', 'roll'],
    joints: JOINTS,
    forward: (p) => forward(asArm(p)),
    inverse: (t, held) => inverse(t, held),
    heading: (want, near) => headingFor(want, near.yaw, JOINTS[0].min, JOINTS[0].max),
    yawRange: [JOINTS[0].min, JOINTS[0].max],
    pitchRange: [20, 200],
    rollRange: [JOINTS[4].min, JOINTS[4].max],
    pitches: [180, 170, 160, 150, 140, 130, 120],
    toolFloor: (pitch, roll, held) => toolFloor(pitch, roll, held),
    lowest: (p, held) => lowest(asArm(p), held),
    stepAboveFloor: (was, next, following, held) => stepAboveFloor(asArm(was), asArm(next), following, JOINTS[1].min, held),
    parts: (s, p, open, held) => armParts(s, asArm(p), open, held),
    fingers: FINGERS,
    grasp: (s, p) => armFrames(s, asArm(p)).grasp,
    posts: [{ x: 0, z: 0, r: 0.27, y0: 0, y1: 0.1 }, { x: 0, z: 0, r: 0.19, y0: 0.1, y1: 0.26 }],
  },
  build: buildArm,
  cell: { stand: 0.9, fence: 2.05, blocks: [0.22, 0.34], camera: [2.2, 2.1, 3.1], look: 0.35 },
  drive: { reach: [0.25, 1.2], height: [0.06, 1.45], hover: [0.2, 0.08, 0.8], scale: 1.5 },
  hardware: true,
}
