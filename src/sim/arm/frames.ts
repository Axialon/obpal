/**
 * Frames in the world, for the arms' parts and joints (./blocks.ts, ./kin.ts): a rotation and a place, x ↦ R·x + t
 * (R row-major), nested as three.js nests groups. World metres, y up. Pure.
 */
import type { V3 } from './grasp'

export interface Frame { R: number[]; t: V3 }

export const ID: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1]
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2])
export const unit = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l] }

/** Turns about x, y and z by `a` radians, as three.js turns a group's rotation. */
export const rotX = (a: number) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c] }
export const rotY = (a: number) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c] }
export const rotZ = (a: number) => { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1] }
export const mulR = (A: readonly number[], B: readonly number[]) => [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j]))
export const mulV = (R: readonly number[], v: V3): V3 => [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]]
/** The transposed rotation times v: a world direction in the frame's own terms. */
export const mulTV = (R: readonly number[], v: V3): V3 => [R[0] * v[0] + R[3] * v[1] + R[6] * v[2], R[1] * v[0] + R[4] * v[1] + R[7] * v[2], R[2] * v[0] + R[5] * v[1] + R[8] * v[2]]
/** A frame's axis `i` (0 x, 1 y, 2 z), in the world. */
export const col = (R: readonly number[], i: number): V3 => [R[i], R[3 + i], R[6 + i]]
/** A point given in a frame's own terms, in the world. */
export const place = (f: Frame, v: V3): V3 => { const r = mulV(f.R, v); return [r[0] + f.t[0], r[1] + f.t[1], r[2] + f.t[2]] }
/** A frame nested in `f`: placed at `t` in f's terms, turned by `R` (a group's position, then its rotation). */
export const nest = (f: Frame, R: readonly number[], t: V3): Frame => ({ R: mulR(f.R, R), t: place(f, t) })
