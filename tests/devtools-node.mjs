/**
 * Node-side helpers for the dev-tool tests (tests/devtools.test.ts, tests/guard.test.ts), which are type-checked
 * without Node's types: files of this checkout, byte buffers, a throwaway browser store, and the guard hook run the
 * way .claude/settings.json runs it, through a real shell.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('..', import.meta.url))
export const readText = (rel) => readFileSync(join(root, rel), 'utf8')
export const bytes = (s) => Buffer.from(s)

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
