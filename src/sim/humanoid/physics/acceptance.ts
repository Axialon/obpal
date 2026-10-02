/** Shared, fail-closed acceptance; no renderer dependency. All tolerances below are simulation acceptance defaults. */
export const STANCE_SECONDS = 30 // s, programme acceptance.
export const SETTLE_SECONDS = 2 // s, slip/support statistics warm-up; penetration/hover still cover ALL ticks.
export const CONTACT_MM = 5 // mm, programme acceptance (not the old 25 mm comparison tolerance).
export const CONE_RAD = .01 // rad, tighter original F1a tolerance, additionally bounded by 5 mm surface travel.
export interface StanceRow {
  completedTicks: number; expectedTicks: number; maxPenetrationMm: number; maxHoverMm: number; slipMm: number
  minPelvisHeightM: number; standingHeightM: number; minUp: number; supportedSamples: number; settledSamples: number
  maxAnchorErrorMm: number; maxLimitSurfaceErrorMm: number; maxConeErrorRad: number; maxEffortRatio: number
  p95TickWallMs: number; p99TickWallMs: number; droppedSeconds: number; invalidFrames: number; error: string | null
}
export interface AnatomyRow { name: string; completedTicks: number; expectedTicks: number; maxConeErrorRad: number; maxLimitSurfaceErrorMm: number;
  maxAnchorErrorMm: number; maxEffortRatio: number; finalTargetErrorRad: number; error: string | null }
export function stancePass(s: StanceRow): boolean {
  return ['completedTicks', 'expectedTicks', 'maxPenetrationMm', 'maxHoverMm', 'slipMm', 'minPelvisHeightM', 'standingHeightM', 'minUp',
    'supportedSamples', 'settledSamples', 'maxAnchorErrorMm', 'maxLimitSurfaceErrorMm', 'maxConeErrorRad', 'maxEffortRatio', 'p95TickWallMs', 'p99TickWallMs',
    'droppedSeconds', 'invalidFrames'].every(k => typeof s[k as keyof StanceRow] === 'number' && Number.isFinite(s[k as keyof StanceRow])) && !s.error && s.completedTicks === 7200 && s.expectedTicks === 7200 &&
    s.maxPenetrationMm <= CONTACT_MM && s.maxHoverMm <= CONTACT_MM && s.maxAnchorErrorMm <= CONTACT_MM &&
    s.maxLimitSurfaceErrorMm <= CONTACT_MM && s.maxConeErrorRad <= CONE_RAD && s.maxEffortRatio <= 1 + 1e-8 &&
    s.p95TickWallMs >= 0 && s.p99TickWallMs >= s.p95TickWallMs && s.maxPenetrationMm >= 0 && s.maxHoverMm >= 0 && s.maxAnchorErrorMm >= 0 &&
    s.maxLimitSurfaceErrorMm >= 0 && s.maxConeErrorRad >= 0 && s.maxEffortRatio >= 0 && s.minPelvisHeightM >= .9 * s.standingHeightM && s.minUp >= .98 && // dimensionless stance, not a recovery/fall classifier.
    s.settledSamples === 6720 && s.supportedSamples === s.settledSamples && s.slipMm >= 0 && s.droppedSeconds === 0 && s.invalidFrames === 0
}
export function anatomyPass(a: { rows: AnatomyRow[] }): boolean {
  return a.rows.length === 97 && new Set(a.rows.map(r => r.name)).size === 97 && a.rows.every(r =>
    ['completedTicks', 'expectedTicks', 'maxConeErrorRad', 'maxLimitSurfaceErrorMm', 'maxAnchorErrorMm', 'maxEffortRatio', 'finalTargetErrorRad'].every(k =>
      typeof r[k as keyof AnatomyRow] === 'number' && Number.isFinite(r[k as keyof AnatomyRow]) && (r[k as keyof AnatomyRow] as number) >= 0) && !r.error && r.completedTicks === r.expectedTicks && r.expectedTicks === 480 &&
    r.maxConeErrorRad <= CONE_RAD && r.maxLimitSurfaceErrorMm <= CONTACT_MM && r.maxAnchorErrorMm <= CONTACT_MM && r.maxEffortRatio <= 1 + 1e-8 && r.finalTargetErrorRad <= .08) // rad: original tracking tolerance; not a cone-overshoot allowance.
}
export const percentile = (values: readonly number[], p: number) => {
  if (!values.length) return NaN
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * p) - 1))]
}
