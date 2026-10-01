# Codex lanes and shipping

Run the coordinator commands from the checkout whose ledger you want to use. Paths are resolved without changing the caller's working directory. The coordinator normally uses the main checkout. Each checkout owns ignored `.claude/local/lanes.json`, round files and `lanes.md`; do not mix ledgers or manually share allocations between checkouts. Busy ports are always probed.

On first run the CLI creates `.claude/local/lanes.config.json` from the environment and prints its location. Configure `chromiumPath`, `blenderPath`, `extraWritableDirs` (an array), and `scratchDir`. `OBPAL_E2E_CHROMIUM`, `BLENDER` and `OBPAL_LANES_SCRATCH` override those settings. `OBPAL_CODEX_BIN` can select a native Codex executable. Paths belong only in this ignored config or the environment. `--blender` requires a configured Blender path. `--search` gives a research lane Codex's live web search (it runs on the model's side; the sandboxed shell still has no network).

```text
pnpm run lane -- start feature --prompt .claude/local/feature.md
pnpm run lane -- start models --prompt .claude/local/models.md --blender --effort xhigh
pnpm run lane -- start research --prompt .claude/local/research.md --search
pnpm run lane -- resume feature --prompt .claude/local/feature-follow-up.md
pnpm run lane -- status [name] [--json]
pnpm run lane -- digest feature
pnpm run triage -- <e2e log dir>
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

### Compact coordinator review

Use `digest <name>` after a final hand-back, before opening full logs. It reads only the latest round's expected final, event tail and err filenames from the ledger directory and prints compact JSON (at most 1,200 characters): state, head, merged master, numeric tests including skips, failure causes, decisions, evidence, risks and a conservative review verdict. `ready-to-merge` reflects reported evidence and still requires diff/evidence review. Missing identity, guard, checks, a dirty tree or current check failures requires review. The final test table determines the verdict after a documented successful rerun; retained history and stated risks remain available for review. Codex runtime diagnostics are removed before extraction and model input. Input space goes to identity, checks, decisions, risks and evidence before explanatory prose. If essential facts are cut, the verdict is downgraded and the output says to inspect originals. `OBPAL_DIGEST_LOCAL` can select another checkout's ignored ledger directory for read-only review; it does not affect other lane commands or write that ledger.

Use `pnpm run triage -- <e2e log dir>` when validation fails. It reads recognized suite logs directly in that folder, without recursion or helper logs. The JSON retains each exact failing line (except necessary secret redaction), category, cause and a PowerShell isolated rerun recommendation. Keep the original assigned `OBPAL_E2E_PORT`, `OBPAL_E2E_WORKER_PORT` and Playwright `OBPAL_E2E_CHROMIUM`; the recommendation clears old selectors, then uses `OBPAL_E2E_SIMS_ONLY` for a recognized group and `OBPAL_E2E_PAGES_ONLY=try` for Try checks. Unknown groups require suite review. Only the recorded arm re-anchor flake in `docs/HUMANOID.md`, with a timeout/wait and explicit load context, is a timing-flake candidate; unfamiliar waits remain unknown. Value assertions are regressions; ports, missing browsers and worker startup are harness/environment failures. Add known flaky names only with retained evidence.

Triage never marks a check passing and never executes its recommendation. One isolated rerun must actually pass; retain the original failure and rerun. A second failure needs investigation. Both tools use `gpt-6-luna` via `codex exec -s read-only`, a strict JSON schema and a 30-second timeout. All classifier content is inline, with shell, browser, image, app, plugin and MCP controls disabled. A tool event alone does not reject a successful schema-valid, grounded answer. Invalid, unavailable or ungrounded model output falls back to an extractive summary. `model`, `tokens` (or null), `mode` and an optional fallback `note` make that visible. No new API key is needed beyond existing Codex authentication. Secret paths and links are excluded, secret-bearing lines redacted, and runtime diagnostics filtered from check logs. Inference sends sanitized text to the Codex provider; review sensitive logs first. These summaries reduce coordinator reading, not the required checks.

Auto-review recommendation only: consider an owner-approved scoped trial for eligible escalations, keeping independent lane deny rules, narrow writable roots, assigned ports, Playwright Chromium, guarded Link copies and the **no new sessions** guard. It changes the reviewer, not sandbox permissions, and cannot guarantee builds/e2e/Blender without escalation. Keep no push/deploy/release/tag/publish/family sync, installed-helper access, registry changes or owner's Chrome. Nothing in this pilot enables auto-review. See [the dated research and limits](DECISION-MODELS.md).

Ship is coordinator-only. It requires the main checkout on clean master, then runs deploy, check:live and the open-source publish in order. It prints the Worker version, live summary and public mirror main commit from `git ls-remote`, and appends `.claude/local/ships.log`. It stops at the first failing step without rollback. If deploy succeeded but a later step failed, inspect and repair that step before an intentional retry. Lane agents must never invoke ship.

Codex CLI 0.159.1 was checked with `exec --help` and `exec resume --help`. Resume lacks `-s`, `--add-dir` and `-p`; the CLI supplies sandbox config overrides instead. Repo skills use YAML `name`/`description` in `.agents/skills/<name>/SKILL.md`. Codex discovers `.agents/skills` from the working directory up to the repository root, as documented in [OpenAI's skills guide](https://developers.openai.com/codex/skills). No user-global skill installation is needed.

## Backup and cleanup

Run maintenance from the main checkout. Machine settings belong in ignored `.claude/local/maintenance.config.json`: `backupRoot` (default on the D drive in the ObPal-Backups folder), `backupRepository` (the owner-approved private GitHub repository, owner/repository), `tempRoot`, `freeSpaceRoot`, and `ensureFreeGb` (150). Environment overrides are `OBPAL_BACKUP_ROOT`, `OBPAL_BACKUP_REPOSITORY`, `OBPAL_TEMP_ROOT`, `OBPAL_FREE_SPACE_ROOT`, and `OBPAL_ENSURE_FREE_GB`. `OBPAL_MAINTENANCE_ROOT` explicitly selects the main checkout when proving a lane's scripts before integration. Never configure another destination for development history; public snapshots still go through `open-source.mjs`.

| Command | Result |
| --- | --- |
| `pnpm run backup -- --dry-run` | Check destination, private remote, tracked history and local filenames; list retention candidates without writing or pushing. |
| `pnpm run backup -- --label manual` | Push all branches and tags to the configured private backup remote, verify remote master, bundle all refs and copy local state. |
| `pnpm run backup -- --no-push --keep --label checkpoint` | Offline bundle and local state, with permanent retention. |
| `pnpm run backup -- --self-test` | Synthetic bundle to clone to same HEAD round trip; remove the fixture afterwards. |
| `pnpm run reap -- --dry-run` | List candidates and sizes; append the selection to ignored `reap.log`. |
| `pnpm run reap -- --hours 12 --ensure-free-gb 150 --keep codex-example` | Reclaim eligible lanes and stale temp directories; preserve running lanes, named keeps and branches. |

Backup refuses missing/mismatched private remotes with exit 2 (including separate push URLs), secret filenames anywhere in reachable tracked history, blobs over 90 MB, same-drive destinations and links in local state. Local files held open or changing during the copy are skipped and named in the manifest. Every saved file is SHA-256 verified; `manifest.json` records verification, skips and retention. The manifest is the index and does not hash itself. Layout uses UTC dates and minutes; repeating the same label within a minute refuses an overwrite. Retention keeps the last seven days, then one newest backup in each of eight rolling seven-day bands, anchored at seven days ago. Only verified backups are pruned, after their digests are checked again; `--keep` also suppresses pruning during that run.

Reap selects direct agent-, astra- and codex- worktrees merged into master, or final lanes explicitly marked merged in the ledger. Running lanes and nested registered worktrees are protected. Dirty recoveries contain `status.txt`, a binary `tracked.diff` against HEAD (staged and unstaged edits), nonignored untracked files and a verified manifest under the backup root's `worktree-reap` directory. Link destinations are recorded as text, never copied. Rebuildable ignored output is discarded. Removal unlinks junctions and uses Windows namespaced paths. Held files skip the whole tree; the ledger lock serializes real removal with lane allocation. Exit 3 means the free-space floor is still unmet; the summary lists the largest remaining items in the managed worktree/temp scopes.

Temporary test state is removed in finally blocks, with an exit fallback for explicit exits. `--keep-logs` or `OBPAL_KEEP_TEMP=1` retains it for investigation. Evidence paths supplied by callers are preserved. The e2e-all log directory, smoothness report and Astra verification result ZIP are deliberately retained; the reaper's age rule is their backstop. A hard-killed process can leave temp state, so review reaping regularly. `lane cleanup` retains branches and suggests reap; merge-lane does likewise. Ship performs backup only after successful publication and reports backup failure separately from the already-completed publication.

### Durable lane evidence

Every `removeLaneTree` caller, including `lane cleanup` and `reap`, archives nonempty `artifacts/` before removing a lane. Set `runsRoot` in ignored maintenance settings or `OBPAL_RUNS_ROOT`; the default is the D drive's ObPal-Runs folder. It must be on another drive from the worktree. Archives are `<runsRoot>/<lane-name>/<UTC yyyy-MM-dd-HHmm>/artifacts/`, with a SHA-256 manifest whose copies and source bytes are verified before removal. The command prints the archive location. Give the owner links into that D: archive, so evidence remains reachable after cleanup. Same-minute archive collisions refuse overwrite; incomplete archives remain for inspection. No evidence recovery can reconstruct clips already deleted in earlier cleanups.

A failed copy, changed source, held file or junction refuses removal. `--force` still preserves evidence. Only explicit `pnpm run lane -- cleanup <name> --discard-artifacts` or `pnpm run reap -- --discard-artifacts` skips the archive. Empty artifact directories need no archive drive. Reap retention keeps evidence for 60 days, and keeps any archive with a `keep` marker permanently; it prunes only verified manifests with matching hashes. Reap dry-run lists retention candidates without deleting them.

Ignored maintenance settings also accept `keep: ["codex-example"]`, combined with every `--keep` value. Preserve paused lanes there until the coordinator releases them. The historical TLS exception in backup matches only two documented path/blob pairs; any replacement blob still refuses. No production or newly generated key is exempt.

### Astra exchange housekeeping

`pnpm run astra:tidy -- --dry-run` previews the moves. `pnpm run astra:tidy` applies them idempotently; `--outbox <dir>` selects a different exchange root. The tools write short README files in outbox and its sibling inbox. Exchange files are only moved, never deleted or overwritten; a name collision receives a preserved suffix.

Packing a request first moves earlier-stage loose uploads to `outbox/sent/<stage>/`. A same-stage replacement goes to `outbox/archive/superseded/<stage>/`; dry-run exchanges go to `outbox/archive/dry-run/<stage>/`. Only the latest current Request ZIP/prompt, current verification Return ZIP/prompt, and `UPLOAD-THIS-<stage>.prompt.txt` remain loose. Other notes are retained under `archive/superseded/unclassified/`.

Intake moves its input stage ZIP to `inbox/processed/<stage>/` on success, or `inbox/refused/<stage>/` on refusal; the refusal Return and prompt go to `outbox/sent/<stage>/`. It searches trusted requests by archive digest in both the top-level outbox and recursively under sent. Unprocessed inbox uploads remain loose. Tidy can repair interrupted moves when a local intake receipt or refusal Return matches the exact received ZIP digest. Unknown or malformed uploads remain available for explicit intake.
