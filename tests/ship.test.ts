import { describe, expect, it } from 'vitest'
import { join, tmpdir } from './lanes-node.mjs'
import { guardShip, runShip } from '../scripts/lib/ship.mjs'

const version = ['12345678', '1234', '1234', '1234', '123456789012'].join('-')
const publicSha = 'a'.repeat(40)
const outputs = [`Current Version ID: ${version}`, 'all passed (20 checks, 90 s)', 'Published', `${publicSha}\trefs/heads/main\n`]

describe('ship guard and ordered failures', () => {
  it('requires a clean main checkout on master', () => {
    const root = join(tmpdir(), 'synthetic-main'), gitDir = join(root, '.git')
    const input = { root, gitDir, commonDir: gitDir, branch: 'master', status: '' }
    expect(() => guardShip(input)).not.toThrow()
    expect(() => guardShip({ ...input, gitDir: join(gitDir, 'worktrees/lane') })).toThrow('main checkout')
    expect(() => guardShip({ ...input, branch: 'codex/alpha' })).toThrow('master')
    expect(() => guardShip({ ...input, status: '?? untracked.txt' })).toThrow('clean tree')
  })
  it('reports version, live summary and the published main commit', () => {
    const calls: string[] = []
    expect(runShip((command, args) => { calls.push([command, ...args].join(' ')); return outputs[calls.length - 1] })).toEqual({ version, check: outputs[1], published: publicSha })
    expect(calls).toEqual(['pnpm run deploy', 'pnpm run check:live', 'node scripts/open-source.mjs --publish', 'git ls-remote https://github.com/Axialon/obpal.git refs/heads/main'])
  })
  it('parses deployment and check evidence when tools emit terminal colors', () => {
    let calls = 0
    expect(runShip(() => `\u001b[32m${outputs[calls++]}\u001b[0m`).version).toBe(version)
  })
  it.each(['deploy', 'check:live', 'open-source publish', 'published commit lookup'])('stops at the first %s failure', step => {
    const index = ['deploy', 'check:live', 'open-source publish', 'published commit lookup'].indexOf(step)
    let calls = 0
    expect(() => runShip(() => { const at = calls++; if (at === index) throw new Error('synthetic'); return outputs[at] })).toThrow(`${step} failed`)
    expect(calls).toBe(index + 1)
  })
  it('refuses missing evidence instead of reporting a successful release', () => {
    expect(() => runShip(() => 'missing')).toThrow('deploy evidence')
    let calls = 0
    expect(() => runShip(() => calls++ ? 'missing' : outputs[0])).toThrow('check:live evidence')
    calls = 0
    expect(() => runShip(() => calls++ < 3 ? outputs[calls - 1] : 'missing')).toThrow('no main ref')
  })
})
