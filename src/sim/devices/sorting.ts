/** Two independent sorting cells: choose a colour lane, then push the waiting part into its bin. */
import { Controller } from '@obpal/core'
import { action, Machine, timestep } from './common'
import { approach, axis, clamp } from './input'
import type { DeviceInput, DeviceSpec } from './types'
import { rail } from '../vr/intent'

export const SORTING_SPEC: DeviceSpec = {
  id: 'sorting',
  name: 'Sorting cell',
  unit: 'Cell',
  units: 2,
  kind: 'Robot',
  blurb: 'Match each conveyor part to a colour bin and send it through with the pusher.',
  teaches: 'Pointing selects a lane and a button starts one machine cycle',
  controllers: [Controller.wii, Controller.trackpad, Controller.gamepad],
  how: {
    'face.wii': 'Point at a colour lane · A sorts the waiting part · touchpad aiming works too',
    'face.trackpad': 'Drag sideways to choose a lane · tap or Sort pushes the waiting part',
    'face.gamepad': 'Left stick chooses a lane · A sorts the waiting part',
  },
  tray: [{ id: 'sort', label: 'Sort', type: 'button', icon: 'grip' }],
  buttons: { 'media:playpause': 'tray:sort', 'key:Space': 'tray:sort' },
}

export const SORTING = { centres: [-2.1, 2.1], lanes: [-0.9, 0, 0.9], colours: ['#e98d7c', '#ead16b', '#78bdd2'], names: ['Coral', 'Gold', 'Blue'], start: -2.2, ready: 0.15, bin: 1.55 }
export interface SortPart { z: number; colour: number }
export interface SortingCell {
  x: number
  lane: number
  aim: number
  /** The selected lane is latched for a cycle; changing aim affects the next part. */
  target: number
  phase: 'ready' | 'carry' | 'push' | 'return'
  push: number
  held: number | null
  parts: SortPart[]
  next: number
  score: number
  missed: number
  actions: number
  bins: number[]
  belt: number
  active: boolean
}

function loadParts(): SortPart[] {
  return [{ z: SORTING.ready, colour: 1 }, { z: -0.7, colour: 2 }, { z: -1.55, colour: 0 }]
}

export class SortingLogic extends Machine {
  readonly spec = SORTING_SPEC
  units: SortingCell[] = [0, 1].map(() => ({
    x: 0, lane: 1, aim: 0, target: 1, phase: 'ready', push: 0, held: null,
    parts: loadParts(), next: 1, score: 0, missed: 0, actions: 0, bins: [0, 0, 0], belt: 0, active: false,
  }))

  home(n: number) {
    Object.assign(this.units[n], {
      x: 0, lane: 1, aim: 0, target: 1, phase: 'ready', push: 0, held: null,
      parts: loadParts(), next: 1, belt: 0, active: false,
    })
  }

  readout(n: number) {
    const u = this.units[n]
    const waiting = u.parts[0]?.colour
    return `${u.score} sorted · ${u.missed} missed · ${SORTING.names[u.lane]} lane${u.phase === 'ready' && waiting !== undefined ? ` · next ${SORTING.names[waiting]}` : ''}`
  }

  step(inputs: readonly (DeviceInput | null)[], delta: number) {
    const dt = timestep(delta)
    this.units.forEach((u, n) => {
      const input = inputs[n] ?? null,
        live = input && !input.quiet ? input : null
      u.active = !!live
      if (live) {
        if (live.point && !live.point.off) {
          u.aim = live.spot ? live.spot[0] - SORTING.centres[n] : live.point.yaw * 0.045
        } else if (live.pad) u.aim += axis(live.pad.axes[0]) * dt * 2.5 * rail(live.controlFrame)
        else if (live.touching) u.aim += live.drag[0] * 0.012 * rail(live.controlFrame)
        u.aim = clamp(u.aim, -0.9, 0.9)
        u.lane = Math.round(u.aim / 0.9) + 1
      }
      if (action(input, 'sort')) {
        u.actions++
        if (u.phase === 'ready' && u.parts[0]?.z >= SORTING.ready - 0.02) {
          u.held = u.parts.shift()!.colour
          u.target = u.lane
          u.phase = 'carry'
          this.events.push({ unit: n, kind: 'tick', text: `${SORTING.names[u.target]} lane selected` })
        }
      }
      // A lost phone freezes both the belt and an unfinished pusher cycle.
      if (!live || !dt) return
      if (u.phase === 'carry') {
        u.x = approach(u.x, SORTING.lanes[u.target], 2.5, dt)
        if (u.x === SORTING.lanes[u.target]) u.phase = 'push'
      } else if (u.phase === 'push') {
        u.push = approach(u.push, 1, 1.6, dt)
        if (u.push === 1) {
          u.bins[u.target]++
          const correct = u.held === u.target
          if (correct) u.score++
          else u.missed++
          u.held = null
          u.phase = 'return'
          this.events.push({ unit: n, kind: correct ? 'score' : 'bump', text: correct ? `Colour matched · ${u.score} sorted` : 'Try the matching colour bin' })
        }
      } else if (u.phase === 'return') {
        u.push = approach(u.push, 0, 2.2, dt)
        if (!u.push) {
          u.x = approach(u.x, 0, 2.5, dt)
          if (!u.x) u.phase = 'ready'
        }
      }
      const travel = dt * 0.65
      let stop = u.phase === 'ready' ? SORTING.ready : -0.6
      for (const p of u.parts) {
        p.z = Math.min(stop, p.z + travel)
        stop = p.z - 0.7
      }
      if (!u.parts.length || u.parts[u.parts.length - 1].z > SORTING.start + 0.8) {
        u.parts.push({ z: SORTING.start, colour: u.next % 3 })
        u.next++
      }
      u.belt = (u.belt + travel) % 0.24
    })
  }
}
