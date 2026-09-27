/**
 * This checkout's worker, run locally for end-to-end tests: `wrangler dev` on the last build (dist/, through the
 * redirected config `vite build` writes), with its Durable Objects kept in a throwaway folder so every run starts
 * clean. It serves the site and the room service, short codes included, which production may not have yet.
 * Never deploys anything.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function answers(origin) {
  try { return (await (await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1500) })).json()).service === 'obpal' } catch { return false }
}

/** Start the worker on `port` (refusing a port something already answers on); `close()` stops it and its children. */
export async function startWorker({ port = 5179 } = {}) {
  const origin = `http://127.0.0.1:${port}`
  if (await answers(origin)) throw new Error(`something already answers on port ${port}; stop it, or pick another port`)
  const state = await mkdtemp(join(tmpdir(), 'obpal-worker-'))
  const child = spawn('npx', ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', state, '--show-interactive-dev-session=false'], {
    cwd: root, shell: true, stdio: 'ignore', windowsHide: true,
  })
  const close = async () => {
    if (process.platform === 'win32') await new Promise((r) => spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }).on('exit', r))
    else child.kill('SIGTERM')
    for (let i = 0; i < 20 && (await answers(origin)); i++) await sleep(250)
    await rm(state, { recursive: true, force: true }).catch(() => {})
  }
  const end = Date.now() + 90_000
  while (!(await answers(origin))) {
    if (child.exitCode !== null || Date.now() > end) { await close(); throw new Error('the local worker did not start') }
    await sleep(500)
  }
  return { origin, close }
}
