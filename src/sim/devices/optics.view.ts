/** Shared camera monitor and named rigid groups for the camera and science models. */
import * as THREE from 'three'
import type { Stage } from './stage'

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
  const overlay = document.createElement('div')
  overlay.setAttribute('role', 'img')
  overlay.style.cssText = 'position:fixed;right:12px;top:74px;pointer-events:none;border:1px solid #9eafbb;border-radius:6px;color:#fff;padding:6px;font:11px system-ui;box-sizing:border-box;text-shadow:0 1px 3px #000'
  document.body.append(overlay)
  const title = document.createElement('span'); overlay.append(title)
  if (reticle) { const cross = document.createElement('span'); cross.textContent = '+'; cross.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font:26px monospace;color:#c6ff34'; overlay.append(cross) }
  const size = new THREE.Vector2(), clear = new THREE.Color()
  return () => {
    const r = stage.renderer, eye = camera(), width = Math.min(240, innerWidth * 0.3), height = width * 0.625, y = 74, portrait = innerWidth < innerHeight, x = portrait ? 12 : innerWidth - width - 12
    overlay.style.left = portrait ? '12px' : ''; overlay.style.right = portrait ? '' : '12px'
    title.textContent = label(); overlay.setAttribute('aria-label', label()); overlay.style.width = `${width}px`; overlay.style.height = `${height}px`
    r.getSize(size); r.getClearColor(clear)
    const alpha = r.getClearAlpha(), scale = size.x / stage.view.width
    eye.aspect = width / height; eye.updateProjectionMatrix(); eye.updateWorldMatrix(true, false)
    r.setScissorTest(true); r.setScissor(x * scale, size.y - (y + height) * scale, width * scale, height * scale)
    r.setViewport(x * scale, size.y - (y + height) * scale, width * scale, height * scale)
    r.setClearColor('#101923', 1); r.clear()
    const visible = hide.map(g => g.visible); hide.forEach(g => { g.visible = false })
    stage.view.drawInset(scene, eye)
    hide.forEach((g, n) => { g.visible = visible[n] })
    r.setScissorTest(false); r.setViewport(0, 0, size.x, size.y); r.setClearColor(clear, alpha)
  }
}
