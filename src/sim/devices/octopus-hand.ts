/**
 * Cove by the phone camera's hand (the Hand camera; docs/OCTOPUS.md, O4). The four fingers' curls drive the four
 * mirrored arm pairs, front to back (index, middle, ring, little): a finger curled past `lift` lifts its pair off the
 * floor and curls it with the finger; opened below `lower`, the pair reaches back down. A pinch grabs the ball and
 * opening it lets go. A lost hand (untracked, unsure, stale or unusable) lets every arm back down and cancels a pinch's
 * reach; a ball already held stays held. This file is the pure part: hand frames in, smoothed curls and edges out.
 */
import { HandGesture } from '@obpal/core'
import type { Frame } from '@obpal/host'

type Hand = Frame['hand']

/**
 * Design values: the tracker confidence below which a frame counts as lost; the curls that lift and lower a pair
 * (apart, so a finger held near one threshold does not flicker); the curls' smoothing (seconds); and how long a pinch
 * must be open before it counts as let go (seconds), so a frame or two of missed pinch does not drop the ball.
 */
export const HAND = { confidence: 0.6, lift: 0.55, lower: 0.35, smoothing: 0.12, release: 0.25 }

/** The base landmark of each finger, index to little, in the 21-point hand. */
const FINGERS = [5, 9, 13, 17] as const

/**
 * How curled each finger is, index to little: 0 straight, 1 fully curled. A finger's curl is the sum of its three
 * joint bends (knuckle, middle and end joints), as a fraction of 2.6 rad. Null when the landmarks are unusable.
 */
export function fingerCurls(landmarks: readonly (readonly number[])[]): [number, number, number, number] | null {
  if (landmarks.length !== 21 || !landmarks.every((p) => p.length >= 3 && p.every(Number.isFinite))) return null
  const curls: number[] = []
  for (const base of FINGERS) {
    const chain = [0, base, base + 1, base + 2, base + 3]
    let bend = 0
    for (let k = 1; k < 4; k++) {
      const a = landmarks[chain[k - 1]], b = landmarks[chain[k]], c = landmarks[chain[k + 1]]
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - b[0], vy = c[1] - b[1], vz = c[2] - b[2]
      const lu = Math.hypot(ux, uy, uz), lv = Math.hypot(vx, vy, vz)
      if (lu < 1e-6 || lv < 1e-6) return null
      bend += Math.acos(Math.min(1, Math.max(-1, (ux * vx + uy * vy + uz * vz) / (lu * lv))))
    }
    curls.push(Math.min(1, Math.max(0, bend / 2.6)))
  }
  return curls as [number, number, number, number]
}

/** What one frame of the hand did: tracking just lost, a pinch just closed, a pinch just let go. */
export interface HandEdges { lost: boolean; pinch: boolean; unpinch: boolean }

/** The hand's state across frames: smoothed curls and a debounced pinch. */
export class HandControl {
  /** Smoothed curls, index to little; all zero while no hand drives. */
  readonly curls: [number, number, number, number] = [0, 0, 0, 0]
  /** A tracked hand is driving. */
  active = false
  /** The pinch, debounced. */
  pinched = false
  private open = 0

  step(hand: Hand | undefined, dt: number): HandEdges {
    const curls = hand && hand.tracked && hand.confidence >= HAND.confidence ? fingerCurls(hand.landmarks) : null
    if (!hand || !curls) {
      const lost = this.active
      this.active = false
      this.curls.fill(0)
      this.pinched = false
      this.open = 0
      return { lost, pinch: false, unpinch: false }
    }
    this.active = true
    const pinching = !!(hand.gestures & HandGesture.pinch), k = 1 - Math.exp(-Math.max(0, dt) / HAND.smoothing)
    // A pinch bends the index finger too: its curl holds while the pinch is on, so grabbing does not lift the front pair.
    for (let i = pinching || this.pinched ? 1 : 0; i < 4; i++) this.curls[i] += (curls[i] - this.curls[i]) * k
    let pinch = false, unpinch = false
    if (pinching) {
      this.open = 0
      if (!this.pinched) this.pinched = pinch = true
    } else if (this.pinched && (this.open += dt) >= HAND.release) {
      this.pinched = false
      unpinch = true
    }
    return { lost: false, pinch, unpinch }
  }
}
