# Claude Code in this repo

Tools for developing ob.Pal with parallel Claude Code agents. A coordinator session hands tasks to worktree lanes, then merges, tests, deploys and releases. Everything here is generic and public. Machine-specific and private settings stay local (see [Local only](#local-only)).

## Scripts
| command | use it when |
|---|---|
| `pnpm run e2e:all [-- <suites>]` | You run any e2e suite. It waits for the suite's ports and gives every suite a fresh local worker (production only with `OBPAL_E2E_UPSTREAM`). It finds the full Chromium, stops the run if a test browser reaches the installed ob.Pal Desktop, and prints one table. |
| `pnpm run check` | You want typecheck and vitest together, for example after resolving a merge. |
| `node scripts/merge-lane.mjs <branch> [-m …] [--dry-run]` | You merge a lane (coordinator, main checkout only). It reviews, scans for secrets and private data, merges with `--no-ff` under the repo's identity, then installs, typechecks and runs vitest. It never pushes. |
| `pnpm run check:live [-- --origin …] [--only …]` | You've deployed. It checks every page at two widths, the pairing code, the /api/code rules, the TURN relay, the security headers and security.txt, and that /link/ shows the release it downloads, read only. |

## Agents, skills and hooks
| file | use it when |
|---|---|
| `agents/obpal-lane.md` | You spawn a lane (`subagent_type: "obpal-lane"`). It knows the rules, e2e, commits, merging master and a ≤400-word hand-back, so the prompt only needs the task and ports. |
| `skills/spawn-lane` | You start or resume a lane: ports, the prompt template, the coordination brief. |
| `skills/merge-lane` | A lane hands back: merge-lane.mjs, its exit codes, scan findings, e2e. |
| `skills/deploy-and-verify` | You deploy: `pnpm run deploy`, then `pnpm run check:live`. |
| `skills/release` | You release Link, Desktop, the GitHub release or the open-source snapshot. |
| `hooks/guard.mjs` | Always on (settings.json, PreToolUse on Bash, PowerShell and Monitor). It only denies, and each deny gives its reason. |

What the guard denies:
- **For everyone:**
  - a browser started with `--version`;
  - the Link e2e with `--desktop`;
  - `reg` from Git Bash, and any registry change;
  - reading or copying `~/.obpal-keys`;
  - `cargo test --ignored`;
  - installing ob.Pal Desktop;
  - wrangler naming the apex domains or the boxem project.
- **For lanes** (a command in or naming `.claude/worktrees/`, or the obpal-lane agent):
  - `git push` and gh writes;
  - `wrangler deploy` and other remote writes, `pnpm run deploy`, publishing;
  - `sync-family.mjs`.

Its tests are in tests/guard.test.ts.

## Local only
These never get committed. They're gitignored, and scripts/open-source.mjs skips them too:
- `.claude/settings.local.json`: personal settings, for example `env` with `OBPAL_E2E_CHROMIUM`.
- `.claude/local/`
- `.claude/skills/local-*/` and `.claude/agents/local-*.md`: private skills and agents.
- `CLAUDE.local.md`
- `.open-source-deny`: the private words the export and the merge scan refuse.

The commit identity for this repo's history is set once in the checkout (`git config user.name` / `user.email`) and shared by every worktree. The public snapshot's identity lives in scripts/open-source.mjs.
