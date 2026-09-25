/**
 * The Blackboxes trade-off model runtime, vendored from the BlackBoxes repo (shared/model-core.js and
 * shared/spatial-drag.js; refresh with `pnpm run sync:family`). Both are dependency-free classic scripts that
 * register globals; this module gives them types.
 */
import * as coreModule from './model-core.js'
import * as dragModule from './spatial-drag.js'

export interface FieldSpec { pillar: string; min: number; max: number; default: number; unit: string }
export interface EngineDefinition { app: string; category: string; defaultLock: string; fields: Record<string, FieldSpec>; locks?: string[] }
export type Constraints = Record<string, unknown>
export interface SolveResult { valid: boolean; errors: string[]; constraints: Constraints; adjustments?: { field: string; input: number; effective: number; reason: string }[] }

export interface ModelsApi {
  version: string
  definitions: Record<string, EngineDefinition>
  defaults(engine: string): Constraints
  solve(engine: string, input: Constraints, options?: { changed?: string; solveFor?: string; locked?: string[] }): SolveResult
  /** Pillars that can absorb a change to `changed`, in the engine's preferred order. */
  solveTargets(engine: string, changed: string): string[]
}

export interface VisualMapping { min: number; max: number; span: number; anchor: number; mirror: boolean; bend: number | null; logSpan: number | null; inverse: boolean }
export interface SpatialApi {
  visualMapping(engine: string, key: string, limits?: { min?: number; max?: number }): VisualMapping
  visualFraction(map: VisualMapping, value: number): number
  visualValue(map: VisualMapping, fraction: number): number
  radialProfile(engine: string, surface?: 'index' | 'showcase'): { min: number; max: number; hullScale: number }
}

// In the browser the scripts register globals; under a CommonJS-style loader (the test runner) they export instead.
// spatial-drag looks the solver up on the global, so make sure it is there either way.
const g = globalThis as unknown as { BlackboxesModels?: ModelsApi; BlackboxesSpatialDrag?: SpatialApi }
const fromModule = <T>(ns: unknown): T | undefined => (ns as { default?: T }).default
g.BlackboxesModels ??= fromModule<ModelsApi>(coreModule)
g.BlackboxesSpatialDrag ??= fromModule<SpatialApi>(dragModule)
export const models: ModelsApi = g.BlackboxesModels!
export const spatial: SpatialApi = g.BlackboxesSpatialDrag!
