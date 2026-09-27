/**
 * The device sims, in the catalogue's order: each device's data and logic, and its look loaded when it's shown. The
 * device page (/sim/device/?d=<id>) and the catalogue (/sim/) both read this list; adding a device is adding a row.
 */
import type { Stage } from './stage'
import type { DeviceLogic, DeviceSpec } from './types'
import type { DeviceView, Preview } from './view'
import { ROVER_SPEC, RoverLogic } from './rover'
import { DRONE_SPEC, DroneLogic } from './drone'
import { MAZE_SPEC, MazeLogic } from './maze'
import { PTZ_SPEC, PtzLogic } from './ptz'
import { LAMP_SPEC, LampLogic } from './lamp'
import { CLAW_SPEC, ClawLogic } from './claw'
import { BOAT_SPEC, BoatLogic } from './boat'

import { SPOTLIGHTS_SPEC, SpotlightsLogic } from './spotlights'

import { VACUUM_SPEC, VacuumLogic } from './vacuum'

import { TANK_SPEC, TankLogic } from './tank'

import { EXCAVATOR_SPEC, ExcavatorLogic } from './excavator'

import { FORKLIFT_SPEC, ForkliftLogic } from './forklift'

import { PAINTER_SPEC, PainterLogic } from './painter'

import { GIMBAL_SPEC, GimbalLogic } from './gimbal'

import { PLANE_SPEC, PlaneLogic } from './plane'

import { SLOTCARS_SPEC, SlotcarsLogic } from './slotcars'

export interface DeviceEntry<L extends DeviceLogic = DeviceLogic> {
  spec: DeviceSpec
  logic(): L
  view(): Promise<{ createView(stage: Stage, logic: L): DeviceView; preview(): Preview }>
}

/** A row, its logic's own type kept between its logic and its view. */
const entry = <L extends DeviceLogic>(e: DeviceEntry<L>) => e as unknown as DeviceEntry

export const DEVICES: DeviceEntry[] = [
  entry({ spec: ROVER_SPEC, logic: () => new RoverLogic(), view: () => import('./rover.view') }),
  entry({ spec: DRONE_SPEC, logic: () => new DroneLogic(), view: () => import('./drone.view') }),
  entry({ spec: MAZE_SPEC, logic: () => new MazeLogic(), view: () => import('./maze.view') }),
  entry({ spec: PTZ_SPEC, logic: () => new PtzLogic(), view: () => import('./ptz.view') }),
  entry({ spec: LAMP_SPEC, logic: () => new LampLogic(), view: () => import('./lamp.view') }),
  entry({ spec: CLAW_SPEC, logic: () => new ClawLogic(), view: () => import('./claw.view') }),
  entry({ spec: BOAT_SPEC, logic: () => new BoatLogic(), view: () => import('./boat.view') }),
  entry({ spec: SPOTLIGHTS_SPEC, logic: () => new SpotlightsLogic(), view: () => import('./spotlights.view') }),
  entry({ spec: VACUUM_SPEC, logic: () => new VacuumLogic(), view: () => import('./vacuum.view') }),
  entry({ spec: TANK_SPEC, logic: () => new TankLogic(), view: () => import('./tank.view') }),
  entry({ spec: EXCAVATOR_SPEC, logic: () => new ExcavatorLogic(), view: () => import('./excavator.view') }),
  entry({ spec: FORKLIFT_SPEC, logic: () => new ForkliftLogic(), view: () => import('./forklift.view') }),
  entry({ spec: PAINTER_SPEC, logic: () => new PainterLogic(), view: () => import('./painter.view') }),
  entry({ spec: GIMBAL_SPEC, logic: () => new GimbalLogic(), view: () => import('./gimbal.view') }),
  entry({ spec: PLANE_SPEC, logic: () => new PlaneLogic(), view: () => import('./plane.view') }),
  entry({ spec: SLOTCARS_SPEC, logic: () => new SlotcarsLogic(), view: () => import('./slotcars.view') }),
]

export const deviceById = (id: string | null | undefined) => DEVICES.find((d) => d.spec.id === id)
