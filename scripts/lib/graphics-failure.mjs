/** Isolated failures for recovery tests and the explicitly requested evidence captures. */
export const GRAPHICS_SCENES = ['drone', 'studio', 'lamp', 'arm', 'humanoid', 'arena']

export async function failGraphics(context, kind) {
  if (kind === 'context') await context.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return /^(webgl2?|experimental-webgl)$/.test(type) ? null : original.call(this, type, ...args)
    }
  })
  if (kind === 'model' || kind === 'slow') await context.route('**/models/drone.glb', async route => {
    await new Promise(resolve => setTimeout(resolve, kind === 'slow' ? 7000 : 1000))
    if (kind === 'model') await route.abort()
    else await route.continue().catch(() => {})
  })
  if (kind === 'import') await context.route('**/assets/drone.view-*.js', route => route.abort())
}
