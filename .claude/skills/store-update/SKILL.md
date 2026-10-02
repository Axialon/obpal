---
name: store-update
description: Prepare and review recurring Chrome Web Store updates for Link, serve the current kit from the main checkout, and record owner-confirmed dashboard submissions and outcomes.
---

# Store update

Follow [the five-step routine](../../../extension/store/UPLOAD.md). Run from the durable main checkout so Copy path points at files that survive lane cleanup. Use `pnpm run store -- status` first, rebuild changed art and the store package, then `pnpm run store -- kit` or `pnpm run store -- serve 5186`. The live page regenerates from repository files; never serve a hand-copied kit. Stop the server after review.

The owner uploads and submits the existing dashboard item. Only after the owner confirms submission, run `pnpm run store -- submitted <version>` and commit the ledger/status changes. Version 1.8.0 is prepared initially; do not infer that it was submitted from a GitHub release or package build. Record `published` or `rejected` only after the dashboard outcome is confirmed. Rejection reasons contain only the generic review issue, with no personal names, emails, account details or local paths.

Run `pnpm run store -- check` after every record change. It also runs in vitest through `pnpm run check`. The last submitted entry supplies the baseline, including a rejected submission; prepared files never advance it. Do not edit hashes by hand. Historical unavailable zip hashes stay explicitly unknown.

Check the item ID and generated time, the HTTP 200 destination checks, the copy-consistency report and the release comparison with the published version. Follow the numbered dashboard steps. Every upload has Download and Copy path; serve the real checkout so both reach current files. The pages suite's Chromium acceptance test exercises every link, image and copy action at desktop and phone widths.

For art captures use the coordinator's assigned stand-in and worker ports, GPU lease and helper guard. Keep evidence in ignored artifacts and raw frames in TEMP. A partial art render is a preview; use the full `store:art` command to refresh its receipt. Lanes implement and test the manager; they never record a real dashboard action or launch the coordinator's review port.
