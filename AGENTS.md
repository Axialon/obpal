# Working in ob.Pal (for coding agents)

Instructions for coding agents, Codex and others, working in this repository. A coordinator hands you a task, reviews your branch, merges it, runs the full checks, deploys and reports to the maintainer. You build the task on your branch, prove it works, and hand back.

## How to work
- Repo skills in `.agents/skills/`: `obpal-develop` for lane workflow, `obpal-evidence` for captures and timing, `obpal-models` for Blender assets, and `obpal-review` for self-review. Coordinator commands are in `docs/LANES.md`.
- The task brief is authorised work. Carry it through to completion without stopping for questions that don't block you: make sensible calls and list them in the hand-back. Ask only when you're truly blocked.
- Match the surrounding code: comment density and style (plain, precise English doc comments), naming and idiom. TypeScript, three.js and Vite; no new frameworks.
- Stay inside the task's files. If you need something outside them, say so in the hand-back.
- Test what your change touches, not everything: the suites the brief names, plus any your change could break.
- Write hand-backs and commit messages in plain sentences.

## Commands
- Install when dependencies are absent or the lockfile moved: `pnpm install --frozen-lockfile --store-dir "$TEMP/pnpm-store-obpal"` (PowerShell: `"$env:TEMP/pnpm-store-obpal"`).
- Check: `pnpm run check` (the typecheck of all four configs, then vitest).
- e2e: `OBPAL_E2E_PORT=<stand-in> OBPAL_E2E_WORKER_PORT=<worker> pnpm run e2e:all -- <suites>`. The suites are code, embed, home, phone, sims, shared, extension, catalogue and pages. In PowerShell, set `$env:OBPAL_E2E_PORT` and `$env:OBPAL_E2E_WORKER_PORT` first.
- Playwright: when its pinned browser build isn't installed, set `OBPAL_E2E_CHROMIUM` to an installed Chromium; the brief gives the path.

## Rules
- **Commits:** plain `git commit` on your branch. The checkout's git config carries the maintainer's identity; never change git config.
- **Never:** push, deploy, release, tag, publish or run `scripts/sync-family.mjs`. Those are the coordinator's.
- **Git stash** is shared by every worktree. Set work aside with a WIP commit, never with `git stash`.
- **Ports:** only the two your brief gives you, the e2e stand-in and the local worker. Never bind 5175, 5176, 3000–3003, 5173–5174 or 8080. Check a port is free before starting anything on it, and stop every server you start.
- **Browsers:** use Playwright's Chromium. Never run a browser with `--version`, and never launch or touch the maintainer's own Chrome.
- **ob.Pal Desktop:** never reach the installed helper, and never run the Link e2e with `--desktop`. Anything that loads Link uses a copy without the manifest `key` and with the guarded host rename (see extension/scripts/e2e.mjs). The e2e runner's guard line must say "no new sessions".
- **Windows:** read the registry from PowerShell only, and never change it. Never install the helper, and never run its `--include-ignored` tests: they drive the real mouse and keyboard.
- **Secrets and privacy:** never read, copy or print anything in `~/.obpal-keys`. Every tracked file goes into the public open-source snapshot, so keep keys, tokens, account ids, local paths, personal names and emails out of files and commits.
- **Assets:** only what we make ourselves, or third-party material under a licence that allows it (CC0, MIT, OFL and the like), credited in `src/support/open-source.json`.
- **Evidence:** screenshots, captures, measurements and logs go in `artifacts/`, which git ignores. Never commit them, and never make a test write into the repository; tests write to a temporary folder.
- **Scope:** never delete recursively outside your worktree.

## Before you hand back
1. `git merge master` **once**, right before your final validation, resolve any conflicts, and run the checks. If master moves after that, don't merge it again unless your branch conflicts with it: hand back, and say which master you validated against. The coordinator's merge reruns typecheck, vitest and the suites your change touches.
2. `pnpm run check`, then the e2e suites your change touches.
3. Commit everything. Leave no uncommitted work and no running servers.

## Hand-back (your final message)
Branch and head sha (with the master sha merged), commits (sha and subject), a test table (typecheck, vitest n/n, each e2e suite n/n, the guard line), what changed (areas and key files), where the before-and-after evidence is, numbered decisions for the maintainer (or "none"), and anything left or risky, one line each. About 500 words at most.
