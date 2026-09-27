/**
 * The kinds of arm the robot arms sim has (/sim/arm/?kind=…), for any page that lists them: the sims' catalogue shows a
 * card for each. Light to import (no three.js until a preview is asked for). The arms themselves are in ./kind/.
 *
 * Each has an id, a name, a line on what it is, the controllers it's best driven with (the first the best; ids from
 * @obpal/core's CONTROLLERS), the page, and a preview: its model on a loop of pick and place, to show it moving.
 */
import type { ControllerId } from '@obpal/core'
import type { Object3D } from 'three'

export type ArmKindId = 'arm5' | 'so101' | 'six' | 'scara' | 'delta' | 'desk'

/** An arm moving by itself, for a card: add `object` to a scene (the arm stands on y = 0 at the middle, facing −x). */
export interface ArmPreview {
  object: Object3D
  /** How tall it stands, and how far it reaches out (m), to frame it. */
  size: { height: number; reach: number }
  /** Pose it for `t` seconds into its loop: it picks up a block, takes it across, puts it down, and back. */
  step(t: number): void
  dispose(): void
}

export interface ArmKindInfo {
  id: ArmKindId
  name: string
  blurb: string
  controllers: ControllerId[]
  href: string
  preview: () => Promise<ArmPreview>
}

const kind = (id: ArmKindId, name: string, blurb: string, controllers: ControllerId[]): ArmKindInfo => ({
  id, name, blurb, controllers, href: `/sim/arm/?kind=${id}`,
  preview: () => import('./preview').then((m) => m.armPreview(id)),
})

export const ARM_KINDS: readonly ArmKindInfo[] = [
  kind('arm5', 'Five-axis arm', 'The sim’s own arm: a turning base, three bends and a wrist roll, over a metre of reach.', ['face.hand', 'face.wii', 'face.trackpad', 'face.gamepad']),
  kind('so101', 'SO-101', 'LeRobot’s open-source arm, joint for joint: drive the twin, then connect a real one over USB.', ['face.hand', 'face.trackpad', 'face.wii', 'face.gamepad']),
  kind('six', 'Six-axis industrial arm', 'A factory arm with a spherical wrist: its forearm twists, so the tool turns any way at all.', ['face.hand', 'face.gamepad', 'face.wii', 'face.trackpad']),
  kind('scara', 'SCARA', 'Swings flat and drops its quill: quick, stiff pick and place from above, the tool always pointing down.', ['face.wii', 'face.gamepad', 'face.hand', 'face.trackpad']),
  kind('delta', 'Delta', 'Three arms overhead carry a level gripper: the fastest kind of picker, working the dome under its motors.', ['face.wii', 'face.hand', 'face.gamepad', 'face.trackpad']),
  kind('desk', 'Desk arm', 'A four-axis arm like the ones on desks and in classrooms: a parallelogram keeps its gripper pointing down.', ['face.wii', 'face.trackpad', 'face.hand', 'face.gamepad']),
]
