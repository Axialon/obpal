import { describe, expect, it, vi } from 'vitest'
import { deploymentTarget, guardDeployCheckout, guardDeployment, liveOrigin, parseJsonc, publicationTarget, publicOrigin } from '../scripts/lib/deployment.mjs'
import { exportProblems, selfHostWrangler } from '../scripts/lib/public-export.mjs'
import { checkIndexNowProof, indexNowPayload, submitIndexNow } from '../scripts/lib/indexnow.mjs'
import { bytes, readText } from './devtools-node.mjs'
import { exportFixture, liveWithoutTarget, materializationFixture, publicationFixture } from './public-export-node.mjs'
import { join, mkdtempSync, mkdirSync, rmSync, tmpdir, writeFileSync } from './lanes-node.mjs'

const origin = 'https://controller.example.org'
const accountId = 'a1'.repeat(16)
const config = { name: 'example-controller', workers_dev: false, routes: [{ pattern: 'controller.example.org', custom_domain: true }] }

describe('explicit operation destinations', () => {
  it('refuses linked lane worktrees without changing the coordinator guard or permissions', () => {
    const root = mkdtempSync(join(tmpdir(), 'obpal-deploy-guard-'))
    try {
      expect(() => guardDeployCheckout(root)).not.toThrow()
      writeFileSync(join(root, '.git'), 'gitdir: synthetic-lane')
      expect(() => guardDeployCheckout(root)).toThrow('never a linked lane worktree')
      rmSync(join(root, '.git'), { recursive: false, force: true })
      mkdirSync(join(root, '.git'))
      expect(() => guardDeployCheckout(root)).not.toThrow()
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('refuses the actual live-check command without a target before any request', () => {
    const result = liveWithoutTarget()
    expect(result.status, result.output).toBe(2)
    expect(result.output).toContain('OBPAL_PUBLIC_ORIGIN')
    expect(result.output).not.toContain('UNEXPECTED_REQUEST')
  })
  it('builds on loopback and requires an origin for service checks and deployment', () => {
    expect(publicOrigin()).toBe('http://localhost:5175')
    expect(() => liveOrigin('', {})).toThrow('OBPAL_PUBLIC_ORIGIN')
    expect(() => deploymentTarget({})).toThrow('OBPAL_PUBLIC_ORIGIN')
    expect(() => deploymentTarget({ OBPAL_PUBLIC_ORIGIN: origin })).toThrow('CLOUDFLARE_ACCOUNT_ID')
    expect(deploymentTarget({ OBPAL_PUBLIC_ORIGIN: origin, CLOUDFLARE_ACCOUNT_ID: accountId })).toEqual({ origin, accountId })
    expect(liveOrigin('', { OBPAL_PUBLIC_ORIGIN: origin })).toBe(origin)
    expect(liveOrigin('https://override.example.org', { OBPAL_PUBLIC_ORIGIN: origin })).toBe('https://override.example.org')
    expect(liveOrigin('', { OBPAL_LIVE_ORIGIN: origin })).toBe(origin)
  })

  it.each(['https://person:password' + '@example.org', 'https://example.org/path', 'https://example.org?x=1', 'https://example.org/#fragment', 'http://example.org', 'file:///tmp/example'])('refuses unsafe origin %s', value => {
    expect(() => publicOrigin(value)).toThrow('not an origin')
  })

  it('refuses a different domain, account, extra route or untouched self-host template', () => {
    const target = { origin, accountId }
    expect(() => guardDeployment(config, target)).not.toThrow()
    expect(() => guardDeployment({ ...config, routes: [{ pattern: 'upstream.example.org', custom_domain: true }] }, target)).toThrow('matching OBPAL_PUBLIC_ORIGIN')
    expect(() => guardDeployment({ ...config, routes: [...config.routes, { pattern: '*.example.org/*' }] }, target)).toThrow('exactly one')
    expect(() => guardDeployment({ ...config, account_id: 'b2'.repeat(16) }, target)).toThrow('account differs')
    expect(() => guardDeployment({ ...config, workers_dev: true }, target)).toThrow('workers_dev')
    expect(() => guardDeployment({ ...config, workers_dev: undefined }, target)).toThrow('workers_dev')
    expect(() => deploymentTarget({ OBPAL_PUBLIC_ORIGIN: origin + ':8443', CLOUDFLARE_ACCOUNT_ID: accountId })).toThrow('not an origin')
    expect(() => guardDeployment(parseJsonc(selfHostWrangler(readText('wrangler.jsonc'))), target)).toThrow('Worker name')
  })

  it('requires contributor-owned publication target and public identity', () => {
    expect(() => publicationTarget({})).toThrow('OBPAL_PUBLIC_REPOSITORY')
    expect(() => publicationTarget({ OBPAL_PUBLIC_REPOSITORY: 'example-owner/controller' })).toThrow('AUTHOR')
    expect(publicationTarget({ OBPAL_PUBLIC_REPOSITORY: 'example-owner/controller', OBPAL_SNAPSHOT_AUTHOR_NAME: 'Example contributor',
      OBPAL_SNAPSHOT_AUTHOR_EMAIL: 'contributor@users.noreply.github.com' }).repository).toBe('example-owner/controller')
  })
})

describe('pinned existing public repository publication', () => {
  it.each(['identity', 'parent', 'extra-parent', 'noop-source'])('refuses %s drift before any publication call', mode => {
    const result = publicationFixture(mode)
    if (mode === 'extra-parent') {
      const injected = result.calls.find(call => call.command === 'fixture' && call.args[0] === 'extra-parent')
      expect(injected?.args).toHaveLength(3)
      expect(injected?.args[1]).toBe(result.baseline)
      expect(injected?.args[2]).not.toBe(result.baseline)
    }
    expect(result.status, result.output).toBe(1)
    expect(result.head).toBe(result.baseline)
    expect(result.calls.some(call => call.command === 'git' && call.args.includes('push'))).toBe(false)
    expect(result.calls.some(call => call.command === 'gh' && call.args.includes('create'))).toBe(false)
  })
  it('accepts an unchanged matching public tree without a publication call', () => {
    const result = publicationFixture('noop')
    expect(result.status, result.output).toBe(0)
    expect(result.head).toBe(result.baseline)
    expect(result.output).toContain('already up to date')
    expect(result.calls.some(call => call.command === 'git' && call.args.includes('push'))).toBe(false)
  })
  it.each(['lookup', 'private', 'repository', 'branch', 'pins', 'source-pin', 'baseline', 'tree', 'source', 'clone-race', 'drift'])(
    'stops before push on %s without creating a repository', mode => {
      const result = publicationFixture(mode)
      expect(result.status, result.output).toBe(1)
      expect(result.calls.some(call => call.command === 'gh' && call.args.includes('create'))).toBe(false)
      expect(result.calls.some(call => call.command === 'git' && call.args.includes('push'))).toBe(false)
      if (!['drift', 'clone-race'].includes(mode)) expect(result.head).toBe(result.baseline)
    })

  it('appends one snapshot with the exact approved tree and public identity, then reads it back', () => {
    const result = publicationFixture('success')
    expect(result.status, result.output).toBe(0)
    expect(result.head).not.toBe(result.baseline)
    expect(result.parent).toBe(result.baseline)
    expect(result.publicTree).toBe(result.tree)
    expect(result.identity).toEqual(['Example contributor', 'contributor@users.noreply.github.com',
      'Example contributor', 'contributor@users.noreply.github.com'])
    const pushes = result.calls.filter(call => call.command === 'git' && call.args.includes('push'))
    expect(pushes).toHaveLength(1)
    expect(pushes[0]!.args).toEqual(['push', '--quiet', 'origin', 'main:refs/heads/main'])
    expect(result.calls.some(call => call.command === 'git' && call.args.includes('fetch'))).toBe(true)
  })

  it.each(['push', 'readback'])('stops after one attempt on %s failure', mode => {
    const result = publicationFixture(mode)
    expect(result.status, result.output).toBe(1)
    expect(result.calls.filter(call => call.command === 'git' && call.args.includes('push'))).toHaveLength(1)
    expect(result.calls.some(call => call.command === 'gh' && call.args.includes('create'))).toBe(false)
    expect(result.head === result.baseline).toBe(mode === 'push')
  })
})

describe('safe public export', () => {
  it('parses commented deployment JSON without altering URL strings', () => {
    expect(parseJsonc('{ /* configuration */ "url": "https://example.org/a//b", // a comment\n "rows": [1,], }'))
      .toEqual({ url: 'https://example.org/a//b', rows: [1] })
  })
  it('removes production targets and payment configuration while retaining runtime protections', () => {
    const input = readText('wrangler.jsonc')
    const production = parseJsonc(input)
    const output = selfHostWrangler(input)
    const result = parseJsonc(output)
    expect(result.routes).toEqual([])
    expect(result.workers_dev).toBe(false)
    expect(result.d1_databases).toBeUndefined()
    expect(result.vars).toEqual({ STRIPE_SPONSORSHIP_ENABLED: 'false', GITHUB_SPONSORS_PENDING: 'false' })
    expect(result.secrets.required).toEqual(['TURN_SECRET'])
    expect(result.durable_objects).toEqual(production.durable_objects)
    expect(result.migrations).toEqual(production.migrations)
    expect(result.assets).toEqual(production.assets)
    expect(result.ratelimits.map((limit: { simple: unknown }) => limit.simple)).toEqual(production.ratelimits.map((limit: { simple: unknown }) => limit.simple))
    expect(result.ratelimits.map((limit: { name: string }) => limit.name)).toContain('RL_FILM')
    expect(output).not.toMatch(/blackboxes|billing\.stripe|database_id|STRIPE_SECRET_KEY/)
    expect(selfHostWrangler(output)).toBe(output)
  })

  it('drops future production fields and environments instead of exporting their destinations', () => {
    const input = { ...parseJsonc(readText('wrangler.jsonc')), account_id: accountId, env: { production: config }, services: [{ service: 'owner-ledger' }] }
    const result = parseJsonc(selfHostWrangler(JSON.stringify(input)))
    for (const key of ['account_id', 'env', 'services']) expect(result[key]).toBeUndefined()
  })

  it('runs the actual exporter, omits private state/proof files, and preserves official product links', () => {
    const result = exportFixture({ 'wrangler.jsonc': readText('wrangler.jsonc'), 'README.md': readText('README.md'),
      ['public/' + 'a'.repeat(32) + '.txt']: 'a'.repeat(32), '.claude/local/pending.md': 'Private coordination state' })
    expect(result.status, result.output).toBe(0)
    expect(result.config?.routes).toEqual([])
    expect(result.config?.vars.STRIPE_SPONSORSHIP_ENABLED).toBe('false')
    expect(result.files).not.toContain('.claude/local/pending.md')
    expect(result.files.some(path => /^public\/[a-f0-9]{32}\.txt$/.test(path))).toBe(false)
    expect(result.readme).toContain('https://obpal.blackboxes.net')
    expect(result.readme).toContain('docs/SELF-HOSTING.md')
    expect(result.readme).not.toContain('deploy to obpal.blackboxes.net')
  })

  it.each([
    ['AWS', () => 'AK' + 'IA' + 'A1'.repeat(8)],
    ['GitHub', () => 'github_' + 'pat_' + 'a1'.repeat(32)],
    ['npm', () => 'npm' + '_' + 'b2'.repeat(18)],
    ['Stripe test', () => 'sk_' + 'test_' + 'c3'.repeat(12)],
    ['AI', () => 'sk-' + 'proj-' + 'd4'.repeat(24)],
  ] as const)('refuses synthetic %s credentials through the real exporter without echoing them', (_kind, make) => {
    const token = make()
    const result = exportFixture({ 'notes.md': token })
    expect(result.status).toBe(1)
    expect(result.output).toContain('notes.md:')
    expect(result.output).not.toContain(token)
  })

  it('uses shared check predicates across all matches and scans binary metadata', () => {
    const token = 'c3'.repeat(20)
    const result = exportProblems('notes.md', bytes(`token: 'placeholderplaceholderplaceholder'\ntoken: '${token}'`))
    expect(result).toContain('notes.md: a secret-looking value')
    expect(exportProblems('model.glb', bytes('\0' + 'npm' + '_' + 'b2'.repeat(18)))).toContain('model.glb: an npm token (in binary data)')
    expect(exportProblems('.env.example', bytes('TURN_SECRET=<your-own-random-secret>'))).toEqual([])
    expect(exportProblems('.env', bytes('NOT_A_SECRET=example'))).toEqual(['.env: an env file'])
  })

  it('documents an independent minimal service and required film admission', () => {
    const docs = readText('docs/SELF-HOSTING.md')
    for (const term of ['controller.example.org', '<your-cloudflare-account-id>', 'TURN_SECRET', 'RL_FILM', '503', 'payments', 'OBPAL_PUBLIC_REPOSITORY']) expect(docs).toContain(term)
    expect(readText('spec/SECURITY.md')).toContain('`RL_FILM` is required')
    expect(readText('scripts/deploy.mjs')).not.toContain('indexnow.mjs')
    expect(JSON.parse(readText('package.json')).scripts.deploy).toBe('node scripts/deploy.mjs')
  })
})

describe('one immutable materialized public inventory', () => {
  it('stages copied, generated and metadata outputs from the same verified manifest without restoring omissions', () => {
    const result = materializationFixture('copy')
    expect(result.error).toBeNull()
    expect(result.stagedPaths?.sort()).toEqual([...result.paths!, 'public-export.manifest.json'].sort())
    expect(result.catalog).toMatch(/DEFAULT_ITEM\s*=\s*["']cube["']/)
    expect(result.catalog).not.toContain('boxemCore')
    expect(result.config?.routes).toEqual([])
    expect(result.paths).not.toContain('public/models/cvc/private.glb')
    expect(result.publicPolicy?.payloadRevision).toBeNull()
    expect(result.publicPolicy?.include.every(row => row.source === 'tooling')).toBe(true)
    expect(JSON.stringify(result.publicPolicy)).not.toContain('private.glb')
  })
  it('reproduces projected source from a new public-only Git history without the private payload revision', () => {
    const result = materializationFixture('reexport')
    expect(result.error).toBeNull()
    expect(result.reproduced).toBe(true)
  })
  it('preserves executable Git modes from the payload rather than the different tooling tree through staging and reproduction', () => {
    const result = materializationFixture('modes')
    expect(result.error).toBeNull()
    expect(result.toolingMode).toBe('100644')
    expect(result.stagedGitMode).toBe('100755')
    expect(result.reexportMode).toBe('100755')
    expect(result.reproduced).toBe(true)
  })
  it.each([
    ['input-hash', /input digest/], ['link-mode', /link|mode/], ['source-link', /link/],
    ['extra', /unplanned output/], ['missing', /missing planned output/], ['corrupt', /output bytes/],
    ['manifest', /metadata/], ['source', /source changed/], ['index', /index changed/], ['output-link', /link/],
    ['closure', /unresolved import/], ['asset-closure', /missing asset/],
  ])('rejects %s without a publication call', (mode, message) => {
    expect(materializationFixture(mode).error).toMatch(message)
  })
})

describe('opt-in indexing', () => {
  const key = 'a'.repeat(32)
  const make = (url = origin) => indexNowPayload({ origin, keyFile: `${key}.txt`, key, sitemap: `<urlset><loc>${url}/</loc></urlset>` })
  it('permits a site without indexing and makes no proof request', async () => {
    const fetcher = vi.fn<typeof fetch>()
    expect(await checkIndexNowProof({ origin, fetcher })).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('checks a configured proof only at the selected local worker', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(key))
    expect(await checkIndexNowProof({ origin: 'http://127.0.0.1:5198', keyFile: `${key}.txt`, fetcher })).toBe(true)
    expect(fetcher).toHaveBeenCalledWith(`http://127.0.0.1:5198/${key}.txt`)
    await expect(checkIndexNowProof({ origin, keyFile: '../upstream-proof.txt', fetcher })).rejects.toThrow('own IndexNow key')
    expect(fetcher).toHaveBeenCalledTimes(1)
    fetcher.mockResolvedValue(new Response('wrong proof'))
    await expect(checkIndexNowProof({ origin, keyFile: `${key}.txt`, fetcher })).rejects.toThrow('not served')
  })
  it('does not contact any service during a dry run', async () => {
    const fetcher = vi.fn<typeof fetch>()
    expect(await submitIndexNow(make(), { fetcher })).toEqual({ submitted: false, count: 1 })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('refuses a sitemap from another origin', () => {
    expect(() => make('https://upstream.example.org')).toThrow('Rebuild the sitemap')
  })
  it('checks the selected live key before explicitly submitting', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(key)).mockResolvedValueOnce(new Response(null, { status: 202 }))
    expect(await submitIndexNow(make(), { submit: true, fetcher })).toEqual({ submitted: true, count: 1 })
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([`${origin}/${key}.txt`, 'https://api.indexnow.org/indexnow'])
    const body = JSON.parse(String(fetcher.mock.calls[1][1]?.body))
    expect(body.host).toBe('controller.example.org')
    expect(body.urlList).toEqual([`${origin}/`])
  })
  it('does not submit when ownership proof fails', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('different'))
    await expect(submitIndexNow(make(), { submit: true, fetcher })).rejects.toThrow('selected origin')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
