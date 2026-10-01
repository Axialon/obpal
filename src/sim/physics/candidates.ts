/** BENCH ONLY. Keeping this graph separate prevents production from bundling all three candidates. */
import type { EngineId, BackendFactory } from './schema'
export const CANDIDATES: Readonly<Record<EngineId, () => Promise<BackendFactory>>> = {
  custom: () => import('./backends/custom').then(m => m.createCustomBackend),
  rapier: () => import('./backends/rapier').then(m => m.createRapierBackend),
  physx: () => import('./backends/physx').then(m => m.createPhysXBackend),
}
