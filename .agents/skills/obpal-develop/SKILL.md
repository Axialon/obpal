---
name: obpal-develop
description: Build and hand back an authorized ob.Pal development task in a lane worktree, with assigned ports, scoped checks and coordinator-ready evidence.
---

# Develop in a lane

Read root `AGENTS.md` for safety and authority. Work within the brief's files and contracts. The coordinator reviews, merges and ships; the lane never pushes, deploys, publishes or runs `scripts/sync-family.mjs`.

Install when dependencies are absent or the lockfile moved: `pnpm install --frozen-lockfile --store-dir "$TEMP/pnpm-store-obpal"`. In PowerShell use `"$env:TEMP/pnpm-store-obpal"`. Do not change the lockfile to make installation work.

Use only the assigned stand-in and worker ports. Check availability before starting servers; stop every server you start. Run browser suites through `pnpm run e2e:all -- <suites>`, with `OBPAL_E2E_PORT`, `OBPAL_E2E_WORKER_PORT` and the brief's `OBPAL_E2E_CHROMIUM` set. In PowerShell set `$env:OBPAL_E2E_PORT` and `$env:OBPAL_E2E_WORKER_PORT` first. Suites: code, embed, home, phone, sims, shared, extension, catalogue, pages. The runner's helper guard must report **no new sessions**.

Run only suites touched by the change and the brief. A suspected flake gets one isolated rerun of the failing suite with the same environment; retain both results. A second failure needs investigation, not repeated retries. Use Playwright's Chromium; never use the owner's Chrome, `--desktop`, or helper tests with `--include-ignored`.

Keep captures and logs under ignored `artifacts/<task>/before/` and `after/`; tests write fixtures to temporary folders. Load `obpal-evidence` for visual or timing proof, `obpal-models` for authored geometry and `obpal-review` before hand-back.

Before handing back: `git merge master` once, right before final validation; resolve conflicts, install if the lockfile moved, run `pnpm run check` and the scoped e2e suites, then commit everything with plain `git commit`. Don't chase a moving master: if it advances during or after your final validation, re-merge only when your branch conflicts with it. Otherwise hand back with the master sha you validated against; the coordinator's merge reruns the checks. A full-suite rerun per master move once cost a lane hours. Preserve checkout identity and use WIP commits instead of shared stash. Leave a clean tree and no running servers.

Hand back in at most 500 words: branch/head and merged master sha; commit shas/subjects; a test table with typecheck, vitest passed/total and skips, each e2e suite passed/total and guard line; changed areas/key files; before/after evidence paths; numbered maintainer decisions or none; remaining work and risks, one line each. Distinguish measured results from unverified device claims.
