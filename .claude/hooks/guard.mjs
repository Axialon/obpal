/**
 * Guard rails for Claude Code in this repo: a PreToolUse hook on the tools that run shell commands (Bash, PowerShell,
 * Monitor; .claude/settings.json). It only ever denies. A command that breaks one of the rules below is blocked with the reason, which Claude reads; anything
 * else goes on to the usual permission checks, untouched.
 *
 * Everyone:
 *   browser-version  a Chromium browser started with --version. On Windows that leaves a windowless browser running,
 *                    which blocks the owner's own. Read the version from the file (its VersionInfo) instead.
 *   e2e-desktop      the Link e2e with --desktop: it drives the installed ob.Pal Desktop and injects real input.
 *   reg-from-bash    reg from Git Bash, which rewrites its /switches as paths. Read the registry from PowerShell.
 *   registry-write   changing the registry, from either shell.
 *   extension-key    reading, copying or printing anything in ~/.obpal-keys (extension/scripts/store.mjs reads the
 *                    key itself and never prints it).
 *   helper-input-tests  cargo test --ignored / --include-ignored: the helper's ignored tests drive the real mouse
 *                    and keyboard.
 *   helper-install   installing ob.Pal Desktop (obpal-desktop install, its install.cmd).
 *   apex-domains     wrangler naming the apex domains blackboxes.net / blackboxes.dev or the boxem project.
 * Lanes (the command runs in or names .claude/worktrees/, or comes from the obpal-lane agent):
 *   push             git push; gh writes (pull requests, releases, repositories).
 *   deploy           wrangler deploy and other remote writes, pnpm run deploy, npm/pnpm publish, the npm release
 *                    with --yes (publish:npm, scripts/publish-npm.mjs; its dry run is allowed), open-source.mjs
 *                    --publish, Cloudflare API writes.
 *   sync-family      scripts/sync-family.mjs, which writes other repos: the coordinator's call.
 *
 * The parsing is a careful approximation of both shells (quotes, escapes, heredocs and here-strings, $( ) and
 * backticks, ; && || | &, and bash -c / pwsh -Command / cmd /c wrappers), tuned to catch these commands as people and
 * agents type them while leaving mentions of them in commit messages, echo and grep alone. It is a rail, not a sandbox.
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// ---- parsing ---------------------------------------------------------------------------------------------------------

/**
 * Text that is data, not commands, taken out: bash heredoc bodies (<<EOF … EOF, <<-, quoted or not; not <<<) and
 * PowerShell here-strings (@' … '@, @" … "@), where commit messages and file contents usually come from.
 */
function stripData(cmd, bash) {
  if (!bash) return cmd.replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@/g, "''")
  const out = []
  const ends = []
  for (const line of cmd.split('\n')) {
    if (ends.length) {
      if (line.replace(/^\t+/, '').replace(/\r$/, '') === ends[0]) ends.shift()
      continue
    }
    out.push(line)
    for (const m of line.matchAll(/(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][\w-]*)\1/g)) ends.push(m[2])
  }
  return out.join('\n')
}

/** The command lines inside $( … ) and, in bash, backticks: [the outer line with each replaced by a word, ...inner]. */
function substitutions(cmd, bash) {
  const inner = []
  let out = ''
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1)
      const end = j < 0 ? cmd.length - 1 : j
      out += cmd.slice(i, end + 1)
      i = end
    } else if (c === '$' && cmd[i + 1] === '(') {
      let depth = 1
      let j = i + 2
      for (; j < cmd.length && depth; j++) depth += cmd[j] === '(' ? 1 : cmd[j] === ')' ? -1 : 0
      inner.push(cmd.slice(i + 2, depth ? j : j - 1))
      out += ' _ '
      i = j - 1
    } else if (bash && c === '`') {
      const j = cmd.indexOf('`', i + 1)
      const end = j < 0 ? cmd.length : j
      inner.push(cmd.slice(i + 1, end))
      out += ' _ '
      i = end
    } else out += c
  }
  return [out, ...inner]
}

/** One command line as simple commands, each a list of words with the quotes and escapes resolved. */
function split(cmd, bash) {
  const segs = [[]]
  let word = null
  const push = () => { if (word !== null) segs[segs.length - 1].push(word); word = null }
  const cut = () => { push(); if (segs[segs.length - 1].length) segs.push([]) }
  const esc = bash ? '\\' : '`'
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1)
      const end = j < 0 ? cmd.length : j
      word = (word ?? '') + cmd.slice(i + 1, end)
      i = end
    } else if (c === '"') {
      let j = i + 1
      let s = ''
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        if (cmd[j] === esc && j + 1 < cmd.length && (!bash || '"\\$`'.includes(cmd[j + 1]))) s += cmd[++j]
        else s += cmd[j]
      }
      word = (word ?? '') + s
      i = j
    } else if (c === '$' && cmd[i + 1] === '{') {
      const j = cmd.indexOf('}', i)
      const end = j < 0 ? cmd.length : j
      word = (word ?? '') + cmd.slice(i, end + 1)
      i = end
    } else if (c === esc && i + 1 < cmd.length) {
      if (cmd[i + 1] !== '\n' && cmd[i + 1] !== '\r') word = (word ?? '') + cmd[i + 1]
      i++
    } else if (c === '\n' || c === '\r') cut()
    else if (/\s/.test(c)) push()
    else if (';&|(){}'.includes(c)) cut()
    else word = (word ?? '') + c
  }
  push()
  return segs.filter((s) => s.length)
}

const SHELLS = /^(bash|sh|zsh|dash|pwsh|powershell)(\.exe)?$/i
/** Words that only run what follows them. */
const WRAPPERS = new Set(['sudo', 'exec', 'command', 'env', 'time', 'nohup', 'call', 'start', 'start-process', 'invoke-expression', 'iex', 'xargs'])

/**
 * Every simple command a command line runs, as word lists: the line itself, what its $( ) and backticks run, and what
 * bash -c, pwsh -Command and cmd /c run, with wrappers (env assignments, sudo, start, &) taken off the front.
 * @param {string} command
 * @param {boolean} bash
 * @returns {string[][]}
 */
export function commands(command, bash, depth = 0) {
  if (depth > 4) return []
  const out = []
  for (const line of substitutions(stripData(command, bash), bash)) {
    for (let seg of split(line, bash)) {
      for (;;) {
        const w = seg[0]?.toLowerCase().replace(/^.*[\\/]/, '') ?? ''
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[0] ?? '')) seg = seg.slice(1)
        else if (WRAPPERS.has(w)) {
          seg = seg.slice(1)
          while (seg.length && /^-(filepath|wait|nonewwindow|passthru)$/i.test(seg[0])) seg = seg.slice(1)
        } else break
      }
      const w = seg[0]?.toLowerCase().replace(/^.*[\\/]/, '') ?? ''
      if (w === 'cmd' || w === 'cmd.exe') {
        const i = seg.findIndex((x) => /^\/\/?[ck]$/i.test(x))
        if (i >= 0) { out.push(...commands(seg.slice(i + 1).join(' '), false, depth + 1)); continue }
      }
      if (SHELLS.test(w)) {
        const i = seg.findIndex((x) => /^-(c|lc|command|encodedcommand)$/i.test(x))
        if (i >= 0 && seg[i + 1] !== undefined) { out.push(...commands(seg.slice(i + 1).join(' '), !/^(pwsh|powershell)/i.test(w), depth + 1)); continue }
      }
      if (seg.length) out.push(seg)
    }
  }
  return out
}

// ---- the rules -------------------------------------------------------------------------------------------------------

const base = (w) => (w ?? '').toLowerCase().replace(/^.*[\\/]/, '')
const has = (seg, re) => seg.some((w) => re.test(w))
/** Commands that print or pass on text without running what it names: mentions in them are only words. */
const TEXTUAL = new Set(['git', 'grep', 'egrep', 'fgrep', 'rg', 'findstr', 'select-string', 'sls', 'echo', 'printf', 'write-output', 'write-host', 'write-error', 'sed', 'awk', 'jq', 'gh', 'claude', 'cat', 'type', 'get-content', 'gc', 'head', 'tail', 'less', 'more', 'wc', 'sort', 'uniq', 'code'])
const BROWSER = /(^|[\\/])(chrome|chromium|chromium-browser|google-chrome(-stable)?|msedge|brave|vivaldi|opera)(\.exe)?$|obpal_e2e_chromium/i
const VERSION = /^(--?version|--product-version)$/i
const REG_WRITE = new Set(['add', 'delete', 'import', 'restore', 'load', 'unload', 'copy'])
const PS_WRITE = new Set(['set-itemproperty', 'sp', 'new-itemproperty', 'remove-itemproperty', 'rp', 'rename-itemproperty', 'clear-itemproperty', 'copy-itemproperty', 'move-itemproperty', 'new-item', 'ni', 'remove-item', 'ri', 'rm', 'del', 'rmdir', 'rd', 'erase', 'set-item', 'si', 'clear-item', 'cli', 'rename-item', 'rni', 'ren', 'move-item', 'mi', 'mv', 'move', 'copy-item', 'cp', 'copy', 'cpi', 'new-psdrive'])
const REG_PATH = /^(hk(cu|lm|cr|u|cc)|hkey_[a-z_]+)(:|\\|$)|^registry::/i
const KEYS_DIR = /[\\/]?\.obpal-keys([\\/]|$)/i
/** What may name the key folder: listing it, opening it for the owner, the scripts that use the key, text. */
const KEYS_OK = new Set(['ls', 'dir', 'gci', 'get-childitem', 'test-path', 'stat', 'find', 'tree', 'explorer', 'explorer.exe', 'ii', 'invoke-item', 'git', 'echo', 'printf', 'write-output', 'write-host'])
const APEX = /(^|[^\w.-])blackboxes\.(net|dev)\b/i
/** wrangler's remote writes (anything with --remote counts too); dev, types, whoami, tail and local data stay open. */
const WRANGLER_WRITES = new Set(['deploy', 'publish', 'versions', 'rollback', 'delete', 'secret', 'secret:bulk', 'pages', 'triggers', 'route', 'routes', 'domains', 'queues', 'hyperdrive', 'vectorize', 'dispatch-namespace', 'workflows', 'containers', 'mtls-certificate', 'cert', 'pipelines', 'secrets-store', 'login', 'logout'])
const GH_WRITES = { pr: ['create', 'merge', 'edit', 'close', 'reopen', 'ready', 'comment', 'review'], release: ['create', 'upload', 'edit', 'delete', 'delete-asset'], repo: ['create', 'delete', 'edit', 'sync', 'fork', 'rename', 'archive'] }
const PM = new Set(['pnpm', 'npm', 'yarn', 'bun', 'pnpm.cmd', 'npm.cmd', 'yarn.cmd'])
const PM_OPTION_VALUE = /^(--filter|-F|-C|--dir|--prefix|--workspace|-w)$/

/** The words after the first that aren't options (nor an option's value), lower-cased. */
function args(seg) {
  const out = []
  const git = base(seg[0]) === 'git' || base(seg[0]) === 'git.exe'
  for (let i = 1; i < seg.length; i++) {
    if (PM_OPTION_VALUE.test(seg[i]) || (git && /^-[Cc]$/.test(seg[i]))) { i++; continue }
    if (!seg[i].startsWith('-')) out.push(seg[i].toLowerCase())
  }
  return out
}

/** The wrangler subcommand a command runs (wrangler …, npx wrangler …, pnpm exec wrangler …), or null. */
function wrangler(seg) {
  const i = seg.findIndex((w) => /^wrangler(@[\w.^~-]+)?(\.cmd|\.exe|\.js)?$/i.test(base(w)))
  if (i < 0 || (i > 0 && !['npx', 'pnpx', 'bunx', 'pnpm', 'npm', 'yarn', 'bun', 'node', 'exec', 'dlx'].includes(base(seg[0])))) return null
  return { sub: seg.slice(i + 1).find((w) => !w.startsWith('-'))?.toLowerCase() ?? '', words: seg.slice(i + 1) }
}

/** The package-manager script a command runs (pnpm run deploy, npm run sync:family, pnpm deploy), or null. */
function pmScript(seg) {
  if (!PM.has(base(seg[0]))) return null
  const a = args(seg)
  return a[0] === 'run' || a[0] === 'run-script' ? a[1] ?? '' : a[0] ?? ''
}

const deny = (rule, reason) => ({ rule, reason })

/** Rules for every session: the coordinator's and the lanes'. */
function everyone(seg, bash) {
  const first = base(seg[0])
  const textual = TEXTUAL.has(first)
  if (!textual && has(seg, BROWSER) && has(seg, VERSION)) {
    return deny('browser-version', 'Never start Chrome/Chromium with --version: on Windows it leaves a windowless browser running that blocks the owner\'s own. Read the version from the file instead, e.g. (Get-Item <path to chrome.exe>).VersionInfo.ProductVersion, or the version folder beside it.')
  }
  if (!textual && seg.includes('--desktop') && has(seg, /e2e/i)) {
    return deny('e2e-desktop', 'The Link e2e with --desktop reaches the installed ob.Pal Desktop and injects real input. It is a deliberate, by-hand run for its owner only: run the e2e without --desktop (the stub helper).')
  }
  const reg = /^reg(\.exe)?$/.test(first)
  if (reg && bash) return deny('reg-from-bash', 'No reg from Git Bash: MSYS rewrites its /switches as paths. Read the registry from PowerShell instead, e.g. Get-ItemProperty \'HKCU:\\Software\\…\'.')
  if ((reg && REG_WRITE.has(args(seg)[0] ?? '')) || /^regedit(\.exe)?$/.test(first) || (PS_WRITE.has(first) && seg.slice(1).some((w) => REG_PATH.test(w)))) {
    return deny('registry-write', 'Never change the registry (no installing the helper, no native-messaging entries by hand). The e2e registers its own stub under a test-only name and removes it.')
  }
  if (seg.some((w) => KEYS_DIR.test(w)) && !KEYS_OK.has(first) && !has(seg, /(^|[\\/])(store|key)\.mjs$|^store:extension$/)) {
    return deny('extension-key', 'Nothing may read, copy or print what is in ~/.obpal-keys (the extension\'s private key and the store\'s first-upload zip). extension/scripts/store.mjs --with-key reads the key itself and prints nothing of it; listing the folder is fine.')
  }
  if (/^cargo(\.exe)?$/.test(first) && seg.includes('test') && (seg.includes('--include-ignored') || seg.includes('--ignored'))) {
    return deny('helper-input-tests', 'The helper\'s ignored tests drive the real mouse and keyboard. Run cargo test without --ignored / --include-ignored.')
  }
  if ((/^obpal-desktop(\.exe)?$/.test(first) && args(seg).includes('install')) || has(seg, /obpal-desktop[\\/]install\.cmd$|desktop[\\/](package|release)[\\/].*install\.cmd$/i)) {
    return deny('helper-install', 'Never install ob.Pal Desktop (the owner\'s machine has its own install); the tests use the stub helper.')
  }
  const wr = wrangler(seg)
  if (wr && wr.words.some((w) => /\bboxem\b/i.test(w) || APEX.test(w))) {
    return deny('apex-domains', 'Not ours to touch: the apex domains blackboxes.net / blackboxes.dev and the boxem project. ob.Pal lives on its own subdomain (wrangler.jsonc routes).')
  }
  return null
}

/** Rules for lanes: they commit on their branch and hand back; the coordinator merges, deploys, pushes and publishes. */
function lanes(seg) {
  const first = base(seg[0]).replace(/\.exe$/, '')
  if (first === 'git' && args(seg)[0] === 'push') return deny('push', 'Lanes never push: commit on your branch and hand back; the coordinator merges and pushes.')
  if (first === 'gh') {
    const [group, action] = args(seg)
    const method = seg.findIndex((w) => /^(-X|--method)$/.test(w))
    const apiWrite = group === 'api' && ((method >= 0 && !/^get$/i.test(seg[method + 1] ?? '')) || has(seg, /^(-f|-F|--field|--raw-field|--input)$/))
    if (GH_WRITES[group]?.includes(action) || apiWrite) return deny('push', `Lanes never publish: gh ${group}${apiWrite ? ' writes' : ` ${action}`} are the coordinator's.`)
  }
  const wr = wrangler(seg)
  if (wr && (WRANGLER_WRITES.has(wr.sub) || wr.words.includes('--remote'))) return deny('deploy', `Lanes never deploy or write to Cloudflare: wrangler ${wr.sub}${wr.words.includes('--remote') ? ' --remote' : ''} is the coordinator's. wrangler dev, types and local data are fine.`)
  const script = pmScript(seg)
  // The npm release publishes only with --yes, however it is started: pnpm/npm/yarn (run) publish:npm, behind npx or
  // corepack, or a runtime on scripts/publish-npm.mjs. Reading or searching the script is not running it.
  const npmRelease = script === 'publish:npm' || (!TEXTUAL.has(first) && has(seg, /^publish:npm$|(^|[\\/])publish-npm\.mjs$/))
  if (script === 'deploy' || (PM.has(first) && args(seg).includes('publish')) || (npmRelease && has(seg, /^--yes(=.*)?$/))) return deny('deploy', 'Lanes never deploy or publish; the coordinator does, from the main checkout.')
  if ((first === 'node' && has(seg, /(^|[\\/])sync-family\.mjs$/)) || script === 'sync:family') return deny('sync-family', 'scripts/sync-family.mjs writes other repos: it is the coordinator\'s call, never a lane\'s.')
  if (first === 'node' && has(seg, /(^|[\\/])open-source\.mjs$/) && seg.includes('--publish')) return deny('deploy', 'Lanes never publish the open-source snapshot; without --publish (export and scan only) is fine.')
  if (['curl', 'curl.exe', 'invoke-restmethod', 'irm', 'invoke-webrequest', 'iwr'].includes(first) && has(seg, /api\.cloudflare\.com/i)) {
    const method = seg.findIndex((w) => /^(-X|--request|-Method)$/i.test(w))
    const writes = (method >= 0 && !/^(get|head)$/i.test(seg[method + 1] ?? '')) || has(seg, /^(-d|--data.*|-F|--form|-T|--upload-file|-Body)$/i)
    if (writes) return deny('deploy', 'Lanes never write to Cloudflare\'s API.')
  }
  return null
}

const WORKTREE = /[\\/]\.claude[\\/]worktrees[\\/]|^\.claude[\\/]worktrees[\\/]/i

/**
 * The hook's decision for one tool call: null lets it through, { rule, reason } blocks it.
 * @param {{ tool_name?: string, tool_input?: { command?: string }, cwd?: string, agent_type?: string }} input
 */
export function decide(input) {
  const command = input?.tool_input?.command
  if (typeof command !== 'string' || !command.trim()) return null
  const bash = input.tool_name !== 'PowerShell'
  const lane = WORKTREE.test(`${input.cwd ?? ''}/`) || WORKTREE.test(command) || /(^|[\s'"=])\.claude[\\/]worktrees[\\/]/i.test(command) || input.agent_type === 'obpal-lane'
  for (const seg of commands(command, bash)) {
    const hit = everyone(seg, bash) ?? (lane ? lanes(seg) : null)
    if (hit) return hit
  }
  return null
}

// ---- the hook --------------------------------------------------------------------------------------------------------
/**
 * Read the tool call from stdin and answer on stdout: a PreToolUse "deny" decision with the reason, or nothing, which
 * lets it through. Always exit 0: the decision travels in the JSON because PowerShell's -Command turns a program's
 * exit code 2 into 1, which Claude Code would take as a failed hook and let the call run. settings.json starts this
 * through `node -e`, with CLAUDE_PROJECT_DIR read by node itself, so it works whichever shell (Git Bash, PowerShell,
 * cmd) runs hooks.
 */
export function main() {
  let input
  try {
    input = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    process.exit(0) // not a tool call we can read: leave it to the permission checks
  }
  const hit = decide(input)
  if (hit) {
    const permissionDecisionReason = `Blocked by the ob.Pal guard (${hit.rule}): ${hit.reason}`
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason } }))
  }
  process.exit(0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
