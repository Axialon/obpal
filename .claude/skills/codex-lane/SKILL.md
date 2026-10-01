---
name: codex-lane
description: Coordinate an ob.Pal Codex development lane with the lane CLI, from a scoped prompt through status, review, merge and cleanup. Use for background Codex tasks and follow-up rounds.
---

# Codex lanes

Use `pnpm run lane --` from the coordinator checkout. See [docs/LANES.md](../../../docs/LANES.md) for the command reference and local settings. The CLI creates the worktree, assigns free ports, adds the standard prompt header, launches detached and records rounds. Do not build detached shell commands or edit the ledger manually.

Default to `gpt-6.1-sol` with `high`; use `xhigh` for difficult reasoning, motion, geometry or intertwined safety contracts. Preserve an owner's requested model. In usage-conservation mode Codex lanes are the default; choose a Claude lane only when the task needs Claude-specific tools or the owner requests it.

Write a prompt file in ignored local storage. Include the owner's words, the observable outcome, owned files, excluded files, dependencies/contracts, acceptance checks and required evidence. Reuse [the prompt template](../spawn-lane/prompt-template.md), omitting its manual port header. Do not put credentials in prompts.

1. `pnpm run lane -- start <name> --prompt <file> [--effort xhigh] [--blender] [--search]`. Use `--search` for research lanes that need the web. Machine paths belong in environment variables or `.claude/local/lanes.config.json`.
2. Use `status` and one background `wait <name> --timeout <minutes>` per lane. Wait exits on final, failure, stall or a dead process. A capacity failure is a failed turn; read the error and intentionally resume later. A timed-out waiter leaves the lane running.
3. `resume <name> --prompt <follow-up-file>` retains the thread and writes a new round. Tell the lane which master changes to merge. Stop a live or stalled lane before resuming. Use `stop --dry-run` when investigating a hung process; the CLI refuses the desktop app and other lane identities.
4. `brief` regenerates `.claude/local/lanes.md`. Reference it from the coordination brief; maintain task scope and merge order in prose separately.
Pacing: keep at most three heavy lanes (full e2e, Blender or long captures) in final validation at once, and don't tell a lane to chase master. Lanes merge master once before final validation; your merge reruns the checks. If a lane's turn fails near the end with a complete, committed branch, integrate it yourself: kill only its orphaned test tree (its worktree path or ports in the command line), merge it, and run the touched suites on master.

5. Use `pnpm run lane -- digest <name>` to read a compact final hand-back before full logs. Its verdict reflects reported checks; review the committed diff and evidence before merging. A truncated digest, missing identity/guard/checks or failure history requires the original files. The JSON records model/tokens and shows extractive fallback when Luna is unavailable or invalid. Use the existing [merge-lane skill](../merge-lane/SKILL.md) to merge into the main checkout, then run coordinator checks. `cleanup <name>` requires the branch to be merged into master. `--force` discards an intentionally abandoned lane; never merge a throwaway smoke lane.

On failed e2e, use `pnpm run triage -- <e2e log dir>` for exact failure lines and isolated PowerShell rerun recommendations. Preserve the assigned ports and Playwright browser. Commands clear stale selectors and use `OBPAL_E2E_SIMS_ONLY`/`OBPAL_E2E_PAGES_ONLY` where the group is recognized. Only a known flaky name plus a wait/timeout under explicit load is a flake candidate; unknown waits need review. **Triage never marks anything passing.** Retain the initial failure and one actual isolated rerun; a second failure needs investigation. Both tools read bounded allowlisted logs, reject secret paths/links, redact secret lines and fall back extractively. Sanitized prompts go to the Codex provider; review sensitive logs first.

Recommendation only: the owner may consider a scoped auto-review trial for eligible escalations after preserving the reviewer policy and adding lane prohibitions. Keep independent deny rules, narrow roots, assigned ports, guarded Link and the **no new sessions** guard. Auto-review does not widen the sandbox or guarantee build/e2e/Blender success. Lane push/deploy/release/tag/publish/family sync, installed-helper access, registry changes and the owner's Chrome remain prohibited. Do not enable auto-review as part of this pilot. See [DECISION-MODELS.md](../../../docs/DECISION-MODELS.md) for dated sources and unverified model details.

The coordinator owns deployment and publication. A lane's final message is evidence to review, not permission to ship.

Maintenance: `pnpm run ship` takes a verified backup after publication. Configure the private backup repository in ignored `.claude/local/maintenance.config.json`; development history must never go to the public snapshot remote. Review `pnpm run reap -- --dry-run` before reclaiming merged lanes and old temp folders. Reap preserves branches and archives dirty changes off drive before removal. Lane start warns below the configured free-space floor. See [docs/LANES.md](../../../docs/LANES.md) for commands.

Before cleanup, preserve the owner's evidence through the verified archive built into `removeLaneTree`. Evidence links given to the owner must point into the printed D: archive (`runsRoot`, default ObPal-Runs), rather than the disposable worktree. `--force` keeps artifacts; `--discard-artifacts` is the explicit opt-out. A copy or hash failure blocks removal. Archives remain for 60 days or indefinitely with a `keep` marker. Keep paused lanes in the ignored maintenance `keep` array until released.
