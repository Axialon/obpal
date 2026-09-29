import { describe, expect, it, vi } from 'vitest'
import { Group, PerspectiveCamera, Quaternion, Scene, Vector3 } from 'three'
import { HandGesture, type Vec3 } from '@obpal/core'
import { CameraHandMotion, palmRotation, type CameraHand } from '../src/ui/hand-control'
import { ViewerHandInput } from '../src/viewer/hand-input'
import { ArmHandInput } from '../src/sim/arm/hand-input'

function hand(p: Vec3 = [0, 0, -0.5], gestures = 0, gen = 1, turn = new Quaternion()): CameraHand {
  const landmarks: Vec3[] = Array.from({ length: 21 }, () => [0, 0, 0])
  landmarks[0] = [0, -0.05, 0]; landmarks[5] = [0.035, 0.01, 0]
  landmarks[9] = [0, 0.04, 0]; landmarks[17] = [-0.035, 0.01, 0]
  return { p, gestures, gen, tracked: true, confidence: 0.95, handedness: 'right', landmarks: landmarks.map(p => new Vector3(...p).applyQuaternion(turn).toArray()) }
}

describe('camera hand anchors', () => {
  it('measures the palm basis and movement once per sample', () => {
    const input = new CameraHandMotion(), turn = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.3)
    expect(input.step(hand(), 'part')?.delta).toEqual([0, 0, 0])
    const h = hand([0.1, 0.2, -0.6], 0, 1, turn)
    const moved = input.step(h, 'part')!
    expect(moved.delta[0]).toBeCloseTo(0.1); expect(moved.delta[1]).toBeCloseTo(0.2); expect(moved.delta[2]).toBeCloseTo(-0.1)
    expect(new Quaternion(...moved.turn).angleTo(turn)).toBeCloseTo(0)
    expect(new Quaternion(...palmRotation(h)!).angleTo(turn)).toBeCloseTo(0)
    expect(input.step(h, 'part')?.delta).toEqual([0, 0, 0])
    expect(new Quaternion(...input.step(h, 'part')!.turn).angleTo(new Quaternion())).toBeCloseTo(0)
  })

  it('holds and re-anchors after loss, stale null, identity or target changes', () => {
    const input = new CameraHandMotion()
    input.step(hand(), 'part')
    for (const missing of [null, { ...hand(), tracked: false }]) {
      expect(input.step(missing, 'part')).toBeNull()
      expect(input.step(hand([0.7, 0.4, -1]), 'part')).toMatchObject({ delta: [0, 0, 0], started: true })
    }
    expect(input.step(hand([-0.4, 0.1, -0.2], 0, 2), 'part')).toMatchObject({ delta: [0, 0, 0], started: true })
    expect(input.step(hand([0.2, 0.1, -0.5], 0, 2), 'other')).toMatchObject({ delta: [0, 0, 0], started: true })
  })

  it('holds when a palm has no usable landmark basis', () => {
    const input = new CameraHandMotion(), h = hand()
    input.step(h, 'part')
    h.landmarks = Array.from({ length: 21 }, () => [0, 0, 0])
    expect(input.step(h, 'part')).toBeNull()
    expect(input.step(hand([1, 0, -0.5]), 'part')?.delta).toEqual([0, 0, 0])
  })
})

function viewer() {
  const scene = new Scene(), target = new Group(), other = new Group(), camera = new PerspectiveCamera()
  camera.position.z = 6; scene.add(camera, target, other); scene.updateMatrixWorld(true)
  const controls = { distance: 5, rotate: vi.fn(), dolly: vi.fn() }
  return { target, other, camera, controls, orbit: true }
}

describe('Viewer camera hands', () => {
  it('hovers with an open palm without moving the camera or model', () => {
    const input = new ViewerHandInput(), ctx = viewer()
    input.step(hand(), ctx, 0)
    input.step(hand([0.1, 0.05, -0.4]), ctx, 100)
    expect(ctx.controls.rotate).not.toHaveBeenCalled()
    expect(ctx.controls.dolly).not.toHaveBeenCalled()
    expect(ctx.target.position.toArray()).toEqual([0, 0, 0])
  })

  it.each([HandGesture.pinch])('grabs with gesture %s in the viewing camera frame', (gesture) => {
    const input = new ViewerHandInput(), ctx = viewer()
    ctx.camera.rotation.y = Math.PI / 2
    ctx.camera.updateMatrixWorld(true)
    input.step(hand(), ctx)
    input.step(hand([0.4, 0, -0.5], gesture), ctx)
    expect(ctx.target.position.length()).toBe(0)
    const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.2)
    input.step(hand([0.5, 0, -0.5], gesture, 1, turn), ctx)
    expect(ctx.target.position.x).toBeCloseTo(0)
    expect(ctx.target.position.z).toBeCloseTo(-0.6)
    const basis = ctx.camera.quaternion
    expect(ctx.target.quaternion.angleTo(basis.clone().multiply(turn).multiply(basis.clone().invert()))).toBeCloseTo(0)
    expect(ctx.other.position.length()).toBe(0)
    expect(ctx.controls.rotate).not.toHaveBeenCalled()
  })

  it('leaves other participants and selected parts in place without a grab', () => {
    const input = new ViewerHandInput(), ctx = viewer()
    ctx.orbit = false
    input.step(hand(), ctx); input.step(hand([0.2, 0.1, -0.2]), ctx)
    expect(ctx.controls.rotate).not.toHaveBeenCalled(); expect(ctx.target.position.length()).toBe(0)
    input.step(hand([0.2, 0.1, -0.2], HandGesture.pinch), { ...ctx, target: null })
    input.step(hand([0.5, 0.1, -0.2], HandGesture.pinch), { ...ctx, target: null })
    expect(ctx.controls.rotate).not.toHaveBeenCalled(); expect(ctx.other.position.length()).toBe(0)
  })

  it('holds a grabbed object through loss and does not jump on a new hand identity', () => {
    const input = new ViewerHandInput(), ctx = viewer()
    input.step(hand([0, 0, -0.5], HandGesture.pinch), ctx)
    input.step(hand([0.1, 0, -0.5], HandGesture.pinch), ctx)
    const held = ctx.target.position.clone()
    input.step(null, ctx)
    input.step(hand([0.8, 0, -0.5], HandGesture.pinch), ctx)
    expect(ctx.target.position.distanceTo(held)).toBe(0)
    input.step(hand([-0.3, 0, -0.5], HandGesture.pinch, 2), ctx)
    expect(ctx.target.position.distanceTo(held)).toBe(0)
  })
})

describe('robot arm camera hands', () => {
  it('requires the held control, follows palm position and turns, and reads pinch for the gripper', () => {
    const input = new ArmHandInput()
    expect(input.step(hand(), false, 'holder')).toBeNull()
    expect(input.step(hand(), true, 'holder')?.delta).toEqual([0, 0, 0])
    const turn = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.4)
    const moved = input.step(hand([0.03, 0.02, -0.54], HandGesture.pinch, 1, turn), true, 'holder')!
    expect(moved.delta[0]).toBeCloseTo(0.03); expect(moved.delta[1]).toBeCloseTo(0.02); expect(moved.delta[2]).toBeCloseTo(-0.04)
    expect(new Quaternion(...moved.rotation).angleTo(turn)).toBeCloseTo(0)
    expect(moved.pinch).toBe(true)
    expect(input.step(hand(), true, 'holder')?.pinch).toBe(false)
  })

  it('drops its anchor on release or loss and re-anchors on holder and identity changes', () => {
    const input = new ArmHandInput()
    input.step(hand(), true, 'one')
    expect(input.step(null, true, 'one')).toBeNull()
    expect(input.step(hand([0.4, 0.2, -0.7]), true, 'one')?.delta).toEqual([0, 0, 0])
    expect(input.step(hand(), false, 'one')).toBeNull()
    expect(input.step(hand(), true, 'one')?.delta).toEqual([0, 0, 0])
    expect(input.step(hand([0.6, 0.1, -0.6], 0, 2), true, 'one')?.delta).toEqual([0, 0, 0])
    expect(input.step(hand(), true, 'two')?.delta).toEqual([0, 0, 0])
  })

  it('keeps Stop latched until the held control is released, then starts without a jump', () => {
    const input = new ArmHandInput()
    input.step(hand(), true, 'holder')
    input.stop()
    expect(input.step(hand([0.5, 0.5, -1], HandGesture.pinch), true, 'holder')).toBeNull()
    input.reset()
    expect(input.step(hand([0.5, 0.5, -1], HandGesture.pinch, 2), true, 'holder')).toBeNull()
    expect(input.step(hand(), false, 'holder')).toBeNull()
    expect(input.step(hand([0.5, 0.5, -1]), true, 'holder')?.delta).toEqual([0, 0, 0])
  })
})
