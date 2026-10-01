---
name: deploy-and-verify
description: Ship ob.Pal from clean master in the main checkout with pnpm run ship, deploying, checking the live site and publishing the open-source snapshot. Use when merged work is green and deployment is authorized, or to re-check the live site.
---

# Deploy and verify

**Before you deploy:**
- Work in the main checkout, on master, with a clean tree and everything planned merged.
- `pnpm run e2e:all` passes every suite, and its guard line says "no new sessions".
- A Durable Object migration or new secrets in the change: confirm the owner has set the secrets.

1. **Ship:** `pnpm run ship`. It refuses worktrees, non-master branches and dirty trees. It runs deploy, check:live and the open-source publish in order, stopping on the first failure. Deploy runs vitest and build, carries the retained assets, deploys the Worker and submits sitemap URLs to IndexNow. Ship prints the Worker version, live result and public mirror commit, and appends `.claude/local/ships.log`.
2. **Re-check only:** `pnpm run check:live` (about 1.5 min, read only, prints no credentials). It exits 1 on any FAIL. A WARN, such as security.txt expiring within 30 days, doesn't fail it.
   - Rerun one part with `-- --only pages|api|turn|headers|release`.
   - Check another deployment with `-- --origin https://…`.
3. **Record** in the brief: the deployed sha, the version id, check:live's last line and the published commit from ship. Tell the owner what to test on real devices. If ship fails after deploy, inspect the reported step and repair it before intentionally retrying; do not assume the release completed.

**If a check fails:**
- A page error or a missing header is a bug to fix forward.
- If the deploy broke the site, rolling back (`npx wrangler rollback`) is the coordinator's call. Tell the owner what and why.

Never touch the apex domains or other projects on the account. The guard blocks wrangler commands that name them.

Maintenance: `pnpm run ship` takes a verified backup after publication. Configure the private backup repository in ignored `.claude/local/maintenance.config.json`; development history must never go to the public snapshot remote. Review `pnpm run reap -- --dry-run` before reclaiming merged lanes and old temp folders. Reap preserves branches and archives dirty changes off drive before removal. Lane start warns below the configured free-space floor. See [docs/LANES.md](../../../docs/LANES.md) for commands.
