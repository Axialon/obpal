/** Map source pixels through object-fit: cover. The canvas itself is never stretched. */
export function coverPoint(x: number, y: number, sourceWidth: number, sourceHeight: number, width: number, height: number, mirror = false) {
  const scale = Math.max(width / sourceWidth, height / sourceHeight)
  return { x: ((mirror ? sourceWidth - x : x) - sourceWidth / 2) * scale + width / 2, y: (y - sourceHeight / 2) * scale + height / 2 }
}
