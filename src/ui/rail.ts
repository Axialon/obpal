/** Lock a gesture once it has left the small press tolerance; never change its axis afterwards. */
export function railAxis(x: number, y: number): 'x' | 'y' | null {
  return Math.max(Math.abs(x), Math.abs(y)) < 8 ? null : Math.abs(x) > Math.abs(y) ? 'x' : 'y'
}

/** A bounded rubber band beyond either end; the position within the rail follows the finger. */
export function railPull(value: number, end: number): number {
  const rubber = (distance: number) => 48 * distance / (48 + distance)
  return value < 0 ? -rubber(-value) : value > end ? end + rubber(value - end) : value
}
