import { gpuStatus } from './lib/gpu-lease.mjs'
import { formatTable } from './lib/report.mjs'
const status = await gpuStatus()
console.log(`GPU: ${status.slots} shared slots; ${status.holders.length} holders, ${status.queue.length} queued`)
console.log(formatTable(['state', 'lane / pid', 'mode', 'suite', 'since'], [
  ...status.holders.map(r => [r.file, r.lane || String(r.pid), r.mode, r.suite, r.startedAt]),
  ...status.queue.map(r => [`queue ${r.order}`, r.lane || String(r.pid), r.mode, r.suite, r.startedAt]),
  ...(status.coordinator ? [['coordinator / legacy', String(status.coordinator.pid), status.coordinator.mode || 'exclusive', status.coordinator.suite || '', status.coordinator.startedAt]] : []),
]))
