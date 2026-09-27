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
]

export const deviceById = (id: string | null | undefined) => DEVICES.find((d) => d.spec.id === id)
