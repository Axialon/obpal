/**
 * This checkout's worker, run locally for end-to-end tests: `wrangler dev` on the last build (dist/, through the
 * redirected config `vite build` writes), with its Durable Objects kept in a throwaway folder so every run starts
 * clean. It serves the site and the room service, short codes included, which production may not have yet, and it has
 * none of production's per-address limits, which every run on one machine shares. The e2e stand-in
 * (extension/e2e/local.mjs) proxies to one of these by default.
 * Never deploys anything.
 */
import { spawn, spawnSync } from 'node:child_process'
import { tempScope } from './lib/temp.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function answers(origin) {
  try { return (await (await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1500) })).json()).service === 'obpal' } catch { return false }
}

/**
 * Start the worker on `port` (refusing a port something already answers on); `close()` stops it and its children.
 * A script that exits without close() (process.exit on its way out, an uncaught error) still stops it, so no worker
 * outlives its run holding the port.
 */
export async function startWorker({ port = 5179 } = {}) {
  const origin = `http://127.0.0.1:${port}`
  if (await answers(origin)) throw new Error(`something already answers on port ${port}; stop it, or pick another port`)
  const temps = tempScope({ fallback: false }) // the worker must stop before its state is removed
  const state = await temps.make(join(tmpdir(), 'obpal-worker-'))
  let output = ''
  const child = spawn('npx', ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', state, '--var', 'TURN_SECRET:local-e2e-address-key', '--show-interactive-dev-session=false'], {
    cwd: root, shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  const capture = chunk => { output = (output + chunk).slice(-16_384) }
  child.stdout.on('data', capture); child.stderr.on('data', capture)
  let launchError
  child.on('error', error => { launchError = error })
  // On exit only synchronous work runs: kill the tree and drop the state folder this run made.
  const onExit = () => {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    else child.kill('SIGTERM')
    temps.cleanupSync()
  }
  process.once('exit', onExit)
  let closing
  const close = () => closing ??= (async () => {
    process.off('exit', onExit)
    if (process.platform === 'win32') await new Promise((r) => spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }).on('exit', r))
    else child.kill('SIGTERM')
    for (let i = 0; i < 20 && (await answers(origin)); i++) await sleep(250)
    await temps.cleanup()
  })()
  let started = false
  try {
    const end = Date.now() + 90_000
    while (!(await answers(origin))) {
      if (launchError || child.exitCode !== null || Date.now() > end) throw new Error(`the local worker did not start${output ? `:\n${output.trim()}` : ''}`)
      await sleep(500)
    }
    started = true
    return { origin, close }
  } finally { if (!started) await close() }
}
