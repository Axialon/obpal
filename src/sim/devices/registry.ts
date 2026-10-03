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
import { STUDIO_SPEC, StudioLogic } from './studio'
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
import { DOG_SPEC, DogLogic } from './dog'
import { SORTING_SPEC, SortingLogic } from './sorting'
import { KART_SPEC, KartLogic } from './kart'
import { HELICOPTER_SPEC, HelicopterLogic } from './helicopter'
import { SUBMARINE_SPEC, SubmarineLogic } from './submarine'
import { SMARTHOME_SPEC, SmarthomeLogic } from './smarthome'
import { AIRHOCKEY_SPEC, AirhockeyLogic } from './airhockey'
import { PINBALL_SPEC, PinballLogic } from './pinball'
import { FOOTBALL_SPEC, FootballLogic } from './football'
import { MARBLERUN_SPEC, MarblerunLogic } from './marblerun'
import { PLANETARY_SPEC, PlanetaryLogic } from './planetary'
import { TELESCOPE_SPEC, TelescopeLogic } from './telescope'
import { PENDULUM_SPEC, PendulumLogic } from './pendulum'
import { TREBUCHET_SPEC, TrebuchetLogic } from './trebuchet'
import { SLIDER_SPEC, SliderLogic } from './slider'
import { JIB_SPEC, JibLogic } from './jib'
import { OCTOPUS_SPEC, OctopusLogic } from './octopus'

export interface DeviceEntry<L extends DeviceLogic = DeviceLogic> {
  spec: DeviceSpec
  logic(): L
  view(): Promise<{ createView(stage: Stage, logic: L): DeviceView; preview(): Preview }>
}

/** A row, its logic's own type kept between its logic and its view. */
const entry = <L extends DeviceLogic>(e: DeviceEntry<L>) => e as unknown as DeviceEntry

export const DEVICES: DeviceEntry[] = [
  entry({ spec: OCTOPUS_SPEC, logic: () => new OctopusLogic(), view: () => import('./octopus.view') }),
  entry({ spec: JIB_SPEC, logic: () => new JibLogic(), view: () => import('./jib.view') }),
  entry({ spec: SLIDER_SPEC, logic: () => new SliderLogic(), view: () => import('./slider.view') }),
  entry({ spec: TREBUCHET_SPEC, logic: () => new TrebuchetLogic(), view: () => import('./trebuchet.view') }),
  entry({ spec: PENDULUM_SPEC, logic: () => new PendulumLogic(), view: () => import('./pendulum.view') }),
  entry({ spec: TELESCOPE_SPEC, logic: () => new TelescopeLogic(), view: () => import('./telescope.view') }),
  entry({ spec: PLANETARY_SPEC, logic: () => new PlanetaryLogic(), view: () => import('./planetary.view') }),
  entry({ spec: MARBLERUN_SPEC, logic: () => new MarblerunLogic(typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches), view: () => import('./marblerun.view') }),
  entry({ spec: FOOTBALL_SPEC, logic: () => new FootballLogic(), view: () => import('./football.view') }),
  entry({ spec: ROVER_SPEC, logic: () => new RoverLogic(), view: () => import('./rover.view') }),
  entry({ spec: DRONE_SPEC, logic: () => new DroneLogic(), view: () => import('./drone.view') }),
  entry({ spec: MAZE_SPEC, logic: () => new MazeLogic(), view: () => import('./maze.view') }),
  entry({ spec: PTZ_SPEC, logic: () => new PtzLogic(), view: () => import('./ptz.view') }),
  entry({ spec: LAMP_SPEC, logic: () => new LampLogic(), view: () => import('./lamp.view') }),
  entry({ spec: CLAW_SPEC, logic: () => new ClawLogic(), view: () => import('./claw.view') }),
  entry({ spec: STUDIO_SPEC, logic: () => new StudioLogic(), view: () => import('./studio.view') }),
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
  entry({ spec: DOG_SPEC, logic: () => new DogLogic(), view: () => import('./dog.view') }),
  entry({ spec: SORTING_SPEC, logic: () => new SortingLogic(), view: () => import('./sorting.view') }),
  entry({ spec: KART_SPEC, logic: () => new KartLogic(), view: () => import('./kart.view') }),
  entry({ spec: HELICOPTER_SPEC, logic: () => new HelicopterLogic(), view: () => import('./helicopter.view') }),
  entry({ spec: SUBMARINE_SPEC, logic: () => new SubmarineLogic(), view: () => import('./submarine.view') }),
  entry({ spec: SMARTHOME_SPEC, logic: () => new SmarthomeLogic(), view: () => import('./smarthome.view') }),
  entry({ spec: AIRHOCKEY_SPEC, logic: () => new AirhockeyLogic(), view: () => import('./airhockey.view') }),
  entry({ spec: PINBALL_SPEC, logic: () => new PinballLogic(), view: () => import('./pinball.view') }),
]

export const deviceById = (id: string | null | undefined) => DEVICES.find((d) => d.spec.id === id)
