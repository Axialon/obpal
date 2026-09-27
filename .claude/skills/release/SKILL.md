---
name: release
description: Release ob.Pal Link and ob.Pal Desktop. Covers version bumps, the extension zips, the Chrome Web Store package and first-upload zip, the Desktop helper zip, the public obpal-link repo and its GitHub release, and the open-source snapshot of this repo. Use when the plan calls for a Link or Desktop release or an OSS snapshot.
---

# Release

**Order:**
1. Merged and green, including `pnpm run e2e:all -- extension`.
2. Versions.
3. Packages.
4. The public obpal-link repo and its GitHub release.
5. The site.
6. The snapshot.

Commands, checks and gotchas for each step are in [reference.md](reference.md). Read it before the first step.

**Rules:**
- Commits to the public repos use the global Axialon identity. This repo's history uses its own identity, never that one.
- The extension's private key never leaves `~/.obpal-keys`. `store.mjs --with-key` reads it there and writes the first-upload zip beside it. Never copy, print or attach either; the guard blocks commands that read that folder.
- Release notes: plain words, what changed for the person using it, and what they must do to update.
- Afterwards, update PLAN.md's done list, the brief, and the owner's handoff (what to test, store steps).
