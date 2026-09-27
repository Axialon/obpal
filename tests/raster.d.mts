/** See raster.mjs. */
export function rasterize(
  svg: string,
  size: number,
  opts?: { background?: string; pad?: number; blur?: number },
): Promise<{ data: Uint8ClampedArray; width: number; height: number }>
