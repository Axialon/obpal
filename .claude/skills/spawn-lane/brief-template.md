# Coordination brief template

The brief lives in the session scratchpad (never in the repo). It's what a compacted coordinator reads first. Update it after every step: spawn, interim, merge, deploy, release.

```
# Coordinated dev: <topic> (<date>)

The owner's asks (verbatim):
- "<quote>"

Repo: <main checkout>, master at <sha> when the lanes started. Lanes are obpal-lane agents in their own worktrees. The coordinator merges (scripts/merge-lane.mjs), runs e2e (pnpm run e2e:all), deploys and releases.

## Lanes (agent ids are internal; never show them to the owner)
- <letter> <scope>: <agent id>, ports <stand-in>/<worker>, from <sha>. Status: running | interim: … | DONE (branch <name>) | MERGED <sha> (vitest n/n, e2e …)

## Contracts
- <an interface between lanes, who owns which file>

## Merge plan
1. <order, and why (who depends on whom)>
2. Checks: pnpm run e2e:all (all suites before a deploy); guard: no new sessions.
3. Deploy: pnpm run deploy, then pnpm run check:live.

## Status (coordinator)
- <time> <what happened>: <sha / version id / numbers>. Next: <step>.

## Owner decisions pending
- <question>: <options, and a recommendation>
```
