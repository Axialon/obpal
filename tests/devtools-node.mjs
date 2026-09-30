/**
 * Node-side helpers for the dev-tool tests (tests/devtools.test.ts, tests/guard.test.ts, tests/messaging.test.ts),
 * which are type-checked without Node's types: files of this checkout (as text or bytes), byte buffers, a throwaway
 * browser store, a packed npm tarball built in memory, a script run for its exit code, and the guard hook run the way
 * .claude/settings.json runs it, through a real shell.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

export const root = fileURLToPath(new URL('..', import.meta.url))
export const readText = (rel) => readFileSync(join(root, rel), 'utf8')
export const readBytes = (rel) => new Uint8Array(readFileSync(join(root, rel)))
export const bytes = (s) => Buffer.from(s)

/**
 * A gzipped tarball like the one `pnpm pack` makes, from path → text or bytes, every path under `folder/`. `pax` writes each
 * path in an extended header, as tar does for a long name; `links` adds symbolic links by path.
 */
export function makeTarball(files, { folder = 'package', pax = false, links = [] } = {}) {
  const enc = new TextEncoder()
  const octal = (n, len) => `${n.toString(8).padStart(len - 1, '0')}\0`
  const entry = (name, body, type = '0') => {
    const head = new Uint8Array(512)
    const put = (s, at) => head.set(enc.encode(s), at)
    let prefix = ''
    let short = name
    if (enc.encode(name).length > 100) { const i = name.lastIndexOf('/'); prefix = name.slice(0, i); short = name.slice(i + 1) }
    put(short, 0); put('0000644\0', 100); put('0000000\0', 108); put('0000000\0', 116); put(octal(body.length, 12), 124); put(octal(0, 12), 136)
    put('        ', 148); put(type, 156); put('ustar\0', 257); put('00', 263); put(prefix, 345)
    put(`${octal(head.reduce((a, b) => a + b, 0), 7)} `.slice(0, 8), 148)
    const pad = new Uint8Array(Math.ceil(body.length / 512) * 512)
    pad.set(body)
    return [head, pad]
  }
  const blocks = []
  for (const [path, body] of Object.entries(files)) {
    const data = typeof body === 'string' ? enc.encode(body) : body
    const name = `${folder}/${path}`
    if (pax) {
      // A pax record is "<length> path=<name>\n", the length counting its own digits.
      const rest = ` path=${name}\n`
      let n = rest.length + 1
      while (String(n).length + rest.length !== n) n++
      blocks.push(...entry('PaxHeader', enc.encode(`${n}${rest}`), 'x'))
    }
    blocks.push(...entry(name, data))
  }
  for (const path of links) blocks.push(...entry(`${folder}/${path}`, new Uint8Array(), '2'))
  blocks.push(new Uint8Array(1024))
  const all = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0))
  let at = 0
  for (const b of blocks) { all.set(b, at); at += b.length }
  return new Uint8Array(gzipSync(all))
}

/** The Node that runs the tests, to start a small script of the test's own. */
export const nodePath = process.execPath

/** A script of this checkout run with Node (no shell): its exit status and what it printed. */
export function runScript(rel, args) {
  const r = spawnSync(process.execPath, [join(root, rel), ...args], { encoding: 'utf8', cwd: root })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

/** A temp folder laid out like Playwright's browser store, with a chrome.exe in each named revision folder. */
export function makeBrowserStore(revisions) {
  const store = mkdtempSync(join(tmpdir(), 'obpal-browsers-'))
  const exe = (rev) => join(store, rev, 'chrome-win64', 'chrome.exe')
  for (const rev of revisions) {
    mkdirSync(join(store, rev, 'chrome-win64'), { recursive: true })
    writeFileSync(exe(rev), '')
  }
  return { store, exe, cleanup: () => rmSync(store, { recursive: true, force: true }) }
}

/** The shells a hook command may run in here: cmd, Windows PowerShell and Git Bash on Windows; sh elsewhere. */
export function hookShells() {
  if (process.platform !== 'win32') return [['sh', ['-c']]]
  const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe'
  return [['cmd', ['/d', '/s', '/c']], ['powershell', ['-NoProfile', '-Command']], ...(existsSync(gitBash) ? [[gitBash, ['-c']]] : [])]
}

/** Run a hook command through a shell with a tool call on stdin: its exit status and its permission decision. */
export function runHook(shell, flags, command, input) {
  const r = spawnSync(shell, [...flags, command], {
    input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root }, windowsVerbatimArguments: shell === 'cmd',
  })
  let decision = 'none'
  try { decision = JSON.parse(r.stdout).hookSpecificOutput.permissionDecision } catch { /* nothing on stdout: let through */ }
  return { status: r.status, decision }
}

/** Every community pack, including its displayed text, is part of the public copy surface. */
export const packFiles = () => ['profiles', 'mappings', 'modes', 'scenes'].flatMap((folder) => readdirSync(join(root, 'catalogue', folder)).filter((f) => f.endsWith('.json')).map((f) => `catalogue/${folder}/${f}`))
