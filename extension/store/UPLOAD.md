# Putting ob.Pal Link on the Chrome Web Store

The steps in the Developer Dashboard, in order. What to paste is in [listing.md](listing.md); the images are in this folder.

## Updating the published item to 1.8.0

1. The store's live version is 1.6.2. GitHub's 1.7.0 was never submitted to the store; 1.8.0 includes both sets of changes.
2. Run `pnpm run store:art`, `pnpm run pack:extension`, `pnpm run store:extension` and `pnpm run store:kit`. Use the existing item, not New item; do not pass `--with-key`.
3. Open `extension/release/store-kit.html`. Its one-screen checklist and CHANGED markers compare every field and image with the 1.6.2 submission at `a4f0ff0`. Changed text has a before → after view. Leave unchanged fields as they are.
4. Upload `extension/release/obpal-link-1.8.0-store.zip` under **Package → Upload new package**. Update the marked text and all eight images: the store icon, five screenshots, small tile and marquee. The logo now matches the ob.Pal logo used everywhere else.
5. Save drafts on the edited tabs. The coordinator submits for review, then records the outcome in `status.json`.

## First upload (historical reference)

- **The first-upload zip:** `%USERPROFILE%\.obpal-keys\store\obpal-link-<version>-store-first-upload.zip`. It carries the extension's private key as `key.pem`, so the store keeps Link's ID, the one ob.Pal Desktop talks to. It's made outside the repository, next to the key, by:

  ```sh
  pnpm run store:extension -- --with-key
  ```

  (`--with-key` alone uses `%USERPROFILE%\.obpal-keys\extension-key.pem`; a path after it uses that key.) Run it again if the version changes before you upload. It prints `extension ID check: match` when the key is right, and writes nothing otherwise.
- **The account page** (once): verify the contact email, set the publisher name, and answer the trader question (see the decisions below).

## Steps

1. Open the [Developer Dashboard](https://chrome.google.com/webstore/devconsole) and click **New item**.
2. Upload the first-upload zip from `.obpal-keys\store`.
3. **Package:** check that the item's ID is `jnnpcnoilofjaffabnhecfokjjknlemg`. If it's anything else, don't submit: the ID is fixed by the first upload, so start a new item with the right zip.
4. **Store listing:** from listing.md, paste the description, and pick the category and the language. Then upload the images:
   - `icon-128.png` as the store icon;
   - `screenshot-1.png` … `screenshot-5.png`, in that order;
   - `tile-440x280.png` as the small promo tile;
   - `marquee-1400x560.png` as the marquee.

   Then fill in the homepage and support URLs, and answer No to mature content. The name and summary come from the package.
5. **Privacy practices:** from listing.md, paste the following:
   - the single purpose;
   - the justification for each permission;
   - the remote code answer (No), with its text.

   Under data usage, tick Location, Web history and User activity, and all three certifications. Then paste the privacy policy URL.
6. **Distribution:** Public, and the regions you choose.
7. **Test instructions:** paste the reviewer notes from listing.md.
8. **Submit for review.** Reviews take from a few days to a few weeks. Choose to publish by hand after approval if you'd like the site to link to the listing the same day.

## Updating a published item

1. `pnpm run store:extension` writes `extension/release/obpal-link-<version>-store.zip` (no key; the item already has its ID).
2. If an earlier version is still pending review, the dashboard won't take a new package: choose **Cancel review** on the item first. The published version stays live meanwhile.
3. **Package:** upload the new zip. **Store listing** and **Privacy practices:** paste any blocks from listing.md that changed since the last upload, and replace the images when they changed. **Test instructions:** paste them again.
4. **Submit for review**, then update `status.json`.

## After approval

- **Delete the first-upload zip** (`%USERPROFILE%\.obpal-keys\store\`): the store has the key now. Keep `extension-key.pem` itself, as safely as before.
- **Later updates:** raise the version, run `pnpm run store:extension`, and upload `extension\release\obpal-link-<version>-store.zip` with **Package → Upload new package**. It has no key and doesn't need one. On the item's **Store listing** tab, replace `screenshot-1.png` through `screenshot-5.png`, `tile-440x280.png` and `marquee-1400x560.png` with the refreshed files in `extension/store/`.
- **The GitHub release keeps working** for developer-mode installs: its manifest keeps the public key, so it has the same ID and ob.Pal Desktop allows it. Because the IDs match, anyone who loaded the GitHub copy should remove it before installing from the store.
- **Send Claude the listing's address**, so the site's Link page and the README can link to it.

## Decisions for you

- **Category:** Tools is suggested. Games is the alternative, though the store means games themselves by it.
- **Regions:** all regions is suggested. Nothing in Link depends on the country.
- **Trader or non-trader** (EU Digital Services Act, on the account page): a trader's legal name, address and phone number are shown to EU visitors. This depends on whether you publish as a business.
- **Official URL** (optional): the listing shows a verified publisher only after the site is verified in Google Search Console with the same Google account.
- **Data usage:** Location, Web history and User activity (2026-09-28). The store's user data FAQ asks for data an extension handles to be disclosed even when it never leaves the device, so the earlier "none, because nothing reaches the developer" no longer holds. Typing stays under User activity, not Authentication information or Personal communications; listing.md has the reasons.
- **Publisher name** and the contact email shown on the listing.

Docs used: [images](https://developer.chrome.com/docs/webstore/images), [listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing), [privacy](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy), [distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution), [publish](https://developer.chrome.com/docs/webstore/publish), [review](https://developer.chrome.com/docs/webstore/review-process), [trader](https://developer.chrome.com/docs/webstore/program-policies/trader-disclosure). The key.pem first upload isn't on developer.chrome.com today: it comes from Chrome's original packaging guide and the [Chromium extensions group](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/Su50pbNzRms).
