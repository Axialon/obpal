import { expect, it } from 'vitest'
import { runIndependentGroups } from '../scripts/lib/e2e-groups.mjs'

it('retains completed gates and setup failures, waits for cleanup and continues independent groups', async () => {
  const events: string[] = []
  const rows: { name: string; error?: unknown }[] = []
  const setupError = new Error('navigation failed')
  const gateError = new Error('measured gate failed')
  const check = async (name: string, run: () => Promise<unknown>) => {
    try { await run(); rows.push({ name }) }
    catch (error) { rows.push({ name, error }) }
  }
  await runIndependentGroups([
    { name: 'camera', run: async () => {
      try {
        await check('camera gate already completed', async () => {})
        throw setupError
      } finally { await Promise.resolve(); events.push('camera cleanup') }
    } },
    { name: 'recovery', run: async () => {
      events.push('recovery setup')
      await check('recovery measured gate', async () => { throw gateError })
    } },
    { name: 'controllers', run: async () => {
      events.push('controllers setup')
      await check('controllers measured gate', async () => {})
    } },
  ], check)
  expect(events).toEqual(['camera cleanup', 'recovery setup', 'controllers setup'])
  expect(rows).toEqual([
    { name: 'camera gate already completed' },
    { name: 'camera group aborted; remaining checks in this group were not run', error: setupError },
    { name: 'recovery measured gate', error: gateError },
    { name: 'controllers measured gate' },
  ])
})
