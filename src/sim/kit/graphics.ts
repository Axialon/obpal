/** A constructor failure is distinct from a scene or model that could not be loaded. */
export class GraphicsUnavailable extends Error {
  constructor(cause: unknown) { super('3D graphics are unavailable', { cause }) }
}

/** Only renderer construction belongs to this error; asset failures keep their own recovery. */
export function startGraphics<T>(create: () => T): T {
  try { return create() } catch (cause) { throw new GraphicsUnavailable(cause) }
}
