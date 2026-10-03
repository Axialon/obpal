export { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
export { tmpdir } from 'node:os'
export { join } from 'node:path'
export const pid = process.pid

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
const leaseModule = new URL('../scripts/lib/gpu-lease.mjs', import.meta.url).href
const childEnvironment = (file, temp) => ({ ...process.env, OBPAL_E2E_GPU_LEASE_FILE: file, TEMP: temp, TMP: temp, TMPDIR: temp })

export async function childGpuPath(file, temp) {
  const { stdout } = await exec(process.execPath, ['--input-type=module', '--eval', `import { GPU_LEASE_FILE } from ${JSON.stringify(leaseModule)}; console.log(GPU_LEASE_FILE)`], { env: childEnvironment(file, temp), windowsHide: true })
  return stdout.trim()
}

/** A real process holding a fixture lease until the parent writes to stdin. */
export function startGpuChild(file, temp, mode = 'shared') {
  const code = `import { acquireGpuLease } from ${JSON.stringify(leaseModule)};
    const release = await acquireGpuLease({ mode: ${JSON.stringify(mode)}, slots: 3, pollMs: 20, suite: 'child-${mode}' });
    console.log('GPU_CHILD ' + process.pid);
    await new Promise(resolve => process.stdin.once('data', resolve));
    await release(); process.stdin.destroy();`
  const child = spawn(process.execPath, ['--input-type=module', '--eval', code], { env: childEnvironment(file, temp), windowsHide: true })
  let stdout = '', stderr = '', entered = false
  const acquired = new Promise((resolve, reject) => {
    child.stdout.on('data', data => {
      stdout += data
      const match = stdout.match(/GPU_CHILD (\d+)/)
      if (match) { entered = true; resolve(Number(match[1])) }
    })
    child.once('error', reject)
    child.once('close', code => { if (!entered) reject(new Error(`GPU child exited ${code}: ${stderr}`)) })
  })
  acquired.catch(() => {})
  child.stderr.on('data', data => { stderr += data })
  const done = new Promise(resolve => child.once('close', code => resolve({ code, stderr })))
  return { acquired, finish: () => { child.stdin.end('release'); return done }, stop: async () => { child.kill(); await done } }
}
