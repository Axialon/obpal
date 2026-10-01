/** Deterministic, conservative selection rule. Missing measurements are not zero-cost passes. */
import { candidateFailures, type CandidateResult } from './bench'
import type { EngineId } from './schema'
export interface Decision { status: 'selected' | 'pending'; selected: EngineId | null; reason: string; eligible: EngineId[] }
export function selectEngine(rows: readonly CandidateResult[], allowed: readonly EngineId[] = ['rapier', 'physx']): Decision {
  const pending = (reason: string): Decision => ({ status: 'pending', selected: null, reason, eligible: [] })
  if (rows.length !== 3 || new Set(rows.map(r => r.id)).size !== 3) return pending('Require one row for every candidate')
  if (!rows.every(r => r.environment.startsWith('browser:')) || new Set(rows.map(r => r.environment)).size !== 1) return pending('Require a like-for-like browser profile; do not compare Node with browser')
  if (rows.some(r => r.status !== 'measured' || r.fixtures.length !== 7)) return pending('At least one candidate was not measured; retain the documented provisional selection')
  // The custom candidate explicitly lacks box/box contacts and reduced coordinates. Measure it, but do not
  // select it as the common production backend on the basis of the narrow fixtures it happens to support.
  const eligible = rows.filter(r => allowed.includes(r.id) && r.id !== 'custom' && candidateFailures(r).length === 0 && r.transfer !== null &&
    Number.isFinite(r.transfer.rawBytes) && r.transfer.rawBytes > 0 && Number.isFinite(r.transfer.gzipBytes) && r.transfer.gzipBytes > 0 &&
    r.fixtures.every(f => Number.isFinite(f.cpuMs.p95) && f.cpuMs.p95 > 0))
  if (!eligible.length) return pending('No production-capable candidate passes all measured correctness/replay/lifecycle floors with bytes and resolved timing')
  const metric = (r: CandidateResult, name: string) => Math.max(...r.fixtures.map(f => f.metrics[name] ?? 0))
  const qualityTier = (r: CandidateResult) => metric(r, 'constraintErrorM') <= .005 && metric(r, 'peakConeErrorRad') <= .03 && metric(r, 'energyDriftRelative') <= .10 ? 0 : 1
  const cpu = (r: CandidateResult) => Math.max(...r.fixtures.map(f => f.cpuMs.p95))
  const tiers = eligible.filter(r => qualityTier(r) === Math.min(...eligible.map(qualityTier)))
  // Correctness tier first; then worst-fixture step p95. Only within 10% of the fastest use gzip bytes.
  const fastest = Math.min(...tiers.map(cpu)), finalists = tiers.filter(r => cpu(r) <= fastest * 1.1)
  finalists.sort((a, b) => a.transfer!.gzipBytes - b.transfer!.gzipBytes || a.id.localeCompare(b.id))
  return { status: 'selected', selected: finalists[0].id, eligible: eligible.map(r => r.id),
    reason: 'Passed correctness/replay/lifecycle; lowest articulation/energy-error tier; worst-fixture step p95 within 10% of fastest; smallest measured gzip payload' }
}

/** One integration decision: pass both measured profiles, then rank on the CPU-stressed profile. */
export function selectAcrossProfiles(rows: readonly CandidateResult[]): Decision {
  const profiles = ['browser:chromium-native', 'browser:chromium-4x-throttle']
  const groups = profiles.map(profile => rows.filter(r => r.environment === profile))
  if (rows.length !== 6 || groups.some(g => g.length !== 3)) return { status: 'pending', selected: null, eligible: [], reason: 'Require all three candidates in both named browser profiles' }
  const native = selectEngine(groups[0])
  if (native.status !== 'selected') return native
  const stress = selectEngine(groups[1], native.eligible)
  return stress.status === 'selected' ? { ...stress, reason: `Passes both profiles; stressed-profile ranking: ${stress.reason}` } : stress
}
