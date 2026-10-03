/**
 * The octopus sim's presentation state (/sim/octopus/): what its logic writes and its view, sound and VR ride read.
 * Arms follow the Cove continuum profile (src/sim/continuum/profile.ts): eight arms with their root positions,
 * lengths, taper and cup sites; each moves as a soft rod (src/sim/continuum/rod.ts). Everything here is plain numbers
 * and strings, so a snapshot can cross the link.
 */
import { Quaternion, Vector3 } from 'three'
import { COVE } from '../continuum/profile'
import { ROD_SEGMENTS } from '../continuum/rod'

export const OCTOPUS_PROFILE = COVE
export const OCTOPUS_ARMS = COVE.arms.length
export const OCTOPUS_CUPS = COVE.arms[0].cups.length
/** Particles per arm in `arms`, three numbers each. */
export const ARM_POINTS = ROD_SEGMENTS + 1

/** Crawl: arms hold, push, peel, recover and reach. Curl: arms coil up and the body settles on them. */
export type OctopusMode = 'crawl' | 'curl'
/**
 * What one arm is doing: holding the floor (and pushing as the body moves away), peeling its suckers tip first,
 * recovering (shortened, drawn in), reaching by a travelling bend, wrapping or holding the ball, or coiled free.
 */
export type ArmRole = 'plant' | 'peel' | 'recover' | 'reach' | 'wrap' | 'hold' | 'free'

export interface OctopusBall { x: number; y: number; z: number; held: boolean }

export interface Octopus {
  /** The collar's centre: x and z on the floor, y its height above the floor. */
  x: number
  y: number
  z: number
  /** Body yaw (radians, the device family's convention: forward is -z at 0). Crawl direction is separate. */
  h: number
  /** Travel speed (m/s) and turn rate (rad/s), for the readout and the sound. */
  v: number
  turn: number
  mode: OctopusMode
  /** Stop holds every arm and the body where they are, until a fresh command. */
  stopped: boolean
  /** Mantle volume as a fraction of full: 1 at rest, lower while a pulse squeezes it. */
  mantle: number
  /** Arm × ARM_POINTS × xyz, world positions of each arm's rod, root first. */
  arms: number[]
  /** Arm × cup seal, 0 free … 1 sealed. */
  cups: number[]
  roles: ArmRole[]
  ball: OctopusBall
  /** The ring the ball is carried to. */
  den: [number, number]
  score: number
  actions: number
  /** Nobody has held it for a while: it is showing itself. */
  showing: boolean
}

/** Where particle `point` of arm `arm` starts in `arms`. */
export const pointAt = (arm: number, point: number) => (arm * ARM_POINTS + point) * 3

/** The profile's +z is the octopus's front; the device family faces -z at zero yaw, so the body turns by h + π. */
export const profileYaw = (h: number) => h + Math.PI

const yaw = new Quaternion(), up = new Vector3(0, 1, 0)
/** An arm's root in the world: its collar point, its outward direction and its dorsal axis, for a body pose. */
export function armRoot(u: Pick<Octopus, 'x' | 'y' | 'z' | 'h'>, arm: number, root: Vector3, direction: Vector3, dorsal: Vector3) {
  const profile = COVE.arms[arm]
  yaw.setFromAxisAngle(up, profileYaw(u.h))
  root.copy(profile.position).applyQuaternion(yaw)
  root.x += u.x; root.y += u.y; root.z += u.z
  direction.set(0, 0, 1).applyQuaternion(profile.orientation).applyQuaternion(yaw)
  dorsal.set(0, 1, 0).applyQuaternion(profile.orientation).applyQuaternion(yaw)
  return root
}
