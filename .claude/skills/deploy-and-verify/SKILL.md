---
name: deploy-and-verify
description: Deploy ob.Pal to production, then verify the live site in one command. The check covers pages at two widths, the Viewer's pairing code, the /api/code rules, the TURN relay, the security headers and security.txt, and that /link/ shows the release it downloads, using pnpm run deploy and pnpm run check:live. Use when merged work is green and the plan calls for a deploy, or to re-check the live site.
---

# Deploy and verify

**Before you deploy:**
- Work in the main checkout, on master, with a clean tree and everything planned merged.
- `pnpm run e2e:all` passes every suite, and its guard line says "no new sessions".
- A Durable Object migration or new secrets in the change: confirm the owner has set the secrets.

1. **Deploy:** `pnpm run deploy`. It runs vitest, builds and runs `wrangler deploy`. Note the version id it prints.
2. **Verify:** `pnpm run check:live` (about 1.5 min, read only, prints no credentials). It exits 1 on any FAIL. A WARN, such as security.txt expiring within 30 days, doesn't fail it.
   - Rerun one part with `-- --only pages|api|turn|headers|release`.
   - Check another deployment with `-- --origin https://…`.
3. **Record** in the brief: the deployed sha, the version id and check:live's last line. Tell the owner what to test on real devices.

**If a check fails:**
- A page error or a missing header is a bug to fix forward.
- If the deploy broke the site, rolling back (`npx wrangler rollback`) is the coordinator's call. Tell the owner what and why.

Never touch the apex domains or other projects on the account. The guard blocks wrangler commands that name them.
