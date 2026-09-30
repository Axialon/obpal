/** Detached round supervisor. Files, rather than a parent shell, own stdin/stdout. */
import { spawn } from 'node:child_process'
import { openSync, closeSync, readFileSync, writeFileSync } from 'node:fs'
import { parseEvents, withLedger } from './lib.mjs'

const job = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const handles = [job.prompt, job.events, job.err].map((path, i) => openSync(path, i ? 'a' : 'r'))
const finish = result => writeFileSync(job.exit, JSON.stringify({ ...result, at: new Date().toISOString() }) + '\n')
let threadSaved = false
async function saveThread() {
  if (threadSaved) return
  const { threadId } = parseEvents(readFileSync(job.events, 'utf8'))
  if (!threadId) return
  await withLedger(job.ledgerFile, ledger => {
    const lane = ledger.lanes.find(l => l.name === job.name)
    if (lane) lane.threadId = threadId
  })
  threadSaved = true
}
const timer = setInterval(() => { saveThread().catch(() => {}) }, 1000)
const child = spawn(job.executable, job.args, { cwd: job.worktree, stdio: handles, windowsHide: true })
handles.forEach(closeSync)
child.on('error', error => { clearInterval(timer); finish({ error: error.message, code: 1 }); process.exitCode = 1 })
child.on('exit', async (code, signal) => {
  clearInterval(timer)
  finish({ code, signal })
  await saveThread().catch(() => {})
  process.exitCode = code || (signal ? 1 : 0)
})
