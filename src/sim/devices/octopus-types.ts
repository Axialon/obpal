/**
 * The octopus sim's presentation state (/sim/octopus/): what its logic writes and its view, sound and VR ride read.
 * Arms are the Cove continuum profile's (src/sim/continuum/profile.ts): eight arms of four piecewise-constant-curvature
 * sections, sixteen cups each. Everything here is plain numbers and strings, so a snapshot can cross the link.
 */
import { COVE, type Shape } from '../continuum/profile'

export const OCTOPUS_PROFILE = COVE
export const OCTOPUS_ARMS = COVE.arms.length
export const OCTOPUS_SECTIONS = COVE.arms[0].sections.length
export const OCTOPUS_CUPS = COVE.arms[0].cups.length
/** Floats per section in `shapes`: bend about local x, bend about local y (1/m), length strain and twist (rad/m). */
export const SHAPE_STRIDE = 4

/** Crawl: arms plant and step. Curl: arms roll up and the body settles on them. */
export type OctopusMode = 'crawl' | 'curl'
/** What one arm is doing: planted, stepping to a new anchor, reaching, wrapping or holding the ball, or moving freely. */
export type ArmRole = 'plant' | 'step' | 'reach' | 'wrap' | 'hold' | 'free'

export interface OctopusBall { x: number; y: number; z: number; held: boolean }

export interface Octopus {
  /** The collar's centre: x and z on the floor, y its height above the floor. */
  x: number
  y: number
  z: number
  /** Body yaw, the only body rotation (radians, the device family's convention: forward is -z at 0). */
  h: number
  /** Travel speed (m/s) and turn rate (rad/s), for the readout and the sound. */
  v: number
  turn: number
  mode: OctopusMode
  /** Stop holds every arm and the body where they are, until a fresh command. */
  stopped: boolean
  /** Mantle volume as a fraction of full: 1 at rest, lower while a pulse squeezes it. */
  mantle: number
  /** Arm × section × SHAPE_STRIDE, in each arm's own section frames. */
  shapes: number[]
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

/** Where section `section` of arm `arm` starts in `shapes`. */
export const shapeAt = (arm: number, section: number) => (arm * OCTOPUS_SECTIONS + section) * SHAPE_STRIDE

/** Read one arm's sections out of the flat state into reusable shapes. */
export function armShapes(u: Pick<Octopus, 'shapes'>, arm: number, out: Shape[]) {
  for (let s = 0; s < OCTOPUS_SECTIONS; s++) {
    const i = shapeAt(arm, s)
    out[s].kx = u.shapes[i]
    out[s].ky = u.shapes[i + 1]
    out[s].strain = u.shapes[i + 2]
    out[s].twist = u.shapes[i + 3]
  }
  return out
}

/** The profile's +z is the octopus's front; the device family faces -z at zero yaw, so the body turns by h + π. */
export const profileYaw = (h: number) => h + Math.PI
