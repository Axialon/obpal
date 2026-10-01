/** One source of fixture floors, used both while measuring and when selecting from the returned table. */
import type { FixtureName } from './fixtures'
export function fixtureFailures(name: FixtureName, metrics: Record<string, number | null>): string[] {
  const errors: string[] = [], required = ['simulatedSeconds', 'penetrationM', 'constraintErrorM', 'peakConeErrorRad', 'finalConeErrorRad',
    'finalSpeedMps', 'finalAngularSpeedRadps', 'finalRelativeAngularSpeedRadps', 'finalY']
  const extra: Record<FixtureName, string[]> = {
    drop: [], 'motor-chain': ['targetErrorRad', 'motorSettlingSeconds', 'peakMotorTorqueNm'],
    'saturated-cone': ['targetErrorRad', 'peakMotorTorqueNm'], wheels: ['rollingLoadN', 'rollingDistanceM'],
    buoyancy: ['floatingTrimM', 'displacedVolumeM3'], energy: ['energyDriftRelative'], damping: ['energyRiseJ', 'dampingRatio', 'dampingExpectedRatio'],
  }
  for (const key of [...required, ...(extra[name] ?? [])]) if (typeof metrics[key] !== 'number' || !Number.isFinite(metrics[key])) errors.push(`missing/non-finite metric: ${key}`)
  if (errors.length) return errors
  const m = (key: string) => metrics[key] as number
  const need = (ok: boolean, reason: string) => { if (!ok) errors.push(reason) }
  need(m('simulatedSeconds') > 0, 'simulation duration is not positive')
  need(m('penetrationM') >= 0 && m('penetrationM') <= .025, 'penetration exceeds 25 mm or is invalid')
  need(m('constraintErrorM') >= 0 && m('constraintErrorM') <= .025, 'anchor error exceeds 25 mm or is invalid')
  need(m('peakConeErrorRad') >= 0 && m('peakConeErrorRad') <= .03 && m('finalConeErrorRad') <= .03, 'cone error exceeds 0.03 rad or is invalid')
  if (name === 'drop') { need(Math.abs(m('finalY') - .25) < .02, 'body did not settle on ground'); need(m('finalSpeedMps') < .1, 'rest velocity exceeds 0.1 m/s') }
  if (name === 'motor-chain') need(m('motorSettlingSeconds') >= 0 && m('motorSettlingSeconds') < m('simulatedSeconds'), 'motor chain did not settle')
  if (name === 'saturated-cone') { need(m('peakMotorTorqueNm') <= 2.500001, 'motor torque budget exceeded'); need(m('finalRelativeAngularSpeedRadps') < .2, 'saturated motor has not settled') }
  if (name === 'wheels') { need(m('rollingDistanceM') > 1, 'wheels did not move'); need(Math.abs(m('rollingLoadN') / 98.1 - 1) < .2, 'suspension did not bear its load'); need(m('finalY') > .35 && m('finalY') < .9, 'suspension height out of bounds') }
  if (name === 'buoyancy') { need(Math.abs(m('floatingTrimM')) < .08, 'floating trim out of bounds'); need(m('finalSpeedMps') < .1, 'hull did not settle'); need(Math.abs(m('displacedVolumeM3') - .003) < .0004, 'displacement does not support mass') }
  if (name === 'energy') need(m('energyDriftRelative') >= 0 && m('energyDriftRelative') < .25, 'undamped energy drift exceeds 25% (comparison floor, not model fidelity)')
  if (name === 'damping') { need(m('energyRiseJ') < 1e-8, 'damping adds energy'); need(Math.abs(m('dampingRatio') - m('dampingExpectedRatio')) < .002, 'damping differs from analytic envelope') }
  return errors
}
