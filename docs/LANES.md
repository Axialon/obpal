# Codex lanes and shipping

Run the coordinator commands from the checkout whose ledger you want to use. Paths are resolved without changing the caller's working directory. The coordinator normally uses the main checkout. Each checkout owns ignored `.claude/local/lanes.json`, round files and `lanes.md`; do not mix ledgers or manually share allocations between checkouts. Busy ports are always probed.

On first run the CLI creates `.claude/local/lanes.config.json` from the environment and prints its location. Configure `chromiumPath`, `blenderPath`, `extraWritableDirs` (an array), and `scratchDir`. `OBPAL_E2E_CHROMIUM`, `BLENDER` and `OBPAL_LANES_SCRATCH` override those settings. `OBPAL_CODEX_BIN` can select a native Codex executable. Paths belong only in this ignored config or the environment. `--blender` requires a configured Blender path.

```text
pnpm run lane -- start feature --prompt .claude/local/feature.md
pnpm run lane -- start models --prompt .claude/local/models.md --blender --effort xhigh
pnpm run lane -- resume feature --prompt .claude/local/feature-follow-up.md
pnpm run lane -- status [name] [--json]
pnpm run lane -- wait feature --timeout 60
pnpm run lane -- stop feature --dry-run
pnpm run lane -- stop feature
pnpm run lane -- cleanup feature
pnpm run lane -- ports
pnpm run lane -- brief
pnpm run ship
```

Start accepts `--model` (default `gpt-6.1-sol`), `--effort` (default `high`), `--base` (default `master`), `--ports auto|<stand-in>/<worker>` and repeatable `--extra-dir`. Resume accepts `--model` and `--effort`; otherwise it retains the lane settings. Prompt files should name outcomes, file ownership, dependencies, checks and evidence. The CLI prepends worktree, branch, ports and the store-dir install command. Start creates `.claude/worktrees/codex-<name>` and `codex/<name>`; resume retains the recorded thread, sandbox roots and environment, with separate `r2`, `r3` round files.

Stand-ins use 5177–5188 and workers use 5190–5199. The allocator excludes recorded allocations and busy loopback ports. Reserved: 5173–5176, 5189, 3000–3003 and 8080. An allocation remains held until cleanup. Availability is a point-in-time check; another application can bind later. Concurrent commands sharing the ledger serialize allocations.

Status shows running, final, failed, stalled or stopped. A live process without events for 20 minutes is stalled (`OBPAL_LANE_STALL_MINUTES` overrides this); a dead process without final is also stalled. A `turn.failed` or non-zero process exit is failed. Wait prints the outcome and available final text; it exits non-zero on failure, stall, stop or timeout. Timeout leaves the lane running. Inspect errors and stop a live stalled round before intentionally resuming. Windows status/stop require CIM process-query access and fail closed if unavailable.

Stop matches a native Codex `exec` process with an exact worktree or thread argument. It refuses `app-server`, another lane identity, and protected descendants; it rechecks the tree before killing. Cleanup refuses live lanes and unmerged branches unless `--force` deliberately discards the branch. It only removes a direct lane under `.claude/worktrees`, unlinks junctions without following them and supports long Windows paths. Registered nested worktrees must be cleaned individually first. Completed cleanup prunes the worktree record, deletes the branch and releases ports; the ledger retains history. Lane names are not reused.

Review the diff and evidence, merge through `pnpm run merge:lane`, then clean up. `brief` regenerates a Markdown table for the coordination brief to reference. The generated round prompts/logs and ledger can contain machine paths and must remain ignored.

Ship is coordinator-only. It requires the main checkout on clean master, then runs deploy, check:live and the open-source publish in order. It prints the Worker version, live summary and public mirror main commit from `git ls-remote`, and appends `.claude/local/ships.log`. It stops at the first failing step without rollback. If deploy succeeded but a later step failed, inspect and repair that step before an intentional retry. Lane agents must never invoke ship.

Codex CLI 0.159.1 was checked with `exec --help` and `exec resume --help`. Resume lacks `-s`, `--add-dir` and `-p`; the CLI supplies sandbox config overrides instead. Repo skills use YAML `name`/`description` in `.agents/skills/<name>/SKILL.md`. Codex discovers `.agents/skills` from the working directory up to the repository root, as documented in [OpenAI's skills guide](https://developers.openai.com/codex/skills). No user-global skill installation is needed.
