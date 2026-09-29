---
name: release
description: Release ob.Pal Link and ob.Pal Desktop. Covers version bumps, the extension zips, the Chrome Web Store package and first-upload zip, the Desktop helper zip, the public obpal-link repo and its GitHub release, the open-source snapshot of this repo, and the @obpal/core and @obpal/host npm packages (publish:npm: a dry run, then --yes, the owner approves npm's link). Use when the plan calls for a Link or Desktop release, an npm release or an OSS snapshot.
---

# Release

**Order:**
1. Merged and green, including `pnpm run e2e:all -- extension`.
2. Versions.
3. Packages.
4. The public obpal-link repo and its GitHub release.
5. The site.
6. The snapshot.

Commands, checks and gotchas for each step are in [reference.md](reference.md). Read it before the first step. When `@obpal/core` or `@obpal/host` changed, the npm packages are released too: see the last section.

**Rules:**
- Commits to the public repos use the global Axialon identity. This repo's history uses its own identity, never that one.
- The extension's private key never leaves `~/.obpal-keys`. `store.mjs --with-key` reads it there and writes the first-upload zip beside it. Never copy, print or attach either; the guard blocks commands that read that folder.
- Release notes: plain words, what changed for the person using it, and what they must do to update.
- Afterwards, update PLAN.md's done list, the brief, and the owner's handoff (what to test, store steps).

## npm packages: @obpal/core and @obpal/host

From the main checkout, on master, everything committed. Bump each package's `version` in packages/<name>/package.json and add its entry to packages/<name>/CHANGELOG.md first (a test fails if the newest entry isn't the version). Then:
1. **Dry run:** `pnpm run publish:npm`. It reads the registry, builds, typechecks, runs the vitest files that test the packages, packs both tarballs and looks inside them (only package.json, README, LICENSE, CHANGELOG and dist; no source map with a local path; the secret and private-word scan), rehearses an install in a temp folder, and prints the plan. Each package is `PUBLISH`, `SKIP` (that version is on npm with the same files) or `REFUSE` (that version is on npm with other files, which is a forgotten bump; or older than the latest). Fix a refusal, commit, run it again.
2. **Publish:** `pnpm run publish:npm -- --yes`. It refuses unless this is the main checkout, on master, with a clean tree. Core goes first, then host: each inspected `pnpm pack` tarball is published by npm through the TTY shim. npm prints a link for each and the script repeats it as `APPROVE: <url>`. **Open each link in the built-in browser for the owner**: they tap their security key to approve that package. Each package needs its own approval; nothing in the script can do it for them.
3. **Verify:** the same run then waits, up to 4 minutes (the registry took about 2), for each new version to show, without the cache; checks its tarball is the one inspected; installs host in a temp folder outside the repo and imports every entry point (core, core/toss, host, host/gamepad, host/element, host/qr). It ends with a result table. Exit 0 is published and verified.
- If it stops half way (core is up, host isn't), run it again once the cause is fixed: what is on npm is skipped.
- Lanes never run `--yes` (the guard blocks `publish:npm` with `--yes` in every spelling, and a lane's `pnpm publish`; the script also refuses in a worktree). A lane may run the dry run: it shows the checkout rules as warnings.
- It never reads or prints a token or ~/.npmrc and never changes npm's config. Afterwards, update PLAN.md's current-state block with the versions now on npm.
