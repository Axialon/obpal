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

5. Review the committed diff and evidence. Use the existing [merge-lane skill](../merge-lane/SKILL.md) to merge into the main checkout, then run coordinator checks. `cleanup <name>` requires the branch to be merged into master. `--force` discards an intentionally abandoned lane; never merge a throwaway smoke lane.

The coordinator owns deployment and publication. A lane's final message is evidence to review, not permission to ship.
