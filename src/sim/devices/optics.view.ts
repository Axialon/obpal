/** Shared camera monitor and named rigid groups for the camera and science models. */
import * as THREE from 'three'
import type { Stage } from './stage'
import { cameraFeed } from '../ui/feed'

export function part(parent: THREE.Object3D, name: string) {
  const group = new THREE.Group(); group.name = name; parent.add(group); return group
}

/** A small texture label, authored here and shared by model annotations. */
export function caption(text: string, color = '#e4eacb', width = 1) {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 96
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#16212be6'; ctx.fillRect(0, 0, 512, 96)
  ctx.fillStyle = color; ctx.font = `600 ${Math.min(70, 420 / (text.length * 0.58))}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, 256, 50)
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }))
  sprite.scale.set(width, width * 96 / 512, 1)
  return sprite
}

/** Draw a real second camera into a monitor, restoring renderer state for the next stage frame. */
export function monitor(stage: Stage, scene: THREE.Scene, camera: () => THREE.PerspectiveCamera, label: () => string, hide: readonly THREE.Object3D[] = [], reticle = false) {
  const feed = cameraFeed(stage, reticle ? 'Eyepiece' : 'Camera view')
  if (reticle) { const cross = document.createElement('span'); cross.className = 'feed-reticle'; cross.textContent = '+'; feed.content.append(cross) }
  return () => {
    const text = label(); feed.label(text); feed.activity(text.includes('REC') || text.includes('PLAYBACK')); feed.draw(scene, camera(), hide)
  }
}
