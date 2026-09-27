---
name: merge-lane
description: Merge a finished ob.Pal lane into master. Covers review, the secret and privacy scan, the no-ff merge with the repo's identity and trailer, install, typecheck, vitest and then e2e, using scripts/merge-lane.mjs and scripts/e2e-all.mjs. Use when a lane hands back or a lane branch is ready to merge.
---

# Merge a lane

Work in the main checkout, on master, with a clean tree. Never merge from a worktree: the script refuses.

1. **Preview:** `node scripts/merge-lane.mjs <branch> --dry-run`. You get one table with the commits, the stat, whether the branch is behind master, public-identity commits, and the scan.
2. **Merge:** `node scripts/merge-lane.mjs <branch> -m "Merge <lane>: <what it brings>"`. It merges with `--no-ff` using the repo's identity and the lane's Co-Authored-By trailer. It runs `pnpm install --frozen-lockfile` if the lockfile moved, then typecheck and vitest. It never pushes or deploys.

   | exit | meaning | next |
   |---|---|---|
   | 0 | merged and green | step 3 |
   | 1 | typecheck or vitest failed after the merge | the merge stays: fix forward, or tell the lane |
   | 2 | refused: dirty tree, scan finding, identity, not the main checkout | read the reason |
   | 3 | conflicts, merge left in progress | resolve, `git add`, `git commit --no-edit`, `pnpm run check` |

   **Scan findings are masked.**
   - A test's made-up credential: read the line, then rerun with `--allow <path>:<line>`.
   - A real secret: the lane removes it and rewrites its commits. Never merge it.
   - Local paths, personal emails and .open-source-deny words would break the next snapshot, so the lane fixes those too.
   - Identity refused: set it once in this checkout with `git config user.name …` and `git config user.email …`.
3. **e2e:** run `pnpm run e2e:all -- <suites the lane touched>`, or every suite (no names) before a deploy. Exit 3 means a test browser reached the installed ob.Pal Desktop. Stop everything and find out how before running anything else.
4. **Record** in the brief the merged sha, vitest n/n and the e2e table line. Tell running lanes that depend on it that master moved (see spawn-lane).
5. **Clean up** only when the lane is finished: `git worktree remove .claude/worktrees/<name>`, and only for lanes this session created.
