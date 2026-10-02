/** Ship from clean master in the main checkout. Coordinator only; never called by a lane. */
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { guardShip, runShip } from './lib/ship.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
try {
  guardShip({ root, gitDir: git(['rev-parse', '--path-format=absolute', '--git-dir']), commonDir: git(['rev-parse', '--path-format=absolute', '--git-common-dir']), branch: git(['branch', '--show-current']), status: git(['status', '--porcelain']) })
  const sha = git(['rev-parse', 'HEAD'])
  // check:live prints the store lag warning in this command's output too.
  const result = runShip((command, args) => {
    console.log(`ship: ${command} ${args.join(' ')}`)
    const windowsPnpm = process.platform === 'win32' && command === 'pnpm'
    // Only fixed pnpm arguments enter cmd; paths and user input never enter a shell.
    const run = spawnSync(windowsPnpm ? 'cmd.exe' : command, windowsPnpm ? ['/d', '/s', '/c', `pnpm ${args.join(' ')}`] : args, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true })
    if (run.stdout) process.stdout.write(run.stdout)
    if (run.stderr) process.stderr.write(run.stderr)
    if (run.error || run.status !== 0) throw new Error(run.error?.message || `exit ${run.status}`)
    return run.stdout + run.stderr
  })
  mkdirSync(join(root, '.claude/local'), { recursive: true })
  appendFileSync(join(root, '.claude/local/ships.log'), JSON.stringify({ at: new Date().toISOString(), sha, ...result }) + '\n')
  console.log(`Worker version: ${result.version}\ncheck:live: ${result.check}\nPublished commit: ${result.published}`)
} catch (error) { console.error(`ship: ${error.message}`); process.exitCode = 1 }
