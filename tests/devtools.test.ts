import { describe, expect, it } from 'vitest'
import { newestInstalled, shortPath } from '../scripts/lib/browser.mjs'
import { countSessionLines, failures, knownSuites, listeningPids, newSessionLines, parseArgs, parseResult, suitePorts } from '../scripts/lib/e2e.mjs'
import { latestRelease, LINK_STORE, LINK_ZIP, linkInstallChecks, linkVersionLabel, pageHeaderChecks, RELEASE_ASSETS, releaseChecks, securityTxtCheck, shownCode, turnChecks } from '../scripts/lib/live.mjs'
import { applyAllow, DEFAULT_CO_AUTHOR, parseArgs as mergeArgs, parseVitest, pickCoAuthor, summarizeNumstat } from '../scripts/lib/merge.mjs'
import { formatDuration, formatTable } from '../scripts/lib/report.mjs'
import { addedLines, isLocalOnly, mask, PRIVATE_RULES, riskyPath, scanText, SECRET_RULES } from '../scripts/lib/scan.mjs'
import { bytes, makeBrowserStore, readText } from './devtools-node.mjs'

/** Samples are put together at run time, so this file never holds one whole and passes its own scan. */
const k = (...parts: string[]) => parts.join('')
const rules = (text: string, deny: string[] = []) => scanText(text, { deny }).map((f) => f.rule)

describe('scan: what must never be committed or published', () => {
  it('finds keys and tokens', () => {
    expect(rules(k('-----BEGIN ', 'RSA PRIVATE KEY-----'))).toEqual(['private-key'])
    expect(rules(k('-----BEGIN ', 'OPENSSH PRIVATE KEY-----'))).toEqual(['private-key'])
    expect(rules(k('key: AKIA', 'IOSFODNN7EXAMPLE'))).toEqual(['aws-key'])
    expect(rules(k('gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0a1B2c3D4e5F6g7H8'))).toEqual(['github-token'])
    expect(rules(k('s', 'k_live_', '4eC39HqLyjWDarjtT1zdp7dc'))).toEqual(['stripe-key'])
    expect(rules(k('wh', 'sec_', 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLISw'))).toEqual(['stripe-key'])
    expect(rules(k('xox', 'b-', '1234567890-abcdefghij'))).toEqual(['slack-token'])
    expect(rules(k('AI', 'za', 'SyA1234567890abcdefghijklmnopqrstuv'))).toEqual(['google-key'])
    expect(rules(k('sk', '-ant-', 'api03-', 'x'.repeat(40)))).toEqual(['ai-key'])
    expect(rules(k('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'abcDEF123456ghiJKL'))).toEqual(['jwt'])
    expect(rules(k('https://deploy', ':', 'hunter2hunter2', '@example.com/repo'))).toEqual(['url-credentials'])
  })

  it('finds Cloudflare account, zone and resource ids', () => {
    const hex = '0123456789abcdef0123456789abcdef'
    expect(rules(k('account', '_id = "', hex, '"'))).toEqual(['cf-account'])
    expect(rules(k('CLOUDFLARE_ACCOUNT', '_ID=', hex))).toEqual(['cf-account'])
    expect(rules(k('https://api.cloudflare.com/client/v4/', 'accounts/', hex, '/workers'))).toEqual(['cf-account'])
    expect(rules(k('"id"', ': "', hex, '"'))).toEqual(['cf-resource'])
    expect(rules(k('"database', '_id": "', '12345678-1234-1234-1234-123456789abc', '"'))).toEqual(['cf-resource'])
  })

  it('finds generated secrets by their name, and leaves ordinary code alone', () => {
    expect(rules(k('TURN_KEY_API_', 'TOKEN=', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'))).toEqual(['secret-env'])
    expect(rules(k('const api', 'Key = ', "'", 'Zx8qP2vL9mN4bR7tK1wS5yH3', "'"))).toEqual(['secret-value'])
    expect(rules('const token = crypto.randomUUID()')).toEqual([])
    expect(rules("const secret = 'correct horse battery staple'")).toEqual([])
    expect(rules('TOKEN=${TURN_KEY_API_TOKEN}')).toEqual([])
    expect(rules('password: <your password here>')).toEqual([])
    expect(rules('const ROOM = /^\\/r\\/([A-Za-z0-9_-]{22})$/')).toEqual([])
    expect(rules("git clone https://github.com/Axialon/obpal.git")).toEqual([])
  })

  it('finds what the open-source export refuses: local paths, personal addresses, private words', () => {
    expect(rules(k('C:', '\\', 'Users', '\\', 'someone\\x'))).toEqual(['windows-path'])
    expect(rules(k('/', 'home', '/someone/', 'x'))).toEqual(['home-path'])
    expect(rules(k('someone', '@', 'gmail.com'))).toEqual(['personal-email'])
    expect(rules('made up: /Users/art/Documents')).toEqual([])
    expect(rules('noreply@anthropic.com and hello@obpal.blackboxes.net')).toEqual([])
    const denied = scanText('a Zanzibar mention', { deny: ['zanzibar'] })
    expect(denied).toEqual([{ rule: 'deny-word', what: 'a private word from .open-source-deny', hint: '' }])
  })

  it('never carries the matched text, only a hint', () => {
    const token = k('gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0a1B2c3D4e5F6g7H8')
    const [f] = scanText(`x ${token}`)
    expect(f.hint).toBe(`ghp_… (${token.length} chars)`)
    expect(mask('abc')).toBe('*** (3 chars)')
  })

  it('reads the added lines of a diff, with their new line numbers', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1..2 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -3 +3,2 @@ context',
      '-old',
      '+new one\r',
      '+++ a line that starts with two pluses',
      '@@ -10,0 +11 @@',
      '+eleven',
      '\\ No newline at end of file',
      'diff --git a/gone.txt b/gone.txt',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      'diff --git a/img.png b/img.png',
      'Binary files /dev/null and b/img.png differ',
    ].join('\n')
    const { lines, binary } = addedLines(diff)
    expect(lines).toEqual([
      { path: 'src/a.ts', line: 3, text: 'new one' },
      { path: 'src/a.ts', line: 4, text: '++ a line that starts with two pluses' },
      { path: 'src/a.ts', line: 11, text: 'eleven' },
    ])
    expect(binary).toEqual(['img.png'])
  })

  it('knows the local-only files and the risky file names', () => {
    for (const p of ['.claude/settings.local.json', '.claude/local/notes.md', '.claude/skills/local-release/SKILL.md', '.claude/agents/local-x.md', 'CLAUDE.local.md', '.open-source-deny']) {
      expect(isLocalOnly(p), p).toBe(true)
    }
    for (const p of ['.claude/settings.json', '.claude/skills/merge-lane/SKILL.md', '.claude/agents/obpal-lane.md', 'CLAUDE.md']) expect(isLocalOnly(p), p).toBe(false)
    expect(riskyPath('extension/e2e/tls/key.pem')).toBe('a key or certificate file')
    expect(riskyPath('keys/id_ed25519')).toBe('an SSH private key')
    expect(riskyPath('.dev.vars')).toBe('an env file')
    expect(riskyPath('worker/.env.production')).toBe('an env file')
    expect(riskyPath('.env.example')).toBeNull()
    expect(riskyPath('.npmrc')).toBe('a credentials file')
    expect(riskyPath('.claude/settings.local.json')).toBe('a local-only file')
    expect(riskyPath('src/main.ts')).toBeNull()
  })

  it('passes its own scan: the dev tools, their docs and these tests hold nothing it refuses', () => {
    const files = [
      'scripts/lib/scan.mjs', 'scripts/lib/e2e.mjs', 'scripts/lib/live.mjs', 'scripts/lib/merge.mjs', 'scripts/lib/report.mjs',
      'scripts/lib/browser.mjs', 'scripts/e2e-all.mjs', 'scripts/check-live.mjs', 'scripts/merge-lane.mjs', 'scripts/open-source.mjs',
      '.claude/hooks/guard.mjs', '.claude/settings.json', '.claude/agents/obpal-lane.md', '.claude/README.md',
      '.claude/skills/spawn-lane/SKILL.md', '.claude/skills/merge-lane/SKILL.md', '.claude/skills/deploy-and-verify/SKILL.md',
      '.claude/skills/release/SKILL.md', '.claude/skills/release/reference.md', '.claude/skills/spawn-lane/prompt-template.md',
      '.claude/skills/spawn-lane/brief-template.md', 'tests/devtools.test.ts', 'tests/guard.test.ts', 'tests/devtools-node.mjs',
      'extension/e2e/local.mjs', 'scripts/local-worker.mjs',
    ]
    const found = files.flatMap((f) => readText(f).split(/\r?\n/)
      .flatMap((line, i) => scanText(line, { rules: [...SECRET_RULES, ...PRIVATE_RULES] }).map((x) => `${f}:${i + 1} ${x.rule}`)))
    expect(found).toEqual([])
  })
})

describe('e2e runner: suites, ports, results, the ob.Pal Desktop guard', () => {
  const scripts = { 'e2e:phone': '', 'e2e:code': '', 'e2e:all': '', 'e2e:zeta': '', 'e2e:extension': '', 'e2e:embed': '', dev: '' }
  const known = knownSuites(scripts)

  it('finds the suites in package.json, in run order, new ones last', () => {
    expect(known).toEqual(['code', 'embed', 'phone', 'extension', 'zeta'])
  })

  it('reads suites bare, comma-separated or after --suites, and options', () => {
    expect(parseArgs([], known).suites).toEqual(known)
    expect(parseArgs(['--', 'all'], known).suites).toEqual(known)
    expect(parseArgs(['phone', 'code,phone'], known).suites).toEqual(['phone', 'code'])
    expect(parseArgs(['--suites', 'e2e:embed,phone'], known).suites).toEqual(['embed', 'phone'])
    const o = parseArgs(['--suites=zeta', '--out', 'logs', '--wait-min=2', '--timeout-min', '5'], known)
    expect(o).toEqual({ suites: ['zeta'], out: 'logs', waitMin: 2, timeoutMin: 5, help: false })
    expect(() => parseArgs(['phnoe'], known)).toThrow('unknown suite phnoe (known: code embed phone extension zeta)')
    expect(() => parseArgs(['--fast'], known)).toThrow('unknown option --fast')
    expect(() => parseArgs(['--wait-min', '0'], known)).toThrow('positive number')
  })

  it('runs the phone modules (connections, camera, controllers, recovery) inside the phone suite, which a full run includes', () => {
    const suite = readText('scripts/e2e-phone.mjs')
    for (const run of ['phoneConnections', 'phoneCamera', 'phoneControllers', 'phoneRecovery']) {
      expect(suite, `${run} is imported`).toMatch(new RegExp(`^import \\{ ${run} \\} from './phone-[a-z]+\\.mjs'`, 'm'))
      expect(suite, `${run} is run`).toMatch(new RegExp(`^\\s*await ${run}\\(`, 'm'))
    }
    expect(knownSuites(JSON.parse(readText('package.json')).scripts)).toContain('phone')
  })

  it('knows which ports each suite binds: its stand-in and its own worker, unless production is asked for', () => {
    expect(suitePorts('phone', {})).toEqual({ port: 5176, worker: 5189 })
    expect(suitePorts('phone', { OBPAL_E2E_UPSTREAM: 'https://obpal.blackboxes.net' })).toEqual({ port: 5176, worker: null })
    expect(suitePorts('code', {})).toEqual({ port: null, worker: 5189 })
    expect(suitePorts('embed', { OBPAL_E2E_PORT: '5186', OBPAL_E2E_WORKER_PORT: '5197', OBPAL_E2E_UPSTREAM: 'x' })).toEqual({ port: 5186, worker: 5197 })
  })

  it('finds what listens on a port in netstat', () => {
    const netstat = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    127.0.0.1:5197         0.0.0.0:0              LISTENING       4242',
      '  TCP    127.0.0.1:5197         127.0.0.1:61000        ESTABLISHED     4242',
      '  TCP    127.0.0.1:51970        0.0.0.0:0              LISTENING       7',
      '  TCP    [::]:5197              [::]:0                 LISTENING       4243',
    ].join('\r\n')
    expect(listeningPids(netstat, 5197)).toEqual([4242, 4243])
    expect(listeningPids(netstat, 5186)).toEqual([])
  })

  it('reads every suite summary form, the last one counting', () => {
    expect(parseResult('  ✓ one\npassed 6/6\n')).toEqual({ passed: 6, total: 6, failed: 0 })
    expect(parseResult('FAILED 2/10')).toEqual({ passed: 8, total: 10, failed: 2 })
    expect(parseResult('11/11 passed')).toEqual({ passed: 11, total: 11, failed: 0 })
    expect(parseResult('\nall 19 passed')).toEqual({ passed: 19, total: 19, failed: 0 })
    expect(parseResult('\n3 of 19 failed')).toEqual({ passed: 16, total: 19, failed: 3 })
    expect(parseResult('  ✓ a check that passed 2/2 steps\n\x1b[31mFAILED 1/4\x1b[0m')).toEqual({ passed: 3, total: 4, failed: 1 })
    expect(parseResult('Error: the build failed')).toBeNull()
    expect(failures('  ✓ fine\n  ✗ locks rotation: timed out\n  ✗ second\n', 1)).toEqual(['✗ locks rotation: timed out'])
  })

  it('finds new ob.Pal Desktop sessions of a test browser, and a log that started afresh', () => {
    const old = '1 [1] serving chrome-extension://abc/ browser: C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\n'
    const leak = '2 [2] serving x browser: D:\\me\\AppData\\Local\\ms-playwright\\chromium-1237\\chrome-win64\\chrome.exe\n'
    const buf = bytes(old + leak)
    expect(newSessionLines(buf, bytes(old).length)).toEqual([leak.trim()])
    expect(newSessionLines(buf, buf.length)).toEqual([])
    expect(newSessionLines(bytes(leak), buf.length)).toHaveLength(1)
    const custom = bytes('3 browser: D:\\browsers\\chromium\\chrome.exe\n')
    expect(newSessionLines(custom, 0, ['D:/browsers/chromium/chrome.exe'])).toHaveLength(1)
    expect(countSessionLines(buf)).toBe(1)
  })
})

describe('report: one table and readable durations', () => {
  it('aligns columns without counting colour codes, and keeps cells on one line', () => {
    expect(formatTable(['suite', 'result'], [['phone', '\x1b[32mpass\x1b[0m'], ['extension', 'FAIL\nsee log']]))
      .toBe('suite      result\n---------  ------------\nphone      pass\nextension  FAIL see log')
  })

  it('reads durations by size', () => {
    expect([formatDuration(850), formatDuration(17_400), formatDuration(214_000)]).toEqual(['850 ms', '17 s', '3.6 min'])
  })
})

describe('merge-lane: arguments, stats, vitest, trailer, accepted findings', () => {
  it('reads the arguments', () => {
    expect(mergeArgs(['lane-x', '-m', 'Merge x', '--dry-run', '--allow', 'tests/a.ts:3'])).toEqual({ branch: 'lane-x', message: 'Merge x', dryRun: true, allow: ['tests/a.ts:3'], help: false })
    expect(() => mergeArgs([])).toThrow('which branch?')
    expect(() => mergeArgs(['a', 'b'])).toThrow('one branch at a time')
    expect(() => mergeArgs(['a', '--push'])).toThrow('unknown option --push')
  })

  it('sums a numstat and ranks the biggest changes', () => {
    const s = summarizeNumstat('10\t2\tsrc/a.ts\n-\t-\tpublic/x.png\n1\t0\tREADME.md\n', 2)
    expect(s).toMatchObject({ files: 3, added: 11, deleted: 2 })
    expect(s.biggest.map((f) => f.path)).toEqual(['src/a.ts', 'README.md'])
  })

  it('reads the vitest summary', () => {
    expect(parseVitest(' Test Files  48 passed (48)\n      Tests  507 passed (507)\n')).toEqual({ passed: 507, failed: 0, skipped: 0, total: 507, files: 48 })
    expect(parseVitest('\x1b[2m Test Files \x1b[22m 1 failed | 47 passed (48)\n      Tests  2 failed | 504 passed | 1 skipped (507)'))
      .toEqual({ passed: 504, failed: 2, skipped: 1, total: 507, files: 48 })
    expect(parseVitest('Error: Cannot find module')).toBeNull()
  })

  it('carries the lane\'s own co-author trailer', () => {
    expect(pickCoAuthor(['abc\0Fix\n\nCo-Authored-By: Claude Opus 9 <noreply@anthropic.com>\n'])).toBe('Claude Opus 9 <noreply@anthropic.com>')
    expect(pickCoAuthor(['abc\0No trailer'])).toBe(DEFAULT_CO_AUTHOR)
  })

  it('accepts only the findings named with --allow', () => {
    const f = [{ path: 'tests/a.ts', line: 3 }, { path: 'tests/a.ts', line: 9 }, { path: 'src/b.ts', line: 1 }, { path: 'x.pem' }]
    expect(applyAllow(f, ['tests/a.ts:3', 'x.pem'])).toEqual({ standing: [f[1], f[2]], allowed: [f[0], f[3]] })
    expect(applyAllow(f, ['tests/a.ts']).standing).toEqual([f[2], f[3]])
  })
})

describe('check:live: headers, security.txt, the pairing code, TURN', () => {
  const live: Record<string, string> = {
    'strict-transport-security': 'max-age=31536000',
    'content-security-policy': "frame-ancestors 'self'; object-src 'none'; base-uri 'self'",
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'accelerometer=(self), gyroscope=(self), microphone=(), geolocation=()',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'SAMEORIGIN',
  }

  it('passes the site\'s headers and fails missing ones', () => {
    expect(pageHeaderChecks((n) => live[n]).map((r) => r.status)).toEqual(Array(7).fill('pass'))
    expect(pageHeaderChecks((n) => live[n])[0].detail).toBe('max-age 365 days')
    const bare = pageHeaderChecks(() => null)
    expect(bare.every((r) => r.status === 'FAIL' && r.detail === 'missing')).toBe(true)
    expect(pageHeaderChecks((n) => (n === 'strict-transport-security' ? 'max-age=300' : live[n]))[0].status).toBe('FAIL')
  })

  it('checks security.txt: contact, expiry ahead, a warning near the end', () => {
    const now = Date.parse('2026-09-27T00:00:00Z')
    const txt = (exp: string) => `Contact: mailto:hello@obpal.blackboxes.net\nExpires: ${exp}\n`
    expect(securityTxtCheck(200, txt('2027-09-26T00:00:00.000Z'), now)).toEqual({ check: 'security.txt', status: 'pass', detail: 'Contact, expires in 364 days' })
    expect(securityTxtCheck(200, txt('2026-10-10T00:00:00Z'), now).status).toBe('WARN')
    expect(securityTxtCheck(200, txt('2026-09-01T00:00:00Z'), now)).toMatchObject({ status: 'FAIL', detail: 'expired 26 days ago' })
    expect(securityTxtCheck(200, 'Expires: 2027-01-01T00:00:00Z', now)).toMatchObject({ status: 'FAIL', detail: 'no Contact' })
    expect(securityTxtCheck(404, '', now)).toMatchObject({ status: 'FAIL', detail: 'HTTP 404' })
  })

  it('proves a pairing code is shown without printing it', () => {
    expect(shownCode('Scan or type 123 456 7890 on your phone')).toBe('### ### ####')
    expect(shownCode('Scan the code')).toBeNull()
  })

  it('reports TURN without credentials', () => {
    const rows = turnChecks({
      hostTurn: [true],
      check: { turn: true, creds: true, urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.example.org:3478?transport=udp', 'turns:turn.example.org:443?transport=tcp'] },
      relay: { opened: true, openMs: 98, echoMs: 6, localType: 'relay', relayProtocol: 'udp' },
    })
    expect(rows).toEqual([
      { check: 'TURN offered', status: 'pass', detail: 'host yes; check yes; turn/udp, turns/tcp' },
      { check: 'relay-only DataChannel', status: 'pass', detail: 'opened in 98 ms, echo 6 ms, relay/udp' },
    ])
    expect(turnChecks({ hostTurn: [], check: null, relay: null })).toEqual([{ check: 'TURN offered', status: 'FAIL', detail: 'the Viewer made no /api/ice request' }])
    expect(turnChecks({ hostTurn: [false], check: { turn: false, creds: false, urls: [] }, relay: null }).map((r) => r.status)).toEqual(['FAIL', 'FAIL'])
  })
})

describe('check:live: release truth, the /link/ label against the download', () => {
  const files = (v: string) => ['obpal-link.zip', `obpal-link-${v}.zip`, 'obpal-desktop-windows-x64.zip']
  const page = (v: string) => `<a href="${LINK_STORE}">Add to Chrome</a><a href="${LINK_ZIP}">Download manual zip</a><p class="fine">Manual zip: Version ${v} · free, MIT licensed.</p>`

  it('checks both install routes on /link/', () => {
    expect(linkInstallChecks(page('1.6.1')).map(r => r.status)).toEqual(['pass', 'pass'])
    expect(linkInstallChecks(page('1.6.1').replace(LINK_STORE, 'https://example.com'))[0].status).toBe('FAIL')
    expect(linkInstallChecks(page('1.6.1').replace(LINK_ZIP, 'https://example.com'))[1].status).toBe('FAIL')
  })

  it('reads the version /link/ shows, and the tag and files of GitHub\'s latest release', () => {
    expect(linkVersionLabel(page('1.6.1'))).toBe('1.6.1')
    expect(linkVersionLabel('<p>Get ob.Pal Link</p>')).toBeNull()
    expect(latestRelease({ tag_name: 'v1.6.1', assets: files('1.6.1').map((name) => ({ name, size: 1 })) })).toEqual({ tag: 'v1.6.1', assets: files('1.6.1') })
    expect(latestRelease({ message: 'Not Found' })).toBeNull()
    expect(latestRelease(null)).toBeNull()
  })

  it('passes when the label is the latest release and all three files are there', () => {
    expect(releaseChecks({ label: '1.6.1', release: { tag: 'v1.6.1', assets: files('1.6.1') } })).toEqual([
      { check: 'latest release', status: 'pass', detail: 'v1.6.1, 3 files' },
      { check: '/link/ label', status: 'pass', detail: 'shows 1.6.1, latest release is v1.6.1' },
      { check: 'release files', status: 'pass', detail: 'all 3 present' },
    ])
    expect(RELEASE_ASSETS('1.6.1')).toEqual(files('1.6.1'))
  })

  it('fails when /link/ shows 1.6.1 and the latest release is v1.6.0', () => {
    const rows = releaseChecks({ label: '1.6.1', release: { tag: 'v1.6.0', assets: files('1.6.0') } })
    expect(rows.map((r) => r.status)).toEqual(['pass', 'FAIL', 'pass'])
    expect(rows[1].detail).toBe('shows 1.6.1, latest release is v1.6.0')
  })

  it('fails when a file is missing, or belongs to another version', () => {
    const rows = releaseChecks({ label: '1.6.1', release: { tag: 'v1.6.1', assets: ['obpal-link.zip', 'obpal-link-1.6.1.zip'] } })
    expect(rows[2]).toEqual({ check: 'release files', status: 'FAIL', detail: 'missing obpal-desktop-windows-x64.zip' })
    expect(releaseChecks({ label: '1.6.1', release: { tag: 'v1.6.1', assets: files('1.6.0') } })[2].detail).toBe('missing obpal-link-1.6.1.zip')
  })

  it('fails without a release to compare with, or a version on the page', () => {
    expect(releaseChecks({ label: '1.6.1', release: null, http: 403 })).toEqual([{ check: 'latest release', status: 'FAIL', detail: 'GitHub gave no release (HTTP 403)' }])
    expect(releaseChecks({ label: null, release: { tag: 'v1.6.1', assets: files('1.6.1') } })[1]).toMatchObject({ status: 'FAIL', detail: 'no version on the page' })
  })
})

describe('browser: the Chromium the tools drive', () => {
  it('falls back to the newest full Chromium an earlier Playwright installed', () => {
    const { store, exe, cleanup } = makeBrowserStore(['chromium-1234', 'chromium-1237', 'chromium_headless_shell-1240'])
    try {
      expect(newestInstalled(exe('chromium-1243'))).toBe(exe('chromium-1237'))
      expect(newestInstalled(`${store}/nowhere/x/chrome.exe`)).toBe('')
    } finally {
      cleanup()
    }
    expect(shortPath('/a/b/ms-playwright/chromium-1237/chrome-linux/chrome')).toBe('…/chromium-1237/chrome-linux/chrome')
  })
})
