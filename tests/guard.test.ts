import { describe, expect, it } from 'vitest'
import { commands, decide } from '../.claude/hooks/guard.mjs'
import { hookShells, readText, runHook } from './devtools-node.mjs'

const MAIN = 'D:\\dev\\ob-pal'
const LANE = 'D:\\dev\\ob-pal\\.claude\\worktrees\\agent-1'
const rule = (tool: 'Bash' | 'PowerShell', command: string, cwd = MAIN, agent_type?: string) =>
  decide({ tool_name: tool, tool_input: { command }, cwd, agent_type })?.rule ?? null

describe('guard: parsing both shells', () => {
  it('splits commands, resolves quotes, and looks inside wrappers and substitutions', () => {
    expect(commands('FOO=1 git status && echo "a;b" | grep x', true)).toEqual([['git', 'status'], ['echo', 'a;b'], ['grep', 'x']])
    expect(commands('echo $(chrome --version) `node -v`', true)).toEqual([['echo', '_', '_'], ['chrome', '--version'], ['node', '-v']])
    expect(commands('bash -lc "cd x && wrangler deploy"', true)).toEqual([['cd', 'x'], ['wrangler', 'deploy']])
    expect(commands('& "C:\\Program Files\\x\\chrome.exe" --version', false)).toEqual([['C:\\Program Files\\x\\chrome.exe', '--version']])
    expect(commands('cmd /c "reg query HKCU\\Software"', false)).toEqual([['reg', 'query', 'HKCU\\Software']])
    expect(commands('Start-Process -FilePath chrome -ArgumentList "--version"', false)).toEqual([['chrome', '-ArgumentList', '--version']])
  })

  it('reads heredocs and here-strings as data, not commands', () => {
    const message = 'Guard rails\n\nnpx wrangler deploy is the coordinator\'s\nchrome.exe --version is never run\n'
    expect(commands(`git commit -F - <<'EOF'\n${message}EOF\ngit log -1`, true)).toEqual([['git', 'commit', '-F', '-', '<<EOF'], ['git', 'log', '-1']])
    expect(commands(`git commit -m "$(cat <<'EOF'\n${message}EOF\n)"`, true)).toEqual([['git', 'commit', '-m', ' _ '], ['cat', '<<EOF']])
    expect(commands(`git commit -m @'\n${message}'@`, false)).toEqual([['git', 'commit', '-m', '']])
    expect(commands('cat <<< "npx wrangler deploy"\nnpx wrangler deploy', true)).toEqual([['cat', '<<<', 'npx wrangler deploy'], ['npx', 'wrangler', 'deploy']])
    expect(rule('Bash', `git commit -m "$(cat <<'EOF'\n${message}EOF\n)"`, LANE)).toBeNull()
    expect(rule('PowerShell', `git commit -m @'\n${message}'@`, LANE)).toBeNull()
  })
})

describe('guard: rules for everyone', () => {
  it('blocks a browser started with --version, not mentions of it', () => {
    expect(rule('Bash', '"C:/Program Files/Google/Chrome/Application/chrome.exe" --version')).toBe('browser-version')
    expect(rule('PowerShell', '& "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --version')).toBe('browser-version')
    expect(rule('Bash', '"$OBPAL_E2E_CHROMIUM" --version')).toBe('browser-version')
    expect(rule('PowerShell', "Start-Process chrome -ArgumentList '--version'")).toBe('browser-version')
    expect(rule('Bash', 'echo $(google-chrome --version)')).toBe('browser-version')
    expect(rule('Bash', 'bash -c "chromium --version"')).toBe('browser-version')
    expect(rule('Bash', 'node --version && ls chrome-win64')).toBeNull()
    expect(rule('PowerShell', '(Get-Item "D:\\b\\chrome.exe").VersionInfo.ProductVersion')).toBeNull()
    expect(rule('Bash', 'git commit -m "docs: never run chrome.exe --version; read the file"')).toBeNull()
    expect(rule('Bash', 'grep -rn "chrome --version" .')).toBeNull()
  })

  it('blocks the Link e2e with --desktop', () => {
    expect(rule('Bash', 'node extension/scripts/e2e.mjs --desktop')).toBe('e2e-desktop')
    expect(rule('PowerShell', 'pnpm run e2e:extension -- --desktop')).toBe('e2e-desktop')
    expect(rule('Bash', 'pnpm --filter @obpal/extension run e2e -- --desktop')).toBe('e2e-desktop')
    expect(rule('Bash', 'pnpm run e2e:extension')).toBeNull()
    expect(rule('Bash', 'echo "e2e --desktop is for its owner only"')).toBeNull()
  })

  it('keeps reg out of Git Bash and the registry unchanged', () => {
    expect(rule('Bash', 'reg query "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts"')).toBe('reg-from-bash')
    expect(rule('Bash', 'cmd //c reg query HKCU\\\\Software')).toBe('reg-from-bash')
    expect(rule('PowerShell', 'reg query HKCU\\Software\\Chromium')).toBeNull()
    expect(rule('PowerShell', "Get-ItemProperty 'HKCU:\\Software\\Chromium\\NativeMessagingHosts\\x'")).toBeNull()
    expect(rule('PowerShell', 'reg add HKCU\\Software\\X /v Y /d Z /f')).toBe('registry-write')
    expect(rule('PowerShell', "Set-ItemProperty -Path 'HKCU:\\Software\\X' -Name Y -Value 1")).toBe('registry-write')
    expect(rule('PowerShell', "Remove-Item -Recurse 'HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\x'")).toBe('registry-write')
    expect(rule('PowerShell', 'Remove-Item -Recurse .\\dist')).toBeNull()
  })

  it('keeps the extension key where it is', () => {
    expect(rule('Bash', 'cat ~/.obpal-keys/extension-key.pem')).toBe('extension-key')
    expect(rule('PowerShell', 'Get-Content $HOME\\.obpal-keys\\extension-key.pem')).toBe('extension-key')
    expect(rule('Bash', 'cp ~/.obpal-keys/extension-key.pem extension/')).toBe('extension-key')
    expect(rule('Bash', 'ls ~/.obpal-keys/store')).toBeNull()
    expect(rule('Bash', 'node extension/scripts/store.mjs --with-key ~/.obpal-keys/extension-key.pem')).toBeNull()
    expect(rule('Bash', 'git commit -m "store: the first-upload zip goes to ~/.obpal-keys/store"')).toBeNull()
  })

  it('keeps the helper off this machine and its real-input tests unrun', () => {
    expect(rule('Bash', 'cd desktop && cargo test -- --include-ignored')).toBe('helper-input-tests')
    expect(rule('Bash', 'cargo test --release')).toBeNull()
    expect(rule('PowerShell', '.\\desktop\\target\\release\\obpal-desktop.exe install')).toBe('helper-install')
    expect(rule('Bash', 'cmd //c desktop/package/install.cmd')).toBe('helper-install')
    expect(rule('Bash', 'node desktop/pack.mjs')).toBeNull()
  })

  it('keeps wrangler off the apex domains and the boxem project, even for the coordinator', () => {
    expect(rule('Bash', 'npx wrangler pages deploy dist --project-name boxem')).toBe('apex-domains')
    expect(rule('Bash', 'npx wrangler deploy --route "blackboxes.net/*"')).toBe('apex-domains')
    expect(rule('Bash', 'npx wrangler deploy')).toBeNull()
    expect(rule('Bash', 'curl -sI https://obpal.blackboxes.net/')).toBeNull()
  })
})

describe('guard: rules for lanes', () => {
  it('tells a lane by its worktree, a command naming one, or the obpal-lane agent', () => {
    expect(rule('Bash', 'git push origin HEAD', LANE)).toBe('push')
    expect(rule('Bash', 'git -C .claude/worktrees/agent-1 push', MAIN)).toBe('push')
    expect(rule('Bash', 'git push', MAIN, 'obpal-lane')).toBe('push')
    expect(rule('Bash', 'git push', MAIN)).toBeNull()
    expect(rule('Bash', 'git commit -m "push the fix later"', LANE)).toBeNull()
  })

  it('blocks deploys and remote writes, and leaves local work alone', () => {
    expect(rule('Bash', 'npx wrangler deploy', LANE)).toBe('deploy')
    expect(rule('PowerShell', 'pnpm exec wrangler versions upload', LANE)).toBe('deploy')
    expect(rule('Bash', 'npx wrangler d1 execute DB --remote --command "select 1"', LANE)).toBe('deploy')
    expect(rule('Bash', 'pnpm run deploy', LANE)).toBe('deploy')
    expect(rule('Bash', 'npm publish', LANE)).toBe('deploy')
    expect(rule('Bash', 'pnpm --filter @obpal/core publish', LANE)).toBe('deploy')
    expect(rule('Bash', 'node scripts/open-source.mjs --publish', LANE)).toBe('deploy')
    expect(rule('Bash', 'pnpm run publish:npm -- --yes', LANE)).toBe('deploy')
    expect(rule('Bash', 'pnpm run publish:npm --yes', LANE)).toBe('deploy')
    expect(rule('PowerShell', 'pnpm publish:npm --yes', LANE)).toBe('deploy')
    expect(rule('Bash', 'pnpm --filter ob-pal run publish:npm -- --yes', LANE)).toBe('deploy')
    expect(rule('Bash', 'npm run publish:npm -- --yes', LANE)).toBe('deploy')
    expect(rule('Bash', 'yarn run publish:npm --yes', LANE)).toBe('deploy')
    expect(rule('Bash', 'yarn publish:npm --yes', LANE)).toBe('deploy')
    expect(rule('Bash', 'node scripts/publish-npm.mjs --yes', LANE)).toBe('deploy')
    expect(rule('PowerShell', 'node .\\scripts\\publish-npm.mjs --yes', LANE)).toBe('deploy')
    expect(rule('Bash', 'cd scripts && node publish-npm.mjs --yes', LANE)).toBe('deploy')
    expect(rule('Bash', 'pnpm exec node scripts/publish-npm.mjs --yes', LANE)).toBe('deploy')
    expect(rule('Bash', 'bash -c "pnpm run publish:npm -- --yes"', LANE)).toBe('deploy')
    expect(rule('Bash', 'npx pnpm run publish:npm -- --yes', LANE)).toBe('deploy')
    expect(rule('Bash', 'corepack pnpm run publish:npm --yes', LANE)).toBe('deploy')
    expect(rule('PowerShell', '& pnpm run publish:npm -- --yes', LANE)).toBe('deploy')
    expect(rule('Bash', 'node --no-warnings scripts/publish-npm.mjs --yes', LANE)).toBe('deploy')
    expect(rule('Bash', 'bun scripts/publish-npm.mjs --yes', LANE)).toBe('deploy')
    expect(rule('Bash', 'pnpm run "publish:npm" -- --yes', LANE)).toBe('deploy')
    expect(rule('Bash', 'pnpm run publish:npm -- --yes=true', LANE)).toBe('deploy')
    expect(rule('Bash', 'pnpm run publish:npm --yes', MAIN, 'obpal-lane')).toBe('deploy')
    expect(rule('Bash', 'pnpm run publish:npm', LANE)).toBeNull()
    expect(rule('PowerShell', 'pnpm run publish:npm', LANE)).toBeNull()
    expect(rule('Bash', 'node scripts/publish-npm.mjs', LANE)).toBeNull()
    expect(rule('Bash', 'node scripts/publish-npm.mjs --help', LANE)).toBeNull()
    expect(rule('Bash', 'cat scripts/publish-npm.mjs', LANE)).toBeNull()
    expect(rule('Bash', 'grep -n yes scripts/publish-npm.mjs', LANE)).toBeNull()
    expect(rule('Bash', 'git commit -m "publish:npm --yes is the coordinator\'s"', LANE)).toBeNull()
    expect(rule('Bash', 'echo pnpm run publish:npm -- --yes', LANE)).toBeNull()
    expect(rule('Bash', 'pnpm run publish:npm -- --yes', MAIN)).toBeNull()
    expect(rule('Bash', 'node scripts/publish-npm.mjs --yes', MAIN)).toBeNull()
    expect(rule('Bash', 'curl -X POST https://api.cloudflare.com/client/v4/zones/x/purge_cache', LANE)).toBe('deploy')
    expect(rule('Bash', 'npx wrangler dev --port 5197', LANE)).toBeNull()
    expect(rule('Bash', 'npx wrangler types', LANE)).toBeNull()
    expect(rule('Bash', 'node scripts/open-source.mjs', LANE)).toBeNull()
    expect(rule('Bash', 'pnpm run deploy', MAIN)).toBeNull()
  })

  it('blocks publishing through gh, and sync-family', () => {
    expect(rule('Bash', 'gh release create v1.6.0 extension/release/obpal-link.zip', LANE)).toBe('push')
    expect(rule('Bash', 'gh api -X POST repos/o/r/issues -f title=x', LANE)).toBe('push')
    expect(rule('Bash', 'gh pr view 3', LANE)).toBeNull()
    expect(rule('Bash', 'gh api repos/o/r', LANE)).toBeNull()
    expect(rule('Bash', 'node scripts/sync-family.mjs', LANE)).toBe('sync-family')
    expect(rule('PowerShell', 'pnpm run sync:family', LANE)).toBe('sync-family')
    expect(rule('Bash', 'cat scripts/sync-family.mjs', LANE)).toBeNull()
    expect(rule('Bash', 'node scripts/sync-family.mjs', MAIN)).toBeNull()
  })
})

describe('guard: the hook as settings.json runs it', () => {
  const entry = JSON.parse(readText('.claude/settings.json')).hooks.PreToolUse[0]
  const deny = { tool_name: 'Bash', tool_input: { command: '"C:/Program Files/Google/Chrome/Application/chrome.exe" --version' }, cwd: MAIN }
  const allow = { tool_name: 'PowerShell', tool_input: { command: 'Get-ChildItem -Force' }, cwd: MAIN }

  it('matches every tool that runs a shell command: Bash, PowerShell and Monitor', () => {
    expect(entry.matcher).toBe('Bash|PowerShell|Monitor')
  })

  it('denies through JSON with exit 0 from every shell, so no shell can turn a deny into a failed hook', () => {
    for (const [shell, flags] of hookShells()) {
      expect(runHook(shell, flags, entry.hooks[0].command, deny), shell).toEqual({ status: 0, decision: 'deny' })
      expect(runHook(shell, flags, entry.hooks[0].command, allow), shell).toEqual({ status: 0, decision: 'none' })
    }
  }, 20_000)
})
