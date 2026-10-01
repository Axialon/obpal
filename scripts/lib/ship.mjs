/** Release preconditions and ordered steps, testable without a deployment. */
import { resolve } from 'node:path'
import { stripAnsi } from './report.mjs'

export function guardShip({ root, gitDir, commonDir, branch, status }) {
  const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase()
  if (!same(gitDir, commonDir) || !same(resolve(root, '.git'), commonDir)) throw new Error('ship requires the main checkout')
  if (branch !== 'master') throw new Error('ship requires master')
  if (status.trim()) throw new Error('ship requires a clean tree, including untracked files')
}

export function workerVersion(output) {
  const match = /(?:Current Version ID|Version ID):\s*([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})/i.exec(stripAnsi(output))
  if (!match) throw new Error('Worker version was not found in deploy output; inspect the deployment before retrying')
  return match[1]
}

export function runShip(run) {
  const step = (name, command, args) => {
    try { return run(command, args) } catch (error) { throw new Error(`${name} failed: ${error.message}`) }
  }
  const deployed = step('deploy', 'pnpm', ['run', 'deploy'])
  let version
  try { version = workerVersion(deployed) } catch (error) { throw new Error(`deploy evidence failed: ${error.message}`) }
  const live = step('check:live', 'pnpm', ['run', 'check:live'])
  const check = stripAnsi(live).split(/\r?\n/).findLast(line => /^all passed(?:,| \()/.test(line.trim()))?.trim()
  if (!check) throw new Error('check:live evidence failed: no passing summary')
  step('open-source publish', 'node', ['scripts/open-source.mjs', '--publish'])
  const remote = step('published commit lookup', 'git', ['ls-remote', 'https://github.com/Axialon/obpal.git', 'refs/heads/main'])
  const published = /^([a-f0-9]{40})\s+refs\/heads\/main\s*$/i.exec(stripAnsi(remote).trim())?.[1]
  if (!published) throw new Error('published commit lookup failed: no main ref')
  step('backup', 'node', ['scripts/backup.mjs', '--label', 'ship'])
  return { version, check, published }
}
