/** Measurements, not golden answer tables. All candidates execute the identical fixture and metric functions. */
import { FIXTURE_NAMES, measureFixture, repeatability, type FixtureResult } from './fixtures'
import { fixtureFailures } from './fixture-validation'
import { lifecycleProbe, type Probe } from './probe'
import type { BackendFactory, EngineId } from './schema'
export interface MeasuredFixture extends Omit<FixtureResult, 'trajectory'> { repeatabilityMaxDelta: number | null; repeatFailures: string[]; sampledFrames: number }
export interface Transfer { rawBytes: number; gzipBytes: number; files: number }
export interface CandidateResult {
  id: EngineId; environment: string; status: 'measured' | 'blocked'; blocker: string | null; factoryLoadMs: number | null; coldInitMs: number | null
  browserErrors?: string[]
  transfer: Transfer | null; browserHeapBytes: number | null; fixtures: MeasuredFixture[]; lifecycle: Probe[]
}
export async function measureCandidate(id: EngineId, load: () => Promise<BackendFactory>, environment: string): Promise<CandidateResult> {
  const result: CandidateResult = { id, environment, status: 'blocked', blocker: null, factoryLoadMs: null, coldInitMs: null,
    transfer: null, browserHeapBytes: null, fixtures: [], lifecycle: [] }
  try {
    const start = performance.now(), factory = await load(); result.factoryLoadMs = performance.now() - start
    for (const name of FIXTURE_NAMES) {
      const first = await measureFixture(factory, name), second = await measureFixture(factory, name)
      if (name === 'drop' && first.initMs !== null) result.coldInitMs = result.factoryLoadMs + first.initMs
      const { trajectory, ...row } = first
      result.fixtures.push({ ...row, sampledFrames: trajectory.length, repeatabilityMaxDelta: repeatability(trajectory, second.trajectory), repeatFailures: second.failures })
    }
    result.lifecycle = await lifecycleProbe(factory)
    result.status = 'measured'
  } catch (error) { result.blocker = error instanceof Error ? error.message : String(error) }
  return result
}
export function candidateFailures(row: CandidateResult): string[] {
  const errors: string[] = [...(row.browserErrors ?? []).map(e => `browser error: ${e}`)]
  if (row.status !== 'measured') errors.push(`candidate blocked: ${row.blocker}`)
  if (row.fixtures.length !== FIXTURE_NAMES.length || new Set(row.fixtures.map(f => f.fixture)).size !== FIXTURE_NAMES.length) errors.push('fixture inventory incomplete')
  for (const name of FIXTURE_NAMES) {
    const f = row.fixtures.find(f => f.fixture === name)
    if (!f) { errors.push(`${name}: missing fixture`); continue }
    errors.push(...fixtureFailures(name, f.metrics).map(e => `${name}: ${e}`))
    if (f.initMs === null || !Number.isFinite(f.initMs) || f.initMs < 0) errors.push(`${name}: init time missing or invalid`)
    if (!f.version || !f.capabilities) errors.push(`${name}: backend metadata missing`)
    if (f.status !== 'measured') errors.push(`${name}: blocked: ${f.blocker}`)
    errors.push(...f.failures.map(e => `${name}: ${e}`), ...f.repeatFailures.map(e => `${name} replay: ${e}`))
    if (f.repeatabilityMaxDelta === null || !Number.isFinite(f.repeatabilityMaxDelta) || f.repeatabilityMaxDelta > 1e-6) errors.push(`${name}: replay differs or was not measured`)
    const cpu = f.cpuMs
    if (![cpu.p50, cpu.p95, cpu.p99].every(n => Number.isFinite(n) && n >= 0) || cpu.p50 > cpu.p95 || cpu.p95 > cpu.p99 || !Number.isInteger(cpu.samples) || cpu.samples <= 0) errors.push(`${name}: CPU measurement absent or invalid`)
  }
  if (row.coldInitMs === null || !Number.isFinite(row.coldInitMs) || row.coldInitMs < 0) errors.push('cold init time missing or invalid')
  if (row.lifecycle.length !== 3 || new Set(row.lifecycle.map(p => p.name)).size !== 3) errors.push('lifecycle probe inventory incomplete')
  errors.push(...row.lifecycle.filter(p => !p.passed).map(p => `${p.name}: ${p.error}`))
  return errors
}
