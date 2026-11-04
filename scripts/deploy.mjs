/** Deploy only to an explicitly selected account and origin. Indexing is a separate, opt-in operation. */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deploymentTarget, guardDeployCheckout, guardDeployment, parseJsonc } from './lib/deployment.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const run = (command, args) => {
  const windowsPnpm = process.platform === 'win32' && command === 'pnpm'
  // Only fixed package-script names enter cmd. No destination value enters a shell.
  const result = spawnSync(windowsPnpm ? 'cmd.exe' : command, windowsPnpm ? ['/d', '/s', '/c', `pnpm ${args.join(' ')}`] : args,
    { cwd: root, stdio: 'inherit', windowsHide: true })
  if (result.error || result.status !== 0) throw new Error(result.error?.message || `${command} exited ${result.status}`)
}
try {
  guardDeployCheckout(root)
  const target = deploymentTarget(process.env)
  guardDeployment(parseJsonc(readFileSync(resolve(root, 'wrangler.jsonc'), 'utf8')), target)
  run('pnpm', ['run', 'test'])
  run('pnpm', ['run', 'build'])
  const redirect = resolve(root, '.wrangler/deploy/config.json')
  const config = resolve(dirname(redirect), JSON.parse(readFileSync(redirect, 'utf8')).configPath)
  guardDeployment(JSON.parse(readFileSync(config, 'utf8')), target)
  // Keep the wrapper's command fixed; the checked build config carries the selected domain.
  execFileSync(process.execPath, ['scripts/keep-assets.mjs', 'wrangler', 'deploy'], { cwd: root, stdio: 'inherit', windowsHide: true })
} catch (error) { console.error(`deploy: ${error.message}`); process.exitCode = 1 }
