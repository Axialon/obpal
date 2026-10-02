/** Own only folders this scope creates. A synchronous exit fallback covers explicit process.exit calls. */
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'

export const keepTemp = () => process.env.OBPAL_KEEP_TEMP === '1' || process.argv.includes('--keep-logs')
export function tempScope({ keep = false, fallback = true } = {}) {
  const paths = new Set()
  const onExit = () => {
    if (keep || keepTemp()) return
    for (const path of paths) {
      try { rmSync(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) }
      catch { console.error('Temp cleanup: held files remain for the age-based reaper') }
    }
  }
  if (fallback) process.once('exit', onExit)
  return {
    retain() { keep = true },
    async make(prefix) { const path = await mkdtemp(prefix); paths.add(path); return path },
    makeSync(prefix) { const path = mkdtempSync(prefix); paths.add(path); return path },
    async cleanup() {
      try {
        if (keep || keepTemp()) return
        for (const path of paths) await rm(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
        paths.clear()
      } finally { if (!paths.size || keep || keepTemp()) process.off('exit', onExit) }
    },
    cleanupSync() { try { onExit(); paths.clear() } finally { process.off('exit', onExit) } },
  }
}
