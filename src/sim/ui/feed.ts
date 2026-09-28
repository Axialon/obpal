/**
 * A camera picture belongs to its window, so other windows can cover it normally. The picture sits in corner brackets
 * with its caption in small caps; a caption that says it's recording (REC) or playing back lights a status dot, and
 * the frame brightens.
 */
import * as THREE from 'three'
import type { Stage } from '../devices/stage'
import { simPanels } from './panels'

export function cameraFeed(stage: Stage, title: string, id = 'camera', index?: number, content = document.createElement('div')) {
  const canvas = document.createElement('canvas'), caption = document.createElement('span'), dot = document.createElement('i'), words = document.createElement('span')
  content.classList.add('panel-feed', 'kit-brackets'); caption.className = 'feed-caption'; caption.hidden = true; canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', title)
  dot.className = 'kit-dot'; dot.hidden = true; caption.dataset.tone = 'live'; caption.append(dot, words)
  content.prepend(canvas); content.append(caption)
  const panel = simPanels().add(content, { id, title, purpose: 'Live camera picture; enlarge or drag any edge to resize', icon: 'camera', anchor: 'camera', index, camera: true })
  const ctx = canvas.getContext('2d', { alpha: false })!, size = new THREE.Vector2(), clear = new THREE.Color()
  let rect: DOMRect | null = null, active = false
  const measure = () => { rect = null }
  new ResizeObserver(measure).observe(content)
  addEventListener('obpal:panels', measure); addEventListener('resize', measure)
  return {
    panel, content,
    label(text: string) {
      if (canvas.getAttribute('aria-label') === `${title}: ${text}`) return
      const rec = /\bREC\b/.test(text), playback = /\bPLAYBACK\b/.test(text)
      words.textContent = text.replace(/^●\s*/, ''); caption.hidden = !text
      dot.hidden = !rec && !playback; caption.dataset.tone = rec ? 'rec' : 'live'; content.dataset.rec = String(rec)
      canvas.setAttribute('aria-label', `${title}: ${text}`)
    },
    activity(on: boolean) { if (on && !active) panel.notify(); active = on },
    draw(scene: THREE.Scene, eye: THREE.PerspectiveCamera, hide: readonly THREE.Object3D[] = []) {
      if (!panel.visible || stage.view.presence?.immersive) return
      rect ??= content.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return
      const r = stage.renderer; r.getSize(size); r.getClearColor(clear)
      const alpha = r.getClearAlpha(), k = size.x / stage.view.width
      const x = Math.round(rect.x * k), top = Math.round(rect.y * k), w = Math.max(1, Math.round(rect.width * k)), h = Math.max(1, Math.round(rect.height * k))
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
      const viewport = r.getViewport(new THREE.Vector4()), scissor = r.getScissor(new THREE.Vector4()), scissorTest = r.getScissorTest()
      const visible = hide.map(g => g.visible)
      try {
        eye.aspect = rect.width / rect.height; eye.updateProjectionMatrix(); eye.updateWorldMatrix(true, false)
        r.setScissorTest(true); r.setScissor(x, size.y - top - h, w, h); r.setViewport(x, size.y - top - h, w, h)
        r.setClearColor('#10151b', 1); r.clear(); hide.forEach(g => { g.visible = false })
        stage.view.drawInset(scene, eye)
        // Copy while the WebGL buffer is live. The opaque window covers the same patch of the stage.
        ctx.drawImage(r.domElement, x, top, w, h, 0, 0, w, h)
      } finally {
        hide.forEach((g, n) => { g.visible = visible[n] })
        r.setScissorTest(scissorTest); r.setScissor(scissor); r.setViewport(viewport); r.setClearColor(clear, alpha)
      }
    },
  }
}
