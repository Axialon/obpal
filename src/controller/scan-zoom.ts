/** Camera zoom is relative to its ordinary framing. Digital magnification fills any unsupported range. */
export type ZoomRange = { min: number; max: number; step: number }
export const clampZoom = (value: number) => Math.max(1, Math.min(3, Number.isFinite(value) ? value : 1))

export function zoomMapping(value: number, range?: ZoomRange) {
  const level = clampZoom(value)
  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max) || range.min <= 0 || range.max <= range.min) return { level, hardware: null, digital: level }
  const base = Math.max(range.min, Math.min(range.max, 1))
  const step = range.step > 0 ? range.step : .01
  const hardware = Math.max(range.min, Math.min(range.max, range.min + Math.floor((Math.min(range.max, level * base) - range.min) / step + 1e-6) * step))
  return { level, hardware, digital: Math.max(1, level * base / hardware) }
}

/** The decoder samples exactly the source rectangle visible through object-fit: cover and digital zoom. */
export function zoomCrop(width: number, height: number, viewWidth: number, viewHeight: number, zoom: number) {
  const aspect = viewWidth > 0 && viewHeight > 0 ? viewWidth / viewHeight : width / height
  const cropWidth = Math.min(width, height * aspect) / Math.max(1, zoom)
  const cropHeight = Math.min(height, width / aspect) / Math.max(1, zoom)
  return { x: (width - cropWidth) / 2, y: (height - cropHeight) / 2, width: cropWidth, height: cropHeight }
}

export function pinchZoom(startZoom: number, startDistance: number, distance: number) {
  return clampZoom(startDistance > 0 && Number.isFinite(distance) ? startZoom * distance / startDistance : startZoom)
}
