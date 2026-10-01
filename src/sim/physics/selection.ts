/** The only production engine selection. Candidates/bench are deliberately not imported here.
 * Change this ONE object (id and its matching literal import) after applying selectEngine's measured rule.
 * Rapier passed both measured Chromium profiles; the stressed-profile timing/payload rule selected it.
 * See docs/PHYSICS-BACKENDS.md for the measured table and adapter limits. */
import { Simulation } from './runtime'
import type { SceneInput, Limits, BackendFactory, EngineId } from './schema'
export const PHYSICS_SELECTION: Readonly<{ id: EngineId; load: () => Promise<BackendFactory> }> = Object.freeze({
  id: 'rapier', load: () => import('./backends/rapier').then(m => m.createRapierBackend),
})
/** No engine import until explicitly called. Never substitute another engine after a fault. */
export async function createSelectedSimulation(scene: SceneInput, limits: Partial<Limits> = {}): Promise<Simulation> {
  // Validate before the lazy import, so malformed input allocates/downloads no engine.
  const { validateScene, validateLimits } = await import('./schema')
  const budget = validateLimits(limits), definition = validateScene(scene, budget)
  const s = new Simulation(definition, await PHYSICS_SELECTION.load(), budget)
  try { await s.init(); return s } catch (error) { s.dispose(); throw error }
}
