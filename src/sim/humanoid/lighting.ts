/** A dark studio reflected in the shells, without a cubemap download or live reflection pass. */
import * as THREE from 'three'
import type { Stage } from '../devices/stage'

export function lightArena(stage: Stage) {
  const room = new THREE.Scene()
  room.background = new THREE.Color(0.16, 0.17, 0.17)
  for (const [position, size, intensity] of [
    [[-3, 4, -3], [5, 6], 10],
    [[2, 3, 2], [3, 5], 12],
    [[3, 1.7, -2], [3, 4], 5],
  ] as const) {
    const card = new THREE.Mesh(
      new THREE.PlaneGeometry(...size),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(intensity, intensity, intensity) }),
    )
    card.position.set(position[0], position[1], position[2])
    card.lookAt(0, 0.8, 0)
    room.add(card)
  }
  const generator = new THREE.PMREMGenerator(stage.renderer)
  const environment = generator.fromScene(room, 0.06)
  stage.scene.environment?.dispose()
  stage.scene.environment = environment.texture
  stage.scene.environmentIntensity = 0.8
  generator.dispose()
  room.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (mesh.isMesh) {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
    }
  })
  stage.ground.position.y = -0.14
  stage.lights.key.position.set(-3, 4, -3)
  stage.lights.key.intensity = 3.2
  const rim = new THREE.DirectionalLight('#d8ebed', 1.4)
  rim.position.set(2, 3, 2)
  stage.scene.add(rim)
}

/** Soft sole contact, independent of shadow maps and screen resolution. */
export function soleShadow() {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.32, 0.48),
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { strength: { value: 0.5 } },
      vertexShader:
        'varying vec2 p; void main(){p=uv*2.-1.;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader:
        'varying vec2 p; uniform float strength; void main(){float a=pow(max(0.,1.-dot(p,p)),2.)*strength;gl_FragColor=vec4(0.,0.,0.,a);}',
    }),
  )
  mesh.rotation.x = -Math.PI / 2
  mesh.position.y = 0.002
  return mesh
}
