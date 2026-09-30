/** A bounded, deterministic light signature; reduced motion holds an open, centred face. */
import * as THREE from 'three'
import type { RigProfile } from './profile'

export function faceState(seconds: number, tracking: boolean, reduced: boolean, horizon = false) {
  const t = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  const phase = t % 6.4
  const blink = reduced ? 1 : 1 - Math.max(0, 1 - Math.abs(phase - 5.7) / .12)
  return {
    blink: horizon ? .35 + .65 * blink : Math.max(.08, blink),
    x: reduced ? 0 : Math.sin(t * .48) * .005,
    y: reduced ? 0 : Math.sin(t * .31) * .0015,
    glow: tracking ? (reduced ? 1.12 : 1.12 + .12 * Math.sin(t * 2)) : .85,
  }
}
export class FaceLight {
  readonly material = new THREE.MeshBasicMaterial({ color: '#c6ff34', toneMapped: false })
  readonly uniforms = { blink: { value: 1 }, glance: { value: new THREE.Vector2() }, glow: { value: .85 }, centre: { value: this.profile.face!.centre } }
  constructor(private profile: RigProfile) {
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms.softBlink = this.uniforms.blink
      shader.uniforms.softGlance = this.uniforms.glance
      shader.uniforms.softGlow = this.uniforms.glow
      shader.uniforms.softCentre = this.uniforms.centre
      shader.uniforms.softScale = { value: this.profile.height / 1.8 }
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform float softBlink; uniform float softCentre; uniform float softScale; uniform vec2 softGlance;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          transformed.y = softCentre + (transformed.y - softCentre) * softBlink + softGlance.y;
          transformed.x += softGlance.x;
          float sx = transformed.x / (0.094 * softScale);
          float sy = (transformed.y - 0.165 * softScale) / (0.125 * softScale);
          transformed.z = (0.008 - 0.093 * sqrt(max(0.01, 1.0 - sx*sx - sy*sy)) - 0.0023) * softScale;`)
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float softGlow;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= softGlow;')
    }
    this.material.customProgramCacheKey = () => 'soft-face-v1'
  }
  step(seconds: number, tracking: boolean, reduced: boolean) {
    const state = faceState(seconds, tracking, reduced, this.profile.face!.horizon)
    this.uniforms.blink.value = state.blink
    this.uniforms.glance.value.set(state.x, state.y)
    this.uniforms.glow.value = state.glow
  }
  dispose() { this.material.dispose() }
}
